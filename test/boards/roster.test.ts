import { describe, expect, test } from "bun:test";
import { canvasViewSchema } from "@keelson/shared";
import { buildRosterBoard } from "../../src/boards/roster.ts";
import { GENESIS_STARTERS } from "../../src/starters.ts";
import type { Mind } from "../../src/types.ts";

const mind = (over: Partial<Mind> = {}): Mind => ({
  slug: "ada",
  name: "Ada",
  role: "Chief of Staff",
  persona: "You are Ada.",
  ...over,
});

function actionItems(board: ReturnType<typeof buildRosterBoard>) {
  return board.sections.flatMap((s) => (s.kind === "actions" ? s.items : []));
}
function actionsSection(board: ReturnType<typeof buildRosterBoard>, title: string) {
  return board.sections.find((s) => s.kind === "actions" && s.title === title);
}
function cards(board: ReturnType<typeof buildRosterBoard>) {
  const section = board.sections.find((s) => s.kind === "cards");
  if (section?.kind !== "cards") throw new Error("no cards section");
  return section.items;
}
// The seated Mind cards only (a pending genesis's boot card also rides the cards
// section, but carries a pill). openSeats survives to assert the old dashed grid is
// gone — no card is titled "Open seat" anymore.
function mindCards(board: ReturnType<typeof buildRosterBoard>) {
  return cards(board).filter((c) => c.title !== "Open seat");
}
function openSeats(board: ReturnType<typeof buildRosterBoard>) {
  return cards(board).filter((c) => c.title === "Open seat");
}

describe("buildRosterBoard cold start", () => {
  test("is a valid board with no roster slug chip at 0 minds", () => {
    const board = buildRosterBoard([]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.view).toBe("board");
    // The redundant "roster" slug is gone; the count status stays.
    expect(board.header?.chip).toBeUndefined();
    expect(board.header?.status?.label).toBe("0 minds");
  });

  test("the cold start leads with the Genesis authoring section — no anchor preamble", () => {
    const board = buildRosterBoard([]);
    const first = board.sections[0];
    expect(first?.kind).toBe("actions");
    if (first?.kind === "actions") expect(first.title).toBe("Genesis — author a Mind");
    expect(JSON.stringify(board)).not.toContain("A Chamber is a team of persistent Minds");
  });

  test('no "convene <slug>" string anywhere; no row trailing starts with "convene "', () => {
    const board = buildRosterBoard([]);
    expect(JSON.stringify(board)).not.toMatch(/convene <[a-z]/);
    for (const s of board.sections) {
      if (s.kind === "rows") {
        for (const item of s.items) expect(item.trailing ?? "").not.toMatch(/^convene /);
      }
    }
  });

  test("the authoring section is titled 'Genesis — author a Mind'", () => {
    const board = buildRosterBoard([]);
    expect(actionsSection(board, "Genesis — author a Mind")?.kind).toBe("actions");
  });

  test("the freeform-brief hero is the authoring section's one item — brand, expanded", () => {
    const items = actionsSection(buildRosterBoard([]), "Genesis — author a Mind");
    if (items?.kind !== "actions") throw new Error("no authoring section");
    expect(items.items).toHaveLength(1);
    const hero = items.items[0];
    expect(hero?.type).toBe("describe-own");
    expect(hero?.tone).toBe("brand");
    // The brief field is open inline — no disclosure step on the authored path.
    expect(hero?.expanded).toBe(true);
    expect(hero?.submitLabel).toBe("Author");
  });

  test('the starters are a compact "Or seat a starter voice" actions chip row', () => {
    const board = buildRosterBoard([]);
    const section = actionsSection(board, "Or seat a starter voice");
    if (section?.kind !== "actions") throw new Error("no starter actions section");
    // A wrapping chip row, not the old boxed cards.
    expect(section.wrap).toBe(true);
    expect(section.items.map((i) => i.type)).toEqual(
      GENESIS_STARTERS.map(() => "author-archetype"),
    );
    // Compact label: name + role (not the fuller tagline an open-seat action carries).
    expect(section.items.map((i) => i.label)).toEqual(
      GENESIS_STARTERS.map((s) => `${s.name} — ${s.role}`),
    );
    // Seats 0/1/2 preview blue/amber/teal — every seat is free at cold start.
    expect(section.items.map((i) => i.tone)).toEqual(["id-blue", "id-amber", "id-teal"]);
    expect(section.items.map((i) => (i.payload as { slug: string }).slug)).toEqual(
      GENESIS_STARTERS.map((s) => s.slug),
    );
    for (const item of section.items) expect(item.glyph).toBe("✦");
  });

  test("a describe-own action carries the verbatim brief field", () => {
    const board = buildRosterBoard([]);
    const own = actionItems(board).find((i) => i.type === "describe-own");
    expect(own?.label).toBe("Author");
    expect(own?.glyph).toBe("✦");
    expect(own?.submitLabel).toBe("Author");
    expect(own?.fields).toEqual([
      {
        name: "brief",
        label: "Who should this Mind feel like?",
        placeholder: 'e.g. "Athena — a skeptical staff engineer who guards the architecture"',
        multiline: true,
      },
    ]);
  });

  test("no genesis-rite bridge caption rides the cold start", () => {
    const board = buildRosterBoard([]);
    const bridge = board.sections
      .flatMap((s) => (s.kind === "rows" ? s.items : []))
      .find((i) => i.trailing === "genesis");
    expect(bridge).toBeUndefined();
    expect(JSON.stringify(board)).not.toContain("genesis rite");
  });

  test("no what's-next journey strip — the anchor and seated nudges carry orientation", () => {
    const board = buildRosterBoard([]);
    expect(JSON.stringify(board)).not.toContain("1 · Author");
  });

  test("no mind cards, no Enter/Retire section; the void screen's line closes it", () => {
    const board = buildRosterBoard([]);
    expect(actionsSection(board, "Enter")).toBeUndefined();
    expect(actionsSection(board, "Retire")).toBeUndefined();
    expect(actionItems(board).some((i) => i.type === "enter-mind" || i.type === "retire")).toBe(
      false,
    );
    expect(board.sections.map((s) => s.kind)).toEqual(["actions", "actions", "rows"]);
    // The original Chamber's void-screen line, quoted at rest.
    const last = board.sections.at(-1);
    if (last?.kind !== "rows") throw new Error("no closing rows section");
    expect(last.items[0]?.text).toBe("awaiting genesis.");
  });
});

