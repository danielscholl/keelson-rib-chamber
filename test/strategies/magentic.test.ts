import { describe, expect, test } from "bun:test";
import { magentic, resolveAssignee } from "../../src/strategies/magentic.ts";
import type { LedgerTask, Room, StrategyInput, TaskLedger, TurnEntry } from "../../src/types.ts";

function room(over: Partial<Room> = {}): Room {
  return {
    slug: "r",
    name: "R",
    strategy: "magentic",
    participants: ["alice", "bob"],
    status: "active",
    turnBudget: 8,
    turnIndex: 0,
    round: 0,
    config: { manager: "mgr" },
    topic: "ship it",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

const task = (over: Partial<LedgerTask> = {}): LedgerTask => ({
  id: "t1",
  description: "x",
  status: "pending",
  createdAt: "t",
  updatedAt: "t",
  ...over,
});

const ledger = (over: Partial<TaskLedger> = {}): TaskLedger => ({
  roomSlug: "r",
  goal: "ship it",
  manager: "mgr",
  status: "executing",
  tasks: [],
  updatedAt: "t",
  ...over,
});

function input(
  over: { room?: Partial<Room>; ledger?: TaskLedger; transcript?: TurnEntry[] } = {},
): StrategyInput {
  return {
    room: room(over.room),
    transcript: over.transcript ?? [],
    ...(over.ledger ? { ledger: over.ledger } : {}),
  };
}

describe("magentic strategy", () => {
  test("no ledger -> the manager plans", () => {
    expect(magentic(input())).toEqual({ kind: "manage", mind: "mgr" });
  });

  test("an empty ledger -> the manager plans", () => {
    expect(magentic(input({ ledger: ledger({ status: "planning" }) }))).toEqual({
      kind: "manage",
      mind: "mgr",
    });
  });

  test("a closed plan (done) -> end", () => {
    const l = ledger({ status: "done", tasks: [task({ status: "completed" })] });
    expect(magentic(input({ ledger: l }))).toEqual({ kind: "end" });
  });

  test("a pending task -> assign to its assignee", () => {
    const l = ledger({ tasks: [task({ id: "t1", assignee: "bob" })] });
    expect(magentic(input({ ledger: l }))).toEqual({ kind: "assign", mind: "bob", taskId: "t1" });
  });

  test("a pending task with no assignee -> assign to the least-spoken worker", () => {
    const l = ledger({ tasks: [task({ id: "t1" })] });
    // alice & bob both unheard -> leastSpoken returns the first by participant order.
    expect(magentic(input({ ledger: l }))).toEqual({ kind: "assign", mind: "alice", taskId: "t1" });
  });

  test("only later tasks pending -> assigns the first pending one", () => {
    const l = ledger({
      tasks: [task({ id: "t1", status: "completed" }), task({ id: "t2", assignee: "bob" })],
    });
    expect(magentic(input({ ledger: l }))).toEqual({ kind: "assign", mind: "bob", taskId: "t2" });
  });

  test("all tasks settled but plan not closed -> the manager replans", () => {
    const l = ledger({
      tasks: [task({ status: "completed" }), task({ id: "t2", status: "failed" })],
    });
    expect(magentic(input({ ledger: l }))).toEqual({ kind: "manage", mind: "mgr" });
  });

  test("ends on the structural cases", () => {
    expect(magentic(input({ room: { status: "stopped" } }))).toEqual({ kind: "end" });
    expect(magentic(input({ room: { participants: [] } }))).toEqual({ kind: "end" });
    expect(magentic(input({ room: { turnIndex: 8, turnBudget: 8 } }))).toEqual({ kind: "end" });
    expect(magentic(input({ room: { config: {} } }))).toEqual({ kind: "end" }); // no manager
  });

  test("is pure (same input, same output, no mutation)", () => {
    const inp = input({ ledger: ledger({ tasks: [task({ assignee: "bob" })] }) });
    const snapshot = JSON.stringify(inp);
    expect(magentic(inp)).toEqual(magentic(inp));
    expect(JSON.stringify(inp)).toBe(snapshot);
  });
});

describe("resolveAssignee", () => {
  const agent = (from: string): TurnEntry => ({
    messageId: "m",
    roomSlug: "r",
    turnIndex: 0,
    from,
    role: "agent",
    parts: [{ text: "x" }],
    at: "t",
  });

  test("keeps an assignee that names a current worker", () => {
    expect(resolveAssignee(task({ assignee: "bob" }), ["alice", "bob"], [])).toBe("bob");
  });

  test("drops an invalid assignee and routes to the least-spoken worker", () => {
    expect(resolveAssignee(task({ assignee: "ghost" }), ["alice", "bob"], [])).toBe("alice");
  });

  test("spreads load to the least-spoken worker", () => {
    expect(resolveAssignee(task({}), ["alice", "bob"], [agent("alice")])).toBe("bob");
  });
});
