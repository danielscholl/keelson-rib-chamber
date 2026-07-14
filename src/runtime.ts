import type { CanvasView, Project, RibContext, SnapshotManager } from "@keelson/shared";
import { errText, expectView } from "@keelson/shared";
import type { ConveneProject } from "./boards/convene.ts";
import { buildChamberBoard } from "./boards/presence.ts";
import { publishBriefing } from "./brief-gate.ts";
import { PRESENCE_KEY } from "./keys.ts";
import { readMinds } from "./minds-store.ts";
import { mindsDir, roomsDir } from "./paths.ts";
import {
  appendPendingGenesis,
  clearPendingGenesis,
  FUTURE_SKEW_MS,
  GENESIS_STALL_MS,
  type PendingGenesis,
  pendingElapsedMs,
  readPendingGeneses,
  removeLandedGenesis,
} from "./pending-genesis.ts";
import { readDraft } from "./room-draft.ts";
import { listRooms } from "./room-store.ts";
import type { Mind, Room } from "./types.ts";

// The genuine host refresh seam (undefined on a harness without it), kept apart from
// the always-defined `refreshWorkflow` fan-out below so a capability check — can the
// host run a workflow at all? (the lens Refresh verb) — still reads true host support,
// not the fan-out that always exists once bindRuntime has run. bindRuntime captures it
// from the ctx (the only hook with the full ctx) and disposeRuntime clears it, so a
// re-boot recaptures the new ctx's and a post-dispose call no-ops.
let hostRefreshWorkflow: RibContext["refreshWorkflow"];

// The host projects lookup, captured in bindRuntime and cleared in disposeRuntime (like
// hostRefreshWorkflow). Undefined on a harness that predates RibContext.getProjects,
// where a projectId is rejected at start (fail closed) rather than targeting nothing.
let getProjects: RibContext["getProjects"];

// The refresh fan-out: onAction handlers re-run a bound collector on demand instead of
// waiting on cadence — room-delete uses it to drop a deleted session's card. Always
// defined (a stable function, not a captured seam): the Chamber panel is a cadence-free
// in-process board, so its local recompose must fire on a roster/rooms mutation
// regardless — else it would freeze at its first snapshot on a host that provides a
// snapshot manager but no refreshWorkflow. It draws from the bench AND the rooms (its
// seats, status footers, and folded-in assembly composer all track both), so recompose
// it on either a roster or a rooms refresh; draft-set / convene call
// refreshPresence directly. Reads the module-private host seam at call time, so it no-ops
// (returns a resolved promise) when unbound (post-dispose).
export function refreshWorkflow(name: string, inputs?: Record<string, string>): Promise<void> {
  if (name === "chamber-roster" || name === "chamber-rooms") refreshPresence();
  return hostRefreshWorkflow?.(name, inputs) ?? Promise.resolve();
}

// The raw host seam for a true capability probe (the lens Refresh verb) — undefined on a
// harness without it, unlike the always-defined `refreshWorkflow` fan-out above.
export function getHostRefreshWorkflow(): RibContext["refreshWorkflow"] {
  return hostRefreshWorkflow;
}

// Fan a Chamber mutation out to the one narrator (the Briefing banner). Nudge the
// standing-digest gate — mutation-driven now, not a 120s poll, since every Chamber
// mutation flows through the rib, so the gate re-evaluates exactly when the fingerprint
// can have changed (and still spends a paid turn ONLY when it actually did) — then
// re-publish the banner so its record + digest registers reflect the change. The delta
// register rides its own attention gate (evaluateBriefGate).
export async function refreshStandingPanels(): Promise<void> {
  await refreshWorkflow("chamber-digest").catch(() => {});
  await publishBriefing();
}

// The roster the driver resolves a speaker's persona from each turn. Cached
// because it only changes when a Mind is created (the genesis tool) or retired
// (onAction); re-reading every mind dir per turn is avoidable disk I/O.
// invalidateRoster() clears it on any mutation and dispose() resets it, so a fresh
// boot re-reads. Assumes a fixed workspace per process — the cache is not keyed on
// KEELSON_WORKSPACE.
let roster: readonly Mind[] | undefined;
export async function resolveMinds(): Promise<readonly Mind[]> {
  if (roster) return roster;
  const minds = await readMinds(mindsDir());
  // Only memoize a non-empty read: readMinds returns [] both for "no minds yet"
  // and for a transient readdir error, so caching [] would stick an empty roster
  // (every speaker -> "unknown mind", ending each room) until the next mutation.
  // Re-reading an empty dir each turn is cheap and self-heals once minds appear.
  if (minds.length > 0) roster = minds;
  return minds;
}
export function invalidateRoster(): void {
  roster = undefined;
}

