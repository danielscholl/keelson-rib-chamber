import type {
  Brief,
  CanvasView,
  RibActionResult,
  RibContext,
  SnapshotManager,
} from "@keelson/shared";
import { errText, expectView } from "@keelson/shared";
import { evaluateBriefGate } from "./brief-gate.ts";
import {
  codingReviewCapabilityError,
  codingToolPool,
  externalToolPool,
  readToolPool,
} from "./capabilities.ts";
import { composeRoomSystemPrompt } from "./compose.ts";
import { assertSafeSlug } from "./genesis.ts";
import { roomViewKey } from "./keys.ts";
import { EXHIBIT_TOOL_NAME } from "./lens.ts";
import { getLensRegistry, stampExhibitSources, tabledExhibitsFor } from "./lens-runtime.ts";
import { chamberDataHome, mindsDir, roomsDir } from "./paths.ts";
import type { RoomStore } from "./ports.ts";
import { onRoomClosed } from "./reflection-gate.ts";
import { createRoomDriver, type RoomDriver } from "./room.ts";
import { MAX_ACTIVE_ROOMS, type RoomConfigInput } from "./room-config.ts";
import { createCoalescingPublisher } from "./room-publisher.ts";
import { createRoomRegionRegistry, type RoomRegionRegistry } from "./room-region-registry.ts";
import { createFileRoomStore, deriveRoomName, sweepClosedRooms } from "./room-store.ts";
import { DEFAULT_END_VOTE_THRESHOLD } from "./routing.ts";
import {
  refreshStandingPanels,
  refreshWorkflow,
  resolveMinds,
  resolveProjectName,
  resolveProjectRoot,
} from "./runtime.ts";
import { getStrategy } from "./strategies/index.ts";
import type { RoomConfig, RoomStrategyName } from "./types.ts";

// Upper bound on a room's turn budget. Each turn is a (paid) agent call, so an
// accidental or malicious huge budget would launch a runaway sequence; reject it.
export const MAX_ROOM_TURN_BUDGET = 50;

// Default room length when a chat tool omits turnBudget. Applied after parse (not
// z.default()) because z.toJSONSchema — which the Copilot provider feeds the model
// — lists defaulted fields as `required`, forcing the model to supply them.
export const DEFAULT_ROOM_TURN_BUDGET = 8;

// The room driver is a boot-time singleton: it holds in-flight turn state across
// onAction calls, so it is built once in registerTools (the only hook that runs
// with the full ctx — runAgentTurn + snapshot manager) and reused thereafter. It
// stays undefined when either seam is absent, and room actions then fail closed.
let driver: RoomDriver | undefined;
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
    void refreshWorkflow("chamber-rooms").catch(() => {});
  }, ROOMS_TICK_MS);
  roomsTicker.unref?.();
}

function stopRoomsTick(): void {
  if (roomsTicker) clearInterval(roomsTicker);
  roomsTicker = undefined;
}

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
let roomRetentionSweep = Promise.resolve();

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
      await refreshWorkflow("chamber-rooms").catch(() => {});
      await refreshStandingPanels();
    }
  } catch (e) {
    console.error(`[rib-chamber] room retention sweep failed: ${errText(e)}`);
  }
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

// The most-recently-started active room, or undefined when none is active. Set
// iteration is insertion-ordered, so the last entry is the newest active room.
export function mostRecentActiveSlug(): string | undefined {
  return [...activeRooms].at(-1);
}

