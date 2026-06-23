import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CanvasBoardView } from "@keelson/shared";
import { assertSafeSlug } from "./genesis.ts";

// A persisted lens: the authored board plus a server-stamped freshness time. The
// optional scope/maintainingMind/reason fields are RESERVED for the living-views
// index (81b) so adding them later needs no migration — they stay absent until
// emit is extended to capture them, and the index omits them when absent.
export interface LensRecord {
  id: string;
  board: CanvasBoardView;
  updatedAt: string;
  scope?: string;
  maintainingMind?: string;
  reason?: string;
}

// saveLens stamps updatedAt itself, so a caller persists only { id, board }.
export interface LensStore {
  saveLens(record: { id: string; board: CanvasBoardView }): Promise<void>;
  deleteLens(id: string): Promise<void>;
}

// File-based lens store, mirroring createFileRoomStore: one directory per lens
// under the data home's lenses/ root, lens.json holding the single record (no
// transcript sibling — a lens has no turn log). `lensesRoot` is injected so the
// store is testable against a temp dir and path resolution stays in paths.ts.
//
// Every method runs assertSafeSlug first: an id becomes a directory name, so a
// traversal id (`../minds/alice`) would otherwise read/write outside the lenses
// tree. This is the FS boundary, mirroring the room/minds stores' guard.
export function createFileLensStore(lensesRoot: string): LensStore {
  // Per-write temp suffix so two overlapping re-authors of the same lens never
  // share a temp file and clobber each other's rename.
  let writeSeq = 0;
  const lensDir = (id: string) => join(lensesRoot, id);
  const lensFile = (id: string) => join(lensDir(id), "lens.json");

  return {
    async saveLens(record) {
      assertSafeSlug(record.id);
      await mkdir(lensDir(record.id), { recursive: true });
      // The store owns the clock: stamp updatedAt server-side at save (like
      // room/mind createdAt), overwriting on re-author so freshness is honest.
      const stored: LensRecord = {
        id: record.id,
        board: record.board,
        updatedAt: new Date().toISOString(),
      };
      // lens.json is rewritten on every re-author; write a unique temp then
      // rename (atomic on the same filesystem) so a crash mid-write can't leave a
      // torn file and concurrent writers can't trample one shared temp.
      const tmp = `${lensFile(record.id)}.${++writeSeq}.tmp`;
      await writeFile(tmp, `${JSON.stringify(stored, null, 2)}\n`);
      await rename(tmp, lensFile(record.id));
    },

    async deleteLens(id) {
      assertSafeSlug(id);
      const dir = lensDir(id);
      // Fail closed on a missing lens (mirrors deleteRoom / retireMind): deleting
      // an already-gone lens surfaces not-found rather than reporting success.
      // Only ENOENT/ENOTDIR map to not-found — a permission/I/O error must surface,
      // not masquerade as "gone" — and the path must be a directory. No active-guard
      // (unlike deleteRoom): a lens has no live-turn status to protect, so it is
      // always retireable.
      let st: Awaited<ReturnType<typeof stat>>;
      try {
        st = await stat(dir);
      } catch (e) {
        if (isNodeError(e) && (e.code === "ENOENT" || e.code === "ENOTDIR")) {
          throw new Error(`lens '${id}' not found`);
        }
        throw e;
      }
      if (!st.isDirectory()) throw new Error(`lens '${id}' not found`);
      await rm(dir, { recursive: true, force: true });
    },
  };
}

// Enumerate every persisted lens, newest-first by updatedAt. The collector's
// source (81b) and the boot re-register seed. Degrades per entry (skips
// non-dirs / unsafe / mismatched / unparseable / bad-date) and ENOENT → [], so
// one bad dir can't blank the index or block boot.
export async function listLenses(lensesRoot: string): Promise<LensRecord[]> {
  let entries: { name: string; isDirectory(): boolean }[];
  try {
    entries = await readdir(lensesRoot, { withFileTypes: true });
  } catch (e) {
    if (isNodeError(e) && e.code === "ENOENT") return [];
    throw e;
  }

  const lenses: { record: LensRecord; updatedAtMs: number }[] = [];
  for (const entry of entries) {
    const id = entry.name;
    if (!entry.isDirectory()) continue;
    try {
      assertSafeSlug(id);
    } catch {
      continue;
    }
    const record = await parseLensJson(join(lensesRoot, id, "lens.json"));
    const updatedAtMs = record ? Date.parse(record.updatedAt) : Number.NaN;
    // The dir name is the authoritative id (mirrors room slug / mind slug): a
    // record whose in-file id drifted from its dir is skipped.
    if (!record || record.id !== id || !Number.isFinite(updatedAtMs)) continue;
    lenses.push({ record, updatedAtMs });
  }

  lenses.sort(
    (a, b) =>
      b.updatedAtMs - a.updatedAtMs ||
      // Tie on updatedAt (same-millisecond saves): newer id first, the same
      // byte-order tiebreak the room store uses (deterministic across locales).
      (a.record.id < b.record.id ? 1 : a.record.id > b.record.id ? -1 : 0),
  );
  return lenses.map((l) => l.record);
}

// Parse a lens.json, tolerant of a missing/corrupt/torn file (degrades to
// undefined). Shared by listLenses so the isLensRecord shape-guard lives in one
// place. Board validation beyond the shape check is deferred to the binding edge.
async function parseLensJson(path: string): Promise<LensRecord | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isLensRecord(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function isLensRecord(value: unknown): value is LensRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.updatedAt !== "string") return false;
  const board = r.board;
  if (typeof board !== "object" || board === null) return false;
  const b = board as Record<string, unknown>;
  return b.view === "board" && Array.isArray(b.sections);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
