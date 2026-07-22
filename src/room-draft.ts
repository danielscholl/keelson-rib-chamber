import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chamberDataHome } from "./paths.ts";

// The convene draft the merged Chamber bench holds between recomposes: which Minds the
// operator has called to the table. Selection is an INCLUSION set (opt-in) — an
// empty/missing draft means nobody is seated yet, so convening starts from a deliberate
// pick, not from every Mind. Assembly is not a stored mode: the bench is assembling
// exactly while this set is non-empty, so a seat click is the only thing that enters it.
export interface RoomDraft {
  selected: Set<string>;
  // Where a convened room runs: the host project id its turns take as their cwd, and
  // whether the coding tier is on. Scope belongs to the table rather than to a shape's
  // form — it is a property of the room, not of how the Minds take turns, so it holds
  // across a change of shape and outlives the cast a convene clears.
  projectId?: string;
  coding?: boolean;
}

interface DraftFile {
  selected: string[];
  projectId?: string;
  coding?: boolean;
}

// The draft lives next to minds/ and rooms/ under the data home (rib-owned, like
// brief-watermark.json and pending-genesis.json), so a single fixed path serves the
// in-process board and the action handlers.
const DRAFT_FILE = "room-draft.json";

export function draftFile(dataHome: string = chamberDataHome()): string {
  return join(dataHome, DRAFT_FILE);
}

function emptyDraft(): RoomDraft {
  return { selected: new Set() };
}

// Tolerant read: a missing or corrupt/torn file degrades to the empty default (nobody
// selected) rather than throwing, mirroring readMinds / readWatermark. A draft written
// before assembly was derived carries a stale `assembling` key, which is simply ignored.
export async function readDraft(dataHome: string = chamberDataHome()): Promise<RoomDraft> {
  try {
    const parsed: unknown = JSON.parse(await readFile(draftFile(dataHome), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return emptyDraft();
    const selectedRaw = (parsed as { selected?: unknown }).selected;
    const selected = Array.isArray(selectedRaw)
      ? new Set(selectedRaw.filter((s): s is string => typeof s === "string"))
      : new Set<string>();
    const { projectId, coding } = parsed as { projectId?: unknown; coding?: unknown };
    return {
      selected,
      ...(typeof projectId === "string" && projectId ? { projectId } : {}),
      ...(typeof coding === "boolean" ? { coding } : {}),
    };
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
  const payload: DraftFile = {
    selected: [...draft.selected].sort(),
    ...(draft.projectId ? { projectId: draft.projectId } : {}),
    ...(draft.coding ? { coding: true } : {}),
  };
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

// Set where a convened room runs. The coding tier is unconfined without a repo to bound
// it to, so dropping the project forces it off here — the one place that pairing is
// enforced, so an incoherent scope can never be persisted and reach validateStart.
export async function setScope(
  projectId: string | undefined,
  coding: boolean,
  dataHome: string = chamberDataHome(),
): Promise<RoomDraft> {
  const draft = await readDraft(dataHome);
  const next: RoomDraft = {
    selected: draft.selected,
    ...(projectId ? { projectId, ...(coding ? { coding: true } : {}) } : {}),
  };
  await writeDraft(next, dataHome);
  return next;
}

// Empty the cast but keep the scope — the state a successful convene returns the bench
// to. Several rooms are commonly convened against one project, so the seats clear and
// the scope stands.
export async function clearCast(dataHome: string = chamberDataHome()): Promise<RoomDraft> {
  const draft = await readDraft(dataHome);
  const next: RoomDraft = { ...draft, selected: new Set() };
  await writeDraft(next, dataHome);
  return next;
}

// Reset to the empty default (nobody seated, no scope) — a full deliberate Clear.
// Writing (rather than unlinking) keeps the file's presence stable for readers.
export async function clearDraft(dataHome: string = chamberDataHome()): Promise<void> {
  await writeDraft(emptyDraft(), dataHome);
}
