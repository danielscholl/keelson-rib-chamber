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

// All action-button items across every actions section of a board (the roster
// can emit both a Room section and a Retire section).
function actionItems(board: ReturnType<typeof buildRosterBoard>) {
  return board.sections.flatMap((s) => (s.kind === "actions" ? s.items : []));
}

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
    const start = actionItems(board).find((i) => i.type === "room-start");
    expect(start).toBeDefined();
    // No slug: the server assigns a fresh one per start.
    expect(start?.payload).toMatchObject({ participants: ["a", "b"] });
  });

  test("offers no Start-room action with fewer than two minds (not a conversation)", () => {
    const hasStart = (minds: Mind[]) =>
      actionItems(buildRosterBoard(minds)).some((i) => i.type === "room-start");
    expect(hasStart([])).toBe(false);
    expect(hasStart([mind()])).toBe(false);
  });

  test("bakes a destructive Retire action per mind, carrying the slug", () => {
    const board = buildRosterBoard([mind({ slug: "a" }), mind({ slug: "b", name: "Bo" })]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const retire = actionItems(board).filter((i) => i.type === "retire");
    expect(retire).toHaveLength(2);
    expect(retire[0]).toMatchObject({ type: "retire", destructive: true, payload: { slug: "a" } });
    // Each button carries ITS own mind's slug, not all the first one (delete path).
    expect(retire[1]).toMatchObject({ type: "retire", destructive: true, payload: { slug: "b" } });
  });

  test("offers Retire even for a single mind (its slug is on the card)", () => {
    expect(
      actionItems(buildRosterBoard([mind({ slug: "solo" })])).some((i) => i.type === "retire"),
    ).toBe(true);
  });

  test("an empty roster has no action sections at all", () => {
    expect(buildRosterBoard([]).sections.some((s) => s.kind === "actions")).toBe(false);
  });
});
