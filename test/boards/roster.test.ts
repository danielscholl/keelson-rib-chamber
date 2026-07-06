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

const ANCHOR =
  "A Chamber is a team of persistent Minds you author — they chat with you, meet each other in Rooms, and keep Lenses for ongoing work. Author your first Mind to start the Chamber.";

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
// The seated Minds only (open-seat ghosts share the cards section but title "Open seat").
function mindCards(board: ReturnType<typeof buildRosterBoard>) {
  return cards(board).filter((c) => c.title !== "Open seat");
}
function openSeats(board: ReturnType<typeof buildRosterBoard>) {
  return cards(board).filter((c) => c.title === "Open seat");
}

describe("buildRosterBoard cold start", () => {
  test("is a valid board with the roster header at 0 minds", () => {
    const board = buildRosterBoard([]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.view).toBe("board");
    expect(board.header?.chip).toBe("roster");
    expect(board.header?.status?.label).toBe("0 minds");
  });

  test("the leading rows item is the verbatim anchor sentence", () => {
    const board = buildRosterBoard([]);
    const first = board.sections[0];
    expect(first?.kind).toBe("rows");
    if (first?.kind === "rows") expect(first.items[0]?.text).toBe(ANCHOR);
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
  });

  test('the starters are seated-alternative cards under "Or seat a starter voice"', () => {
    const board = buildRosterBoard([]);
    const section = board.sections.find(
      (s) => s.kind === "cards" && s.title === "Or seat a starter voice",
    );
    if (section?.kind !== "cards") throw new Error("no starter cards section");
    expect(section.boxed).toBe(true);
    expect(section.items.map((c) => c.title)).toEqual(GENESIS_STARTERS.map((s) => s.name));
    // Seats 0/1/2 preview blue/amber/teal — the hue each starter will wear when
    // authored from an empty roster — with the role as the pill and blurb as copy.
    expect(section.items.map((c) => c.dot)).toEqual(["id-blue", "id-amber", "id-teal"]);
    expect(section.items.map((c) => c.pill?.label)).toEqual(GENESIS_STARTERS.map((s) => s.role));
    expect(section.items.map((c) => c.footnote)).toEqual(GENESIS_STARTERS.map((s) => s.blurb));
    for (const [i, card] of section.items.entries()) {
      expect(card.actions).toEqual([
        {
          type: "author-archetype",
          label: `Author ${GENESIS_STARTERS[i]?.name}`,
          glyph: "✦",
          payload: { slug: GENESIS_STARTERS[i]?.slug },
        },
      ]);
    }
  });

  test("a describe-own action carries the verbatim brief field", () => {
    const board = buildRosterBoard([]);
    const own = actionItems(board).find((i) => i.type === "describe-own");
    expect(own?.label).toBe("Author");
    expect(own?.glyph).toBe("✦");
    expect(own?.fields).toEqual([
      {
        name: "brief",
        label: "Who should this Mind feel like?",
        placeholder: 'e.g. "Athena — a skeptical staff engineer who guards the architecture"',
        multiline: true,
      },
    ]);
  });

  test("a bridge caption teaches the /genesis equivalence", () => {
    const board = buildRosterBoard([]);
    const bridge = board.sections
      .flatMap((s) => (s.kind === "rows" ? s.items : []))
      .find((i) => i.trailing === "genesis");
    expect(bridge?.text).toBe(
      "Authoring runs the genesis rite — /genesis in chat, chamber-genesis in workflows.",
    );
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
    expect(board.sections.map((s) => s.kind)).toEqual(["rows", "actions", "rows", "cards", "rows"]);
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
      new Set(),
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
  });

  test("a freeform brief (no name/role) holds 'calibrating…' and titles the seat Genesis", () => {
    const board = buildRosterBoard([], new Set(), undefined, pending(), START + 4_000);
    const boot = cards(board).find((c) => c.title === "Genesis");
    expect(boot).toBeDefined();
    const values = boot?.fields?.map((f) => String(f.value)) ?? [];
    expect(values.some((v) => v.includes("identity: calibrating…"))).toBe(true);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
  });

  test("past the stall window the boot card flips to a warn card with a Dismiss action", () => {
    const board = buildRosterBoard(
      [],
      new Set(),
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
      new Set(),
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

  test("the quiet Author action and lone-Mind nudge are withheld while a genesis is pending", () => {
    const one = buildRosterBoard([mind({ slug: "a" })], new Set(), undefined, pending(), START);
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

  test("fields: a truncated persona ((no persona) fallback) and model only when set", () => {
    const withModel = mindCards(buildRosterBoard([mind({ model: "claude-x" })]))[0];
    expect(withModel?.fields?.find((f) => f.label === "persona")?.value).toBe("You are Ada.");
    expect(withModel?.fields?.find((f) => f.label === "model")?.value).toBe("claude-x");
    const noModel = mindCards(buildRosterBoard([mind({ model: undefined })]))[0];
    expect(noModel?.fields?.some((f) => f.label === "model")).toBe(false);
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

  test("each seated card carries a set-model action with model/provider fields", () => {
    const board = buildRosterBoard([
      mind({ slug: "ada", name: "Ada", model: "claude-opus-4.8", provider: "anthropic" }),
    ]);
    const actions = mindCards(board)[0]?.actions ?? [];
    const setModel = actions.find((a) => a.type === "set-model");
    expect(setModel).toMatchObject({
      type: "set-model",
      label: "Set model…",
      glyph: "⚙",
      payload: { slug: "ada" },
    });
    expect(setModel?.destructive ?? false).toBe(false);
    expect(setModel?.fields).toEqual([
      { name: "model", label: "Model", placeholder: "claude-opus-4.8" },
      { name: "provider", label: "Provider", placeholder: "anthropic" },
    ]);
    expect(actions.findIndex((a) => a.type === "retire")).toBe(actions.length - 1);
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

describe("buildRosterBoard open seats (persistent authoring)", () => {
  test("a dashed open seat renders per free identity slot, in ramp order", () => {
    const board = buildRosterBoard([
      mind({ slug: "a", identitySlot: 0 }),
      mind({ slug: "b", name: "Bo", identitySlot: 1 }),
    ]);
    // Two seated (blue, amber) → three open seats in teal, rose, olive.
    const seats = openSeats(board);
    expect(seats.map((s) => s.dot)).toEqual(["id-teal", "id-rose", "id-olive"]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
  });

  test("open seats honor slot gaps left by a churned roster", () => {
    const board = buildRosterBoard([
      mind({ slug: "a", identitySlot: 0 }),
      mind({ slug: "c", name: "Cy", identitySlot: 2 }),
    ]);
    // Slots 0 and 2 taken → the free seats are 1, 3, 4 (amber, rose, olive).
    expect(openSeats(board).map((s) => s.dot)).toEqual(["id-amber", "id-rose", "id-olive"]);
  });

  test("every open seat carries the freeform Author verb; the first also offers free starters", () => {
    const board = buildRosterBoard([mind({ slug: "a", identitySlot: 0 })]);
    const seats = openSeats(board);
    for (const seat of seats) {
      expect(seat.actions?.some((x) => x.type === "describe-own")).toBe(true);
    }
    const firstStarters = seats[0]?.actions?.filter((x) => x.type === "author-archetype") ?? [];
    expect(firstStarters).toHaveLength(GENESIS_STARTERS.length);
    // Subsequent seats don't repeat the starter buttons.
    expect(seats[1]?.actions?.some((x) => x.type === "author-archetype")).toBe(false);
  });

  test("an already-seated starter is not offered again in the open seat", () => {
    const board = buildRosterBoard([
      mind({ slug: "moneypenny", name: "Moneypenny", identitySlot: 0 }),
    ]);
    const firstSeat = openSeats(board)[0];
    const offered = (firstSeat?.actions ?? [])
      .filter((x) => x.type === "author-archetype")
      .map((x) => (x.payload as { slug: string }).slug);
    expect(offered).not.toContain("moneypenny");
    expect(offered).toContain("mycroft");
  });

  test("one Mind seated points forward with a 'seat a second' nudge (the composer needs two)", () => {
    const board = buildRosterBoard([mind({ slug: "a", identitySlot: 0 })]);
    const nudge = board.sections
      .flatMap((s) => (s.kind === "rows" ? s.items : []))
      .find((i) => i.trailing === "next");
    expect(nudge?.text).toBe("Seat a second Mind to convene a Room.");
    // No convene composer yet at one Mind.
    expect(actionsSection(board, "Convene a room — who's in")).toBeUndefined();
    // The nudge is gone once a second Mind is seated (the composer takes over).
    const two = buildRosterBoard([mind({ slug: "a" }), mind({ slug: "b", name: "Bo" })]);
    expect(
      two.sections
        .flatMap((s) => (s.kind === "rows" ? s.items : []))
        .some((i) => i.trailing === "next"),
    ).toBe(false);
  });

  test("a starter whose preferred seat is taken is offered untoned (no false hue promise)", () => {
    // "ada" claims slot 0 — Moneypenny's seat. The offered Moneypenny starter must not
    // promise blue (she would land elsewhere); Mycroft (seat 1, free) keeps its amber.
    const board = buildRosterBoard([mind({ slug: "ada", name: "Ada", identitySlot: 0 })]);
    const starters =
      openSeats(board)[0]?.actions?.filter((x) => x.type === "author-archetype") ?? [];
    const bySlug = new Map(starters.map((s) => [(s.payload as { slug: string }).slug, s]));
    expect(bySlug.get("moneypenny")?.tone).toBeUndefined();
    expect(bySlug.get("mycroft")?.tone).toBe("id-amber");
  });

  test("a full ramp (5 seated) has no open seats but keeps a quiet Author action", () => {
    const five = [0, 1, 2, 3, 4].map((slot) =>
      mind({ slug: `m${slot}`, name: `M${slot}`, identitySlot: slot }),
    );
    const board = buildRosterBoard(five);
    expect(openSeats(board)).toHaveLength(0);
    const author = actionsSection(board, "Author a Mind");
    if (author?.kind !== "actions") throw new Error("no quiet Author action");
    expect(author.items.map((i) => i.type)).toEqual(["describe-own"]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
  });
});

describe("buildRosterBoard convene composer", () => {
  const two = [
    mind({ slug: "a", name: "Ada", identitySlot: 0 }),
    mind({ slug: "b", name: "Bo", identitySlot: 1 }),
  ];

  function whoChips(board: ReturnType<typeof buildRosterBoard>) {
    const section = actionsSection(board, "Convene a room — who's in");
    if (section?.kind !== "actions") throw new Error("no who's-in section");
    return section.items;
  }
  function shapes(board: ReturnType<typeof buildRosterBoard>) {
    const section = actionsSection(board, "…and how");
    return section?.kind === "actions" ? section.items : [];
  }

  test("both composer rows wrap — compact chip rows, not a stacked column", () => {
    const board = buildRosterBoard(two);
    const who = actionsSection(board, "Convene a room — who's in");
    const how = actionsSection(board, "…and how");
    expect(who?.kind === "actions" && who.wrap).toBe(true);
    expect(how?.kind === "actions" && how.wrap).toBe(true);
  });

  test("shape chips carry short labels; the mechanism is taught by each form", () => {
    const items = shapes(buildRosterBoard(two));
    expect(items.map((i) => i.label)).toEqual([
      "Discussion",
      "Debate",
      "Open floor",
      "Review",
      "Build",
    ]);
  });

  test("who's-in chips are identity-toned draft-set toggles, one per Mind", () => {
    const board = buildRosterBoard(two);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const chips = whoChips(board);
    expect(chips.map((c) => c.type)).toEqual(["draft-set", "draft-set"]);
    for (const chip of chips) expect(chip.glyph).toBe("✓");
    expect(chips.map((c) => c.tone)).toEqual(["id-blue", "id-amber"]);
    expect(chips.map((c) => c.payload)).toEqual([{ slug: "a" }, { slug: "b" }]);
    expect(chips.map((c) => c.label)).toEqual(["Ada", "Bo"]);
  });

  test("an excluded slug renders unselected (+ glyph); others stay selected (✓)", () => {
    const board = buildRosterBoard(two, new Set(["a"]));
    const bySlug = new Map(
      whoChips(board).map((c) => [(c.payload as { slug: string }).slug, c.glyph]),
    );
    expect(bySlug.get("a")).toBe("+");
    expect(bySlug.get("b")).toBe("✓");
  });

  test("the five room shapes appear at >= 2 selected, each dispatching convene with its strategy", () => {
    const items = shapes(buildRosterBoard(two));
    expect(items.map((i) => i.type)).toEqual([
      "convene",
      "convene",
      "convene",
      "convene",
      "convene",
    ]);
    expect(items.map((i) => (i.payload as { strategy: string }).strategy)).toEqual([
      "sequential",
      "group-chat",
      "open-floor",
      "review",
      "magentic",
    ]);
    // The server reads the draft — no shape bakes participants into its payload.
    for (const i of items) expect(i.payload ?? {}).not.toHaveProperty("participants");
  });

  test("the Debate shape collects a moderator; Build collects a manager + project", () => {
    const items = shapes(buildRosterBoard(two));
    const byStrategy = new Map(items.map((i) => [(i.payload as { strategy: string }).strategy, i]));
    expect(byStrategy.get("group-chat")?.fields?.map((f) => f.name)).toEqual([
      "topic",
      "moderator",
      "turns",
    ]);
    expect(byStrategy.get("magentic")?.fields?.map((f) => f.name)).toEqual([
      "topic",
      "manager",
      "project",
      "turns",
    ]);
    expect(byStrategy.get("sequential")?.fields?.map((f) => f.name)).toEqual(["topic", "project"]);
  });

  test("shapes are absent below 2 selected, but the chips stay (so the operator can re-select)", () => {
    const board = buildRosterBoard(two, new Set(["a"]));
    expect(whoChips(board)).toHaveLength(2);
    expect(shapes(board)).toHaveLength(0);
  });

  test("shapes are absent when all are excluded", () => {
    expect(shapes(buildRosterBoard(two, new Set(["a", "b"])))).toHaveLength(0);
  });

  test("no room-start action remains anywhere on the board", () => {
    expect(actionItems(buildRosterBoard(two)).some((i) => i.type === "room-start")).toBe(false);
  });
});

describe("buildRosterBoard pulse (leads the board)", () => {
  const two = [mind({ slug: "a", name: "Ada" }), mind({ slug: "b", name: "Bo" })];

  test("omitting pulse, or forYou:false, renders no pulse section at all", () => {
    const omitted = buildRosterBoard(two);
    expect(
      omitted.sections.some((s) => s.kind === "rows" && s.items[0]?.trailing === "Briefing"),
    ).toBe(false);
    const quiet = buildRosterBoard(two, new Set(), { forYou: false });
    expect(quiet.sections).toEqual(omitted.sections);
  });

  test("forYou:true leads the board with one quiet rows line", () => {
    const board = buildRosterBoard(two, new Set(), { forYou: true });
    const first = board.sections[0];
    expect(first?.kind).toBe("rows");
    if (first?.kind !== "rows") throw new Error("expected a rows section");
    expect(first.items).toEqual([
      { glyph: "brand", text: "A briefing is waiting for you.", trailing: "Briefing" },
    ]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
  });

  test("the pulse leads even the cold-start board and stays valid", () => {
    const board = buildRosterBoard([], new Set(), { forYou: true });
    expect(board.sections[0]?.kind).toBe("rows");
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
  });
});
