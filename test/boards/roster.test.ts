import { describe, expect, test } from "bun:test";
import { type CanvasTone, canvasViewSchema } from "@keelson/shared";
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

const TONES: readonly CanvasTone[] = [
  "ok",
  "warn",
  "error",
  "neutral",
  "info",
  "caution",
  "brand",
  "accent",
];

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

  test("exactly three author-archetype actions in order with verbatim labels", () => {
    const board = buildRosterBoard([]);
    const authors = actionItems(board).filter((i) => i.type === "author-archetype");
    expect(authors).toHaveLength(3);
    expect(authors.map((a) => a.payload)).toEqual(GENESIS_STARTERS.map((s) => ({ slug: s.slug })));
    expect(authors.map((a) => a.label)).toEqual(
      GENESIS_STARTERS.map((s) => `${s.name} — ${s.tagline}`),
    );
    expect(authors.map((a) => (a.payload as { slug: string }).slug)).toEqual([
      "moneypenny",
      "mycroft",
      "jarvis",
    ]);
    for (const a of authors) expect(a.type).toBe("author-archetype");
  });

  test("a describe-own action carries the verbatim brief field", () => {
    const board = buildRosterBoard([]);
    const own = actionItems(board).find((i) => i.type === "describe-own");
    expect(own?.label).toBe("Describe & author");
    expect(own?.fields).toEqual([
      {
        name: "brief",
        label: "Or describe your own",
        placeholder:
          'Who should this feel like? e.g. "Athena — a skeptical staff engineer who guards the architecture"',
        multiline: true,
      },
    ]);
  });

  test("the trailing rows item carries the verbatim next-step text + trailing", () => {
    const board = buildRosterBoard([]);
    const rows = board.sections.filter((s) => s.kind === "rows");
    const last = rows[rows.length - 1];
    if (last?.kind !== "rows") throw new Error("no trailing rows section");
    expect(last.items[0]?.text).toBe(
      "Next: with two Minds you can convene a Room; any Mind can keep a Lens. Each appears as its own panel here once it exists.",
    );
    expect(last.items[0]?.trailing).toBe("what's next");
  });

  test("no Enter/Retire actions section, no cards, only the three documented sections", () => {
    const board = buildRosterBoard([]);
    expect(actionsSection(board, "Enter")).toBeUndefined();
    expect(actionsSection(board, "Retire")).toBeUndefined();
    expect(board.sections.some((s) => s.kind === "cards")).toBe(false);
    expect(board.sections).toHaveLength(3);
    expect(board.sections.map((s) => s.kind)).toEqual(["rows", "actions", "rows"]);
  });
});

describe("buildRosterBoard populated", () => {
  test("valid; header counts singular/plural", () => {
    expect(buildRosterBoard([mind()]).header?.status?.label).toBe("1 mind");
    const two = buildRosterBoard([mind({ slug: "a" }), mind({ slug: "b", name: "Bo" })]);
    expect(canvasViewSchema.safeParse(two).success).toBe(true);
    expect(two.header?.status?.label).toBe("2 minds");
  });

  test("each card dot is a canvas tone; dotFor is deterministic and can differ", () => {
    const board = buildRosterBoard([mind({ slug: "a" }), mind({ slug: "moneypenny", name: "M" })]);
    for (const card of cards(board)) {
      expect(card.dot).toBeDefined();
      expect(TONES).toContain(card.dot as CanvasTone);
    }
    // Determinism: the same slug hashes to the same dot across two builds.
    const again = buildRosterBoard([mind({ slug: "a" })]);
    expect(cards(again)[0]?.dot).toBe(cards(board)[0]?.dot);
    // Distinct slugs don't all collapse to one tone. Order-independent: a
    // DOT_TONES reorder permutes the tone labels but not how many distinct tones
    // a fixed slug set lands on.
    const spread = buildRosterBoard(
      ["a", "b", "c", "d", "e", "f", "g", "h"].map((slug) => mind({ slug })),
    );
    expect(new Set(cards(spread).map((c) => c.dot)).size).toBeGreaterThan(1);
  });

  test("exactly one pill per card carrying the role, never the slug", () => {
    const board = buildRosterBoard([mind({ slug: "ada", role: "Chief of Staff" })]);
    const card = cards(board)[0];
    expect(card?.pill).toEqual({ label: "Chief of Staff" });
  });

  test("an empty role falls back to a 'Mind' pill", () => {
    expect(cards(buildRosterBoard([mind({ role: "" })]))[0]?.pill?.label).toBe("Mind");
  });

  test("fields: a truncated persona ((no persona) fallback) and model only when set", () => {
    const withModel = cards(buildRosterBoard([mind({ model: "claude-x" })]))[0];
    expect(withModel?.fields?.find((f) => f.label === "persona")?.value).toBe("You are Ada.");
    expect(withModel?.fields?.find((f) => f.label === "model")?.value).toBe("claude-x");
    const noModel = cards(buildRosterBoard([mind({ model: undefined })]))[0];
    expect(noModel?.fields?.some((f) => f.label === "model")).toBe(false);
    const noPersona = cards(buildRosterBoard([mind({ persona: "   " })]))[0];
    expect(noPersona?.fields?.find((f) => f.label === "persona")?.value).toBe("(no persona)");
  });

  test("the slug still rides the serialized board (guards collect-roster toContain)", () => {
    expect(JSON.stringify(buildRosterBoard([mind({ slug: "ada" })]))).toContain("ada");
  });

  test("each card.actions has a destructive Retire with a typed irreversible confirm", () => {
    const board = buildRosterBoard([mind({ slug: "ada", name: "Ada" })]);
    const retire = cards(board)[0]?.actions?.find((a) => a.type === "retire");
    expect(retire).toMatchObject({
      type: "retire",
      label: "Retire Mind…",
      glyph: "✕",
      tone: "warn",
      destructive: true,
      payload: { slug: "ada" },
    });
    expect(retire?.confirm?.irreversible).toBe(true);
    expect(retire?.confirm?.subject).toBe("ada");
  });

  test("each card.actions leads with a non-destructive Enter carrying the slug", () => {
    const board = buildRosterBoard([mind({ slug: "ada", name: "Ada" })]);
    const actions = cards(board)[0]?.actions ?? [];
    const enter = actions.find((a) => a.type === "enter-mind");
    expect(enter).toMatchObject({
      type: "enter-mind",
      label: "Enter Ada",
      glyph: "→",
      payload: { slug: "ada" },
    });
    // Non-destructive (so the host renders it inline, not in the overflow) and
    // un-gated — no confirm.
    expect(enter?.destructive ?? false).toBe(false);
    expect(enter?.confirm).toBeUndefined();
    // Enter is the primary verb: it precedes the destructive Retire on the card.
    expect(actions[0]?.type).toBe("enter-mind");
    expect(actions.findIndex((a) => a.type === "enter-mind")).toBeLessThan(
      actions.findIndex((a) => a.type === "retire"),
    );
  });

  test("no standalone actions section titled Enter; Enter lives on each card", () => {
    const board = buildRosterBoard([mind({ slug: "a" }), mind({ slug: "b", name: "Bo" })]);
    // Enter moved onto the card (host renders non-destructive card actions inline),
    // so there is no separate button-list section for it.
    expect(actionsSection(board, "Enter")).toBeUndefined();
    expect(actionItems(board).some((i) => i.type === "enter-mind")).toBe(false);
    // One enter-mind card action per Mind, each carrying its own slug.
    const enters = cards(board).map((c) => c.actions?.find((a) => a.type === "enter-mind"));
    expect(enters.map((e) => e?.payload)).toEqual([{ slug: "a" }, { slug: "b" }]);
    for (const e of enters) expect(e?.glyph).toBe("→");
  });

  test("no standalone actions-section item of type retire", () => {
    const board = buildRosterBoard([mind({ slug: "a" }), mind({ slug: "b", name: "Bo" })]);
    expect(actionItems(board).some((i) => i.type === "retire")).toBe(false);
  });

  test("the Convene-a-room composer appears only at >= 2 minds", () => {
    expect(actionsSection(buildRosterBoard([mind()]), "Convene a room")).toBeUndefined();
    const board = buildRosterBoard([mind({ slug: "a" }), mind({ slug: "b", name: "Bo" })]);
    expect(actionsSection(board, "Convene a room")?.kind).toBe("actions");
  });
});

