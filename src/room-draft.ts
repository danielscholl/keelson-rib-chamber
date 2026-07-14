import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chamberDataHome } from "./paths.ts";

// The convene draft the merged Chamber bench holds between recomposes: whether the
// operator is assembling a room, and which Minds they have called to the table.
// Selection is an INCLUSION set (opt-in) — an empty/missing draft means nobody is
// seated yet, so convening starts from a deliberate pick, not from every Mind.
// `assembling` is what unfolds the composer under the bench; exiting it clears the
// selection so a cancelled assembly leaves no stale cast behind.
export interface RoomDraft {
  assembling: boolean;
  selected: Set<string>;
}

interface DraftFile {
  assembling: boolean;
  selected: string[];
}

// The draft lives next to minds/ and rooms/ under the data home (rib-owned, like
// brief-watermark.json and pending-genesis.json), so a single fixed path serves the
// in-process board and the action handlers.
const DRAFT_FILE = "room-draft.json";

export function draftFile(dataHome: string = chamberDataHome()): string {
  return join(dataHome, DRAFT_FILE);
}

function emptyDraft(): RoomDraft {
  return { assembling: false, selected: new Set() };
}

// Tolerant read: a missing or corrupt/torn file degrades to the empty default (not
// assembling, nobody selected) rather than throwing, mirroring readMinds / readWatermark.
export async function readDraft(dataHome: string = chamberDataHome()): Promise<RoomDraft> {
  try {
    const parsed: unknown = JSON.parse(await readFile(draftFile(dataHome), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return emptyDraft();
    const assembling = (parsed as { assembling?: unknown }).assembling === true;
    const selectedRaw = (parsed as { selected?: unknown }).selected;
    const selected = Array.isArray(selectedRaw)
      ? new Set(selectedRaw.filter((s): s is string => typeof s === "string"))
      : new Set<string>();
    return { assembling, selected };
  } catch {
    return emptyDraft();
  }
}

// Monotonic per-write suffix so two overlapping writes never share a temp path
// (room-store's saveRoom does the same) — the rename stays atomic even if a fast
// double-toggle races two writes.
let writeSeq = 0;

// Atomic write (temp + rename, like room-store's saveRoom) so a crash mid-write
// can't leave a torn draft the next read would discard.
async function writeDraft(draft: RoomDraft, dataHome: string): Promise<void> {
  await mkdir(dataHome, { recursive: true });
  const file = draftFile(dataHome);
  const tmp = `${file}.${process.pid}.${writeSeq++}.tmp`;
  const payload: DraftFile = { assembling: draft.assembling, selected: [...draft.selected].sort() };
  await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`);
  await rename(tmp, file);
}

// Flip one slug's membership in the inclusion set and persist, returning the new
// draft so the caller can echo the selection back without re-reading.
export async function toggleSelected(
  slug: string,
  dataHome: string = chamberDataHome(),
): Promise<RoomDraft> {
  const draft = await readDraft(dataHome);
  if (draft.selected.has(slug)) draft.selected.delete(slug);
  else draft.selected.add(slug);
  await writeDraft(draft, dataHome);
  return draft;
}

// Enter or leave assembly mode. Leaving clears the selection: a cancelled assembly
// must not leave a stale cast that a later re-entry would silently reuse.
export async function setAssembling(
  on: boolean,
  dataHome: string = chamberDataHome(),
): Promise<RoomDraft> {
  const draft = await readDraft(dataHome);
  const next: RoomDraft = on ? { assembling: true, selected: draft.selected } : emptyDraft();
  await writeDraft(next, dataHome);
  return next;
}

// Reset to the empty default (not assembling, nobody selected) — the state a
// successful convene returns the bench to. Writing (rather than unlinking) keeps the
// file's presence stable for readers.
export async function clearDraft(dataHome: string = chamberDataHome()): Promise<void> {
  await writeDraft(emptyDraft(), dataHome);
}
