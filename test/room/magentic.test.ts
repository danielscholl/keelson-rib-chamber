import { describe, expect, test } from "bun:test";
import type { CanvasView } from "@keelson/shared";
import type { RoomStore } from "../../src/ports.ts";
import { createRoomDriver } from "../../src/room.ts";
import type { Mind } from "../../src/types.ts";
import {
  fixedClock,
  makeFakePublisher,
  makeFakeStore,
  scriptedRunAgentTurn,
  scriptedThenAbortable,
  seqIds,
  type TurnScript,
} from "../helpers/fakes.ts";

const MINDS: Mind[] = [
  { slug: "mgr", name: "Manager", role: "manager", persona: "You manage." },
  { slug: "alice", name: "Alice", role: "worker", persona: "You are Alice." },
  { slug: "bob", name: "Bob", role: "worker", persona: "You are Bob." },
];

const START = {
  slug: "demo",
  name: "Demo",
  strategy: "magentic" as const,
  participants: ["alice", "bob"],
  turnBudget: 8,
  topic: "ship the feature",
  config: { manager: "mgr" },
};

// Trailing-JSON manager directives (the same wire form parseMagenticPlan reads).
const planTail = (tasks: { description: string; assignee?: string }[]) =>
  `Here is the plan.\n${JSON.stringify({ action: "plan", tasks })}`;
const doneTail = (summary = "all set") =>
  `We are finished.\n${JSON.stringify({ action: "done", summary })}`;

function makeDriver(scripts: TurnScript[], store: RoomStore, idPrefix = "id") {
  const pub = makeFakePublisher();
  const turns = scriptedRunAgentTurn(scripts);
  const driver = createRoomDriver({
    store,
    publisher: pub.publisher,
    runAgentTurn: turns.run,
    minds: () => MINDS,
    now: fixedClock(),
    newId: seqIds(idPrefix),
  });
  return { driver, pub, turns };
}

function harness(scripts: TurnScript[]) {
  const { store } = makeFakeStore();
  return { store, ...makeDriver(scripts, store) };
}

// The trailing (status [· result]) of each task row across every published board, so
// a test can assert the plan's progression as the operator would see it.
function planTrailings(views: { slug: string; view: CanvasView }[]): string[] {
  const out: string[] = [];
  for (const { view } of views) {
    if (view.view !== "board") continue;
    const plan = view.sections.find((s) => s.kind === "rows" && s.title?.startsWith("Plan"));
    if (plan?.kind !== "rows") continue;
    for (const item of plan.items) if (item.trailing) out.push(item.trailing);
  }
  return out;
}

