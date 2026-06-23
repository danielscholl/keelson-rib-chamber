import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chamberDataHome } from "./paths.ts";

// The briefing's persisted "last-seen": the ended rooms and lens fingerprints the
// briefing has already accounted for, plus whether it currently holds a promoted
// (non-quiet) board. The gate diffs the live ChamberState against this to decide
// whether anything NEW happened — so a cold start (no file) treats everything as
// new, and a quiet re-evaluation runs no agent turn.
export interface Watermark {
  ackedEndedRooms: string[];
  lensFingerprints: Record<string, string>;
  briefPromoted: boolean;
  updatedAt: string;
}

// The watermark lives next to room-draft.json under the data home (the brief gate is
// rib-owned, not a paths.ts dir), so the filename stays here like room-draft.ts.
const WATERMARK_FILE = "brief-watermark.json";

export function watermarkFile(dataHome: string = chamberDataHome()): string {
  return join(dataHome, WATERMARK_FILE);
}

const EMPTY: Watermark = {
  ackedEndedRooms: [],
  lensFingerprints: {},
  briefPromoted: false,
  updatedAt: "",
};

// Tolerant read: a missing or corrupt/torn file degrades to the empty watermark
// (cold start — everything reads as new and unpromoted) rather than throwing, the
// same fail-soft contract readDraftExclusion / readMinds keep.
export async function readWatermark(dataHome: string = chamberDataHome()): Promise<Watermark> {
  try {
    const parsed: unknown = JSON.parse(await readFile(watermarkFile(dataHome), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return { ...EMPTY };
    const p = parsed as Record<string, unknown>;
    const ackedEndedRooms = Array.isArray(p.ackedEndedRooms)
      ? p.ackedEndedRooms.filter((s): s is string => typeof s === "string")
      : [];
    const lensFingerprints: Record<string, string> = {};
    if (typeof p.lensFingerprints === "object" && p.lensFingerprints !== null) {
      for (const [id, at] of Object.entries(p.lensFingerprints as Record<string, unknown>)) {
        if (typeof at === "string") lensFingerprints[id] = at;
      }
    }
    return {
      ackedEndedRooms,
      lensFingerprints,
      briefPromoted: p.briefPromoted === true,
      updatedAt: typeof p.updatedAt === "string" ? p.updatedAt : "",
    };
  } catch {
    return { ...EMPTY };
  }
}

// Monotonic per-write suffix so two overlapping writes never share a temp path
// (room-draft / room-store do the same) — the rename stays atomic even under a race.
let writeSeq = 0;

// Atomic write (temp + rename, like room-draft's writeDraftExclusion) so a crash
// mid-write can't leave a torn watermark the next read would discard.
export async function writeWatermark(
  watermark: Watermark,
  dataHome: string = chamberDataHome(),
): Promise<void> {
  await mkdir(dataHome, { recursive: true });
  const file = watermarkFile(dataHome);
  const tmp = `${file}.${process.pid}.${writeSeq++}.tmp`;
  await writeFile(tmp, `${JSON.stringify(watermark, null, 2)}\n`);
  await rename(tmp, file);
}