describe("buildRosterBoard genesis boot card", () => {
  const START = Date.parse("2026-07-05T18:00:00.000Z");
  const pending = (over: Partial<import("../../src/pending-genesis.ts").PendingGenesis> = {}) => ({
    startedAt: new Date(START).toISOString(),
    ...over,
  });
  function bootCard(board: ReturnType<typeof buildRosterBoard>) {
    return cards(board).find((c) => c.title !== "Open seat" && "pill" in c && c.pill?.label);
  }

  test("a pending genesis renders a boot card in the next free seat, with a live elapsed count", () => {
    const board = buildRosterBoard(
      [mind({ slug: "a", identitySlot: 0 })],
      undefined,
      pending({ name: "Mycroft", role: "Research Partner" }),
      START + 38_000,
    );
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const boot = cards(board).find((c) => c.title === "Mycroft");
    expect(boot?.dot).toBe("id-amber"); // slot 1 — the next free seat after slot 0
    expect(boot?.pill).toEqual({ label: "authoring", tone: "brand" });
    const values = boot?.fields?.map((f) => String(f.value)) ?? [];
    expect(values.some((v) => v.includes("identity: Mycroft"))).toBe(true);
    expect(values.some((v) => v.includes("purpose: Research Partner"))).toBe(true);
    expect(values.some((v) => v.includes("38s"))).toBe(true);
    // The liturgy renders as stacked terminal lines: the card stacks its fields,
    // each a dim `>` prompt label with the readout on the green ok tone.
    expect(boot?.stacked).toBe(true);
    for (const f of boot?.fields ?? []) {
      expect(f.label).toBe(">");
      expect(f.tone).toBe("ok");
    }
  });

  test("a freeform brief (no name/role) holds 'calibrating…' and titles the seat Genesis", () => {
    const board = buildRosterBoard([], undefined, pending(), START + 4_000);
    const boot = cards(board).find((c) => c.title === "Genesis");
    expect(boot).toBeDefined();
    const values = boot?.fields?.map((f) => String(f.value)) ?? [];
    expect(values.some((v) => v.includes("identity: calibrating…"))).toBe(true);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
  });

  test("past the stall window the boot card flips to a warn card with a Dismiss action", () => {
    const board = buildRosterBoard(
      [],
      undefined,
      pending({ name: "Mycroft" }),
      START + 200_000, // > 180s stall window
    );
    const boot = cards(board).find((c) => c.title === "Mycroft");
    expect(boot?.pill).toEqual({ label: "stalled", tone: "warn" });
    expect(boot?.actions?.some((a) => a.type === "dismiss-genesis")).toBe(true);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
  });

  test("an unparseable startedAt (a hand-edited marker) renders the dismissable stalled card", () => {
    const board = buildRosterBoard(
      [],
      undefined,
      { startedAt: "not-a-date", name: "Mycroft" },
      START,
    );
    const boot = cards(board).find((c) => c.title === "Mycroft");
    expect(boot?.pill).toEqual({ label: "stalled", tone: "warn" });
    expect(boot?.actions?.some((a) => a.type === "dismiss-genesis")).toBe(true);
    // No "NaNs" leaks into the rendered card.
    expect(JSON.stringify(boot)).not.toContain("NaN");
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
  });

  test("a startedAt in the future beyond clock skew (a rollback) also stalls to Dismiss", () => {
    const board = buildRosterBoard(
      [],
      undefined,
      { startedAt: new Date(START + 120_000).toISOString(), name: "Mycroft" },
      START,
    );
    const boot = cards(board).find((c) => c.title === "Mycroft");
    expect(boot?.pill).toEqual({ label: "stalled", tone: "warn" });
    expect(boot?.actions?.some((a) => a.type === "dismiss-genesis")).toBe(true);
  });

  test("the quiet Author action and lone-Mind nudge are withheld while a genesis is pending", () => {
    const one = buildRosterBoard([mind({ slug: "a" })], undefined, pending(), START);
    expect(
      one.sections
        .flatMap((s) => (s.kind === "rows" ? s.items : []))
        .some((i) => i.trailing === "next"),
    ).toBe(false);
    // The boot card consumed a seat; the remaining free slots are still open seats.
    expect(bootCard(one)).toBeDefined();
  });
});

