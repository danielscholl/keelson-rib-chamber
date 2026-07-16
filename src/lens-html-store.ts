import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertSafeSlug } from "./genesis.ts";
import { isValidRefresh, type LensRefresh } from "./lens-store.ts";
import { deleteRecordDir, isNodeError } from "./record-dir.ts";

// A persisted HTML lens: the authored page markup plus a server-stamped
// freshness time and an optional human title for the panel head. Mirrors the
// board-lens LensRecord, split across two files on disk — lens.html carries the
// raw markup (kept out of JSON so a large page never round-trips an encoder),
// meta.json carries {id, title?, updatedAt, refresh?}.
export interface HtmlLensRecord {
  id: string;
  html: string;
  title?: string;
  updatedAt: string;
  refresh?: LensRefresh;
  // Whether this lens holds a panel on the Chamber surface — operator-owned and absent
  // by default, mirroring LensRecord.pinned. Never authored: the emit schema has no
  // such field, so a designed page cannot claim the surface it renders onto.
  pinned?: boolean;
}

interface HtmlLensMeta {
  id: string;
  title?: string;
  updatedAt: string;
  refresh?: LensRefresh;
  pinned?: boolean;
}

export interface HtmlLensStore {
  // `updatedAt` overrides the store's stamp, the LensStore.saveLens rule: a
  // re-emit that left the page alone holds the freshness it already had.
  save(record: {
    id: string;
    html: string;
    title?: string;
    refresh?: LensRefresh;
    updatedAt?: string;
    pinned?: boolean;
  }): Promise<void>;
  load(id: string): Promise<HtmlLensRecord | undefined>;
  delete(id: string): Promise<void>;
}

// File-based HTML lens store, mirroring createFileLensStore: one directory per
// lens under the data home's lenses-html/ root. Every method runs assertSafeSlug
// first — an id becomes a directory name, so a traversal id would otherwise
// read/write outside the tree.
export function createFileHtmlLensStore(root: string): HtmlLensStore {
  // Per-write temp suffix so two overlapping re-authors of the same lens never
  // share a temp file and clobber each other's rename.
  let writeSeq = 0;
  const lensDir = (id: string) => join(root, id);
  const htmlFile = (id: string) => join(lensDir(id), "lens.html");
  const metaFile = (id: string) => join(lensDir(id), "meta.json");

  return {
    async save(record) {
      assertSafeSlug(record.id);
      await mkdir(lensDir(record.id), { recursive: true });
      const meta: HtmlLensMeta = {
        id: record.id,
        ...(record.title ? { title: record.title } : {}),
        // The store owns the clock (mirrors saveLens) unless the caller supplied a
        // stamp: stamp updatedAt at save, overwriting on re-author so freshness is
        // honest.
        updatedAt: record.updatedAt ?? new Date().toISOString(),
        ...(record.refresh ? { refresh: record.refresh } : {}),
        // Written only when true, so unpinned stays the absent default (saveLens's rule).
        ...(record.pinned ? { pinned: true } : {}),
      };
      // Unique temp then rename (atomic on the same filesystem) so a crash
      // mid-write can't leave a torn file. html first, meta second: meta.json is
      // the commit record (load/list skip a metaless dir), so a crash between
      // the two renames leaves an invisible partial, never a half-written lens.
      const htmlTmp = `${htmlFile(record.id)}.${++writeSeq}.tmp`;
      await writeFile(htmlTmp, record.html);
      await rename(htmlTmp, htmlFile(record.id));
      const metaTmp = `${metaFile(record.id)}.${++writeSeq}.tmp`;
      await writeFile(metaTmp, `${JSON.stringify(meta, null, 2)}\n`);
      await rename(metaTmp, metaFile(record.id));
    },

    async load(id) {
      assertSafeSlug(id);
      const record = await parseHtmlLens(root, id);
      return record;
    },

    async delete(id) {
      assertSafeSlug(id);
      await deleteRecordDir(lensDir(id), () => new Error(`lens '${id}' not found`));
    },
  };
}

// Enumerate every persisted HTML lens, newest-first by updatedAt — the boot
// re-register seed. Degrades per entry (skips non-dirs / unsafe / mismatched /
// unparseable / bad-date / empty-html) and ENOENT → [], so one bad dir can't
// block boot. Mirrors listLenses.
export async function listHtmlLenses(root: string): Promise<HtmlLensRecord[]> {
  let entries: { name: string; isDirectory(): boolean }[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (e) {
    if (isNodeError(e) && e.code === "ENOENT") return [];
    throw e;
  }

  const lenses: { record: HtmlLensRecord; updatedAtMs: number }[] = [];
  for (const entry of entries) {
    const id = entry.name;
    if (!entry.isDirectory()) continue;
    try {
      assertSafeSlug(id);
    } catch {
      continue;
    }
    const record = await parseHtmlLens(root, id);
    const updatedAtMs = record ? Date.parse(record.updatedAt) : Number.NaN;
    if (!record || !Number.isFinite(updatedAtMs)) continue;
    lenses.push({ record, updatedAtMs });
  }

  lenses.sort(
    (a, b) =>
      b.updatedAtMs - a.updatedAtMs ||
      (a.record.id < b.record.id ? 1 : a.record.id > b.record.id ? -1 : 0),
  );
  return lenses.map((l) => l.record);
}

// Read one lens's meta.json + lens.html pair, tolerant of a missing/corrupt/
// torn file (degrades to undefined). The dir name is the authoritative id
// (mirrors loadLens/listLenses): a record whose in-file id drifted is absent.
async function parseHtmlLens(root: string, id: string): Promise<HtmlLensRecord | undefined> {
  let meta: unknown;
  try {
    meta = JSON.parse(await readFile(join(root, id, "meta.json"), "utf8"));
  } catch {
    return undefined;
  }
  if (!isHtmlLensMeta(meta) || meta.id !== id) return undefined;
  let html: string;
  try {
    html = await readFile(join(root, id, "lens.html"), "utf8");
  } catch {
    return undefined;
  }
  if (html.length === 0) return undefined;
  return {
    id,
    html,
    updatedAt: meta.updatedAt,
    ...(meta.title ? { title: meta.title } : {}),
    // Dropped rather than trusted when it wouldn't survive region registration:
    // a hand-edited backing then costs the lens its cadence, never its panel
    // (the createFileLensStore fold, same predicate).
    ...(isValidRefresh(meta.refresh) && meta.refresh ? { refresh: meta.refresh } : {}),
    // Folded, not rejected (the createFileLensStore rule): a bad pin can't take a panel
    // down, so a hand-edit typo costs the pin, never the record.
    ...(meta.pinned === true ? { pinned: true } : {}),
  };
}

function isHtmlLensMeta(value: unknown): value is HtmlLensMeta {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.updatedAt !== "string") return false;
  return r.title === undefined || typeof r.title === "string";
}