// Resolve the room a say/stop targets: an explicit (active) slug, else the most-
// recent active room. Returns an error when the named room isn't active or none is —
// so a steer never silently targets a finished or wrong room.
export function resolveSteerTarget(roomArg?: string): { slug: string } | { error: string } {
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
export function roomNote(slug: string): string {
  return activeRooms.size > 1 ? ` (${slug})` : "";
}

export const ROOM_DISABLED: RibActionResult = {
  ok: false,
  error: "room controls require the C1 agent-turn seam and a snapshot manager",
};

export function bindRoomLifecycle(seams: {
  sm: SnapshotManager;
  registerRegion: NonNullable<RibContext["registerRegion"]>;
  runAgentTurn: NonNullable<RibContext["runAgentTurn"]>;
}): { roomStore: RoomStore } {
  const { sm, registerRegion, runAgentTurn: run } = seams;
  // The room publisher routes each room's board to a per-slug key + dynamic surface
  // region, so it requires registerRegion. Rebuilt against a new manager on a
  // re-bootstrap, reused otherwise; built before the old one is disposed so a failed
  // rebuild leaves the existing registry and roomSm consistent.
  let registry = roomRegistry;
  if (!registry || sm !== roomSm) {
    registry = createRoomRegionRegistry(sm, registerRegion);
    roomRegistry?.dispose();
    roomRegistry = registry;
    roomSm = sm;
  }
  const roomStore = createFileRoomStore(roomsDir());
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
    turnTools: [...(getLensRegistry() ? [{ name: EXHIBIT_TOOL_NAME }] : []), ...externalToolPool()],
    // The witnessed-provenance stamp: the driver saw the table-exhibit tool run
    // in this room's turn, so record the room as the exhibit's source.
    onExhibitsTabled: (ids, room) => stampExhibitSources(ids, room),
    exhibits: tabledExhibitsFor,
    // The coding pool (host built-ins), always handed over but inert until a
    // room opts in (room.coding) and is confined — the tier is gated per-room.
    codingTools: codingToolPool(),
    // The read pool (host built-in: Read), granted to every speaker in a room that
    // targets a project, confined to the project root — so a Discussion can read
    // the repo it's about without the coding tier or a per-Mind `read` declaration.
    readTools: readToolPool(),
  });
  queueRoomRetentionSweep();
  return { roomStore };
}

export function clearRoomTracking(): void {
  loops.clear();
  activeRooms.clear();
  lastSlug = undefined;
  stopRoomsTick();
}

export async function disposeRoomLifecycle(): Promise<void> {
  roomRegistry?.dispose();
  roomRegistry = undefined;
  roomSm = undefined;
  releaseRoomViews();
  roomViewSm = undefined;
  await driver?.dispose();
}

export function getDriver(): RoomDriver | undefined {
  return driver;
}

export function getRoomManager(): SnapshotManager | undefined {
  return roomSm;
}

export function isRoomActive(slug: string): boolean {
  return activeRooms.has(slug);
}

export function activeRoomCount(): number {
  return activeRooms.size;
}

export function activeRoomSlugs(): string[] {
  return [...activeRooms];
}

export function lastRoomSlug(): string | undefined {
  return lastSlug;
}

export function noteRoomDeleted(slug: string): void {
  if (lastSlug === slug) lastSlug = undefined;
  reconcileRoomPanels();
}

export async function publishRoomView(slug: string, board: CanvasView): Promise<void> {
  const sm = roomSm;
  if (!sm) return;
  await ensureRoomViewPublisher(sm, slug).publish(board);
}

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
      void refreshWorkflow("chamber-rooms").catch(() => {});
      // A newly-ended room is briefing substance: evaluate the gate (it runs a turn
      // only if the watermark hasn't seen this room) and refresh the roster so its
      // pulse counts/for-you update promptly. Both fire-and-forget — never thrown.
      void evaluateBriefGate().catch(() => {});
      void refreshWorkflow("chamber-roster").catch(() => {});
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

export async function validateStart(
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
export async function startRoom(
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
    void refreshWorkflow("chamber-rooms").catch(() => {});
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
export async function injectRoom(
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
export async function stopRoom(slug: string): Promise<RibActionResult> {
  if (!driver) return ROOM_DISABLED;
  if (!isSafeSlug(slug)) return { ok: false, error: `unsafe room slug: ${JSON.stringify(slug)}` };
  try {
    await driver.stop(slug);
    activeRooms.delete(slug);
    reconcileRoomPanels();
    // The room is now a closed session — refresh the index so it appears as a card
    // (fail-soft; cadence covers an older harness without the seam).
    await refreshWorkflow("chamber-rooms").catch(() => {});
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

// A unique, path-safe room slug per start (timestamp + counter), so every room
// gets its own rooms/<slug>/ dir and a late turn from a prior room can't bleed
// into a new one. Matches SAFE_SLUG (lowercase alnum + hyphens).
function freshRoomSlug(): string {
  return `room-${Date.now().toString(36)}-${(roomSeq++).toString(36)}`;
}

// A room participant must be a safe slug and not a reserved authority: "director"
// and "system" are driver-stamped roles, never speakers (a room with one would
// just end on its turn — an unknown mind).
export function isValidParticipant(slug: string): boolean {
  return slug !== "director" && slug !== "system" && isSafeSlug(slug);
}

// True if the slug is a bare kebab token (no traversal, non-empty). assertSafeSlug
// throws on a bad slug; this is its non-throwing predicate form.
export function isSafeSlug(slug: string): boolean {
  try {
    assertSafeSlug(slug);
    return true;
  } catch {
    return false;
  }
}