describe("buildRosterBoard populated", () => {
  test("valid; header counts singular/plural", () => {
    expect(buildRosterBoard([mind()]).header?.status?.label).toBe("1 mind");
    const two = buildRosterBoard([mind({ slug: "a" }), mind({ slug: "b", name: "Bo" })]);
    expect(canvasViewSchema.safeParse(two).success).toBe(true);
    expect(two.header?.status?.label).toBe("2 minds");
  });

  test("each seated card dot is the Mind's persisted identity-slot tone (keelson#390)", () => {
    const board = buildRosterBoard([
      mind({ slug: "a", identitySlot: 0 }),
      mind({ slug: "b", name: "Bo", identitySlot: 1 }),
    ]);
    const [a, b] = mindCards(board);
    expect(a?.dot).toBe("id-blue");
    expect(b?.dot).toBe("id-amber");
  });

  test("a seated slot past the ramp (or absent) folds to neutral, not an invented hue", () => {
    const board = buildRosterBoard([
      mind({ slug: "a", identitySlot: 99 }),
      mind({ slug: "b", name: "Bo" }),
    ]);
    for (const card of mindCards(board)) expect(card.dot).toBe("neutral");
  });

  test("exactly one pill per card carrying the role, never the slug", () => {
    const board = buildRosterBoard([mind({ slug: "ada", role: "Chief of Staff" })]);
    const card = mindCards(board)[0];
    expect(card?.pill).toEqual({ label: "Chief of Staff" });
  });

  test("an empty role falls back to a 'Mind' pill", () => {
    expect(mindCards(buildRosterBoard([mind({ role: "" })]))[0]?.pill?.label).toBe("Mind");
  });

  test("fields: a truncated persona ((no persona) fallback); the model reads off the set-model label, not a field", () => {
    const withModel = mindCards(buildRosterBoard([mind({ model: "claude-x" })]))[0];
    expect(withModel?.fields?.find((f) => f.label === "persona")?.value).toBe("You are Ada.");
    // The read-only model field is gone — the model now rides the set-model action label.
    expect(withModel?.fields?.some((f) => f.label === "model")).toBe(false);
    expect(withModel?.actions?.find((a) => a.type === "set-model")?.label).toBe("Model — claude-x");
    const noModel = mindCards(buildRosterBoard([mind({ model: undefined })]))[0];
    expect(noModel?.actions?.find((a) => a.type === "set-model")?.label).toBe("Model — default");
    const noPersona = mindCards(buildRosterBoard([mind({ persona: "   " })]))[0];
    expect(noPersona?.fields?.find((f) => f.label === "persona")?.value).toBe("(no persona)");
  });

  test("the slug still rides the serialized board (guards collect-roster toContain)", () => {
    expect(JSON.stringify(buildRosterBoard([mind({ slug: "ada" })]))).toContain("ada");
  });

  test("each seated card.actions has a destructive Retire with a simple confirm", () => {
    const board = buildRosterBoard([mind({ slug: "ada", name: "Ada" })]);
    const retire = mindCards(board)[0]?.actions?.find((a) => a.type === "retire");
    expect(retire).toMatchObject({
      type: "retire",
      label: "Retire Mind…",
      glyph: "✕",
      tone: "warn",
      destructive: true,
      payload: { slug: "ada" },
    });
    expect(retire?.confirm?.irreversible).toBeUndefined();
    expect(retire?.confirm?.subject).toBeUndefined();
    expect(retire?.confirm?.confirmLabel).toBe("Retire");
  });

  test("each seated card.actions leads with a non-destructive Enter carrying the slug", () => {
    const board = buildRosterBoard([mind({ slug: "ada", name: "Ada" })]);
    const actions = mindCards(board)[0]?.actions ?? [];
    const enter = actions.find((a) => a.type === "enter-mind");
    expect(enter).toMatchObject({
      type: "enter-mind",
      label: "Enter Ada",
      glyph: "→",
      payload: { slug: "ada" },
    });
    expect(enter?.destructive ?? false).toBe(false);
    expect(enter?.confirm).toBeUndefined();
    expect(actions[0]?.type).toBe("enter-mind");
    expect(actions.findIndex((a) => a.type === "enter-mind")).toBeLessThan(
      actions.findIndex((a) => a.type === "retire"),
    );
  });

  test("each seated card's set-model action is an at-rest indicator plus the host model picker", () => {
    const board = buildRosterBoard([
      mind({ slug: "ada", name: "Ada", model: "claude-opus-4-7", provider: "anthropic" }),
    ]);
    const actions = mindCards(board)[0]?.actions ?? [];
    const setModel = actions.find((a) => a.type === "set-model");
    expect(setModel).toMatchObject({
      type: "set-model",
      label: "Model — claude-opus-4-7",
      glyph: "⚙",
      payload: { slug: "ada" },
    });
    expect(setModel?.destructive ?? false).toBe(false);
    // One field: the host's live-catalog picker, non-required (its clear row
    // drops the pin), opening on the current provider/model pair so an idle
    // submit re-affirms both rather than dropping them via setMindModel.
    expect(setModel?.fields?.map((f) => f.name)).toEqual(["model"]);
    const modelField = setModel?.fields?.find((f) => f.name === "model");
    expect(modelField?.required ?? false).toBe(false);
    expect(modelField?.defaultValue).toBe("claude-opus-4-7");
    expect(modelField?.options).toBeUndefined(); // the catalog is the host's, never baked in
    expect(modelField?.modelPicker).toEqual({
      providerField: "provider",
      providerDefault: "anthropic",
    });
    expect(actions.findIndex((a) => a.type === "retire")).toBe(actions.length - 1);
  });

  test("a Mind pinned off-catalog keeps that model as the picker default", () => {
    const drift = "claude-opus-4.8"; // dot-format prose slug, not a catalog id
    const board = buildRosterBoard([mind({ slug: "ada", model: drift })]);
    const setModel = mindCards(board)[0]?.actions?.find((a) => a.type === "set-model");
    const modelField = setModel?.fields?.find((f) => f.name === "model");
    expect(modelField?.defaultValue).toBe(drift);
    // A provider-less pin seeds no providerDefault — nothing to re-affirm.
    expect(modelField?.modelPicker).toEqual({ providerField: "provider" });
    // The whole board still validates fail-closed with the drifted default present.
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
  });

  test("an unset Mind's model control reads default and opens on the clear row", () => {
    const board = buildRosterBoard([mind({ slug: "ada", model: undefined })]);
    const setModel = mindCards(board)[0]?.actions?.find((a) => a.type === "set-model");
    expect(setModel?.label).toBe("Model — default");
    const modelField = setModel?.fields?.find((f) => f.name === "model");
    // No defaultValue → the non-required picker opens on its clear row.
    expect(modelField?.defaultValue).toBeUndefined();
    expect(modelField?.modelPicker).toEqual({ providerField: "provider" });
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
  });

  test("Enter lives on each Mind card; no standalone Enter/retire action item", () => {
    const board = buildRosterBoard([mind({ slug: "a" }), mind({ slug: "b", name: "Bo" })]);
    expect(actionsSection(board, "Enter")).toBeUndefined();
    // enter-mind and retire ride the Mind cards, never a separate button list.
    for (const item of actionItems(board)) {
      expect(item.type).not.toBe("enter-mind");
      expect(item.type).not.toBe("retire");
    }
    const enters = mindCards(board).map((c) => c.actions?.find((a) => a.type === "enter-mind"));
    expect(enters.map((e) => e?.payload)).toEqual([{ slug: "a" }, { slug: "b" }]);
  });
});

