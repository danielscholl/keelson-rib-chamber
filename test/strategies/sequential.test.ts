import { describe, expect, test } from "bun:test";
import { sequential } from "../../src/strategies/sequential.ts";
import type { Room, StrategyInput, TurnEntry } from "../../src/types.ts";

function room(overrides: Partial<Room> = {}): Room {
  return {
    slug: "r",
    name: "R",
    strategy: "sequential",
    participants: ["a", "b"],
    status: "active",
    turnBudget: 10,
    turnIndex: 0,
    round: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const agentEntry = (from: string): TurnEntry => ({
  messageId: "m",
  roomSlug: "r",
  turnIndex: 0,
  from,
  role: "agent",
  parts: [{ text: "hi" }],
  at: "2026-01-01T00:00:00.000Z",
});

function input(overrides: Partial<Room> = {}, transcript: TurnEntry[] = []): StrategyInput {
  return { room: room(overrides), transcript };
}

describe("sequential strategy", () => {
  test("round-robins over participants by turnIndex", () => {
    expect(sequential(input({ turnIndex: 0 }))).toEqual({ kind: "speak", mind: "a" });
    expect(sequential(input({ turnIndex: 1 }))).toEqual({ kind: "speak", mind: "b" });
    expect(sequential(input({ turnIndex: 2 }))).toEqual({ kind: "speak", mind: "a" });
  });

  test("synthesizes with the last speaker at the turn budget", () => {
    expect(sequential(input({ turnIndex: 10, turnBudget: 10 }, [agentEntry("b")]))).toEqual({
      kind: "synthesize",
      mind: "b",
    });
  });

  test("ends when not active", () => {
    expect(sequential(input({ status: "stopped" }))).toEqual({ kind: "end" });
  });

  test("ends with no participants", () => {
    expect(sequential(input({ participants: [] }))).toEqual({ kind: "end" });
  });

  test("is pure (same input, same output, no mutation)", () => {
    const inp = input({ turnIndex: 1 });
    const snapshot = JSON.stringify(inp);
    expect(sequential(inp)).toEqual(sequential(inp));
    expect(JSON.stringify(inp)).toBe(snapshot);
  });
});
