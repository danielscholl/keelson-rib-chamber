import { describe, expect, test } from "bun:test";
import { openFloor } from "../../src/strategies/open-floor.ts";
import type { Room, StrategyInput, TurnEntry } from "../../src/types.ts";

function room(overrides: Partial<Room> = {}): Room {
  return {
    slug: "r",
    name: "R",
    strategy: "open-floor",
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

function input(transcript: TurnEntry[] = [], overrides: Partial<Room> = {}): StrategyInput {
  return { room: room(overrides), transcript };
}

describe("open-floor strategy (pure tier-3 seed/fallback)", () => {
  test("seeds the first participant on an empty transcript", () => {
    expect(openFloor(input())).toEqual({ kind: "speak", mind: "a" });
  });

  test("falls back to the least-spoken participant", () => {
    // a spoke twice, b once -> b is least-spoken
    const transcript = [agentEntry("a"), agentEntry("b"), agentEntry("a")];
    expect(openFloor(input(transcript))).toEqual({ kind: "speak", mind: "b" });
  });

  test("ends when not active", () => {
    expect(openFloor(input([], { status: "stopped" }))).toEqual({ kind: "end" });
  });

  test("ends with no participants", () => {
    expect(openFloor(input([], { participants: [] }))).toEqual({ kind: "end" });
  });

  test("ends at the turn budget", () => {
    expect(openFloor(input([], { turnIndex: 10, turnBudget: 10 }))).toEqual({ kind: "end" });
  });

  test("is pure (same input, same output, no mutation)", () => {
    const inp = input([agentEntry("a")]);
    const snapshot = JSON.stringify(inp);
    expect(openFloor(inp)).toEqual(openFloor(inp));
    expect(JSON.stringify(inp)).toBe(snapshot);
  });
});
