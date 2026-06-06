import { buildRoomBoard } from "./boards/room.ts";
import type { RoomPublisher, RoomStore, RunAgentTurn } from "./ports.ts";
import { getStrategy } from "./strategies/index.ts";
import { buildTurnEntry, renderTranscript } from "./transcript.ts";
import type { Mind, MindSlug, Room, RoomConfig, RoomStrategyName, StrategyStep } from "./types.ts";

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

export interface RoomDriver {
  start(config: RoomStartConfig): Promise<Room>;
  step(slug: MindSlug): Promise<void>;
  inject(slug: MindSlug, input: RoomInjectInput): Promise<void>;
  stop(slug: MindSlug): Promise<void>;
  dispose(): Promise<void>;
}

export function createRoomDriver(deps: RoomDriverDeps): RoomDriver {
  const controllers = new Map<MindSlug, AbortController>();
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? defaultNewId();
  // The single-active-room invariant (one fixed rib:chamber:room key, C1): in the
  // wired rib this is enforced by the snapshot key's register-once discipline;
  // here the driver tracks it directly.
  let activeSlug: MindSlug | undefined;

  function controllerFor(slug: MindSlug): AbortController {
    let controller = controllers.get(slug);
    if (!controller) {
      controller = new AbortController();
      controllers.set(slug, controller);
    }
    return controller;
  }

  function clearActive(slug: MindSlug): void {
    if (activeSlug === slug) activeSlug = undefined;
    controllers.delete(slug);
  }

  async function persistAndPublish(room: Room): Promise<void> {
    await deps.store.saveRoom(room);
    const transcript = await deps.store.loadTranscript(room.slug);
    await deps.publisher.publish(buildRoomBoard(room, transcript));
  }

  function isValidNominee(slug: MindSlug, room: Room): boolean {
    return slug !== "director" && slug !== "system" && room.participants.includes(slug);
  }

  async function start(config: RoomStartConfig): Promise<Room> {
    if (activeSlug && activeSlug !== config.slug) {
      const other = await deps.store.loadRoom(activeSlug);
      if (other && other.status === "active") {
        throw new Error(
          `a room is already active (${activeSlug}); stop it before starting "${config.slug}"`,
        );
      }
      activeSlug = undefined;
    }

    const existing = await deps.store.loadRoom(config.slug);
    activeSlug = config.slug;
    if (existing && existing.status === "active") {
      // Resume the same slug from its persisted state.
      await persistAndPublish(existing);
      return existing;
    }

    const room: Room = {
      slug: config.slug,
      name: config.name,
      strategy: config.strategy,
      participants: config.participants,
      status: "active",
      turnBudget: config.turnBudget,
      turnIndex: existing?.turnIndex ?? 0,
      ...(config.config ? { config: config.config } : {}),
      createdAt: existing?.createdAt ?? now().toISOString(),
    };
    await persistAndPublish(room);
    return room;
  }

  async function step(slug: MindSlug): Promise<void> {
    const loaded = await deps.store.loadRoom(slug);
    if (loaded?.status !== "active") return;

    // (1) consume one-shot director overrides (read + clear).
    const pending = loaded.pending ?? {};
    const override = {
      nextSpeaker: pending.nextSpeaker,
      directionInjection: pending.directionInjection,
    };
    const room: Room = { ...loaded, pending: undefined };

    // (2) decide: a valid nextSpeaker override wins; otherwise the strategy picks.
    let decision: StrategyStep;
    if (override.nextSpeaker !== undefined && isValidNominee(override.nextSpeaker, room)) {
      decision = { kind: "speak", mind: override.nextSpeaker };
    } else {
      decision = getStrategy(room.strategy)(room);
    }

    // (3) execute.
    if (decision.kind === "end") {
      const ended: Room = { ...room, status: "done" };
      clearActive(ended.slug);
      await persistAndPublish(ended);
      return;
    }
    if (decision.kind === "speak") {
      await runSpeakTurn(room, decision.mind, override.directionInjection);
      return;
    }
    // speak-parallel / moderate / synthesize — Phase 3 / deferred concurrent.
    throw new Error(`step kind "${decision.kind}" is not supported in Phase 2`);
  }

  async function runSpeakTurn(
    room: Room,
    mindSlug: MindSlug,
    directionInjection: string | undefined,
  ): Promise<void> {
    const minds = await deps.minds();
    const mind = minds.find((m) => m.slug === mindSlug);
    if (!mind) {
      // Speaker not in roster — fail closed: note it and end the room.
      await deps.store.appendTranscript(
        room.slug,
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
      const ended: Room = { ...room, status: "done" };
      clearActive(ended.slug);
      await persistAndPublish(ended);
      return;
    }

    const transcript = await deps.store.loadTranscript(room.slug);
    const context = renderTranscript(transcript);
    const prompt = directionInjection ? `${context}\n\n[director]: ${directionInjection}` : context;

    const controller = controllerFor(room.slug);
    // tools omitted -> text-only (the room default). Mapping Mind.tools slugs to
    // C1 tool descriptors is deferred.
    const turn = deps.runAgentTurn({
      system: mind.persona,
      prompt,
      abortSignal: controller.signal,
    });

    try {
      // Draining the stream could drive throttled partial publishes later; for now
      // the result is the source of truth.
      for await (const _chunk of turn.stream) {
        // intentionally empty
      }
    } catch {
      // a stream error surfaces via result.status below
    }
    const result = await turn.result;
    const aborted = result.status === "aborted" || controller.signal.aborted;
    const text =
      result.status === "error" || result.status === "timeout"
        ? (result.error ?? result.text ?? `turn ${result.status}`)
        : result.text;

    await deps.store.appendTranscript(
      room.slug,
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

    let next: Room = { ...room, turnIndex: room.turnIndex + 1 };
    if (aborted) {
      next = { ...next, status: "stopped" };
      clearActive(next.slug);
    } else if (next.turnIndex >= next.turnBudget) {
      next = { ...next, status: "done" };
      clearActive(next.slug);
    }
    await persistAndPublish(next);
  }

  async function inject(slug: MindSlug, input: RoomInjectInput): Promise<void> {
    const room = await deps.store.loadRoom(slug);
    if (room?.status !== "active") return;

    const pending = {
      ...(room.pending ?? {}),
      ...(input.directionInjection !== undefined
        ? { directionInjection: input.directionInjection }
        : {}),
      ...(input.nextSpeaker !== undefined ? { nextSpeaker: input.nextSpeaker } : {}),
    };

    if (input.text !== undefined) {
      // `from` is forced to "director" server-side regardless of any payload.
      await deps.store.appendTranscript(
        slug,
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

    await persistAndPublish({ ...room, pending });
  }

  async function stop(slug: MindSlug): Promise<void> {
    const room = await deps.store.loadRoom(slug);
    if (!room) return;
    controllerFor(slug).abort();
    clearActive(slug);
    await persistAndPublish({ ...room, status: "stopped", pending: undefined });
  }

  async function dispose(): Promise<void> {
    for (const controller of controllers.values()) controller.abort();
    controllers.clear();
    activeSlug = undefined;
  }

  return { start, step, inject, stop, dispose };
}

function defaultNewId(): () => string {
  let n = 0;
  return () => `turn-${(++n).toString(36)}-${Date.now().toString(36)}`;
}
