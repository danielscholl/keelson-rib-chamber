import { describe, expect, test } from "bun:test";
import { concurrent } from "../../src/strategies/concurrent.ts";
import type { Room, StrategyInput } from "../../src/types.ts";

function room(overrides: Partial<Room> = {}): Room {
  return {
    slug: "r",
    name: "R",
    strategy: "concurrent",
    participants: ["a", "b", "c"],
    status: "active",
    turnBudget: 10,
    turnIndex: 0,
    round: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function input(overrides: Partial<Room> = {}): StrategyInput {
  return { room: room(overrides), transcript: [] };
}

describe("concurrent strategy", () => {
  test("fans every participant out in one parallel round (does not rotate by turnIndex)", () => {
    expect(concurrent(input({ turnIndex: 0 }))).toEqual({
      kind: "speak-parallel",
      minds: ["a", "b", "c"],
    });
    // turnIndex does not narrow the batch — the driver trims to the remaining budget.
    expect(concurrent(input({ turnIndex: 1 }))).toEqual({
      kind: "speak-parallel",
      minds: ["a", "b", "c"],
    });
  });

  test("ends at the turn budget", () => {
    expect(concurrent(input({ turnIndex: 10, turnBudget: 10 }))).toEqual({ kind: "end" });
  });

  test("ends when not active", () => {
    expect(concurrent(input({ status: "stopped" }))).toEqual({ kind: "end" });
  });

  test("ends with no participants", () => {
    expect(concurrent(input({ participants: [] }))).toEqual({ kind: "end" });
  });

  test("never emits an empty parallel batch (ends instead, so the driver always spawns >=1)", () => {
    const step = concurrent(input({ participants: [] }));
    expect(step.kind).toBe("end");
    const live = concurrent(input({ participants: ["a"], turnIndex: 0, turnBudget: 2 }));
    expect(live).toEqual({ kind: "speak-parallel", minds: ["a"] });
  });

  test("is pure (same input, same output, no mutation)", () => {
    const inp = input({ turnIndex: 2 });
    const snapshot = JSON.stringify(inp);
    expect(concurrent(inp)).toEqual(concurrent(inp));
    expect(JSON.stringify(inp)).toBe(snapshot);
  });
});
