import type {
  Brief,
  CanvasBoardView,
  CanvasView,
  Project,
  Rib,
  RibAction,
  RibActionResult,
  RibAuthStatus,
  RibContext,
  RibViewDescriptor,
  SnapshotManager,
  ToolContext,
  ToolDefinition,
} from "@keelson/shared";
import {
  asNonEmptyString,
  asStringArray,
  CANVAS_PUBLISH_CONTRACT,
  canvasBoardViewSchema,
  errText,
  expectView,
  formatPaletteReport,
  validateCategoricalPalette,
  z,
} from "@keelson/shared";
import { listAgents, resolveAgent } from "./agents.ts";
import { recordSection } from "./boards/activity.ts";
import { buildConveneBoard, type ConveneProject } from "./boards/convene.ts";
import { buildChamberBoard } from "./boards/presence.ts";
import { buildRoomBoard } from "./boards/room.ts";
import {
  codingReviewCapabilityError,
  codingToolPool,
  externalToolPool,
  KNOWN_CAPABILITY_SLUGS,
  readToolPool,
} from "./capabilities.ts";
import {
  buildChamberState,
  type ChamberDelta,
  chamberFingerprint,
  diffAgainstWatermark,
  readChamberRecords,
} from "./chamber-state.ts";
import { CHAMBER_COMMANDS, completeChamberCommand, invokeChamberCommand } from "./commands.ts";
import { buildSeedFor, composeRoomSystemPrompt } from "./compose.ts";
import { readDigest, writeDigest } from "./digest-store.ts";
import { assertSafeSlug, slugify } from "./genesis.ts";
import {
  BRIEF_KEY,
  CONVENE_KEY,
  DIGEST_KEY,
  EXHIBITS_KEY,
  LENSES_KEY,
  PRESENCE_KEY,
  ROOMS_KEY,
  ROSTER_KEY,
  roomViewKey,
} from "./keys.ts";
import {
  CHAMBER_SURFACE_ID,
  canonicalLensId,
  createLensRegistry,
  EXHIBIT_TOOL_NAME,
  LENS_TOOL_NAME,
  type LensRegistry,
  lensKey,
  lensRefreshInputs,
  MIN_REFRESH_CADENCE_MS,
} from "./lens.ts";
import {
  createHtmlLensRegistry,
  declaredHtmlPalettes,
  HTML_LENS_KEY,
  HTML_LENS_TOOL_NAME,
  type HtmlLensRegistry,
  htmlLensKey,
  htmlLensStructuralError,
} from "./lens-html.ts";
import { createFileHtmlLensStore, listHtmlLenses } from "./lens-html-store.ts";
import {
  createFileLensStore,
  isExhibit,
  type LensKind,
  type LensRefresh,
  type LensStore,
  lensProvenance,
  listLenses,
} from "./lens-store.ts";
import {
  appendLog,
  listMindRecords,
  MEMORY_DOC_CAP,
  type MindRecord,
  readMindDoc,
  readMinds,
  readSoul,
  retireMind,
  scaffoldMind,
  setMindModel,
  writeMemory,
} from "./minds-store.ts";
import {
  chamberDataHome,
  htmlLensesDir,
  isChamberDataHomeWritable,
  lensesDir,
  mindsDir,
  roomsDir,
  setChamberDataHome,
} from "./paths.ts";
import {
  appendPendingGenesis,
  clearPendingGenesis,
  FUTURE_SKEW_MS,
  GENESIS_STALL_MS,
  type PendingGenesis,
  pendingElapsedMs,
  readPendingGeneses,
  removeLandedGenesis,
  removePendingGenesisAt,
} from "./pending-genesis.ts";
import type { RoomStore } from "./ports.ts";
import { BRIEF_PROMPT } from "./prompts.ts";
import { createRoomDriver, type RoomDriver } from "./room.ts";
import {
  MAX_CRITERION_LEN,
  MAX_GROUNDING_CRITERIA,
  MAX_GROUNDING_URL_LEN,
  normalizeGrounding,
  parseCriteriaLines,
  type RoomConfigInput,
  roomConfigFromFlat,
} from "./room-config.ts";
import { clearDraft, readDraftExclusion, toggleDraftExclusion } from "./room-draft.ts";
import { createCoalescingPublisher } from "./room-publisher.ts";
import { createRoomRegionRegistry, type RoomRegionRegistry } from "./room-region-registry.ts";
import { createFileRoomStore, deriveRoomName, listRooms, sweepClosedRooms } from "./room-store.ts";
import type { OutcomeSplit } from "./room-text.ts";
import { splitOutcome } from "./room-text.ts";
import { DEFAULT_END_VOTE_THRESHOLD, stripControlJson } from "./routing.ts";
import { GENESIS_STARTERS } from "./starters.ts";
import { getStrategy } from "./strategies/index.ts";
import { renderTranscript } from "./transcript.ts";
import type { Mind, Room, RoomConfig, RoomStrategyName, TurnEntry } from "./types.ts";
import { IDENTITY_SLOT_COUNT, nextFreeSlot } from "./types.ts";
import { readWatermark, writeWatermark } from "./watermark-store.ts";
import {
  contributeChamberWorkflows,
  DIGEST_TOOL_NAME,
  LENS_REFRESH_WORKFLOW,
} from "./workflows.ts";

export { normalizeGrounding } from "./room-config.ts";

// Upper bound on a room's turn budget. Each turn is a (paid) agent call, so an
// accidental or malicious huge budget would launch a runaway sequence; reject it.
const MAX_ROOM_TURN_BUDGET = 50;
// Default room length when a chat tool omits turnBudget. Applied after parse (not
// z.default()) because z.toJSONSchema — which the Copilot provider feeds the model
// — lists defaulted fields as `required`, forcing the model to supply them.
const DEFAULT_ROOM_TURN_BUDGET = 8;

// The room driver is a boot-time singleton: it holds in-flight turn state across
// onAction calls, so it is built once in registerTools (the only hook that runs
// with the full ctx — runAgentTurn + snapshot manager) and reused thereafter. It
// stays undefined when either seam is absent, and room actions then fail closed.
let driver: RoomDriver | undefined;
// The lens registry is a boot-time singleton too: it owns the per-subject snapshot
// registrations and surface regions, created once in registerTools and disposed in
// dispose() so a re-register doesn't duplicate-register. lensSm tracks the manager it
// was built against, so a re-bootstrap with a different one rebinds it.
let lensRegistry: LensRegistry | undefined;
let lensSm: SnapshotManager | undefined;
let htmlLensRegistry: HtmlLensRegistry | undefined;
let htmlLensSm: SnapshotManager | undefined;
// Tracked alongside htmlLensSm because createHtmlLensRegistry captures registerRegion:
// a re-bootstrap that reuses the same manager but hands a fresh seam must rebuild, or
// the registry would publish/register through the stale registerRegion.
let htmlLensRegisterRegion: NonNullable<RibContext["registerRegion"]> | undefined;
// The room region registry is a boot-time singleton like the lens one: it owns the
// per-slug room snapshot keys + surface regions, built once in registerTools and
// disposed in dispose(). roomSm tracks the manager it was built against so a
// re-bootstrap with a different one rebinds it.
let roomRegistry: RoomRegionRegistry | undefined;
let roomSm: SnapshotManager | undefined;
// A closed room is released from the region registry (retainOnly keeps only active +
// the most-recent), so unlike a lens it has no standing key. room-open publishes each
// opened room's board to its own snapshot-only key (roomViewKey(slug)) the drawer
// subscribes to, registered lazily and torn down in dispose().
let roomViewSm: SnapshotManager | undefined;
const roomViewEntries = new Map<
  string,
  { publisher: { publish(view: CanvasView): Promise<void> }; unregister: () => void }
>();
// The refresh seam, captured in registerTools (the only hook with the full ctx) so
// onAction handlers can re-run a bound collector on demand instead of waiting on
// cadence — room-delete uses it to drop a deleted session's card. Optional and
// fail-soft: undefined on an older harness, where the index falls back to cadence.
let refreshWorkflow: RibContext["refreshWorkflow"];
// The genuine host refresh seam (undefined on a harness without it), kept apart from
// the always-defined `refreshWorkflow` fan-out above so a capability check — can the
// host run a workflow at all? (the lens Refresh verb) — still reads true host support,
// not the fan-out that always exists once registerTools has run.
let hostRefreshWorkflow: RibContext["refreshWorkflow"];

