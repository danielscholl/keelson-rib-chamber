import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chamberDataHome } from "./paths.ts";

// A genesis in flight: the marker the author action writes before the chamber-genesis
// workflow runs, so the roster surface can show a boot card in the seat being taken
// (a nod to the original Chamber's genesis screen). `startedAt` drives the elapsed
// counter + the stall timeout; `name`/`role` are known when a STARTER archetype was
// authored (pinned as workflow inputs) and absent for a freeform brief (the workflow
// authors them), in which case the boot card holds "calibrating…". One marker at a
// time — a second author overwrites it (the latest seat is the one being taken).
export interface PendingGenesis {
  startedAt: string;
  name?: string;
  role?: string;
}

// Lives next to room-draft.json / brief-watermark.json under the data home (rib-owned
// state, not a paths.ts dir), so the out-of-process roster collector resolves the same
// path from the baked home.
const PENDING_FILE = "pending-genesis.json";

export function pendingGenesisFile(dataHome: string = chamberDataHome()): string {
  return join(dataHome, PENDING_FILE);
}

// Tolerant read: a missing/corrupt/torn file — or one without a string startedAt —
// degrades to null (no pending genesis), the same fail-soft contract readWatermark /
// readDraftExclusion keep.
export async function readPendingGenesis(
  dataHome: string = chamberDataHome(),
): Promise<PendingGenesis | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(pendingGenesisFile(dataHome), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const p = parsed as Record<string, unknown>;
    if (typeof p.startedAt !== "string" || p.startedAt.length === 0) return null;
    return {
      startedAt: p.startedAt,
      ...(typeof p.name === "string" && p.name ? { name: p.name } : {}),
      ...(typeof p.role === "string" && p.role ? { role: p.role } : {}),
    };
  } catch {
    return null;
  }
}

// The stall window past which a pending genesis is presumed wedged (the workflow
// failed without clearing the marker), and the skew tolerance past which a FUTURE
// startedAt (a clock rollback mid-genesis) is treated as wedged too — a clock we
// can't count forward from must present the Dismiss, not tick indefinitely.
export const GENESIS_STALL_MS = 180_000;
export const FUTURE_SKEW_MS = 30_000;

// The one elapsed rule the boot card and the boot-time tick reconcile both read, so
// the card's stalled flip and the ticker's budget can never disagree: unparseable or
// future-beyond-skew stamps count as fully stalled.
export function pendingElapsedMs(marker: PendingGenesis, now: number): number {
  const started = Date.parse(marker.startedAt);
  if (!Number.isFinite(started) || started - now > FUTURE_SKEW_MS) return GENESIS_STALL_MS;
  return Math.max(0, now - started);
}

// Monotonic per-write suffix so two overlapping writes never share a temp path
// (watermark-store / room-draft do the same) — the rename stays atomic under a race.
let writeSeq = 0;

// Atomic write (temp + rename, like writeWatermark) so a crash mid-write can't leave a
// torn marker the next read would discard.
export async function writePendingGenesis(
  marker: PendingGenesis,
  dataHome: string = chamberDataHome(),
): Promise<void> {
  await mkdir(dataHome, { recursive: true });
  const file = pendingGenesisFile(dataHome);
  const tmp = `${file}.${process.pid}.${writeSeq++}.tmp`;
  await writeFile(tmp, `${JSON.stringify(marker, null, 2)}\n`);
  await rename(tmp, file);
}

// Clear the marker by removing the file (an absent file IS "no pending"). Fail-soft on
// a missing file so a double-clear (emit + dismiss racing) never throws.
export async function clearPendingGenesis(dataHome: string = chamberDataHome()): Promise<void> {
  await rm(pendingGenesisFile(dataHome), { force: true });
}