describe("buildRosterBoard seated launchpad (authoring stays reachable)", () => {
  const launchpad = (board: ReturnType<typeof buildRosterBoard>) =>
    actionsSection(board, "Author another Mind");
  const launchpadStarters = (board: ReturnType<typeof buildRosterBoard>) => {
    const section = actionsSection(board, "Or seat a starter voice");
    return section?.kind === "actions"
      ? section.items.filter((i) => i.type === "author-archetype")
      : [];
  };
  const starterSlugs = (board: ReturnType<typeof buildRosterBoard>) =>
    launchpadStarters(board).map((s) => (s.payload as { slug: string }).slug);

  test("no open-seat cards render once a Mind is seated", () => {
    const board = buildRosterBoard([
      mind({ slug: "a", identitySlot: 0 }),
      mind({ slug: "b", name: "Bo", identitySlot: 1 }),
    ]);
    expect(openSeats(board)).toHaveLength(0);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
  });

  test("the launchpad offers the freeform Author brief — the shared filled hero", () => {
    const board = buildRosterBoard([mind({ slug: "a", identitySlot: 0 })]);
    const section = launchpad(board);
    if (section?.kind !== "actions") throw new Error("no launchpad");
    expect(section.items.map((i) => i.type)).toEqual(["describe-own"]);
    const own = section.items[0];
    // Same hero as cold start: filled brand, brief open inline.
    expect(own?.glyph).toBe("✦");
    expect(own?.tone).toBe("brand");
    expect(own?.expanded).toBe(true);
    expect(own?.submitLabel).toBe("Author");
  });

  test("the launchpad's starters are a compact 'Or seat a starter voice' chip row", () => {
    const board = buildRosterBoard([mind({ slug: "a", identitySlot: 0 })]);
    const section = actionsSection(board, "Or seat a starter voice");
    if (section?.kind !== "actions") throw new Error("no starter row");
    expect(section.wrap).toBe(true);
    // "a" is not a starter → all three starters offered, compact "name — role".
    expect(section.items.map((i) => i.label)).toEqual(
      GENESIS_STARTERS.map((s) => `${s.name} — ${s.role}`),
    );
    expect(starterSlugs(board)).toEqual(GENESIS_STARTERS.map((s) => s.slug));
  });

  test("rule 1 — an authored starter drops off the row (never offered to re-author)", () => {
    const board = buildRosterBoard([
      mind({ slug: "moneypenny", name: "Moneypenny", identitySlot: 0 }),
    ]);
    const offered = starterSlugs(board);
    expect(offered).not.toContain("moneypenny");
    expect(offered).toContain("mycroft");
    expect(offered).toContain("jarvis");
  });

  test("rule 2 — a starter whose preferred hue is taken stays, but untoned", () => {
    // "ada" claims slot 0 — Moneypenny's blue. Moneypenny is still offered (not authored)
    // but must not promise blue (she'd land elsewhere); Mycroft (seat 1, free) keeps amber.
    const board = buildRosterBoard([mind({ slug: "ada", name: "Ada", identitySlot: 0 })]);
    const bySlug = new Map(
      launchpadStarters(board).map((s) => [(s.payload as { slug: string }).slug, s]),
    );
    expect(bySlug.get("moneypenny")?.tone).toBeUndefined();
    expect(bySlug.get("mycroft")?.tone).toBe("id-amber");
  });

  test("a full ramp (5 seated) still offers the freeform Author, but no starter chips", () => {
    const five = [0, 1, 2, 3, 4].map((slot) =>
      mind({ slug: `m${slot}`, name: `M${slot}`, identitySlot: slot }),
    );
    const board = buildRosterBoard(five);
    expect(openSeats(board)).toHaveLength(0);
    const section = launchpad(board);
    if (section?.kind !== "actions") throw new Error("no launchpad");
    expect(section.items.map((i) => i.type)).toEqual(["describe-own"]);
    // Every hue is seated — no starter voices offered.
    expect(actionsSection(board, "Or seat a starter voice")).toBeUndefined();
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
  });

  test("the launchpad is present at >= 2 minds; no convene composer rides the roster", () => {
    const board = buildRosterBoard([
      mind({ slug: "a", name: "Ada" }),
      mind({ slug: "b", name: "Bo" }),
    ]);
    expect(actionsSection(board, "Author another Mind")?.kind).toBe("actions");
    // Convening moved to its own region — the roster is Minds-only now.
    expect(actionsSection(board, "Convene a room — who's in")).toBeUndefined();
    expect(actionsSection(board, "…and how")).toBeUndefined();
  });

  test("one Mind seated points forward with a 'seat a second' nudge above the launchpad", () => {
    const board = buildRosterBoard([mind({ slug: "a", identitySlot: 0 })]);
    const nudge = board.sections
      .flatMap((s) => (s.kind === "rows" ? s.items : []))
      .find((i) => i.trailing === "next");
    expect(nudge?.text).toBe("Seat a second Mind to convene a Room.");
    // No convene composer rides the roster; the launchpad is there to author #2.
    expect(actionsSection(board, "Convene a room — who's in")).toBeUndefined();
    expect(launchpad(board)?.kind).toBe("actions");
    // The lone-Mind nudge is gone once a second Mind is seated.
    const two = buildRosterBoard([mind({ slug: "a" }), mind({ slug: "b", name: "Bo" })]);
    expect(
      two.sections
        .flatMap((s) => (s.kind === "rows" ? s.items : []))
        .some((i) => i.trailing === "next"),
    ).toBe(false);
  });

  test("the launchpad is withheld while a genesis is pending (the boot card owns it)", () => {
    const START = Date.parse("2026-07-05T18:00:00.000Z");
    const board = buildRosterBoard(
      [mind({ slug: "a", identitySlot: 0 })],
      undefined,
      { startedAt: new Date(START).toISOString() },
      START,
    );
    expect(actionsSection(board, "Author another Mind")).toBeUndefined();
    expect(actionsSection(board, "Or seat a starter voice")).toBeUndefined();
  });
});

