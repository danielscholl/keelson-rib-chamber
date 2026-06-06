import { describe, expect, test } from "bun:test";
import { canvasViewSchema } from "@keelson/shared";
import { buildRoomBoard } from "../../src/boards/room.ts";
import type { Room, TurnEntry } from "../../src/types.ts";

const room = (over: Partial<Room> = {}): Room => ({
  slug: "r",
  name: "Room",
  strategy: "sequential",
  participants: ["a", "b"],
  status: "active",
  turnBudget: 6,
  turnIndex: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const entry = (over: Partial<TurnEntry> = {}): TurnEntry => ({
  messageId: "m",
  roomSlug: "r",
  turnIndex: 0,
  from: "a",
  role: "agent",
  parts: [{ text: "hello" }],
  at: "2026-01-01T00:00:00.000Z",
  ...over,
});

describe("buildRoomBoard", () => {
  test("empty transcript is valid; segments per participant with n=0", () => {
    const board = buildRoomBoard(room(), []);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.header?.segments).toEqual([
      { label: "a", n: 0 },
      { label: "b", n: 0 },
    ]);
  });

  test("one row per entry; segment counts match agent turns", () => {
    const board = buildRoomBoard(room(), [
      entry({ from: "a" }),
      entry({ from: "b" }),
      entry({ from: "a" }),
      entry({ from: "director", role: "director", parts: [{ text: "steer" }] }),
    ]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const section = board.sections[0];
    expect(section?.kind).toBe("rows");
    if (section?.kind === "rows") expect(section.items).toHaveLength(4);
    expect(board.header?.segments).toEqual([
      { label: "a", n: 2 },
      { label: "b", n: 1 },
    ]);
  });

  test("empty turn text is coalesced to a placeholder (text min(1))", () => {
    const board = buildRoomBoard(room(), [entry({ parts: [{ text: "" }] })]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
  });

  test("aborted entries and every status tone stay valid", () => {
    for (const status of ["active", "stopped", "done"] as const) {
      const board = buildRoomBoard(room({ status }), [
        entry({ aborted: true, parts: [{ text: "" }] }),
      ]);
      expect(canvasViewSchema.safeParse(board).success).toBe(true);
    }
  });
});
