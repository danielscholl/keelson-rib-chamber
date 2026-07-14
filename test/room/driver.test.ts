import { describe, expect, test } from "bun:test";
import type { CanvasBoardView } from "@keelson/shared";
import { createRoomDriver } from "../../src/room.ts";
import type { Mind, Room, RoomConfig, RoomStrategyName, TurnEntry } from "../../src/types.ts";
import {
  abortableRunAgentTurn,
  fixedClock,
  gatedRunAgentTurn,
  gatedRunAgentTurnPool,
  makeFakePublisher,
  makeFakeStore,
  scriptedRunAgentTurn,
  scriptedThenAbortable,
  seqIds,
  type TurnScript,
  throwingThenAbortable,
} from "../helpers/fakes.ts";

// onRoomClosed signals via an async transcript read, so poll briefly for the signal.
async function waitForLen(arr: readonly unknown[], n: number, ms = 1000): Promise<void> {
  const deadline = Date.now() + ms;
  while (arr.length < n && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
}

// The debate feed lives nested inside the columns section's main (first) column,
// as its one rows section — not a top-level board.sections entry. Throws (never
// silently degrades to []) when that shape is missing, so a regression that
// stops emitting the columns/rows section fails loudly instead of reading as
// "correctly empty".
function debateRows(board: CanvasBoardView) {
  const columns = board.sections.find((s) => s.kind === "columns");
  if (columns?.kind !== "columns") throw new Error("expected a columns section");
  const feed = columns.columns[0]?.sections[0];
  if (feed?.kind !== "rows") throw new Error("expected the debate feed");
  return feed.items;
}

const MINDS: Mind[] = [
  { slug: "a", name: "Ada", role: "agent", persona: "You are Ada." },
  { slug: "b", name: "Bo", role: "agent", persona: "You are Bo." },
];

const START = {
  slug: "demo",
  name: "Demo",
  strategy: "sequential" as const,
  participants: ["a", "b"],
  turnBudget: 4,
};

function harness(
  scripts: TurnScript[] = [{ text: "reply" }],
  opts: {
    minds?: readonly Mind[];
    turnTools?: readonly { name: string }[];
    turnCwd?: string;
    resolveProjectRoot?: (projectId: string) => string | undefined;
  } = {},
) {
  const { store, rooms, transcripts } = makeFakeStore();
  const pub = makeFakePublisher();
  const turns = scriptedRunAgentTurn(scripts);
  const driver = createRoomDriver({
    store,
    publisher: pub.publisher,
    runAgentTurn: turns.run,
    minds: () => opts.minds ?? MINDS,
    ...(opts.turnTools ? { turnTools: opts.turnTools } : {}),
    ...(opts.turnCwd ? { turnCwd: opts.turnCwd } : {}),
    ...(opts.resolveProjectRoot ? { resolveProjectRoot: opts.resolveProjectRoot } : {}),
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

  test("allows multiple concurrent active rooms (single-active lifted)", async () => {
    const h = harness();
    await h.driver.start(START);
    await expect(h.driver.start({ ...START, slug: "other" })).resolves.toBeDefined();
    expect((await h.store.loadRoom("demo"))?.status).toBe("active");
    expect((await h.store.loadRoom("other"))?.status).toBe("active");
  });

  test("drives concurrent rooms independently, each on its own key", async () => {
    const h = harness([{ text: "r" }]);
    await h.driver.start({ ...START, slug: "alpha", turnBudget: 1 });
    await h.driver.start({ ...START, slug: "beta", turnBudget: 1 });
    // alpha runs to completion; beta is untouched by it.
    expect(await h.driver.step("alpha")).toBe("ended");
    expect((await h.store.loadRoom("alpha"))?.status).toBe("done");
    expect((await h.store.loadRoom("beta"))?.status).toBe("active");
    expect(await h.driver.step("beta")).toBe("ended");
    expect((await h.store.loadRoom("beta"))?.status).toBe("done");
    // Each room's boards were routed to its own slug.
    expect(new Set(h.pub.published.map((p) => p.slug))).toEqual(new Set(["alpha", "beta"]));
  });

  test("stopping one concurrent room leaves the others active", async () => {
    const h = harness([{ text: "r" }]);
    await h.driver.start({ ...START, slug: "alpha", turnBudget: 4 });
    await h.driver.start({ ...START, slug: "beta", turnBudget: 4 });
    await h.driver.stop("alpha");
    expect((await h.store.loadRoom("alpha"))?.status).toBe("stopped");
    expect((await h.store.loadRoom("beta"))?.status).toBe("active");
    // beta still advances after alpha stopped.
    expect(await h.driver.step("beta")).toBe("advanced");
  });

  test("restarting the same slug resumes turnIndex", async () => {
    const h = harness();
    await h.driver.start(START);
    await h.driver.step("demo");
    const resumed = await h.driver.start(START);
    expect(resumed.turnIndex).toBe(1);
  });

  test("restarting a done same-slug room starts with a clean transcript cache", async () => {
    const h = harness([{ text: "old done reply" }, { text: "fresh reply" }]);
    await h.driver.start({ ...START, turnBudget: 1 });
    expect(await h.driver.step("demo")).toBe("ended");
    expect((await h.store.loadRoom("demo"))?.status).toBe("done");
    expect(await h.store.loadTranscript("demo")).toHaveLength(2);

    await h.driver.start(START);
    expect((await h.store.loadRoom("demo"))?.turnIndex).toBe(0);
    const reopened = h.pub.last();
    if (reopened?.view !== "board") throw new Error("expected a board view");
    expect(debateRows(reopened)).toHaveLength(0);

    await h.driver.step("demo");
    expect(h.turns.requests[2]?.prompt ?? "").not.toContain("old done reply");
  });

  test("restarting a stopped same-slug room starts with a clean transcript cache", async () => {
    const h = harness([{ text: "fresh after stop" }]);
    await h.driver.start(START);
    await h.driver.inject("demo", { text: "old director note" });
    await h.driver.stop("demo");
    expect((await h.store.loadRoom("demo"))?.status).toBe("stopped");
    expect(await h.store.loadTranscript("demo")).toHaveLength(1);

    await h.driver.start(START);
    const reopened = h.pub.last();
    if (reopened?.view !== "board") throw new Error("expected a board view");
    expect(debateRows(reopened)).toHaveLength(0);

    await h.driver.step("demo");
    expect(h.turns.requests[0]?.prompt ?? "").not.toContain("old director note");
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

  test("a clean empty turn retries once before committing and counting", async () => {
    const h = harness([{ text: "" }, { text: "from retry" }]);
    await h.driver.start({ ...START, turnBudget: 2 });
    await h.driver.step("demo");
    const transcript = await h.store.loadTranscript("demo");
    expect(transcript).toHaveLength(1);
    expect(transcript[0]?.parts[0]?.text).toBe("from retry");
    expect((await h.store.loadRoom("demo"))?.turnIndex).toBe(1);
    expect(h.turns.requests).toHaveLength(2);
  });

  test("a persistently empty turn retries once, then commits and counts once", async () => {
    const h = harness([{ text: "" }]);
    await h.driver.start({ ...START, turnBudget: 2 });
    await h.driver.step("demo");
    const transcript = await h.store.loadTranscript("demo");
    expect(transcript).toHaveLength(1);
    expect(transcript[0]?.parts[0]?.text).toBe("");
    expect((await h.store.loadRoom("demo"))?.turnIndex).toBe(1);
    expect(h.turns.requests).toHaveLength(2);
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

  test("budget: reaching turnBudget appends synthesis, marks done, and further steps are no-ops", async () => {
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
    expect(h.turns.requests).toHaveLength(1);
  });
});

describe("room driver — round cursor", () => {
  test("sequential: round advances when the roster completes a cycle; entries are stamped", async () => {
    const h = harness([{ text: "a1" }, { text: "b1" }, { text: "a2" }, { text: "b2" }]);
    await h.driver.start(START); // participants [a, b], turnBudget 4
    await h.driver.step("demo"); // a — cycle not yet complete
    expect((await h.store.loadRoom("demo"))?.round).toBe(0);
    await h.driver.step("demo"); // b — first cycle complete
    expect((await h.store.loadRoom("demo"))?.round).toBe(1);
    await h.driver.step("demo"); // a again
    expect((await h.store.loadRoom("demo"))?.round).toBe(1);
    await h.driver.step("demo"); // b again — second cycle complete (room then done)
    expect((await h.store.loadRoom("demo"))?.round).toBe(2);
    // each entry carries the round it was authored in
    expect((await h.store.loadTranscript("demo")).map((e) => e.round)).toEqual([0, 0, 1, 1, 2]);
  });

  test("concurrent: one parallel batch is a full round, sharing one stamp", async () => {
    const h = harness([{ text: "a1" }, { text: "b1" }]);
    await h.driver.start({ ...START, strategy: "concurrent", turnBudget: 4 });
    expect(await h.driver.step("demo")).toBe("advanced"); // [a, b] in one round
    expect((await h.store.loadRoom("demo"))?.round).toBe(1);
    const t = await h.store.loadTranscript("demo");
    expect(t.map((e) => e.from)).toEqual(["a", "b"]);
    expect(t.map((e) => e.round)).toEqual([0, 0]); // both authored before the cursor advanced
  });
});

describe("room driver — project targeting (per-room cwd)", () => {
  test("a room targeted at a project runs its turns at the project root", async () => {
    const h = harness([{ text: "ok" }], {
      turnCwd: "/data/home",
      resolveProjectRoot: (id) => (id === "p1" ? "/repos/alpha" : undefined),
    });
    await h.driver.start({ ...START, projectId: "p1" });
    await h.driver.step("demo");
    expect(h.turns.requests[0]?.cwd).toBe("/repos/alpha");
  });

  test("an untargeted room keeps the neutral turnCwd", async () => {
    const h = harness([{ text: "ok" }], {
      turnCwd: "/data/home",
      resolveProjectRoot: () => "/repos/alpha",
    });
    await h.driver.start(START); // no projectId
    await h.driver.step("demo");
    expect(h.turns.requests[0]?.cwd).toBe("/data/home");
  });

  test("a targeted project the host no longer knows falls back to the neutral cwd", async () => {
    const h = harness([{ text: "ok" }], {
      turnCwd: "/data/home",
      resolveProjectRoot: () => undefined, // project deleted mid-room
    });
    await h.driver.start({ ...START, projectId: "p1" });
    await h.driver.step("demo");
    // Never the host process cwd — the neutral turnCwd, so no ambient context leaks.
    expect(h.turns.requests[0]?.cwd).toBe("/data/home");
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
    expect(h.turns.requests).toHaveLength(1);
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
  test("honours the Mind's model + provider pin in the turn request", async () => {
    const { store } = makeFakeStore();
    const pub = makeFakePublisher();
    const turns = scriptedRunAgentTurn([{ text: "ok" }]);
    const driver = createRoomDriver({
      store,
      publisher: pub.publisher,
      runAgentTurn: turns.run,
      minds: () => [
        {
          slug: "a",
          name: "Ada",
          role: "agent",
          persona: "You are Ada.",
          model: "claude-x",
          provider: "claude",
        },
      ],
      now: fixedClock(),
      newId: seqIds(),
    });
    await driver.start({ ...START, participants: ["a"] });
    await driver.step("demo");
    expect(turns.requests[0]?.model).toBe("claude-x");
    expect(turns.requests[0]?.provider).toBe("claude");
  });

  const TOOLED_MINDS: Mind[] = [
    { slug: "a", name: "Ada", role: "agent", persona: "You are Ada.", tools: ["lens"] },
    { slug: "b", name: "Bo", role: "agent", persona: "You are Bo." },
  ];
  const EXHIBIT_POOL = [{ name: "chamber_table_exhibit" }];

  test("maps a speaker's declared lens slug onto the turn's tools (a Mind can table an exhibit mid-room)", async () => {
    const h = harness([{ text: "ok" }], { minds: TOOLED_MINDS, turnTools: EXHIBIT_POOL });
    await h.driver.start(START);
    await h.driver.step("demo"); // speaker a, declares the lens slug
    expect(h.turns.requests[0]?.tools).toEqual([{ name: "chamber_table_exhibit" }]);
  });

  test("a Mind that declares no tools stays text-only even when the room pool is set", async () => {
    const h = harness([{ text: "a" }, { text: "b" }], {
      minds: TOOLED_MINDS,
      turnTools: EXHIBIT_POOL,
    });
    await h.driver.start(START);
    await h.driver.step("demo"); // a: declares lens
    await h.driver.step("demo"); // b: declares nothing
    expect(h.turns.requests[0]?.tools).toEqual([{ name: "chamber_table_exhibit" }]);
    expect(h.turns.requests[1]?.tools).toBeUndefined();
  });

  test("each parallel speaker gets its own tool rail by declaration", async () => {
    const h = harness([{ text: "ada" }, { text: "bo" }], {
      minds: TOOLED_MINDS,
      turnTools: EXHIBIT_POOL,
    });
    await h.driver.start({ ...START, strategy: "concurrent", turnBudget: 4 });
    await h.driver.step("demo"); // one parallel batch = a + b
    const ada = h.turns.requests.find((r) => r.system === "You are Ada.");
    const bo = h.turns.requests.find((r) => r.system === "You are Bo.");
    expect(ada?.tools).toEqual([{ name: "chamber_table_exhibit" }]);
    expect(bo?.tools).toBeUndefined();
  });

  test("omits tools from the turn request when no turnTools configured (text-only default)", async () => {
    const h = harness();
    await h.driver.start(START);
    await h.driver.step("demo");
    expect(h.turns.requests[0]?.tools).toBeUndefined();
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
  test("start rejects an unknown strategy and activates nothing", async () => {
    const h = harness();
    // All four RoomStrategyName values now resolve; an unregistered name still fails
    // closed at start (getStrategy throws), leaking no active slot. speak-parallel
    // now executes (concurrent emits it); the remaining step() throw guards only
    // synthesize, which is reached inline from a moderate close, never from step().
    await expect(
      h.driver.start({ ...START, strategy: "nonexistent" as RoomStrategyName }),
    ).rejects.toThrow();
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
    const turns = gatedRunAgentTurnPool();
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
    await turns.started(1);
    const injectP = driver.inject("demo", { nextSpeaker: "b" }); // loads the still-active room
    turns.release(0); // debate turn reaches the budget, then the synthesis turn starts
    await turns.started(2);
    turns.release(1);
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

  test("transcript is never re-parsed from disk during a room's turns", async () => {
    const c = countingStore();
    const driver = createRoomDriver({
      store: c.store,
      publisher: makeFakePublisher().publisher,
      runAgentTurn: scriptedRunAgentTurn([{ text: "x" }]).run,
      minds: () => MINDS,
      now: fixedClock(),
      newId: seqIds(),
    });
    await driver.start(START); // a fresh room opens an empty cache — no disk read
    await driver.step("demo");
    await driver.step("demo");
    await driver.step("demo");
    expect((await c.store.loadRoom("demo"))?.turnIndex).toBe(3); // turns ran
    // The in-memory transcript serves every prompt/board build, so the store's
    // loadTranscript is never hit across the room's life (was 2 re-parses/turn).
    expect(c.loads()).toBe(0);
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
    const texts = debateRows(last).map((i) => i.text);
    // Exact ordered rows: the concurrently-injected director note (appended first,
    // mid-turn, uncarried by any round), a "Round 1" divider (the agent reply is
    // the first round-stamped entry), then the turn's reply. Asserting the full
    // ordered sequence — not an order/count-insensitive toContain — catches a
    // cache/disk divergence (a double-counted or mis-ordered entry) the looser
    // check would miss.
    expect(texts).toEqual(["director note", "Round 1", "agent reply"]);
  });

  test("concurrent starts of different slugs both open (no shared reservation)", async () => {
    const h = harness();
    // Fire two starts without awaiting between them. Each reserves its own per-slug
    // slot, so both open — there is no shared single-active reservation to contend.
    const settled = await Promise.allSettled([
      h.driver.start({ ...START, slug: "a" }),
      h.driver.start({ ...START, slug: "b" }),
    ]);
    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect((await h.store.loadRoom("a"))?.status).toBe("active");
    expect((await h.store.loadRoom("b"))?.status).toBe("active");
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
  // them settle so we can read its recorded request deterministically. Bounded by
  // a deadline so a regression that never invokes the turn fails loudly instead of
  // hanging the suite forever.
  async function waitForTurns(turns: { requests: unknown[] }, n: number) {
    const deadline = Date.now() + 2_000;
    while (turns.requests.length < n) {
      if (Date.now() > deadline) {
        throw new Error(`timeout waiting for ${n} turns; got ${turns.requests.length}`);
      }
      await new Promise<void>((r) => setTimeout(r, 0));
    }
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
    const items = debateRows(last);
    // A "Round 1" divider (the fresh reply is the generation's first round-stamped
    // entry) plus the one fresh reply — the stale entry was gated out. The fake
    // always settles "STALE-GEN1" regardless of which turn released it; only its
    // PROMPT (asserted above) proves the stale reply never entered this context.
    expect(items.map((i) => i.text)).toEqual(["Round 1", "STALE-GEN1"]);
  });

  test("a stale turn that drained to disk before a same-slug restart is not pulled into the new room", async () => {
    const { store } = makeFakeStore();
    const pub = makeFakePublisher();
    const turns = gatedRunAgentTurn("STALE-BEFORE-RESTART");
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
    await driver.stop("demo"); // closes gen 1
    turns.release(); // the gen-1 turn drains and writes its reply to DISK *before* the restart
    await stale;
    expect((await store.loadTranscript("demo")).length).toBe(1); // disk kept it (append-only)

    await driver.start(START); // restart the same slug -> a fresh generation
    // The restarted room is a brand-new room: it must not inherit the stale
    // stopped-turn reply that the shared on-disk transcript still holds. Opening a
    // new generation seeds an empty cache (not from disk), so the board and the
    // resumed turnIndex both start clean.
    const last = pub.last();
    if (last?.view !== "board") throw new Error("expected a board view");
    const items = debateRows(last);
    expect(items).toHaveLength(0); // fresh room, no carried-over history
    expect((await store.loadRoom("demo"))?.turnIndex).toBe(0);
  });
});

// These assert on the *request* handed to runAgentTurn — the surface the
// canned-text fakes never checked, which is why an empty first-turn prompt, the
// tagline-instead-of-soul system, and the missing cwd all shipped unseen.
describe("room driver — turn request (CR-1 topic / CR-2 soul / CR-3 cwd)", () => {
  const MINDS2: Mind[] = [
    { slug: "a", name: "Ada", role: "agent", persona: "Ada — the tagline." },
    { slug: "b", name: "Bo", role: "agent", persona: "Bo — the tagline." },
  ];

  const START2 = {
    slug: "demo",
    name: "Demo",
    strategy: "sequential" as const,
    participants: ["a", "b"],
    turnBudget: 4,
  };

  function harness(
    opts: {
      scripts?: TurnScript[];
      composeTurnSystem?: (mind: Mind) => Promise<string> | string;
      onRoomClosed?: (room: Room, transcript: readonly TurnEntry[]) => void;
      turnCwd?: string;
    } = {},
  ) {
    const { store } = makeFakeStore();
    const pub = makeFakePublisher();
    const turns = scriptedRunAgentTurn(opts.scripts ?? [{ text: "reply" }]);
    const driver = createRoomDriver({
      store,
      publisher: pub.publisher,
      runAgentTurn: turns.run,
      minds: () => MINDS2,
      ...(opts.composeTurnSystem ? { composeTurnSystem: opts.composeTurnSystem } : {}),
      ...(opts.onRoomClosed ? { onRoomClosed: opts.onRoomClosed } : {}),
      ...(opts.turnCwd ? { turnCwd: opts.turnCwd } : {}),
      now: fixedClock(),
      newId: seqIds(),
    });
    return { driver, turns, store };
  }

  function firstRequest(turns: ReturnType<typeof scriptedRunAgentTurn>) {
    const req = turns.requests[0];
    if (!req) throw new Error("expected a recorded turn request");
    return req;
  }

  test("CR-1: the first turn's prompt is non-empty and carries the topic", async () => {
    const h = harness();
    await h.driver.start({ ...START2, topic: "What should we build next?" });
    await h.driver.step("demo");
    const req = firstRequest(h.turns);
    expect(req.prompt.length).toBeGreaterThan(0);
    expect(req.prompt).toContain("What should we build next?");
  });

  test("CR-1: the first turn's prompt is non-empty even with no topic", async () => {
    const h = harness();
    await h.driver.start(START2); // no topic
    await h.driver.step("demo");
    // The empty-prompt CLI error was the original bug; the builder always yields a
    // non-empty instruction even when topic and transcript are both empty.
    expect(firstRequest(h.turns).prompt.trim().length).toBeGreaterThan(0);
  });

  test("CR-1: a whitespace-only topic yields no topic line in the prompt", async () => {
    const h = harness();
    await h.driver.start({ ...START2, topic: "   " });
    await h.driver.step("demo");
    expect(firstRequest(h.turns).prompt).not.toContain("Room topic:");
  });

  test("CR-1: a later turn includes the prior transcript as context", async () => {
    const h = harness({ scripts: [{ text: "first reply from Ada" }, { text: "Bo responds" }] });
    await h.driver.start({ ...START2, topic: "Topic X" });
    await h.driver.step("demo"); // Ada
    await h.driver.step("demo"); // Bo
    const second = h.turns.requests[1];
    if (!second) throw new Error("expected a second turn request");
    expect(second.prompt).toContain("Conversation so far");
    expect(second.prompt).toContain("first reply from Ada");
  });

  test("CR-2: the turn system prompt is the full soul, not the tagline", async () => {
    const h = harness({
      composeTurnSystem: (mind) => `# ${mind.slug}\n\nFull authored soul body for ${mind.slug}.`,
    });
    await h.driver.start({ ...START2, topic: "Topic" });
    await h.driver.step("demo");
    const req = firstRequest(h.turns);
    expect(req.system).toContain("Full authored soul body for a");
    expect(req.system).not.toBe("Ada — the tagline.");
  });

  test("CR-2: falls back to the roster tagline when no soul is readable", async () => {
    const h = harness({ composeTurnSystem: () => "" }); // composer yields nothing -> persona
    await h.driver.start({ ...START2, topic: "Topic" });
    await h.driver.step("demo");
    expect(firstRequest(h.turns).system).toBe("Ada — the tagline.");
  });

  test("CR-4: signals onRoomClosed once with the final transcript when a room completes", async () => {
    const closed: Array<{ status: string; turns: number }> = [];
    const h = harness({
      onRoomClosed: (room, transcript) =>
        closed.push({ status: room.status, turns: transcript.length }),
    });
    await h.driver.start({ ...START2, turnBudget: 2 });
    await h.driver.step("demo");
    await h.driver.step("demo"); // budget reached -> synthesis -> done
    await waitForLen(closed, 1);
    await h.driver.step("demo"); // a redundant step on a closed room must not re-signal
    expect(closed).toHaveLength(1);
    expect(closed[0]).toEqual({ status: "done", turns: 3 });
  });

  test("CR-4: signals onRoomClosed when an operator stops the room", async () => {
    const closed: string[] = [];
    const h = harness({ onRoomClosed: (room) => closed.push(room.status) });
    await h.driver.start(START2);
    await h.driver.step("demo");
    await h.driver.stop("demo");
    await waitForLen(closed, 1);
    expect(closed).toEqual(["stopped"]);
  });

  test("CR-3: room turns run in the configured neutral cwd", async () => {
    const h = harness({ turnCwd: "/tmp/chamber-home" });
    await h.driver.start({ ...START2, topic: "Topic" });
    await h.driver.step("demo");
    expect(firstRequest(h.turns).cwd).toBe("/tmp/chamber-home");
  });

  test("CR-3: no cwd is set when none is configured", async () => {
    const h = harness();
    await h.driver.start({ ...START2, topic: "Topic" });
    await h.driver.step("demo");
    expect(firstRequest(h.turns).cwd).toBeUndefined();
  });
});

// group-chat (Slice 2): a moderate step runs the moderator, then routes on its
// reply — up to two turns per step(). The strategy is pure rhythm; all parsing /
// routing / the close gate live in the driver and are exercised here through the
// real getStrategy("group-chat").
describe("room driver — group-chat moderate", () => {
  const MINDS_GC: Mind[] = [
    { slug: "a", name: "Ada", role: "agent", persona: "You are Ada." },
    { slug: "b", name: "Bo", role: "agent", persona: "You are Bo." },
    { slug: "m", name: "Mod", role: "agent", persona: "You are Mod." },
    { slug: "s", name: "Synth", role: "agent", persona: "You are Synth." },
  ];

  function gcHarness(scripts: TurnScript[], minds: Mind[] = MINDS_GC) {
    const { store } = makeFakeStore();
    const pub = makeFakePublisher();
    const turns = scriptedRunAgentTurn(scripts);
    const driver = createRoomDriver({
      store,
      publisher: pub.publisher,
      runAgentTurn: turns.run,
      minds: () => minds,
      now: fixedClock(),
      newId: seqIds(),
    });
    return { driver, store, pub, turns };
  }

  function startGc(
    driver: ReturnType<typeof createRoomDriver>,
    config: RoomConfig = { moderator: "m" },
    turnBudget = 6,
  ) {
    return driver.start({
      slug: "gc",
      name: "GC",
      strategy: "group-chat",
      participants: ["a", "b"],
      turnBudget,
      config,
    });
  }

  const direct = (slug: string, extra = "") =>
    `${extra}{"action":"direct","next_speaker":"${slug}"}`;

  async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > deadline) throw new Error("waitFor timed out");
      await new Promise<void>((r) => setTimeout(r, 0));
    }
  }

  test("a moderate step runs the moderator then the routed speaker (turnIndex +2)", async () => {
    const h = gcHarness([{ text: direct("a") }, { text: "Ada speaks." }]);
    await startGc(h.driver);
    expect(await h.driver.step("gc")).toBe("advanced");
    const t = await h.store.loadTranscript("gc");
    expect(t.map((e) => e.from)).toEqual(["m", "a"]);
    expect(t.every((e) => e.role === "agent")).toBe(true);
    expect((await h.store.loadRoom("gc"))?.turnIndex).toBe(2);
    // The moderator turn uses its own persona/soul and is asked for routing JSON.
    expect(h.turns.requests[0]?.system).toBe("You are Mod.");
    expect(h.turns.requests[0]?.prompt).toContain('"action":"direct"');
    expect(h.turns.requests[1]?.system).toBe("You are Ada.");
  });

  test("round advances only when the last unheard participant speaks; moderator turns don't bump it", async () => {
    const h = gcHarness([
      { text: direct("a") },
      { text: "a1" },
      { text: direct("b") },
      { text: "b1" },
    ]);
    await startGc(h.driver); // participants [a, b]
    await h.driver.step("gc"); // m -> a, b still unheard
    expect((await h.store.loadRoom("gc"))?.round).toBe(0);
    await h.driver.step("gc"); // m -> b, the cycle completes
    expect((await h.store.loadRoom("gc"))?.round).toBe(1);
    const t = await h.store.loadTranscript("gc");
    expect(t.map((e) => e.from)).toEqual(["m", "a", "m", "b"]);
    // the moderator (a non-participant) authors agent turns that never lift the cursor
    expect(t.map((e) => e.round)).toEqual([0, 0, 0, 0]);
  });

  test("an over-cap nominee is redirected to leastSpoken (anti-monopoly)", async () => {
    const h = gcHarness([
      { text: direct("a") }, // step 1: route to a
      { text: "a1" },
      { text: direct("a") }, // step 2: a is at the cap -> redirect
      { text: "b1" },
    ]);
    await startGc(h.driver, { moderator: "m", maxSpeakerRepeats: 1 });
    await h.driver.step("gc");
    await h.driver.step("gc");
    expect((await h.store.loadTranscript("gc")).map((e) => e.from)).toEqual(["m", "a", "m", "b"]);
  });

  test("a fixated moderator (repeated nomination over the cap) rotates, not monopolizes", async () => {
    // maxSpeakerRepeats 1 with the moderator always nominating 'a': the over-cap
    // redirect must rotate via leastSpoken over ALL participants (a, b, a, b) — not
    // pin 'a' (cap ignored) and not pin 'b' (excluding the nominee would).
    const h = gcHarness([
      { text: direct("a") },
      { text: "a1" },
      { text: direct("a") },
      { text: "b1" },
      { text: direct("a") },
      { text: "a2" },
      { text: direct("a") },
      { text: "b2" },
    ]);
    await startGc(h.driver, { moderator: "m", maxSpeakerRepeats: 1 }, 8);
    for (let i = 0; i < 4; i++) await h.driver.step("gc");
    const speakers = (await h.store.loadTranscript("gc"))
      .filter((e) => e.from !== "m")
      .map((e) => e.from);
    expect(speakers).toEqual(["a", "b", "a", "b"]);
  });

  test("a director direction (no callOn) steers the moderator's routing turn", async () => {
    const h = gcHarness([{ text: direct("a") }, { text: "a1" }]);
    await startGc(h.driver);
    await h.driver.inject("gc", { directionInjection: "wrap it up" });
    await h.driver.step("gc");
    // The steer reaches the moderator (who decides who speaks), not a bare speaker.
    expect(h.turns.requests[0]?.system).toBe("You are Mod.");
    expect(h.turns.requests[0]?.prompt).toContain("wrap it up");
  });

  test("the moderator's direction is NOT delivered to a redirected speaker", async () => {
    const h = gcHarness([
      { text: direct("a") },
      { text: "a1" }, // a=1 (at cap 1)
      { text: '{"action":"direct","next_speaker":"a","direction":"address the cost"}' },
      { text: "b1" }, // a over cap -> redirected to b
    ]);
    await startGc(h.driver, { moderator: "m", maxSpeakerRepeats: 1 }, 10);
    await h.driver.step("gc");
    await h.driver.step("gc");
    const froms = (await h.store.loadTranscript("gc")).map((e) => e.from);
    expect(froms).toEqual(["m", "a", "m", "b"]);
    // b got the turn via redirect, so the direction written for 'a' must not leak to b.
    expect(h.turns.requests[3]?.prompt).not.toContain("address the cost");
  });

  test("an invalid/unknown nominee falls back to the least-spoken participant", async () => {
    const h = gcHarness([
      { text: direct("a") }, // step 1: a speaks
      { text: "a1" },
      { text: direct("ghost") }, // step 2: unknown -> leastSpoken (b, unheard)
      { text: "b1" },
    ]);
    await startGc(h.driver);
    await h.driver.step("gc");
    await h.driver.step("gc");
    const froms = (await h.store.loadTranscript("gc")).map((e) => e.from);
    expect(froms).toEqual(["m", "a", "m", "b"]);
    expect(froms).not.toContain("ghost");
  });

  test("a persistently malformed moderator rotates speakers (no monopoly)", async () => {
    // No routing JSON in any moderator turn -> the fallback must distribute via
    // leastSpoken, not pin participants[0]. Expect a, b, a, b — not a, b, a, a.
    const h = gcHarness([
      { text: "musing 1" },
      { text: "a1" },
      { text: "musing 2" },
      { text: "b1" },
      { text: "musing 3" },
      { text: "a2" },
      { text: "musing 4" },
      { text: "b2" },
    ]);
    await startGc(h.driver, { moderator: "m" }, 8);
    for (let i = 0; i < 4; i++) await h.driver.step("gc");
    const speakers = (await h.store.loadTranscript("gc"))
      .filter((e) => e.from !== "m")
      .map((e) => e.from);
    expect(speakers).toEqual(["a", "b", "a", "b"]);
  });

  test("a malformed moderator reply still routes (deterministic nextUnheard)", async () => {
    const h = gcHarness([{ text: "no json here, just musing" }, { text: "a1" }]);
    await startGc(h.driver);
    expect(await h.driver.step("gc")).toBe("advanced");
    expect((await h.store.loadTranscript("gc")).map((e) => e.from)).toEqual(["m", "a"]);
  });

  test("a moderator tick that reaches turnBudget runs synthesis, not a speaker", async () => {
    const h = gcHarness([{ text: direct("a") }, { text: "should-not-run" }]);
    await startGc(h.driver, { moderator: "m" }, 1); // budget 1 -> the moderator tick hits it
    expect(await h.driver.step("gc")).toBe("ended");
    expect((await h.store.loadRoom("gc"))?.status).toBe("done");
    expect((await h.store.loadTranscript("gc")).map((e) => e.from)).toEqual(["m", "m"]);
    expect(h.turns.requests).toHaveLength(2); // no speaker turn was invoked, only synthesis
  });

  test("an unknown moderator fails the room closed", async () => {
    const h = gcHarness([{ text: "x" }]);
    await startGc(h.driver, { moderator: "ghost" });
    expect(await h.driver.step("gc")).toBe("ended");
    expect((await h.store.loadRoom("gc"))?.status).toBe("done");
    const t = await h.store.loadTranscript("gc");
    expect(t[0]?.role).toBe("system");
    expect(t[0]?.parts[0]?.text).toContain('unknown mind "ghost"');
  });

  test("a director cannot nominate the moderator as a speaker", async () => {
    const h = gcHarness([{ text: direct("a") }, { text: "a1" }]);
    await startGc(h.driver);
    await h.driver.inject("gc", { nextSpeaker: "m" }); // m is not a participant -> ignored
    await h.driver.step("gc");
    // The moderate flow still ran (moderator -> participant), m never spoke as a speaker.
    expect((await h.store.loadTranscript("gc")).map((e) => e.from)).toEqual(["m", "a"]);
    expect((await h.store.loadRoom("gc"))?.turnIndex).toBe(2);
  });

  test("the close gate blocks an early close (routes until all heard)", async () => {
    const h = gcHarness([{ text: '{"action":"close"}' }, { text: "a1" }]);
    await startGc(h.driver); // nobody has spoken -> close not yet allowed
    await h.driver.step("gc");
    expect((await h.store.loadTranscript("gc")).map((e) => e.from)).toEqual(["m", "a"]);
    expect((await h.store.loadRoom("gc"))?.status).toBe("active");
  });

  test("a gated close runs the synthesizer then ends the room", async () => {
    const h = gcHarness([
      { text: direct("a") },
      { text: "a1" },
      { text: direct("b") },
      { text: "b1" },
      { text: '{"action":"close"}' }, // both heard -> close allowed
      { text: "Synthesis." },
    ]);
    await startGc(h.driver, { moderator: "m", synthesizer: "s" }, 10);
    await h.driver.step("gc");
    await h.driver.step("gc");
    expect(await h.driver.step("gc")).toBe("ended");
    expect((await h.store.loadTranscript("gc")).map((e) => e.from)).toEqual([
      "m",
      "a",
      "m",
      "b",
      "m",
      "s",
    ]);
    expect((await h.store.loadRoom("gc"))?.status).toBe("done");
  });

  test("a synthesis turn that errors still closes the room", async () => {
    const h = gcHarness([
      { text: direct("a") },
      { text: "a1" },
      { text: direct("b") },
      { text: "b1" },
      { text: '{"action":"close"}' },
      { text: "", status: "error" }, // the synth turn errors
    ]);
    await startGc(h.driver, { moderator: "m", synthesizer: "s" }, 10);
    await h.driver.step("gc");
    await h.driver.step("gc");
    await h.driver.step("gc");
    const t = await h.store.loadTranscript("gc");
    expect(t[t.length - 1]?.from).toBe("s");
    expect((await h.store.loadRoom("gc"))?.status).toBe("done");
  });

  test("a gated close with no synthesizer ends the room without an extra turn", async () => {
    const h = gcHarness([
      { text: direct("a") },
      { text: "a1" },
      { text: direct("b") },
      { text: "b1" },
      { text: '{"action":"close"}' },
    ]);
    await startGc(h.driver, { moderator: "m" }, 10); // no synthesizer
    await h.driver.step("gc");
    await h.driver.step("gc");
    expect(await h.driver.step("gc")).toBe("ended");
    expect((await h.store.loadTranscript("gc")).map((e) => e.from)).toEqual([
      "m",
      "a",
      "m",
      "b",
      "m",
    ]);
    expect((await h.store.loadRoom("gc"))?.status).toBe("done");
  });

  test("the moderator's routing tail is stripped from the speaker's prompt but kept on disk", async () => {
    const h = gcHarness([
      { text: 'Hand off to Ada.\n{"action":"direct","next_speaker":"a","direction":"go deeper"}' },
      { text: "a1" },
    ]);
    await startGc(h.driver);
    await h.driver.step("gc");
    const speakerReq = h.turns.requests[1];
    if (!speakerReq) throw new Error("expected a speaker turn request");
    expect(speakerReq.prompt).not.toContain('"action":"direct"'); // routing JSON stripped
    expect(speakerReq.prompt).toContain("Hand off to Ada."); // deliberation prose survives
    expect(speakerReq.prompt).toContain("go deeper"); // the direction is injected for the speaker
    const t = await h.store.loadTranscript("gc");
    expect(t[0]?.parts[0]?.text).toContain('"action":"direct"'); // raw entry untouched on disk
  });

  test("a stop between the moderator and speaker turns finalizes cleanly", async () => {
    const { store } = makeFakeStore();
    const pub = makeFakePublisher();
    const turns = scriptedRunAgentTurn([{ text: direct("a") }, { text: "should-be-dropped" }]);
    let calls = 0;
    let releaseSecond: () => void = () => {};
    const secondMinds = new Promise<Mind[]>((r) => {
      releaseSecond = () => r(MINDS_GC);
    });
    const driver = createRoomDriver({
      store,
      publisher: pub.publisher,
      runAgentTurn: turns.run,
      // The moderator resolve (1st minds()) returns immediately; the speaker resolve
      // (2nd) blocks, so we can stop precisely between the two turns.
      minds: () => {
        calls += 1;
        return calls >= 2 ? secondMinds : MINDS_GC;
      },
      now: fixedClock(),
      newId: seqIds(),
    });
    await driver.start({
      slug: "gc",
      name: "GC",
      strategy: "group-chat",
      participants: ["a", "b"],
      turnBudget: 6,
      config: { moderator: "m" },
    });
    const stepP = driver.step("gc");
    await waitFor(() => calls >= 2); // the moderator committed; the speaker resolve is parked
    await driver.stop("gc"); // bumps the generation, aborts the shared controller
    releaseSecond();
    await stepP;
    const room = await store.loadRoom("gc");
    expect(room?.status).toBe("stopped");
    expect(room?.turnIndex).toBe(1); // only the moderator's tick landed
    // No phantom speaker entry: the aborted second turn never STARTED, so the
    // stopped room's transcript holds only the moderator turn.
    const t = await store.loadTranscript("gc");
    expect(t).toHaveLength(1);
    expect(t[0]?.from).toBe("m");
  });

  test("a stop after the routed speaker turn has STARTED records its aborted entry", async () => {
    const { store } = makeFakeStore();
    const pub = makeFakePublisher();
    // The moderator turn resolves (routing to a); the speaker turn stays in flight.
    const turns = scriptedThenAbortable(direct("a"));
    const driver = createRoomDriver({
      store,
      publisher: pub.publisher,
      runAgentTurn: turns.run,
      minds: () => MINDS_GC,
      now: fixedClock(),
      newId: seqIds(),
    });
    await startGc(driver);
    const stepP = driver.step("gc");
    await turns.secondStarted; // moderator committed; the speaker turn is mid-flight
    await driver.stop("gc"); // stop DURING the speaker turn (not before it started)
    await stepP;
    const t = await store.loadTranscript("gc");
    // The speaker turn had started, so its aborted entry is recorded — matching the
    // single-speaker path, not dropped as a phantom.
    expect(t.map((e) => e.from)).toEqual(["m", "a"]);
    expect(t[1]?.aborted).toBe(true);
    expect((await store.loadRoom("gc"))?.status).toBe("stopped");
  });
});

// open-floor (Slice 3): an unmoderated room — each step runs ONE speaker turn,
// and the driver routes the next from the prior turn's nomination tail. The
// strategy is pure (tier-3 seed/leastSpoken); all parsing (the end-vote close, the
// peer nomination) lives in the driver's decideOpenFloor, exercised here through
// the real getStrategy("open-floor"). Precedence: director > nomination > seed.
describe("room driver — open-floor", () => {
  const MINDS_OF: Mind[] = [
    { slug: "a", name: "Ada", role: "agent", persona: "You are Ada." },
    { slug: "b", name: "Bo", role: "agent", persona: "You are Bo." },
    { slug: "c", name: "Cy", role: "agent", persona: "You are Cy." },
  ];

  function ofHarness(scripts: TurnScript[], minds: Mind[] = MINDS_OF) {
    const { store } = makeFakeStore();
    const pub = makeFakePublisher();
    const turns = scriptedRunAgentTurn(scripts);
    const driver = createRoomDriver({
      store,
      publisher: pub.publisher,
      runAgentTurn: turns.run,
      minds: () => minds,
      now: fixedClock(),
      newId: seqIds(),
    });
    return { driver, store, pub, turns };
  }

  function startOf(
    driver: ReturnType<typeof createRoomDriver>,
    config: RoomConfig = {},
    participants: string[] = ["a", "b"],
    turnBudget = 6,
  ) {
    return driver.start({
      slug: "of",
      name: "OF",
      strategy: "open-floor",
      participants,
      turnBudget,
      config,
    });
  }

  const nominate = (slug: string, extra = "") => `${extra}{"action":"nominate","slug":"${slug}"}`;
  const endVote = (extra = "") => `${extra}{"action":"end"}`;

  test("the first turn is seeded to participants[0], then a valid nomination routes the next", async () => {
    const h = ofHarness([{ text: nominate("b", "Over to Bo.\n") }, { text: "b1" }]);
    await startOf(h.driver);
    expect(await h.driver.step("of")).toBe("advanced"); // seed -> a, which nominates b
    await h.driver.step("of"); // tier-2 nomination -> b
    expect((await h.store.loadTranscript("of")).map((e) => e.from)).toEqual(["a", "b"]);
    expect(h.turns.requests[0]?.system).toBe("You are Ada.");
    // The open-floor speaker is asked for the nominate/pass/end vocabulary.
    expect(h.turns.requests[0]?.prompt).toContain('"action":"nominate"');
  });

  test("a self-nomination falls back to the least-spoken participant", async () => {
    const h = ofHarness([{ text: nominate("a") }, { text: "b1" }]);
    await startOf(h.driver);
    await h.driver.step("of"); // a speaks, nominates itself
    await h.driver.step("of"); // self rejected -> leastSpoken -> b
    expect((await h.store.loadTranscript("of")).map((e) => e.from)).toEqual(["a", "b"]);
  });

  test("a non-participant nomination falls back to least-spoken", async () => {
    const h = ofHarness([{ text: nominate("ghost") }, { text: "b1" }]);
    await startOf(h.driver);
    await h.driver.step("of");
    await h.driver.step("of");
    const froms = (await h.store.loadTranscript("of")).map((e) => e.from);
    expect(froms).toEqual(["a", "b"]);
    expect(froms).not.toContain("ghost");
  });

  test("an over-cap nomination falls back to the least-spoken (unheard) participant", async () => {
    const h = ofHarness([
      { text: nominate("b") }, // a -> b
      { text: nominate("a") }, // b -> a, but a is already at the cap (1)
      { text: "c1" }, // over cap -> leastSpoken -> c (unheard)
    ]);
    await startOf(h.driver, { maxSpeakerRepeats: 1 }, ["a", "b", "c"]);
    await h.driver.step("of");
    await h.driver.step("of");
    await h.driver.step("of");
    expect((await h.store.loadTranscript("of")).map((e) => e.from)).toEqual(["a", "b", "c"]);
  });

  test("a director 'call on' override beats a conflicting agent nomination (tier 1 > tier 2)", async () => {
    const h = ofHarness([{ text: nominate("b") }, { text: "a2" }]);
    await startOf(h.driver);
    await h.driver.step("of"); // a speaks, nominates b
    await h.driver.inject("of", { nextSpeaker: "a" }); // director overrides the nomination
    await h.driver.step("of");
    // a (the override) speaks again, NOT b (the nominee).
    expect((await h.store.loadTranscript("of")).map((e) => e.from)).toEqual(["a", "a"]);
  });

  test("an end-vote closes the room once all have spoken and the threshold is passed", async () => {
    const h = ofHarness([{ text: endVote() }, { text: endVote() }]);
    await startOf(h.driver); // 2 Minds, default threshold 0.49
    await h.driver.step("of"); // a votes end
    await h.driver.step("of"); // b votes end -> both heard, ratio 1.0 > 0.49
    expect(await h.driver.step("of")).toBe("ended");
    expect((await h.store.loadRoom("of"))?.status).toBe("done");
    expect((await h.store.loadTranscript("of")).map((e) => e.from)).toEqual(["a", "b"]);
  });

  test("an end-vote at exactly the threshold does not close (strict >: 0.5 is not > 0.5)", async () => {
    const h = ofHarness([
      { text: nominate("b") }, // a -> b (a heard, not an end vote)
      { text: endVote() }, // b votes end (b heard); current ratio 1/2 = 0.5
      { text: nominate("b") }, // a speaks again rather than closing
    ]);
    await startOf(h.driver, { endVoteThreshold: 0.5 });
    await h.driver.step("of");
    await h.driver.step("of");
    expect(await h.driver.step("of")).toBe("advanced"); // 0.5 not > 0.5 -> keep going
    expect((await h.store.loadRoom("of"))?.status).toBe("active");
  });

  test("a nomination tail is stripped from the next speaker's prompt but kept on disk", async () => {
    const h = ofHarness([
      { text: 'Over to Bo.\n{"action":"nominate","slug":"b","reason":"data"}' },
      { text: "b1" },
    ]);
    await startOf(h.driver);
    await h.driver.step("of");
    await h.driver.step("of");
    const speakerReq = h.turns.requests[1];
    if (!speakerReq) throw new Error("expected a speaker turn request");
    expect(speakerReq.prompt).toContain("Over to Bo."); // deliberation prose survives
    // The concrete tail values are gone from rendered history (the instruction's
    // placeholder vocabulary, "slug":"<participant>", is unrelated).
    expect(speakerReq.prompt).not.toContain('"slug":"b"');
    const t = await h.store.loadTranscript("of");
    expect(t[0]?.parts[0]?.text).toContain('"slug":"b"'); // raw entry untouched on disk
  });

  test("a participant with no roster Mind fails the room closed", async () => {
    // 'ghost' leads the participant order, so the seed picks it; resolveMindOrFailClosed
    // records a system note and ends the room rather than hanging.
    const h = ofHarness([{ text: "unused" }]);
    await startOf(h.driver, {}, ["ghost", "a"]);
    expect(await h.driver.step("of")).toBe("ended");
    expect((await h.store.loadRoom("of"))?.status).toBe("done");
    const t = await h.store.loadTranscript("of");
    expect(t[0]?.role).toBe("system");
    expect(t[0]?.parts[0]?.text).toContain('unknown mind "ghost"');
  });
});

describe("room driver — concurrent (speak-parallel)", () => {
  const START_CONC = {
    slug: "demo",
    name: "Demo",
    strategy: "concurrent" as const,
    participants: ["a", "b"],
    turnBudget: 4,
  };

  function poolHarness() {
    const { store } = makeFakeStore();
    const pub = makeFakePublisher();
    const pool = gatedRunAgentTurnPool();
    const driver = createRoomDriver({
      store,
      publisher: pub.publisher,
      runAgentTurn: pool.run,
      minds: () => MINDS,
      now: fixedClock(),
      newId: seqIds(),
    });
    return { driver, store, pub, pool };
  }

  test("runs all participants in one parallel round, appended in participant order", async () => {
    const h = poolHarness();
    await h.driver.start(START_CONC);
    const stepP = h.driver.step("demo");
    await h.pool.started(2); // both turns are in flight at once — genuinely parallel
    expect(h.pool.requests).toHaveLength(2);
    // Release in REVERSE order: completion order must not affect append order.
    h.pool.release(1, "from bo");
    h.pool.release(0, "from ada");
    expect(await stepP).toBe("advanced");
    const t = await h.store.loadTranscript("demo");
    expect(t.map((e) => e.from)).toEqual(["a", "b"]); // participant order, not completion
    expect(t.map((e) => e.parts[0]?.text)).toEqual(["from ada", "from bo"]);
    expect(t.map((e) => e.turnIndex)).toEqual([0, 1]); // contiguous, seeded from current
    const room = await h.store.loadRoom("demo");
    expect(room?.turnIndex).toBe(2); // advanced by the batch size, not 1
    expect(room?.status).toBe("active"); // budget 4 not yet reached
  });

  test("publishes once per round (batched), not once per speaker", async () => {
    const h = harness([{ text: "x" }]); // scripted turns resolve immediately
    await h.driver.start({ ...START_CONC, turnBudget: 2 });
    const before = h.pub.all().length; // start published the seed frame
    await h.driver.step("demo"); // one parallel round of two -> done
    expect(h.pub.all().length).toBe(before + 2); // the batch publish, then the synthesis close
    expect(await h.store.loadTranscript("demo")).toHaveLength(3);
    expect((await h.store.loadRoom("demo"))?.status).toBe("done");
  });

  test("trims the batch to the remaining budget — a round never overshoots", async () => {
    // budget 3, 2 participants: round 1 = [a,b] (idx 0,1 -> turnIndex 2); round 2
    // has one slot left, so it trims to [a] (idx 2 -> turnIndex 3 -> done).
    const h = harness([{ text: "r" }]);
    await h.driver.start({ ...START_CONC, turnBudget: 3 });
    expect(await h.driver.step("demo")).toBe("advanced"); // round 1
    expect((await h.store.loadRoom("demo"))?.turnIndex).toBe(2);
    expect(await h.driver.step("demo")).toBe("ended"); // round 2: trimmed, hits budget
    const t = await h.store.loadTranscript("demo");
    expect(t.map((e) => e.from)).toEqual(["a", "b", "a", "a"]);
    const room = await h.store.loadRoom("demo");
    expect(room?.turnIndex).toBe(4);
    expect(room?.status).toBe("done");
  });

  test("an unknown participant fails the whole round closed (no partial round)", async () => {
    const { store } = makeFakeStore();
    const pub = makeFakePublisher();
    const pool = gatedRunAgentTurnPool();
    const driver = createRoomDriver({
      store,
      publisher: pub.publisher,
      runAgentTurn: pool.run,
      minds: () => MINDS, // only "a" and "b" exist
      now: fixedClock(),
      newId: seqIds(),
    });
    await driver.start({ ...START_CONC, participants: ["a", "ghost"] });
    expect(await driver.step("demo")).toBe("ended");
    expect((await store.loadRoom("demo"))?.status).toBe("done");
    // No speaker turn ran (the round failed closed at resolution); the only entry
    // is the system note for the unknown Mind.
    expect(pool.requests).toHaveLength(0);
    const t = await store.loadTranscript("demo");
    expect(t.some((e) => e.role === "system" && e.parts[0]?.text.includes("ghost"))).toBe(true);
  });

  test("dispose during a parallel round drops the whole batch (clean teardown)", async () => {
    const h = poolHarness();
    await h.driver.start(START_CONC);
    const stepP = h.driver.step("demo");
    await h.pool.started(2);
    await h.driver.dispose(); // aborts the shared controller + flags disposed
    h.pool.releaseAll(); // the turns settle after teardown
    await stepP;
    // Disposed mid-round -> the batch is dropped: nothing appended or published.
    expect(await h.store.loadTranscript("demo")).toHaveLength(0);
  });

  test("a stop after the turns settle but before the commit drops the batch from the board", async () => {
    const h = poolHarness();
    await h.driver.start(START_CONC); // generation 1
    const stepP = h.driver.step("demo");
    await h.pool.started(2);
    await h.driver.stop("demo"); // bumps the generation, aborts, saves the stopped frame
    h.pool.releaseAll(); // the gen-1 round settles after the stop
    await stepP;
    const room = await h.store.loadRoom("demo");
    expect(room?.status).toBe("stopped");
    expect(room?.turnIndex).toBe(0); // the generation-gated batch never advanced it
    // The append-only disk entries survive (contained by the fresh-slug invariant),
    // but the batch never reached the cache/board: the last frame is the stopped one.
    expect((await h.store.loadTranscript("demo")).length).toBe(2);
    const last = h.pub.last();
    if (last?.view !== "board") throw new Error("expected a board view");
    expect(last.header?.status?.label).toBe("stopped");
    const items = debateRows(last);
    // The gen-1 batch was gated out of the board — the only feed row is the
    // termination marker the stopped frame carries.
    expect(items).toHaveLength(1);
    expect(items[0]?.text).toBe("Stopped");
  });

  test("a director nextSpeaker override routes a single speaker, then parallel rounds resume", async () => {
    const h = harness([{ text: "r" }]);
    await h.driver.start({ ...START_CONC, turnBudget: 6 });
    await h.driver.inject("demo", { nextSpeaker: "b" }); // steer a concurrent room to one Mind
    expect(await h.driver.step("demo")).toBe("advanced");
    // The override collapses this one step to a single speaker — the same one-shot
    // semantics every other strategy gives a director override — advancing by 1, not
    // a full parallel round.
    expect((await h.store.loadTranscript("demo")).map((e) => e.from)).toEqual(["b"]);
    expect((await h.store.loadRoom("demo"))?.turnIndex).toBe(1);
    // The next step has no pending override, so the parallel cadence resumes.
    expect(await h.driver.step("demo")).toBe("advanced");
    expect((await h.store.loadTranscript("demo")).map((e) => e.from)).toEqual(["b", "a", "b"]);
    expect((await h.store.loadRoom("demo"))?.turnIndex).toBe(3);
  });

  test("a turn-seam failure aborts the in-flight siblings and propagates (no orphaned calls)", async () => {
    const { store } = makeFakeStore();
    const pub = makeFakePublisher();
    const fake = throwingThenAbortable("turn seam failed");
    const driver = createRoomDriver({
      store,
      publisher: pub.publisher,
      runAgentTurn: fake.run,
      minds: () => MINDS,
      now: fixedClock(),
      newId: seqIds(),
    });
    await driver.start(START_CONC);
    // The first speaker's turn throws -> Promise.all short-circuits. The round must
    // abort the shared controller (cancel the sibling) and await it to settle before
    // propagating, rather than dropping the controller with a turn still in flight.
    await expect(driver.step("demo")).rejects.toThrow("turn seam failed");
    expect(fake.abortedSibling()).toBe(true); // the sibling's controller was aborted
    expect(fake.settledSibling()).toBe(true); // and awaited to settle (not orphaned)
  });

  test("a stop during the identity compose cancels the round before any agent turn is invoked", async () => {
    const { store } = makeFakeStore();
    const pub = makeFakePublisher();
    const turns = scriptedRunAgentTurn([{ text: "should not run" }]);
    let enterSoul: () => void = () => {};
    const soulEntered = new Promise<void>((resolve) => {
      enterSoul = resolve;
    });
    let releaseSoul: () => void = () => {};
    const soulGate = new Promise<void>((resolve) => {
      releaseSoul = resolve;
    });
    const driver = createRoomDriver({
      store,
      publisher: pub.publisher,
      runAgentTurn: turns.run,
      minds: () => MINDS,
      composeTurnSystem: async () => {
        enterSoul();
        await soulGate; // suspend the round inside the (async) identity compose
        return "soul";
      },
      now: fixedClock(),
      newId: seqIds(),
    });
    await driver.start(START_CONC);
    const stepP = driver.step("demo");
    await soulEntered; // the parallel round is now suspended in the SOUL read
    await driver.stop("demo"); // stop while the reads are in flight
    releaseSoul(); // the reads resolve AFTER the stop
    await stepP;
    // The post-read re-check finalizes each turn as aborted without invoking the
    // agent, so a quick stop fans out zero agent calls.
    expect(turns.requests).toHaveLength(0);
    expect((await store.loadRoom("demo"))?.status).toBe("stopped");
  });
});
