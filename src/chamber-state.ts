import { isExhibit, type LensRecord, listLenses } from "./lens-store.ts";
import { readMinds } from "./minds-store.ts";
import { lensesDir, mindsDir, roomsDir } from "./paths.ts";
import { listRooms } from "./room-store.ts";
import type { Mind, Room } from "./types.ts";
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
  exhibitCount: number;
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

export interface ChamberRecords {
  minds: readonly Mind[];
  rooms: readonly Room[];
  lenses: readonly LensRecord[];
}

// One read of the three Chamber stores, returned raw. Shared by buildChamberState
// (which reduces them to counts/fingerprints) and chamberFingerprint (which needs the
// full records — slugs/ids, not just the reduced counts).
export async function readChamberRecords(
  dirs: ChamberStateDirs = { mindsDir: mindsDir(), roomsDir: roomsDir(), lensesDir: lensesDir() },
): Promise<ChamberRecords> {
  const [minds, rooms, lenses] = await Promise.all([
    readMinds(dirs.mindsDir),
    listRooms(dirs.roomsDir),
    listLenses(dirs.lensesDir),
  ]);
  return { minds, rooms, lenses };
}

export async function buildChamberState(
  dirs: ChamberStateDirs = { mindsDir: mindsDir(), roomsDir: roomsDir(), lensesDir: lensesDir() },
): Promise<ChamberState> {
  const { minds, rooms, lenses } = await readChamberRecords(dirs);
  return reduceChamberState(minds, rooms, lenses);
}

// The pure reduction behind buildChamberState — split out so a caller that already
// read the three stores (the digest gate, which also builds a source summary from the
// same records) reduces them without a second read.
export function reduceChamberState(
  minds: readonly Mind[],
  rooms: readonly Room[],
  lenses: readonly LensRecord[],
): ChamberState {
  const endedRoomSlugs = rooms.filter((r) => isEndedRoom(r.status)).map((r) => r.slug);
  const activeRoomCount = rooms.length - endedRoomSlugs.length;
  const lensFingerprints: Record<string, string> = {};
  for (const lens of lenses) lensFingerprints[lens.id] = lens.updatedAt;

  // The pulse's "Live views" counts standing lenses only — an exhibit is a tabled
  // deliverable, not a living view. Fingerprints keep BOTH species: a tabled or
  // re-tabled exhibit is briefing/digest substance like any lens change.
  const exhibitCount = lenses.filter(isExhibit).length;
  return {
    mindCount: minds.length,
    activeRoomCount,
    endedRoomSlugs,
    liveLensCount: lenses.length - exhibitCount,
    exhibitCount,
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

// A stable, order-independent fingerprint of everything the digest RENDERS — WHICH
// Minds, active/ended rooms, and lenses exist, by stable slug/id AND the name/status
// buildDigestSource displays, plus lens freshness. The standing-digest gate diffs a
// fresh fingerprint against the one persisted at the last (paid) authoring to decide
// whether re-authoring is warranted. Keyed on identity + rendered name (not counts), so
// retiring one Mind for another — or a slug-stable rename — re-authors; a lens title
// change rides updatedAt (re-authoring a lens bumps it). Slugs are colon-free
// (kebab-case), so `slug:name` parses unambiguously. Deliberately excludes per-turn
// churn (a room's turnIndex), so a live room can't drive a re-author each turn.
export function chamberFingerprint(
  minds: readonly Mind[],
  rooms: readonly Room[],
  lenses: readonly LensRecord[],
): string {
  const mindIds = minds.map((m) => `${m.slug}:${m.name}`).sort();
  const activeRooms = rooms
    .filter((r) => !isEndedRoom(r.status))
    .map((r) => `${r.slug}:${r.name}`)
    .sort();
  const endedRooms = rooms
    .filter((r) => isEndedRoom(r.status))
    .map((r) => `${r.slug}:${r.status}:${r.name}`)
    .sort();
  const lensFps = lenses.map((l) => `${l.id}=${l.updatedAt}`).sort();
  return JSON.stringify({ minds: mindIds, activeRooms, endedRooms, lenses: lensFps });
}

// Whether the chamber has anything worth digesting yet. Authoring a digest of an empty
// chamber is a wasted (paid) turn, so the gate withholds the author node until some
// content exists — the same cost floor diffAgainstWatermark's hasSubstance applies.
// Minds are deliberately NOT content: a bench that has produced nothing has no shape to
// synthesize, and the digest prompt forbids restating counts, so a minds-only chamber
// leaves the author nothing true to say. The Briefing's own render gate must apply the
// same floor (see brief-gate's hasContent), or emptying a chamber back to minds goes
// quiet here while a stale board keeps rendering there.
export function hasDigestContent(state: ChamberState): boolean {
  return (
    state.activeRoomCount > 0 ||
    state.endedRoomSlugs.length > 0 ||
    state.liveLensCount > 0 ||
    // An exhibit is renderable content the digest lists, so an exhibits-only
    // chamber (rooms deleted, minds retired) is not "empty".
    state.exhibitCount > 0
  );
}

// A compact, honest text summary of the chamber the digest author turn synthesizes from
// (it has no tools to read the stores itself). Names only — no transcript text, no
// fabricated metrics — so the author works from what is actually on disk. The gate
// emits this; the author reads it via $gate.output.summary.
export function buildDigestSource(
  minds: readonly Mind[],
  rooms: readonly Room[],
  lenses: readonly LensRecord[],
): string {
  const active = rooms.filter((r) => !isEndedRoom(r.status));
  const ended = rooms.filter((r) => isEndedRoom(r.status));
  const standing = lenses.filter((l) => !isExhibit(l));
  const exhibits = lenses.filter(isExhibit);
  const names = <T>(xs: readonly T[], f: (x: T) => string): string =>
    xs.length ? xs.map(f).join(", ") : "none";
  return [
    `Minds (${minds.length}): ${names(minds, (m) => m.name)}`,
    `Active rooms (${active.length}): ${names(active, (r) => r.name || r.slug)}`,
    `Ended rooms (${ended.length}): ${names(ended, (r) => `${r.name || r.slug} (${r.status})`)}`,
    `Lenses (${standing.length}): ${names(standing, (l) => l.board.title || l.id)}`,
    `Exhibits (${exhibits.length}): ${names(
      exhibits,
      (l) => `${l.board.title || l.id}${l.sourceRoom ? ` (from ${l.sourceRoom})` : ""}`,
    )}`,
  ].join("\n");
}
