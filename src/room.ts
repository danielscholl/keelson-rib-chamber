import { buildRoomBoard } from "./boards/room.ts";
import type { RoomPublisher, RoomStore, RunAgentTurn } from "./ports.ts";
import {
  allHeardInCycle,
  DEFAULT_END_VOTE_THRESHOLD,
  DEFAULT_MAX_SPEAKER_REPEATS,
  DEFAULT_MIN_ROUNDS,
  endVoteRatio,
  leastSpoken,
  type ModeratorDecision,
  parseModeratorDecision,
  parseNomination,
  speakerCounts,
} from "./routing.ts";
import { getStrategy } from "./strategies/index.ts";
import { openFloor } from "./strategies/open-floor.ts";
import {
  buildModeratorPrompt,
  buildOpenFloorPrompt,
  buildSynthesisPrompt,
  buildTurnEntry,
  buildTurnPrompt,
} from "./transcript.ts";
import type {
  Mind,
  MindSlug,
  Room,
  RoomConfig,
  RoomStrategyName,
  StrategyStep,
  TurnEntry,
} from "./types.ts";

export interface RoomDriverDeps {
  store: RoomStore;
  publisher: RoomPublisher;
  runAgentTurn: RunAgentTurn;
  // Resolve persona/model/tools by slug. A function (not a port) — the roster is
  // Phase 1 / genesis territory; the driver only needs to look minds up.
  minds: () => Promise<readonly Mind[]> | readonly Mind[];
  // Resolve a Mind's authored SOUL.md by slug, used as the turn system prompt so
  // the speaker behaves like its genesis-authored self. Falls back to the roster
  // tagline (Mind.persona) when absent, so omitting this keeps a thin persona.
  readSoul?: (slug: MindSlug) => Promise<string | undefined> | string | undefined;
  // Neutral working dir for agent turns. Without it the turn inherits the
  // server's cwd, leaking the host repo's ambient context (git state, files)
  // into the conversation; pointing it at the Chamber data home isolates that.
  turnCwd?: string;
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
  config?: RoomConfig;
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
  dispose(): Promise<void>;
  isDisposed(): boolean;
}

