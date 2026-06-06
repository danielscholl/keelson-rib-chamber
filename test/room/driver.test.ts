import { describe, expect, test } from "bun:test";
import { createRoomDriver } from "../../src/room.ts";
import type { Mind } from "../../src/types.ts";
import {
  abortableRunAgentTurn,
  fixedClock,
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

  test("dispose aborts in-flight turns", async () => {
    const h = abortHarness();
    await h.driver.start(START);
    const stepP = h.driver.step("demo");
    await h.turns.started;
    await h.driver.dispose();
    await stepP;
    expect((await h.store.loadTranscript("demo")).some((e) => e.aborted)).toBe(true);
  });
});
