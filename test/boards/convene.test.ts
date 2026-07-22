import { describe, expect, test } from "bun:test";
import type { CanvasBoardView } from "@keelson/shared";
import { canvasViewSchema } from "@keelson/shared";
import {
  type ConveneProject,
  conveneScopeSection,
  conveneShapeSection,
} from "../../src/boards/convene.ts";
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
function byStrategy(cast: readonly Mind[]) {
  const section = conveneShapeSection(cast);
  return new Map(shapes(section).map((i) => [(i.payload as { strategy: string }).strategy, i]));
}
function fieldNames(item: { fields?: readonly { name: string }[] } | undefined): string[] {
  return (item?.fields ?? []).map((f) => f.name);
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
    expect(section.kind === "actions" && section.title).toBe("How should they convene?");
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

  test("every shape describes itself inline, and still carries the fuller hover hint", () => {
    // Three seated: Discussion, Debate, and Delegate enabled (three — two run, one
    // facilitates), Review gated (not a pair). A gated tab still carries its hover hint.
    const bs = byStrategy([A, B, C]);
    for (const item of shapes(conveneShapeSection([A, B, C]))) {
      // Both registers, and distinct: the subtitle orients at a glance, the hint explains.
      expect(item.subtitle?.length ?? 0).toBeGreaterThan(0);
      expect(item.hint?.length ?? 0).toBeGreaterThan(0);
      expect(item.subtitle).not.toBe(item.hint);
      expect(item.submitLabel).toBe("Convene");
      expect(item.submitTone).toBe("brand");
    }
    expect(bs.get("review")?.disabled).toBe(true);
    expect(bs.get("review")?.hint).toContain("cross-vendor");
    expect(bs.get("group-chat")?.disabled ?? false).toBe(false);
    expect(bs.get("magentic")?.disabled ?? false).toBe(false);
    expect(bs.get("sequential")?.disabled ?? false).toBe(false);
    expect(bs.get("sequential")?.hint).toContain("Round-robin");
    expect(bs.get("sequential")?.subtitle).toContain("Round-robin");
  });

  test("the strip opens on Discussion — the default shape, and never a gated one", () => {
    const bs = byStrategy([A, B, C]);
    expect(bs.get("sequential")?.defaultOpen).toBe(true);
    for (const strategy of ["group-chat", "open-floor", "review", "magentic"]) {
      expect(bs.get(strategy)?.defaultOpen).toBeUndefined();
    }
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

  test("Debate enables at three seated with a chair picker drawn from the cast", () => {
    const section = conveneShapeSection([A, B, C]);
    const debate = byStrategy([A, B, C]).get("group-chat");
    expect(debate?.disabled ?? false).toBe(false);
    const chair = debate?.fields?.find((f) => f.name === "moderator");
    expect(chair?.required).toBe(true);
    expect(chair?.segmented).toBe(true);
    expect(chair?.options).toEqual([
      { value: "a", label: "Ada" },
      { value: "b", label: "Bo" },
      { value: "c", label: "Cy" },
    ]);
    expect(valid(section)).toBe(true);
  });

  test("a full table falls back to a select rather than a wrapping strip", () => {
    const cast = [
      A,
      B,
      C,
      mind({ slug: "d", name: "Di", identitySlot: 3 }),
      mind({ slug: "e", name: "El", identitySlot: 4 }),
    ];
    const section = conveneShapeSection(cast);
    const chair = byStrategy(cast)
      .get("group-chat")
      ?.fields?.find((f) => f.name === "moderator");
    expect(chair?.options).toHaveLength(5);
    expect(chair?.segmented).toBe(false);
    expect(valid(section)).toBe(true);
  });

  test("a gated shape says what to change inline, and keeps the fuller reason", () => {
    const review = byStrategy([A, B, C]).get("review");
    expect(review?.disabled).toBe(true);
    expect(review?.subtitle).toBe("Needs exactly two Minds");
    expect(review?.reason).toContain("exactly two Minds");
    // The tab-sized form is not the tooltip — a strip can't carry the full sentence.
    expect(review?.subtitle).not.toBe(review?.reason);
    const debate = byStrategy([A, B]).get("group-chat");
    expect(debate?.subtitle).toContain("chair");
    expect(debate?.reason).toContain("chair");
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

describe("conveneScopeSection", () => {
  const projects: ConveneProject[] = [
    { id: "p1", name: "keelson" },
    { id: "p2", name: "chamber" },
  ];

  test("a project picker over the host projects, opening on the current scope", () => {
    const section = conveneScopeSection(projects, { projectId: "p1" });
    expect(section).not.toBeNull();
    if (!section) return;
    expect(valid(section)).toBe(true);
    expect(section.kind === "actions" && section.title).toBe("Where does it run?");
    const item = shapes(section)[0];
    expect(item?.type).toBe("scope-set");
    // The bar IS the affordance — the form stands open rather than behind a click.
    expect(item?.expanded).toBe(true);
    const proj = item?.fields?.find((f) => f.name === "project");
    expect(proj?.options).toEqual([
      { value: "p1", label: "keelson" },
      { value: "p2", label: "chamber" },
    ]);
    expect(proj?.defaultValue).toBe("p1");
    // Not required, so its placeholder doubles as the clear option.
    expect(proj?.required).toBeUndefined();
  });

  test("no bar at all when the host exposes no projects and nothing is scoped", () => {
    expect(conveneScopeSection([], {})).toBeNull();
  });

  test("a scope the host no longer offers stays selectable so it can be cleared", () => {
    // Otherwise the draft keeps a projectId every convene rejects with no UI path to
    // drop it — and a defaultValue matching no option fails the board's own schema, so
    // the panel would stop publishing rather than merely look stale.
    for (const projects of [[], [{ id: "p1", name: "keelson" }]]) {
      const section = conveneScopeSection(projects, { projectId: "gone" });
      expect(section).not.toBeNull();
      if (!section) continue;
      expect(valid(section)).toBe(true);
      const proj = shapes(section)[0]?.fields?.find((f) => f.name === "project");
      expect(proj?.options?.some((o) => o.value === "gone")).toBe(true);
      expect(proj?.options?.find((o) => o.value === "gone")?.label).toContain("unavailable");
      expect(proj?.defaultValue).toBe("gone");
    }
  });

  test("the coding tier appears only once a project is set", () => {
    const unscoped = conveneScopeSection(projects, {});
    expect(unscoped && fieldNames(shapes(unscoped)[0])).toEqual(["project"]);
    const scoped = conveneScopeSection(projects, { projectId: "p1" });
    expect(scoped && fieldNames(shapes(scoped)[0])).toEqual(["project", "coding"]);
  });

  test("the coding control is a segmented pair opening on the drafted value", () => {
    const on = conveneScopeSection(projects, { projectId: "p1", coding: true });
    const off = conveneScopeSection(projects, { projectId: "p1" });
    const codingOf = (s: Section | null) =>
      s ? shapes(s)[0]?.fields?.find((f) => f.name === "coding") : undefined;
    expect(codingOf(on)?.segmented).toBe(true);
    expect(codingOf(on)?.options).toEqual([
      { value: "off", label: "Discuss only" },
      { value: "on", label: "Edit the repo" },
    ]);
    expect(codingOf(on)?.defaultValue).toBe("on");
    expect(codingOf(off)?.defaultValue).toBe("off");
    // Required, so there is no clear segment — the tier always reads as a definite state.
    expect(codingOf(on)?.required).toBe(true);
    expect(on && valid(on)).toBe(true);
  });
});

describe("conveneShapeSection fields", () => {
  test("no shape asks where the room runs — scope is the table's, not the shape's", () => {
    const bs = byStrategy([A, B, C]);
    for (const strategy of ["sequential", "group-chat", "open-floor", "review", "magentic"]) {
      expect(fieldNames(bs.get(strategy))).not.toContain("project");
      expect(fieldNames(bs.get(strategy))).not.toContain("coding");
    }
  });

  test("fields run narration → shape → the one thing checked at close", () => {
    const bs = byStrategy([A, B, C]);
    expect(fieldNames(bs.get("group-chat"))).toEqual([
      "topic",
      "groundingUrl",
      "moderator",
      "turns",
      "criteria",
    ]);
    expect(fieldNames(bs.get("magentic"))).toEqual([
      "topic",
      "groundingUrl",
      "manager",
      "turns",
      "criteria",
    ]);
    // Discussion gains the turns field it was missing — turnBudget bounds every
    // strategy identically, so its absence there was drift.
    expect(fieldNames(bs.get("sequential"))).toEqual([
      "topic",
      "groundingUrl",
      "turns",
      "criteria",
    ]);
    expect(fieldNames(bs.get("open-floor"))).toEqual([
      "topic",
      "groundingUrl",
      "turns",
      "criteria",
    ]);
    // Review stays a single-pass pair: no budget to spend, no synthesis to ground.
    // Read it from a two-seated cast — at three it is gated, so it carries no form.
    expect(fieldNames(byStrategy([A, B]).get("review"))).toEqual(["topic"]);
  });

  test("the brief's two halves are labelled by what each does", () => {
    const fields = byStrategy([A, B, C]).get("group-chat")?.fields ?? [];
    expect(fields.find((f) => f.name === "groundingUrl")?.label).toBe("Reference link");
    const criteria = fields.find((f) => f.name === "criteria");
    expect(criteria?.label).toBe("Done when");
    expect(criteria?.multiline).toBe(true);
    // The cost the form used to hide: criteria buy an extra cross-vendor turn.
    expect(criteria?.placeholder).toContain("turn");
  });

  test("nothing is half-width — the grouping carries the form, not a paired row", () => {
    const bs = byStrategy([A, B, C]);
    for (const strategy of ["sequential", "group-chat", "open-floor", "review", "magentic"]) {
      for (const f of bs.get(strategy)?.fields ?? []) expect(f.half).toBeUndefined();
    }
  });

  // Review is only enabled as a cross-vendor pair, so it is read from a two-seated
  // cast; the chaired shapes need a third to facilitate.
  const topicOf = (cast: readonly Mind[], strategy: string) =>
    byStrategy(cast)
      .get(strategy)
      ?.fields?.find((f) => f.name === "topic");

  test("a topic is required where the room drives to a definite outcome", () => {
    for (const strategy of ["group-chat", "magentic"]) {
      expect(topicOf([A, B, C], strategy)?.required).toBe(true);
      expect(topicOf([A, B, C], strategy)?.label).toBe("Topic (required)");
    }
    expect(topicOf([A, B], "review")?.required).toBe(true);
    for (const strategy of ["sequential", "open-floor"]) {
      expect(topicOf([A, B, C], strategy)?.required).toBeUndefined();
      expect(topicOf([A, B, C], strategy)?.label).toBe("Topic");
    }
  });

  test("each shape asks for the topic in its own verb", () => {
    expect(topicOf([A, B, C], "group-chat")?.placeholder).toContain("decide");
    expect(topicOf([A, B, C], "open-floor")?.placeholder).toContain("explore");
    expect(topicOf([A, B], "review")?.placeholder).toContain("review");
    // Delegate decomposes a goal (TaskLedger.goal) — "discuss" was simply wrong.
    expect(topicOf([A, B, C], "magentic")?.placeholder).toContain("goal");
    expect(topicOf([A, B, C], "sequential")?.placeholder).toContain("discuss");
  });

  test("only the required field is marked; the optional ones carry no suffix", () => {
    const bs = byStrategy([A, B, C]);
    for (const strategy of ["sequential", "group-chat", "open-floor", "review", "magentic"]) {
      for (const f of bs.get(strategy)?.fields ?? []) {
        expect(f.label).not.toContain("(optional)");
        expect(f.label.includes("(required)")).toBe(f.required === true);
      }
    }
    expect(bs.get("group-chat")?.fields?.find((f) => f.name === "moderator")?.label).toBe(
      "Chair (required)",
    );
    expect(bs.get("magentic")?.fields?.find((f) => f.name === "manager")?.label).toBe(
      "Manager (required)",
    );
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
