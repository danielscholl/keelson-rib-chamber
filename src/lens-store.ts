import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CanvasBoardView } from "@keelson/shared";
import { assertSafeSlug } from "./genesis.ts";
import { deleteRecordDir, isNodeError } from "./record-dir.ts";

// A persisted lens: the authored board plus a server-stamped freshness time. The
// optional scope/maintainingMind/reason fields are the index card's PROVENANCE —
// the authoring agent supplies whatever it can name (never fabricated), so each
// stays absent when the emit omitted it and the index omits it in turn. A record
// with no `kind` is a lens (a standing view a Mind maintains); an exhibit is a
// deliverable a discussion tabled. `sourceRoom` is driver-witnessed, never
// agent-supplied, so a Mind cannot claim a room it wasn't in (see room.ts).
export type LensKind = "lens" | "exhibit";

// A lens's re-compose backing: the catalog workflow the panel's refresh runs
// (with input `lens` = the record id) and how often. Lens-only — an exhibit is
// its moment and never refreshes, so the exhibit emit carries no such field.
export interface LensRefresh {
  workflow: string;
  cadenceMs?: number;
}

export interface LensRecord {
  id: string;
  board: CanvasBoardView;
  updatedAt: string;
  kind?: LensKind;
  refresh?: LensRefresh;
  scope?: string;
  maintainingMind?: string;
  reason?: string;
  sourceRoom?: string;
}

// The provenance an emit may carry alongside { id, board }: all optional. saveLens
// stamps updatedAt itself (freshness is server-owned); sourceRoom rides here so the
// driver-witnessed stamp and the note write-back can round-trip it.
export type LensProvenance = Pick<
  LensRecord,
  "scope" | "maintainingMind" | "reason" | "sourceRoom"
>;

// The read-side kind fold: anything but a literal "exhibit" — absent, or a value a
// corrupt record smuggled in — is a lens, so a bad kind degrades to the default
// meaning instead of hiding the record from both indexes.
export function isExhibit(record: Pick<LensRecord, "kind">): boolean {
  return record.kind === "exhibit";
}

// Pick the provenance fields off a loaded record, so a write-back path can
// round-trip them without hand-listing each (a missed field would be silently
// stripped on the next save).
export function lensProvenance(record: LensRecord): LensProvenance {
  return {
    scope: record.scope,
    maintainingMind: record.maintainingMind,
    reason: record.reason,
    sourceRoom: record.sourceRoom,
  };
}

export interface LensStore {
  // `updatedAt` is normally store-stamped at save. The optional override hands the
  // stamp to a caller that has read the prior record, which the store has not: to hold
  // the prior freshness across a write that leaves the board alone (the witness stamp's
  // sourceRoom, or a re-author touching only refresh/provenance), or to keep a changed
  // board's stamp strictly ahead of it — this clock is millisecond-resolution and the
  // brief/digest gates compare the value exactly.
  saveLens(
    record: {
      id: string;
      board: CanvasBoardView;
      kind?: LensKind;
      refresh?: LensRefresh;
      updatedAt?: string;
    } & LensProvenance,
  ): Promise<void>;
  loadLens(id: string): Promise<LensRecord | undefined>;
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
      // The store owns the clock unless the caller supplied a stamp (see saveLens):
      // stamp updatedAt server-side at save, like room/mind createdAt.
      // Provenance is spread in only when present, so an absent field leaves no key
      // on the record and the index omits it (a re-author without it clears a prior).
      const stored: LensRecord = {
        id: record.id,
        board: record.board,
        updatedAt: record.updatedAt ?? new Date().toISOString(),
        // Only the exhibit kind is written; lens stays the absent default so old
        // and new lens records serialize identically.
        ...(record.kind === "exhibit" ? { kind: record.kind } : {}),
        // Refresh backing is lens-only: an exhibit is its moment (see LensRefresh).
        ...(record.refresh && record.kind !== "exhibit" ? { refresh: record.refresh } : {}),
        ...(record.scope ? { scope: record.scope } : {}),
        ...(record.maintainingMind ? { maintainingMind: record.maintainingMind } : {}),
        ...(record.reason ? { reason: record.reason } : {}),
        ...(record.sourceRoom ? { sourceRoom: record.sourceRoom } : {}),
      };
      // lens.json is rewritten on every re-author; write a unique temp then
      // rename (atomic on the same filesystem) so a crash mid-write can't leave a
      // torn file and concurrent writers can't trample one shared temp.
      const tmp = `${lensFile(record.id)}.${++writeSeq}.tmp`;
      await writeFile(tmp, `${JSON.stringify(stored, null, 2)}\n`);
      await rename(tmp, lensFile(record.id));
    },

    async loadLens(id) {
      assertSafeSlug(id);
      const record = await parseLensJson(lensFile(id));
      // The dir name is the authoritative id (mirrors listLenses): a record whose
      // in-file id drifted from its dir is treated as absent, not returned.
      if (!record || record.id !== id) return undefined;
      return record;
    },

    async deleteLens(id) {
      assertSafeSlug(id);
      // Fail closed on a missing lens (mirrors deleteRoom / retireMind): deleting
      // an already-gone lens surfaces not-found rather than reporting success. No
      // active-guard (unlike deleteRoom): a lens has no live-turn status to
      // protect, so it is always retireable.
      await deleteRecordDir(lensDir(id), () => new Error(`lens '${id}' not found`));
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
    let record = parsed;
    // Fold an unknown kind string to the lens default here, so the returned
    // record's type is honest and every reader sees the same degraded value.
    const kind = (record as { kind?: unknown }).kind;
    if (kind !== undefined && kind !== "exhibit" && kind !== "lens") {
      const { kind: _dropped, ...rest } = record as LensRecord & { kind?: unknown };
      record = rest as LensRecord;
    }
    // Same fold for a malformed refresh block: drop the field, keep the lens,
    // so a corrupt config degrades to a non-refreshing panel, not a lost record.
    if (!isValidRefresh((record as { refresh?: unknown }).refresh)) {
      const { refresh: _dropped, ...rest } = record as LensRecord & { refresh?: unknown };
      record = rest as LensRecord;
    }
    return record;
  } catch {
    return undefined;
  }
}

function isValidRefresh(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  if (typeof r.workflow !== "string" || r.workflow.length === 0) return false;
  // Integer only: the harness region schema rejects a fractional cadence at
  // registration, which would take the whole panel down — the exact failure
  // this fold exists to degrade past.
  return (
    r.cadenceMs === undefined || (typeof r.cadenceMs === "number" && Number.isInteger(r.cadenceMs))
  );
}

function isLensRecord(value: unknown): value is LensRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.updatedAt !== "string") return false;
  // Provenance is optional but must be a string when present, so a corrupt
  // record can't smuggle a non-string into the card's pill/field/reason.
  if (!isOptionalString(r.scope) || !isOptionalString(r.maintainingMind)) return false;
  if (!isOptionalString(r.reason)) return false;
  // kind/sourceRoom follow the same rule; a non-"exhibit" kind string still
  // parses and folds to lens at the read side (see isExhibit).
  if (!isOptionalString(r.kind) || !isOptionalString(r.sourceRoom)) return false;
  const board = r.board;
  if (typeof board !== "object" || board === null) return false;
  const b = board as Record<string, unknown>;
  return b.view === "board" && Array.isArray(b.sections);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}
