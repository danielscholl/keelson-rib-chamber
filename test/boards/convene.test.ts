import { describe, expect, test } from "bun:test";
import type { CanvasBoardView } from "@keelson/shared";
import { canvasViewSchema } from "@keelson/shared";
import { type ConveneProject, conveneShapeSection } from "../../src/boards/convene.ts";
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

type Section = CanvasBoardView["sections"][number];

// conveneShapeSection returns one section; wrap it in a minimal board so the shared
// canvas schema still validates the shape the merged bench will publish.
function valid(section: Section): boolean {
  return canvasViewSchema.safeParse({ view: "board", sections: [section] }).success;
}
function shapes(section: Section) {
  return section.kind === "actions" ? section.items : [];
}
function byStrategy(cast: readonly Mind[], projects: readonly ConveneProject[] = []) {
  const section = conveneShapeSection(cast, projects);
  return new Map(shapes(section).map((i) => [(i.payload as { strategy: string }).strategy, i]));
}

describe("conveneShapeSection cast + shapes", () => {
  test("under two seated it prompts to seat more (no shape tabs); valid", () => {
    for (const cast of [[], [A]]) {
      const section = conveneShapeSection(cast);
      expect(valid(section)).toBe(true);
      expect(section.kind).toBe("rows");
      expect(section.kind === "rows" && section.items[0]?.text).toContain("Seat two or more");
    }
  });

  test("at two seated: a tabs strip of the five shapes", () => {
    const section = conveneShapeSection([A, B]);
    expect(valid(section)).toBe(true);
    expect(section.kind === "actions" && section.title).toBe("…and how");
    expect(section.kind === "actions" && section.tabs).toBe(true);
    expect(shapes(section).map((i) => i.label)).toEqual([
      "Discussion",
      "Debate",
      "Open floor",
      "Review",
      "Delegate",
    ]);
    expect(shapes(section).map((i) => (i.payload as { strategy: string }).strategy)).toEqual([
      "sequential",
      "group-chat",
      "open-floor",
      "review",
      "magentic",
    ]);
  });

  test("every shape shows only its name — the description rides the hover hint", () => {
    // Three seated: Discussion, Debate, and Delegate enabled (three — two run, one
    // facilitates), Review gated (not a pair). A gated tab still carries its hover hint.
    const bs = byStrategy([A, B, C]);
    for (const item of shapes(conveneShapeSection([A, B, C]))) {
      expect(item.subtitle).toBeUndefined();
      expect(typeof item.hint).toBe("string");
      expect(item.hint?.length ?? 0).toBeGreaterThan(0);
      expect(item.submitLabel).toBe("Convene");
    }
    expect(bs.get("review")?.disabled).toBe(true);
    expect(bs.get("review")?.hint).toContain("cross-vendor");
    expect(bs.get("group-chat")?.disabled ?? false).toBe(false);
    expect(bs.get("magentic")?.disabled ?? false).toBe(false);
    expect(bs.get("sequential")?.disabled ?? false).toBe(false);
    expect(bs.get("sequential")?.hint).toContain("Round-robin");
  });
});

describe("conveneShapeSection capability gating", () => {
  test("Debate/Delegate are disabled (need a third to facilitate) with only two seated", () => {
    const bs = byStrategy([A, B]);
    expect(bs.get("group-chat")?.disabled).toBe(true);
    expect(bs.get("group-chat")?.reason).toContain("chair");
    // A gated shape carries no form (a disabled tab can't open one).
    expect(bs.get("group-chat")?.fields).toBeUndefined();
    expect(bs.get("magentic")?.disabled).toBe(true);
    expect(bs.get("magentic")?.reason).toContain("manage");
  });

  test("Debate enables at three seated with a chair select drawn from the cast", () => {
    const section = conveneShapeSection([A, B, C]);
    const debate = byStrategy([A, B, C]).get("group-chat");
    expect(debate?.disabled ?? false).toBe(false);
    const chair = debate?.fields?.find((f) => f.name === "moderator");
    expect(chair?.required).toBe(true);
    expect(chair?.options).toEqual([
      { value: "a", label: "Ada" },
      { value: "b", label: "Bo" },
      { value: "c", label: "Cy" },
    ]);
    expect(valid(section)).toBe(true);
  });

  test("Review needs exactly two seated of different vendors", () => {
    // Same vendor (A + C both anthropic) → disabled.
    expect(byStrategy([A, C]).get("review")?.disabled).toBe(true);
    expect(byStrategy([A, C]).get("review")?.reason).toContain("vendors");
    // Different vendors (A anthropic + B openai) → enabled.
    expect(byStrategy([A, B]).get("review")?.disabled ?? false).toBe(false);
    // Three seated → not a pair → disabled.
    expect(byStrategy([A, B, C]).get("review")?.disabled).toBe(true);
  });

  test("Review is disabled when a provider is unpinned", () => {
    const unpinned = mind({ slug: "d", name: "Di", identitySlot: 3 });
    const review = byStrategy([A, unpinned]).get("review");
    expect(review?.disabled).toBe(true);
    expect(review?.reason).toContain("provider");
  });
});

describe("conveneShapeSection project picker + grounding", () => {
  const projects: ConveneProject[] = [
    { id: "p1", name: "keelson" },
    { id: "p2", name: "chamber" },
  ];

  test("Discussion carries a project select over the host projects", () => {
    const section = conveneShapeSection([A, B], projects);
    const proj = byStrategy([A, B], projects)
      .get("sequential")
      ?.fields?.find((f) => f.name === "project");
    expect(proj?.options).toEqual([
      { value: "p1", label: "keelson" },
      { value: "p2", label: "chamber" },
    ]);
    expect(valid(section)).toBe(true);
  });

  test("no project field when the host exposes no projects", () => {
    expect(
      byStrategy([A, B])
        .get("sequential")
        ?.fields?.some((f) => f.name === "project"),
    ).toBe(false);
  });

  test("the design-bearing shapes expose the grounding source + criteria fields", () => {
    const bs = byStrategy([A, B, C]);
    for (const strategy of ["sequential", "group-chat", "open-floor", "magentic"]) {
      const names = bs.get(strategy)?.fields?.map((f) => f.name) ?? [];
      expect(names).toContain("groundingUrl");
      expect(names).toContain("criteria");
    }
    const criteria = bs.get("sequential")?.fields?.find((f) => f.name === "criteria");
    expect(criteria?.multiline).toBe(true);
  });

  test("Review carries no grounding fields — its cross-vendor pass is not a synthesis close", () => {
    const names =
      byStrategy([A, B])
        .get("review")
        ?.fields?.map((f) => f.name) ?? [];
    expect(names).not.toContain("groundingUrl");
    expect(names).not.toContain("criteria");
  });
});
