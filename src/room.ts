import type { Brief, TokenUsage } from "@keelson/shared";
import { buildRoomBoard } from "./boards/room.ts";
import { resolveMindTools } from "./capabilities.ts";
import { applyManagerPlan, failStuckTasks, freshLedger, setTaskStatus } from "./ledger.ts";
import { EXHIBIT_TOOL_NAME } from "./lens.ts";
import type { LensRecord } from "./lens-store.ts";
import type { RoomPublisher, RoomStore, RunAgentTurn } from "./ports.ts";
import {
  allHeardInCycle,
  DEFAULT_END_VOTE_THRESHOLD,
  DEFAULT_MAX_SPEAKER_REPEATS,
  DEFAULT_MIN_ROUNDS,
  endVoteRatio,
  leastSpoken,
  type ModeratorDecision,
  parseMagenticPlan,
  parseModeratorDecision,
  parseNomination,
  roundOf,
  speakerCounts,
} from "./routing.ts";
import { getStrategy } from "./strategies/index.ts";
import { magentic } from "./strategies/magentic.ts";
import { openFloor } from "./strategies/open-floor.ts";
import { exhaustedSynthesis } from "./strategies/synthesis.ts";
import {
  buildFidelityPrompt,
  buildManagerPrompt,
  buildModeratorPrompt,
  buildOpenFloorPrompt,
  buildReviewPrompt,
  buildSynthesisPrompt,
  buildTurnEntry,
  buildTurnPrompt,
  buildWorkerPrompt,
} from "./transcript.ts";
import type {
  Mind,
  MindSlug,
  Room,
  RoomConfig,
  RoomStrategyName,
  StrategyStep,
  TaskLedger,
  TaskStatus,
  TurnEntry,
} from "./types.ts";

export interface RoomDriverDeps {
  store: RoomStore;
  publisher: RoomPublisher;
  runAgentTurn: RunAgentTurn;
  // Resolve persona/model/tools by slug. A function (not a port) — the roster is
  // Phase 1 / genesis territory; the driver only needs to look minds up.
  minds: () => Promise<readonly Mind[]> | readonly Mind[];
  // Compose a Mind's turn system prompt by slug: its authored SOUL plus the durable
  // memory + operating rules it has accumulated, so a speaker carries what it has
  // learned into the room instead of starting from a static soul each turn. Falls
  // back to the roster tagline (Mind.persona) when absent, so omitting this keeps a
  // thin persona.
  composeTurnSystem?: (mind: Mind) => Promise<string> | string;
  // Fired once when a room leaves "active" (done/stopped), with the room and its
  // final transcript. The rib hangs the close-only reflection pass off this — a
  // gated, fire-and-forget paid turn per participating Mind. The driver neither
  // awaits nor observes it (a close must never block or fail on reflection), so the
  // reflection policy + cost gating stay rib-side, next to the briefing gate.
  onRoomClosed?: (room: Room, transcript: readonly TurnEntry[]) => void;
  // Neutral working dir for agent turns. Without it the turn inherits the
  // server's cwd, leaking the host repo's ambient context (git state, files)
  // into the conversation; pointing it at the Chamber data home isolates that.
  turnCwd?: string;
  // Resolve a room's targeted project to its root path, so a turn runs at the
  // project root instead of turnCwd. Host-provided (RibContext.getProjects); omitted
  // means targeting is unavailable. NB: this sets cwd, not a filesystem boundary —
  // confinement is a separate host seam.
  resolveProjectRoot?: (projectId: string) => string | undefined;
  // Resolve a room's targeted project to its display name, for the board's scope
  // stat — a separate accessor from resolveProjectRoot (a path) so the board never
  // renders a filesystem path as the operator-facing scope label. Omitted keeps a
  // scoped room's chip showing the raw projectId as a fallback.
  resolveProjectName?: (projectId: string) => string | undefined;
  // Tool names every room turn may invoke, forwarded as the turn's `tools` (the
  // C1 seam resolves them to the rib's registered defs). The rib decides what is
  // safe for a room turn — today the exhibit write seam, so a discussion can table
  // its deliverable mid-room. Omitted/empty keeps the turn text-only (the room default).
  turnTools?: readonly { name: string }[];
  // Fired after a turn in which the driver WITNESSED the table-exhibit tool run,
  // with the raw emitted ids (pre-canonicalization) and the room. The rib stamps
  // sourceRoom off this — witnessed provenance, never agent-claimed. Fire-and-forget:
  // the driver neither awaits nor observes it (a stamp must never block a turn).
  onExhibitsTabled?: (ids: readonly string[], room: Room) => void;
  // Resolve the exhibits a room has tabled, for the board's Tabled section. Called
  // only from republish() — never on the turn path, since it scans the lenses dir.
  // Omitted (a host without the lens seams) means the board carries no Tabled section.
  exhibits?: (slug: MindSlug) => Promise<readonly LensRecord[]>;
  // The coding tier's pool, layered on top of turnTools only for a room that opted
  // in (`room.coding`) AND has a cwd to confine the turn to. These are host provider
  // built-ins (Bash/Edit/Write/Read), so a turn that gets them is confined to its
  // cwd via allowedDirectories — granting and confining are one decision. Omitted
  // keeps every room text-only/lens (the coding tier is unavailable).
  codingTools?: readonly { name: string }[];
  // The read-only pool (host built-in: Read) granted to EVERY speaker in a room that
  // targets a resolvable project, confined to the project root — independent of the
  // coding tier and of any per-Mind `read` declaration. Selecting a project is the
  // grant, so a Discussion is grounded in the actual repo rather than reasoning blind.
  // Read can't mutate, so it's safe room-wide; write/exec stays the coding tier.
  // Omitted keeps project rooms text-only (the read tier is unavailable).
  readTools?: readonly { name: string }[];
  now?: () => Date;
  newId?: () => string;
}

export interface RoomStartConfig {
  slug: MindSlug;
  name: string;
  strategy: RoomStrategyName;
  participants: readonly MindSlug[];
  turnBudget: number;
  topic?: string;
  grounding?: Brief;
  config?: RoomConfig;
  projectId?: string;
  coding?: boolean;
}

export interface RoomInjectInput {
  directionInjection?: string;
  nextSpeaker?: MindSlug;
  text?: string;
}

// The result of driving one turn. The auto-advance loop only needs "keep going?"
// (it stops on "ended"), but a second stepper — the planned chat-tool room
// controls — must tell the serial-gate no-op apart from a closed room, which a
// bare boolean conflated (both were `false`).
//   - "advanced": a turn ran and the room is still active — step again.
//   - "ended":    the room is not active (closed this step, already closed, or a
//                 newer generation superseded this op) — stop driving.
//   - "busy":     a turn is already in flight, so this call did nothing. The sole
//                 auto-advance loop never sees this (it awaits each step fully); a
//                 second stepper must treat it as "retry later", not "ended".
export type StepOutcome = "advanced" | "ended" | "busy";

export interface RoomDriver {
  start(config: RoomStartConfig): Promise<Room>;
  // Drive one turn; see StepOutcome. The auto-advance loop stops on "ended" and
  // is the sole stepper, so it no longer re-reads room.json itself.
  step(slug: MindSlug): Promise<StepOutcome>;
  // Returns whether the override was applied — false if the room is no longer
  // active or a newer generation superseded it, so a caller can report a dropped
  // steer instead of a false success.
  inject(slug: MindSlug, input: RoomInjectInput): Promise<boolean>;
  stop(slug: MindSlug): Promise<void>;
  // Re-publish a room's board from current state, without writing any. The rib calls
  // this once an exhibit's provenance stamp lands, so the Tabled section appears in
  // the room it was tabled in rather than a turn later. A no-op for an unknown room.
  republish(slug: MindSlug): Promise<void>;
  dispose(): Promise<void>;
  isDisposed(): boolean;
}

// Pick the pre-close fidelity checker: a participant Mind on a genuinely DIFFERENT,
// pinned provider than the synthesizer (the cross-vendor check is the point, as in the
// review strategy). A real cross-vendor read needs BOTH providers pinned and differing —
// so an unpinned synthesizer, or no differing-provider participant, yields undefined and
// the driver skips the check rather than run a same-vendor (or unconfirmable) auditor
// whose prompt would falsely claim a second vendor. Pure — the driver resolves the slug.
export function pickFidelityChecker(
  room: Room,
  synthSlug: MindSlug | undefined,
  roster: readonly Mind[],
): MindSlug | undefined {
  const bySlug = new Map(roster.map((m) => [m.slug, m]));
  const synthProvider = synthSlug ? bySlug.get(synthSlug)?.provider : undefined;
  if (!synthProvider) return undefined;
  return room.participants.find((p) => {
    if (p === synthSlug) return false;
    const provider = bySlug.get(p)?.provider;
    return provider !== undefined && provider !== synthProvider;
  });
}

