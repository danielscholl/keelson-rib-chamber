import { describe, expect, test } from "bun:test";
import { applyManagerPlan, failStuckTasks, freshLedger, setTaskStatus } from "../src/ledger.ts";
import type { MagenticPlan } from "../src/routing.ts";
import type { LedgerTask, TaskLedger, TaskStatus } from "../src/types.ts";

const NOW = () => new Date("2026-01-01T00:00:00.000Z");
function clock() {
  let n = 0;
  return { now: NOW, newId: () => `t-${++n}` };
}

const ledger = (over: Partial<TaskLedger> = {}): TaskLedger => ({
  roomSlug: "r",
  goal: "ship it",
  manager: "mgr",
  status: "planning",
  tasks: [],
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const task = (status: TaskStatus, over: Partial<LedgerTask> = {}): LedgerTask => ({
  id: "id",
  description: "do a thing",
  status,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

describe("freshLedger", () => {
  test("starts empty in planning status", () => {
    expect(freshLedger("r", "ship it", "mgr", NOW)).toMatchObject({
      roomSlug: "r",
      goal: "ship it",
      manager: "mgr",
      status: "planning",
      tasks: [],
    });
  });
});

describe("applyManagerPlan", () => {
  test("a plan appends pending tasks and goes executing", () => {
    const plan: MagenticPlan = {
      action: "plan",
      tasks: [
        { description: "build parser", assignee: "alice" },
        { description: "wire api", assignee: "bob" },
      ],
    };
    const out = applyManagerPlan(ledger(), plan, ["alice", "bob"], clock());
    expect(out.status).toBe("executing");
    expect(out.tasks.map((t) => [t.description, t.assignee, t.status])).toEqual([
      ["build parser", "alice", "pending"],
      ["wire api", "bob", "pending"],
    ]);
  });

  test("drops an assignee that is not a worker", () => {
    const plan: MagenticPlan = { action: "plan", tasks: [{ description: "x", assignee: "ghost" }] };
    expect(
      applyManagerPlan(ledger(), plan, ["alice", "bob"], clock()).tasks[0]?.assignee,
    ).toBeUndefined();
  });

  test("done closes the plan", () => {
    const out = applyManagerPlan(
      ledger({ status: "executing", tasks: [task("completed")] }),
      { action: "done", tasks: [], summary: "ok" },
      ["alice"],
      clock(),
    );
    expect(out.status).toBe("done");
  });

  test("a replan dedups a re-listed non-failed task (case/space-insensitive)", () => {
    const existing = ledger({
      status: "executing",
      tasks: [task("completed", { description: "build parser" })],
    });
    const plan: MagenticPlan = {
      action: "plan",
      tasks: [{ description: "  Build   Parser " }, { description: "write tests" }],
    };
    const out = applyManagerPlan(existing, plan, ["alice"], clock());
    expect(out.tasks.map((t) => t.description)).toEqual(["build parser", "write tests"]);
    expect(out.status).toBe("executing");
  });

  test("a failed task can be re-listed (retry) — not deduped", () => {
    const existing = ledger({
      status: "executing",
      tasks: [task("failed", { description: "wire api" })],
    });
    const out = applyManagerPlan(
      existing,
      { action: "plan", tasks: [{ description: "wire api" }] },
      ["alice"],
      clock(),
    );
    expect(out.tasks).toHaveLength(2);
    expect(out.tasks[1]).toMatchObject({ description: "wire api", status: "pending" });
  });

  test("a null plan on an exhausted ledger closes it (no manage->manage hang)", () => {
    const existing = ledger({ status: "executing", tasks: [task("completed")] });
    expect(applyManagerPlan(existing, null, ["alice"], clock()).status).toBe("done");
  });

  test("a null plan on an empty ledger closes it (the manager planned nothing)", () => {
    const out = applyManagerPlan(ledger(), null, ["alice"], clock());
    expect(out.status).toBe("done");
    expect(out.tasks).toHaveLength(0);
  });
});

describe("setTaskStatus", () => {
  test("settles a task and stamps a result, without closing the plan", () => {
    const out = setTaskStatus(
      ledger({ status: "executing", tasks: [task("pending", { id: "x" })] }),
      "x",
      "completed",
      { now: NOW },
      "done it",
    );
    expect(out.tasks[0]).toMatchObject({ status: "completed", result: "done it" });
    expect(out.status).toBe("executing"); // only the manager closes the plan
  });

  test("an unknown id is a no-op (same reference)", () => {
    const l = ledger({ tasks: [task("pending", { id: "x" })] });
    expect(setTaskStatus(l, "zzz", "completed", { now: NOW })).toBe(l);
  });
});

describe("failStuckTasks", () => {
  test("fails a lingering in-progress task (interrupted)", () => {
    const out = failStuckTasks(
      ledger({ status: "executing", tasks: [task("in-progress", { id: "x" })] }),
      { now: NOW },
    );
    expect(out.tasks[0]).toMatchObject({ status: "failed", result: "interrupted" });
  });

  test("no in-progress task -> unchanged reference", () => {
    const l = ledger({ tasks: [task("completed")] });
    expect(failStuckTasks(l, { now: NOW })).toBe(l);
  });
});