describe("magentic driver", () => {
  test("decomposes a goal, assigns each worker, tracks to completion, then closes", async () => {
    const h = harness([
      {
        text: planTail([
          { description: "build the parser", assignee: "alice" },
          { description: "wire the api", assignee: "bob" },
        ]),
      }, // turn 0: manage
      { text: "parser built" }, // turn 1: alice
      { text: "api wired" }, // turn 2: bob
      { text: doneTail("shipped") }, // turn 3: manage -> done
    ]);
    await h.driver.start(START);

    // manage -> a two-task executing plan
    expect(await h.driver.step("demo")).toBe("advanced");
    const ledger = await h.store.loadLedger("demo");
    expect(ledger?.status).toBe("executing");
    expect(ledger?.tasks.map((t) => [t.assignee, t.status])).toEqual([
      ["alice", "pending"],
      ["bob", "pending"],
    ]);

    // assign alice's task, then bob's — each settles completed
    expect(await h.driver.step("demo")).toBe("advanced");
    expect((await h.store.loadLedger("demo"))?.tasks[0]).toMatchObject({
      assignee: "alice",
      status: "completed",
    });
    expect(await h.driver.step("demo")).toBe("advanced");
    expect((await h.store.loadLedger("demo"))?.tasks[1]).toMatchObject({
      assignee: "bob",
      status: "completed",
    });

    // manage reviews and closes the plan; the room stays active for one more step
    expect(await h.driver.step("demo")).toBe("advanced");
    expect((await h.store.loadLedger("demo"))?.status).toBe("done");
    expect((await h.store.loadRoom("demo"))?.status).toBe("active");

    // the strategy then ends the room (the plan is done)
    expect(await h.driver.step("demo")).toBe("ended");
    expect((await h.store.loadRoom("demo"))?.status).toBe("done");
    // the manager's plan/done turns are in the transcript (4 turns: manage, 2 work, manage)
    expect(await h.store.loadTranscript("demo")).toHaveLength(4);
  });

  test("a manager that declares done immediately closes the room without draining budget", async () => {
    // Regression: a done/empty plan on turn 0 settles the ledger to done + []; the
    // strategy must end the room, not re-run a paid manage turn every step to budget.
    const h = harness([{ text: doneTail("nothing to do") }]);
    await h.driver.start(START); // turnBudget 8
    expect(await h.driver.step("demo")).toBe("advanced"); // the single manage turn
    expect((await h.store.loadLedger("demo"))?.status).toBe("done");
    expect(await h.driver.step("demo")).toBe("ended"); // closes — no second manage
    expect((await h.store.loadRoom("demo"))?.status).toBe("done");
    expect((await h.store.loadRoom("demo"))?.turnIndex).toBe(1); // exactly ONE paid turn
    expect(await h.store.loadTranscript("demo")).toHaveLength(1);
  });

  test("an errored manage turn retries instead of closing the room as a false done", async () => {
    const h = harness([
      { text: "boom", status: "error" }, // manage turn 0 errors before planning
      { text: planTail([{ description: "do it", assignee: "alice" }]) }, // manage retry succeeds
      { text: "did it" }, // assign alice
      { text: doneTail() }, // manage -> done
    ]);
    await h.driver.start(START);
    await h.driver.step("demo"); // manage errors -> ledger preserved, room stays active
    expect((await h.store.loadRoom("demo"))?.status).toBe("active");
    expect((await h.store.loadLedger("demo"))?.status).not.toBe("done"); // not a false success
    await h.driver.step("demo"); // manage retry -> plans t1
    expect((await h.store.loadLedger("demo"))?.tasks).toHaveLength(1);
    await h.driver.step("demo"); // assign alice
    await h.driver.step("demo"); // manage -> done
    expect(await h.driver.step("demo")).toBe("ended");
    expect((await h.store.loadRoom("demo"))?.status).toBe("done");
  });

  test("a nextSpeaker override is ignored for a magentic room (the manager routes)", async () => {
    const h = harness([
      { text: planTail([{ description: "do it", assignee: "alice" }]) }, // manage -> t1(alice)
      { text: "did it" }, // the ledger assign (alice), not a forced bob turn
    ]);
    await h.driver.start(START);
    await h.driver.step("demo"); // manage -> t1(alice) pending
    await h.driver.inject("demo", { nextSpeaker: "bob" }); // a stale board / raw-API override
    await h.driver.step("demo"); // runs the ledger assign (alice/t1), NOT bob
    expect((await h.store.loadLedger("demo"))?.tasks[0]).toMatchObject({
      assignee: "alice",
      status: "completed",
    });
    const transcript = await h.store.loadTranscript("demo");
    const lastAgent = [...transcript].reverse().find((e) => e.role === "agent");
    expect(lastAgent?.from).toBe("alice"); // bob never got an off-plan turn
  });

  test("replans on a failed (errored) task — the room continues", async () => {
    const h = harness([
      { text: planTail([{ description: "wire the api", assignee: "alice" }]) }, // manage
      { text: "boom", status: "error" }, // alice errors -> failed
      { text: planTail([{ description: "wire the api another way", assignee: "bob" }]) }, // manage replans
      { text: "done via bob" }, // bob -> completed
      { text: doneTail() }, // manage -> done
    ]);
    await h.driver.start(START);
    await h.driver.step("demo"); // manage -> t1(alice)
    await h.driver.step("demo"); // assign alice -> errors
    expect((await h.store.loadLedger("demo"))?.tasks[0]?.status).toBe("failed");
    // an errored task is NOT an operator stop — the room keeps going
    expect((await h.store.loadRoom("demo"))?.status).toBe("active");

    await h.driver.step("demo"); // manage replans -> appends t2(bob)
    expect((await h.store.loadLedger("demo"))?.tasks.map((t) => t.status)).toEqual([
      "failed",
      "pending",
    ]);
    await h.driver.step("demo"); // assign bob -> completed
    expect((await h.store.loadLedger("demo"))?.tasks[1]?.status).toBe("completed");
    await h.driver.step("demo"); // manage -> done
    expect(await h.driver.step("demo")).toBe("ended"); // strategy closes the room
    expect((await h.store.loadRoom("demo"))?.status).toBe("done");
  });

  test("an agent-aborted worker turn fails the task (not completed) and stops the room", async () => {
    const h = harness([
      { text: planTail([{ description: "do it", assignee: "alice" }]) }, // manage
      { text: "", status: "aborted" }, // alice's turn reports aborted (agent-side, no operator stop)
    ]);
    await h.driver.start(START);
    await h.driver.step("demo"); // manage -> plan
    await h.driver.step("demo"); // assign alice -> aborted
    // The task did not finish, so it settles failed, NOT completed.
    expect((await h.store.loadLedger("demo"))?.tasks[0]?.status).toBe("failed");
    expect((await h.store.loadRoom("demo"))?.status).toBe("stopped");
  });

  test("the ledger persists across a process restart and the resumed board renders it", async () => {
    const { store } = makeFakeStore();
    // driver 1 plans, then is disposed (a process going away mid-room).
    const d1 = makeDriver(
      [{ text: planTail([{ description: "do a", assignee: "alice" }]) }],
      store,
    );
    await d1.driver.start(START);
    await d1.driver.step("demo"); // manage -> one pending task, ledger persisted
    await d1.driver.dispose();
    expect((await store.loadLedger("demo"))?.tasks).toHaveLength(1);

    // driver 2 (a fresh process) over the same store resumes the still-active room.
    const d2 = makeDriver([{ text: "did a" }], store, "id2");
    await d2.driver.start(START); // resume — re-publishes the board
    const resumed = d2.pub.last();
    if (resumed?.view !== "board") throw new Error("expected a board");
    expect(resumed.sections.some((s) => s.kind === "rows" && s.title?.startsWith("Plan"))).toBe(
      true,
    );

    // and the loop continues from the persisted ledger (assigns the pending task)
    expect(await d2.driver.step("demo")).toBe("advanced");
    expect((await store.loadLedger("demo"))?.tasks[0]?.status).toBe("completed");
  });

  test("the turn budget bounds the loop", async () => {
    const h = harness([
      {
        text: planTail([
          { description: "a", assignee: "alice" },
          { description: "b", assignee: "bob" },
          { description: "c", assignee: "alice" },
        ]),
      },
      { text: "1" },
      { text: "2" },
      { text: "3" },
    ]);
    await h.driver.start({ ...START, turnBudget: 2 });
    expect(await h.driver.step("demo")).toBe("advanced"); // manage (turnIndex 1)
    expect(await h.driver.step("demo")).toBe("ended"); // one work turn hits the budget
    expect((await h.store.loadRoom("demo"))?.status).toBe("done");
    expect((await h.store.loadRoom("demo"))?.turnIndex).toBe(3);
  });

  test("stopping during a worker turn stops the room", async () => {
    const { store } = makeFakeStore();
    const pub = makeFakePublisher();
    // the manage turn resolves immediately (the plan); the assign turn stays in flight
    // until aborted, so a stop can land mid-worker-turn.
    const scripted = scriptedThenAbortable(
      planTail([{ description: "long task", assignee: "alice" }]),
    );
    const driver = createRoomDriver({
      store,
      publisher: pub.publisher,
      runAgentTurn: scripted.run,
      minds: () => MINDS,
      now: fixedClock(),
      newId: seqIds(),
    });
    await driver.start(START);
    await driver.step("demo"); // manage -> plan
    const assignStep = driver.step("demo"); // assign alice -> in flight
    await scripted.secondStarted;
    // The task is in-progress while the worker turn runs.
    expect((await store.loadLedger("demo"))?.tasks[0]?.status).toBe("in-progress");
    await driver.stop("demo");
    await assignStep;
    expect((await store.loadRoom("demo"))?.status).toBe("stopped");
    // The stop settles the in-progress task so a reopened board shows no phantom live
    // work (a stopped room has no manage turn to recover it).
    expect((await store.loadLedger("demo"))?.tasks[0]?.status).toBe("failed");
  });

  test("an assign step publishes in-progress before it settles to completed", async () => {
    const h = harness([
      { text: planTail([{ description: "do it", assignee: "alice" }]) },
      { text: "did it" },
    ]);
    await h.driver.start(START);
    await h.driver.step("demo"); // manage
    await h.driver.step("demo"); // assign alice
    const trailings = planTrailings(h.pub.published);
    expect(trailings.some((t) => t.startsWith("in-progress"))).toBe(true);
    expect(trailings.some((t) => t.startsWith("completed"))).toBe(true);
  });
});
