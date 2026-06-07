import { describe, expect, test } from "bun:test";
import { createRoomDriver } from "../../src/room.ts";
import type { Mind } from "../../src/types.ts";
import {
  abortableRunAgentTurn,
  fixedClock,
  gatedRunAgentTurn,
  makeFakePublisher,
  makeFakeStore,
  scriptedRunAgentTurn,
  seqIds,
  type TurnScript,
} from "../helpers/fakes.ts";

const MINDS: Mind[] = [
  { slug: "a", name: "Ada", persona: "You are Ada." },
  { slug: "b", name: "Bo", persona: "You are Bo." },
];

const START = {
  slug: "demo",
  name: "Demo",
  strategy: "sequential" as const,
  participants: ["a", "b"],
  turnBudget: 4,
};

function harness(scripts: TurnScript[] = [{ text: "reply" }]) {
  const { store, rooms, transcripts } = makeFakeStore();
  const pub = makeFakePublisher();
  const turns = scriptedRunAgentTurn(scripts);
  const driver = createRoomDriver({
    store,
    publisher: pub.publisher,
    runAgentTurn: turns.run,
    minds: () => MINDS,
    now: fixedClock(),
    newId: seqIds(),
  });
  return { driver, store, rooms, transcripts, pub, turns };
}

describe("room driver — lifecycle", () => {
  test("start creates an active room and publishes a valid board", async () => {
    const h = harness();
    const room = await h.driver.start(START);
    expect(room.status).toBe("active");
    expect(h.pub.all()).toHaveLength(1);
  });

  test("single active room: a second different active slug throws", async () => {
    const h = harness();
    await h.driver.start(START);
    await expect(h.driver.start({ ...START, slug: "other" })).rejects.toThrow();
  });

  test("restarting the same slug resumes turnIndex", async () => {
    const h = harness();
    await h.driver.start(START);
    await h.driver.step("demo");
    const resumed = await h.driver.start(START);
    expect(resumed.turnIndex).toBe(1);
  });
});

describe("room driver — step", () => {
  test("speak: invokes runAgentTurn with persona system + appends one stamped entry", async () => {
    const h = harness([{ text: "from ada" }]);
    await h.driver.start(START);
    await h.driver.step("demo");
    expect(h.turns.requests[0]?.system).toBe("You are Ada.");
    const transcript = await h.store.loadTranscript("demo");
    expect(transcript).toHaveLength(1);
    expect(transcript[0]?.from).toBe("a");
    expect(transcript[0]?.role).toBe("agent");
    expect(transcript[0]?.turnIndex).toBe(0);
    expect(transcript[0]?.parts[0]?.text).toBe("from ada");
    const room = await h.store.loadRoom("demo");
    expect(room?.turnIndex).toBe(1);
  });

  test("prompt carries prior transcript text", async () => {
    const h = harness([{ text: "first" }, { text: "second" }]);
    await h.driver.start(START);
    await h.driver.step("demo");
    await h.driver.step("demo");
    expect(h.turns.requests[1]?.prompt).toContain("a: first");
  });

  test("driver is sole authority for `from` (stamps the invoked mind)", async () => {
    const h = harness();
    await h.driver.start(START);
    await h.driver.step("demo");
    const t = await h.store.loadTranscript("demo");
    expect(t[0]?.from).toBe("a");
  });

  test("budget: reaching turnBudget marks done; further steps are no-ops", async () => {
    const h = harness();
    await h.driver.start({ ...START, turnBudget: 2 });
    await h.driver.step("demo");
    await h.driver.step("demo");
    expect((await h.store.loadRoom("demo"))?.status).toBe("done");
    const before = (await h.store.loadTranscript("demo")).length;
    await h.driver.step("demo");
    expect((await h.store.loadTranscript("demo")).length).toBe(before);
  });

  test("timeout/error turns are recorded and the room stays active", async () => {
    const h = harness([{ text: "", status: "error" }]);
    await h.driver.start(START);
    await h.driver.step("demo");
    expect((await h.store.loadRoom("demo"))?.status).toBe("active");
    expect(await h.store.loadTranscript("demo")).toHaveLength(1);
  });
});