describe("buildRosterBoard header peek (roster dots + collapse hint)", () => {
  test("cold start emits no people and no collapse hint (the launchpad stays open)", () => {
    const board = buildRosterBoard([]);
    expect(board.header?.people).toBeUndefined();
    expect(board.header?.defaultCollapsed).toBeUndefined();
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
  });

  test("a seated roster emits identity-toned people and the collapse hint", () => {
    const board = buildRosterBoard([
      mind({ slug: "a", name: "Athena", identitySlot: 0 }),
      mind({ slug: "b", name: "Bo", identitySlot: 1 }),
    ]);
    expect(board.header?.defaultCollapsed).toBe(true);
    expect(board.header?.people).toEqual([
      { name: "Athena", tone: "id-blue" },
      { name: "Bo", tone: "id-amber" },
    ]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
  });

  test("a slotless Mind folds to a neutral dot in the peek", () => {
    const board = buildRosterBoard([mind({ slug: "a", name: "Ada" })]);
    expect(board.header?.people).toEqual([{ name: "Ada", tone: "neutral" }]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
  });
});

describe("buildRosterBoard pulse (leads the board)", () => {
  const two = [mind({ slug: "a", name: "Ada" }), mind({ slug: "b", name: "Bo" })];

  test("omitting pulse, or forYou:false, renders no pulse section at all", () => {
    const omitted = buildRosterBoard(two);
    expect(
      omitted.sections.some((s) => s.kind === "rows" && s.items[0]?.trailing === "Briefing"),
    ).toBe(false);
    const quiet = buildRosterBoard(two, { forYou: false });
    expect(quiet.sections).toEqual(omitted.sections);
  });

  test("forYou:true leads the board with one quiet rows line", () => {
    const board = buildRosterBoard(two, { forYou: true });
    const first = board.sections[0];
    expect(first?.kind).toBe("rows");
    if (first?.kind !== "rows") throw new Error("expected a rows section");
    expect(first.items).toEqual([
      { glyph: "brand", text: "A briefing is waiting for you.", trailing: "Briefing" },
    ]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
  });

  test("the pulse leads even the cold-start board and stays valid", () => {
    const board = buildRosterBoard([], { forYou: true });
    expect(board.sections[0]?.kind).toBe("rows");
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
  });
});