// Fan a Chamber mutation out to the one narrator (the Briefing banner). Nudge the
// standing-digest gate — mutation-driven now, not a 120s poll, since every Chamber
// mutation flows through the rib, so the gate re-evaluates exactly when the fingerprint
// can have changed (and still spends a paid turn ONLY when it actually did) — then
// re-publish the banner so its record + digest registers reflect the change. The delta
// register rides its own attention gate (evaluateBriefGate).
async function refreshStandingPanels(): Promise<void> {
  await refreshWorkflow?.("chamber-digest")?.catch(() => {});
  await publishBriefing();
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

// The rooms-index ticker. The index card's bar reads room.turnIndex/turnBudget,
// which commitActive persists every turn — but the index is a bound collector that
// only recomposes on a room lifecycle change (start/end/delete), so a live room's
// bar sat frozen at its start value mid-run. While ANY room is active, re-read the
// index on a modest cadence so the bar advances as turns land (a cheap deterministic
// disk read, like the roster tick); stop once no room is active. Unref'd so it never
// holds the process open; cleared on dispose.
const ROOMS_TICK_MS = 2_500;
let roomsTicker: ReturnType<typeof setInterval> | undefined;

function startRoomsTick(): void {
  if (roomsTicker) return;
  roomsTicker = setInterval(() => {
    void refreshWorkflow?.("chamber-rooms")?.catch(() => {});
  }, ROOMS_TICK_MS);
  roomsTicker.unref?.();
}

function stopRoomsTick(): void {
  if (roomsTicker) clearInterval(roomsTicker);
  roomsTicker = undefined;
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

function stopGenesisTick(): void {
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
async function beginGenesis(info: { name?: string; role?: string }): Promise<void> {
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
async function settleGenesis(name: string): Promise<void> {
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

// Serialize genesis slot allocation + scaffold across parallel landings. nextFreeSlot
// reads the roster snapshot, so two emits that read the same free slot before either
// scaffolds would persist a duplicate hue. Each scaffold invalidates the roster, so
// the next serialized landing re-reads and takes the next free slot.
let genesisScaffoldInFlight: Promise<unknown> = Promise.resolve();
// The host projects lookup, captured in registerTools and cleared in dispose (like
// refreshWorkflow). Undefined on a harness that predates RibContext.getProjects,
// where a projectId is rejected at start (fail closed) rather than targeting nothing.
let getProjects: RibContext["getProjects"];

// The one place a projectId is matched against the host list, so start-time
// validation and the driver's per-turn cwd agree on what an id means.
function resolveProject(projectId: string): Project | undefined {
  return getProjects?.().find((p) => p.id === projectId);
}
function resolveProjectRoot(projectId: string): string | undefined {
  return resolveProject(projectId)?.rootPath;
}
function resolveProjectName(projectId: string): string | undefined {
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
function resolveProjectInput(
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
function resolveMindByNameOrId(minds: readonly Mind[], input: string): string | undefined {
  const trimmed = input.trim();
  return (
    minds.find((m) => m.slug === trimmed)?.slug ??
    minds.find((m) => m.name.toLowerCase() === trimmed.toLowerCase())?.slug
  );
}

// The Convene composer is an in-process snapshot (like the Briefing banner, not a
// bound collector) because its shape gating and project picker need the host's live
// project list — an out-of-process collector can't reach ctx.getProjects. Registered
// in registerTools and recomposed whenever the Minds it draws chips + capability
// gating from change (the refreshWorkflow wrapper below) or on a draft/convene mutation.
let conveneSm: SnapshotManager | undefined;
let conveneUnregister: (() => void) | undefined;

async function composeConveneBoard(): Promise<CanvasView> {
  const [minds, excluded, rooms] = await Promise.all([
    readMinds(mindsDir()).catch(() => [] as Mind[]),
    readDraftExclusion().catch(() => new Set<string>()),
    listRooms(roomsDir()).catch(() => [] as Room[]),
  ]);
  const projects: ConveneProject[] = (getProjects?.() ?? []).map((p) => ({
    id: p.id,
    name: p.name,
  }));
  return buildConveneBoard(minds, excluded, projects, rooms.length);
}

// Fire-and-forget recompose of the Convene board. No-op until registerTools has bound
// it to a snapshot manager (fail closed on an older harness).
function refreshConvene(): void {
  void conveneSm?.recompose(CONVENE_KEY).catch(() => {});
}

// The Chamber panel leads the surface: an in-process board (like Convene) reading the
// bench + rooms + the pending-genesis marker, so seats, status footers, the live pulse,
// and the boot card all track mutations. Recomposed whenever a roster or rooms refresh
// fires (the refreshWorkflow wrapper) — which is also how the genesis/rooms tickers
// advance it. Fail closed on an older harness (no snapshot manager).
let presenceSm: SnapshotManager | undefined;
let presenceUnregister: (() => void) | undefined;

async function composePresenceBoard(): Promise<CanvasView> {
  const [minds, rooms, pending] = await Promise.all([
    readMinds(mindsDir()).catch(() => [] as Mind[]),
    listRooms(roomsDir()).catch(() => [] as Room[]),
    readPendingGeneses(),
  ]);
  return buildChamberBoard(minds, rooms, pending);
}

function refreshPresence(): void {
  void presenceSm?.recompose(PRESENCE_KEY).catch(() => {});
}
// The briefing gate's seams + state, captured in registerTools (the only hook with
// the full ctx). The publisher routes the brief board to BRIEF_KEY; briefRunAgentTurn
// is the (paid) turn the gate fires ONLY when something new happened. Both undefined
// when a seam is absent — the gate then keeps a quiet board and runs no turn.
let briefPublisher: { publish(board: CanvasBoardView): Promise<void> } | undefined;
let briefUnregister: (() => void) | undefined;
let briefSm: SnapshotManager | undefined;
let briefRunAgentTurn: RibContext["runAgentTurn"];
// Serializes brief evaluations so concurrent triggers (a room ending as a lens lands)
// fire at most ONE agent turn: the second await-chains behind the first, then re-reads
// state — which the first turn's watermark advance has likely made quiet. The headline
// cost-safety invariant rides this plus the hasSubstance gate.
let briefInFlight: Promise<void> = Promise.resolve();
// Aborts the gate's in-flight (paid) turn on dispose, mirroring the room driver's
// per-room controllers. The gate captures this signal per turn and re-checks it
// before its publish/write, so a turn caught mid-shutdown drops its late result
// instead of writing post-teardown. registerTools installs a fresh controller each
// boot, so an orphaned pre-dispose turn stays aborted (gated out) even after re-boot.
let briefAbort = new AbortController();
// The Briefing banner is the surface's one narrator: three registers composed
// in-process (the banner is rib-driven, not a collector) — the promoted delta (from
// the last paid brief turn, held here), the standing digest (read from digest.json),
// and the always-on record (the activity feed tail). `promotedDelta` holds the delta
// turn's sections so a record/digest refresh re-assembles the banner without re-running
// the paid turn; `promotedCount` is the "N new" the header shows.
let promotedDelta: CanvasBoardView["sections"] | undefined;
let promotedCount = 0;
// The structured origins of the promoted delta, resolved at promote time from the
// gate's own slugs/ids (never parsed from the agent-authored prose) and rendered as
// "Open what changed" jump chips beneath the delta register. Lives and lapses with
// promotedDelta.
interface PromotedSource {
  kind: "room" | "lens";
  label: string;
  ref: string;
}
let promotedSources: readonly PromotedSource[] = [];
// Serializes banner re-publishes so a mutation-driven refresh and a gate promote can't
// interleave two composes onto one publish; reset on dispose.
let briefingPublishInFlight: Promise<void> = Promise.resolve();

// The reflection gate's seams + state, captured in registerTools alongside the brief
// gate's. reflectRunAgentTurn is the (paid) turn each participating Mind runs at a
// room's close to curate its own memory.md; undefined when the agent-turn seam is
// absent (older harness), where a room closes with no reflection. reflectAbort aborts
// in-flight reflection on dispose (mirrors briefAbort). reflectWrites serializes a
// Mind's memory writes so two rooms closing at once that share it can't lose-update.
let reflectRunAgentTurn: RibContext["runAgentTurn"];
let reflectAbort = new AbortController();
const reflectWrites = new Map<string, Promise<unknown>>();

// Slugs whose auto-advance loop is running, so a re-start doesn't double-drive.
const loops = new Set<string>();
// Monotonic suffix so each room-start gets a brand-new slug (see freshRoomSlug).
let roomSeq = 0;
// Rooms currently active. Multiple run concurrently — each on its own per-slug
// snapshot key + surface region — so a room is added when it opens and removed when
// it stops or its loop ends. Set iteration is insertion-ordered, so the last entry
// is the most-recently-started active room: the default target when a chat tool
// omits an explicit slug.
const activeRooms = new Set<string>();
// The most-recent room, active or finished. Unlike activeRooms it survives the room
// ending, so chamber_room_status (and the surface's retained panel) can still show a
// just-finished transcript. Cleared only on dispose.
let lastSlug: string | undefined;
// Cap on concurrently-active rooms. Each runs its own loop of paid agent turns, so an
// unbounded fan-out would burn cost without an operator noticing. A small soft cap
// keeps "multiple rooms" useful while bounding the spend; it also sits far under the
// harness per-surface region ceiling, so a start never fails for lack of a panel slot.
export const MAX_ACTIVE_ROOMS = 6;
let roomRetentionSweep = Promise.resolve();

// The roster the driver resolves a speaker's persona from each turn. Cached
// because it only changes when a Mind is created (the genesis tool) or retired
// (onAction); re-reading every mind dir per turn is avoidable disk I/O.
// invalidateRoster() clears it on any mutation and dispose() resets it, so a fresh
// boot re-reads. Assumes a fixed workspace per process — the cache is not keyed on
// KEELSON_WORKSPACE.
let roster: readonly Mind[] | undefined;
async function resolveMinds(): Promise<readonly Mind[]> {
  if (roster) return roster;
  const minds = await readMinds(mindsDir());
  // Only memoize a non-empty read: readMinds returns [] both for "no minds yet"
  // and for a transient readdir error, so caching [] would stick an empty roster
  // (every speaker -> "unknown mind", ending each room) until the next mutation.
  // Re-reading an empty dir each turn is cheap and self-heals once minds appear.
  if (minds.length > 0) roster = minds;
  return minds;
}
function invalidateRoster(): void {
  roster = undefined;
}

function queueRoomRetentionSweep(): void {
  const root = roomsDir();
  roomRetentionSweep = roomRetentionSweep.then(
    () => runRoomRetentionSweep(root),
    () => runRoomRetentionSweep(root),
  );
}

async function runRoomRetentionSweep(root: string): Promise<void> {
  try {
    const { removed } = await sweepClosedRooms(root);
    // A sweep that actually pruned rooms changed the store — refresh the index and the
    // standing panels (like the user-initiated room-delete) so an evicted room stops
    // showing instead of lingering until the 120s cadence.
    if (removed.length > 0) {
      await refreshWorkflow?.("chamber-rooms")?.catch(() => {});
      await refreshStandingPanels();
    }
  } catch (e) {
    console.error(`[rib-chamber] room retention sweep failed: ${errText(e)}`);
  }
}

// Re-publish every persisted lens on boot so its live panel + snapshot key come
// back after a restart (the registry is otherwise in-memory only). Fire-and-forget
// and fail-soft per entry — listLenses already skips a corrupt record, and one lens
// that fails to re-publish (e.g. the per-surface region ceiling) is logged and
// skipped so it can't block boot. Re-registers via reregister (the live half of
// publish) WITHOUT re-saving, so a lens's authored updatedAt is preserved — a
// restart must not reset every lens's freshness.
// In flight while boot re-registration runs. retire awaits it so a retire landing
// mid-reconcile can't race a reregister into resurrecting the just-deleted lens (a
// live key/panel with no on-disk record).
let lensReconcileInFlight: Promise<void> | undefined;

// Serializes lens write-backs (the lens-note action's load-append-publish) so two
// concurrent appends to the same board can't lose-update each other. Mirrors
// briefInFlight: a global chain, reset on dispose so a re-boot starts fresh.
let lensWriteInFlight: Promise<unknown> = Promise.resolve();

// Enqueue one record-file mutation behind every prior one. Chains on settle
// (never letting a rejected tail poison the queue) and returns this mutation's
// own completion for callers that await it — the one idiom behind the emit,
// table, stamp, and note write paths.
function enqueueLensWrite<T>(apply: () => Promise<T>): Promise<T> {
  const run = lensWriteInFlight.then(apply, apply);
  lensWriteInFlight = run.catch(() => {});
  return run;
}

function reconcileLensPanels(registry: LensRegistry): void {
  lensReconcileInFlight = (async () => {
    let records: Awaited<ReturnType<typeof listLenses>>;
    try {
      records = await listLenses(lensesDir());
    } catch (e) {
      console.error(`[rib-chamber] lens re-registration failed: ${errText(e)}`);
      return;
    }
    for (const rec of records) {
      try {
        // Kind and refresh ride through so an exhibit's panel comes back on its
        // own shelf and a living lens comes back with its re-compose wiring.
        await registry.reregister(
          rec.id,
          rec.board,
          isExhibit(rec) ? "exhibit" : "lens",
          rec.refresh,
        );
      } catch (e) {
        console.error(`[rib-chamber] lens '${rec.id}' re-registration failed: ${errText(e)}`);
      }
    }
  })();
  void lensReconcileInFlight;
}

// The HTML twin of reconcileLensPanels: re-publish every persisted HTML lens on
// boot so its key, region, and views entry come back after a restart, via
// reregister (no re-save, authored updatedAt preserved), fail-soft per entry.
// Tracked in flight for the same reason as lensReconcileInFlight: the retire
// verb awaits it so a retire landing mid-reconcile can't race a reregister into
// resurrecting the just-deleted lens.
let htmlLensReconcileInFlight: Promise<void> | undefined;

function reconcileHtmlLensPanels(registry: HtmlLensRegistry): void {
  htmlLensReconcileInFlight = (async () => {
    let records: Awaited<ReturnType<typeof listHtmlLenses>>;
    try {
      records = await listHtmlLenses(htmlLensesDir());
    } catch (e) {
      console.error(`[rib-chamber] html lens re-registration failed: ${errText(e)}`);
      return;
    }
    for (const rec of records) {
      try {
        await registry.reregister(rec.id, rec.html, rec.title);
      } catch (e) {
        console.error(`[rib-chamber] html lens '${rec.id}' re-registration failed: ${errText(e)}`);
      }
    }
  })();
}

// The room surface shows a panel for every active room plus the most-recent room's,
// so a just-finished room's final board lingers until a newer room supersedes it.
// Recomputed after any room lifecycle change; retainOnly drops the panels of rooms
// that are neither active nor the most-recent.
function reconcileRoomPanels(): void {
  const keep = new Set(activeRooms);
  if (lastSlug) keep.add(lastSlug);
  roomRegistry?.retainOnly(keep);
  // Drive the rooms-index bar off the same lifecycle signal: tick while a room is
  // live so its bar advances, quiet once the bench is idle.
  if (activeRooms.size > 0) startRoomsTick();
  else stopRoomsTick();
}

// The attention gate. A room ending or a lens changing fires this; it is the SOLE
// path that may run the (paid) briefing turn, and it runs one ONLY when the live
// ChamberState shows substance the watermark hasn't seen. Every call chains onto
// briefInFlight, so concurrent triggers collapse: the second runs after the first
// has advanced the watermark and therefore re-reads as quiet (no second turn). The
// returned promise is for tests; hooks fire-and-forget it. Never throws — a failed
// turn keeps the prior board and leaves the watermark un-advanced. Exported so the
// brief-gate test can drive it directly (asserting the no-turn-when-quiet invariant).
export function evaluateBriefGate(): Promise<void> {
  const next = briefInFlight.then(runBriefGate, runBriefGate);
  // Keep the chain alive even if this run rejected, so a later trigger still serializes
  // behind it rather than racing a half-finished evaluation.
  briefInFlight = next.catch(() => {});
  return next;
}

async function runBriefGate(): Promise<void> {
  // Seam absent (older harness, or a ctx without the snapshot/turn seams): the banner
  // keeps whatever board it has (the boot-seeded quiet one) and no turn ever runs.
  if (!briefPublisher || !briefRunAgentTurn) return;
  const runTurn = briefRunAgentTurn;
  // Capture this boot's abort signal up front: a dispose during the turn aborts it,
  // and re-checking it (not the live briefAbort) before publish/write gates out a
  // turn whose rib was torn down — including one orphaned across a later re-boot.
  const { signal } = briefAbort;

  let state: Awaited<ReturnType<typeof buildChamberState>>;
  let watermark: Awaited<ReturnType<typeof readWatermark>>;
  try {
    state = await buildChamberState();
    watermark = await readWatermark();
  } catch (e) {
    console.error(`[rib-chamber] brief gate state read failed: ${errText(e)}`);
    return;
  }
  const delta = diffAgainstWatermark(state, watermark);

  // Quiet: nothing new since the watermark. If the delta register was promoted, lapse
  // it (the digest + record stay) and clear the flag; otherwise this is an idempotent
  // no-op — no write, and (the headline invariant) NO turn.
  if (!delta.hasSubstance) {
    if (watermark.briefPromoted) {
      try {
        promotedDelta = undefined;
        promotedCount = 0;
        promotedSources = [];
        await writeWatermark({
          ...watermark,
          briefPromoted: false,
          updatedAt: new Date().toISOString(),
        });
        await publishBriefing();
      } catch (e) {
        console.error(`[rib-chamber] brief quiet republish failed: ${errText(e)}`);
      }
    }
    return;
  }

  // Promote: something new happened. Compose a delta-aware prompt (the brief core
  // plus a "what's new" block built from METADATA only — no transcript text) and run
  // ONE agent turn. On a clean board reply, publish it and advance the watermark to
  // the state we just read; on any failure keep the prior board and do not advance.
  let prompt: string;
  let sources: PromotedSource[];
  try {
    ({ prompt, sources } = await composeBriefPrompt(delta));
  } catch (e) {
    console.error(`[rib-chamber] brief prompt compose failed: ${errText(e)}`);
    return;
  }
  let board: CanvasBoardView;
  try {
    const turn = runTurn({
      prompt,
      allowedTools: [],
      timeoutMs: BRIEF_TURN_TIMEOUT_MS,
      cwd: chamberDataHome(),
      abortSignal: signal,
    });
    try {
      for await (const _chunk of turn.stream) {
        // drained for progress; the result is the source of truth (mirrors room.ts)
      }
    } catch {
      // a stream error surfaces via result.status below
    }
    const result = await turn.result;
    if (result.status !== "ok") {
      console.error(`[rib-chamber] brief turn ${result.status}: ${result.error ?? ""}`);
      return;
    }
    board = expectView(BRIEF_KEY, "board")(parseBoard(result.text)) as CanvasBoardView;
  } catch (e) {
    // Parse/validate/turn failure — fail closed: keep the prior board, don't advance.
    console.error(`[rib-chamber] brief turn failed: ${errText(e)}`);
    return;
  }
  // Shutdown landed during the (paid) turn — drop the late result so nothing is
  // published or written after the rib is disposed (mirrors room.ts runOneTurn).
  if (signal.aborted) return;
  try {
    // The turn authored a board; its sections become the delta register, labelled and
    // wrapped with the digest + record by composeBriefingBoard. Store the count so the
    // header reads "N new", and the resolved sources so the register carries its
    // deterministic jump chips.
    promotedDelta = board.sections;
    promotedCount = delta.newlyEndedRooms.length + delta.changedOrNewLenses.length;
    promotedSources = sources;
    await writeWatermark({
      ackedEndedRooms: state.endedRoomSlugs,
      lensFingerprints: state.lensFingerprints,
      briefPromoted: true,
      updatedAt: new Date().toISOString(),
    });
    await publishBriefing();
  } catch (e) {
    // Stored the delta but the watermark write failed: the banner is live, but a later
    // trigger may re-promote. Logged; never thrown into a fire-and-forget hook.
    console.error(`[rib-chamber] brief watermark advance failed: ${errText(e)}`);
  }
}

// Parse an agent's reply text into a candidate board object. The turn is JSON-only
// (the prompt asks for one object), but a live model commonly wraps it in a ```json
// fence or prefixes a sentence of prose — so strip a surrounding fence, then fall
// back to the first balanced {…}, before giving up. A throw still means no JSON
// object was recoverable; the caller treats that as fail-closed (prior board kept).
function parseBoard(text: string): unknown {
  const unfenced = stripCodeFence(text.trim());
  try {
    return JSON.parse(unfenced);
  } catch (err) {
    const candidate = firstJsonObject(unfenced);
    if (candidate !== null && candidate !== unfenced) return JSON.parse(candidate);
    throw err;
  }
}

// Strip a single surrounding markdown code fence (```json … ``` or ``` … ```);
// returns the inner content, or the input unchanged when it isn't fenced.
function stripCodeFence(s: string): string {
  const m = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(s);
  return m?.[1]?.trim() ?? s;
}

// Recover the first complete JSON object embedded in `text` (e.g. after a leading
// sentence of prose). Tracks string/escape state so a brace inside a string value
// can't close the object early. Returns the substring, or null when none balances.
function firstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
    } else if (ch === "\\") {
      escaped = true;
    } else if (ch === '"') {
      inString = !inString;
    } else if (!inString) {
      if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

// The promote prompt: the standing brief core plus a delta block naming what changed
// since the last briefing — ended rooms by name/status/turns and changed/new lenses
// by id + scope/reason. METADATA ONLY (no transcript text) so a briefing never reads
// a room's content. Reads the rooms/lenses once on the promote path (rare, and a paid
// turn is about to run anyway) to resolve the slugs/ids the delta carries to metadata
// — the same read also yields the structured `sources` the banner renders as jump
// chips, so the chips can never name anything the prompt didn't.
async function composeBriefPrompt(
  delta: ChamberDelta,
): Promise<{ prompt: string; sources: PromotedSource[] }> {
  const lines: string[] = [];
  const sources: PromotedSource[] = [];
  if (delta.newlyEndedRooms.length > 0) {
    const rooms = await listRooms(roomsDir());
    const bySlug = new Map(rooms.map((r) => [r.slug, r]));
    lines.push("Rooms that ended since the last briefing:");
    for (const slug of delta.newlyEndedRooms) {
      const room = bySlug.get(slug);
      if (!room) continue;
      lines.push(`  - ${room.name} (${room.status}, ${room.turnIndex} turns)`);
      sources.push({ kind: "room", label: room.name || room.slug, ref: slug });
    }
  }
  if (delta.changedOrNewLenses.length > 0) {
    const lenses = await listLenses(lensesDir());
    const byId = new Map(lenses.map((l) => [l.id, l]));
    lines.push("Lenses authored or exhibits tabled since the last briefing:");
    for (const id of delta.changedOrNewLenses) {
      const lens = byId.get(id);
      const detail = lens
        ? [
            isExhibit(lens)
              ? `exhibit${lens.sourceRoom ? ` from room ${lens.sourceRoom}` : ""}`
              : undefined,
            lens.scope,
            lens.reason,
          ]
            .filter((s): s is string => Boolean(s))
            .join(" — ")
        : "";
      lines.push(`  - ${id}${detail ? ` (${detail})` : ""}`);
      // A lens retired between the diff and this read has no live key left to open.
      if (lens) sources.push({ kind: "lens", label: lens.board.title || id, ref: id });
    }
  }
  if (lines.length === 0) return { prompt: BRIEF_PROMPT, sources };
  return {
    prompt: `${BRIEF_PROMPT}

What's new since the last briefing — lead the briefing with these, honestly (do NOT invent detail beyond what is listed):
${lines.join("\n")}`,
    sources,
  };
}

// Boot reconciliation: the banner is re-seeded with the quiet board on every
// registerTools, so a persisted briefPromoted:true must be cleared or the roster
// pulse ("For you") would advertise a waiting briefing the quiet banner doesn't have.
// Preserves the acks (a real promote still needs fresh substance to fire). Fail-soft:
// a missing/unpromoted watermark is a no-op, and any error is swallowed at boot.
async function clearPersistedBriefPromoted(): Promise<void> {
  try {
    const wm = await readWatermark();
    if (!wm.briefPromoted) return;
    await writeWatermark({ ...wm, briefPromoted: false, updatedAt: new Date().toISOString() });
  } catch (e) {
    console.error(`[rib-chamber] brief watermark boot reset failed: ${errText(e)}`);
  }
}

// The reflection turn's budget. One composing turn (no tools), so a modest ceiling
// bounds a wedged provider without starving a normal reflection.
const REFLECTION_TURN_TIMEOUT_MS = 60_000;
// The cap on a reflection's log line, mirrored from the prompt — a journal entry is
// one short line, not a paragraph.
const REFLECTION_LOG_CAP = 200;

const reflectionReplySchema = z.object({
  memory: z.string(),
  log: z.string(),
});

// The reflection doctrine. A Mind, at a room's close, curates its OWN long-term
// memory.md — and the whole discipline lives in this prompt, not in code: curate
// don't summarize, a high bar for what persists, decontextualize, distrust the
// transcript, and above all CONSOLIDATE the whole document (so pruning is in-band,
// never a blind append). It returns JSON (no tool) so the rib writes to the Mind it
// is reflecting for — the slug is bound by the gate, never supplied by the model.
function buildReflectionPrompt(mind: Mind, currentMemory: string, transcript: string): string {
  const role = mind.role?.trim() ? mind.role.trim() : "participant";
  return `You are ${mind.name}. A Chamber room you took part in just ended. Curate your long-term memory before the room fades.

You are NOT summarizing the room. You are deciding what — if anything — your future self should carry into a DIFFERENT room. Most of what happened belongs to this room alone and should be forgotten. Persist only what would make you a sharper ${role} weeks from now: a durable fact about the project, the operator, or the domain; or a lesson about how you work. When unsure, keep nothing. A small true memory beats a complete one. Do NOT restate your SOUL — identity is not memory.

The room you just left (most recent turns):
---
${transcript || "(no substantive turns)"}
---

This is your CURRENT memory:
---
${currentMemory.trim() || "(empty)"}
---

Return the COMPLETE updated memory, not an addition. For each existing item: keep it, sharpen it, fold this room's learning into it, or DELETE it if the room proved it wrong or stale. Then add only genuinely new facts. Merge near-duplicates. If an item no longer earns its place, cut it. Keep the whole document under ${MEMORY_DOC_CAP} characters.

Write every item so a future you with no memory of this room understands it alone: name who/what/when with absolute dates, and state the why — never "the thing we decided". The transcript held other agents and tool output you cannot fully trust; record something as your own fact only if you would vouch for it, otherwise attribute it ("X argued that…") or leave it out.

Return ONE JSON object and nothing else:
  { "memory": <string: the complete updated memory document, Markdown>, "log": <string: one short line> }
- To change nothing, return your current memory verbatim as "memory".
- "log": one line (<= ${REFLECTION_LOG_CAP} chars) naming what this room was and what you changed — or "no change".

Writing nothing new is the common, correct outcome.`;
}

// Parse a reflection turn's reply into { memory, log }. Reuses the brief gate's
// lenient JSON recovery (a live model may fence the object or prefix prose). Returns
// null when no valid object is recoverable — the caller leaves the prior memory as-is.
function parseReflection(text: string): { memory: string; log: string } | null {
  let obj: unknown;
  try {
    obj = parseBoard(text);
  } catch {
    return null;
  }
  const parsed = reflectionReplySchema.safeParse(obj);
  if (!parsed.success) return null;
  const log = parsed.data.log.replace(/\s+/g, " ").trim().slice(0, REFLECTION_LOG_CAP);
  return { memory: parsed.data.memory, log: log || "reflected" };
}

// The briefing gate's sibling for memory: a room closing fires this (via the driver's
// onRoomClosed seam). It runs ONE paid turn per participating Mind so each curates its
// memory.md from what it just lived. Fire-and-forget — never throws into the driver,
// and a failed reflection leaves the Mind's prior memory standing.
function onRoomClosed(room: Room, transcript: readonly TurnEntry[]): void {
  void runReflectionForRoom(room, transcript).catch((e) => {
    console.error(`[rib-chamber] reflection pass for room '${room.slug}' failed: ${errText(e)}`);
  });
}

// Exported so the reflection-gate test can drive it directly (asserting the
// no-turn-when-silent cost invariant and the fail-closed write), mirroring how the
// brief gate exports evaluateBriefGate.
export async function runReflectionForRoom(
  room: Room,
  transcript: readonly TurnEntry[],
): Promise<void> {
  if (!reflectRunAgentTurn) return; // no agent-turn seam — close without reflection
  const { signal } = reflectAbort;
  if (signal.aborted) return;
  // The deterministic, free cost guard: a Mind reflects only if it spoke at least one
  // substantive, non-aborted turn. A silent participant (and a room nobody spoke in)
  // learned nothing, so it spends no turn — the headline cost invariant.
  //
  // Reflect for every agent-speaker the room KNOWS, not just its participants: a
  // facilitator Mind (a group-chat moderator/synthesizer or a magentic manager) lives
  // in room.config, not room.participants, yet authors `role: "agent"` turns — so it
  // must reflect on a room it actually shaped. Bound to the room's configured Minds so
  // a stray entry can't summon a reflection; the roster lookup below skips a since-
  // retired one. Only buildAgentEntry emits `role: "agent"`, always keyed by a Mind
  // slug, so `spoke` holds Mind slugs alone (never a director/system authority).
  const known = new Set(
    [
      ...room.participants,
      room.config?.moderator,
      room.config?.synthesizer,
      room.config?.manager,
    ].filter((slug): slug is string => Boolean(slug)),
  );
  const spoke = new Set(
    transcript
      .filter(
        (e) => e.role === "agent" && !e.aborted && e.parts.some((p) => p.text.trim().length > 0),
      )
      .map((e) => e.from),
  );
  const reflectors = [...spoke].filter((slug) => known.has(slug));
  if (reflectors.length === 0) return;
  const roster = await resolveMinds();
  // renderTranscript windows to the last N turns, strips routing/control JSON, and
  // marks omissions — the same clean view a Mind sees while speaking in the room.
  const transcriptText = renderTranscript(transcript);
  // Sequential, not parallel: at most one reflection turn in flight per closing room,
  // so a wide room doesn't fan out a burst of paid turns.
  for (const slug of reflectors) {
    if (signal.aborted) return;
    const mind = roster.find((m) => m.slug === slug);
    if (!mind) continue; // retired between speaking and the close
    await reflectOneMind(mind, transcriptText, signal);
  }
}

async function reflectOneMind(
  mind: Mind,
  transcriptText: string,
  signal: AbortSignal,
): Promise<void> {
  if (!reflectRunAgentTurn || signal.aborted) return;
  // Serialize the WHOLE read -> turn -> write per Mind so two concurrent room closes
  // that share it consolidate on each other's result instead of lose-updating: the
  // second reflection reads memory.md only AFTER the first has written it. Chained on
  // reflectWrites (reset on dispose); the chain swallows errors so one failed
  // reflection can't wedge the Mind's next one, and the room's loop keeps going.
  const prev = reflectWrites.get(mind.slug) ?? Promise.resolve();
  const next = prev.then(() => reflectAndPersist(mind, transcriptText, signal));
  reflectWrites.set(
    mind.slug,
    next.catch((e) => {
      console.error(`[rib-chamber] reflection for '${mind.slug}' failed: ${errText(e)}`);
    }),
  );
  await reflectWrites.get(mind.slug);
}

// Read the Mind's current memory, run its (paid) reflection turn, and persist the
// consolidated result — the body the per-Mind chain serializes. The memory.md read
// is HERE, inside the chain, so the consolidation is over the latest memory rather
// than a snapshot taken before an earlier reflection's write landed.
async function reflectAndPersist(
  mind: Mind,
  transcriptText: string,
  signal: AbortSignal,
): Promise<void> {
  const run = reflectRunAgentTurn;
  if (!run || signal.aborted) return;
  const currentMemory = (await readMindDoc(mindsDir(), mind.slug, "memory.md")) ?? "";
  const prompt = buildReflectionPrompt(mind, currentMemory, transcriptText);
  const system = (await readSoul(mindsDir(), mind.slug))?.trim() || mind.persona;

  let replyText: string;
  try {
    const turn = run({
      system,
      prompt,
      allowedTools: [],
      timeoutMs: REFLECTION_TURN_TIMEOUT_MS,
      cwd: chamberDataHome(),
      abortSignal: signal,
      ...(mind.model ? { model: mind.model } : {}),
      ...(mind.provider ? { provider: mind.provider } : {}),
    });
    try {
      for await (const _chunk of turn.stream) {
        // drained for progress; the result is the source of truth (mirrors room.ts)
      }
    } catch {
      // a stream error surfaces via result.status below
    }
    const result = await turn.result;
    if (result.status !== "ok") {
      console.error(
        `[rib-chamber] reflection turn for '${mind.slug}' ${result.status}: ${result.error ?? ""}`,
      );
      return;
    }
    replyText = result.text;
  } catch (e) {
    console.error(`[rib-chamber] reflection turn for '${mind.slug}' failed: ${errText(e)}`);
    return;
  }
  // Shutdown landed during the (paid) turn — drop the late write (mirrors the brief gate).
  if (signal.aborted) return;
  const parsed = parseReflection(replyText);
  if (!parsed) {
    console.error(
      `[rib-chamber] reflection for '${mind.slug}': unparseable reply, memory unchanged`,
    );
    return;
  }
  // An empty memory would WIPE the Mind's accumulated memory. A model that means "no
  // change" is told to echo its current memory back, so treat an empty document as a
  // keep-prior no-op rather than persisting the blank — a bad turn must not erase a
  // Mind's hard-won memory.
  if (!parsed.memory.trim()) {
    console.error(
      `[rib-chamber] reflection for '${mind.slug}': empty memory returned, keeping prior`,
    );
    return;
  }
  await writeMemory(mindsDir(), mind.slug, parsed.memory);
  await appendLog(mindsDir(), mind.slug, parsed.log, new Date().toISOString());
}

// The most-recently-started active room, or undefined when none is active. Set
// iteration is insertion-ordered, so the last entry is the newest active room.
function mostRecentActiveSlug(): string | undefined {
  return [...activeRooms].at(-1);
}

// Resolve the room a say/stop targets: an explicit (active) slug, else the most-
// recent active room. Returns an error when the named room isn't active or none is —
// so a steer never silently targets a finished or wrong room.
function resolveSteerTarget(roomArg?: string): { slug: string } | { error: string } {
  const explicit = (roomArg ?? "").trim();
  if (explicit) {
    if (!isSafeSlug(explicit)) return { error: `unsafe room slug: ${JSON.stringify(explicit)}` };
    if (!activeRooms.has(explicit)) {
      return { error: `Chamber room "${explicit}" is not active — check chamber_room_status.` };
    }
    return { slug: explicit };
  }
  const slug = mostRecentActiveSlug();
  if (!slug) return { error: "No active Chamber room. Start one with chamber_room_start." };
  return { slug };
}

// A say/stop reply names which room it hit when several are active (the default
// target is otherwise implicit); with one room the slug is just noise. One helper so
// say and stop can't drift on the threshold or the format.
function roomNote(slug: string): string {
  return activeRooms.size > 1 ? ` (${slug})` : "";
}

// The synchronous seed the banner holds for the instant between registration and the
// first async compose (createCoalescingPublisher needs a sync default). A valid, calm
// board; publishBriefing() replaces it with the composed three-register banner.
function seedBriefingBoard(): CanvasBoardView {
  return {
    view: "board",
    title: "Briefing",
    header: { status: { label: "Up to date", tone: "neutral" } },
    sections: [{ kind: "rows", title: "The record", items: [{ glyph: "neutral", text: "…" }] }],
  };
}

// The record register's cap in the always-on banner: fewer rows than the store-level
// default so the heartbeat stays a glance, not a scrollable log.
const BANNER_RECORD_LIMIT = 4;

// The one narrator, composed in-process from three producers and published to
// BRIEF_KEY. Attention-ordered top to bottom: the delta leads (what's new since you
// last looked), the digest interprets (the standing synthesis), the record grounds
// (recent events). Quiet is STRUCTURAL — a register renders only when it has something
// to say: the delta only when promoted, the digest only once the chamber has content
// (sparse = absent, never narrated), the record always (a single hint line on a fresh
// chamber). No paid turn runs here — the delta and digest are read from where their
// (separately gated) turns already wrote.
async function composeBriefingBoard(): Promise<CanvasBoardView> {
  const [mindRecords, rooms, lenses, digest] = await Promise.all([
    listMindRecords(mindsDir()).catch(() => []),
    listRooms(roomsDir()).catch(() => []),
    listLenses(lensesDir()).catch(() => []),
    readDigest().catch(() => null),
  ]);
  const sections: CanvasBoardView["sections"] = [];

  // 1. Delta — the promoted brief turn's content, labelled on its first section,
  //    followed by its deterministic jump chips (from the gate's structured delta,
  //    reusing the index cards' own open verbs — the prose stays the narrative,
  //    the chips are only the way there).
  if (promotedDelta && promotedDelta.length > 0) {
    const [first, ...rest] = promotedDelta;
    if (first) sections.push({ ...first, title: "Since you last looked" }, ...rest);
    if (promotedSources.length > 0) {
      sections.push({
        kind: "actions",
        title: "Open what changed",
        wrap: true,
        items: promotedSources.map((s) =>
          s.kind === "room"
            ? { type: "room-open", label: `${s.label} ↗`, glyph: "▦", payload: { slug: s.ref } }
            : { type: "lens-open", label: `${s.label} ↗`, glyph: "❖", payload: { id: s.ref } },
        ),
      });
    }
  }

  // 2. Digest — the standing synthesis, only once the chamber has content. Drop any
  //    stats section the turn may have authored so an index count can't creep back
  //    into the one narrator; label the register on its first surviving section.
  const hasContent = mindRecords.length > 0 || rooms.length > 0 || lenses.length > 0;
  if (hasContent && digest?.board) {
    // readDigest only checks `board` is an object; guard `sections` so a torn digest.json
    // can't throw here and drop the WHOLE banner publish (delta + record too).
    const digestSections = Array.isArray(digest.board.sections) ? digest.board.sections : [];
    const kept = digestSections.filter((s) => s.kind !== "stats");
    const [first, ...rest] = kept;
    if (first) sections.push({ ...first, title: "Digest" }, ...rest);
  }

  // 3. Record — always present.
  sections.push(recordSection(mindRecords, rooms, lenses, Date.now(), BANNER_RECORD_LIMIT));

  return {
    view: "board",
    title: "Briefing",
    header: {
      status:
        promotedCount > 0
          ? { label: `${promotedCount} new`, tone: "brand" }
          : { label: "Up to date", tone: "neutral" },
    },
    sections,
  };
}

// Re-compose and publish the banner. Serialized so a mutation-driven refresh and a gate
// promote can't race two composes onto one publish; never throws into a fire-and-forget
// caller. A no-op when the publisher seam is absent (older harness).
function publishBriefing(): Promise<void> {
  const run = async (): Promise<void> => {
    if (!briefPublisher) return;
    try {
      await briefPublisher.publish(await composeBriefingBoard());
    } catch (e) {
      console.error(`[rib-chamber] briefing publish failed: ${errText(e)}`);
    }
  };
  const next = briefingPublishInFlight.then(run, run);
  briefingPublishInFlight = next.catch(() => {});
  return next;
}

// The brief turn's budget. A briefing is a single composing turn (no tools), so a
// modest ceiling bounds a wedged provider without starving a normal compose.
const BRIEF_TURN_TIMEOUT_MS = 60_000;

// The only chamber verbs an untrusted HTML-lens iframe may reach (origin
// "canvas-html"): a no-op ack (`lens-html`) and read-only navigation to a lens
// panel (`lens-open`). Everything destructive or paid stays off this list, so a
// prompt-injected lens can't drive retire / room-* / set-model / convene. See #124.
const FRAME_SAFE_ACTIONS: ReadonlySet<string> = new Set(["lens-html", "lens-open"]);

// The rib's view declarations, mutable at runtime: the host resolves a snapshot
// key's canvas kind by EXACT match against this list (per GET /api/ribs request),
// so each per-subject HTML lens must add its own `canvasKind: "html"` entry here
// or the drawer would render its string frame through the board pipeline. The
// registry's declareView seam pushes/removes entries; the statics stay fixed.
const RIB_VIEWS: RibViewDescriptor[] = [
  { key: PRESENCE_KEY, canvasKind: "view", title: "The Chamber" },
  { key: ROSTER_KEY, canvasKind: "view", title: "Roster" },
  { key: CONVENE_KEY, canvasKind: "view", title: "Convene" },
  { key: ROOMS_KEY, canvasKind: "view", title: "Rooms" },
  { key: LENSES_KEY, canvasKind: "view", title: "Lenses" },
  { key: EXHIBITS_KEY, canvasKind: "view", title: "Exhibits" },
  // DIGEST_KEY has no surface region of its own anymore — the standing digest folds
  // into the Briefing banner's Digest register — but the chamber-digest workflow
  // still binds it (its store is what the banner reads), so the view stays declared.
  { key: DIGEST_KEY, canvasKind: "view", title: "Digest" },
  { key: HTML_LENS_KEY, canvasKind: "html", title: "HTML Lens" },
  { key: BRIEF_KEY, canvasKind: "view", title: "Briefing" },
];

function declareHtmlLensView(id: string, title?: string): () => void {
  const view: RibViewDescriptor = {
    key: htmlLensKey(id),
    canvasKind: "html",
    title: title ?? id,
  };
  RIB_VIEWS.push(view);
  return () => {
    const at = RIB_VIEWS.indexOf(view);
    if (at >= 0) RIB_VIEWS.splice(at, 1);
  };
}

const rib: Rib = {
  id: "chamber",
  displayName: "Chamber",

  contributeDocs: () => [
    {
      title: "Chamber",
      summary:
        "The Chamber rib for Keelson: convene Minds in multi-agent rooms, table exhibits, and publish standing lenses. Covers genesis, room strategies, agent-authored lenses, when to convene, and the rib's design.",
      llmsFullUrl: "https://danielscholl.github.io/keelson-rib-chamber/llms-full.txt",
    },
  ],

  // Binds the agent-authored keys to the canvas renderer; data arrives when the
  // producers (the roster collector, the brief turn, the room driver) run.
  views: RIB_VIEWS,

  // No static actions[]: a payload-less button can't carry input, so every Chamber
  // control lives where its context is. Genesis is the chamber-genesis workflow (it
  // needs a freeform brief); retire and the room controls (start/inject/stop) are
  // payload-carrying board actions (the OSDU pattern) that reach onAction below.

  // The Chamber nav tab. The Chamber panel leads in the header (the bench itself:
  // seat cards, authoring, live pulse), the Briefing banner follows as the
  // always-on heartbeat (the one narrator, folding what were three what's-happening
  // panels — delta / digest / record — into one), and the
  // standing row pairs the sessions index (ended rooms) with the lenses index (the
  // living views) at half width each. The live room panels and
  // lens panels are push-fed dynamic regions a producer registers at runtime — each
  // ACTIVE room registers its own per-slug region (group "rooms") on start via
  // room-region-registry, and a Mind authors lenses (chamber_emit_lens, group "lens"),
  // all through registerRegion. The rooms index is the history of CLOSED rooms (an
  // active room shows as its live inline panel); the lenses index sits alongside each
  // lens's own live panel, with Open focusing it.
  surfaces: [
    {
      id: CHAMBER_SURFACE_ID,
      title: "Chamber",
      subtitle: "Author Minds · convene Rooms · keep Lenses · table Exhibits · read the Briefing",
      // Chamber panels are an authoring console, not snapshot cards to lift into chat,
      // so drop the host's per-region explore/select/expand chrome. Board actions
      // (Enter a Mind, room controls) still flow — only the head-strip icons go.
      hideRegionActions: true,
      layout: {
        // The Chamber panel leads: the bench itself — seat cards, boot card,
        // authoring launchpad, live pulse.
        // Not collapsible — it is the focal panel every visit. In-process (no
        // workflow binding); the rib recomposes it on any roster/rooms mutation,
        // and the genesis ticker's frames pulse the head dot (keelson#353).
        header: {
          key: PRESENCE_KEY,
          title: "The Chamber",
          glyph: { char: "◈", tone: "brand" },
          live: true,
        },
        // Binds no `workflow`: the Briefing is rib-driven, composed and re-published
        // in-process, so a binding would make the SPA try to refresh a workflow that
        // does not exist.
        banner: {
          key: BRIEF_KEY,
          title: "Briefing",
          glyph: { char: "❖", tone: "brand" },
        },
        rows: [
          {
            columns: [
              {
                key: CONVENE_KEY,
                title: "Convene",
                // In-process board (no workflow binding): the rib recomposes it on a
                // roster/draft/convene mutation, not on cadence. Collapsible so it folds
                // to its head bar once rooms exist (the board's defaultCollapsed hint),
                // a one-click open when you want it — the empty-state cold.
                collapsible: true,
                glyph: { char: "＋", tone: "brand" },
              },
            ],
          },
          {
            columns: [
              {
                key: ROOMS_KEY,
                workflow: "chamber-rooms",
                title: "Rooms",
                // Like the roster: a cheap deterministic disk read that changes only
                // when a room ends or is deleted; the same modest cadence keeps it
                // self-populating on open, with room-delete refreshing it on demand.
                cadenceMs: 120_000,
                // A long ended-sessions index can collapse to its head strip.
                collapsible: true,
                glyph: { char: "▦", tone: "brand" },
              },
              {
                key: LENSES_KEY,
                workflow: "chamber-lenses",
                title: "Lenses",
                // The living-views index: a cheap deterministic disk read that
                // changes only on author/retire; the same modest cadence self-
                // populates it on open, with author + retire refreshing it on demand.
                cadenceMs: 120_000,
                // A long living-views index can collapse to its head strip.
                collapsible: true,
                glyph: { char: "✦", tone: "accent" },
              },
            ],
          },
          {
            columns: [
              {
                key: EXHIBITS_KEY,
                workflow: "chamber-exhibits",
                title: "Exhibits",
                // The tabled-deliverables index, the lenses index's sibling: same
                // cheap collector + cadence, refreshed on table/delete. hideWhenEmpty
                // keeps the shelf invisible until a discussion has tabled something
                // (the builder emits zero sections when empty), so a fresh Chamber
                // doesn't advertise a concept it hasn't produced.
                cadenceMs: 120_000,
                collapsible: true,
                hideWhenEmpty: true,
                glyph: { char: "▣", tone: "caution" },
              },
            ],
          },
        ],
      },
    },
  ],

  contributeWorkflows: contributeChamberWorkflows,

  // Boot-time wiring of the room loop. Builds the driver against the real seams:
  // runAgentTurn (C1) for the turns, the per-slug room region registry as the
  // publisher (each room's board is cached and recomposed under its own
  // rib:chamber:room:<slug> key — a live WS push, no collector), the FS data home as
  // the store, and the roster as the minds resolver. The seams are optional, so the
  // driver stays undefined on a host without them and room actions fail closed.
  registerTools: (ctx: RibContext) => {
    // Capture the data home from the blessed ctx.getDataDir seam once, before any
    // store/driver/region is built from it — and before contributeWorkflows bakes
    // the path into the roster bash node. When the seam is absent (older harness),
    // leave it uncaptured: chamberDataHome() lazily resolves ribDataDir("chamber").
    const dataDir = ctx.getDataDir?.();
    if (dataDir) setChamberDataHome(dataDir);
    // Capture the refresh seam for onAction handlers (room-delete refreshes the
    // sessions index). dispose() clears it so a re-boot recaptures the new ctx's.
    // Wrapped so any roster refresh (genesis, retire, set-model — a Mind or its
    // provider changed) also recomposes the in-process Convene board, whose chips +
    // capability gating draw from the same Minds; draft-set / convene call
    // refreshConvene directly. The Presence ribbon draws from both the bench and the
    // rooms, so recompose it on either a roster or a rooms refresh.
    const rawRefresh = ctx.refreshWorkflow;
    hostRefreshWorkflow = rawRefresh;
    // Always defined, even when the host has no refresh seam: Convene and Presence are
    // cadence-free in-process boards, so their local recompose must fire on a
    // roster/rooms mutation regardless — else they would freeze at their first snapshot
    // on a host that provides a snapshot manager but no refreshWorkflow.
    refreshWorkflow = (name, inputs) => {
      if (name === "chamber-roster") refreshConvene();
      if (name === "chamber-roster" || name === "chamber-rooms") refreshPresence();
      return rawRefresh?.(name, inputs) ?? Promise.resolve();
    };
    // Capture the host projects lookup so a room can be targeted at a project
    // (per-room turn cwd = project.rootPath). dispose() clears it like the above.
    getProjects = ctx.getProjects;
    // A (re-)boot reopens the gate after any prior dispose: hand the gate a fresh
    // controller so its turns aren't pre-aborted (the prior, aborted one stays bound
    // to any orphaned in-flight turn, keeping that turn gated out).
    briefAbort = new AbortController();
    // Same for the reflection gate: a fresh controller so a re-boot's reflection
    // turns aren't pre-aborted, while any orphaned pre-dispose turn stays gated out.
    reflectAbort = new AbortController();
    // The genesis write seam is always available: genesis is a workflow whose
    // prompt node calls chamber_emit_genesis, and the write needs no room driver.
    // The room-control tools (and the driver) require the C1 agent-turn + snapshot
    // seams, so they only appear when those are present.
    // Pass the refresh seam so a genesis write re-runs the bound chamber-roster
    // collector (republishing the roster), not just the 120s cadence. Optional and
    // fail-soft: undefined on an older harness, where genesis falls back to cadence.
    const genesisTool = makeGenesisTool(refreshWorkflow);
    // The digest write seam is always available, like genesis: it only writes the
    // digest store (no snapshot/turn seam needed), and the chamber-digest workflow's
    // author node opts in to it by name.
    const digestTool = makeDigestTool();
    // Like genesis and digest, the list and cleanup tools need only the disk paths
    // captured above, so they are always available — independent of the snapshot/turn seams.
    const readTools = [
      makeListMindsTool(),
      makeListRoomsTool(),
      makeListLensesTool(),
      makeListExhibitsTool(),
      makeRoomTranscriptTool(),
    ];
    const cleanupTools = [makeRetireMindTool(), makeRoomDeleteTool()];
    const sm = ctx.getSnapshotManager?.();
    const registerRegion = ctx.registerRegion;
    const run = ctx.runAgentTurn;
    // The Briefing banner is rib-driven (no workflow binding): wire its publisher
    // here, gated on the snapshot + agent-turn seams the gate needs to run a turn.
    // Mirrors ensureRoomViewPublisher — a coalescing publisher on BRIEF_KEY, rebound
    // onto a new manager on a re-bootstrap. Seed the cache with the quiet board so the
    // banner renders calm copy immediately (not the idle "Load" state), and capture
    // runAgentTurn so the gate can promote to a paid turn when substance appears.
    if (sm && run && (sm !== briefSm || !briefPublisher)) {
      briefUnregister?.();
      const { publisher, latest } = createCoalescingPublisher(
        () => sm.recompose(BRIEF_KEY),
        seedBriefingBoard(),
      );
      briefUnregister = sm.register(BRIEF_KEY, latest, {
        validate: expectView(BRIEF_KEY, "board"),
      });
      briefPublisher = publisher;
      briefSm = sm;
      briefRunAgentTurn = run;
      // A re-boot starts the delta register empty (briefPromoted is cleared below); the
      // digest + record are read fresh by the first compose.
      promotedDelta = undefined;
      promotedCount = 0;
      promotedSources = [];
      // Prime BRIEF_KEY so a client subscribing the instant the banner appears reads the
      // seed, then compose the real three-register banner (record + any standing digest)
      // in the background so it doesn't wait on the next mutation.
      void sm.recompose(BRIEF_KEY);
      void publishBriefing();
      // The banner's delta register is empty, but a persisted briefPromoted:true would
      // make the pulse ("For you") read "1 waiting" against it until the next event.
      // Clear the flag (preserving the acks) so the two agree from boot. Serialized
      // through briefInFlight so it can't lose-update a concurrent gate promotion's
      // watermark write — both are read-modify-writes of the same file.
      briefInFlight = briefInFlight.then(clearPersistedBriefPromoted, clearPersistedBriefPromoted);
    }
    // The Convene composer: an in-process board (needs getProjects) registered on the
    // snapshot manager and primed once; rebound onto a new manager on a re-bootstrap.
    if (sm && sm !== conveneSm) {
      conveneUnregister?.();
      conveneUnregister = sm.register(CONVENE_KEY, composeConveneBoard, {
        validate: expectView(CONVENE_KEY, "board"),
      });
      conveneSm = sm;
      void sm.recompose(CONVENE_KEY);
    }
    // The Chamber panel: an in-process board (reads the bench + rooms + the pending
    // marker) registered on the snapshot manager and primed once; rebound onto a new
    // manager on a re-boot, like Convene.
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
        const freshest = Math.max(
          ...markers.map((m) => GENESIS_STALL_MS - pendingElapsedMs(m, now)),
        );
        if (freshest <= 0) refreshPresence();
        // + FUTURE_SKEW_MS: a marker up to the skew tolerance in the future clamps
        // elapsed to 0, so the deadline must outlast the card's own clock reaching
        // the stall — the final tick has to compose the stalled card, never stop
        // one frame short of its Dismiss.
        else startGenesisTick(freshest + FUTURE_SKEW_MS);
      });
    }
    // Lenses render via the registerRegion seam, so the registry and its emit tool
    // wire up only when BOTH the snapshot manager and registerRegion are present —
    // independent of the room's C1 agent-turn seam (the room tools below additionally
    // require runAgentTurn). Without registerRegion the tool is withheld (fail closed)
    // rather than publishing invisible, unbounded keys that never render. Created once
    // (a module singleton, like the room driver) and reused on a later registerTools so
    // its keys aren't registered twice. If a different manager arrives (a re-bootstrap
    // without an intervening dispose), rebuild against it rather than publishing through
    // the stale manager. Build the replacement BEFORE disposing the old one, so a failed
    // rebuild leaves the existing registry and lensSm consistent.
    const lensStore = createFileLensStore(lensesDir());
    if (!sm || !registerRegion) {
      htmlLensRegistry?.dispose();
      htmlLensRegistry = undefined;
      htmlLensSm = undefined;
      htmlLensRegisterRegion = undefined;
    } else if (
      !htmlLensRegistry ||
      sm !== htmlLensSm ||
      registerRegion !== htmlLensRegisterRegion
    ) {
      const next = createHtmlLensRegistry(
        sm,
        registerRegion,
        createFileHtmlLensStore(htmlLensesDir()),
        declareHtmlLensView,
      );
      htmlLensRegistry?.dispose();
      htmlLensRegistry = next;
      htmlLensSm = sm;
      htmlLensRegisterRegion = registerRegion;
      // Re-register every persisted HTML lens so it survives a restart (key +
      // region + views entry back live). Fail-soft per entry, like board lenses.
      reconcileHtmlLensPanels(next);
    }
    if (sm && registerRegion && sm !== lensSm) {
      const next = createLensRegistry(sm, registerRegion, lensStore);
      lensRegistry?.dispose();
      lensRegistry = next;
      lensSm = sm;
      // Re-register every persisted lens so it survives a restart: each becomes a
      // live region again (its snapshot key present for the index/open path).
      // Fail-soft per entry — one bad lens can't break boot.
      reconcileLensPanels(next);
    }
    const lensTools =
      sm && registerRegion && lensRegistry
        ? [
            makeLensTool(lensStore, lensRegistry),
            makeRetireLensTool(),
            makeTableExhibitTool(lensStore, lensRegistry),
            makeDeleteExhibitTool(),
          ]
        : [];
    const htmlLensTools =
      sm && registerRegion && htmlLensRegistry ? [makeEmitLensHtmlTool(htmlLensRegistry)] : [];
    // The room publisher routes each room's board to a per-slug key + dynamic surface
    // region, so it requires registerRegion. Rebuilt against a new manager on a
    // re-bootstrap, reused otherwise; built before the old one is disposed so a failed
    // rebuild leaves the existing registry and roomSm consistent.
    if (sm && registerRegion && run) {
      let registry = roomRegistry;
      if (!registry || sm !== roomSm) {
        registry = createRoomRegionRegistry(sm, registerRegion);
        roomRegistry?.dispose();
        roomRegistry = registry;
        roomSm = sm;
      }
      const roomStore = createFileRoomStore(roomsDir());
      // Capture the agent-turn seam for the close-only reflection pass (onRoomClosed,
      // below) — the same run this driver uses for room turns.
      reflectRunAgentTurn = run;
      driver = createRoomDriver({
        store: roomStore,
        publisher: registry,
        runAgentTurn: run,
        minds: resolveMinds,
        // Compose each turn's system prompt from the Mind's soul PLUS its durable
        // memory + rules, so a speaker carries what it has learned into the room.
        composeTurnSystem: (mind) => composeRoomSystemPrompt(mindsDir(), mind),
        // Fire the reflection gate when a room closes (gated, fire-and-forget).
        onRoomClosed,
        turnCwd: chamberDataHome(),
        resolveProjectRoot,
        resolveProjectName,
        // Base room tools are still a ceiling: the exhibit seam only when wired,
        // plus external read-only names that resolve only for declaring Minds. Rooms
        // table EXHIBITS (deliverables), not lenses — authoring a standing lens
        // stays the operator's /lens act, so the two shelves can't re-cross.
        turnTools: [...(lensRegistry ? [{ name: EXHIBIT_TOOL_NAME }] : []), ...externalToolPool()],
        // The witnessed-provenance stamp: the driver saw the table-exhibit tool run
        // in this room's turn, so record the room as the exhibit's source.
        onExhibitsTabled: (ids, room) => stampExhibitSources(ids, room),
        // The coding pool (host built-ins), always handed over but inert until a
        // room opts in (room.coding) and is confined — the tier is gated per-room.
        codingTools: codingToolPool(),
        // The read pool (host built-in: Read), granted to every speaker in a room that
        // targets a project, confined to the project root — so a Discussion can read
        // the repo it's about without the coding tier or a per-Mind `read` declaration.
        readTools: readToolPool(),
      });
      queueRoomRetentionSweep();
      // Expose the room controls as chat tools (start / say / stop / status),
      // sharing the same driver + store this hook just built. Returned only when
      // the seams are present (no driver -> no tools), mirroring how the actions
      // fail closed.
      return [
        genesisTool,
        digestTool,
        ...readTools,
        ...cleanupTools,
        ...lensTools,
        ...htmlLensTools,
        ...roomControlTools(roomStore),
      ];
    }
    return [genesisTool, digestTool, ...readTools, ...cleanupTools, ...lensTools, ...htmlLensTools];
  },

  // Retire a Mind (removes it, then refreshes the roster — the OSDU
  // mutate-then-refresh pattern). The room-* controls drive the room loop; the
  // transcript pushes to the canvas as turns land (no refresh needed). Turns
  // advance on their own (the auto-advance loop), so there is no manual step.
  onAction: (action) => {
    // Actions relayed from the sandboxed HTML-lens iframe arrive with origin
    // "canvas-html" (the host stamps it; the frame can't forge it — see #124). That
    // markup is LLM-authored and can auto-fire on load, so gate it to a non-paid,
    // non-destructive subset — never retire / room-* / set-model / convene. Trusted
    // board actions (origin absent) keep the full verb surface below.
    if (action.origin === "canvas-html" && !FRAME_SAFE_ACTIONS.has(action.type)) {
      return { ok: false, error: `'${action.type}' is not permitted from an HTML lens` };
    }
    switch (action.type) {
      case "enter-mind":
        return enterMindAction(action);
      case "author-archetype":
        return authorArchetypeAction(action);
      case "author-lens":
        return authorLensAction(action);
      case "describe-own":
        return describeOwnAction(action);
      case "dismiss-genesis":
        return dismissGenesisAction(action);
      case "retire":
        return retireAction(action);
      case "set-model":
        return setModelAction(action);
      case "lens-html":
        return lensHtmlAction(action);
      case "room-start":
        return roomStartAction(action);
      case "draft-set":
        return draftSetAction(action);
      case "convene":
        return conveneAction(action);
      case "room-inject":
        return roomInjectAction(action);
      case "room-stop":
        return roomStopAction(action);
      case "room-delete":
        return roomDeleteAction(action);
      case "room-open":
        return roomOpenAction(action);
      case "outcome-copy":
        return outcomeCopyAction(action);
      case "outcome-explore":
        return outcomeExploreAction(action);
      case "retire-lens":
        return retireLensAction(action);
      case "retire-lens-html":
        return retireHtmlLensAction(action);
      case "delete-exhibit":
        return deleteExhibitAction(action);
      case "lens-open":
        return lensOpenAction(action);
      case "lens-note":
        return lensNoteAction(action);
      case "refresh-lens":
        return refreshLensAction(action);
      default:
        return { ok: false, error: `unknown action '${action.type}'` };
    }
  },

  // Agents: every Mind is enterable as a keelson agent (GET /api/agents, the /mind
  // command's source). resolveAgent builds the same seed the roster Enter action
  // does (buildSeedFor), so the two entry points can't drift.
  listAgents: () => listAgents(),
  resolveAgent: (slug: string) => resolveAgent(slug),

  // Slash commands: /mind opens a Mind as a seeded chat (resolved through the
  // agents seam via the open-agent effect); /genesis authors a new Mind by running
  // the chamber-genesis workflow with the brief as $ARGUMENTS.
  listCommands: () => CHAMBER_COMMANDS,
  completeCommand: (name, prefix) => completeChamberCommand(name, prefix),
  invokeCommand: (name, arg) => invokeChamberCommand(name, arg),

  // A rib can't introspect provider availability (runAgentTurn resolves one at
  // turn time), so this asserts only the seams + data home; a missing provider
  // surfaces at the first room turn, not here.
  authStatus: async (ctx: RibContext): Promise<RibAuthStatus> => {
    if (!(await isChamberDataHomeWritable())) {
      return {
        authenticated: false,
        statusMessage: `data home not writable: ${chamberDataHome()}`,
      };
    }
    if (!ctx.getSnapshotManager) {
      return { authenticated: false, statusMessage: "snapshot manager not available" };
    }
    if (!ctx.runAgentTurn) {
      return {
        authenticated: false,
        statusMessage: "agent-turn seam not wired (rooms unavailable)",
      };
    }
    if (!ctx.registerRegion) {
      return {
        authenticated: false,
        statusMessage: "region registration not available (rooms & lenses unavailable)",
      };
    }
    return {
      authenticated: true,
      statusMessage: "rooms & lenses wired; provider resolved at turn time",
    };
  },

  // Shutdown: stop the auto-advance loops and abort any in-flight turn so a CLI
  // child can't keep running (or publish) after teardown. driver.dispose() sets
  // the disposal flag the loop observes (so it stops between turns), and the
  // in-flight turn drops its late append/commit instead of writing post-teardown
  // — so a room caught mid-turn is left as-is on disk (status stays "active"; a
  // fresh process re-reads it), not finalized to "stopped". Resets the roster
  // cache too, so a re-boot re-reads minds.
  dispose: async () => {
    loops.clear();
    activeRooms.clear();
    lastSlug = undefined;
    stopRoomsTick();
    // A genesis can't survive the process — stop its tick and clear the marker so a
    // re-boot doesn't render a boot card for a workflow that died with the old process.
    stopGenesisTick();
    await clearPendingGenesis().catch(() => {});
    refreshWorkflow = undefined;
    hostRefreshWorkflow = undefined;
    getProjects = undefined;
    conveneUnregister?.();
    conveneUnregister = undefined;
    conveneSm = undefined;
    presenceUnregister?.();
    presenceUnregister = undefined;
    presenceSm = undefined;
    briefUnregister?.();
    briefUnregister = undefined;
    briefPublisher = undefined;
    briefSm = undefined;
    briefRunAgentTurn = undefined;
    // Abort the gate's in-flight (paid) turn; its post-turn signal re-check then drops
    // any late publish/write. Reset the serialization chain so a re-bootstrap (or the
    // next test) starts fresh — an aborted turn that ignores the signal must not leave
    // briefInFlight parked on a never-settling promise (that would wedge a later boot).
    briefAbort.abort();
    briefInFlight = Promise.resolve();
    // Reset the banner's in-memory registers so a re-boot starts with an empty delta
    // and a fresh publish chain.
    promotedDelta = undefined;
    promotedCount = 0;
    promotedSources = [];
    briefingPublishInFlight = Promise.resolve();
    // Abort in-flight reflection and drain its writes so a late memory write can't
    // land after teardown; reset the per-Mind write chains for the next boot.
    reflectRunAgentTurn = undefined;
    reflectAbort.abort();
    await Promise.allSettled([...reflectWrites.values()]);
    reflectWrites.clear();
    invalidateRoster();
    // Drain any in-flight lens write-back before tearing down the registry, so a
    // late load-append-publish can't publish to a disposed registry or interleave
    // with a re-boot's writes.
    await lensWriteInFlight.catch(() => {});
    lensWriteInFlight = Promise.resolve();
    htmlLensRegistry?.dispose();
    htmlLensRegistry = undefined;
    htmlLensSm = undefined;
    htmlLensRegisterRegion = undefined;
    lensRegistry?.dispose();
    lensRegistry = undefined;
    lensSm = undefined;
    roomRegistry?.dispose();
    roomRegistry = undefined;
    roomSm = undefined;
    releaseRoomViews();
    roomViewSm = undefined;
    await driver?.dispose();
  },
};

const ROOM_DISABLED: RibActionResult = {
  ok: false,
  error: "room controls require the C1 agent-turn seam and a snapshot manager",
};

// Drive turns on their own until the room leaves "active" (budget reached, or a
// stop/inject ended it). Detached and idempotent per slug: room-start kicks it,
// the driver's serial gate + generation gating keep one turn at a time, and a
// stop aborts the in-flight turn so step() reports the room is no longer active
// and the loop exits. step() is the sole room.json reader for the drive decision
// (it returns a StepOutcome), so the loop no longer re-reads it. Errors are
// logged, never thrown into the (already-returned) action.
function ensureLoop(slug: string): void {
  if (!driver || driver.isDisposed() || loops.has(slug)) return;
  loops.add(slug);
  const activeDriver = driver;
  void (async () => {
    try {
      while (!activeDriver.isDisposed()) {
        // Stop only when the room left "active" (budget reached, stopped, or
        // superseded). "busy" can't occur here — this loop is the sole stepper
        // and awaits each step fully — so anything but "ended" means keep going.
        if ((await activeDriver.step(slug)) === "ended") break;
      }
    } catch (e) {
      console.error(`[rib-chamber] room loop '${slug}' failed: ${errText(e)}`);
      // The loop died mid-room: the driver still holds this slug as an active
      // room and room.json is still "active". Force-stop so the driver and disk
      // agree with the active-set cleanup below — otherwise the room lingers as a
      // wedged active room nothing ever clears.
      try {
        await activeDriver.stop(slug);
      } catch (stopErr) {
        console.error(`[rib-chamber] failed to stop wedged room '${slug}': ${errText(stopErr)}`);
      }
    } finally {
      loops.delete(slug);
      // The room left "active" — drop it from the active set and reconcile the
      // surface so its panel is released unless it is still the most-recent room.
      activeRooms.delete(slug);
      reconcileRoomPanels();
      queueRoomRetentionSweep();
      // The room just became a closed session — refresh the index so its card
      // appears promptly instead of on the next cadence. Fail-soft, never thrown
      // into the detached loop.
      void refreshWorkflow?.("chamber-rooms")?.catch(() => {});
      // A newly-ended room is briefing substance: evaluate the gate (it runs a turn
      // only if the watermark hasn't seen this room) and refresh the roster so its
      // pulse counts/for-you update promptly. Both fire-and-forget — never thrown.
      void evaluateBriefGate().catch(() => {});
      void refreshWorkflow?.("chamber-roster")?.catch(() => {});
      void refreshStandingPanels();
    }
  })();
}

// Validate + canonicalize room-start inputs, shared by startRoom and the
// chamber_room_start dry-run so the dry-run never advertises a start the real
// path would reject. De-dupes participants and requires at least two DISTINCT
// valid speakers — the tool schema's min(2) counts RAW entries, so ["a","a"]
// would otherwise collapse to a one-Mind room — and that each names a real Mind,
// since the chat tool takes free-form slugs (a typo would otherwise open a room
// that dies on "unknown mind" mid-rotation after burning paid turns).
type StartConfigInput = RoomConfigInput;

// The positive-integer floor for the routing knobs both group-chat and open-floor
// accept. Floored at the shared boundary so every entry point (chat tool, board
// action, a direct API payload) is protected — a 0 minRounds would open the close
// gate immediately, a 0 maxSpeakerRepeats would redirect every pick.
function validationFailure(errors: string[]): { ok: false; error: string } {
  return { ok: false, error: errors.join("\n") };
}

function routingKnobErrors(config: StartConfigInput): string[] {
  const errors: string[] = [];
  if (
    config.minRounds !== undefined &&
    (!Number.isInteger(config.minRounds) || config.minRounds < 1)
  ) {
    errors.push("minRounds must be a positive integer");
  }
  if (
    config.maxSpeakerRepeats !== undefined &&
    (!Number.isInteger(config.maxSpeakerRepeats) || config.maxSpeakerRepeats < 1)
  ) {
    errors.push("maxSpeakerRepeats must be a positive integer");
  }
  return errors;
}

async function validateStart(
  participants: readonly string[],
  turnBudget: number,
  strategy: string,
  config: StartConfigInput = {},
  projectId?: string,
  coding?: boolean,
): Promise<
  { ok: true; participants: string[]; config?: RoomConfig } | { ok: false; error: string }
> {
  const deduped = [...new Set(participants)];
  if (deduped.length < 2 || !deduped.every(isValidParticipant)) {
    return {
      ok: false,
      error: "a room needs at least 2 distinct participants (safe Mind slugs, not director/system)",
    };
  }
  if (!Number.isInteger(turnBudget) || turnBudget <= 0 || turnBudget > MAX_ROOM_TURN_BUDGET) {
    return { ok: false, error: `turnBudget must be an integer in 1..${MAX_ROOM_TURN_BUDGET}` };
  }
  // Reject an unknown/unregistered strategy here (the dry-run calls validateStart but
  // not driver.start), so a typo or an unimplemented strategy can't be advertised as
  // startable and then fail in driver.start's getStrategy on the confirmed path.
  try {
    getStrategy(strategy as RoomStrategyName);
  } catch {
    return { ok: false, error: `unknown strategy "${strategy}"` };
  }
  // Fail closed on an unknown projectId (or an absent getProjects seam). Checked
  // here, not in driver.start, so the dry-run — which calls validateStart but not
  // startRoom — never advertises a target the confirm path would reject.
  if (projectId !== undefined && !resolveProjectRoot(projectId)) {
    return {
      ok: false,
      error: `unknown project "${projectId}" — pick a project from the host's project list`,
    };
  }
  // The coding tier is unconfined without a repo to bound it to: a coding room's
  // turns run Bash/Edit/Write confined to the project root (allowedDirectories), so
  // require a project. Checked here, not in the driver, so the dry-run rejects an
  // unbounded coding room before advertising a start the confirm path can't honor.
  if (coding && projectId === undefined) {
    return {
      ok: false,
      error:
        "a coding room must target a project (set `projectId`) — coding tools are confined to the project's repo",
    };
  }
  const minds = await resolveMinds();
  const known = new Set(minds.map((m) => m.slug));
  const missing = deduped.filter((s) => !known.has(s));
  if (missing.length > 0) {
    return {
      ok: false,
      error: `unknown Mind(s): ${missing.join(", ")} — genesis them first or check the roster`,
    };
  }
  const managerConfigErrors =
    strategy !== "magentic" && config.manager
      ? [`${strategy} has no manager — \`manager\` is only for the magentic strategy`]
      : [];
  // group-chat needs a moderator Mind that routes but never speaks: it must be a
  // real Mind and NOT in the speaker pool (so isValidNominee rejects nominating it
  // and the board never counts it as a speaker — see docs/design/phase3-rooms.md §1).
  if (strategy === "group-chat") {
    const errors: string[] = [...managerConfigErrors];
    const moderator = config.moderator;
    if (!moderator) {
      errors.push("group-chat needs a moderator Mind — set `moderator`");
    } else {
      if (!isValidParticipant(moderator)) {
        errors.push("moderator must be a safe Mind slug (not director/system)");
      }
      if (!known.has(moderator)) {
        errors.push(`unknown moderator Mind: ${moderator} — genesis it first or check the roster`);
      }
      if (deduped.includes(moderator)) {
        errors.push("the moderator must not also be a participant — it routes, it does not speak");
      }
    }
    if (config.synthesizer) {
      // Same safe/reserved-slug guard as the moderator: a synthesizer authors a
      // role:"agent" turn, so it must never be a reserved authority (director/system).
      if (!isValidParticipant(config.synthesizer)) {
        errors.push("synthesizer must be a safe Mind slug (not director/system)");
      }
      if (!known.has(config.synthesizer)) {
        errors.push(`unknown synthesizer Mind: ${config.synthesizer}`);
      }
      if (deduped.includes(config.synthesizer)) {
        errors.push(
          "the synthesizer must not also be a participant — it writes the closing summary, it does not debate",
        );
      }
      if (config.synthesizer === moderator) {
        errors.push("the synthesizer must not also be the moderator — they are distinct roles");
      }
    }
    errors.push(...routingKnobErrors(config));
    if (errors.length > 0) return validationFailure(errors);
    const roomConfig: RoomConfig = {
      moderator,
      ...(config.synthesizer ? { synthesizer: config.synthesizer } : {}),
      ...(typeof config.minRounds === "number" ? { minRounds: config.minRounds } : {}),
      ...(typeof config.maxSpeakerRepeats === "number"
        ? { maxSpeakerRepeats: config.maxSpeakerRepeats }
        : {}),
    };
    return { ok: true, participants: deduped, config: roomConfig };
  }
  // open-floor is unmoderated: every speaker nominates the next and the room closes
  // by an end-vote. Same routing-knob floors as group-chat, plus the end-vote
  // threshold (a (0,1) fraction; the close gate is a strict `>` against it).
  if (strategy === "open-floor") {
    const errors: string[] = [...managerConfigErrors];
    // open-floor has no routing Mind: speakers nominate each other and vote to
    // close. Reject a moderator/synthesizer rather than silently dropping it, so an
    // operator who reused a group-chat payload sees why the field had no effect.
    if (config.moderator) {
      errors.push("open-floor has no moderator — every speaker nominates the next");
    }
    if (config.synthesizer) {
      errors.push("open-floor has no closing synthesizer — drop `synthesizer`");
    }
    errors.push(...routingKnobErrors(config));
    if (
      config.endVoteThreshold !== undefined &&
      (!Number.isFinite(config.endVoteThreshold) ||
        config.endVoteThreshold <= 0 ||
        config.endVoteThreshold >= 1)
    ) {
      errors.push("endVoteThreshold must be a number in (0,1)");
    }
    if (errors.length > 0) return validationFailure(errors);
    const roomConfig: RoomConfig = {
      ...(typeof config.minRounds === "number" ? { minRounds: config.minRounds } : {}),
      ...(typeof config.maxSpeakerRepeats === "number"
        ? { maxSpeakerRepeats: config.maxSpeakerRepeats }
        : {}),
      endVoteThreshold: config.endVoteThreshold ?? DEFAULT_END_VOTE_THRESHOLD,
    };
    return { ok: true, participants: deduped, config: roomConfig };
  }
  // review is a two-Mind, single-pass cross-vendor critique: participants[0]
  // authors the artifact, participants[1] reviews it. Roles are positional, so it
  // needs no routing Mind and no config — but it DOES require the two Minds to run
  // on different providers (the whole point), so a same-vendor or unpinned pair is
  // rejected here rather than running a pointless same-model review.
  if (strategy === "review") {
    const errors: string[] = [...managerConfigErrors];
    if (deduped.length !== 2) {
      errors.push("review needs exactly 2 participants: the author, then the reviewer");
    }
    if (turnBudget < 2) {
      errors.push("review needs a turnBudget of at least 2 (one author turn, one review turn)");
    }
    if (config.moderator) {
      errors.push(
        "review has no moderator — the reviewer critiques the author's artifact directly",
      );
    }
    if (config.synthesizer) {
      errors.push("review has no synthesizer — the reviewer's turn is the close");
    }
    if (errors.length > 0) return validationFailure(errors);
    const authorSlug = deduped[0];
    const reviewerSlug = deduped[1];
    if (authorSlug === undefined || reviewerSlug === undefined) {
      return {
        ok: false,
        error: "review needs exactly 2 participants: the author, then the reviewer",
      };
    }
    const bySlug = new Map(minds.map((m) => [m.slug, m]));
    const authorProvider = bySlug.get(authorSlug)?.provider;
    const reviewerProvider = bySlug.get(reviewerSlug)?.provider;
    if (!authorProvider || !reviewerProvider) {
      return {
        ok: false,
        error:
          "review must be cross-vendor: pin a provider on both the author and the reviewer Mind, set to different providers",
      };
    }
    if (authorProvider === reviewerProvider) {
      return {
        ok: false,
        error: `review must be cross-vendor: ${authorSlug} and ${reviewerSlug} both use "${authorProvider}" — pin them to different providers`,
      };
    }
    // A coding review is only a real code→review loop if the author can edit and
    // the reviewer can read the change; otherwise it's a same-as-non-coding prose
    // pass with a confined cwd nobody uses. Reject the under-equipped pair here, on
    // the dry-run path, so the operator fixes the Minds before confirming.
    const author = bySlug.get(authorSlug);
    const reviewer = bySlug.get(reviewerSlug);
    if (coding && author && reviewer) {
      const capError = codingReviewCapabilityError(author, reviewer);
      if (capError) return { ok: false, error: capError };
    }
    return { ok: true, participants: deduped };
  }
  // magentic is manager-led: a non-participant manager Mind plans a task ledger and
  // delegates to the participant workers (parallel to group-chat's moderator). It
  // needs a manager Mind that is real and NOT among the ≥2 workers, and — like the
  // other facilitated modes — rejects a stray moderator/synthesizer rather than
  // silently dropping it, so a reused payload's dead field is explained.
  if (strategy === "magentic") {
    const errors: string[] = [];
    const manager = config.manager;
    if (!manager) {
      errors.push("magentic needs a manager Mind — set `manager`");
    } else {
      if (!isValidParticipant(manager)) {
        errors.push("manager must be a safe Mind slug (not director/system)");
      }
      if (!known.has(manager)) {
        errors.push(`unknown manager Mind: ${manager} — genesis it first or check the roster`);
      }
      if (deduped.includes(manager)) {
        errors.push(
          "the manager must not also be a worker — it plans and delegates, it does not execute tasks",
        );
      }
    }
    if (config.moderator) {
      errors.push("magentic has no moderator — the manager routes the work");
    }
    if (config.synthesizer) {
      errors.push("magentic has no synthesizer — the manager closes the plan");
    }
    if (errors.length > 0) return validationFailure(errors);
    return { ok: true, participants: deduped, config: { manager } };
  }
  if (managerConfigErrors.length > 0) return validationFailure(managerConfigErrors);
  return { ok: true, participants: deduped };
}

// Open a fresh-slug room and kick its auto-advance loop. The shared core behind
// both the board's room-start action and the chamber_room_start chat tool, so
// validation, the concurrency cap, and the fresh-slug discipline live in one
// place. Each start opens a brand-new room under a unique slug: the CLI
// MVP can't cancel an in-flight turn, so a turn still draining from a stopped
// room must land in its own old dir, never a reused one. Past closed rooms remain
// as bounded history under rooms/ via the retention sweep.
async function startRoom(
  input: {
    participants: readonly string[];
    turnBudget: number;
    name?: string;
    strategy?: string;
    topic?: string;
    grounding?: Brief;
    projectId?: string;
    coding?: boolean;
  } & RoomConfigInput,
): Promise<RibActionResult> {
  // Refuse once disposed: driver.start() doesn't check, so without this a start
  // after dispose() would write an "active" room whose loop never runs (ensureLoop
  // bails on isDisposed) — a phantom room nothing ever clears.
  if (!driver || driver.isDisposed()) return ROOM_DISABLED;
  const strategy = ((input.strategy ?? "").trim() || "sequential") as RoomStrategyName;
  const valid = await validateStart(
    input.participants,
    input.turnBudget,
    strategy,
    {
      moderator: input.moderator,
      minRounds: input.minRounds,
      synthesizer: input.synthesizer,
      maxSpeakerRepeats: input.maxSpeakerRepeats,
      endVoteThreshold: input.endVoteThreshold,
      manager: input.manager,
    },
    input.projectId,
    input.coding,
  );
  if (!valid.ok) return { ok: false, error: valid.error };
  const name = (input.name ?? "").trim() || deriveRoomName(input.topic, input.participants);
  // Normalize here so both entry points (the chat tool and the board action)
  // store a trimmed topic or none — a whitespace-only topic becomes no topic.
  const topic = (input.topic ?? "").trim();
  const slug = freshRoomSlug();
  // Concurrency cap + reservation in one synchronous tick (no await between the size
  // check and the add): two concurrent starts can neither overshoot MAX_ACTIVE_ROOMS
  // nor have a racing reconcileRoomPanels (a finishing room's loop) drop this room's
  // panel mid-driver.start — the slug is in activeRooms before that await, so it is
  // always in the keep-set. Both entry points (chat tool, board action) route here.
  if (activeRooms.size >= MAX_ACTIVE_ROOMS) {
    return {
      ok: false,
      error: `${MAX_ACTIVE_ROOMS} Chamber rooms are already active (the concurrent cap) — stop one before starting another.`,
    };
  }
  activeRooms.add(slug);
  const activeDriver = driver;
  try {
    await activeDriver.start({
      slug,
      name,
      strategy,
      participants: valid.participants,
      turnBudget: input.turnBudget,
      ...(topic ? { topic } : {}),
      ...(input.grounding ? { grounding: input.grounding } : {}),
      ...(valid.config ? { config: valid.config } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.coding ? { coding: input.coding } : {}),
    });
    lastSlug = slug;
    // driver.start published this room's first board (registering its per-slug
    // region); reconcile so the surface keeps every active room plus the most-recent.
    reconcileRoomPanels();
    ensureLoop(slug);
    // The sessions index is a separate snapshot from the room's own panel — refresh
    // it so the new active session appears promptly instead of on the next cadence
    // (mirrors the end-of-room refresh). Fail-soft, never thrown.
    void refreshWorkflow?.("chamber-rooms")?.catch(() => {});
    void refreshStandingPanels();
    return { ok: true, data: { slug } };
  } catch (e) {
    // The reserved slot never opened — release it and drop any partial panel.
    activeRooms.delete(slug);
    reconcileRoomPanels();
    return { ok: false, error: errText(e) };
  }
}

// Inject director overrides into a room: a direction for the next speaker, a
// nominated next speaker, and/or a director message. Shared by the board's
// room-inject action and the chamber_room_say chat tool.
async function injectRoom(
  slug: string,
  input: { directionInjection?: string; nextSpeaker?: string; text?: string },
): Promise<RibActionResult> {
  if (!driver) return ROOM_DISABLED;
  if (!isSafeSlug(slug)) return { ok: false, error: `unsafe room slug: ${JSON.stringify(slug)}` };
  try {
    const applied = await driver.inject(slug, {
      ...(input.directionInjection ? { directionInjection: input.directionInjection } : {}),
      ...(input.nextSpeaker ? { nextSpeaker: input.nextSpeaker } : {}),
      ...(input.text ? { text: input.text } : {}),
    });
    // driver.inject silently no-ops on a room that is no longer active; surface
    // that as a failure so a chat tool can't claim a dropped steer landed.
    if (!applied) return { ok: false, error: "the room is no longer active" };
    return { ok: true, data: { slug } };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

// Stop a room and drop it as the active target. Shared by the board's room-stop
// action and the chamber_room_stop chat tool.
async function stopRoom(slug: string): Promise<RibActionResult> {
  if (!driver) return ROOM_DISABLED;
  if (!isSafeSlug(slug)) return { ok: false, error: `unsafe room slug: ${JSON.stringify(slug)}` };
  try {
    await driver.stop(slug);
    activeRooms.delete(slug);
    reconcileRoomPanels();
    // The room is now a closed session — refresh the index so it appears as a card
    // (fail-soft; cadence covers an older harness without the seam).
    await refreshWorkflow?.("chamber-rooms")?.catch(() => {});
    await refreshStandingPanels();
    return { ok: true, data: { slug } };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

function roomStartAction(action: RibAction): Promise<RibActionResult> {
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  // Routing config arrives as flat payload keys — a board action's collected
  // `fields` (base #120) merge in flat, so `moderator`/`endVoteThreshold` etc. are
  // plain keys, not nested. roomConfigFromFlat owns that flat-key contract, and the
  // grounding brief follows the same flat shape (`groundingUrl` + one-per-line `criteria`).
  const grounding = normalizeGrounding({
    sourceUrl: asNonEmptyString(payload.groundingUrl),
    criteria: parseCriteriaLines(asNonEmptyString(payload.criteria)),
  });
  return startRoom({
    participants: asStringArray(payload.participants),
    turnBudget: typeof payload.turnBudget === "number" ? payload.turnBudget : 0,
    name: asNonEmptyString(payload.name) || undefined,
    strategy: asNonEmptyString(payload.strategy) || undefined,
    topic: asNonEmptyString(payload.topic) || undefined,
    ...(grounding ? { grounding } : {}),
    projectId: asNonEmptyString(payload.projectId) || undefined,
    coding: payload.coding === true,
    ...roomConfigFromFlat(payload),
  });
}

// Toggle one Mind's membership in the Convene draft (the deselected-slug set). The
// slug must name a real, current Mind (validated against the live roster, not just
// shape) so a stale/forged chip can't write an unknown slug into the draft. On success
// recompose the Convene board so the chips re-render with the new glyph and the shape
// gating re-evaluates against the new cast. Returns the new exclusion list.
async function draftSetAction(action: RibAction): Promise<RibActionResult> {
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  const slug = asNonEmptyString(payload.slug);
  if (!slug || !isValidParticipant(slug)) {
    return { ok: false, error: "draft-set requires payload { slug } naming a current Mind" };
  }
  try {
    const minds = await readMinds(mindsDir());
    if (!minds.some((m) => m.slug === slug)) {
      return { ok: false, error: `unknown Mind: ${slug}` };
    }
    const excluded = await toggleDraftExclusion(slug);
    refreshConvene();
    return { ok: true, data: { excluded: [...excluded] } };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

// Convene a room from the current draft and the chosen shape: participants are the
// selected Minds (all current Minds minus the draft's excluded set) minus the named
// facilitator — a Debate chair / Delegate manager is one of the selected Minds, pulled
// out of the cast so it routes/plans rather than speaks/works. The room shape (a
// `strategy` in the
// action payload) and its per-shape fields (topic, project, moderator, manager, turns)
// come from the shape action the operator clicked. Reuses the room start path
// (startRoom → validateStart → driver), so the <2-participant / facilitator-rules /
// cross-vendor / seam-absent guards aren't duplicated here — a shape the draft can't
// satisfy (a Review that isn't a cross-vendor pair, a Debate whose moderator is also a
// participant) surfaces validateStart's error. On success clear the draft (back to
// all-selected) and recompose the Convene board so the chips reset and it folds to its
// bar (a room now exists). An empty draft with the Discussion shape yields every Mind
// in a sequential room — the historical Start.
async function conveneAction(action: RibAction): Promise<RibActionResult> {
  if (!driver || driver.isDisposed()) return ROOM_DISABLED;
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  let allMinds: Mind[];
  let draftedMinds: Mind[];
  try {
    const excluded = await readDraftExclusion();
    allMinds = await readMinds(mindsDir());
    draftedMinds = allMinds.filter((m) => !excluded.has(m.slug));
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
  const strategy = asNonEmptyString(payload.strategy) || "sequential";
  const topic = asNonEmptyString(payload.topic) || undefined;
  // Grounding is a source URL plus one criterion per line of the criteria field; an
  // empty/whitespace pair normalizes to no grounding (the convene default is ungrounded).
  const grounding = normalizeGrounding({
    sourceUrl: asNonEmptyString(payload.groundingUrl),
    criteria: parseCriteriaLines(asNonEmptyString(payload.criteria)),
  });

  const projectInput = asNonEmptyString(payload.project);
  let projectId: string | undefined;
  if (projectInput) {
    const resolved = resolveProjectInput(projectInput);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    projectId = resolved.project.id;
  }

  // Moderator (Debate) and manager (Build) are Mind name-or-slug free text; resolve
  // each to a slug so validateStart's facilitator rules apply. An unresolvable
  // non-empty value is surfaced, not silently dropped.
  const resolveFacilitator = (
    input: string | undefined,
    role: string,
  ): { slug?: string } | { error: string } => {
    if (!input) return {};
    const slug = resolveMindByNameOrId(allMinds, input);
    return slug ? { slug } : { error: `unknown ${role} "${input}" — name a Mind from the roster` };
  };
  const mod = resolveFacilitator(asNonEmptyString(payload.moderator), "moderator");
  if ("error" in mod) return { ok: false, error: mod.error };
  const mgr = resolveFacilitator(asNonEmptyString(payload.manager), "manager");
  if ("error" in mgr) return { ok: false, error: mgr.error };

  // The facilitator (Debate chair / Delegate manager) is one of the selected Minds;
  // pull it out of the participant set so validateStart's "the facilitator must not
  // also be a participant" rule holds — it routes/plans, it does not speak/work.
  const facilitator = mod.slug ?? mgr.slug;
  const roomMinds = facilitator ? draftedMinds.filter((m) => m.slug !== facilitator) : draftedMinds;
  const participants = roomMinds.map((m) => m.slug);
  const displayNames = roomMinds.map((m) => m.name);

  // Turns: free text -> a positive integer, else the default; validateStart caps it.
  const turnsRaw = asNonEmptyString(payload.turns);
  const parsedTurns = turnsRaw ? Number.parseInt(turnsRaw, 10) : Number.NaN;
  const turnBudget =
    Number.isInteger(parsedTurns) && parsedTurns > 0 ? parsedTurns : DEFAULT_ROOM_TURN_BUDGET;

  const res = await startRoom({
    name: deriveRoomName(topic, displayNames),
    strategy,
    participants,
    turnBudget,
    topic,
    ...(grounding ? { grounding } : {}),
    ...(projectId ? { projectId } : {}),
    ...(mod.slug ? { moderator: mod.slug } : {}),
    ...(mgr.slug ? { manager: mgr.slug } : {}),
  });
  if (res.ok) {
    await clearDraft().catch(() => {});
    refreshConvene();
  }
  return res;
}

async function roomInjectAction(action: RibAction): Promise<RibActionResult> {
  const resolved = requireRoomSlug(action);
  if ("error" in resolved) return resolved.error;
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  return injectRoom(resolved.slug, {
    directionInjection: asNonEmptyString(payload.directionInjection) || undefined,
    nextSpeaker: asNonEmptyString(payload.nextSpeaker) || undefined,
    text: asNonEmptyString(payload.text) || undefined,
  });
}

async function roomStopAction(action: RibAction): Promise<RibActionResult> {
  const resolved = requireRoomSlug(action);
  if ("error" in resolved) return resolved.error;
  return stopRoom(resolved.slug);
}

// Delete a closed room: remove its rooms/<slug>/ dir, then refresh the sessions
// index so the card drops (the mutate-then-refresh pattern). Fail-closed on a
// missing/unsafe slug (requireRoomSlug) before any FS touch. The in-memory
// activeRooms check is a fast-path with a clear message; deleteRoom is the
// authoritative guard — it re-reads the on-disk room.json status and refuses a
// LIVE room (whose dir the driver rewrites each turn), so a stale in-memory set
// (a restart or a second process) can't race a delete into a live room. deleteRoom
// throws on an already-gone room (surfaced here, not as success); the try/catch
// fails soft like retireAction.
async function roomDeleteAction(action: RibAction): Promise<RibActionResult> {
  const resolved = requireRoomSlug(action);
  if ("error" in resolved) return resolved.error;
  const slug = resolved.slug;
  if (activeRooms.has(slug)) {
    return { ok: false, error: "stop the room before deleting it" };
  }
  try {
    await createFileRoomStore(roomsDir()).deleteRoom(slug);
    // Drop any lingering panel/most-recent pin for the deleted room, then refresh
    // the index card away (fail-soft — the seam resolves on error / is absent on an
    // older harness, where the 120s cadence drops the card).
    if (lastSlug === slug) lastSlug = undefined;
    reconcileRoomPanels();
    await refreshWorkflow?.("chamber-rooms")?.catch(() => {});
    await refreshStandingPanels();
    return { ok: true, data: { slug } };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

// Unregister every per-slug room-view snapshot key so dispose() (and a rebind onto a
// new manager) releases them rather than leaking registrations across boots/tests.
function releaseRoomViews(): void {
  for (const entry of roomViewEntries.values()) entry.unregister();
  roomViewEntries.clear();
}

// Return the per-slug room-view publisher for the active manager, registering its key
// lazily on first open via the same coalescing publisher the lens/room registries use.
// A re-bootstrap onto a different manager releases the stale keys first so we don't leak
// them or publish through a dead manager. The get-miss → register → set is synchronous,
// so a second open of the same slug finds the entry rather than tripping sm.register's
// duplicate-key guard.
function ensureRoomViewPublisher(
  sm: SnapshotManager,
  slug: string,
): { publish(view: CanvasView): Promise<void> } {
  if (roomViewSm !== sm) {
    releaseRoomViews();
    roomViewSm = sm;
  }
  const existing = roomViewEntries.get(slug);
  if (existing) return existing.publisher;
  const key = roomViewKey(slug);
  const { publisher, latest } = createCoalescingPublisher(() => sm.recompose(key));
  const unregister = sm.register(key, latest, { validate: expectView(key, "board") });
  roomViewEntries.set(slug, { publisher, unregister });
  return publisher;
}

// Open a closed room from the sessions index: rebuild its board from the persisted
// transcript, publish it to the room's own room-view key, and return the host
// open-canvas effect. The board carries the room's Start-again / group-chat / open-floor
// controls, so a past session can be relaunched from the drawer. Fails closed on a
// missing/unsafe slug, an unknown room, or an absent room seam.
async function roomOpenAction(action: RibAction): Promise<RibActionResult> {
  const resolved = requireRoomSlug(action);
  if ("error" in resolved) return resolved.error;
  const sm = roomSm;
  if (!sm) return ROOM_DISABLED;
  try {
    const store = createFileRoomStore(roomsDir());
    const room = await store.loadRoom(resolved.slug);
    if (!room) return { ok: false, error: `room '${resolved.slug}' not found` };
    const transcript = await store.loadTranscript(resolved.slug);
    // A magentic room's plan lives in its ledger; load it so a reopened closed room
    // renders the Plan section, not just the transcript (the live board does the same).
    const ledger = room.strategy === "magentic" ? await store.loadLedger(resolved.slug) : undefined;
    const minds = await resolveMinds();
    const projectName = room.projectId ? resolveProjectName(room.projectId) : undefined;
    const board = buildRoomBoard(room, transcript, ledger, minds, projectName ?? room.projectId);
    await ensureRoomViewPublisher(sm, resolved.slug).publish(board);
    return {
      ok: true,
      data: { effect: "open-canvas", key: roomViewKey(resolved.slug), title: room.name },
    };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

// Load a room's synthesized outcome document (the last agent turn, split at its
// own `---`/`##` boundary — see room-text.ts). An error names why there isn't
// one yet (no such room, or a room that hasn't produced a document) rather than
// silently degrading, since both outcome actions are refused without one.
async function loadRoomOutcome(
  slug: string,
): Promise<{ room: Room; outcome: OutcomeSplit } | { error: string }> {
  const store = createFileRoomStore(roomsDir());
  const room = await store.loadRoom(slug);
  if (!room) return { error: `room '${slug}' not found` };
  const transcript = await store.loadTranscript(slug);
  const last = [...transcript].reverse().find((e) => e.role === "agent");
  const text = last ? stripControlJson(last.parts.map((p) => p.text).join("\n")) : "";
  const { outcome } = splitOutcome(text);
  if (!outcome) return { error: `room '${slug}' has no synthesized outcome document yet` };
  return { room, outcome };
}

// Copy the room's outcome document as markdown. The outcome card's field sets
// this as its `copyAction` (canvas.ts): the host fetches it on click and writes
// the returned string straight to the clipboard, so the full document never
// rides the board payload — the same seam osdu's credential reveal uses.
async function outcomeCopyAction(action: RibAction): Promise<RibActionResult> {
  const resolved = requireRoomSlug(action);
  if ("error" in resolved) return resolved.error;
  try {
    const found = await loadRoomOutcome(resolved.slug);
    if ("error" in found) return { ok: false, error: found.error };
    return { ok: true, data: `## ${found.outcome.title}\n\n${found.outcome.body}` };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

// openChatSeedSchema's systemPrompt cap (@keelson/shared). OUTCOME_SEED_BUDGET
// is headroom reserved for the framing preamble so the document body is
// truncated by US in the common case; MAX_SEED_PROMPT is a hard backstop on
// the FINAL assembled string (mirrors compose.ts's stackMindPrompt, which
// every other seed-builder goes through) — a room with an unusually long
// explicit name (roomStartSchema.name carries no length cap) must not blow
// past the schema's own max and turn Explore-in-chat into a raw validation
// error.
const MAX_SEED_PROMPT = 8000;
const OUTCOME_SEED_BUDGET = 7500;

// Explore the outcome in a fresh chat — the same surface→chat handoff every ✦
// "Explore in chat" verb uses (mirrors enterMindAction): seed a new
// conversation with the document so the operator can interrogate it or draft
// the next artifact from it.
async function outcomeExploreAction(action: RibAction): Promise<RibActionResult> {
  const resolved = requireRoomSlug(action);
  if ("error" in resolved) return resolved.error;
  try {
    const found = await loadRoomOutcome(resolved.slug);
    if ("error" in found) return { ok: false, error: found.error };
    const { room, outcome } = found;
    const preamble = `The room "${room.name}" produced this outcome document. Help the operator explore it, answer questions about it, or draft the next artifact from it.\n\n## ${outcome.title}\n\n`;
    const body = outcome.body.slice(0, Math.max(0, OUTCOME_SEED_BUDGET - preamble.length));
    const systemPrompt = `${preamble}${body}`.slice(0, MAX_SEED_PROMPT);
    return {
      ok: true,
      data: { effect: "open-chat", seed: { systemPrompt, name: outcome.title.slice(0, 80) } },
    };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

// Both indexes that render an exhibit — its own shelf card and the producing
// room's tabled link — refreshed together (concurrently; the collectors are
// independent and each fail-soft) so neither goes stale after a mutation.
async function refreshExhibitIndexes(): Promise<void> {
  await Promise.all([
    refreshWorkflow?.("chamber-exhibits")?.catch(() => {}),
    refreshWorkflow?.("chamber-rooms")?.catch(() => {}),
  ]);
}

// The witnessed-provenance stamp: the room driver saw the table-exhibit tool fire
// in a turn it ran, so record the room as each exhibit's source — serialized on
// lensWriteInFlight with the other record writers, fail-soft per id, and
// preserving updatedAt (a provenance stamp is not a re-tabling). The stamp is
// the room's SLUG (the stable identifier room cards and open links join on);
// display sites resolve it to the room's name, falling back to the raw value.
function stampExhibitSources(rawIds: readonly string[], room: Room): void {
  const source = room.slug;
  const apply = async (): Promise<void> => {
    await lensReconcileInFlight?.catch(() => {});
    const store = createFileLensStore(lensesDir());
    let stamped = false;
    for (const rawId of rawIds) {
      const id = canonicalLensId(rawId);
      if (!id) continue;
      try {
        const record = await store.loadLens(id);
        if (!record || !isExhibit(record) || record.sourceRoom === source) continue;
        await store.saveLens({ ...record, sourceRoom: source });
        stamped = true;
      } catch (e) {
        console.error(`[rib-chamber] exhibit '${id}' source stamp failed: ${errText(e)}`);
      }
    }
    // One refresh per index for the batch — the exhibit card's "from" field and
    // the room card's "tabled" link both just appeared.
    if (stamped) await refreshExhibitIndexes();
  };
  void enqueueLensWrite(apply);
}

// One kind-checked delete backs all four delete verbs (two board actions, two
// tools): serialize behind boot re-registration (a delete must not race a
// reregister into resurrecting the record), verify the record's species, delete,
// release the live panel, then refresh that shelf's index. `crossKind` supplies
// the surface-appropriate steering message (board verbs name the sibling index,
// tools name the sibling tool).
async function deleteRecordOfKind(
  rawId: string,
  expected: LensKind,
  crossKind: (id: string) => string,
): Promise<{ ok: true; id: string; key: string } | { ok: false; error: string }> {
  const noun = expected === "exhibit" ? "exhibit" : "lens";
  const id = canonicalLensId(rawId);
  if (!id) return { ok: false, error: `unsafe ${noun} id: ${JSON.stringify(rawId)}` };
  try {
    await lensReconcileInFlight?.catch(() => {});
    const store = createFileLensStore(lensesDir());
    const record = await store.loadLens(id);
    if (record && isExhibit(record) !== (expected === "exhibit")) {
      return { ok: false, error: crossKind(id) };
    }
    if (!record && expected === "exhibit") {
      return { ok: false, error: `exhibit '${id}' not found` };
    }
    try {
      await store.deleteLens(id);
    } catch (e) {
      // The store's not-found message says "lens"; keep the verb's noun honest
      // when a concurrent delete wins the race.
      if (expected === "exhibit" && /not found/.test(errText(e))) {
        return { ok: false, error: `exhibit '${id}' not found` };
      }
      throw e;
    }
    lensRegistry?.remove(id);
    if (expected === "exhibit") {
      // A room card listing this exhibit as tabled must drop the dead link.
      await refreshExhibitIndexes();
    } else {
      await refreshWorkflow?.("chamber-lenses")?.catch(() => {});
      // The retired lens drops from the roster pulse's "Live views" count too —
      // refresh it so the count matches the just-updated index.
      await refreshWorkflow?.("chamber-roster")?.catch(() => {});
    }
    await refreshStandingPanels();
    return { ok: true, id, key: lensKey(id) };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

async function retireLensAction(action: RibAction): Promise<RibActionResult> {
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  const raw = asNonEmptyString(payload.id);
  if (!raw) return { ok: false, error: "retire-lens requires payload { id }" };
  const res = await deleteRecordOfKind(
    raw,
    "lens",
    (id) => `'${id}' is an exhibit — delete it from the Exhibits index`,
  );
  return res.ok ? { ok: true, data: { id: res.id, key: res.key } } : res;
}

async function deleteExhibitAction(action: RibAction): Promise<RibActionResult> {
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  const raw = asNonEmptyString(payload.id);
  if (!raw) return { ok: false, error: "delete-exhibit requires payload { id }" };
  const res = await deleteRecordOfKind(
    raw,
    "exhibit",
    (id) => `'${id}' is a lens — retire it from the Lenses index`,
  );
  return res.ok ? { ok: true, data: { id: res.id, key: res.key } } : res;
}

// Extract and canonicalize the { id } payload every lens verb carries, so the
// guard prologue (and its error wording) lives once rather than per handler.
function lensActionId(action: RibAction, verb: string): { id: string } | { error: string } {
  const raw = asNonEmptyString(((action.payload ?? {}) as Record<string, unknown>).id);
  if (!raw) return { error: `${verb} requires payload { id }` };
  const id = canonicalLensId(raw);
  if (!id) return { error: `unsafe lens id: ${JSON.stringify(raw)}` };
  return { id };
}

// Retire an HTML lens: the head ⋯ verb on its panel — the only delete path an
// HTML lens has (its sandboxed iframe can't reach destructive actions and it
// carries no index card). Deletes the persisted record, then releases the live
// key + region + views entry.
async function retireHtmlLensAction(action: RibAction): Promise<RibActionResult> {
  const got = lensActionId(action, "retire-lens-html");
  if ("error" in got) return { ok: false, error: got.error };
  const { id } = got;
  try {
    // Let any in-flight boot re-registration finish first (mirrors
    // deleteRecordOfKind awaiting lensReconcileInFlight): a retire landing
    // mid-reconcile must not race a reregister into resurrecting the panel.
    await htmlLensReconcileInFlight?.catch(() => {});
    try {
      await createFileHtmlLensStore(htmlLensesDir()).delete(id);
    } catch (e) {
      // The record is already gone but a panel may still be live (external
      // tamper): releasing it lets the verb converge instead of stranding a
      // ghost panel no second retire could ever remove.
      if (/not found/.test(errText(e)) && htmlLensRegistry?.remove(id)) {
        await refreshStandingPanels();
        return { ok: true, data: { id, key: htmlLensKey(id) } };
      }
      throw e;
    }
    htmlLensRegistry?.remove(id);
    await refreshStandingPanels();
    return { ok: true, data: { id, key: htmlLensKey(id) } };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

// Re-compose a living lens on demand: the Refresh verb on a refresh-backed
// lens's index card. Fires the record's named workflow with input `lens` = the
// id — the same run the panel's cadence fires — and returns as soon as the run
// is started; the re-emit republishes the panel and its index card.
async function refreshLensAction(action: RibAction): Promise<RibActionResult> {
  const got = lensActionId(action, "refresh-lens");
  if ("error" in got) return { ok: false, error: got.error };
  const { id } = got;
  if (!hostRefreshWorkflow) {
    return { ok: false, error: "workflow refresh unavailable on this harness" };
  }
  try {
    const record = await createFileLensStore(lensesDir()).loadLens(id);
    if (!record) return { ok: false, error: `lens '${id}' not found` };
    if (isExhibit(record)) {
      return { ok: false, error: `'${id}' is an exhibit — exhibits don't refresh` };
    }
    if (!record.refresh) {
      return {
        ok: false,
        error: `lens '${id}' has no refresh backing — re-author it with chamber_emit_lens refresh: {}`,
      };
    }
    await hostRefreshWorkflow(record.refresh.workflow, lensRefreshInputs(id));
    return { ok: true, data: { id, workflow: record.refresh.workflow } };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

// Open a lens: return the host open-canvas effect focusing the lens's live board in
// the drawer. A lens is live-published the whole time it exists, so its snapshot key
// always resolves — no deferral (unlike a closed room). Non-destructive and
// side-effect-free; fails closed on a missing/unsafe id (canonicalLensId rejects
// garbage) so a stale/garbled payload can't open a bad key.
function lensOpenAction(action: RibAction): RibActionResult {
  const got = lensActionId(action, "lens-open");
  if ("error" in got) return { ok: false, error: got.error };
  return { ok: true, data: { effect: "open-canvas", key: lensKey(got.id), title: got.id } };
}

function lensHtmlAction(action: RibAction): RibActionResult {
  const payload = action.payload;
  if (
    typeof payload !== "undefined" &&
    (typeof payload !== "object" || payload === null || Array.isArray(payload))
  ) {
    return { ok: false, error: "lens-html requires an object payload" };
  }
  return { ok: true, data: { key: HTML_LENS_KEY } };
}

// The rows section a lens write-back appends annotation notes to. The verb owns
// this section title so repeated notes accumulate in one place regardless of how
// the maintaining Mind laid out the rest of the board.
const LENS_NOTES_SECTION_TITLE = "Notes";
const LENS_NOTE_MAX = 500;

// Append a note as a row to a lens board's "Notes" section, creating that section
// if the board has none. Pure (no I/O): the caller persists + republishes the
// returned board. New rows go to the end so the section reads oldest-first.
function appendLensNote(board: CanvasBoardView, note: string): CanvasBoardView {
  const row = { text: note };
  let appended = false;
  const sections: CanvasBoardView["sections"] = board.sections.map((s) => {
    if (!appended && s.kind === "rows" && s.title === LENS_NOTES_SECTION_TITLE) {
      appended = true;
      return { ...s, items: [...s.items, row] };
    }
    return s;
  });
  if (!appended) {
    sections.push({ kind: "rows", title: LENS_NOTES_SECTION_TITLE, items: [row] });
  }
  return { ...board, sections };
}

// Lens write-back: append an operator-supplied note from the lens's own panel (a
// board `actions` section dispatches `{ id, note }` here). A deterministic edit,
// NOT a re-prompt of the maintaining Mind, so it costs nothing. The brief gate is
// deliberately NOT fired — a free in-view annotation must not promote a paid
// briefing turn (that path is reserved for Mind-authored substance).
async function lensNoteAction(action: RibAction): Promise<RibActionResult> {
  const got = lensActionId(action, "lens-note");
  if ("error" in got) return { ok: false, error: got.error };
  const { id } = got;
  const note = asNonEmptyString(((action.payload ?? {}) as Record<string, unknown>).note);
  if (!note) return { ok: false, error: "lens-note requires a non-empty note" };
  // Count code points, not UTF-16 code units, so the cap matches the "characters"
  // the message promises (an emoji is one character but two code units).
  if ([...note].length > LENS_NOTE_MAX) {
    return { ok: false, error: `note too long (max ${LENS_NOTE_MAX} characters)` };
  }
  // The write-back republishes through the registry to update the live panel, so the
  // region seam must be wired (it always is when a lens exists — fail closed if not).
  if (!lensRegistry)
    return { ok: false, error: "lens write-back unavailable (region seam absent)" };
  const registry = lensRegistry;
  // Serialize the load-append-publish: it is a read-modify-write, so two concurrent
  // appends to the same board would lose-update (the store's atomic rename guards a
  // torn file, not a stale read). Note appends are rare operator actions, so one
  // global chain — not a per-id lock — suffices.
  const apply = async (): Promise<RibActionResult> => {
    try {
      // Let any in-flight boot re-registration finish first, so the write can't race a
      // reregister republishing the pre-edit board over the live key.
      await lensReconcileInFlight?.catch(() => {});
      const record = await createFileLensStore(lensesDir()).loadLens(id);
      if (!record) return { ok: false, error: `lens '${id}' not found` };
      // Round-trip the provenance, the kind, and the refresh backing (lensProvenance
      // picks every provenance field), so an annotated exhibit can't come back as a
      // lens with no source room and an annotated living lens keeps its wiring.
      const { key } = await registry.publish(
        id,
        appendLensNote(record.board, note),
        lensProvenance(record),
        isExhibit(record) ? "exhibit" : "lens",
        record.refresh,
      );
      // The record's updatedAt advanced — refresh its own index card (and, for a
      // lens, the roster pulse; exhibits don't ride the "Live views" count), cheap
      // deterministic collectors, fail-soft like the emit/retire paths.
      if (isExhibit(record)) {
        await refreshWorkflow?.("chamber-exhibits")?.catch(() => {});
      } else {
        await refreshWorkflow?.("chamber-lenses")?.catch(() => {});
        await refreshWorkflow?.("chamber-roster")?.catch(() => {});
      }
      await refreshStandingPanels();
      return { ok: true, data: { id, key } };
    } catch (e) {
      return { ok: false, error: errText(e) };
    }
  };
  return enqueueLensWrite(apply);
}

// Resolve the target room slug for a control. With server-assigned slugs there
// is no default: a payload-less call (a stale/static button or an API client
// that forgot the slug) must fail closed rather than hit a legacy `room` dir.
function requireRoomSlug(action: RibAction): { slug: string } | { error: RibActionResult } {
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  const slug = asNonEmptyString(payload.slug);
  if (!slug) return { error: { ok: false, error: "this room control requires payload { slug }" } };
  if (!isSafeSlug(slug)) {
    return { error: { ok: false, error: `unsafe room slug: ${JSON.stringify(slug)}` } };
  }
  return { slug };
}

// A unique, path-safe room slug per start (timestamp + counter), so every room
// gets its own rooms/<slug>/ dir and a late turn from a prior room can't bleed
// into a new one. Matches SAFE_SLUG (lowercase alnum + hyphens).
function freshRoomSlug(): string {
  return `room-${Date.now().toString(36)}-${(roomSeq++).toString(36)}`;
}

// A room participant must be a safe slug and not a reserved authority: "director"
// and "system" are driver-stamped roles, never speakers (a room with one would
// just end on its turn — an unknown mind).
function isValidParticipant(slug: string): boolean {
  return slug !== "director" && slug !== "system" && isSafeSlug(slug);
}

// True if the slug is a bare kebab token (no traversal, non-empty). assertSafeSlug
// throws on a bad slug; this is its non-throwing predicate form.
function isSafeSlug(slug: string): boolean {
  try {
    assertSafeSlug(slug);
    return true;
  } catch {
    return false;
  }
}

// Open a mind as a seeded chat: compose its soul into a system prompt and hand
// the harness an "open-chat" directive (the generic seam the SPA interprets to
// start a fresh seeded conversation). Read-only against minds/ — resolving via
// resolveMinds() returns the unknown-mind error on a retire-then-enter race.
async function enterMindAction(action: RibAction): Promise<RibActionResult> {
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  const slug = asNonEmptyString(payload.slug);
  if (!slug) return { ok: false, error: "enter-mind requires payload { slug }" };
  try {
    const mind = (await resolveMinds()).find((m) => m.slug === slug);
    if (!mind) return { ok: false, error: `unknown Mind: ${slug}` };
    const seed = await buildSeedFor(mindsDir(), mind);
    return { ok: true, data: { effect: "open-chat", seed } };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

// The cold-start "Author a Mind" board actions launch the chamber-genesis workflow
// (the canonical genesis path: one prompt turn authors the SOUL.md + tagline and
// persists via chamber_emit_genesis), rather than opening a freeform author chat.
// Routing through the workflow lets an archetype pin its short role/name/voice as
// $inputs, so the roster card carries a crisp role pill instead of a model-
// improvised sentence.

// Author one of the starter archetypes: launch chamber-genesis with the starter's
// brief as $ARGUMENTS and its name/role/voice pinned as explicit inputs.
async function authorArchetypeAction(action: RibAction): Promise<RibActionResult> {
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  const slug = asNonEmptyString(payload.slug);
  const starter = GENESIS_STARTERS.find((s) => s.slug === slug);
  if (!starter) return { ok: false, error: `unknown archetype: ${slug || "(none)"}` };
  // A starter's name/role are known now (pinned as inputs), so the boot card can show
  // them; stay on the surface (stay: true) so the operator watches the seat fill.
  await beginGenesis({ name: starter.name, role: starter.role });
  return {
    ok: true,
    data: {
      effect: "run-workflow",
      workflow: "chamber-genesis",
      stay: true,
      args: {
        ARGUMENTS: starter.voiceDescription,
        name: starter.name,
        role: starter.role,
        voice: starter.voice,
      },
    },
  };
}

async function authorLensAction(action: RibAction): Promise<RibActionResult> {
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  const subject = asNonEmptyString(payload.subject);
  if (!subject) return { ok: false, error: "author-lens requires payload { subject }" };
  return {
    ok: true,
    // ribClientEffectSchema wants args as a string map (the slash-command path
    // takes a bare string — different schema); ARGUMENTS is the $ARGUMENTS binding.
    data: {
      effect: "run-workflow",
      workflow: "chamber-lens",
      stay: true,
      args: { ARGUMENTS: subject },
    },
  };
}

// The operator-typed brief is the only unbounded, user-controlled input here;
// clamp it before it rides into a billed genesis run.
const MAX_BRIEF_CHARS = 2000;

// Author from a freeform brief: launch chamber-genesis with the brief as $ARGUMENTS
// (the same path /genesis takes). The workflow authors the name, a short role
// title, and the voice from the brief.
async function describeOwnAction(action: RibAction): Promise<RibActionResult> {
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  const brief = asNonEmptyString(payload.brief);
  if (!brief) return { ok: false, error: "Describe the Mind first — who should it feel like?" };
  // A freeform brief has no name/role yet (the workflow authors them), so the boot card
  // holds "calibrating…"; stay on the surface so the operator watches the seat fill.
  await beginGenesis({});
  return {
    ok: true,
    data: {
      effect: "run-workflow",
      workflow: "chamber-genesis",
      stay: true,
      args: { ARGUMENTS: brief.slice(0, MAX_BRIEF_CHARS) },
    },
  };
}

// Dismiss a stalled (or unwanted) genesis boot card: settle the one marker the card's
// payload names (its startedAt stamp), falling back to clearing them all for a legacy
// dispatch without one; stop the tick when nothing is left in flight; refresh the
// roster so the seat frees back to the launchpad. Deterministic and free — not paid.
async function dismissGenesisAction(action?: RibAction): Promise<RibActionResult> {
  const payload = (action?.payload ?? {}) as Record<string, unknown>;
  const startedAt = asNonEmptyString(payload.startedAt);
  // Stop the tick only after a real removal reports nothing left. A failed remove
  // must not be read as "none remain" — that freezes still-pending sibling cards
  // before they reach the stalled/Dismiss state.
  try {
    if (startedAt) {
      const remaining = await removePendingGenesisAt(startedAt);
      if (remaining.length === 0) stopGenesisTick();
    } else {
      await clearPendingGenesis();
      stopGenesisTick();
    }
  } catch {
    // leave the ticker running; a still-present marker keeps ticking to Dismiss
  }
  await refreshWorkflow?.("chamber-roster")?.catch(() => {});
  return { ok: true };
}

async function retireAction(action: RibAction): Promise<RibActionResult> {
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  const slug = asNonEmptyString(payload.slug);
  if (!slug) return { ok: false, error: "retire requires payload { slug }" };
  try {
    await retireMind(mindsDir(), slug);
    invalidateRoster(); // a Mind is gone — drop it from the cached roster
    await refreshWorkflow?.("chamber-roster")?.catch(() => {});
    await refreshStandingPanels();
    return { ok: true, data: { slug } };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

async function setModelAction(action: RibAction): Promise<RibActionResult> {
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  const slug = asNonEmptyString(payload.slug);
  if (!slug) return { ok: false, error: "set-model requires payload { slug }" };
  const model = asNonEmptyString(payload.model);
  const provider = asNonEmptyString(payload.provider);
  try {
    await setMindModel(mindsDir(), slug, { model, provider });
    invalidateRoster();
    await refreshWorkflow?.("chamber-roster");
    return { ok: true, data: { slug, ...(model ? { model } : {}) } };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

// Tool results stream to chat as `tool_result` chunks; keep each well under the
// chat context budget. Truncation is signalled, never silent.
const MAX_TOOL_RESULT_CHARS = 16_000;
function boundedText(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  const omitted = text.length - MAX_TOOL_RESULT_CHARS;
  return `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n…(truncated — ${omitted} more chars)`;
}
function emitResult(ctx: ToolContext, content: string, isError = false): void {
  ctx.emit({ type: "tool_result", toolUseId: "", content, ...(isError ? { isError: true } : {}) });
}

// turnBudget/confirm are .optional() (not .default()) on purpose: z.toJSONSchema
// — which the Copilot provider feeds the model — lists defaulted fields as
// `required`, which would force the model to send `confirm` (defeating the
// dry-run/omit path) and `turnBudget`. Defaults are applied after parse instead.
const roomStartSchema = z.object({
  participants: z.array(z.string()).min(2),
  turnBudget: z.number().int().min(1).max(MAX_ROOM_TURN_BUDGET).optional(),
  name: z.string().optional(),
  topic: z.string().optional(),
  // Optional grounding brief distinct from the free-text topic: a source URL and the
  // acceptance criteria the room must satisfy. Injected into turn prompts; when it
  // carries criteria, a design-bearing room runs a cross-vendor fidelity check against
  // them before the closing synthesis. Omit for a room with no grounding.
  grounding: z
    .object({
      sourceUrl: z.string().max(MAX_GROUNDING_URL_LEN).optional(),
      criteria: z.array(z.string().max(MAX_CRITERION_LEN)).max(MAX_GROUNDING_CRITERIA).optional(),
    })
    .optional(),
  // Optional: target the room at a keelson project (turns run at its rootPath).
  projectId: z.string().optional(),
  // Opt into the coding tier (default off): a Mind that declares `code`/`read` can
  // run Bash/Edit/Write/Read, confined to the project root. Requires `projectId`.
  coding: z.boolean().optional(),
  // Routing config. `strategy` defaults to sequential; `moderator` is required
  // (and validated) only for "group-chat"; `manager` for "magentic"; `endVoteThreshold`
  // tunes "open-floor"'s close. All optional so a plain two-Mind room needs none of them.
  strategy: z.string().optional(),
  moderator: z.string().optional(),
  manager: z.string().optional(),
  synthesizer: z.string().optional(),
  minRounds: z.number().int().min(1).optional(),
  maxSpeakerRepeats: z.number().int().min(1).optional(),
  endVoteThreshold: z.number().optional(),
  confirm: z.boolean().optional(),
});
const roomSaySchema = z
  .object({
    // Target a specific room; omit to steer the most-recent active room.
    room: z.string().optional(),
    direction: z.string().optional(),
    callOn: z.string().optional(),
    text: z.string().optional(),
  })
  .refine((v) => Boolean(v.direction || v.callOn || v.text), {
    message: "provide at least one of: direction, callOn, text",
  });
// status/stop take an optional room slug (default: the most-recent room).
const roomTargetSchema = z.object({ room: z.string().optional() });

// Render a room + its transcript as chat-legible text. Targets an explicit slug, or
// the most-recent active room — falling back to the most-recent finished room only
// when none is active, so a bare call headlines a live room when one exists. Reads
// through the same store the driver writes, so it reflects the latest committed turn.
// When several rooms are active and no slug was named, appends a one-line index of
// the others so multiple concurrent rooms are discoverable from a bare status call.
async function renderRoomStatus(store: RoomStore, target?: string): Promise<string> {
  const explicit = (target ?? "").trim();
  const slug = explicit || mostRecentActiveSlug() || lastSlug;
  if (!slug) return "No Chamber room yet. Start one with chamber_room_start.";
  const room = await store.loadRoom(slug);
  if (!room) {
    return explicit
      ? `No Chamber room "${slug}".`
      : "No Chamber room yet. Start one with chamber_room_start.";
  }
  const transcript = await store.loadTranscript(slug);
  const head =
    `Room "${room.name}" (${slug}) — ${room.status}, turn ${room.turnIndex}/${room.turnBudget}; ` +
    `participants: ${room.participants.join(", ")}.`;
  const groundingSource = room.grounding?.sourceUrl?.trim();
  const criteria = room.grounding?.criteria.filter((c) => c.trim().length > 0) ?? [];
  const criteriaText =
    criteria.length > 0 ? `: ${criteria.map((c, i) => `${i + 1}. ${c}`).join("; ")}` : "";
  const grounding =
    groundingSource || criteria.length > 0
      ? `\nGrounding${groundingSource ? ` (${groundingSource})` : ""}${criteriaText}`
      : "";
  const body = transcript.length > 0 ? renderTranscript(transcript) : "(no turns yet)";
  let index = "";
  if (!explicit && activeRooms.size > 1) {
    const others = [...activeRooms].filter((s) => s !== slug);
    const lines = await Promise.all(
      others.map(async (s) => {
        const r = await store.loadRoom(s);
        return r
          ? `  • ${r.name} (${s}) — ${r.status}, turn ${r.turnIndex}/${r.turnBudget}`
          : `  • ${s}`;
      }),
    );
    index = `\n\n${activeRooms.size} rooms active — pass room:<slug> to read another:\n${lines.join("\n")}`;
  }
  return boundedText(`${head}${grounding}\n\n${body}${index}`);
}

// Genesis write seam: the chamber-genesis workflow's prompt node authors the soul
// + tagline and calls this tool to persist the Mind. Deterministic and in-process
// (it reuses scaffoldMind), so the generative half stays in the prompt and the
// write half stays testable.
const genesisEmitSchema = z.object({
  name: z.string().min(1),
  role: z.string().min(1),
  voice: z.string().min(1),
  soul: z.string().min(1),
  // Seat-card stanza (2-4 verb-led sentences). Lenient on purpose: blank is
  // omitted at persist and the card render truncates at 200, so an empty or
  // overlong stanza degrades rather than failing the one paid authoring turn.
  mission: z.string().max(500).optional(),
  tagline: z.string().min(1),
  model: z.string().optional(),
  provider: z.string().optional(),
  // Capability slugs the Mind may invoke in a room (see CAPABILITIES).
  // Unknown slugs are dropped at persist; omitted/empty keeps the Mind text-only.
  tools: z.array(z.string()).optional(),
});

function makeGenesisTool(refreshWorkflow?: RibContext["refreshWorkflow"]): ToolDefinition {
  return {
    name: "chamber_emit_genesis",
    description:
      "Internal write-seam for the chamber-genesis workflow: persist an authored Mind (SOUL.md + record) under minds/<slug>. The workflow's prompt turn authors { soul, mission, tagline, optional model/provider pin, optional capability tools }; this tool only writes, failing closed on a slug collision. To create an agent, run the chamber-genesis workflow (e.g. /workflow run chamber-genesis <brief>) rather than calling this directly.",
    inputSchema: genesisEmitSchema,
    state_changing: true,
    async execute(input, ctx) {
      const parsed = genesisEmitSchema.safeParse(input);
      if (!parsed.success) {
        emitResult(ctx, `chamber_emit_genesis: ${parsed.error.message}`, true);
        return;
      }
      const {
        name,
        role,
        voice,
        soul,
        mission,
        tagline,
        tools,
        model: rawModel,
        provider: rawProvider,
      } = parsed.data;
      try {
        const knownTools = tools
          ? [...new Set(tools.filter((s) => KNOWN_CAPABILITY_SLUGS.has(s)))]
          : [];
        const model = rawModel?.trim();
        const provider = rawProvider?.trim();
        const slug = slugify(name);
        // A Mind takes the lowest identity slot not already worn (keelson#390),
        // preferring its starter's own hue when that slug matches a starter and the
        // hue is free — so the cold-start card previews what actually gets seated,
        // and a churned roster never double-seats a hue (next-free, not count-based).
        // Slot pick + scaffold run behind genesisScaffoldInFlight so two parallel
        // landings can't read the same free slot and persist a duplicate hue.
        const buildAndScaffold = async (): Promise<MindRecord> => {
          const preferred = GENESIS_STARTERS.find((s) => s.slug === slug)?.seat;
          const slot = nextFreeSlot(await resolveMinds(), preferred);
          const built: MindRecord = {
            slug,
            name,
            role,
            voice,
            // The roster card truncates for display (with an ellipsis); store the
            // authored tagline trimmed, not hard-cut.
            persona: tagline.trim(),
            ...(mission?.trim() ? { mission: mission.trim() } : {}),
            createdAt: new Date().toISOString(),
            // Omit the slot past the ramp (a sixth Mind) so identityToneForSlot folds
            // it to neutral rather than persisting an out-of-range index.
            ...(slot < IDENTITY_SLOT_COUNT ? { identitySlot: slot } : {}),
            ...(model ? { model } : {}),
            ...(model && provider ? { provider } : {}),
            ...(knownTools.length > 0 ? { tools: knownTools } : {}),
          };
          await scaffoldMind(mindsDir(), built, soul);
          invalidateRoster();
          return built;
        };
        const scaffoldRun = genesisScaffoldInFlight.then(buildAndScaffold, buildAndScaffold);
        genesisScaffoldInFlight = scaffoldRun.catch(() => {});
        const record = await scaffoldRun;
        // The genesis landed — settle its own boot-card marker (siblings keep theirs)
        // so the next roster frame shows the real seat instead of the boot card.
        await settleGenesis(record.name);
        // Re-run the bound chamber-roster collector so the new Mind appears
        // promptly instead of waiting on the 120s cadence. Fail-soft (the seam
        // resolves on error and is absent on an older harness) — never throw.
        await refreshWorkflow?.("chamber-roster");
        // A new Mind is additive — route Activity through the seam (no digest turn).
        await refreshStandingPanels();
        emitResult(ctx, JSON.stringify({ ok: true, slug: record.slug, name: record.name }));
      } catch (e) {
        emitResult(ctx, `chamber_emit_genesis failed: ${errText(e)}`, true);
      }
    },
  };
}

// Lens publish seam: the chamber-lens workflow's prompt node composes a canvas
// board and calls this tool to publish it under a per-subject key. `id` routes
// re-authoring of the same subject back to the same panel; the board is validated
// fail-closed (the key's expectView guard) before it is broadcast. scope /
// maintainingMind / reason are the index card's optional PROVENANCE — the agent
// supplies what it can name (never fabricated); each is omitted when absent.
const lensEmitSchema = z.object({
  id: z.string().min(1).max(64),
  board: canvasBoardViewSchema,
  scope: z.string().min(1).max(40).optional(),
  maintainingMind: z.string().min(1).max(40).optional(),
  reason: z.string().min(1).max(120).optional(),
  // The lens's re-compose backing. Absent PRESERVES an existing lens's config —
  // a refresh turn re-emitting the board must not strip its own backing — and
  // null clears it. An object PATCHES the prior backing: an omitted field keeps
  // its prior value, `workflow` bottoming out at the bundled chamber-lens-refresh
  // re-author; the floor/ceiling keep a typo'd cadence from thrashing turns.
  refresh: z
    .object({
      workflow: z.string().min(1).max(64).optional(),
      cadenceMs: z.number().int().min(MIN_REFRESH_CADENCE_MS).max(86_400_000).optional(),
    })
    .nullable()
    .optional(),
});

function makeLensTool(store: LensStore, registry: LensRegistry): ToolDefinition {
  return {
    name: LENS_TOOL_NAME,
    description:
      'Author a lens: render a canvas `board` you compose onto the Chamber surface, where it shows live as its own panel with no hand-coded UI — a STANDING VIEW on a subject you maintain by re-authoring the same id. `id` is a short, stable kebab-case identifier for the subject (re-authoring the same id updates the same panel); `board` is the canvas board view. Optional provenance for the lenses index card — supply only what you can truthfully name, never invent: `scope` (the board\'s kind, e.g. "status board" / "timeline" / "checklist"), `maintainingMind` (YOUR own Mind name/slug, the lens\'s maintainer), `reason` (a short note on what changed in this authoring). Optional `refresh` makes it a LIVING view: `{ workflow?, cadenceMs? }` names a catalog workflow the panel re-runs on cadence with input `lens` = this id (the workflow re-composes and re-emits the lens; default workflow chamber-lens-refresh, default cadence 1h). Omitting `refresh` on a re-author keeps the existing backing; an object PATCHES it (an omitted field keeps its prior value); `refresh: null` removes it. Call it once per lens. To let a viewer annotate the lens in place, include an `actions` section whose action has `type: "lens-note"`, `payload: { id: <this lens id> }`, and one multiline field named `note` — submitting it appends the note to the lens. The chamber-lens workflow (/workflow run chamber-lens <subject>) is the standalone entry point. NOT for a deliverable a discussion produced — table that with chamber_table_exhibit.',
    inputSchema: lensEmitSchema,
    state_changing: true,
    execute(input, ctx) {
      // Serialized on lensWriteInFlight (like the exhibit tool): the refresh
      // preserve-vs-clear resolution is a read-modify-write of the record, and
      // an unserialized publish could land inside a note write-back or stamp.
      const apply = async (): Promise<void> => {
        const parsed = lensEmitSchema.safeParse(input);
        if (!parsed.success) {
          emitResult(ctx, `chamber_emit_lens: ${parsed.error.message}`, true);
          return;
        }
        // Canonicalize the id into a stable routing key (the prompt asks for kebab-case,
        // but a model may send "Release Risks"). A lens-specific normalizer, NOT the
        // Mind slugifier: no 48-char cap (which would collide distinct long subjects)
        // and no synthetic fallback — an id with no usable characters is rejected.
        const id = canonicalLensId(parsed.data.id);
        if (!id) {
          emitResult(ctx, "chamber_emit_lens: id has no usable characters", true);
          return;
        }
        const { scope, maintainingMind, reason } = parsed.data;
        try {
          await lensReconcileInFlight?.catch(() => {});
          // The two species share one id space, so the LENS verb must not overwrite
          // an exhibit (it would flip the record's kind and drop its witnessed
          // sourceRoom). Best-effort guard — the publish itself stays last-writer-wins.
          const existing = await store.loadLens(id);
          if (existing && isExhibit(existing)) {
            emitResult(
              ctx,
              `chamber_emit_lens: '${id}' is an exhibit — update it with chamber_table_exhibit or pick another id`,
              true,
            );
            return;
          }
          const refresh = resolveLensRefresh(parsed.data.refresh, existing?.refresh);
          // The harness refresh seam is fail-soft (an unknown workflow warns
          // server-side and resolves), so an emit that names a custom workflow
          // gets a caveat in its reply — the one place the author can hear it.
          const customWorkflow =
            parsed.data.refresh?.workflow && parsed.data.refresh.workflow !== LENS_REFRESH_WORKFLOW
              ? parsed.data.refresh.workflow
              : undefined;
          const { key } = await registry.publish(
            id,
            parsed.data.board,
            { scope, maintainingMind, reason },
            "lens",
            refresh,
          );
          // Re-run the bound chamber-lenses collector so a newly-authored lens appears
          // in the index promptly instead of waiting on cadence (mirrors genesis
          // refreshing the roster). Fail-soft: the seam resolves on error / is absent
          // on an older harness — never throw past a successful publish.
          await refreshWorkflow?.("chamber-lenses")?.catch(() => {});
          // A changed/new lens is briefing substance: evaluate the gate (it runs a turn
          // only if the watermark hasn't seen this fingerprint) and refresh the roster
          // so its pulse updates. Both fire-and-forget — never thrown past the publish.
          void evaluateBriefGate().catch(() => {});
          void refreshWorkflow?.("chamber-roster")?.catch(() => {});
          await refreshStandingPanels();
          emitResult(
            ctx,
            JSON.stringify({
              ok: true,
              key,
              ...(customWorkflow
                ? {
                    note: `refresh runs workflow '${customWorkflow}' — if that workflow is not in the catalog, the panel silently never re-composes`,
                  }
                : {}),
            }),
          );
        } catch (e) {
          emitResult(ctx, `chamber_emit_lens failed: ${errText(e)}`, true);
        }
      };
      return enqueueLensWrite(apply);
    },
  };
}

// Resolve an emit's refresh input against the prior record: absent preserves
// (a refresh turn re-emitting the board must not strip its own backing), null
// clears, and an object PATCHES — each omitted field keeps its prior value, so
// a cadence-only re-author can't silently swap a bespoke refresh workflow for
// the bundled default.
function resolveLensRefresh(
  input: { workflow?: string; cadenceMs?: number } | null | undefined,
  prior: LensRefresh | undefined,
): LensRefresh | undefined {
  if (input === undefined) return prior;
  if (input === null) return undefined;
  const cadenceMs = input.cadenceMs ?? prior?.cadenceMs;
  return {
    workflow: input.workflow ?? prior?.workflow ?? LENS_REFRESH_WORKFLOW,
    ...(cadenceMs !== undefined ? { cadenceMs } : {}),
  };
}

const digestEmitSchema = z.object({
  board: canvasBoardViewSchema,
});

// Standing-digest write seam: the chamber-digest workflow's author node composes a
// canvas board synthesizing the Chamber's current state and calls this tool to persist
// it. The tool validates the board fail-closed (the schema), stamps it with the current
// chamber fingerprint (so the gate reads the digest as current and runs no further turn
// until the next change), and writes it atomically. The publish node then re-reads the
// store to drive the bound key.
function makeDigestTool(): ToolDefinition {
  return {
    name: DIGEST_TOOL_NAME,
    description:
      "Internal write-seam for the chamber-digest workflow: persist the standing digest board the author turn composed. The workflow's gate-conditioned author node calls this once with { board } when the Chamber changed; this tool validates the board fail-closed, stamps it with the current chamber fingerprint, and writes it so the Briefing banner's Digest register refreshes. The chamber-digest workflow (nudged by the rib on each Chamber mutation) is the entry point — don't call this directly.",
    inputSchema: digestEmitSchema,
    state_changing: true,
    async execute(input, ctx) {
      const parsed = digestEmitSchema.safeParse(input);
      if (!parsed.success) {
        emitResult(ctx, `chamber_emit_digest: ${parsed.error.message}`, true);
        return;
      }
      try {
        // Stamp the fingerprint from a fresh read at persist time (the same reduction
        // the gate uses) so the gate goes quiet after this authoring. The read is taken
        // at turn END: a structural change landing DURING the (short) author turn is
        // captured by the fingerprint but not by this board, so it surfaces on the next
        // structural change rather than immediately — acceptable eventual consistency
        // for a standing panel, and the common no-mid-turn-change case is exact. (The
        // out-of-process gate/turn split is why we don't cheaply stamp the gate's
        // pre-turn fingerprint here, the way the in-process Briefing gate does.)
        const { minds, rooms, lenses } = await readChamberRecords();
        await writeDigest({
          board: parsed.data.board,
          fingerprint: chamberFingerprint(minds, rooms, lenses),
        });
        // The digest register reads digest.json — re-publish the banner so the new
        // synthesis lands without waiting on the next mutation.
        await publishBriefing();
        emitResult(ctx, JSON.stringify({ ok: true }));
      } catch (e) {
        emitResult(ctx, `chamber_emit_digest failed: ${errText(e)}`, true);
      }
    },
  };
}

const lensHtmlEmitSchema = z.object({
  html: z.string().min(1).max(262144),
  id: z.string().min(1).max(64).optional(),
  title: z.string().min(1).max(80).optional(),
});

function makeEmitLensHtmlTool(registry: HtmlLensRegistry): ToolDefinition {
  return {
    name: HTML_LENS_TOOL_NAME,
    // The shared canvas contract IS the description (one source of truth with the
    // host's canvas_publish); the chamber-specific routing rides ahead of it.
    description: [
      "Author an HTML lens: publish a designed, self-contained HTML page as its own live panel on the Chamber surface.",
      "`id` is a short, stable kebab-case identifier for the subject (re-emitting the same id updates the same panel, and the lens persists across restarts);",
      "omit it to target the single shared legacy canvas instead. `title` (optional) names the panel head.",
      "`id` plays the role the contract below calls `name`.",
      CANVAS_PUBLISH_CONTRACT,
    ].join(" "),
    inputSchema: lensHtmlEmitSchema,
    state_changing: true,
    async execute(input, ctx) {
      const parsed = lensHtmlEmitSchema.safeParse(input);
      if (!parsed.success) {
        emitResult(ctx, `chamber_emit_lens_html: ${parsed.error.message}`, true);
        return;
      }
      const { html, title } = parsed.data;
      const structural = htmlLensStructuralError(html);
      if (structural !== undefined) {
        emitResult(ctx, `chamber_emit_lens_html: ${structural}`, true);
        return;
      }
      // Fail-closed palette gate (the canvas_publish contract): a declared
      // categorical palette that hard-fails CVD/contrast rejects the emit with the
      // per-check report so the turn fixes the colors and retries.
      const palettes = declaredHtmlPalettes(html);
      for (const mode of ["dark", "light"] as const) {
        const palette = palettes[mode];
        if (!palette) continue;
        let report: ReturnType<typeof validateCategoricalPalette>;
        try {
          report = validateCategoricalPalette(palette, { mode });
        } catch (e) {
          emitResult(ctx, `chamber_emit_lens_html: data-palette-${mode}: ${errText(e)}`, true);
          return;
        }
        if (!report.ok) {
          emitResult(
            ctx,
            `chamber_emit_lens_html: the declared ${mode} palette fails validation — fix the colors (prefer the keelson series slots) and emit again:\n${formatPaletteReport(report)}`,
            true,
          );
          return;
        }
      }
      let id: string | undefined;
      if (parsed.data.id !== undefined) {
        id = canonicalLensId(parsed.data.id);
        if (!id) {
          emitResult(ctx, "chamber_emit_lens_html: id has no usable characters", true);
          return;
        }
      }
      try {
        const { key } = await registry.publish(html, {
          ...(id !== undefined ? { id } : {}),
          ...(title !== undefined ? { title } : {}),
        });
        // No chamber-lenses/roster/brief refresh here (unlike chamber_emit_lens):
        // HTML lenses persist in their own store, which those collectors don't
        // read, so refreshing them would be inert.
        emitResult(ctx, JSON.stringify({ ok: true, key }));
      } catch (e) {
        emitResult(ctx, `chamber_emit_lens_html failed: ${errText(e)}`, true);
      }
    },
  };
}

const lensRetireSchema = z.object({ id: z.string().min(1).max(64) });

// Lens retire seam: delete a lens's persisted record AND drop its live panel +
// snapshot key, so an agent can retire a lens it (or another Mind) authored.
// Mirrors the chamber-genesis refresh path: fail-closed on an unknown id
// (deleteLens throws), then refresh the lenses index AFTER success only.
function makeRetireLensTool(): ToolDefinition {
  return {
    name: "chamber_retire_lens",
    description:
      "Retire a lens: permanently remove a lens you (or another Mind) authored — its persisted record AND its live Chamber panel. `id` is the lens's stable kebab-case identifier (the same id chamber_emit_lens used). Fails closed if no such lens exists.",
    inputSchema: lensRetireSchema,
    state_changing: true,
    async execute(input, ctx) {
      const parsed = lensRetireSchema.safeParse(input);
      if (!parsed.success) {
        emitResult(ctx, `chamber_retire_lens: ${parsed.error.message}`, true);
        return;
      }
      const res = await deleteRecordOfKind(
        parsed.data.id,
        "lens",
        (id) => `'${id}' is an exhibit — use chamber_delete_exhibit`,
      );
      if (!res.ok) {
        emitResult(ctx, `chamber_retire_lens: ${res.error}`, true);
        return;
      }
      emitResult(ctx, JSON.stringify({ ok: true, key: res.key }));
    },
  };
}

// Exhibit publish seam — the room driver's turn tool: a discussion tables its
// deliverable (an assessment, a plan, a findings board) as a point-in-time record
// on the Exhibits shelf. Deliberately NO sourceRoom input: the room driver stamps
// the producing room after WITNESSING this tool fire in a turn it ran (see
// stampExhibitSources), so provenance can't be claimed, only observed.
const exhibitEmitSchema = z.object({
  id: z.string().min(1).max(64),
  board: canvasBoardViewSchema,
  reason: z.string().min(1).max(120).optional(),
});

function makeTableExhibitTool(store: LensStore, registry: LensRegistry): ToolDefinition {
  return {
    name: EXHIBIT_TOOL_NAME,
    description:
      "Table an exhibit: publish a canvas `board` DELIVERABLE your discussion produced onto the Chamber surface, where it shows as its own panel on the Exhibits shelf — a point-in-time record (an assessment, a plan, a findings summary), kept until deleted. `id` is a short, stable kebab-case identifier for the deliverable; `board` is the canvas board view; optional `reason` is a one-line gist of what the exhibit holds. Call it once when the discussion has converged on something worth keeping. NOT for a standing view you intend to keep updating — author that with chamber_emit_lens.",
    inputSchema: exhibitEmitSchema,
    state_changing: true,
    execute(input, ctx) {
      // Serialized on lensWriteInFlight: the tool's load-check-publish, the witness
      // stamp, and the note write-back all touch the same record files, and an
      // unserialized publish could land inside a stamp's read-modify-write.
      const apply = async (): Promise<void> => {
        const parsed = exhibitEmitSchema.safeParse(input);
        if (!parsed.success) {
          emitResult(ctx, `chamber_table_exhibit: ${parsed.error.message}`, true);
          return;
        }
        const id = canonicalLensId(parsed.data.id);
        if (!id) {
          emitResult(ctx, "chamber_table_exhibit: id has no usable characters", true);
          return;
        }
        try {
          await lensReconcileInFlight?.catch(() => {});
          const existing = await store.loadLens(id);
          // The two species share one id space, so the EXHIBIT verb must not
          // overwrite a standing lens (it would flip the record's kind and drop
          // its maintainer provenance).
          if (existing && !isExhibit(existing)) {
            emitResult(
              ctx,
              `chamber_table_exhibit: '${id}' is a lens — update it with chamber_emit_lens or pick another id`,
              true,
            );
            return;
          }
          const { key } = await registry.publish(
            id,
            parsed.data.board,
            // A re-table keeps the witnessed source until the driver re-stamps it
            // (the record is rewritten whole, so an omitted field would clear it).
            { reason: parsed.data.reason, sourceRoom: existing?.sourceRoom },
            "exhibit",
          );
          // Mirror the lens emit's freshness path: the new exhibit appears in its
          // index promptly (a re-table with a changed title also updates the
          // producing room's tabled link), and a tabled deliverable is briefing
          // substance. No roster refresh — exhibits don't ride the pulse's "Live
          // views" count.
          await refreshExhibitIndexes();
          void evaluateBriefGate().catch(() => {});
          await refreshStandingPanels();
          emitResult(ctx, JSON.stringify({ ok: true, key }));
        } catch (e) {
          emitResult(ctx, `chamber_table_exhibit failed: ${errText(e)}`, true);
        }
      };
      return enqueueLensWrite(apply);
    },
  };
}

// Exhibit delete seam: the chamber_retire_lens sibling for the Exhibits shelf,
// kind-checked the other way (see deleteExhibitAction, the board-action twin).
const exhibitDeleteSchema = z.object({ id: z.string().min(1).max(64) });

function makeDeleteExhibitTool(): ToolDefinition {
  return {
    name: "chamber_delete_exhibit",
    description:
      "Delete an exhibit: permanently remove a tabled deliverable — its persisted record AND its live Chamber panel. `id` is the exhibit's stable kebab-case identifier (the same id chamber_table_exhibit used; see chamber_list_exhibits). Fails closed if no such exhibit exists. NOT for retiring a lens (chamber_retire_lens).",
    inputSchema: exhibitDeleteSchema,
    state_changing: true,
    async execute(input, ctx) {
      const parsed = exhibitDeleteSchema.safeParse(input);
      if (!parsed.success) {
        emitResult(ctx, `chamber_delete_exhibit: ${parsed.error.message}`, true);
        return;
      }
      const res = await deleteRecordOfKind(
        parsed.data.id,
        "exhibit",
        (id) => `'${id}' is a lens — use chamber_retire_lens`,
      );
      if (!res.ok) {
        emitResult(ctx, `chamber_delete_exhibit: ${res.error}`, true);
        return;
      }
      emitResult(ctx, JSON.stringify({ ok: true, key: res.key }));
    },
  };
}

// Tools are the only chamber surface an MCP client reaches — a board action is not —
// so the read-only list tools and the cleanup verbs (retire a Mind, delete an ended
// room, otherwise board-action-only) are registered here, making the genesis ->
// convene -> read transcript -> clean up lifecycle drivable over MCP, not only the SPA.

// No input — the list tools take none. A bare object schema keeps the params the
// provider advertises empty rather than absent (z.toJSONSchema needs an object).
const noToolInputSchema = z.object({});

// Emit a list payload that stays valid JSON under the tool-result budget: keep rows
// until the next would push the serialized result over the cap, then report the
// omitted count. boundedText would instead truncate the serialized string —
// unparseable JSON exactly when the cap bites — so the list tools use this.
function emitJsonList<T>(ctx: ToolContext, key: string, rows: readonly T[]): void {
  const build = (kept: readonly T[]): string =>
    JSON.stringify({
      count: rows.length,
      ...(kept.length < rows.length ? { omitted: rows.length - kept.length } : {}),
      [key]: kept,
    });
  let kept: T[] = [];
  for (const row of rows) {
    const next = [...kept, row];
    if (kept.length > 0 && build(next).length > MAX_TOOL_RESULT_CHARS) break;
    kept = next;
  }
  emitResult(ctx, build(kept));
}

function makeListMindsTool(): ToolDefinition {
  return {
    name: "chamber_list_minds",
    description:
      "List the Chamber's Minds (the agent roster): each Mind's slug, name, role, tagline, and any pinned model/provider and capability tools. Read-only. Use it to see which agents exist before convening a room. NOT for creating a Mind (run the chamber-genesis workflow) or retiring one (chamber_retire_mind).",
    inputSchema: noToolInputSchema,
    state_changing: false,
    async execute(_input, ctx) {
      try {
        const minds = await readMinds(mindsDir());
        const rows = minds.map((m) => ({
          slug: m.slug,
          name: m.name,
          role: m.role,
          tagline: m.persona,
          ...(m.model ? { model: m.model } : {}),
          ...(m.provider ? { provider: m.provider } : {}),
          ...(m.tools && m.tools.length > 0 ? { tools: m.tools } : {}),
        }));
        emitJsonList(ctx, "minds", rows);
      } catch (e) {
        emitResult(ctx, `chamber_list_minds failed: ${errText(e)}`, true);
      }
    },
  };
}

function makeListRoomsTool(): ToolDefinition {
  return {
    name: "chamber_list_rooms",
    description:
      "List the Chamber's rooms — active sessions first, then ended ones — with each room's slug, name, status, strategy, participants, and turn progress. Read-only. Use it to find a room to read in detail with chamber_room_status, or to delete with chamber_room_delete. NOT for starting, steering, or stopping a room (chamber_room_start / _say / _stop).",
    inputSchema: noToolInputSchema,
    state_changing: false,
    async execute(_input, ctx) {
      try {
        const rooms = await listRooms(roomsDir());
        // listRooms is newest-first; surface active rooms ahead of finished ones
        // (the sessions-index convention), preserving the createdAt order within each.
        const ordered = [
          ...rooms.filter((r) => r.status === "active"),
          ...rooms.filter((r) => r.status !== "active"),
        ];
        const rows = ordered.map((r) => ({
          slug: r.slug,
          name: r.name,
          status: r.status,
          strategy: r.strategy,
          participants: r.participants,
          turn: r.turnIndex,
          turnBudget: r.turnBudget,
          ...(r.topic ? { topic: r.topic } : {}),
          ...(r.projectId ? { projectId: r.projectId } : {}),
          ...(r.coding ? { coding: true } : {}),
        }));
        emitJsonList(ctx, "rooms", rows);
      } catch (e) {
        emitResult(ctx, `chamber_list_rooms failed: ${errText(e)}`, true);
      }
    },
  };
}

const listLensesSchema = z.object({
  id: z.string().min(1).max(64).optional(),
});

function makeListLensesTool(): ToolDefinition {
  return {
    name: "chamber_list_lenses",
    description:
      "List the Chamber's living lenses (agent-authored canvas boards), newest first: each lens's id, when it was last updated, any refresh backing, and any provenance (scope, maintaining Mind, reason). Pass { id } to fetch ONE lens in full — the matching record then also carries its `board` (the current composition), which a refresh turn re-composes from. Read-only. NOT for authoring a lens (run the chamber-lens workflow), retiring one (chamber_retire_lens), or the tabled deliverables (chamber_list_exhibits).",
    inputSchema: listLensesSchema,
    state_changing: false,
    async execute(input, ctx) {
      const parsed = listLensesSchema.safeParse(input ?? {});
      if (!parsed.success) {
        emitResult(ctx, `chamber_list_lenses: ${parsed.error.message}`, true);
        return;
      }
      const wanted = parsed.data.id ? canonicalLensId(parsed.data.id) : undefined;
      // An id that canonicalizes to nothing fails closed (mirrors the emit and
      // action guards) — a silent empty list would read as "no such lens".
      if (parsed.data.id !== undefined && !wanted) {
        emitResult(
          ctx,
          `chamber_list_lenses: unsafe lens id: ${JSON.stringify(parsed.data.id)}`,
          true,
        );
        return;
      }
      try {
        const lenses = (await listLenses(lensesDir())).filter(
          (l) => !isExhibit(l) && (wanted === undefined || l.id === wanted),
        );
        const rows = lenses.map((l) => ({
          id: l.id,
          updatedAt: l.updatedAt,
          ...(l.refresh ? { refresh: l.refresh } : {}),
          ...(l.scope ? { scope: l.scope } : {}),
          ...(l.maintainingMind ? { maintainingMind: l.maintainingMind } : {}),
          ...(l.reason ? { reason: l.reason } : {}),
          // The board rides along only on a single-lens fetch: it is the bulky
          // field, and the list's readers (briefings, refresh turns) only need
          // one composition at a time.
          ...(wanted !== undefined ? { board: l.board } : {}),
        }));
        emitJsonList(ctx, "lenses", rows);
      } catch (e) {
        emitResult(ctx, `chamber_list_lenses failed: ${errText(e)}`, true);
      }
    },
  };
}

function makeListExhibitsTool(): ToolDefinition {
  return {
    name: "chamber_list_exhibits",
    description:
      "List the Chamber's exhibits (deliverables discussions tabled), newest first: each exhibit's id, when it was tabled, the producing room when witnessed, and any gist. Read-only. NOT for tabling one (chamber_table_exhibit), deleting one (chamber_delete_exhibit), or the living lenses (chamber_list_lenses).",
    inputSchema: noToolInputSchema,
    state_changing: false,
    async execute(_input, ctx) {
      try {
        const exhibits = (await listLenses(lensesDir())).filter(isExhibit);
        const rows = exhibits.map((l) => ({
          id: l.id,
          tabledAt: l.updatedAt,
          ...(l.sourceRoom ? { sourceRoom: l.sourceRoom } : {}),
          ...(l.reason ? { reason: l.reason } : {}),
        }));
        emitJsonList(ctx, "exhibits", rows);
      } catch (e) {
        emitResult(ctx, `chamber_list_exhibits failed: ${errText(e)}`, true);
      }
    },
  };
}

const mindRetireSchema = z.object({ slug: z.string().min(1).max(64) });

// Mind retire seam: delete a Mind's record + SOUL.md, then refresh the roster and
// standing panels — the same mutate-then-refresh path the `retire` board action
// takes, exposed as a tool so an MCP client can retire a Mind (the minds noun
// otherwise has no management tool). retireMind asserts a safe slug and throws when
// the Mind is absent, so the refresh runs only after a real delete.
function makeRetireMindTool(): ToolDefinition {
  return {
    name: "chamber_retire_mind",
    description:
      "Retire a Mind: permanently remove an agent's record and SOUL.md from the roster. `slug` is the Mind's identifier (see chamber_list_minds). Fails closed if no such Mind exists. NOT for retiring a lens (chamber_retire_lens).",
    inputSchema: mindRetireSchema,
    state_changing: true,
    async execute(input, ctx) {
      const parsed = mindRetireSchema.safeParse(input);
      if (!parsed.success) {
        emitResult(ctx, `chamber_retire_mind: ${parsed.error.message}`, true);
        return;
      }
      const slug = parsed.data.slug.trim();
      try {
        await retireMind(mindsDir(), slug);
        invalidateRoster();
        await refreshWorkflow?.("chamber-roster")?.catch(() => {});
        await refreshStandingPanels();
        emitResult(ctx, JSON.stringify({ ok: true, slug }));
      } catch (e) {
        emitResult(ctx, `chamber_retire_mind failed: ${errText(e)}`, true);
      }
    },
  };
}

const roomDeleteSchema = z.object({ room: z.string().min(1) });
const ROOM_TRANSCRIPT_DEFAULT_LIMIT = 50;
const ROOM_TRANSCRIPT_MAX_LIMIT = 500;
const roomTranscriptSchema = z.object({
  room: z.string().min(1),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(ROOM_TRANSCRIPT_MAX_LIMIT).optional(),
});

function makeRoomTranscriptTool(): ToolDefinition {
  return {
    name: "chamber_room_transcript",
    description:
      "Read a Chamber room's full persisted transcript in pages: returns exact transcript entries from rooms/<slug>/transcript.jsonl plus offset, limit, total, and nextCursor. Read-only. Use it to page through a long room transcript without chamber_room_status truncation. NOT for starting, steering, stopping, or deleting a room.",
    inputSchema: roomTranscriptSchema,
    state_changing: false,
    async execute(input, ctx) {
      const parsed = roomTranscriptSchema.safeParse(input);
      if (!parsed.success) {
        emitResult(ctx, `chamber_room_transcript: ${parsed.error.message}`, true);
        return;
      }
      const slug = parsed.data.room.trim();
      if (!slug) {
        emitResult(ctx, "chamber_room_transcript: room is required", true);
        return;
      }
      const offset = parsed.data.offset ?? 0;
      const limit = parsed.data.limit ?? ROOM_TRANSCRIPT_DEFAULT_LIMIT;
      try {
        const store = createFileRoomStore(roomsDir());
        const room = await store.loadRoom(slug);
        if (!room) throw new Error(`room '${slug}' not found`);
        const transcript = await store.loadTranscript(slug);
        const end = Math.min(offset + limit, transcript.length);
        emitResult(
          ctx,
          JSON.stringify({
            ok: true,
            room: slug,
            offset,
            limit,
            total: transcript.length,
            nextCursor: end < transcript.length ? end : null,
            entries: transcript.slice(offset, end),
          }),
        );
      } catch (e) {
        emitResult(ctx, `chamber_room_transcript failed: ${errText(e)}`, true);
      }
    },
  };
}

// Room delete seam: remove an ended room's directory (room.json + transcript +
// ledger), drop its panel, and refresh the sessions index — the same path the
// room-delete board action takes, exposed as a tool so an MCP client can clean up a
// finished room. Refuses an active room (stop it first); deleteRoom asserts a safe
// slug and throws when the room is absent, so this fails closed.
function makeRoomDeleteTool(): ToolDefinition {
  return {
    name: "chamber_room_delete",
    description:
      "Delete an ended Chamber room: permanently remove its record, transcript, and ledger. `room` is the room slug (see chamber_list_rooms). Stop an active room with chamber_room_stop before deleting it; fails closed if no such room exists. NOT for stopping a running room.",
    inputSchema: roomDeleteSchema,
    state_changing: true,
    async execute(input, ctx) {
      const parsed = roomDeleteSchema.safeParse(input);
      if (!parsed.success) {
        emitResult(ctx, `chamber_room_delete: ${parsed.error.message}`, true);
        return;
      }
      const slug = parsed.data.room.trim();
      if (activeRooms.has(slug)) {
        emitResult(
          ctx,
          "chamber_room_delete: stop the room before deleting it (chamber_room_stop).",
          true,
        );
        return;
      }
      try {
        await createFileRoomStore(roomsDir()).deleteRoom(slug);
        // Drop any lingering most-recent pin/panel for the deleted room (mirrors the
        // board action), then refresh the index card away — fail-soft on the seam.
        if (lastSlug === slug) lastSlug = undefined;
        reconcileRoomPanels();
        await refreshWorkflow?.("chamber-rooms")?.catch(() => {});
        await refreshStandingPanels();
        emitResult(ctx, JSON.stringify({ ok: true, slug }));
      } catch (e) {
        emitResult(ctx, `chamber_room_delete failed: ${errText(e)}`, true);
      }
    },
  };
}

// The room controls as chat tools — the second `step()` consumer the StepOutcome
// soundness (#10/#13) was built for. Fire-and-return: start kicks the existing
// auto-advance loop; status reads progress; say/stop steer a room — an explicit
// `room` slug, or by default the most-recent active one (the server assigns slugs).
// start self-gates on an in-tool `confirm` flag because each turn is a paid agent
// call (keelson chat has no pause-and-confirm gate yet — the OSDU lifecycle pattern).
function roomControlTools(store: RoomStore): ToolDefinition[] {
  return [
    {
      name: "chamber_room_status",
      description:
        'Use when the user asks what is happening in a Chamber room — "what are they saying", "show the room", "room status". Returns a room\'s participants, status, turn count, and the conversation so far. Defaults to the most-recent room; pass `room` (a slug) to read a specific one — a bare call also indexes the other active rooms when several run at once. Read-only. NOT for starting or stopping a room.',
      inputSchema: roomTargetSchema,
      state_changing: false,
      async execute(input, ctx) {
        try {
          const parsed = roomTargetSchema.safeParse(input);
          const target = parsed.success ? parsed.data.room : undefined;
          emitResult(ctx, await renderRoomStatus(store, target));
        } catch (e) {
          emitResult(ctx, `chamber_room_status failed: ${errText(e)}`, true);
        }
      },
    },
    {
      name: "chamber_room_start",
      description:
        "Open a Chamber room where the named agent Minds converse turn-by-turn (turnBudget paid agent turns, default 8; at budget exhaustion every strategy except review appends one extra paid closing-synthesis turn, so a completed room runs up to turnBudget + 1 room turns — turnBudget + 2 when a design-bearing room is grounded with acceptance criteria (a cross-vendor fidelity turn before synthesis); every Mind that spoke then also runs one paid reflection turn at close, so the total paid calls exceed the room-turn count). Provide a `topic` to frame the discussion — strongly recommended, since it is what the first speaker responds to. Optionally provide `grounding` — a `{ sourceUrl?, criteria?: string[] }` brief distinct from the topic: it is injected into every turn prompt, and its acceptance criteria drive an independent cross-vendor fidelity check — when the room's Minds span two providers — that folds any divergences into the closing document before a design-bearing room (sequential/concurrent/group-chat/open-floor/magentic) synthesizes. Strategy role rules: sequential/concurrent need only at least two participant Mind slugs and no manager; group-chat requires a `moderator` Mind slug that is real, safe, and NOT among participants, with optional `synthesizer` that is also real/safe and neither a participant nor the moderator; open-floor has no moderator or synthesizer; review requires exactly two participants pinned to different providers — first author, second reviewer — with no moderator or synthesizer and turnBudget at least 2; magentic requires a real/safe `manager` Mind slug NOT among participants, no moderator or synthesizer, and at least two worker participants. State-changing: set confirm:true ONLY after the user has approved — without confirm the tool reports what it would start and runs nothing. participants are Mind slugs (see chamber_list_minds). Several rooms can run concurrently (up to a small cap) — stop one if the cap is reached. NOT for creating a Mind (that is the New agent / genesis action).",
      inputSchema: roomStartSchema,
      state_changing: true,
      requires_confirmation: true,
      async execute(input, ctx) {
        const parsed = roomStartSchema.safeParse(input);
        if (!parsed.success) {
          emitResult(ctx, `chamber_room_start: ${parsed.error.message}`, true);
          return;
        }
        const { participants, name } = parsed.data;
        const topic = (parsed.data.topic ?? "").trim() || undefined;
        const grounding = normalizeGrounding(parsed.data.grounding);
        const turnBudget = parsed.data.turnBudget ?? DEFAULT_ROOM_TURN_BUDGET;
        const confirm = parsed.data.confirm ?? false;
        const moderator = (parsed.data.moderator ?? "").trim() || undefined;
        const manager = (parsed.data.manager ?? "").trim() || undefined;
        // A `moderator` — or a `manager` — with no explicit strategy infers the
        // matching facilitated mode (group-chat / magentic) so validateStart enforces
        // its rules and the dry-run label below matches what actually starts (an
        // explicit strategy still wins; moderator takes precedence if both are set).
        const strategy =
          (parsed.data.strategy ?? "").trim() ||
          (moderator ? "group-chat" : manager ? "magentic" : "sequential");
        const synthesizer = (parsed.data.synthesizer ?? "").trim() || undefined;
        const minRounds = parsed.data.minRounds;
        const maxSpeakerRepeats = parsed.data.maxSpeakerRepeats;
        const endVoteThreshold = parsed.data.endVoteThreshold;
        // Canonicalize before the dry-run's validateStart: it and driver.start match
        // projectId as an id only, so a name must resolve to its id up here or the
        // dry-run would reject a project the confirm path (and the board) accept.
        const projectInput = (parsed.data.projectId ?? "").trim() || undefined;
        let projectId: string | undefined;
        if (projectInput) {
          const resolved = resolveProjectInput(projectInput);
          if (!resolved.ok) {
            emitResult(ctx, `chamber_room_start: ${resolved.error}`, true);
            return;
          }
          projectId = resolved.project.id;
        }
        const coding = parsed.data.coding ?? false;
        // Validate up front (including roster membership + group-chat moderator
        // rules + project resolution + the coding-tier project requirement) so the
        // dry-run never advertises a start the confirm path rejects.
        const valid = await validateStart(
          participants,
          turnBudget,
          strategy,
          {
            moderator,
            manager,
            synthesizer,
            minRounds,
            maxSpeakerRepeats,
            endVoteThreshold,
          },
          projectId,
          coding,
        );
        if (!valid.ok) {
          emitResult(ctx, `chamber_room_start: ${valid.error}`, true);
          return;
        }
        // Concurrency cap: refuse before the dry-run prompt so the tool never
        // advertises a start the confirm path would reject (startRoom enforces the
        // same cap authoritatively).
        if (activeRooms.size >= MAX_ACTIVE_ROOMS) {
          emitResult(
            ctx,
            `chamber_room_start: ${MAX_ACTIVE_ROOMS} rooms are already active (the concurrent cap) — stop one with chamber_room_stop first.`,
            true,
          );
          return;
        }
        const who = valid.participants.join(", ");
        const topicNote = topic ? ` on "${topic}"` : " (no topic set)";
        const modeNote =
          strategy === "group-chat" && moderator
            ? ` (group-chat, moderated by ${moderator})`
            : strategy === "magentic" && manager
              ? ` (magentic: ${manager} manages ${valid.participants.length} worker${valid.participants.length === 1 ? "" : "s"})`
              : strategy === "review"
                ? ` (review: ${valid.participants[0]} reviewed by ${valid.participants[1]})`
                : "";
        // validateStart confirmed the project resolves; name it so the operator sees
        // the repo the turns will run against.
        const projectNote = projectId
          ? ` in project "${resolveProject(projectId)?.name ?? projectId}"`
          : "";
        // Name the elevated capability at the confirm step so the human approving
        // the (paid) room knows a coding Mind can run Bash/Edit/Write.
        const codingNote = coding
          ? " with the coding tier ON (Minds that declare `code`/`read` can run Bash/Edit/Write/Read, confined to the project repo)"
          : "";
        // Disclose the extra paid turns a grounded design-bearing room spends at close
        // (a cross-vendor fidelity turn plus the closing synthesis) so the approving
        // human sees the true ceiling, not just the base budget.
        const groundingNote =
          grounding && grounding.criteria.length > 0 && strategy !== "review"
            ? ` It carries a grounding brief: the closing synthesis, plus a cross-vendor fidelity turn when the Minds span two providers, add up to 2 more room turns (up to ${turnBudget + 2}), before the per-speaker reflection pass at close.`
            : "";
        if (!confirm) {
          emitResult(
            ctx,
            `Would open a room with ${who}${topicNote}${modeNote}${projectNote}${codingNote} for ${turnBudget} turns (each turn is a paid agent call).${groundingNote} Re-call chamber_room_start with confirm:true once the user approves.`,
          );
          return;
        }
        // A user abort during the awaits above must not still open a paid room.
        if (ctx.abortSignal.aborted) return;
        const res = await startRoom({
          participants,
          turnBudget,
          name,
          topic,
          ...(grounding ? { grounding } : {}),
          strategy,
          projectId,
          coding,
          moderator,
          manager,
          synthesizer,
          minRounds,
          maxSpeakerRepeats,
          endVoteThreshold,
        });
        if (res.ok) {
          const slug = (res.data as { slug?: string } | undefined)?.slug ?? "";
          emitResult(
            ctx,
            `Opened room "${slug}" with ${who}. It auto-advances — watch the Chamber surface or call chamber_room_status to read progress.`,
          );
        } else {
          emitResult(ctx, `chamber_room_start failed: ${res.error}`, true);
        }
      },
    },
    {
      name: "chamber_room_say",
      description:
        'Steer a Chamber room: `direction` sets guidance for the next speaker, `callOn` nominates a specific Mind to go next, `text` drops a director message into the transcript. Defaults to the most-recent active room; pass `room` (a slug) to steer a specific one when several run at once. Use when the user wants to nudge the conversation ("tell them to wrap up", "let Alice answer"). At least one of direction/callOn/text required. NOT for starting or stopping the room.',
      inputSchema: roomSaySchema,
      state_changing: true,
      async execute(input, ctx) {
        const parsed = roomSaySchema.safeParse(input);
        if (!parsed.success) {
          emitResult(ctx, `chamber_room_say: ${parsed.error.message}`, true);
          return;
        }
        const target = resolveSteerTarget(parsed.data.room);
        if ("error" in target) {
          emitResult(ctx, target.error, true);
          return;
        }
        const slug = target.slug;
        const { direction, callOn, text } = parsed.data;
        // The driver only honors nextSpeaker when it exactly matches an active
        // participant slug — otherwise step() silently drops it and falls back to
        // the strategy. Reject up front so the tool can't report a dropped
        // nomination ("Alice" vs "alice", a typo, a non-participant) as sent.
        if (callOn) {
          const room = await store.loadRoom(slug);
          // magentic routes turns by the manager's ledger, so a forced speaker would run
          // an off-plan turn that settles no task (step() also ignores the override for
          // magentic) — reject it here and point the operator at `direction`, which steers
          // the manager, instead of reporting a dropped nomination as sent.
          if (room?.strategy === "magentic") {
            emitResult(
              ctx,
              "chamber_room_say: a magentic room routes turns by its manager — use `direction` to steer the plan, not `callOn`.",
              true,
            );
            return;
          }
          if (!room?.participants.includes(callOn)) {
            emitResult(
              ctx,
              `chamber_room_say: "${callOn}" is not a participant — call on one of the room's Minds.`,
              true,
            );
            return;
          }
        }
        // injectRoom does the truthiness filtering; pass the fields straight through.
        const res = await injectRoom(slug, {
          directionInjection: direction,
          nextSpeaker: callOn,
          text,
        });
        const note = roomNote(slug);
        emitResult(
          ctx,
          res.ok ? `Sent to the room${note}.` : `chamber_room_say failed: ${res.error}`,
          !res.ok,
        );
      },
    },
    {
      name: "chamber_room_stop",
      description:
        'Stop a Chamber room (halts its turns). Defaults to the most-recent active room; pass `room` (a slug) to stop a specific one when several run at once. Use when the user says "stop the room", "end it". Reversible — a new room can be started afterward. NOT for retiring a Mind.',
      inputSchema: roomTargetSchema,
      state_changing: true,
      async execute(input, ctx) {
        const parsed = roomTargetSchema.safeParse(input);
        const target = resolveSteerTarget(parsed.success ? parsed.data.room : undefined);
        if ("error" in target) {
          emitResult(ctx, target.error, true);
          return;
        }
        // Compute the note before stopRoom drops the slug from the active set.
        const note = roomNote(target.slug);
        const res = await stopRoom(target.slug);
        emitResult(
          ctx,
          res.ok ? `Stopped the room${note}.` : `chamber_room_stop failed: ${res.error}`,
          !res.ok,
        );
      },
    },
  ];
}

export default rib;
