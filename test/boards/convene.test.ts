import { describe, expect, test } from "bun:test";
import { canvasViewSchema } from "@keelson/shared";
import { buildConveneBoard, type ConveneProject } from "../../src/boards/convene.ts";
import type { Mind } from "../../src/types.ts";

const mind = (over: Partial<Mind> = {}): Mind => ({
  slug: "ada",
  name: "Ada",
  role: "Chief of Staff",
  persona: "You are Ada.",
  ...over,
});

const A = mind({ slug: "a", name: "Ada", identitySlot: 0, provider: "anthropic" });
const B = mind({ slug: "b", name: "Bo", identitySlot: 1, provider: "openai" });
const C = mind({ slug: "c", name: "Cy", identitySlot: 2, provider: "anthropic" });

function section(board: ReturnType<typeof buildConveneBoard>, title: string) {
  return board.sections.find((s) => s.kind === "actions" && s.title === title);
}
function chips(board: ReturnType<typeof buildConveneBoard>) {
  const s = section(board, "Who’s in");
  return s?.kind === "actions" ? s.items : [];
}
function shapes(board: ReturnType<typeof buildConveneBoard>) {
  const s = section(board, "…and how");
  return s?.kind === "actions" ? s.items : [];
}
function byStrategy(board: ReturnType<typeof buildConveneBoard>) {
  return new Map(shapes(board).map((i) => [(i.payload as { strategy: string }).strategy, i]));
}

describe("buildConveneBoard cast + shapes", () => {
  test("under two Minds it is a single nudge, no chips or shapes; valid", () => {
    const board = buildConveneBoard([A]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(chips(board)).toHaveLength(0);
    expect(shapes(board)).toHaveLength(0);
    expect(board.sections[0]?.kind).toBe("rows");
  });

  test("at two Minds: identity-toned draft-set chips + a tabs strip of five shapes", () => {
    const board = buildConveneBoard([A, B]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const cs = chips(board);
    expect(cs.map((c) => c.type)).toEqual(["draft-set", "draft-set"]);
    expect(cs.map((c) => c.tone)).toEqual(["id-blue", "id-amber"]);
    expect(cs.map((c) => c.glyph)).toEqual(["✓", "✓"]);
    expect(cs.map((c) => c.payload)).toEqual([{ slug: "a" }, { slug: "b" }]);
    const how = section(board, "…and how");
    expect(how?.kind === "actions" && how.tabs).toBe(true);
    expect(shapes(board).map((i) => i.label)).toEqual([
      "Discussion",
      "Debate",
      "Open floor",
      "Review",
      "Delegate",
    ]);
    expect(shapes(board).map((i) => (i.payload as { strategy: string }).strategy)).toEqual([
      "sequential",
      "group-chat",
      "open-floor",
      "review",
      "magentic",
    ]);
  });

  test("an excluded slug renders unselected (+); shapes drop below two selected", () => {
    const board = buildConveneBoard([A, B], new Set(["a"]));
    const a = chips(board).find((c) => (c.payload as { slug: string }).slug === "a");
    expect(a?.glyph).toBe("+");
    expect(shapes(board)).toHaveLength(0);
  });

  test("every shape carries a purpose hint — enabled and gated alike", () => {
    // Three Minds all in: Discussion, Debate, and Delegate enabled (three selected —
    // two run, one facilitates), Review gated (not a pair). A gated tab must still
    // carry its hint so the hover reminder survives the disable, joined with the
    // reason by the host.
    const board = buildConveneBoard([A, B, C]);
    const bs = byStrategy(board);
    for (const item of shapes(board)) {
      expect(typeof item.hint).toBe("string");
      expect(item.hint?.length ?? 0).toBeGreaterThan(0);
    }
    expect(bs.get("review")?.disabled).toBe(true);
    expect(bs.get("review")?.hint).toContain("cross-vendor");
    expect(bs.get("group-chat")?.disabled ?? false).toBe(false);
    expect(bs.get("magentic")?.disabled ?? false).toBe(false);
    expect(bs.get("sequential")?.disabled ?? false).toBe(false);
    expect(bs.get("sequential")?.hint).toContain("Round-robin");
  });
});

describe("buildConveneBoard capability gating", () => {
  test("Debate/Delegate are disabled (need a third to facilitate) with only two selected", () => {
    const bs = byStrategy(buildConveneBoard([A, B]));
    expect(bs.get("group-chat")?.disabled).toBe(true);
    expect(bs.get("group-chat")?.reason).toContain("chair");
    // A gated shape carries no form (a disabled tab can't open one).
    expect(bs.get("group-chat")?.fields).toBeUndefined();
    expect(bs.get("magentic")?.disabled).toBe(true);
    expect(bs.get("magentic")?.reason).toContain("manage");
  });

  test("Debate enables at three selected with a chair select drawn from the cast", () => {
    // All three selected → any of them can be named chair; the other two debate.
    const board = buildConveneBoard([A, B, C]);
    const debate = byStrategy(board).get("group-chat");
    expect(debate?.disabled ?? false).toBe(false);
    const chair = debate?.fields?.find((f) => f.name === "moderator");
    expect(chair?.required).toBe(true);
    expect(chair?.options).toEqual([
      { value: "a", label: "Ada" },
      { value: "b", label: "Bo" },
      { value: "c", label: "Cy" },
    ]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
  });

  test("Review needs exactly two Minds of different vendors", () => {
    // Same vendor (A + C both anthropic) → disabled.
    const same = byStrategy(buildConveneBoard([A, C])).get("review");
    expect(same?.disabled).toBe(true);
    expect(same?.reason).toContain("vendors");
    // Different vendors (A anthropic + B openai) → enabled.
    const cross = byStrategy(buildConveneBoard([A, B])).get("review");
    expect(cross?.disabled ?? false).toBe(false);
    // Three selected → not a pair → disabled.
    const trio = byStrategy(buildConveneBoard([A, B, C])).get("review");
    expect(trio?.disabled).toBe(true);
  });

  test("Review is disabled when a provider is unpinned", () => {
    const unpinned = mind({ slug: "d", name: "Di", identitySlot: 3 });
    const review = byStrategy(buildConveneBoard([A, unpinned])).get("review");
    expect(review?.disabled).toBe(true);
    expect(review?.reason).toContain("provider");
  });
});

describe("buildConveneBoard project picker + collapse", () => {
  const projects: ConveneProject[] = [
    { id: "p1", name: "keelson" },
    { id: "p2", name: "chamber" },
  ];

  test("Discussion carries a project select over the host projects", () => {
    const board = buildConveneBoard([A, B], new Set(), projects);
    const proj = byStrategy(board)
      .get("sequential")
      ?.fields?.find((f) => f.name === "project");
    expect(proj?.options).toEqual([
      { value: "p1", label: "keelson" },
      { value: "p2", label: "chamber" },
    ]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
  });

  test("no project field when the host exposes no projects", () => {
    const bs = byStrategy(buildConveneBoard([A, B]));
    expect(bs.get("sequential")?.fields?.some((f) => f.name === "project")).toBe(false);
  });

  test("defaultCollapsed follows the session count (folds once rooms exist)", () => {
    expect(buildConveneBoard([A, B], new Set(), [], 0).header?.defaultCollapsed).toBe(false);
    expect(buildConveneBoard([A, B], new Set(), [], 2).header?.defaultCollapsed).toBe(true);
  });
});