describe("room driver — director overrides", () => {
  test("nextSpeaker override is consumed once and routes the next turn", async () => {
    const h = harness();
    await h.driver.start(START); // round-robin would pick "a"
    await h.driver.inject("demo", { nextSpeaker: "b" });
    await h.driver.step("demo");
    expect((await h.store.loadTranscript("demo"))[0]?.from).toBe("b");
    expect((await h.store.loadRoom("demo"))?.pending).toBeUndefined();
  });

  test("invalid nominee falls back to the strategy pick", async () => {
    const h = harness();
    await h.driver.start(START);
    await h.driver.inject("demo", { nextSpeaker: "ghost" });
    await h.driver.step("demo");
    expect((await h.store.loadTranscript("demo"))[0]?.from).toBe("a");
  });

  test("reserved authorities are rejected as nominees", async () => {
    const h = harness();
    await h.driver.start(START);
    await h.driver.inject("demo", { nextSpeaker: "director" });
    await h.driver.step("demo");
    expect((await h.store.loadTranscript("demo"))[0]?.from).toBe("a");
  });

  test("directionInjection is one-shot and appears in the prompt", async () => {
    const h = harness([{ text: "one" }, { text: "two" }]);
    await h.driver.start(START);
    await h.driver.inject("demo", { directionInjection: "be concise" });
    await h.driver.step("demo");
    expect(h.turns.requests[0]?.prompt).toContain("be concise");
    await h.driver.step("demo");
    expect(h.turns.requests[1]?.prompt).not.toContain("be concise");
  });

  test("inject text appends a director entry with from forced to 'director'", async () => {
    const h = harness();
    await h.driver.start(START);
    await h.driver.inject("demo", { text: "director says hi" });
    const t = await h.store.loadTranscript("demo");
    expect(t[0]?.from).toBe("director");
    expect(t[0]?.role).toBe("director");
  });
});

describe("room driver — stop / abort", () => {
  function abortHarness() {
    const { store } = makeFakeStore();
    const pub = makeFakePublisher();
    const turns = abortableRunAgentTurn();
    const driver = createRoomDriver({
      store,
      publisher: pub.publisher,
      runAgentTurn: turns.run,
      minds: () => MINDS,
      now: fixedClock(),
      newId: seqIds(),
    });
    return { driver, store, pub, turns };
  }

  test("stop aborts an in-flight turn; entry marked aborted; room stopped; next step no-op", async () => {
    const h = abortHarness();
    await h.driver.start(START);
    const stepP = h.driver.step("demo");
    await h.turns.started;
    await h.driver.stop("demo");
    await stepP;
    expect((await h.store.loadRoom("demo"))?.status).toBe("stopped");
    const t = await h.store.loadTranscript("demo");
    expect(t.some((e) => e.aborted)).toBe(true);
    const before = (await h.store.loadTranscript("demo")).length;
    await h.driver.step("demo");
    expect((await h.store.loadTranscript("demo")).length).toBe(before);
  });

  test("dispose aborts an in-flight turn and drops its late write (clean teardown)", async () => {
    const h = abortHarness();
    await h.driver.start(START);
    const stepP = h.driver.step("demo");
    await h.turns.started;
    await h.driver.dispose();
    await stepP;
    // The turn was aborted by dispose; its late result is dropped rather than
    // appended/published, so nothing is written after the rib is gone. (A user
    // stop, by contrast, still records the aborted marker — disposed is false.)
    expect(await h.store.loadTranscript("demo")).toHaveLength(0);
  });
});

