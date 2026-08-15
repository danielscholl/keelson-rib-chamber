import { describe, expect, test } from "bun:test";
import type { CanvasBoardView } from "@keelson/shared";
import { canvasViewSchema } from "@keelson/shared";
import {
  type ConveneProject,
  conveneScopeSection,
  conveneScopeWarning,
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
  return new Map(shapes(section).map((i) => [(i.binding as { strategy: string }).strategy, i]));
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
    expect(shapes(section).map((i) => (i.binding as { strategy: string }).strategy)).toEqual([
      "sequential",
      "group-chat",
      "open-floor",
      "review",
      "magentic",
    ]);
  });

  test("each shape's strategy rides binding, with no payload and no same-named field", () => {
    // `binding` merges into the dispatched payload AFTER collected field values,
    // so the tab's strategy can never be shadowed by a form field — and no shape
    // may collect a field named after the bound key either.
    for (const item of shapes(conveneShapeSection([A, B, C]))) {
      expect(item.binding).toEqual({ strategy: expect.any(String) });
      expect(item.payload).toBeUndefined();
      expect(fieldNames(item)).not.toContain("strategy");
    }
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

  // The tier toggle always trails the answers, so find it by label rather than index —
  // the number of answers ahead of it varies with the project count.
  const tierOf = (s: Section | null) =>
    s ? shapes(s).find((i) => i.label === "…and edit it") : undefined;
  const answers = (s: Section | null) =>
    s ? shapes(s).filter((i) => i.label !== "…and edit it") : [];
  // `payload` is an open record on the contract, so name the one key these chips carry.
  const projectOf = (i: { payload?: unknown } | undefined) =>
    (i?.payload as { project?: string } | undefined)?.project;

  test("the axis is named for what it grants, not for where it points", () => {
    // "Where does it run?" / "Shared" described a working directory and read as benign;
    // the unscoped state is a room whose Minds can open no file at all.
    const section = conveneScopeSection(projects, {});
    expect(section?.kind === "actions" && section.title).toBe("What can they read?");
    expect(answers(section).find((i) => i.selected)?.label).toBe("Nothing");
  });

  test("every answer is one chip that dispatches on click — no commit step to skip", () => {
    const section = conveneScopeSection(projects, { projectId: "p1" });
    expect(section).not.toBeNull();
    if (!section) return;
    expect(valid(section)).toBe(true);
    expect(section.kind === "actions" && section.wrap).toBe(true);
    expect(answers(section).map((i) => i.label)).toEqual(["Nothing", "keelson", "chamber"]);
    for (const chip of answers(section)) {
      expect(chip.type).toBe("scope-set");
      // A field would need a submit; that is exactly the step a scope can be lost in.
      expect(chip.fields).toBeUndefined();
    }
    // `selected` is the readout, and each chip carries the value it sets.
    expect(answers(section).map((i) => i.selected)).toEqual([false, true, false]);
    expect(answers(section).map((i) => i.payload)).toEqual([
      { project: "" },
      { project: "p1" },
      { project: "p2" },
    ]);
  });

  test("clearing is an answer of its own, not an empty option inside a picker", () => {
    const section = conveneScopeSection(projects, { projectId: "p1" });
    const nothing = answers(section).find((i) => i.label === "Nothing");
    expect(nothing?.payload).toEqual({ project: "" });
    expect(nothing?.selected).toBe(false);
  });

  test("no bar at all when the host exposes no projects and nothing is scoped", () => {
    expect(conveneScopeSection([], {})).toBeNull();
  });

  test("a scope the host no longer offers stays selectable so it can be cleared", () => {
    // Otherwise the draft keeps a projectId every convene rejects with no UI path to
    // drop it. The chip strip renders it as its own selected answer, so any other chip
    // replaces it in one click.
    for (const projects of [[], [{ id: "p1", name: "keelson" }]]) {
      const section = conveneScopeSection(projects, { projectId: "gone" });
      expect(section).not.toBeNull();
      if (!section) continue;
      expect(valid(section)).toBe(true);
      const staleChip = answers(section).find((i) => projectOf(i) === "gone");
      expect(staleChip?.label).toContain("unavailable");
      expect(staleChip?.selected).toBe(true);
      expect(answers(section).some((i) => projectOf(i) === "")).toBe(true);
    }
  });

  test("the threshold counts the chips emitted, not the projects", () => {
    // Nothing is always an answer and a dropped project adds its own, so counting the
    // project list alone lets a stale scope push the strip two past the ceiling.
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `proj-${i}` }));
    const isPicker = (s: Section | null) => answers(s).some((i) => i.fields !== undefined);
    // 5 projects + Nothing = 6, exactly the ceiling.
    expect(answers(conveneScopeSection(many(5), {})).length).toBe(6);
    expect(isPicker(conveneScopeSection(many(5), {}))).toBe(false);
    // The same 5 plus a dropped project is 7 — over, so it falls back.
    expect(isPicker(conveneScopeSection(many(5), { projectId: "gone" }))).toBe(true);
    // And 6 projects is 7 answers on its own, with no stale scope needed.
    expect(isPicker(conveneScopeSection(many(6), {}))).toBe(true);
  });

  test("past the chip threshold the picker falls back to a select", () => {
    // A long strip stops reading at a glance — the same threshold rule facilitatorField
    // applies with `segmented`.
    const many = Array.from({ length: 9 }, (_, i) => ({ id: `p${i}`, name: `proj-${i}` }));
    const section = conveneScopeSection(many, { projectId: "p3" });
    expect(section).not.toBeNull();
    if (!section) return;
    expect(valid(section)).toBe(true);
    const picker = answers(section)[0];
    expect(answers(section).length).toBe(1);
    expect(picker?.label).toBe("Reads — proj-3");
    const proj = picker?.fields?.find((f) => f.name === "project");
    expect(proj?.options?.length).toBe(9);
    expect(proj?.defaultValue).toBe("p3");
    expect(proj?.required).toBeUndefined();
  });

  test("a dropped project still contributes its option in the select fallback", () => {
    // A defaultValue matching no option fails the board's own schema, which would stop
    // the whole panel publishing rather than merely look stale.
    const many = Array.from({ length: 9 }, (_, i) => ({ id: `p${i}`, name: `proj-${i}` }));
    const section = conveneScopeSection(many, { projectId: "gone" });
    expect(section && valid(section)).toBe(true);
    const proj = answers(section)[0]?.fields?.find((f) => f.name === "project");
    expect(proj?.options?.find((o) => o.value === "gone")?.label).toContain("unavailable");
    expect(proj?.defaultValue).toBe("gone");
  });

  test("the tier toggle appears only once a project is set", () => {
    expect(tierOf(conveneScopeSection(projects, {}))).toBeUndefined();
    expect(tierOf(conveneScopeSection(projects, { projectId: "p1" }))).toBeDefined();
  });

  test("the tier is one toggle whose label holds still and whose state is pressed", () => {
    const on = conveneScopeSection(projects, { projectId: "p1", coding: true });
    const off = conveneScopeSection(projects, { projectId: "p1" });
    // The label names the capability once; `selected` says whether it is granted, so
    // the control never reads as "is this the state, or what the click does?". It now
    // continues the section's question rather than restating it as its own noun.
    expect(tierOf(on)?.label).toBe("…and edit it");
    expect(tierOf(off)?.label).toBe("…and edit it");
    expect(tierOf(on)?.selected).toBe(true);
    expect(tierOf(off)?.selected).toBe(false);
    // No fields — it dispatches on click like a seat card, carrying the value it flips to.
    expect(tierOf(on)?.fields).toBeUndefined();
    expect(tierOf(on)?.payload).toEqual({ coding: "off" });
    expect(tierOf(off)?.payload).toEqual({ coding: "on" });
    expect(on && valid(on)).toBe(true);
    expect(off && valid(off)).toBe(true);
  });

  test("the read floor is stated where it comes from — the project, not the tier", () => {
    // A scoped room grants every speaker Read inside the root (readToolPool), so an
    // off tier is NOT "no repo access" and must not be labelled as though it were.
    const section = conveneScopeSection(projects, { projectId: "p1" });
    expect(answers(section).find((i) => projectOf(i) === "p1")?.hint).toContain("read");
    expect(tierOf(section)?.hint).toContain("Reading is already allowed");
  });

  test("the unscoped answer says the Minds' own read/code will grant nothing", () => {
    const section = conveneScopeSection(projects, {});
    expect(answers(section).find((i) => i.label === "Nothing")?.hint).toContain("read no files");
  });

  test("a stale project offers no tier toggle — only the answers that can unpick it", () => {
    // Granting edits against a project the host no longer lists would deepen a scope
    // every convene already rejects; the useful move is to repick or clear.
    for (const p of [[], projects]) {
      const section = conveneScopeSection(p, { projectId: "gone", coding: true });
      expect(tierOf(section)).toBeUndefined();
    }
  });

  test("the toggle names the project it would let the Minds write to", () => {
    expect(tierOf(conveneScopeSection(projects, { projectId: "p1" }))?.hint).toContain("keelson");
  });
});

