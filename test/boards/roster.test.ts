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
});
