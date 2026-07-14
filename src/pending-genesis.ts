import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chamberDataHome } from "./paths.ts";

// A genesis in flight: the marker the author action writes before the chamber-genesis
// workflow runs, so the roster surface can show a boot card in the seat being taken
// (a nod to the original Chamber's genesis screen). `startedAt` drives the elapsed
// counter + the stall timeout; `name`/`role` are known when a STARTER archetype was
// authored (pinned as workflow inputs) and absent for a freeform brief (the workflow
// authors them), in which case the boot card holds "calibrating…". Markers are a
// LIST in arrival order — geneses run in parallel (no chamber workflow mutates a
// checkout, so the runs don't contend), each with its own boot card, and each
// landing settles only its own marker.
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

function asMarker(value: unknown): PendingGenesis | null {
  if (typeof value !== "object" || value === null) return null;
  const p = value as Record<string, unknown>;
  if (typeof p.startedAt !== "string" || p.startedAt.length === 0) return null;
  return {
    startedAt: p.startedAt,
    ...(typeof p.name === "string" && p.name ? { name: p.name } : {}),
    ...(typeof p.role === "string" && p.role ? { role: p.role } : {}),
  };
}

// Tolerant read: a missing/corrupt/torn file — or entries without a string
// startedAt — degrade to fewer (or no) markers, the same fail-soft contract
// readWatermark / readDraft keep. A legacy single-object file (the
// pre-list shape) reads as a one-marker list, so an in-place upgrade never drops
// a genesis that was in flight. Arrival order (startedAt ascending) so boot
// cards seat in the order the operator authored.
export async function readPendingGeneses(
  dataHome: string = chamberDataHome(),
): Promise<PendingGenesis[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(pendingGenesisFile(dataHome), "utf8"));
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    return entries
      .map(asMarker)
      .filter((m): m is PendingGenesis => m !== null)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  } catch {
    return [];
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
// torn marker list the next read would discard.
async function writePendingGeneses(
  markers: readonly PendingGenesis[],
  dataHome: string = chamberDataHome(),
): Promise<void> {
  await mkdir(dataHome, { recursive: true });
  const file = pendingGenesisFile(dataHome);
  const tmp = `${file}.${process.pid}.${writeSeq++}.tmp`;
  await writeFile(tmp, `${JSON.stringify(markers, null, 2)}\n`);
  await rename(tmp, file);
}

// Serialize every marker read-modify-write for a data home. A genesis landing, an
// append, and a dismiss each read the list and write it back; run in parallel (the
// point of concurrent genesis) they would last-writer-win — resurrecting a settled
// boot card or dropping a live marker. The temp+rename only guards torn files, so
// order the whole read-modify-write behind one chain per home.
const markerWrites = new Map<string, Promise<unknown>>();
function enqueueMarkerWrite<T>(dataHome: string, apply: () => Promise<T>): Promise<T> {
  const prev = markerWrites.get(dataHome) ?? Promise.resolve();
  const run = prev.then(apply, apply);
  markerWrites.set(
    dataHome,
    run.catch(() => {}),
  );
  return run;
}

// Remove the marker file directly (no rename). Called from inside an already-queued
// mutation, so it must not re-enter enqueueMarkerWrite (that would deadlock).
async function unlinkPendingGenesisFile(dataHome: string): Promise<void> {
  await rm(pendingGenesisFile(dataHome), { force: true });
}

// Append a marker for a genesis the caller is about to launch. startedAt doubles as
// the boot card's dismiss identity, so a same-millisecond stamp nudges forward until
// unique — two rapid authors must never share one.
export async function appendPendingGenesis(
  marker: PendingGenesis,
  dataHome: string = chamberDataHome(),
): Promise<PendingGenesis[]> {
  return enqueueMarkerWrite(dataHome, async () => {
    const existing = await readPendingGeneses(dataHome);
    let stamp = marker.startedAt;
    while (existing.some((m) => m.startedAt === stamp)) {
      const t = Date.parse(stamp);
      if (!Number.isFinite(t)) break;
      stamp = new Date(t + 1).toISOString();
    }
    const markers = [...existing, { ...marker, startedAt: stamp }];
    await writePendingGeneses(markers, dataHome);
    return markers;
  });
}

// Settle the marker a landed genesis belongs to, returning what remains. A starter
// landed under its pinned name; a freeform brief's authored name matches no marker,
// so it settles the OLDEST unnamed marker — and if none, the oldest marker outright,
// so a stray can never pin a boot card forever after every run has finished. Two
// freeform landings out of order can settle each other's marker (both clear once all
// land); a run-scoped identity would remove that ambiguity — tracked as follow-up.
export async function removeLandedGenesis(
  name: string,
  dataHome: string = chamberDataHome(),
): Promise<PendingGenesis[]> {
  return enqueueMarkerWrite(dataHome, async () => {
    const markers = await readPendingGeneses(dataHome);
    if (markers.length === 0) return markers;
    const byName = markers.findIndex((m) => m.name === name);
    const oldestUnnamed = markers.findIndex((m) => m.name === undefined);
    const drop = byName !== -1 ? byName : oldestUnnamed !== -1 ? oldestUnnamed : 0;
    const remaining = markers.filter((_, i) => i !== drop);
    if (remaining.length === 0) await unlinkPendingGenesisFile(dataHome);
    else await writePendingGeneses(remaining, dataHome);
    return remaining;
  });
}

// Dismiss one marker by its startedAt stamp (the boot card's identity — carried on
// its Dismiss action), returning what remains. An unknown stamp removes nothing.
export async function removePendingGenesisAt(
  startedAt: string,
  dataHome: string = chamberDataHome(),
): Promise<PendingGenesis[]> {
  return enqueueMarkerWrite(dataHome, async () => {
    const markers = await readPendingGeneses(dataHome);
    const remaining = markers.filter((m) => m.startedAt !== startedAt);
    if (remaining.length === markers.length) return remaining;
    if (remaining.length === 0) await unlinkPendingGenesisFile(dataHome);
    else await writePendingGeneses(remaining, dataHome);
    return remaining;
  });
}

// Clear every marker by removing the file (an absent file IS "no pending"). Fail-soft
// on a missing file so a double-clear (emit + dismiss racing) never throws. Queued so
// a clear can't interleave a concurrent append's read-modify-write.
export async function clearPendingGenesis(dataHome: string = chamberDataHome()): Promise<void> {
  await enqueueMarkerWrite(dataHome, () => unlinkPendingGenesisFile(dataHome));
}