export function createRoomDriver(deps: RoomDriverDeps): RoomDriver {
  const controllers = new Map<MindSlug, AbortController>();
  // Rooms with a turn in flight. The serial gate: one turn at a time per room, so
  // two fire-and-return room-next calls cannot race the same turnIndex.
  const inFlight = new Set<MindSlug>();
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? defaultNewId();
  // The single-active-room invariant (one fixed rib:chamber:room key, C1): in the
  // wired rib this is enforced by the snapshot key's register-once discipline;
  // here the driver tracks it directly and reserves it synchronously in start().
  let activeSlug: MindSlug | undefined;
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

  function clearActive(slug: MindSlug): void {
    if (activeSlug === slug) activeSlug = undefined;
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
    writeChains.set(
      slug,
      next.then(
        () => {},
        () => {},
      ),
    );
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

  async function persistAndPublish(room: Room): Promise<void> {
    await deps.store.saveRoom(room);
    const transcript = await loadCachedTranscript(room.slug);
    await deps.publisher.publish(buildRoomBoard(room, transcript));
  }

  // Commit a still-active room, unless a newer generation has superseded this op.
  // Returns whether the room remains active (false when superseded — the caller
  // should stop driving).
  async function commitActive(slug: MindSlug, gen: number, room: Room): Promise<boolean> {
    if (generationOf(slug) !== gen) return false;
    await persistAndPublish(room);
    return true;
  }

  // Commit a room leaving the active state (done/stopped). Bumps the generation so
  // any other in-flight op on this room becomes stale and skips its own write,
  // then releases the in-memory transcript. Always returns false (not active).
  async function commitTerminal(slug: MindSlug, gen: number, room: Room): Promise<boolean> {
    if (generationOf(slug) !== gen) return false;
    bumpGeneration(slug);
    clearActive(slug);
    await persistAndPublish(room);
    transcripts.delete(slug);
    return false;
  }

  function isValidNominee(slug: MindSlug, room: Room): boolean {
    return slug !== "director" && slug !== "system" && room.participants.includes(slug);
  }

  async function start(config: RoomStartConfig): Promise<Room> {
    // Reject a strategy the registry cannot execute before reserving — otherwise
    // the room would occupy the single active slot with no way for step() to
    // advance it. Runs before the reservation so a bad strategy leaks no slot.
    getStrategy(config.strategy);

    // Single-active reservation, synchronous: there is no await between reading
    // and claiming activeSlug, so two concurrent starts cannot both pass — the
    // second sees the first's reservation and rejects. This owns the invariant
    // the adapter used to guard with a process-wide start gate.
    if (activeSlug !== undefined && activeSlug !== config.slug) {
      throw new Error(
        `a room is already active (${activeSlug}); stop it before starting "${config.slug}"`,
      );
    }
    const claimed = activeSlug === undefined;
    activeSlug = config.slug;

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
        ...(config.config ? { config: config.config } : {}),
        createdAt: now().toISOString(),
      };
      await persistAndPublish(room);
      return room;
    } catch (e) {
      // Release the slot we just claimed so a failed start doesn't wedge the
      // driver (only if we claimed it — a failed resume must not unreserve the
      // still-active room).
      if (claimed && activeSlug === config.slug) activeSlug = undefined;
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

      // (2) decide: a valid nextSpeaker override wins; otherwise the strategy
      // picks over the room and the transcript (the round cursor is room.round).
      let decision: StrategyStep;
      if (override.nextSpeaker !== undefined && isValidNominee(override.nextSpeaker, room)) {
        decision = { kind: "speak", mind: override.nextSpeaker };
      } else {
        const transcript = await loadCachedTranscript(slug);
        // open-floor's routing (end-vote close + peer nomination) is driver-side
        // parsing, so it goes through decideOpenFloor rather than the pure strategy.
        decision =
          room.strategy === "open-floor"
            ? decideOpenFloor(room, transcript)
            : getStrategy(room.strategy)({ room, transcript });
      }

      // (3) execute. commitTerminal / runSpeakTurn report "is the room still
      // active" as a boolean; map that to the StepOutcome the loop drives on.
      if (decision.kind === "end") {
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
      // speak-parallel / synthesize — deferred concurrent (Slice 4); synthesis is
      // reached inline from a moderate close, never as a strategy-returned step.
      throw new Error(`step kind "${decision.kind}" is not supported yet`);
    } finally {
      controllers.delete(slug);
      inFlight.delete(slug);
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
  ): Promise<Mind | undefined> {
    const minds = await deps.minds();
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

  // Run one agent turn and return its reply text + aborted flag, or "disposed" if
  // the rib was torn down mid-turn (the caller drops a disposed turn without
  // committing). The prompt is built by the caller — the speaker, moderator, and
  // synthesizer differ only in their prompt — so this owns just the abort
  // pre-check, the stream drain, and result extraction.
  async function runOneTurn(
    mind: Mind,
    prompt: string,
    controller: AbortController,
  ): Promise<{ text: string; aborted: boolean } | "disposed"> {
    let text: string;
    let aborted: boolean;
    if (controller.signal.aborted) {
      // A stop / dispose landed during the async gap above — finalize without
      // invoking a turn, so no normal reply is appended after a stop.
      text = "";
      aborted = true;
    } else {
      // The authored soul is the turn's identity; fall back to the roster tagline
      // when a Mind has no readable SOUL.md so the turn still runs in character.
      const system = (await deps.readSoul?.(mind.slug))?.trim() || mind.persona;
      // tools omitted -> text-only (the room default). Mapping Mind.tools slugs to
      // C1 tool descriptors is deferred. The Mind's model pin is honoured.
      const turn = deps.runAgentTurn({
        system,
        prompt,
        abortSignal: controller.signal,
        ...(deps.turnCwd ? { cwd: deps.turnCwd } : {}),
        ...(mind.model ? { model: mind.model } : {}),
      });
      try {
        // Draining the stream could drive throttled partial publishes later; for
        // now the result is the source of truth.
        for await (const _chunk of turn.stream) {
          // intentionally empty
        }
      } catch {
        // a stream error surfaces via result.status below
      }
      const result = await turn.result;
      aborted = result.status === "aborted" || controller.signal.aborted;
      text =
        result.status === "error" || result.status === "timeout"
          ? (result.error ?? result.text ?? `turn ${result.status}`)
          : result.text;
    }
    // Shutdown landed during the (uncancellable) turn — drop the late result so
    // nothing is appended or published after the rib is disposed.
    if (disposed) return "disposed";
    return { text, aborted };
  }

  // Append a finished agent turn and advance the room under the write lock: an
  // aborted turn -> stopped, the budget reached -> done, else still active.
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
  ): Promise<boolean> {
    await appendEntry(
      room.slug,
      gen,
      buildTurnEntry({
        roomSlug: room.slug,
        turnIndex: room.turnIndex,
        from: mind.slug,
        role: "agent",
        text,
        aborted,
        messageId: newId(),
        at: now().toISOString(),
      }),
    );
    return await withLock(room.slug, async () => {
      const current = (await deps.store.loadRoom(room.slug)) ?? room;
      const advanced: Room = { ...current, turnIndex: current.turnIndex + 1 };
      if (aborted) {
        return await commitTerminal(room.slug, gen, { ...advanced, status: "stopped" });
      }
      if (advanced.turnIndex >= advanced.turnBudget) {
        return await commitTerminal(room.slug, gen, { ...advanced, status: "done" });
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
  ): string {
    if (room.strategy === "open-floor") {
      return buildOpenFloorPrompt({
        ...(room.topic ? { topic: room.topic } : {}),
        transcript,
        participants: room.participants,
        ...(directionInjection ? { directionInjection } : {}),
      });
    }
    return buildTurnPrompt({
      ...(room.topic ? { topic: room.topic } : {}),
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
    );
    const turn = await runOneTurn(mind, prompt, controller);
    if (turn === "disposed") return false;
    return await commitTurn(room, mind, turn.text, turn.aborted, gen);
  }

  // A group-chat moderate step: run the moderator, then route on its reply. Up to
  // two turns under one step() (the serial gate + the shared controller/gen cover
  // both). The moderator commits first (so the speaker is prompted from a
  // transcript that already holds its direction); the budget gate is the commit's
  // own terminal check — if the moderator's tick reaches turnBudget the commit
  // returns inactive and no speaker/synthesis runs.
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
      transcript: await loadCachedTranscript(room.slug),
      participants: room.participants,
      // A director steer is guidance for the routing decision, so it goes to the
      // moderator (who decides who speaks), not directly to a speaker.
      ...(directionInjection ? { directionInjection } : {}),
    });
    const modTurn = await runOneTurn(moderator, modPrompt, controller);
    if (modTurn === "disposed") return false;
    const modActive = await commitTurn(room, moderator, modTurn.text, modTurn.aborted, gen);
    if (!modActive) return false; // aborted/stopped, budget -> done, or superseded

    // Re-load so the speaker/synthesis turn advances from the moderator's commit,
    // not the pre-moderator snapshot — its entry index must follow the moderator's.
    const afterMod = await deps.store.loadRoom(room.slug);
    if (afterMod?.status !== "active" || generationOf(room.slug) !== gen) return false;

    const decision = parseModeratorDecision(modTurn.text);
    const postMod = await loadCachedTranscript(room.slug);
    const counts = speakerCounts(postMod);
    const minRounds = afterMod.config?.minRounds ?? DEFAULT_MIN_ROUNDS;

    if (decision?.action === "close" && allHeardInCycle(afterMod.participants, counts, minRounds)) {
      return await runCloseSynthesis(afterMod, controller, gen);
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
      transcript: postMod,
      // The moderator's `direction` is guidance for the Mind it nominated, so
      // surface it only when that nominee actually got the turn — a cap-redirect or
      // fallback routes to someone else, for whom the steer was not written.
      ...(decision?.direction && speaker === decision.nextSpeaker
        ? { directionInjection: decision.direction }
        : {}),
    });
    const spkTurn = await runOneTurn(speakerMind, spkPrompt, controller);
    if (spkTurn === "disposed") return false;
    return await commitTurn(afterMod, speakerMind, spkTurn.text, spkTurn.aborted, gen);
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

  // The closing act of a group-chat: an optional synthesizer authors one summary
  // turn, then the room ends (done). Synthesis always closes — even an errored
  // turn — and a disposed turn drops cleanly. Only reached when the moderator's
  // commit left budget, so the synthesis turn always fits.
  async function runCloseSynthesis(
    room: Room,
    controller: AbortController,
    gen: number,
  ): Promise<boolean> {
    const synthSlug = room.config?.synthesizer;
    if (synthSlug) {
      const minds = await deps.minds();
      const synth = minds.find((m) => m.slug === synthSlug);
      if (synth) {
        // Skip only if a stop superseded before synthesis starts (no phantom entry
        // for a turn that never ran); a stop during it is recorded, as on the
        // speaker path.
        if (controller.signal.aborted || generationOf(room.slug) !== gen) return false;
        const prompt = buildSynthesisPrompt({
          ...(room.topic ? { topic: room.topic } : {}),
          transcript: await loadCachedTranscript(room.slug),
        });
        const turn = await runOneTurn(synth, prompt, controller);
        if (turn === "disposed") return false;
        await appendEntry(
          room.slug,
          gen,
          buildTurnEntry({
            roomSlug: room.slug,
            turnIndex: room.turnIndex,
            from: synth.slug,
            role: "agent",
            text: turn.text,
            aborted: turn.aborted,
            messageId: newId(),
            at: now().toISOString(),
          }),
        );
        return await withLock(room.slug, async () => {
          const current = (await deps.store.loadRoom(room.slug)) ?? room;
          return await commitTerminal(room.slug, gen, {
            ...current,
            turnIndex: current.turnIndex + 1,
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
      await persistAndPublish({ ...room, status: "stopped", pending: undefined });
      transcripts.delete(slug);
    });
  }

  async function dispose(): Promise<void> {
    disposed = true;
    for (const controller of controllers.values()) controller.abort();
    controllers.clear();
    activeSlug = undefined;
  }

  function isDisposed(): boolean {
    return disposed;
  }

  return { start, step, inject, stop, dispose, isDisposed };
}

function defaultNewId(): () => string {
  let n = 0;
  return () => `turn-${(++n).toString(36)}-${Date.now().toString(36)}`;
}