describe("conveneScopeWarning", () => {
  const reader = mind({ slug: "r", name: "Rhea", tools: ["read"] });
  const coder = mind({ slug: "k", name: "Kit", tools: ["code", "lens"] });
  const talker = mind({ slug: "t", name: "Tam", tools: ["lens"] });
  const plain = mind({ slug: "p", name: "Pip" });

  test("an unscoped room names the Minds whose declared skills it will resolve to nothing", () => {
    const section = conveneScopeWarning([reader, coder], {});
    expect(section).not.toBeNull();
    if (!section) return;
    expect(valid(section)).toBe(true);
    const text = section.kind === "rows" ? section.items[0]?.text : undefined;
    expect(text).toBe("Rhea and Kit can read code — but this room reads nothing.");
    expect(section.kind === "rows" && section.items[0]?.glyph).toBe("warn");
  });

  test("silent once a project is scoped — the declaration now resolves", () => {
    expect(conveneScopeWarning([reader, coder], { projectId: "p1" })).toBeNull();
  });

  test("silent when no seated Mind declares a filesystem skill", () => {
    // `lens` tables an exhibit and needs no project, so a room of talkers is not blind —
    // it is simply a discussion, which is a legitimate room to convene.
    expect(conveneScopeWarning([talker, plain], {})).toBeNull();
  });

  test("names one, two, and three the way the cast line does", () => {
    const textOf = (cast: Mind[]) => {
      const s = conveneScopeWarning(cast, {});
      return s?.kind === "rows" ? s.items[0]?.text : undefined;
    };
    expect(textOf([reader])).toContain("Rhea can read code");
    expect(textOf([reader, coder])).toContain("Rhea and Kit can read code");
    expect(textOf([reader, coder, mind({ slug: "z", name: "Zed", tools: ["read"] })])).toContain(
      "Rhea, Kit, and Zed can read code",
    );
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
