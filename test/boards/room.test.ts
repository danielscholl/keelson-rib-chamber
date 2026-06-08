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

  test("an active room bakes Call-on-<participant> + Stop controls carrying the slug", () => {
    const board = buildRoomBoard(room({ slug: "r", participants: ["a", "b"] }), []);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const actions = board.sections.find((s) => s.kind === "actions");
    expect(actions?.kind).toBe("actions");
    if (actions?.kind !== "actions") throw new Error("no actions section");
    const byType = (t: string) => actions.items.filter((i) => i.type === t);
    // No manual "Next": turns auto-advance, so a manual stepper would only race
    // the loop.
    expect(byType("room-next")).toHaveLength(0);
    expect(byType("room-stop")[0]?.payload).toEqual({ slug: "r" });
    const calls = byType("room-inject").map((i) => i.payload);
    expect(calls).toEqual([
      { slug: "r", nextSpeaker: "a" },
      { slug: "r", nextSpeaker: "b" },
    ]);
  });

  test("a closed room offers a single Start-again carrying the same config", () => {
    for (const status of ["stopped", "done"] as const) {
      const board = buildRoomBoard(room({ status, participants: ["a", "b"], turnBudget: 6 }), []);
      const actions = board.sections.find((s) => s.kind === "actions");
      if (actions?.kind !== "actions") throw new Error("no actions section");
      expect(actions.items.map((i) => i.type)).toEqual(["room-start"]);
      // No slug: the server assigns a fresh one per start.
      expect(actions.items[0]?.payload).toMatchObject({ turnBudget: 6, participants: ["a", "b"] });
    }
  });

  test("a room with a topic shows it as a leading Topic section", () => {
    const board = buildRoomBoard(room({ topic: "Ship strategies before lenses?" }), []);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const first = board.sections[0];
    expect(first?.kind).toBe("rows");
    if (first?.kind === "rows") {
      expect(first.title).toBe("Topic");
      expect(first.items[0]?.text).toBe("Ship strategies before lenses?");
    }
  });

  test("no Topic section when the room has no topic", () => {
    const board = buildRoomBoard(room(), []);
    const titled = board.sections.find((s) => s.kind === "rows" && s.title === "Topic");
    expect(titled).toBeUndefined();
  });

  test("Start-again carries the room's topic so a restart keeps its subject", () => {
    const board = buildRoomBoard(room({ status: "done", topic: "Q3 roadmap" }), []);
    const actions = board.sections.find((s) => s.kind === "actions");
    if (actions?.kind !== "actions") throw new Error("no actions section");
    expect(actions.items[0]?.payload).toMatchObject({ topic: "Q3 roadmap" });
  });
});