describe("room driver — concurrency & model", () => {
  test("honours the Mind's model pin in the turn request", async () => {
    const { store } = makeFakeStore();
    const pub = makeFakePublisher();
    const turns = scriptedRunAgentTurn([{ text: "ok" }]);
    const driver = createRoomDriver({
      store,
      publisher: pub.publisher,
      runAgentTurn: turns.run,
      minds: () => [{ slug: "a", name: "Ada", persona: "You are Ada.", model: "claude-x" }],
      now: fixedClock(),
      newId: seqIds(),
    });
    await driver.start({ ...START, participants: ["a"] });
    await driver.step("demo");
    expect(turns.requests[0]?.model).toBe("claude-x");
  });

  test("concurrent step() calls do not race (the second is a no-op)", async () => {
    const { store } = makeFakeStore();
    const pub = makeFakePublisher();
    const turns = gatedRunAgentTurn();
    const driver = createRoomDriver({
      store,
      publisher: pub.publisher,
      runAgentTurn: turns.run,
      minds: () => MINDS,
      now: fixedClock(),
      newId: seqIds(),
    });
    await driver.start(START);
    const first = driver.step("demo");
    const second = driver.step("demo"); // dropped: a turn is already in flight
    await turns.started;
    turns.release();
    await Promise.all([first, second]);
    expect(await store.loadTranscript("demo")).toHaveLength(1);
    expect((await store.loadRoom("demo"))?.turnIndex).toBe(1);
  });

  test("an inject during a turn is preserved, not clobbered by completion", async () => {
    const { store } = makeFakeStore();
    const pub = makeFakePublisher();
    const turns = gatedRunAgentTurn();
    const driver = createRoomDriver({
      store,
      publisher: pub.publisher,
      runAgentTurn: turns.run,
      minds: () => MINDS,
      now: fixedClock(),
      newId: seqIds(),
    });
    await driver.start(START);
    const stepP = driver.step("demo");
    await turns.started;
    await driver.inject("demo", { nextSpeaker: "b" }); // arrives mid-turn
    turns.release();
    await stepP;
    expect((await store.loadRoom("demo"))?.pending?.nextSpeaker).toBe("b");
  });

  test("an inject racing a turn's commit never reverts turnIndex", async () => {
    const { store } = makeFakeStore();
    const pub = makeFakePublisher();
    const turns = gatedRunAgentTurn();
    const driver = createRoomDriver({
      store,
      publisher: pub.publisher,
      runAgentTurn: turns.run,
      minds: () => MINDS,
      now: fixedClock(),
      newId: seqIds(),
    });
    await driver.start(START); // turnIndex 0, budget 4
    const stepP = driver.step("demo");
    await turns.started; // turn for "a" in flight at turnIndex 0
    // The inject (loads the pre-turn room) and the turn's commit (advances
    // turnIndex) race for the room write. The per-room lock serializes them, so
    // the inject can't save the stale turnIndex 0 over the turn's advance.
    const injectP = driver.inject("demo", { nextSpeaker: "b", text: "steer" });
    turns.release();
    await Promise.all([stepP, injectP]);
    const room = await store.loadRoom("demo");
    expect(room?.turnIndex).toBe(1); // advanced exactly once, never reverted
    expect(room?.pending?.nextSpeaker).toBe("b"); // and the inject is preserved
  });
});

describe("room driver — lifecycle edge cases", () => {
  test("start rejects an unimplemented strategy and activates nothing", async () => {
    const h = harness();
    await expect(h.driver.start({ ...START, strategy: "group-chat" })).rejects.toThrow();
    expect(await h.store.loadRoom("demo")).toBeUndefined();
    expect(h.pub.all()).toHaveLength(0);
  });

  test("a stop during the pre-turn gap cancels the turn (no reply is appended)", async () => {
    const { store } = makeFakeStore();
    const pub = makeFakePublisher();
    const turns = scriptedRunAgentTurn([{ text: "should not run" }]);
    let resolveMinds: (m: Mind[]) => void = () => {};
    const mindsReady = new Promise<Mind[]>((resolve) => {
      resolveMinds = resolve;
    });
    const driver = createRoomDriver({
      store,
      publisher: pub.publisher,
      runAgentTurn: turns.run,
      minds: () => mindsReady, // resolves only after we stop
      now: fixedClock(),
      newId: seqIds(),
    });
    await driver.start(START);
    const stepP = driver.step("demo"); // suspends awaiting minds()
    await driver.stop("demo"); // aborts the controller allocated at step start
    resolveMinds(MINDS);
    await stepP;
    expect(turns.requests).toHaveLength(0); // the turn was never invoked
    expect((await store.loadTranscript("demo")).some((e) => e.aborted)).toBe(true);
    expect((await store.loadRoom("demo"))?.status).toBe("stopped");
  });

  test("a stale stop does not rewrite a done room", async () => {
    const h = harness();
    await h.driver.start({ ...START, turnBudget: 1 });
    await h.driver.step("demo"); // turnIndex 1 >= 1 -> done
    expect((await h.store.loadRoom("demo"))?.status).toBe("done");
    await h.driver.stop("demo"); // stale stop -> no-op
    expect((await h.store.loadRoom("demo"))?.status).toBe("done");
  });

  test("a stop + same-slug restart is not clobbered by the stale step completion", async () => {
    const { store } = makeFakeStore();
    const pub = makeFakePublisher();
    const turns = gatedRunAgentTurn();
    const driver = createRoomDriver({
      store,
      publisher: pub.publisher,
      runAgentTurn: turns.run,
      minds: () => MINDS,
      now: fixedClock(),
      newId: seqIds(),
    });
    await driver.start(START);
    const stepP = driver.step("demo"); // turn in flight
    await turns.started;
    await driver.stop("demo"); // closes the generation
    await driver.start(START); // restart same slug -> fresh active generation
    turns.release(); // the superseded turn settles
    await stepP;
    expect((await store.loadRoom("demo"))?.status).toBe("active"); // not clobbered to stopped
  });

  test("resuming an active room does not drop an in-flight turn's commit", async () => {
    const { store } = makeFakeStore();
    const pub = makeFakePublisher();
    const turns = gatedRunAgentTurn();
    const driver = createRoomDriver({
      store,
      publisher: pub.publisher,
      runAgentTurn: turns.run,
      minds: () => MINDS,
      now: fixedClock(),
      newId: seqIds(),
    });
    await driver.start(START);
    const stepP = driver.step("demo"); // turn in flight
    await turns.started;
    await driver.start(START); // resume the same active room — must not supersede the turn
    turns.release();
    await stepP;
    expect((await store.loadRoom("demo"))?.turnIndex).toBe(1); // commit not dropped
  });

  test("an inject racing room closure does not reactivate the room", async () => {
    const { store } = makeFakeStore();
    const pub = makeFakePublisher();
    const turns = gatedRunAgentTurn();
    const driver = createRoomDriver({
      store,
      publisher: pub.publisher,
      runAgentTurn: turns.run,
      minds: () => MINDS,
      now: fixedClock(),
      newId: seqIds(),
    });
    await driver.start({ ...START, turnBudget: 1 }); // the one turn completes -> done
    const stepP = driver.step("demo");
    await turns.started;
    const injectP = driver.inject("demo", { nextSpeaker: "b" }); // loads the still-active room
    turns.release(); // step completes -> done (closes the generation)
    await Promise.all([stepP, injectP]);
    expect((await store.loadRoom("demo"))?.status).toBe("done"); // not reactivated
  });
});

