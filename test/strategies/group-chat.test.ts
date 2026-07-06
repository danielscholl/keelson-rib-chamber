import { describe, expect, test } from "bun:test";
import { groupChat } from "../../src/strategies/group-chat.ts";
import type { Room, StrategyInput } from "../../src/types.ts";

function room(overrides: Partial<Room> = {}): Room {
  return {
    slug: "r",
    name: "R",
    strategy: "group-chat",
    participants: ["a", "b"],
    status: "active",
    turnBudget: 10,
    turnIndex: 0,
    round: 0,
    config: { moderator: "mod" },
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function input(overrides: Partial<Room> = {}): StrategyInput {
  return { room: room(overrides), transcript: [] };
}

describe("group-chat strategy (pure rhythm)", () => {
  test("hands control to the configured moderator while active", () => {
    expect(groupChat(input())).toEqual({ kind: "moderate", mind: "mod" });
  });

  test("ends when not active", () => {
    expect(groupChat(input({ status: "stopped" }))).toEqual({ kind: "end" });
  });

  test("ends with no participants", () => {
    expect(groupChat(input({ participants: [] }))).toEqual({ kind: "end" });
  });

  test("synthesizes with the moderator at the turn budget", () => {
    expect(groupChat(input({ turnIndex: 10, turnBudget: 10 }))).toEqual({
      kind: "synthesize",
      mind: "mod",
    });
  });

  test("ends when no moderator is configured", () => {
    expect(groupChat(input({ config: {} }))).toEqual({ kind: "end" });
    expect(groupChat(input({ config: undefined }))).toEqual({ kind: "end" });
  });

  test("is pure (same input, same output, no mutation)", () => {
    const inp = input();
    const snapshot = JSON.stringify(inp);
    expect(groupChat(inp)).toEqual(groupChat(inp));
    expect(JSON.stringify(inp)).toBe(snapshot);
  });
});