// The synthesizer for a grounded design-bearing room's NATURAL close (an open-floor
// end-vote, a magentic ledger completing) — so a grounded room always closes with a
// fidelity-checked synthesis, not only on budget exhaustion. Reuses exhaustedSynthesis'
// precedence (config.synthesizer → facilitator → last participant). Undefined for review
// (its cross-vendor pass is its own close) and for an ungrounded room, which ends direct.
export function groundedCloseSynthesizer(
  room: Room,
  transcript: readonly TurnEntry[],
): MindSlug | undefined {
  if (room.strategy === "review") return undefined;
  const hasCriteria = room.grounding?.criteria.some((c) => c.trim().length > 0) ?? false;
  if (!hasCriteria) return undefined;
  const facilitator = room.config?.manager ?? room.config?.moderator;
  const decision = exhaustedSynthesis(room, transcript, facilitator);
  return decision.kind === "synthesize" ? decision.mind : undefined;
}

export function createRoomDriver(deps: RoomDriverDeps): RoomDriver {
  // The most recently resolved roster, stashed as a side effect of the EXISTING
  // per-turn deps.minds() calls below (never a new one of its own) — starts
  // empty (a fresh room's first publish, before any turn, has no speaker to
  // tone anyway). persistAndPublish reads this SYNCHRONOUSLY so a board publish
  // never gains a new await on deps.minds(): several tests deliberately gate
  // that seam to test turn-suspension timing, and publishing happens far more
  // often than a turn resolves — awaiting it there would race those gates.
  let cachedMinds: readonly Mind[] = [];
  async function fetchMinds(): Promise<readonly Mind[]> {
    const minds = await deps.minds();
    cachedMinds = minds;
    return minds;
  }

  // What each room has tabled, read SYNCHRONOUSLY by publishBoard for the same reason
  // as cachedMinds — and additionally because deps.exhibits scans the whole lenses
  // directory, which a per-turn publish must not pay for. Populated only by
  // republish(), which the lens stamp calls once a table is witnessed. Empty is the
  // correct initial state: a fresh slug per start means a starting room has tabled
  // nothing yet.
  const cachedExhibits = new Map<MindSlug, readonly LensRecord[]>();

  const controllers = new Map<MindSlug, AbortController>();
  // Rooms with a turn in flight. The serial gate: one turn at a time per room, so
  // two fire-and-return room-next calls cannot race the same turnIndex.
  const inFlight = new Set<MindSlug>();
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? defaultNewId();
  // Rooms currently driving. Multiple run concurrently — each owns its own per-slug
  // snapshot key + surface region (room-region-registry), so there is no shared
  // single-key contention. Tracked so releaseSlugState never GCs a live room's
  // in-memory state; a fresh slug per start means starts never contend for a slot.
  const activeRooms = new Set<MindSlug>();
  // Set by dispose(). The CLI MVP can't cancel an in-flight child, so a turn can
  // settle after teardown; once disposed, a late turn drops its append/commit so
  // nothing is written or published after the rib is gone. The adapter observes
  // this via isDisposed() rather than tracking a parallel flag of its own.
  let disposed = false;

  // The active room's transcript, held in memory. The driver is the sole writer
  // of a room's transcript, so this stays authoritative: loaded once on start,
  // appended in place as entries are written, and read for both prompt context
  // and the board. Without it each turn re-parsed the whole file twice (prompt +
  // board), which is quadratic over a room's life. Evicted when the room closes.
  const transcripts = new Map<MindSlug, TurnEntry[]>();

  // Rooms whose close has already been signaled to onRoomClosed, so the reflection
  // pass fires at most once per room even though a terminal commit and an operator
  // stop can both reach a close. A fresh slug per start means this never needs
  // clearing within a lifetime.
  const notifiedClosed = new Set<MindSlug>();

  function clearActive(slug: MindSlug): void {
    activeRooms.delete(slug);
    controllers.delete(slug);
  }

  // A room's active lifetime has a generation. start and stop open/close one; a
  // step or inject captures it and skips its room-state write if a newer
  // generation has superseded it (e.g. a stop+restart while a turn was draining),
  // so a stale completion can't clobber or reactivate fresher state. Transcript
  // appends are append-only and always happen; only the room write is gated.
  const generations = new Map<MindSlug, number>();
  const generationOf = (slug: MindSlug): number => generations.get(slug) ?? 0;
  function bumpGeneration(slug: MindSlug): number {
    const value = generationOf(slug) + 1;
    generations.set(slug, value);
    return value;
  }

  // Release a closed slug's in-memory state, gated so it never fires while a
  // turn is in flight or the slug is active. Deleting `generations` is safe
  // because the rib mints a unique slug per start (freshRoomSlug) — a slug is
  // never reused, so a new lifetime can't realign with a stale generation.
  function releaseSlugState(slug: MindSlug): void {
    if (inFlight.has(slug) || activeRooms.has(slug)) return;
    controllers.delete(slug);
    transcripts.delete(slug);
    generations.delete(slug);
    cachedExhibits.delete(slug);
  }

  // Per-room serialization for the load-modify-save commit sections. A director
  // inject runs concurrently with an in-flight turn (it must — the turn is
  // awaiting the agent), so without this their commits can interleave: inject
  // loads the pre-turn room and saves it after the turn advanced turnIndex,
  // reverting the advance (the same turn repeats). The lock wraps only the brief
  // commit sections, never the agent call, so mid-turn injection still works.
  const writeChains = new Map<MindSlug, Promise<unknown>>();
  function withLock<T>(slug: MindSlug, fn: () => Promise<T>): Promise<T> {
    const prev = writeChains.get(slug) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    // Keep the chain going even if this section throws (one failure must not
    // wedge the room's future commits).
    const stored = next.then(
      () => {},
      () => {},
    );
    writeChains.set(slug, stored);
    void stored.then(() => {
      if (writeChains.get(slug) !== stored) return;
      writeChains.delete(slug);
      releaseSlugState(slug);
    });
    return next;
  }

  // Append to disk (the append-only source of truth) and mirror into the active
  // generation's in-memory transcript so the next prompt/board build needs no
  // re-read. The disk write is unconditional; the cache push is generation-gated:
  // a turn still draining from a superseded generation (a stop/restart landed
  // mid-turn) must not push its late reply into the new generation's cache array —
  // that would pollute the new room's board and the next speaker's prompt context.
  // The gate also makes the post-await Map lookup sound: an array's identity only
  // changes when the generation bumps (start opens a new one, stop/terminal deletes
  // it), so a matching `gen` means `transcripts.get(slug)` is this gen's array.
  async function appendEntry(slug: MindSlug, gen: number, entry: TurnEntry): Promise<void> {
    await deps.store.appendTranscript(slug, entry);
    if (generationOf(slug) !== gen) return; // superseded mid-turn — keep it off the new cache
    transcripts.get(slug)?.push(entry);
  }

  // The room's transcript for prompt context / board: the in-memory copy while
  // the room is live, falling back to disk (the source of truth) otherwise.
  async function loadCachedTranscript(slug: MindSlug): Promise<readonly TurnEntry[]> {
    return transcripts.get(slug) ?? (await deps.store.loadTranscript(slug));
  }

  async function publishBoard(room: Room): Promise<void> {
    const transcript = await loadCachedTranscript(room.slug);
    // A magentic room carries a task ledger; load it so the board renders the plan.
    // Other strategies have none (loadLedger -> undefined), so the board omits the
    // section. Cheap (a small JSON read), and keeps the board the one surface the
    // ledger reaches the operator through.
    const ledger =
      room.strategy === "magentic" ? await deps.store.loadLedger(room.slug) : undefined;
    const projectName = room.projectId ? deps.resolveProjectName?.(room.projectId) : undefined;
    await deps.publisher.publish(
      room.slug,
      buildRoomBoard(
        room,
        transcript,
        ledger,
        cachedMinds,
        projectName ?? room.projectId,
        cachedExhibits.get(room.slug) ?? [],
      ),
    );
  }

  async function persistAndPublish(room: Room): Promise<void> {
    await deps.store.saveRoom(room);
    await publishBoard(room);
  }

  // Re-publish a room's board after its exhibits changed. Deliberately does NOT save:
  // generation gating owns every room write, and a provenance stamp is not room state.
  // The room is re-read inside the lock so a publish racing a turn's commit renders the
  // committed room, not a stale copy.
  async function republish(slug: MindSlug): Promise<void> {
    if (disposed) return;
    const exhibits = await deps.exhibits?.(slug);
    if (!exhibits) return;
    cachedExhibits.set(slug, exhibits);
    await withLock(slug, async () => {
      if (disposed) return;
      const room = await deps.store.loadRoom(slug);
      if (room) await publishBoard(room);
    });
  }

  // Commit a still-active room, unless a newer generation has superseded this op.
  // Returns whether the room remains active (false when superseded — the caller
  // should stop driving).
  async function commitActive(slug: MindSlug, gen: number, room: Room): Promise<boolean> {
    if (generationOf(slug) !== gen) return false;
    await persistAndPublish(room);
    return true;
  }

  // Signal a room's close to the rib (the reflection pass), once, fire-and-forget.
  // Reads the final transcript from disk (the source of truth — the in-memory cache
  // may already be released) and hands it over. Never awaited and never throws into
  // the caller, so a close is never delayed or failed by reflection.
  function notifyClosed(room: Room): void {
    if (!deps.onRoomClosed || notifiedClosed.has(room.slug)) return;
    notifiedClosed.add(room.slug);
    const onClosed = deps.onRoomClosed;
    void deps.store
      .loadTranscript(room.slug)
      .then((transcript) => onClosed(room, transcript))
      .catch(() => {});
  }

  // Commit a room leaving the active state (done/stopped). Bumps the generation so
  // any other in-flight op on this room becomes stale and skips its own write,
  // then releases the in-memory transcript. Always returns false (not active).
  async function commitTerminal(slug: MindSlug, gen: number, room: Room): Promise<boolean> {
    if (generationOf(slug) !== gen) return false;
    bumpGeneration(slug);
    clearActive(slug);
    await persistAndPublish(room);
    releaseSlugState(slug);
    // The room is now persisted closed — let the rib reflect on it (gated, off the
    // hot path). Fire-and-forget: a close never waits on or fails from reflection.
    notifyClosed(room);
    return false;
  }

  function isValidNominee(slug: MindSlug, room: Room): boolean {
    return slug !== "director" && slug !== "system" && room.participants.includes(slug);
  }

  async function start(config: RoomStartConfig): Promise<Room> {
    // Reject a strategy the registry cannot execute before reserving — otherwise
    // the room would reserve a slot with no way for step() to advance it. Runs
    // before the reservation so a bad strategy leaks no slot.
    getStrategy(config.strategy);

    // Reserve THIS slug's slot. Rooms run concurrently — each on its own per-slug
    // key — and a fresh slug per start (the rib mints freshRoomSlug) means two starts
    // never contend for one slot. `claimed` records whether this call added the slug,
    // so a failed start below unreserves only what it added (a resume that found the
    // slug already active must not unreserve it).
    const claimed = !activeRooms.has(config.slug);
    activeRooms.add(config.slug);

    try {
      const existing = await deps.store.loadRoom(config.slug);

      if (existing && existing.status === "active") {
        // Resume an already-active room — do NOT bump the generation, so an
        // in-flight turn keeps its lifetime and still commits normally. Do NOT
        // re-seed the transcript cache over an existing array either: the driver
        // is the sole transcript writer, so the in-memory copy is already
        // authoritative, and replacing it here would race a same-generation
        // in-flight append (disk gets the entry, this re-seed re-reads it, then
        // the append's cache push double-counts it). Seed only when there is no
        // cache yet — e.g. a resume after a process restart, where no in-flight
        // turn can race it.
        if (!transcripts.has(config.slug)) {
          transcripts.set(config.slug, [...(await deps.store.loadTranscript(config.slug))]);
        }
        await persistAndPublish(existing);
        return existing;
      }

      // A fresh start, or a restart of a closed (stopped/done) room, opens a NEW
      // generation — a brand-new room that does NOT inherit the prior generation's
      // persisted transcript or turnIndex. The driver requires a unique slug per
      // generation (the rib mints freshRoomSlug() per start), so in the live rib a
      // new slug has no transcript on disk and this seeds []. The empty seed also
      // closes a slug-reuse hole: the append-only transcript.jsonl can hold a
      // superseded generation's entry — a stopped in-flight turn that drained to
      // disk before this start — and loading from it would pull that stale turn
      // into the new room's board/prompt. The push-side generation gate only
      // guards a stale append landing AFTER this seed; seeding empty (not from
      // disk) guards one that landed BEFORE. (Full slug-reuse soundness across a
      // process restart would need per-generation entry tagging; the unique-slug
      // invariant makes that moot.)
      bumpGeneration(config.slug);
      transcripts.set(config.slug, []);
      const room: Room = {
        slug: config.slug,
        name: config.name,
        strategy: config.strategy,
        participants: config.participants,
        status: "active",
        turnBudget: config.turnBudget,
        turnIndex: 0,
        round: 0,
        ...(config.topic ? { topic: config.topic } : {}),
        ...(config.grounding ? { grounding: config.grounding } : {}),
        ...(config.config ? { config: config.config } : {}),
        ...(config.projectId ? { projectId: config.projectId } : {}),
        ...(config.coding ? { coding: config.coding } : {}),
        createdAt: now().toISOString(),
      };
      await persistAndPublish(room);
      return room;
    } catch (e) {
      // Release the slot we just claimed so a failed start doesn't wedge the
      // driver (only if we claimed it — a failed resume must not unreserve the
      // still-active room).
      if (claimed) activeRooms.delete(config.slug);
      throw e;
    }
  }

  async function step(slug: MindSlug): Promise<StepOutcome> {
    // Serial gate. The check-and-add is synchronous (no await between), so a
    // second concurrent step while a turn is in flight is a no-op rather than
    // racing the first — preventing duplicate entries / a lost budget tick. It
    // reports "busy" (not "ended") so a second caller can retry instead of
    // mistaking a transient in-flight turn for a closed room.
    if (inFlight.has(slug)) return "busy";
    inFlight.add(slug);
    // Allocate the turn's AbortController up front (before any await) so a stop /
    // dispose during the pre-turn async gap aborts the same controller the turn
    // will observe — not a throwaway that gets replaced after the gap.
    const controller = new AbortController();
    controllers.set(slug, controller);
    // Capture the generation before any await so a stop/restart during loadRoom
    // can't make this step adopt the new lifetime — it abandons below instead.
    const gen = generationOf(slug);
    try {
      const loaded = await deps.store.loadRoom(slug);
      if (loaded?.status !== "active") return "ended";
      if (generationOf(slug) !== gen) return "ended"; // superseded during load — abandon

      // (1) consume one-shot director overrides (read + clear). Persist the clear
      // before the turn so an inject arriving mid-turn writes fresh pending that
      // the completion below preserves rather than clobbers.
      const pending = loaded.pending ?? {};
      const override = {
        nextSpeaker: pending.nextSpeaker,
        directionInjection: pending.directionInjection,
      };
      const room: Room = { ...loaded, pending: undefined };
      if (loaded.pending) {
        // Clear the consumed override under the lock + a generation recheck so a
        // stop racing this write can't be reverted: a stale active save landing
        // after stop's stopped write would otherwise reactivate the room and let
        // the auto loop keep issuing turns.
        await withLock(slug, async () => {
          if (generationOf(slug) !== gen) return; // stop/restart superseded — don't rewrite
          await deps.store.saveRoom(room);
        });
      }

      // (2) decide: a valid nextSpeaker override wins; otherwise the strategy picks
      // over the room and the transcript (the round cursor is room.round). magentic is
      // exempt — its turns are routed by the manager's ledger, so a director "call on
      // <worker>" must not force an off-plan speak turn (the chat tool rejects it too;
      // this is the shared-path guard against a stale board action or a raw API inject).
      let decision: StrategyStep;
      if (
        room.strategy !== "magentic" &&
        override.nextSpeaker !== undefined &&
        isValidNominee(override.nextSpeaker, room)
      ) {
        decision = { kind: "speak", mind: override.nextSpeaker };
      } else {
        const transcript = await loadCachedTranscript(slug);
        // open-floor's routing (end-vote close + peer nomination) is driver-side
        // parsing, so it goes through decideOpenFloor rather than the pure strategy.
        // magentic decides over the task ledger too, so it is loaded and passed in.
        if (room.strategy === "open-floor") {
          decision = decideOpenFloor(room, transcript);
        } else if (room.strategy === "magentic") {
          const ledger = await deps.store.loadLedger(slug);
          decision = magentic({ room, transcript, ledger });
        } else {
          decision = getStrategy(room.strategy)({ room, transcript });
        }
      }

      // (3) execute. commitTerminal / runSpeakTurn report "is the room still
      // active" as a boolean; map that to the StepOutcome the loop drives on.
      if (decision.kind === "end") {
        // A grounded design-bearing room routes even a natural close (an open-floor
        // end-vote, a magentic ledger completing before budget) through the fidelity +
        // synthesis path, so its criteria are checked and folded into a closing document
        // however the room reaches its end. Ungrounded rooms and review end directly.
        const groundedSynth = groundedCloseSynthesizer(room, await loadCachedTranscript(slug));
        if (groundedSynth) {
          const active = await runCloseSynthesis(room, controller, gen, groundedSynth);
          return active ? "advanced" : "ended";
        }
        await commitTerminal(slug, gen, { ...room, status: "done" });
        return "ended";
      }
      if (decision.kind === "speak") {
        const active = await runSpeakTurn(
          room,
          decision.mind,
          override.directionInjection,
          controller,
          gen,
        );
        return active ? "advanced" : "ended";
      }
      if (decision.kind === "moderate") {
        const active = await runModerateTurn(
          room,
          decision.mind,
          override.directionInjection,
          controller,
          gen,
        );
        return active ? "advanced" : "ended";
      }
      if (decision.kind === "speak-parallel") {
        const active = await runParallelTurn(
          room,
          decision.minds,
          override.directionInjection,
          controller,
          gen,
        );
        return active ? "advanced" : "ended";
      }
      if (decision.kind === "manage") {
        const active = await runManageTurn(
          room,
          decision.mind,
          override.directionInjection,
          controller,
          gen,
        );
        return active ? "advanced" : "ended";
      }
      if (decision.kind === "assign") {
        const active = await runAssignTurn(
          room,
          decision.mind,
          decision.taskId,
          override.directionInjection,
          controller,
          gen,
        );
        return active ? "advanced" : "ended";
      }
      if (decision.kind === "synthesize") {
        const active = await runCloseSynthesis(room, controller, gen, decision.mind);
        return active ? "advanced" : "ended";
      }
      throw new Error("step kind is not supported yet");
    } finally {
      controllers.delete(slug);
      inFlight.delete(slug);
      releaseSlugState(slug);
    }
  }

  // Resolve a Mind by slug; on a roster miss fail the room closed (a system note
  // + done) and return undefined so the caller bails. Shared by the speaker, the
  // moderator, and the synthesizer so an unknown configured Mind never hangs the
  // room. Note `room.turnIndex` stamps the system entry — a fail-closed step does
  // not advance the counter.
  async function resolveMindOrFailClosed(
    room: Room,
    mindSlug: MindSlug,
    gen: number,
    roster?: readonly Mind[],
  ): Promise<Mind | undefined> {
    const minds = roster ?? (await fetchMinds());
    const mind = minds.find((m) => m.slug === mindSlug);
    if (mind) return mind;
    await appendEntry(
      room.slug,
      gen,
      buildTurnEntry({
        roomSlug: room.slug,
        turnIndex: room.turnIndex,
        from: "system",
        role: "system",
        text: `unknown mind "${mindSlug}"`,
        messageId: newId(),
        at: now().toISOString(),
      }),
    );
    await withLock(room.slug, () => commitTerminal(room.slug, gen, { ...room, status: "done" }));
    return undefined;
  }

  // The room's targeted project root, or undefined when there is no target, the host
  // no longer knows it (deleted mid-room), or its rootPath is empty/whitespace
  // (rootPath is `z.string()`, no min length). Resolved per turn so the projects store
  // stays the single source of truth. This IS the read grant + confinement boundary.
  function roomProjectRoot(room: Room): string | undefined {
    if (!room.projectId) return undefined;
    return deps.resolveProjectRoot?.(room.projectId)?.trim() || undefined;
  }

  // Resolve a turn's cwd. A project-targeted room runs at the project root
  // (path-as-context, as chat/workflows do); otherwise it keeps the neutral turnCwd,
  // so a turn never falls through to the seam's process-tmpdir default.
  function turnCwdFor(room: Room): string | undefined {
    return roomProjectRoot(room) ?? deps.turnCwd;
  }

  // Prompt context for a project-targeted room: names the project (and root) so the
  // discussion is grounded in a real repo, and — when the read tier is available —
  // tells speakers to read it rather than reason from assumptions. Undefined when no
  // project resolves, so a non-project room's prompt is unchanged.
  function projectContextFor(room: Room): string | undefined {
    const root = roomProjectRoot(room);
    if (!root) return undefined;
    const name = room.projectId ? deps.resolveProjectName?.(room.projectId)?.trim() : undefined;
    const label = name ? `"${name}" (${root})` : root;
    const readLine = deps.readTools?.length
      ? " Ground your points in that actual project — use the Read tool to inspect its files (README, source, config) rather than reasoning from assumptions."
      : "";
    return `This room is about the project ${label}.${readLine}`;
  }

  // Run one agent turn and return its reply text + aborted flag, or "disposed" if
  // the rib was torn down mid-turn (the caller drops a disposed turn without
  // committing). The prompt is built by the caller — the speaker, moderator, and
  // synthesizer differ only in their prompt — so this owns just the abort check
  // (before AND after the SOUL read), the stream drain, and result extraction.
  async function runOneTurn(
    room: Room,
    mind: Mind,
    prompt: string,
    controller: AbortController,
  ): Promise<
    { text: string; aborted: boolean; errored: boolean; usage?: TokenUsage } | "disposed"
  > {
    let text: string;
    let aborted: boolean;
    // Whether the turn errored or timed out (distinct from an operator abort). The
    // magentic assign path reads it to mark a task failed vs completed; the other
    // callers ignore it (an errored turn already surfaces via its error text).
    let errored = false;
    let usage: TokenUsage | undefined;
    // The composed identity (authored soul + the Mind's durable memory & rules) is
    // the turn's system prompt; fall back to the roster tagline when a Mind has no
    // composer or no readable soul so the turn still runs in character. Skip the
    // (async, file-backed) read entirely if a stop/dispose already landed.
    const system = controller.signal.aborted
      ? mind.persona
      : (await deps.composeTurnSystem?.(mind))?.trim() || mind.persona;
    // Re-check AFTER the SOUL read: a stop/dispose can land before OR during it, and
    // a turn must not be invoked with an already-aborted signal — in a concurrent
    // round that would fan out N wasted agent calls. Finalize as aborted instead, so
    // no normal reply is appended after a stop.
    if (controller.signal.aborted) {
      text = "";
      aborted = true;
    } else {
      const cwd = turnCwdFor(room);
      const projectRoot = roomProjectRoot(room);
      // Granting coding tools and confining the turn are one decision: the coding
      // pool is offered only when there is a real cwd to bound it to (project root,
      // or the neutral home if the project vanished), so a coding turn never runs
      // unconfined. The host enforces the boundary off allowedDirectories. The cwd
      // truthiness check is load-bearing: an empty root would confine to nothing.
      const coding = Boolean(room.coding) && Boolean(cwd);
      // The read tier: a room that targets a resolvable project grants Read to EVERY
      // speaker, confined to the project root — no per-Mind `read` needed and no coding
      // tier — so a Discussion can read the repo it's about. Distinct from coding: read
      // is confined to the project root only (never the neutral-home fallback), since
      // there's nothing safe to read outside the targeted project.
      const readGrant = Boolean(projectRoot) && Boolean(deps.readTools?.length);
      const confineRoot = coding ? cwd : readGrant ? projectRoot : undefined;
      const pool =
        coding && deps.codingTools?.length
          ? [...(deps.turnTools ?? []), ...deps.codingTools]
          : deps.turnTools;
      // A speaker's declared capability slugs (mind.tools) map onto the turn's
      // tool rail, intersected with the room-safe pool; no declaration stays
      // text-only. The Mind's model/provider pin is honoured (provider alongside
      // model so a cross-provider pin resolves coherently here, the same as a
      // direct /mind chat — not just against the default provider).
      const declared = resolveMindTools(mind, pool);
      // Layer the room-level read grant on top, deduped — a code-declaring Mind in a
      // coding room already carries Read, so this only adds it for those that don't.
      const tools = readGrant
        ? [
            ...declared,
            ...(deps.readTools ?? []).filter((t) => !declared.some((d) => d.name === t.name)),
          ]
        : declared;
      const turn = deps.runAgentTurn({
        system,
        prompt,
        abortSignal: controller.signal,
        ...(cwd ? { cwd } : {}),
        ...(tools.length > 0 ? { tools } : {}),
        ...(confineRoot ? { allowedDirectories: [confineRoot] } : {}),
        ...(mind.model ? { model: mind.model } : {}),
        ...(mind.provider ? { provider: mind.provider } : {}),
      });
      // The drain doubles as the exhibit witness: a tool_use chunk naming the
      // table-exhibit seam proves THIS room's turn tabled that id, so the rib can
      // stamp sourceRoom without trusting the agent to name its own room.
      const tabledIds: string[] = [];
      try {
        // Draining the stream could drive throttled partial publishes later; for
        // now the result is the source of truth.
        for await (const chunk of turn.stream) {
          if (chunk.type !== "tool_use" || chunk.toolName !== EXHIBIT_TOOL_NAME) continue;
          const rawId = chunk.toolInput?.id;
          if (typeof rawId === "string" && rawId.length > 0) tabledIds.push(rawId);
        }
      } catch {
        // a stream error surfaces via result.status below
      }
      const result = await turn.result;
      // Stamp even on an aborted/errored result: the tool already ran server-side
      // when its tool_use chunk streamed, so the record exists either way (the
      // stamp itself load-checks and skips a record the emit never persisted).
      if (tabledIds.length > 0) deps.onExhibitsTabled?.(tabledIds, room);
      aborted = result.status === "aborted" || controller.signal.aborted;
      errored = result.status === "error" || result.status === "timeout";
      text =
        result.status === "error" || result.status === "timeout"
          ? (result.error ?? result.text ?? `turn ${result.status}`)
          : result.text;
      usage = result.usage;
    }
    // Shutdown landed during the (uncancellable) turn — drop the late result so
    // nothing is appended or published after the rib is disposed.
    if (disposed) return "disposed";
    return { text, aborted, errored, ...(usage ? { usage } : {}) };
  }

  // Build an agent-authored transcript entry (a Mind's turn) with driver-stamped
  // id/time. Shared by the single-speaker, synthesis, and concurrent-batch commits
  // so the agent-entry shape lives in one place. `round` is the cursor the turn was
  // authored in (room.round at turn start); the room advances its own round from the
  // post-append transcript.
  function buildAgentEntry(
    roomSlug: MindSlug,
    turnIndex: number,
    fromSlug: MindSlug,
    reply: { text: string; aborted: boolean; usage?: TokenUsage },
    round: number,
  ): TurnEntry {
    return buildTurnEntry({
      roomSlug,
      turnIndex,
      from: fromSlug,
      role: "agent",
      text: reply.text,
      aborted: reply.aborted,
      round,
      messageId: newId(),
      at: now().toISOString(),
      ...(reply.usage ? { usage: reply.usage } : {}),
    });
  }

  // The room's round after the current turn was appended: roundOf folded over the
  // post-append transcript (appendEntry has already pushed the entry into the cache).
  // Shared by the commit points so room.round is recomputed the same way at each.
  async function roundAfter(slug: MindSlug, current: Room): Promise<number> {
    return roundOf(current.participants, await loadCachedTranscript(slug));
  }

  // Append a finished agent turn and advance the room under the write lock: an
  // aborted turn -> stopped; a budget hit stays active just long enough for the
  // strategy's closing synthesis decision.
  // Returns whether the room remains active (false when superseded/closed). The
  // entry is stamped with `room.turnIndex` (the snapshot handed in) while the room
  // advances from the re-loaded current, so a director inject racing the commit is
  // preserved — the existing single-turn discipline, now shared by moderate steps.
  async function commitTurn(
    room: Room,
    mind: Mind,
    text: string,
    aborted: boolean,
    gen: number,
    usage?: TokenUsage,
  ): Promise<boolean> {
    await appendEntry(
      room.slug,
      gen,
      buildAgentEntry(room.slug, room.turnIndex, mind.slug, { text, aborted, usage }, room.round),
    );
    return await withLock(room.slug, async () => {
      const current = (await deps.store.loadRoom(room.slug)) ?? room;
      const advanced: Room = {
        ...current,
        turnIndex: current.turnIndex + 1,
        round: await roundAfter(room.slug, current),
      };
      if (aborted) {
        return await commitTerminal(room.slug, gen, { ...advanced, status: "stopped" });
      }
      return await commitActive(room.slug, gen, advanced);
    });
  }

  // The speaker prompt for a `speak` step. open-floor speakers get the
  // nominate/pass/end vocabulary (they route the room themselves); every other
  // strategy — sequential, concurrent, a group-chat-routed speaker, a director
  // override — gets the plain turn prompt.
  function composeSpeakPrompt(
    room: Room,
    transcript: readonly TurnEntry[],
    directionInjection: string | undefined,
    speaker?: MindSlug,
  ): string {
    if (room.strategy === "open-floor") {
      return buildOpenFloorPrompt({
        ...(room.topic ? { topic: room.topic } : {}),
        ...(room.grounding ? { grounding: room.grounding } : {}),
        transcript,
        participants: room.participants,
        ...(directionInjection ? { directionInjection } : {}),
      });
    }
    // The reviewer (participants[1]) judges the author's artifact alone — the
    // author's last turn — not the windowed transcript, so the handoff stays
    // artifact-only and cross-vendor. The author (participants[0]) gets the plain
    // turn prompt, framed by the topic-as-contract.
    if (room.strategy === "review" && speaker !== undefined && speaker === room.participants[1]) {
      const authorSlug = room.participants[0];
      const authorEntry = [...transcript]
        .reverse()
        .find((e) => e.role === "agent" && e.from === authorSlug);
      const artifact = authorEntry?.parts.map((p) => p.text).join("\n") ?? "";
      return buildReviewPrompt({
        ...(room.topic ? { contract: room.topic } : {}),
        ...(room.grounding ? { grounding: room.grounding } : {}),
        artifact,
        ...(authorSlug ? { author: authorSlug } : {}),
        ...(directionInjection ? { directionInjection } : {}),
        ...(room.coding ? { coding: true } : {}),
      });
    }
    const projectContext = projectContextFor(room);
    return buildTurnPrompt({
      ...(room.topic ? { topic: room.topic } : {}),
      ...(room.grounding ? { grounding: room.grounding } : {}),
      ...(projectContext ? { projectContext } : {}),
      transcript,
      ...(directionInjection ? { directionInjection } : {}),
    });
  }

  async function runSpeakTurn(
    room: Room,
    mindSlug: MindSlug,
    directionInjection: string | undefined,
    controller: AbortController,
    gen: number,
  ): Promise<boolean> {
    const mind = await resolveMindOrFailClosed(room, mindSlug, gen);
    if (!mind) return false;
    const prompt = composeSpeakPrompt(
      room,
      await loadCachedTranscript(room.slug),
      directionInjection,
      mindSlug,
    );
    const turn = await runOneTurn(room, mind, prompt, controller);
    if (turn === "disposed") return false;
    const active = await commitTurn(room, mind, turn.text, turn.aborted, gen, turn.usage);
    if (!active) return false;
    return (await runBudgetSynthesisIfExhausted(room.slug, controller, gen)) ?? true;
  }

  // A concurrent round: run the round's speakers at once — each prompted from the
  // SAME pre-round transcript (so they don't hear each other) and sharing the one
  // per-room AbortController (so a stop aborts the whole round) — then append their
  // replies in participant order under ONE lock, advancing turnIndex past the batch
  // with a single publish. A pre-spawn budget gate trims the batch to the
  // remaining budget so a round never overshoots turnBudget. Mirrors commitTurn's
  // discipline batched: the disk append is unconditional, the cache push and the
  // room-state commit are generation-gated — so a stop racing the commit drops the
  // whole batch, and the append-only disk entries stay contained by fresh slugs.
  async function runParallelTurn(
    room: Room,
    mindSlugs: readonly MindSlug[],
    directionInjection: string | undefined,
    controller: AbortController,
    gen: number,
  ): Promise<boolean> {
    // Pre-spawn budget gate: trim to the remaining budget so the batch can't
    // advance turnIndex past turnBudget. The strategy only emits speak-parallel
    // while turnIndex < turnBudget (remaining >= 1); the guard closes cleanly in
    // the degenerate case rather than spawning an empty round.
    const remaining = room.turnBudget - room.turnIndex;
    const slugs = remaining > 0 ? mindSlugs.slice(0, remaining) : [];
    if (slugs.length === 0) {
      return await withLock(room.slug, () =>
        commitTerminal(room.slug, gen, { ...room, status: "done" }),
      );
    }
    // Resolve every speaker up front against ONE roster read; an unknown one fails
    // the whole room closed (the single-speaker discipline) rather than running a
    // partial round.
    const roster = await fetchMinds();
    const minds: Mind[] = [];
    for (const slug of slugs) {
      const mind = await resolveMindOrFailClosed(room, slug, gen, roster);
      if (!mind) return false; // resolveMindOrFailClosed already closed the room
      minds.push(mind);
    }
    // All speakers share the pre-round transcript and one director steer (if any).
    const prompt = composeSpeakPrompt(
      room,
      await loadCachedTranscript(room.slug),
      directionInjection,
    );
    const turns = minds.map((m) => runOneTurn(room, m, prompt, controller));
    let results: ({ text: string; aborted: boolean; usage?: TokenUsage } | "disposed")[];
    try {
      results = await Promise.all(turns);
    } catch (err) {
      // A turn threw (a readSoul / turn-seam failure, not a status the result maps).
      // Promise.all short-circuits on the first rejection, leaving the sibling turns
      // in flight — abort the shared controller to cancel them and await all settle
      // so none is orphaned once step() drops the controller, then propagate. The
      // auto-loop force-stops the room, exactly as it would for a single thrown turn.
      controller.abort();
      await Promise.allSettled(turns);
      throw err;
    }
    if (results.some((r) => r === "disposed")) return false; // torn down mid-round
    const replies = results as { text: string; aborted: boolean; usage?: TokenUsage }[];

    // One lock for the whole batch: append every reply in participant order, indices
    // running from the re-loaded current.turnIndex; the room then advances to that
    // same running index, so the entry count and the advance share one source (no
    // separate +N that could drift from what was actually appended). Commit once.
    // An aborted reply (a stop landed mid-round) stops the room; reaching the budget
    // hands off to one closing synthesis turn.
    const active = await withLock(room.slug, async () => {
      const current = (await deps.store.loadRoom(room.slug)) ?? room;
      let nextIdx = current.turnIndex;
      let anyAborted = false;
      // One shared round for the whole parallel batch — every speaker spoke in the
      // same round, before any of them advanced the cursor.
      for (let k = 0; k < minds.length; k++) {
        const reply = replies[k];
        const mind = minds[k];
        if (!reply || !mind) continue;
        if (reply.aborted) anyAborted = true;
        await appendEntry(
          room.slug,
          gen,
          buildAgentEntry(room.slug, nextIdx++, mind.slug, reply, current.round),
        );
      }
      const advanced: Room = {
        ...current,
        turnIndex: nextIdx,
        round: await roundAfter(room.slug, current),
      };
      if (anyAborted) {
        return await commitTerminal(room.slug, gen, { ...advanced, status: "stopped" });
      }
      return await commitActive(room.slug, gen, advanced);
    });
    if (!active) return false;
    return (await runBudgetSynthesisIfExhausted(room.slug, controller, gen)) ?? true;
  }

  // A group-chat moderate step: run the moderator, then route on its reply. Up to
  // two turns under one step() (the serial gate + the shared controller/gen cover
  // both). The moderator commits first (so the speaker is prompted from a
  // transcript that already holds its direction); if the moderator's tick reaches
  // turnBudget, routing stops and the fallback synthesis closes the room.
  async function runModerateTurn(
    room: Room,
    moderatorSlug: MindSlug,
    directionInjection: string | undefined,
    controller: AbortController,
    gen: number,
  ): Promise<boolean> {
    const moderator = await resolveMindOrFailClosed(room, moderatorSlug, gen);
    if (!moderator) return false;
    const modPrompt = buildModeratorPrompt({
      ...(room.topic ? { topic: room.topic } : {}),
      ...(room.grounding ? { grounding: room.grounding } : {}),
      transcript: await loadCachedTranscript(room.slug),
      participants: room.participants,
      // A director steer is guidance for the routing decision, so it goes to the
      // moderator (who decides who speaks), not directly to a speaker.
      ...(directionInjection ? { directionInjection } : {}),
    });
    const modTurn = await runOneTurn(room, moderator, modPrompt, controller);
    if (modTurn === "disposed") return false;
    const modActive = await commitTurn(
      room,
      moderator,
      modTurn.text,
      modTurn.aborted,
      gen,
      modTurn.usage,
    );
    if (!modActive) return false; // aborted/stopped or superseded

    // Re-load so the speaker/synthesis turn advances from the moderator's commit,
    // not the pre-moderator snapshot — its entry index must follow the moderator's.
    const afterMod = await deps.store.loadRoom(room.slug);
    if (afterMod?.status !== "active" || generationOf(room.slug) !== gen) return false;
    if (afterMod.turnIndex >= afterMod.turnBudget) {
      return (await runBudgetSynthesisIfExhausted(room.slug, controller, gen)) ?? true;
    }

    const decision = parseModeratorDecision(modTurn.text);
    const postMod = await loadCachedTranscript(room.slug);
    const counts = speakerCounts(postMod);
    const minRounds = afterMod.config?.minRounds ?? DEFAULT_MIN_ROUNDS;

    if (decision?.action === "close" && allHeardInCycle(afterMod.participants, counts, minRounds)) {
      // A grounded Debate closes through fidelity + synthesis too, with the moderator as
      // the fallback synthesizer (the Convene Debate form configures none). An ungrounded
      // close passes no fallback, so it ends without an extra turn, exactly as before.
      return await runCloseSynthesis(
        afterMod,
        controller,
        gen,
        groundedCloseSynthesizer(afterMod, postMod),
      );
    }

    const speaker = pickGroupChatSpeaker(decision, afterMod, counts);
    if (!speaker) {
      // No resolvable participant to route to — close cleanly rather than hang.
      return await withLock(room.slug, () =>
        commitTerminal(room.slug, gen, { ...afterMod, status: "done" }),
      );
    }
    const speakerMind = await resolveMindOrFailClosed(afterMod, speaker, gen);
    if (!speakerMind) return false;
    // If a stop superseded the step BEFORE the speaker turn starts (e.g. during the
    // moderator-to-speaker gap), skip it: appending an entry for a turn that never
    // ran would leave a phantom on disk after a real moderator turn. A stop DURING
    // the speaker turn falls through to commitTurn, which records the aborted entry
    // exactly like the single-speaker path.
    if (controller.signal.aborted || generationOf(room.slug) !== gen) return false;
    const spkPrompt = buildTurnPrompt({
      ...(afterMod.topic ? { topic: afterMod.topic } : {}),
      ...(afterMod.grounding ? { grounding: afterMod.grounding } : {}),
      transcript: postMod,
      // The moderator's `direction` is guidance for the Mind it nominated, so
      // surface it only when that nominee actually got the turn — a cap-redirect or
      // fallback routes to someone else, for whom the steer was not written.
      ...(decision?.direction && speaker === decision.nextSpeaker
        ? { directionInjection: decision.direction }
        : {}),
    });
    const spkTurn = await runOneTurn(room, speakerMind, spkPrompt, controller);
    if (spkTurn === "disposed") return false;
    const active = await commitTurn(
      afterMod,
      speakerMind,
      spkTurn.text,
      spkTurn.aborted,
      gen,
      spkTurn.usage,
    );
    if (!active) return false;
    return (await runBudgetSynthesisIfExhausted(room.slug, controller, gen)) ?? true;
  }

  // The driver's speaker pick for a moderate step: the moderator's validated
  // nominee under the anti-monopoly cap, else the least-spoken OTHER participant;
  // an invalid/missing nominee falls back to nextUnheard. Never throws — routing
  // always degrades to a deterministic pick.
  function pickGroupChatSpeaker(
    decision: ModeratorDecision | null,
    room: Room,
    counts: Map<MindSlug, number>,
  ): MindSlug | undefined {
    const cap = room.config?.maxSpeakerRepeats ?? DEFAULT_MAX_SPEAKER_REPEATS;
    const nominee = decision?.nextSpeaker;
    if (nominee && isValidNominee(nominee, room) && (counts.get(nominee) ?? 0) < cap) {
      return nominee;
    }
    // No usable nominee (missing / unparseable / invalid / over the cap): the
    // least-spoken participant, over ALL participants. leastSpoken prefers an
    // unheard participant and otherwise rotates by count, so neither a malformed
    // moderator nor a fixated one can monopolize — and it won't hand every redirect
    // to a single "other" Mind (which excluding the nominee would, in a 2-Mind
    // room). The nominee is re-picked only when it is itself the least-spoken, i.e.
    // balanced rotation, not a monopoly.
    return leastSpoken(room.participants, counts) ?? room.participants[0];
  }

  // The driver's routing for an open-floor (unmoderated) step, computed from the
  // prior transcript before the turn runs. Honors the same purity split as
  // group-chat — the strategy never parses; all text parsing (the end-vote, the
  // peer nomination) lives here. Precedence below the director override (tier 1,
  // handled in step()): end-vote close > a valid peer nomination (tier 2) > the
  // pure strategy's seed/leastSpoken fallback (tier 3). Never throws.
  function decideOpenFloor(room: Room, transcript: readonly TurnEntry[]): StrategyStep {
    const counts = speakerCounts(transcript);
    const minRounds = room.config?.minRounds ?? DEFAULT_MIN_ROUNDS;
    const threshold = room.config?.endVoteThreshold ?? DEFAULT_END_VOTE_THRESHOLD;
    // Close gate: every participant has spoken its floor AND more than the
    // threshold fraction currently votes to end (STRICT `>`). Checked before
    // routing so a quorum-end wins even over a pending nomination.
    if (
      allHeardInCycle(room.participants, counts, minRounds) &&
      endVoteRatio(transcript, room.participants) > threshold
    ) {
      return { kind: "end" };
    }
    // Tier 2: the last speaker's nomination, if it names a valid OTHER participant
    // under the anti-monopoly cap. Self-nominations and over-cap picks fall through.
    const lastAgent = [...transcript].reverse().find((e) => e.role === "agent");
    if (lastAgent) {
      const nom = parseNomination(lastAgent.parts.map((p) => p.text).join("\n"));
      if (nom?.action === "nominate" && nom.slug) {
        const cap = room.config?.maxSpeakerRepeats ?? DEFAULT_MAX_SPEAKER_REPEATS;
        if (
          isValidNominee(nom.slug, room) &&
          nom.slug !== lastAgent.from &&
          (counts.get(nom.slug) ?? 0) < cap
        ) {
          return { kind: "speak", mind: nom.slug };
        }
      }
    }
    // Tier 3: the pure strategy seeds the first speaker / rotates by leastSpoken.
    return openFloor({ room, transcript });
  }

  async function runBudgetSynthesisIfExhausted(
    slug: MindSlug,
    controller: AbortController,
    gen: number,
  ): Promise<boolean | undefined> {
    const room = await deps.store.loadRoom(slug);
    if (room?.status !== "active" || generationOf(slug) !== gen) return false;
    if (room.turnIndex < room.turnBudget) return undefined;
    const transcript = await loadCachedTranscript(slug);
    const decision =
      room.strategy === "magentic"
        ? magentic({ room, transcript, ledger: await deps.store.loadLedger(slug) })
        : getStrategy(room.strategy)({ room, transcript });
    if (decision.kind === "synthesize") {
      return await runCloseSynthesis(room, controller, gen, decision.mind);
    }
    return await withLock(slug, () => commitTerminal(slug, gen, { ...room, status: "done" }));
  }

  // The pre-close fidelity check. When the room carries grounding criteria, an
  // independent cross-vendor Mind (pickFidelityChecker) diffs the emerging outcome
  // against them and its reply is appended before synthesis — so the synthesizer can
  // fold the divergences in and the operator can read the check in the transcript.
  // Best-effort: a room without grounding, or one with no eligible checker, runs no
  // turn (turns: 0) — the close is byte-for-byte unchanged. An operator stop DURING the
  // check is recorded and closes the room without a synthesis turn (closed: true).
  async function runFidelityCheck(
    room: Room,
    synthSlug: MindSlug,
    roster: readonly Mind[],
    controller: AbortController,
    gen: number,
  ): Promise<"disposed" | { turns: number; closed: boolean; active: boolean; checked: boolean }> {
    const criteria = room.grounding?.criteria.filter((c) => c.trim().length > 0) ?? [];
    if (!room.grounding || criteria.length === 0)
      return { turns: 0, closed: false, active: true, checked: false };
    const checkerSlug = pickFidelityChecker(room, synthSlug, roster);
    const checker = checkerSlug ? roster.find((m) => m.slug === checkerSlug) : undefined;
    if (!checker) return { turns: 0, closed: false, active: true, checked: false };
    // Load the transcript, THEN re-check abort/generation immediately before the paid
    // turn (mirrors the synthesis guard) so a stop in the load gap skips the check rather
    // than appending an empty, never-run fidelity entry.
    const fidTranscript = await loadCachedTranscript(room.slug);
    if (controller.signal.aborted || generationOf(room.slug) !== gen)
      return { turns: 0, closed: false, active: true, checked: false };
    const prompt = buildFidelityPrompt({ grounding: room.grounding, transcript: fidTranscript });
    const turn = await runOneTurn(room, checker, prompt, controller);
    if (turn === "disposed") return "disposed";
    await appendEntry(
      room.slug,
      gen,
      buildAgentEntry(
        room.slug,
        room.turnIndex,
        checker.slug,
        { text: turn.text, aborted: turn.aborted, usage: turn.usage },
        room.round,
      ),
    );
    if (turn.aborted || generationOf(room.slug) !== gen) {
      const active = await withLock(room.slug, async () => {
        const current = (await deps.store.loadRoom(room.slug)) ?? room;
        return await commitTerminal(room.slug, gen, {
          ...current,
          turnIndex: current.turnIndex + 1,
          round: await roundAfter(room.slug, current),
          status: turn.aborted ? "stopped" : "done",
        });
      });
      return { turns: 1, closed: true, active, checked: false };
    }
    // Persist the completed fidelity turn (advance the cursor, keep the room active)
    // BEFORE the riskier synthesis turn — the speaker path commits each turn the same
    // way, so a synthesis failure can't drop this paid entry or leave turnIndex/round
    // stale from the pre-fidelity room.json.
    await withLock(room.slug, async () => {
      if (generationOf(room.slug) !== gen) return;
      const current = (await deps.store.loadRoom(room.slug)) ?? room;
      await commitActive(room.slug, gen, {
        ...current,
        turnIndex: current.turnIndex + 1,
        round: await roundAfter(room.slug, current),
      });
    });
    // `turns` counts the appended turn (cursor + billing); `checked` is whether it
    // produced real findings — an errored/timed-out OR empty check leaves no usable
    // findings in the transcript, so the synthesizer must NOT be told a valid check is
    // there to fold in.
    return {
      turns: 1,
      closed: false,
      active: true,
      checked: !turn.errored && turn.text.trim().length > 0,
    };
  }

  // The closing act: a configured synthesizer, or a strategy-chosen fallback,
  // authors one summary turn, then the room ends (done). Synthesis always closes —
  // even an errored turn — and a disposed turn drops cleanly. When the room carries
  // grounding criteria, one extra cross-vendor fidelity turn runs FIRST (see
  // runFidelityCheck) so the synthesizer can fold its divergences into the document.
  async function runCloseSynthesis(
    room: Room,
    controller: AbortController,
    gen: number,
    fallbackSynthSlug?: MindSlug,
  ): Promise<boolean> {
    const synthSlug = room.config?.synthesizer ?? fallbackSynthSlug;
    if (synthSlug) {
      const roster = await fetchMinds();
      const synth = await resolveMindOrFailClosed(room, synthSlug, gen, roster);
      if (synth) {
        // Skip only if a stop superseded before synthesis starts (no phantom entry
        // for a turn that never ran); a stop during it is recorded, as on the
        // speaker path.
        if (controller.signal.aborted || generationOf(room.slug) !== gen) return false;
        // The next turnIndex to assign: a grounded design-bearing close runs a
        // fidelity turn before synthesis, so the two entries take consecutive indices.
        const fidelity = await runFidelityCheck(room, synthSlug, roster, controller, gen);
        if (fidelity === "disposed") return false;
        // An operator stop landed during the check — it is recorded; close now without
        // burning a second paid turn on synthesis.
        if (fidelity.closed) return fidelity.active;
        const cursor = room.turnIndex + fidelity.turns;
        // Load the transcript, THEN re-check abort/generation immediately before the paid
        // turn — a stop landing in the fidelity or transcript-load gap must skip synthesis
        // rather than append a phantom, never-run entry. The stop path already closed.
        const synthTranscript = await loadCachedTranscript(room.slug);
        if (controller.signal.aborted || generationOf(room.slug) !== gen) return false;
        // Round at synthesis time, folded over the post-fidelity transcript: a fidelity
        // turn can complete an all-heard cycle, so the closing entry must not carry the
        // stale pre-fidelity round (the board groups the outcome by it).
        const synthRound = roundOf(room.participants, synthTranscript);
        const prompt = buildSynthesisPrompt({
          ...(room.topic ? { topic: room.topic } : {}),
          ...(room.grounding ? { grounding: room.grounding } : {}),
          fidelityChecked: fidelity.checked,
          transcript: synthTranscript,
        });
        const turn = await runOneTurn(room, synth, prompt, controller);
        if (turn === "disposed") return false;
        await appendEntry(
          room.slug,
          gen,
          buildAgentEntry(
            room.slug,
            cursor,
            synth.slug,
            { text: turn.text, aborted: turn.aborted, usage: turn.usage },
            synthRound,
          ),
        );
        return await withLock(room.slug, async () => {
          const current = (await deps.store.loadRoom(room.slug)) ?? room;
          // The fidelity turn (if any) already advanced the cursor via its own commit, so
          // the terminal commit adds only the synthesis turn.
          return await commitTerminal(room.slug, gen, {
            ...current,
            turnIndex: current.turnIndex + 1,
            round: await roundAfter(room.slug, current),
            status: "done",
          });
        });
      }
    }
    // No synthesizer configured/resolvable — just close.
    return await withLock(room.slug, () =>
      commitTerminal(room.slug, gen, { ...room, status: "done" }),
    );
  }

  // A magentic manage step: the manager (re)plans the task ledger. Recovers any task
  // left in-progress by a crash (the serial gate means none is live during a manage
  // turn), runs the manager turn, then applies its parsed plan/done directive to the
  // ledger — appending new tasks or closing the plan. One turn per step, like the
  // single-speaker path; the ledger is persisted alongside the room state under the
  // commit's write lock (commitLedgerTurn).
  async function runManageTurn(
    room: Room,
    managerSlug: MindSlug,
    directionInjection: string | undefined,
    controller: AbortController,
    gen: number,
  ): Promise<boolean> {
    const manager = await resolveMindOrFailClosed(room, managerSlug, gen);
    if (!manager) return false;
    const loaded =
      (await deps.store.loadLedger(room.slug)) ??
      freshLedger(room.slug, room.topic ?? "", managerSlug, now);
    const ledger = failStuckTasks(loaded, { now });
    const prompt = buildManagerPrompt({
      ...(room.topic ? { topic: room.topic } : {}),
      ...(room.grounding ? { grounding: room.grounding } : {}),
      ledger,
      transcript: await loadCachedTranscript(room.slug),
      workers: room.participants,
      ...(directionInjection ? { directionInjection } : {}),
    });
    const turn = await runOneTurn(room, manager, prompt, controller);
    if (turn === "disposed") return false;
    // An errored/timed-out manage turn produced no real plan — its text is an error
    // string, so parseMagenticPlan is null and applyManagerPlan would derive "done" on a
    // fresh/exhausted ledger, closing the room as a false success. Preserve the ledger
    // instead so the strategy retries the manager next step (bounded by turnBudget); only
    // a clean turn's directive advances the plan.
    const nextLedger = turn.errored
      ? ledger
      : applyManagerPlan(ledger, parseMagenticPlan(turn.text), room.participants, { now, newId });
    const active = await commitLedgerTurn(room, manager, turn, nextLedger, gen);
    if (!active) return false;
    return (await runBudgetSynthesisIfExhausted(room.slug, controller, gen)) ?? true;
  }

  // A magentic assign step: one worker executes one task. Marks the task in-progress
  // and publishes first (so the board shows the worker is on it before a possibly long
  // turn freezes it), runs the worker, then settles the task — completed, or failed if
  // the turn errored/timed out so the manager replans on its next turn. An operator
  // stop (aborted) closes the room in commitLedgerTurn, like every other turn.
  async function runAssignTurn(
    room: Room,
    workerSlug: MindSlug,
    taskId: string,
    directionInjection: string | undefined,
    controller: AbortController,
    gen: number,
  ): Promise<boolean> {
    const worker = await resolveMindOrFailClosed(room, workerSlug, gen);
    if (!worker) return false;
    const base =
      (await deps.store.loadLedger(room.slug)) ??
      freshLedger(room.slug, room.topic ?? "", room.config?.manager ?? workerSlug, now);
    const task = base.tasks.find((t) => t.id === taskId);
    // Mark in-progress and publish the board (room state unchanged, so turnIndex does
    // not advance). Generation-gated like every room write — a stop racing it skips.
    const inProgress = setTaskStatus(base, taskId, "in-progress", { now });
    await withLock(room.slug, async () => {
      if (generationOf(room.slug) !== gen) return;
      await deps.store.saveLedger(room.slug, inProgress);
      const transcript = await loadCachedTranscript(room.slug);
      const projectName = room.projectId ? deps.resolveProjectName?.(room.projectId) : undefined;
      await deps.publisher.publish(
        room.slug,
        buildRoomBoard(
          room,
          transcript,
          inProgress,
          cachedMinds,
          projectName ?? room.projectId,
          cachedExhibits.get(room.slug) ?? [],
        ),
      );
    });
    const prompt = buildWorkerPrompt({
      ...(room.topic ? { topic: room.topic } : {}),
      ...(room.grounding ? { grounding: room.grounding } : {}),
      task: task?.description ?? "Complete the next step toward the goal.",
      transcript: await loadCachedTranscript(room.slug),
      ...(directionInjection ? { directionInjection } : {}),
      ...(room.coding ? { coding: true } : {}),
    });
    const turn = await runOneTurn(room, worker, prompt, controller);
    if (turn === "disposed") return false;
    // The serial gate means nothing else wrote the ledger during the turn, so settle
    // from the in-progress copy. An aborted or errored turn did not finish its task —
    // only a clean turn completes it; a failed task lets the manager retry on replan.
    const status: TaskStatus = turn.aborted || turn.errored ? "failed" : "completed";
    const nextLedger = setTaskStatus(
      inProgress,
      taskId,
      status,
      { now },
      summarizeOutcome(turn.text),
    );
    const active = await commitLedgerTurn(room, worker, turn, nextLedger, gen);
    if (!active) return false;
    return (await runBudgetSynthesisIfExhausted(room.slug, controller, gen)) ?? true;
  }

  // Append a manager/worker turn, persist the ledger it produced, and advance the room
  // under the write lock — the magentic counterpart to commitTurn (which has no ledger
  // to persist). The ledger save is generation-gated exactly like the room write, so a
  // stop/restart racing the commit drops both. An aborted turn -> stopped; a budget
  // hit stays active just long enough for the closing synthesis. Returns whether the
  // room remains active.
  async function commitLedgerTurn(
    room: Room,
    mind: Mind,
    turn: { text: string; aborted: boolean; errored: boolean; usage?: TokenUsage },
    nextLedger: TaskLedger,
    gen: number,
  ): Promise<boolean> {
    await appendEntry(
      room.slug,
      gen,
      buildAgentEntry(room.slug, room.turnIndex, mind.slug, turn, room.round),
    );
    return await withLock(room.slug, async () => {
      const current = (await deps.store.loadRoom(room.slug)) ?? room;
      if (generationOf(room.slug) === gen) await deps.store.saveLedger(room.slug, nextLedger);
      const advanced: Room = {
        ...current,
        turnIndex: current.turnIndex + 1,
        round: await roundAfter(room.slug, current),
      };
      if (turn.aborted) {
        return await commitTerminal(room.slug, gen, { ...advanced, status: "stopped" });
      }
      return await commitActive(room.slug, gen, advanced);
    });
  }

  async function inject(slug: MindSlug, input: RoomInjectInput): Promise<boolean> {
    // Capture before the load so a terminal step that bumps the generation during
    // it makes this late inject drop its write rather than reactivate the room.
    const gen = generationOf(slug);
    const room = await deps.store.loadRoom(slug);
    if (room?.status !== "active") return false;
    if (generationOf(slug) !== gen) return false; // superseded during load

    if (input.text !== undefined) {
      // `from` is forced to "director" server-side regardless of any payload.
      await appendEntry(
        slug,
        gen,
        buildTurnEntry({
          roomSlug: slug,
          turnIndex: room.turnIndex,
          from: "director",
          role: "director",
          text: input.text,
          messageId: newId(),
          at: now().toISOString(),
        }),
      );
    }

    // Merge pending onto the LATEST room under the lock: re-load inside the lock
    // so a turn that advanced turnIndex while we were appending isn't reverted,
    // and this commit can't interleave with the turn's own load-advance-save.
    // Skip if a stop/terminal completion closed the room — an inject must never
    // reactivate a stopped/done room. Return the lock's result so a late inject
    // (the room stopped/superseded between the load above and the lock) surfaces
    // as false — a dropped steer — instead of a false "applied".
    return await withLock(slug, async () => {
      const current = await deps.store.loadRoom(slug);
      if (current?.status !== "active") return false;
      if (generationOf(slug) !== gen) return false;
      const pending = {
        ...(current.pending ?? {}),
        ...(input.directionInjection !== undefined
          ? { directionInjection: input.directionInjection }
          : {}),
        ...(input.nextSpeaker !== undefined ? { nextSpeaker: input.nextSpeaker } : {}),
      };
      await commitActive(slug, gen, { ...current, pending });
      return true;
    });
  }

  async function stop(slug: MindSlug): Promise<void> {
    // Under the room lock so the stopped write can't interleave with a turn's
    // commit: a commit that already passed its generation check could otherwise
    // save the active room after this stopped save and reactivate it. When a turn
    // is mid-agent-call the lock is free, so the abort below still lands promptly.
    await withLock(slug, async () => {
      const room = await deps.store.loadRoom(slug);
      // Only an active room can be stopped — a stale stop must not rewrite a
      // `done` (or already stopped) room to stopped.
      if (room?.status !== "active") return;
      // Close the generation so an in-flight step's completion is superseded and
      // cannot re-publish stale state after this stop.
      bumpGeneration(slug);
      controllers.get(slug)?.abort();
      clearActive(slug);
      // A magentic worker turn marks its task in-progress before running; an operator
      // stop here would otherwise strand it in-progress on disk — the aborted settle is
      // generation-gated away, and a stopped room never runs another manage turn to
      // recover it, so a reopened board would show phantom live work. Settle it as the
      // room closes, the same interrupted->failed sweep a manage turn does on resume.
      if (room.strategy === "magentic") {
        const ledger = await deps.store.loadLedger(slug);
        if (ledger) {
          const swept = failStuckTasks(ledger, { now });
          if (swept !== ledger) await deps.store.saveLedger(slug, swept);
        }
      }
      await persistAndPublish({ ...room, status: "stopped", pending: undefined });
      // An operator stop closes the room here (not via commitTerminal), so signal
      // the close from this path too — reflection fires for the Minds that spoke
      // before the stop (notifyClosed dedupes if a terminal commit raced it). Pass
      // the same shape that was just persisted (pending cleared), not the pre-stop room.
      notifyClosed({ ...room, status: "stopped", pending: undefined });
    });
    releaseSlugState(slug);
  }

  async function dispose(): Promise<void> {
    disposed = true;
    const slugs = new Set([
      ...controllers.keys(),
      ...transcripts.keys(),
      ...generations.keys(),
      ...writeChains.keys(),
    ]);
    for (const controller of controllers.values()) controller.abort();
    controllers.clear();
    activeRooms.clear();
    for (const slug of slugs) releaseSlugState(slug);
  }

  function isDisposed(): boolean {
    return disposed;
  }

  return { start, step, inject, stop, republish, dispose, isDisposed };
}

function defaultNewId(): () => string {
  let n = 0;
  return () => `turn-${(++n).toString(36)}-${Date.now().toString(36)}`;
}

// A short, single-line outcome note for a settled magentic task, stamped into the
// ledger so the manager's next prompt and the board carry the gist without the whole
// turn text. Empty output reads as "(no output)".
function summarizeOutcome(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) return "(no output)";
  return trimmed.length > 160 ? `${trimmed.slice(0, 159)}…` : trimmed;
}
