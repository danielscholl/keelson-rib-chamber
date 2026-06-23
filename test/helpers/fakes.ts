import type { CanvasView, MessageChunk } from "@keelson/shared";
import { canvasViewSchema } from "@keelson/shared";
import type {
  RibAgentTurn,
  RibAgentTurnRequest,
  RibAgentTurnResult,
  RunAgentTurn,
} from "../../src/agent-turn.ts";
import { assertSafeSlug } from "../../src/genesis.ts";
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
    async deleteRoom(slug) {
      // Reject an unsafe slug first (the FS boundary in the real store), then fail
      // closed on a missing room — keeps the fake faithful to createFileRoomStore.
      assertSafeSlug(slug);
      if (!rooms.has(slug)) throw new Error(`room '${slug}' not found`);
      rooms.delete(slug);
      transcripts.delete(slug);
    },
  };
  return { store, rooms, transcripts };
}

// Recording RoomPublisher. Every published view is asserted valid against
// canvasViewSchema — the provider-free end-to-end proof. Records the owning slug
// alongside each board so a test can assert per-room routing.
export function makeFakePublisher() {
  const views: CanvasView[] = [];
  const published: { slug: string; view: CanvasView }[] = [];
  const publisher: RoomPublisher = {
    async publish(slug, view) {
      const parsed = canvasViewSchema.safeParse(view);
      if (!parsed.success) {
        throw new Error(`published an invalid canvas view: ${parsed.error.message}`);
      }
      views.push(view);
      published.push({ slug, view });
    },
  };
  return {
    publisher,
    views,
    published,
    last: () => views[views.length - 1],
    all: () => views,
  };
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

// A runAgentTurn pool for concurrent rounds: every call gets its OWN gate, so a
// test can release the N in-flight turns in any order (proving the driver appends
// in participant order regardless of completion order) or hold them while a stop
// races the batch. `release(i, text?)` settles the i-th turn; `releaseAll` settles
// them all; `started(n)` resolves once at least n turns are in flight.
export function gatedRunAgentTurnPool() {
  const requests: RibAgentTurnRequest[] = [];
  const releases: ((text?: string) => void)[] = [];
  let started = 0;
  const waiters: { n: number; resolve: () => void }[] = [];
  const run: RunAgentTurn = (req) => {
    requests.push(req);
    let releaseResult: (text?: string) => void = () => {};
    const result = new Promise<RibAgentTurnResult>((resolve) => {
      releaseResult = (text = "reply") => resolve({ status: "ok", text });
    });
    releases.push(releaseResult);
    started += 1;
    for (let k = waiters.length - 1; k >= 0; k--) {
      const w = waiters[k];
      if (w && started >= w.n) {
        w.resolve();
        waiters.splice(k, 1);
      }
    }
    return {
      stream: (async function* (): AsyncGenerator<MessageChunk> {
        yield { type: "done" };
      })(),
      result,
    };
  };
  return {
    run,
    requests,
    release: (i: number, text?: string) => releases[i]?.(text),
    releaseAll: (texts?: string[]) => {
      for (let i = 0; i < releases.length; i++) releases[i]?.(texts?.[i]);
    },
    started: (n: number) =>
      new Promise<void>((resolve) => {
        if (started >= n) resolve();
        else waiters.push({ n, resolve });
      }),
  };
}

// A runAgentTurn whose FIRST call throws synchronously (a turn-seam failure) and
// whose later calls stay in flight until aborted — for proving a concurrent round
// cancels its in-flight siblings and awaits them (no orphaned calls) when one turn
// rejects. `abortedSibling`/`settledSibling` report whether a later turn observed
// the abort and settled.
export function throwingThenAbortable(reason = "turn seam failed") {
  const requests: RibAgentTurnRequest[] = [];
  let abortedSibling = false;
  let settledSibling = false;
  let n = 0;
  const run: RunAgentTurn = (req) => {
    requests.push(req);
    const i = n++;
    if (i === 0) throw new Error(reason); // the first speaker's turn seam throws
    const result = new Promise<RibAgentTurnResult>((resolve) => {
      const signal = req.abortSignal;
      const onAbort = () => {
        abortedSibling = true;
        resolve({ status: "aborted", text: "" });
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    }).then((r) => {
      settledSibling = true;
      return r;
    });
    return {
      stream: (async function* (): AsyncGenerator<MessageChunk> {
        yield { type: "done" };
      })(),
      result,
    };
  };
  return {
    run,
    requests,
    abortedSibling: () => abortedSibling,
    settledSibling: () => settledSibling,
  };
}

export function fixedClock(iso = "2026-01-01T00:00:00.000Z") {
  return () => new Date(iso);
}

export function seqIds(prefix = "id") {
  let n = 0;
  return () => `${prefix}-${++n}`;
}
