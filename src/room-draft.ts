import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chamberDataHome } from "./paths.ts";

// The Convene draft is modelled as an EXCLUSION set — the slugs the operator has
// deselected — not an inclusion set. An empty/missing file therefore means "all
// Minds selected", preserving the roster's historical all-Minds Start behavior,
// and the first toggle deselects just one Mind instead of collapsing the rest.
interface DraftFile {
  excluded: string[];
}

// The draft lives next to minds/ and rooms/ under the data home, so the
// out-of-process roster collector resolves the identical path from the same baked
// minds dir's parent (see bin/collect-roster.ts).
const DRAFT_FILE = "room-draft.json";

export function draftFile(dataHome: string = chamberDataHome()): string {
  return join(dataHome, DRAFT_FILE);
}

// Tolerant read: a missing or corrupt/torn file degrades to an empty set (all
// Minds selected) rather than throwing, mirroring readMinds / parseRoomJson.
export async function readDraftExclusion(
  dataHome: string = chamberDataHome(),
): Promise<Set<string>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(draftFile(dataHome), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return new Set();
    const excluded = (parsed as { excluded?: unknown }).excluded;
    if (!Array.isArray(excluded)) return new Set();
    return new Set(excluded.filter((s): s is string => typeof s === "string"));
  } catch {
    return new Set();
  }
}

// Monotonic per-write suffix so two overlapping writes never share a temp path
// (room-store's saveRoom does the same) — the rename stays atomic even if a future
// caller or a fast double-toggle races two writes.
let writeSeq = 0;

// Atomic write (temp + rename, like room-store's saveRoom) so a crash mid-write
// can't leave a torn draft the next read would discard.
async function writeDraftExclusion(excluded: Set<string>, dataHome: string): Promise<void> {
  await mkdir(dataHome, { recursive: true });
  const file = draftFile(dataHome);
  const tmp = `${file}.${process.pid}.${writeSeq++}.tmp`;
  const payload: DraftFile = { excluded: [...excluded].sort() };
  await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`);
  await rename(tmp, file);
}

// Flip one slug's membership in the exclusion set and persist, returning the new
// set so the caller can echo it back to the action result without re-reading.
export async function toggleDraftExclusion(
  slug: string,
  dataHome: string = chamberDataHome(),
): Promise<Set<string>> {
  const excluded = await readDraftExclusion(dataHome);
  if (excluded.has(slug)) excluded.delete(slug);
  else excluded.add(slug);
  await writeDraftExclusion(excluded, dataHome);
  return excluded;
}

// Reset to the all-Minds default by writing an empty exclusion set. Writing
// (rather than unlinking) keeps the file's presence stable for readers.
export async function clearDraft(dataHome: string = chamberDataHome()): Promise<void> {
  await writeDraftExclusion(new Set(), dataHome);
}