describe("room driver — settle (I/O + reservation)", () => {
  // Wrap a fake store to count full-transcript reads, proving the in-memory
  // transcript replaces the per-turn re-parse.
  function countingStore() {
    const base = makeFakeStore();
    let loadTranscriptCalls = 0;
    const store = {
      ...base.store,
      async loadTranscript(slug: string) {
        loadTranscriptCalls += 1;
        return base.store.loadTranscript(slug);
      },
    };
    return { ...base, store, loads: () => loadTranscriptCalls };
  }

  test("transcript is loaded once per room, not re-parsed each turn", async () => {
    const c = countingStore();
    const driver = createRoomDriver({
      store: c.store,
      publisher: makeFakePublisher().publisher,
      runAgentTurn: scriptedRunAgentTurn([{ text: "x" }]).run,
      minds: () => MINDS,
      now: fixedClock(),
      newId: seqIds(),
    });
    await driver.start(START); // one load to seed the in-memory transcript
    await driver.step("demo");
    await driver.step("demo");
    await driver.step("demo");
    expect((await c.store.loadRoom("demo"))?.turnIndex).toBe(3); // turns ran
    expect(c.loads()).toBe(1); // never re-read despite 3 turns (was 2/turn)
  });

  test("a mid-turn director inject shows in the published board", async () => {
    const { store } = makeFakeStore();
    const pub = makeFakePublisher();
    const turns = gatedRunAgentTurn("agent reply");
    const driver = createRoomDriver({
      store,
      publisher: pub.publisher,
      runAgentTurn: turns.run,
      minds: () => MINDS,
      now: fixedClock(),
      newId: seqIds(),
    });
    await driver.start(START);
    const stepP = driver.step("demo");
    await turns.started;
    await driver.inject("demo", { text: "director note" }); // appends mid-turn
    turns.release();
    await stepP;
    const last = pub.last();
    if (last?.view !== "board") throw new Error("expected a board view");
    const rows = last.sections.find((s) => s.kind === "rows");
    const texts = rows?.kind === "rows" ? rows.items.map((i) => i.text) : [];
    // Exact ordered rows: the concurrently-injected director note (appended first,
    // mid-turn) then the turn's reply. Asserting the full ordered sequence — not an
    // order/count-insensitive toContain — catches a cache/disk divergence (a
    // double-counted or mis-ordered entry) the looser check would miss.
    expect(texts).toEqual(["director note", "agent reply"]);
  });

  test("concurrent starts: synchronous reservation lets only one win", async () => {
    const h = harness();
    // Fire two starts without awaiting between them. The reservation in start()
    // is synchronous, so the second sees the first's claim and rejects — no
    // adapter-level start gate needed.
    const settled = await Promise.allSettled([
      h.driver.start({ ...START, slug: "a" }),
      h.driver.start({ ...START, slug: "b" }),
    ]);
    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((r) => r.status === "rejected")).toHaveLength(1);
  });

  test("isDisposed reflects dispose()", async () => {
    const h = harness();
    expect(h.driver.isDisposed()).toBe(false);
    await h.driver.dispose();
    expect(h.driver.isDisposed()).toBe(true);
  });
});