// The one place a projectId is matched against the host list, so start-time
// validation and the driver's per-turn cwd agree on what an id means.
export function resolveProject(projectId: string): Project | undefined {
  return getProjects?.().find((p) => p.id === projectId);
}
export function resolveProjectRoot(projectId: string): string | undefined {
  return resolveProject(projectId)?.rootPath;
}
export function resolveProjectName(projectId: string): string | undefined {
  return resolveProject(projectId)?.name;
}
// A free-text project reference (id or name, case-insensitive) resolved against
// the host's project list — the same "id or name" convention squad's tools use
// for project selection, since a board action field is free text, not a picker.
function resolveProjectByNameOrId(input: string): Project | undefined {
  const projects = getProjects?.() ?? [];
  const trimmed = input.trim();
  return (
    projects.find((p) => p.id === trimmed) ??
    projects.find((p) => p.name.toLowerCase() === trimmed.toLowerCase())
  );
}

// Resolve a free-text project reference (id or name) to its canonical Project, or a
// uniform "unknown project" error that names where a valid id comes from. The two
// free-text entry points — the Convene board field and the chamber_room_start tool arg —
// resolve through here rather than accepting an id alone (the room-start action forwards
// an existing room's already-canonical id, so it skips this).
export function resolveProjectInput(
  input: string,
): { ok: true; project: Project } | { ok: false; error: string } {
  const project = resolveProjectByNameOrId(input);
  if (!project) {
    return {
      ok: false,
      error: `unknown project "${input}" — pass a project id or name from the host's project list (run \`keelson project list\`)`,
    };
  }
  return { ok: true, project };
}

// Resolve a Convene composer's moderator/manager field (free text, id or name,
// case-insensitive) to a Mind slug — the same convention the project field uses,
// since a board action field is free text, not a picker. Returns the slug or
// undefined; the caller surfaces an unresolvable value rather than dropping it.
export function resolveMindByNameOrId(minds: readonly Mind[], input: string): string | undefined {
  const trimmed = input.trim();
  return (
    minds.find((m) => m.slug === trimmed)?.slug ??
    minds.find((m) => m.name.toLowerCase() === trimmed.toLowerCase())?.slug
  );
}

// The Chamber panel leads the surface: an in-process board (needs the host's live
// project list for the folded-in convene composer, so it can't be an out-of-process
// collector) reading the bench + rooms + the pending-genesis marker + the convene draft,
// so seats, status footers, the live pulse, the boot card, and assembly all track
// mutations. Recomposed whenever a roster or rooms refresh fires (the refreshWorkflow
// fan-out) — which is also how the genesis/rooms tickers advance it — or on a
// draft-set/convene mutation. Fail closed on an older harness (no snapshot manager).
let presenceSm: SnapshotManager | undefined;
let presenceUnregister: (() => void) | undefined;

async function composePresenceBoard(): Promise<CanvasView> {
  const [minds, rooms, pending, draft] = await Promise.all([
    readMinds(mindsDir()).catch(() => [] as Mind[]),
    listRooms(roomsDir()).catch(() => [] as Room[]),
    readPendingGeneses(),
    readDraft().catch(() => ({ selected: new Set<string>() })),
  ]);
  const projects: ConveneProject[] = (getProjects?.() ?? []).map((p) => ({
    id: p.id,
    name: p.name,
  }));
  return buildChamberBoard(minds, rooms, pending, Date.now(), draft, projects);
}

export function refreshPresence(): void {
  void presenceSm?.recompose(PRESENCE_KEY).catch(() => {});
}

// The genesis boot-card ticker. While a genesis runs (a pending-genesis marker on disk),
// the rib recomposes the Chamber panel every GENESIS_TICK_MS so the boot card's elapsed
// count advances and the live head dot pulses (keelson#353 — streaming is derived from
// frame cadence). An in-process recompose, not a chamber-roster workflow run — the panel
// reads the marker itself, so ticking must not spawn a collector subprocess ~72 times per
// genesis. Ticking is bounded to the stall window: a wedged genesis stops ticking and the
// panel shows the stalled card + Dismiss. All timers unref so they never hold the process
// open, and stopGenesisTick clears them on emit / dismiss / dispose.
const GENESIS_TICK_MS = 2_500;
let genesisTicker: ReturnType<typeof setInterval> | undefined;
let genesisTickerDeadline: ReturnType<typeof setTimeout> | undefined;
// Bumped by every stopGenesisTick (emit / dismiss / dispose / a fresh start), so an
// async continuation that read the marker before the stop can prove its read is
// still current before starting the ticker.
let genesisTickEpoch = 0;

function tickChamber(): void {
  refreshPresence();
}

// `deadlineMs` bounds the tick to the stall budget REMAINING — a fresh genesis gets
// the full window; the boot reconcile passes what's left on the marker's own clock so
// a near-stalled marker doesn't earn three extra minutes of pulsing.
function startGenesisTick(deadlineMs: number = GENESIS_STALL_MS): void {
  stopGenesisTick();
  tickChamber(); // show the boot card at once
  genesisTicker = setInterval(tickChamber, GENESIS_TICK_MS);
  genesisTicker.unref?.();
  genesisTickerDeadline = setTimeout(() => {
    tickChamber(); // one last frame flips the card to its stalled state
    if (genesisTicker) clearInterval(genesisTicker);
    genesisTicker = undefined;
  }, deadlineMs);
  genesisTickerDeadline.unref?.();
}

