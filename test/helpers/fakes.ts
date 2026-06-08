import type { CanvasView, MessageChunk } from "@keelson/shared";
import { canvasViewSchema } from "@keelson/shared";
import type {
  RibAgentTurn,
  RibAgentTurnRequest,
  RibAgentTurnResult,
  RunAgentTurn,
} from "../../src/agent-turn.ts";
import type { RoomPublisher, RoomStore } from "../../src/ports.ts";
import type { MindSlug, Room, TurnEntry } from "../../src/types.ts";

// In-memory RoomStore. Returns copies on read so a test can't mutate stored
// state by reference (catches accidental aliasing in the driver).
export function makeFakeStore() {
  const rooms = new Map<MindSlug, Room>();
  const transcripts = new Map<MindSlug, TurnEntry[]>();
  const store: RoomStore = {
    async loadRoom(slug) {
      const room = rooms.get(slug);
      return room ? { ...room } : undefined;
    },
    async saveRoom(room) {
      rooms.set(room.slug, { ...room });
    },
    async appendTranscript(slug, entry) {
      const list = transcripts.get(slug) ?? [];
      list.push({ ...entry });
      transcripts.set(slug, list);
    },
    async loadTranscript(slug) {
      return (transcripts.get(slug) ?? []).map((e) => ({ ...e }));
    },
  };
  return { store, rooms, transcripts };
}

// Recording RoomPublisher. Every published view is asserted valid against
// canvasViewSchema — the provider-free end-to-end proof.
export function makeFakePublisher() {
  const views: CanvasView[] = [];
  const publisher: RoomPublisher = {
    async publish(view) {
      const parsed = canvasViewSchema.safeParse(view);
      if (!parsed.success) {
        throw new Error(`published an invalid canvas view: ${parsed.error.message}`);
      }
      views.push(view);
    },
  };
  return { publisher, views, last: () => views[views.length - 1], all: () => views };
}

export interface TurnScript {
  text: string;
  status?: RibAgentTurnResult["status"];
  chunks?: string[];
}

// Scripted runAgentTurn: each call consumes the next script (repeating the last).
// The stream yields text chunks then done; the result resolves to the scripted
// status/text. Records every request for assertions.
export function scriptedRunAgentTurn(scripts: TurnScript[]) {
  const requests: RibAgentTurnRequest[] = [];
  let i = 0;
  const run: RunAgentTurn = (req) => {
    requests.push(req);
    const script = (scripts.length > 0 ? scripts[Math.min(i, scripts.length - 1)] : undefined) ?? {
      text: "",
    };
    i += 1;
    const chunks = script.chunks ?? [script.text];
    const turn: RibAgentTurn = {
      stream: (async function* (): AsyncGenerator<MessageChunk> {
        for (const content of chunks) yield { type: "text", content };
        yield { type: "done" };
      })(),
      result: Promise.resolve({
        status: script.status ?? "ok",
        text: script.text,
      } satisfies RibAgentTurnResult),
    };
    return turn;
  };
  return { run, requests };
}

// Abort-aware runAgentTurn whose result resolves only when the abort signal fires
// (or immediately if already aborted) — for testing stop()/dispose(). `started`
// resolves when the turn is in-flight, so a test can deterministically abort it.
export function abortableRunAgentTurn() {
  const requests: RibAgentTurnRequest[] = [];
  let markStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const run: RunAgentTurn = (req) => {
    requests.push(req);
    markStarted();
    const result = new Promise<RibAgentTurnResult>((resolve) => {
      const signal = req.abortSignal;
      if (!signal) return;
      if (signal.aborted) {
        resolve({ status: "aborted", text: "" });
        return;
      }
      signal.addEventListener("abort", () => resolve({ status: "aborted", text: "" }), {
        once: true,
      });
    });
    return {
      stream: (async function* (): AsyncGenerator<MessageChunk> {
        yield { type: "done" };
      })(),
      result,
    };
  };
  return { run, requests, started };
}

// A runAgentTurn whose result resolves only when `release()` is called — for
// holding a turn in flight while another op (a second step, an inject) runs.
// `started` resolves when the turn is invoked.
export function gatedRunAgentTurn(text = "reply") {
  const requests: RibAgentTurnRequest[] = [];
  let markStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let releaseResult: () => void = () => {};
  const run: RunAgentTurn = (req) => {
    requests.push(req);
    markStarted();
    const result = new Promise<RibAgentTurnResult>((resolve) => {
      releaseResult = () => resolve({ status: "ok", text });
    });
    return {
      stream: (async function* (): AsyncGenerator<MessageChunk> {
        yield { type: "done" };
      })(),
      result,
    };
  };
  return { run, requests, started, release: () => releaseResult() };
}

// A runAgentTurn whose FIRST call resolves immediately with `firstText` (e.g. a
// moderator's routing reply) and whose subsequent calls stay in flight until the
// abort signal fires — so a test can let the moderator turn commit, then stop the
// room while the routed speaker turn is mid-flight. `secondStarted` resolves when
// the second turn is invoked.
export function scriptedThenAbortable(firstText: string) {
  const requests: RibAgentTurnRequest[] = [];
  let markSecond: () => void = () => {};
  const secondStarted = new Promise<void>((resolve) => {
    markSecond = resolve;
  });
  let n = 0;
  const run: RunAgentTurn = (req) => {
    requests.push(req);
    const i = n++;
    const stream = (async function* (): AsyncGenerator<MessageChunk> {
      yield { type: "done" };
    })();
    if (i === 0) {
      return {
        stream,
        result: Promise.resolve({ status: "ok", text: firstText } satisfies RibAgentTurnResult),
      };
    }
    markSecond();
    const result = new Promise<RibAgentTurnResult>((resolve) => {
      const signal = req.abortSignal;
      if (!signal) return;
      if (signal.aborted) {
        resolve({ status: "aborted", text: "" });
        return;
      }
      signal.addEventListener("abort", () => resolve({ status: "aborted", text: "" }), {
        once: true,
      });
    });
    return { stream, result };
  };
  return { run, requests, secondStarted };
}

export function fixedClock(iso = "2026-01-01T00:00:00.000Z") {
  return () => new Date(iso);
}

export function seqIds(prefix = "id") {
  let n = 0;
  return () => `${prefix}-${++n}`;
}
