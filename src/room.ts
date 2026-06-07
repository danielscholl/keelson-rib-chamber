import { buildRoomBoard } from "./boards/room.ts";
import type { RoomPublisher, RoomStore, RunAgentTurn } from "./ports.ts";
import { getStrategy } from "./strategies/index.ts";
import { buildTurnEntry, renderTranscript } from "./transcript.ts";
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
  now?: () => Date;
  newId?: () => string;
}

export interface RoomStartConfig {
  slug: MindSlug;
  name: string;
  strategy: RoomStrategyName;
  participants: readonly MindSlug[];
  turnBudget: number;
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

      // (2) decide: a valid nextSpeaker override wins; otherwise the strategy picks.
      let decision: StrategyStep;
      if (override.nextSpeaker !== undefined && isValidNominee(override.nextSpeaker, room)) {
        decision = { kind: "speak", mind: override.nextSpeaker };
      } else {
        decision = getStrategy(room.strategy)(room);
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
      // speak-parallel / moderate / synthesize — Phase 3 / deferred concurrent.
      throw new Error(`step kind "${decision.kind}" is not supported in Phase 2`);
    } finally {
      controllers.delete(slug);
      inFlight.delete(slug);
    }
  }

  async function runSpeakTurn(
    room: Room,
    mindSlug: MindSlug,
    directionInjection: string | undefined,
    controller: AbortController,
    gen: number,
  ): Promise<boolean> {
    const minds = await deps.minds();
    const mind = minds.find((m) => m.slug === mindSlug);
    if (!mind) {
      // Speaker not in roster — fail closed: note it and end the room.
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
      return await withLock(room.slug, () =>
        commitTerminal(room.slug, gen, { ...room, status: "done" }),
      );
    }

    const transcript = await loadCachedTranscript(room.slug);

    let text: string;
    let aborted: boolean;
    if (controller.signal.aborted) {
      // A stop / dispose landed during the async gap above — finalize without
      // invoking a turn, so no normal reply is appended after a stop.
      text = "";
      aborted = true;
    } else {
      const context = renderTranscript(transcript);
      const prompt = directionInjection
        ? `${context}\n\n[director]: ${directionInjection}`
        : context;
      // tools omitted -> text-only (the room default). Mapping Mind.tools slugs to
      // C1 tool descriptors is deferred. The Mind's model pin is honoured.
      const turn = deps.runAgentTurn({
        system: mind.persona,
        prompt,
        abortSignal: controller.signal,
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
    if (disposed) return false;

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

    // Merge onto the latest stored room, not the pre-turn snapshot, so a director
    // inject that arrived during the turn (fresh pending) is preserved. Under the
    // room lock so the load-advance-save can't interleave with an inject commit.
    // The commit helpers drop the write if a stop/restart has superseded the turn.
    return await withLock(room.slug, async () => {
      const current = (await deps.store.loadRoom(room.slug)) ?? room;
      // Advance from the re-loaded current, not the pre-turn snapshot, so the
      // index stays consistent with the state this commit is merging onto.
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