export function stopGenesisTick(): void {
  genesisTickEpoch++;
  if (genesisTicker) clearInterval(genesisTicker);
  if (genesisTickerDeadline) clearTimeout(genesisTickerDeadline);
  genesisTicker = undefined;
  genesisTickerDeadline = undefined;
}

// Begin a genesis: append a pending marker (name/role known for a starter, absent for
// a freeform brief) and (re)start the boot-card tick — markers are a list, so parallel
// geneses each keep their own boot card. Fail-soft — a marker write failure just skips
// the boot card, never blocks the genesis workflow the caller is about to launch.
export async function beginGenesis(info: { name?: string; role?: string }): Promise<void> {
  try {
    const marker: PendingGenesis = {
      startedAt: new Date().toISOString(),
      ...(info.name ? { name: info.name } : {}),
      ...(info.role ? { role: info.role } : {}),
    };
    await appendPendingGenesis(marker);
    startGenesisTick();
  } catch (e) {
    console.error(`[rib-chamber] pending-genesis write failed: ${errText(e)}`);
  }
}

// A genesis landed: settle ITS marker (matched by authored name, else the oldest
// freeform marker — see removeLandedGenesis) and stop the tick only when no other
// genesis is still in flight, so a sibling's boot card keeps pulsing. Fail-soft.
export async function settleGenesis(name: string): Promise<void> {
  // A marker-store failure must not be read as "nothing left" — that stops the
  // ticker while sibling boot cards are still pending and never lets them reach the
  // stalled/Dismiss state. Stop only after a real removal reports none remain.
  try {
    const remaining = await removeLandedGenesis(name);
    if (remaining.length === 0) stopGenesisTick();
  } catch {
    // leave the ticker running; siblings may still be in flight
  }
}

// Bind the cross-cutting host seams + in-process panels — called from registerTools (the
// only hook with the full ctx). Capture the refresh + projects seams (dispose clears them
// so a re-boot recaptures the new ctx's), then register the Convene and Chamber panels on
// the snapshot manager and reconcile a crashed genesis's boot card.
export function bindRuntime(seams: {
  refreshWorkflow?: RibContext["refreshWorkflow"];
  getProjects?: RibContext["getProjects"];
  sm?: SnapshotManager;
}): void {
  hostRefreshWorkflow = seams.refreshWorkflow;
  getProjects = seams.getProjects;
  const sm = seams.sm;
  // The Chamber panel: an in-process board (reads the bench + rooms + the pending
  // marker + the convene draft, and needs getProjects for the folded-in composer)
  // registered on the snapshot manager and primed once; rebound onto a new manager on a
  // re-boot.
  if (sm && sm !== presenceSm) {
    presenceUnregister?.();
    presenceUnregister = sm.register(PRESENCE_KEY, composePresenceBoard, {
      validate: expectView(PRESENCE_KEY, "board"),
    });
    presenceSm = sm;
    void sm.recompose(PRESENCE_KEY);
    // A crash can orphan a pending-genesis marker (only graceful dispose clears it),
    // and no cadence re-reads the in-process panel — the boot card would freeze short
    // of its stalled Dismiss. Restart the tick for the stall budget REMAINING on the
    // marker's own clock (an already-stalled or unparseable marker gets one frame —
    // it composes straight to Dismiss). The epoch check guards the async gap: an
    // emit / dismiss / dispose landing between the read and this callback bumps it,
    // so a settled genesis can never resurrect the ticker.
    const epoch = genesisTickEpoch;
    void readPendingGeneses().then((markers) => {
      if (markers.length === 0 || epoch !== genesisTickEpoch) return;
      const now = Date.now();
      // The freshest marker's remaining budget bounds the tick — older siblings
      // flip to their stalled card mid-tick on their own clocks.
      const freshest = Math.max(...markers.map((m) => GENESIS_STALL_MS - pendingElapsedMs(m, now)));
      if (freshest <= 0) refreshPresence();
      // + FUTURE_SKEW_MS: a marker up to the skew tolerance in the future clamps
      // elapsed to 0, so the deadline must outlast the card's own clock reaching
      // the stall — the final tick has to compose the stalled card, never stop
      // one frame short of its Dismiss.
      else startGenesisTick(freshest + FUTURE_SKEW_MS);
    });
  }
}

// Tear down the runtime cluster: stop the genesis tick and clear the marker (a genesis
// can't survive the process), drop the host seams so a post-dispose refresh no-ops,
// unregister the in-process panels, and reset the roster cache so a re-boot re-reads.
export async function disposeRuntime(): Promise<void> {
  stopGenesisTick();
  await clearPendingGenesis().catch(() => {});
  hostRefreshWorkflow = undefined;
  getProjects = undefined;
  presenceUnregister?.();
  presenceUnregister = undefined;
  presenceSm = undefined;
  invalidateRoster();
}