describe("buildRosterBoard convene composer", () => {
  const two = [mind({ slug: "a", name: "Ada" }), mind({ slug: "b", name: "Bo" })];

  function convene(board: ReturnType<typeof buildRosterBoard>) {
    const section = actionsSection(board, "Convene a room");
    if (section?.kind !== "actions") throw new Error("no Convene section");
    return section.items;
  }
  const chips = (board: ReturnType<typeof buildRosterBoard>) =>
    convene(board).filter((i) => i.type === "draft-set");
  const conveneAction = (board: ReturnType<typeof buildRosterBoard>) =>
    convene(board).find((i) => i.type === "convene");

  test("default (empty exclusion) renders one selected chip per Mind", () => {
    const board = buildRosterBoard(two);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const items = chips(board);
    expect(items).toHaveLength(2);
    // ✓ glyph = selected; each chip is a draft-set action carrying only its slug.
    for (const chip of items) expect(chip.glyph).toBe("✓");
    expect(items.map((c) => c.payload)).toEqual([{ slug: "a" }, { slug: "b" }]);
    expect(items.map((c) => c.label)).toEqual(["Ada", "Bo"]);
  });

  test("an excluded slug renders unselected (+ glyph); others stay selected (✓)", () => {
    const board = buildRosterBoard(two, new Set(["a"]));
    const bySlug = new Map(
      chips(board).map((c) => [(c.payload as { slug: string }).slug, c.glyph]),
    );
    expect(bySlug.get("a")).toBe("+");
    expect(bySlug.get("b")).toBe("✓");
  });

  test("Convene is present at >= 2 selected and carries NO participants in its payload", () => {
    const action = conveneAction(buildRosterBoard(two));
    expect(action).toBeDefined();
    expect(action?.glyph).toBe("▸");
    // The server reads the draft — the action must not bake participants.
    expect(action?.payload ?? {}).not.toHaveProperty("participants");
    // It does carry the optional topic capture field.
    expect(action?.fields?.[0]?.name).toBe("topic");
  });

  test("Convene is absent below 2 selected (one excluded of two)", () => {
    const board = buildRosterBoard(two, new Set(["a"]));
    // Chips still render (so the operator can re-select), but Convene is omitted —
    // validateStart needs >= 2 distinct participants.
    expect(chips(board)).toHaveLength(2);
    expect(conveneAction(board)).toBeUndefined();
  });

  test("Convene is absent when all are excluded", () => {
    expect(conveneAction(buildRosterBoard(two, new Set(["a", "b"])))).toBeUndefined();
  });

  test("the board stays valid with an excluded slug and no Convene", () => {
    expect(canvasViewSchema.safeParse(buildRosterBoard(two, new Set(["a"]))).success).toBe(true);
  });

  test("no room-start action remains anywhere on the board", () => {
    expect(actionItems(buildRosterBoard(two)).some((i) => i.type === "room-start")).toBe(false);
  });
});
