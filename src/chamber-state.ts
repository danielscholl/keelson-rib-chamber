import { listLenses } from "./lens-store.ts";
import { readMinds } from "./minds-store.ts";
import { lensesDir, mindsDir, roomsDir } from "./paths.ts";
import { listRooms } from "./room-store.ts";
import type { Watermark } from "./watermark-store.ts";

// One read of the three Chamber stores, reduced to the counts and fingerprints the
// pulse (the roster stats section) and the briefing gate both need — built ONCE per
// trigger so a refresh and a gate evaluation never re-walk the data home twice. Dirs
// are injected so the state is testable against temp dirs; the default-args overload
// resolves the live data home via paths.ts (the same seam the collectors use).
export interface ChamberState {
  mindCount: number;
  activeRoomCount: number;
  // Slugs of every room that has left "active" (stopped/done) — the briefing's
  // "what ended since you last looked" candidates.
  endedRoomSlugs: string[];
  liveLensCount: number;
  // id -> the lens's server-stamped updatedAt, the freshness fingerprint the gate
  // diffs against the watermark to tell a changed/new lens from an unchanged one.
  lensFingerprints: Record<string, string>;
}

export interface ChamberStateDirs {
  mindsDir: string;
  roomsDir: string;
  lensesDir: string;
}

// A room is "ended" once it leaves the active state — the same active/closed split
// the rooms-index collector draws. Kept here so the gate and the pulse agree on what
// counts as a finished session.
function isEndedRoom(status: string): boolean {
  return status !== "active";
}

export async function buildChamberState(
  dirs: ChamberStateDirs = { mindsDir: mindsDir(), roomsDir: roomsDir(), lensesDir: lensesDir() },
): Promise<ChamberState> {
  const [minds, rooms, lenses] = await Promise.all([
    readMinds(dirs.mindsDir),
    listRooms(dirs.roomsDir),
    listLenses(dirs.lensesDir),
  ]);

  const endedRoomSlugs = rooms.filter((r) => isEndedRoom(r.status)).map((r) => r.slug);
  const activeRoomCount = rooms.length - endedRoomSlugs.length;
  const lensFingerprints: Record<string, string> = {};
  for (const lens of lenses) lensFingerprints[lens.id] = lens.updatedAt;

  return {
    mindCount: minds.length,
    activeRoomCount,
    endedRoomSlugs,
    liveLensCount: lenses.length,
    lensFingerprints,
  };
}

// What the gate acts on: the rooms newly ended and the lenses changed/new since the
// persisted watermark. `hasSubstance` is the cost-safety gate — false means nothing
// worth a (paid) briefing turn happened, so the gate stays quiet and runs no turn.
export interface ChamberDelta {
  newlyEndedRooms: string[];
  changedOrNewLenses: string[];
  hasSubstance: boolean;
}

export function diffAgainstWatermark(state: ChamberState, watermark: Watermark): ChamberDelta {
  const acked = new Set(watermark.ackedEndedRooms);
  const newlyEndedRooms = state.endedRoomSlugs.filter((slug) => !acked.has(slug));
  // A lens is substance when its fingerprint differs from the watermark's — which
  // covers a brand-new id (absent from the watermark, so `!==` against undefined) and
  // a re-authored one (updatedAt advanced). A RETIRED lens (in the watermark, absent
  // now) is NOT iterated here, so a retire alone never promotes the briefing.
  const changedOrNewLenses = Object.keys(state.lensFingerprints).filter(
    (id) => state.lensFingerprints[id] !== watermark.lensFingerprints[id],
  );
  return {
    newlyEndedRooms,
    changedOrNewLenses,
    hasSubstance: newlyEndedRooms.length > 0 || changedOrNewLenses.length > 0,
  };
}
