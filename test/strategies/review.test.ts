import { describe, expect, test } from "bun:test";
import { review } from "../../src/strategies/review.ts";
import type { Room, StrategyInput } from "../../src/types.ts";

function room(overrides: Partial<Room> = {}): Room {
  return {
    slug: "r",
    name: "R",
    strategy: "review",
    participants: ["author", "reviewer"],
    status: "active",
    turnBudget: 8,
    turnIndex: 0,
    round: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function input(overrides: Partial<Room> = {}): StrategyInput {
  return { room: room(overrides), transcript: [] };
}

describe("review strategy (pure rhythm)", () => {
  test("turn 0 routes to the author (participants[0])", () => {
    expect(review(input({ turnIndex: 0 }))).toEqual({ kind: "speak", mind: "author" });
  });

  test("turn 1 routes to the reviewer (participants[1])", () => {
    expect(review(input({ turnIndex: 1 }))).toEqual({ kind: "speak", mind: "reviewer" });
  });

  test("ends after the reviewer turn", () => {
    expect(review(input({ turnIndex: 2 }))).toEqual({ kind: "end" });
  });

  test("ends when not active", () => {
    expect(review(input({ status: "stopped" }))).toEqual({ kind: "end" });
  });

  test("ends with fewer than two participants", () => {
    expect(review(input({ participants: ["author"] }))).toEqual({ kind: "end" });
  });

  test("ends at the turn budget — exempt from exhaustion synthesis, the critique is the close", () => {
    expect(review(input({ turnIndex: 2, turnBudget: 2 }))).toEqual({ kind: "end" });
  });

  test("is pure (same input, same output, no mutation)", () => {
    const inp = input();
    const snapshot = JSON.stringify(inp);
    expect(review(inp)).toEqual(review(inp));
    expect(JSON.stringify(inp)).toBe(snapshot);
  });
});
