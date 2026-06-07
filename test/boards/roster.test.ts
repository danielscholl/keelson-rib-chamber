import { describe, expect, test } from "bun:test";
import { canvasViewSchema } from "@keelson/shared";
import { buildRosterBoard } from "../../src/boards/roster.ts";
import type { Mind } from "../../src/types.ts";

const mind = (over: Partial<Mind> = {}): Mind => ({
  slug: "ada",
  name: "Ada",
  persona: "You are Ada.",
  ...over,
});

describe("buildRosterBoard", () => {
  test("empty roster is a valid board", () => {
    const board = buildRosterBoard([]);
    expect(board.view).toBe("board");
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
  });

  test("one card per mind; title=name, pill=slug", () => {
    const board = buildRosterBoard([mind(), mind({ slug: "bo", name: "Bo" })]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const section = board.sections[0];
    expect(section?.kind).toBe("cards");
    if (section?.kind === "cards") {
      expect(section.items).toHaveLength(2);
      expect(section.items[0]?.title).toBe("Ada");
      expect(section.items[0]?.pill?.label).toBe("ada");
    }
  });

  test("surfaces model and tools when present", () => {
    const board = buildRosterBoard([mind({ model: "claude-x", tools: ["web", "bash"] })]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
  });

  test("bakes a Start-room action carrying all mind slugs once there are >= 2", () => {
    const board = buildRosterBoard([mind({ slug: "a" }), mind({ slug: "b", name: "Bo" })]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const actions = board.sections.find((s) => s.kind === "actions");
    if (actions?.kind !== "actions") throw new Error("no actions section");
    expect(actions.items[0]?.type).toBe("room-start");
    // No slug: the server assigns a fresh one per start.
    expect(actions.items[0]?.payload).toMatchObject({ participants: ["a", "b"] });
  });

  test("offers no start action with fewer than two minds (not a conversation)", () => {
    expect(buildRosterBoard([]).sections.some((s) => s.kind === "actions")).toBe(false);
    expect(buildRosterBoard([mind()]).sections.some((s) => s.kind === "actions")).toBe(false);
  });
});
