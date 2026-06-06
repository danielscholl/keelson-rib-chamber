import { describe, expect, test } from "bun:test";
import { sequential } from "../../src/strategies/sequential.ts";
import type { Room } from "../../src/types.ts";

function room(overrides: Partial<Room> = {}): Room {
  return {
    slug: "r",
    name: "R",
    strategy: "sequential",
    participants: ["a", "b"],
    status: "active",
    turnBudget: 10,
    turnIndex: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("sequential strategy", () => {
  test("round-robins over participants by turnIndex", () => {
    expect(sequential(room({ turnIndex: 0 }))).toEqual({ kind: "speak", mind: "a" });
    expect(sequential(room({ turnIndex: 1 }))).toEqual({ kind: "speak", mind: "b" });
    expect(sequential(room({ turnIndex: 2 }))).toEqual({ kind: "speak", mind: "a" });
  });

  test("ends at the turn budget", () => {
    expect(sequential(room({ turnIndex: 10, turnBudget: 10 }))).toEqual({ kind: "end" });
  });

  test("ends when not active", () => {
    expect(sequential(room({ status: "stopped" }))).toEqual({ kind: "end" });
  });

  test("ends with no participants", () => {
    expect(sequential(room({ participants: [] }))).toEqual({ kind: "end" });
  });

  test("is pure (same input, same output, no mutation)", () => {
    const r = room({ turnIndex: 1 });
    const snapshot = JSON.stringify(r);
    expect(sequential(r)).toEqual(sequential(r));
    expect(JSON.stringify(r)).toBe(snapshot);
  });
});