describe("room driver — driver-API soundness", () => {
  // Flush pending microtasks until a turn has actually been invoked. The fresh
  // turn below reaches runAgentTurn through several awaits; a macrotask tick lets
  // them settle so we can read its recorded request deterministically.
  async function waitForTurns(turns: { requests: unknown[] }, n: number) {
    while (turns.requests.length < n) await new Promise<void>((r) => setTimeout(r, 0));
  }

  test("step() distinguishes busy (serial-gate no-op) from ended (room closed)", async () => {
    const { store } = makeFakeStore();
    const pub = makeFakePublisher();
    const turns = gatedRunAgentTurn();
    const driver = createRoomDriver({
      store,
      publisher: pub.publisher,
      runAgentTurn: turns.run,
      minds: () => MINDS,
      now: fixedClock(),
      newId: seqIds(),
    });
    await driver.start(START); // budget 4 -> stays active after one turn
    const first = driver.step("demo"); // a turn goes in flight
    await turns.started;
    // A second step while a turn is in flight is the serial-gate no-op: it must
    // report "busy" (a transient retry), never "ended" — which is what a second
    // stepper would use to abandon a still-active room.
    expect(await driver.step("demo")).toBe("busy");
    turns.release();
    expect(await first).toBe("advanced"); // a turn ran and the room is still active
    // Once stopped, a step reports "ended" — distinct from the transient "busy".
    await driver.stop("demo");
    expect(await driver.step("demo")).toBe("ended");
  });

  test("step() returns 'ended' when the turn closes the room (budget reached)", async () => {
    const h = harness();
    await h.driver.start({ ...START, turnBudget: 1 });
    // The single turn hits the budget and commits terminal — the room ends on this
    // step (the speak->terminal path, not the already-closed early return).
    expect(await h.driver.step("demo")).toBe("ended");
    expect((await h.store.loadRoom("demo"))?.status).toBe("done");
  });

  test("a stale-generation turn's append stays out of a restarted room's cache", async () => {
    const { store } = makeFakeStore();
    const pub = makeFakePublisher();
    // Distinct text so a leaked stale entry is unambiguous in the new room's context.
    const turns = gatedRunAgentTurn("STALE-GEN1");
    const driver = createRoomDriver({
      store,
      publisher: pub.publisher,
      runAgentTurn: turns.run,
      minds: () => MINDS,
      now: fixedClock(),
      newId: seqIds(),
    });
    await driver.start(START); // generation 1
    const stale = driver.step("demo"); // the gen-1 turn goes in flight
    await turns.started;
    await driver.stop("demo"); // closes gen 1 (bumps the generation, clears the cache)
    await driver.start(START); // restart the same slug -> a fresh active generation
    turns.release(); // the gen-1 turn drains now, after the generation moved on
    await stale;
    // The stale turn's reply lands on disk (append-only) but its cache push is
    // generation-gated, so it never enters the restarted generation's array.
    expect((await store.loadTranscript("demo")).length).toBe(1); // disk kept it

    // Drive one fresh turn: its prompt is rendered from this generation's cache,
    // and its board is built from it. Neither may carry the stale gen-1 reply.
    const fresh = driver.step("demo");
    await waitForTurns(turns, 2);
    expect(turns.requests[1]?.prompt ?? "").not.toContain("STALE-GEN1");
    turns.release();
    expect(await fresh).toBe("advanced");
    const last = pub.last();
    if (last?.view !== "board") throw new Error("expected a board view");
    const rows = last.sections.find((s) => s.kind === "rows");
    const items = rows?.kind === "rows" ? rows.items : [];
    expect(items).toHaveLength(1); // only the fresh reply — the stale entry was gated out
  });
});
