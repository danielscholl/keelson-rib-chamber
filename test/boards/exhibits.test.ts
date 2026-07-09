import { describe, expect, test } from "bun:test";
import { canvasViewSchema } from "@keelson/shared";
import { buildExhibitsIndexBoard } from "../../src/boards/exhibits.ts";
import type { LensRecord } from "../../src/lens-store.ts";

const exhibit = (over: Partial<LensRecord> = {}): LensRecord => ({
  id: "sample-assessment",
  board: { view: "board", title: "Sample Assessment", sections: [] },
  updatedAt: "2026-01-01T00:00:00.000Z",
  kind: "exhibit",
  ...over,
});

function cards(board: ReturnType<typeof buildExhibitsIndexBoard>) {
  const section = board.sections.find((s) => s.kind === "cards");
  if (section?.kind !== "cards") throw new Error("no cards section");
  return section.items;
}

describe("buildExhibitsIndexBoard empty", () => {
  test("no exhibits → ZERO sections, so the region's hideWhenEmpty folds the shelf away", () => {
    const board = buildExhibitsIndexBoard([]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.sections).toEqual([]);
    expect(board.header?.status?.label).toBe("0 exhibits");
  });
});

describe("buildExhibitsIndexBoard cards", () => {
  test("one card per exhibit, validated against the canvas schema", () => {
    const board = buildExhibitsIndexBoard([
      exhibit(),
      exhibit({ id: "q3-plan", board: { view: "board", title: "Q3 Plan", sections: [] } }),
    ]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.header?.status?.label).toBe("2 exhibits");
    expect(cards(board).map((c) => c.title)).toEqual(["Sample Assessment", "Q3 Plan"]);
  });

  test("provenance is fail-soft: from/gist render only when present", () => {
    const board = buildExhibitsIndexBoard([
      exhibit({ sourceRoom: "sample-review", reason: "honest promise, empty shelf" }),
      exhibit({ id: "bare", board: { view: "board", title: "", sections: [] } }),
    ]);
    const [full, bare] = cards(board);
    expect(full?.fields?.map((f) => f.label)).toEqual(["from", "tabled"]);
    expect(full?.fields?.[0]?.value).toBe("room · sample-review");
    expect(full?.reason).toEqual({ label: "gist", text: "honest promise, empty shelf" });
    // An untitled board falls back to the id; no from/gist when absent.
    expect(bare?.title).toBe("bare");
    expect(bare?.fields?.map((f) => f.label)).toEqual(["tabled"]);
    expect(bare?.reason).toBeUndefined();
  });

  test("each card carries Open plus a confirmed, destructive Delete", () => {
    const [card] = cards(buildExhibitsIndexBoard([exhibit()]));
    const actions = card?.actions ?? [];
    expect(actions.map((a) => a.type)).toEqual(["lens-open", "delete-exhibit"]);
    const del = actions[1];
    expect(del?.destructive).toBe(true);
    expect(del?.payload).toEqual({ id: "sample-assessment" });
    expect(del?.confirm?.title).toBe("Delete exhibit");
    expect(del?.confirm?.body).toContain("Sample Assessment");
  });

  test("the from field resolves the witnessed slug to the room's name, falling back to the raw value", () => {
    const room = {
      slug: "room-m3xyz-0",
      name: "Sample Review",
      status: "done",
      createdAt: "2026-01-01T00:00:00.000Z",
      participants: [],
      turnIndex: 2,
      turnBudget: 2,
      round: 0,
      strategy: "group-chat",
    } as never;
    const board = buildExhibitsIndexBoard(
      [
        exhibit({ sourceRoom: "room-m3xyz-0" }),
        // A deleted room (or a legacy record stamped with the display name)
        // shows its raw sourceRoom rather than dropping the provenance.
        exhibit({ id: "orphan", sourceRoom: "room-gone-1" }),
      ],
      [room],
    );
    const [resolved, orphan] = cards(board);
    expect(resolved?.fields?.[0]?.value).toBe("room · Sample Review");
    expect(orphan?.fields?.[0]?.value).toBe("room · room-gone-1");
  });
});
