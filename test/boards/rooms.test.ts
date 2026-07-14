import { describe, expect, test } from "bun:test";
import { type CanvasTone, canvasViewSchema } from "@keelson/shared";
import { buildRoomsIndexBoard } from "../../src/boards/rooms.ts";
import type { Mind, Room } from "../../src/types.ts";

const room = (over: Partial<Room> = {}): Room => ({
  slug: "room-1",
  name: "Q3 priorities",
  strategy: "sequential",
  participants: ["ada", "bo"],
  status: "done",
  turnBudget: 6,
  turnIndex: 6,
  round: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

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

function cards(board: ReturnType<typeof buildRoomsIndexBoard>) {
  const section = board.sections.find((s) => s.kind === "cards");
  if (section?.kind !== "cards") throw new Error("no cards section");
  return section.items;
}

describe("buildRoomsIndexBoard empty", () => {
  test("no rooms → a valid header-only board with the sessions header and no body", () => {
    const board = buildRoomsIndexBoard([]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.view).toBe("board");
    expect(board.header?.chip).toBe("sessions");
    expect(board.header?.status?.label).toBe("0 sessions");
    expect(board.sections).toHaveLength(0);
  });

  test("only-active rooms → indexed as status cards (NOT the empty state), counted", () => {
    const board = buildRoomsIndexBoard([room({ status: "active", turnIndex: 2, turnBudget: 6 })]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.header?.status?.label).toBe("1 session");
    const items = cards(board);
    expect(items).toHaveLength(1);
    // The pill carries STATE (the status word); the bar carries MAGNITUDE (progress).
    expect(items[0]?.pill).toEqual({ label: "active", tone: "info" });
    expect(items[0]?.bar).toEqual({ value: 2, total: 6 });
    expect(items[0]?.dot).toBe("info");
    // Open is how a live room is watched; Delete is withheld because the handler
    // refuses a live room.
    expect(items[0]?.actions?.map((a) => a.type)).toEqual(["room-open"]);
  });
});

describe("buildRoomsIndexBoard active + closed", () => {
  test("active rooms come first, then closed; header counts BOTH", () => {
    const board = buildRoomsIndexBoard([
      room({ slug: "live", name: "Live", status: "active" }),
      room({ slug: "ended", name: "Ended", status: "done" }),
    ]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.header?.status?.label).toBe("2 sessions");
    expect(cards(board).map((c) => c.title)).toEqual(["Live", "Ended"]);
  });

  test("both cards Open; only the closed one Deletes", () => {
    const board = buildRoomsIndexBoard([
      room({ slug: "live", status: "active" }),
      room({ slug: "ended", status: "done" }),
    ]);
    const [activeCard, closedCard] = cards(board);
    expect(activeCard?.actions?.map((a) => a.type)).toEqual(["room-open"]);
    expect(closedCard?.actions?.map((a) => a.type)).toEqual(["room-open", "room-delete"]);
  });

  test("only a marked closed room gains one Summary action between Open and Delete", () => {
    const board = buildRoomsIndexBoard(
      [
        room({ slug: "live", status: "active", outcomeAt: "2026-01-01T00:05:00.000Z" }),
        room({ slug: "marked", status: "done", outcomeAt: "2026-01-01T00:05:00.000Z" }),
        room({ slug: "legacy", status: "done" }),
      ],
      [],
      [],
      new Set(["live", "marked"]),
    );
    const [activeCard, markedCard, legacyCard] = cards(board);
    expect(activeCard?.actions?.map((action) => action.type)).toEqual(["room-open"]);
    expect(markedCard?.actions?.map((action) => action.type)).toEqual([
      "room-open",
      "room-summary",
      "room-delete",
    ]);
    expect(markedCard?.actions?.[1]).toEqual({
      type: "room-summary",
      label: "Summary",
      glyph: "☰",
      payload: { slug: "marked" },
    });
    expect(legacyCard?.actions?.map((action) => action.type)).toEqual([
      "room-open",
      "room-delete",
    ]);
  });

  test("a stopped room Deletes — only an ACTIVE room withholds it", () => {
    const board = buildRoomsIndexBoard([room({ slug: "halted", status: "stopped" })]);
    expect(cards(board)[0]?.actions?.map((a) => a.type)).toEqual(["room-open", "room-delete"]);
  });
});

describe("buildRoomsIndexBoard closed sessions", () => {
  test("valid; header counts sessions singular/plural", () => {
    expect(buildRoomsIndexBoard([room()]).header?.status?.label).toBe("1 session");
    const two = buildRoomsIndexBoard([
      room({ slug: "room-1" }),
      room({ slug: "room-2", status: "stopped" }),
    ]);
    expect(canvasViewSchema.safeParse(two).success).toBe(true);
    expect(two.header?.status?.label).toBe("2 sessions");
  });

  test("one card per closed room, preserving the given (newest-first) order", () => {
    const board = buildRoomsIndexBoard([
      room({ slug: "newer", name: "Newer" }),
      room({ slug: "older", name: "Older", status: "stopped" }),
    ]);
    expect(cards(board).map((c) => c.title)).toEqual(["Newer", "Older"]);
  });

  test("each card dot is a valid tone toned by status (done→ok, stopped→warn)", () => {
    const board = buildRoomsIndexBoard([
      room({ slug: "d", status: "done" }),
      room({ slug: "s", status: "stopped" }),
    ]);
    for (const c of cards(board)) expect(TONES).toContain(c.dot as CanvasTone);
    expect(cards(board)[0]?.dot).toBe("ok");
    expect(cards(board)[1]?.dot).toBe("warn");
  });

  test("pill = the status word (one job), bar = turn progress, turns field in ink", () => {
    const done = cards(
      buildRoomsIndexBoard([room({ status: "done", turnIndex: 6, turnBudget: 6 })]),
    );
    expect(done[0]?.pill).toEqual({ label: "done", tone: "ok" });
    expect(done[0]?.bar).toEqual({ value: 6, total: 6 });
    expect(done[0]?.fields?.find((f) => f.label === "turns")?.value).toBe("6/6");
    const stopped = cards(
      buildRoomsIndexBoard([room({ status: "stopped", turnIndex: 3, turnBudget: 8 })]),
    );
    expect(stopped[0]?.pill).toEqual({ label: "stopped", tone: "warn" });
    expect(stopped[0]?.bar).toEqual({ value: 3, total: 8 });
    expect(stopped[0]?.fields?.find((f) => f.label === "turns")?.value).toBe("3/8");
  });

  test("closing-turn overflow is labeled while the bar stays capped", () => {
    const [card] = cards(
      buildRoomsIndexBoard([room({ status: "done", turnIndex: 9, turnBudget: 8 })]),
    );
    expect(
      canvasViewSchema.safeParse(buildRoomsIndexBoard([room({ turnIndex: 9, turnBudget: 8 })]))
        .success,
    ).toBe(true);
    expect(card?.bar).toEqual({ value: 8, total: 8 });
    expect(card?.fields?.find((f) => f.label === "turns")?.value).toBe("8/8 + closing");
  });

  test("the shape field names the strategy and its facilitator", () => {
    const seq = cards(buildRoomsIndexBoard([room({ strategy: "sequential" })]));
    expect(seq[0]?.fields?.find((f) => f.label === "shape")?.value).toBe("discussion");
    const debate = cards(
      buildRoomsIndexBoard([room({ strategy: "group-chat", config: { moderator: "moneypenny" } })]),
    );
    expect(debate[0]?.fields?.find((f) => f.label === "shape")?.value).toBe(
      "debate · moneypenny moderates",
    );
    const delegate = cards(
      buildRoomsIndexBoard([room({ strategy: "magentic", config: { manager: "mycroft" } })]),
    );
    expect(delegate[0]?.fields?.find((f) => f.label === "shape")?.value).toBe(
      "delegate · mycroft manages",
    );
  });

  test("the round cursor is a field only once it has advanced (0 for a plain sequential room)", () => {
    const seq = cards(buildRoomsIndexBoard([room({ round: 0 })]))[0];
    expect(seq?.fields?.some((f) => f.label === "round")).toBe(false);
    const rounds = cards(buildRoomsIndexBoard([room({ strategy: "group-chat", round: 3 })]))[0];
    expect(rounds?.fields?.find((f) => f.label === "round")?.value).toBe("3");
  });

  test("the with field is a people list; names resolve to Minds' identity tones", () => {
    const minds = [
      mind({ slug: "ada", name: "Ada", identitySlot: 0 }),
      mind({ slug: "bo", name: "Bo", identitySlot: 2 }),
    ];
    const board = buildRoomsIndexBoard([room({ participants: ["ada", "bo", "cy"] })], minds);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const withField = cards(board)[0]?.fields?.find((f) => f.label === "with");
    // A seated slug wears its Mind's display name + seat hue; a retired/unknown
    // slug stays the bare slug with no tone (the muted dot).
    expect(withField?.people).toEqual([
      { name: "Ada", tone: "id-blue" },
      { name: "Bo", tone: "id-teal" },
      { name: "cy" },
    ]);
    expect(withField?.value).toBeUndefined();
  });

  test("without minds the cast folds to bare slugs; a started-relative time renders", () => {
    const card = cards(buildRoomsIndexBoard([room({ participants: ["ada", "bo", "cy"] })]))[0];
    expect(card?.fields?.find((f) => f.label === "with")?.people).toEqual([
      { name: "ada" },
      { name: "bo" },
      { name: "cy" },
    ]);
    const started = card?.fields?.find((f) => f.label === "started")?.value;
    // Rendered from createdAt — an "… ago" span, never an invented "ended" time.
    expect(String(started)).toMatch(/ ago$/);
    expect(card?.fields?.some((f) => f.label === "ended")).toBe(false);
  });

  test("a drifted no-participant room omits the with field (an empty people list is invalid)", () => {
    const board = buildRoomsIndexBoard([room({ participants: [] })]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(cards(board)[0]?.fields?.some((f) => f.label === "with")).toBe(false);
  });

  test("each card has an inline Open then a destructive Delete with a simple confirm", () => {
    const board = buildRoomsIndexBoard([room({ slug: "room-1", name: "Q3 priorities" })]);
    const actions = cards(board)[0]?.actions ?? [];
    expect(actions).toHaveLength(2);
    // Open is the primary, non-destructive verb (the host renders it inline).
    expect(actions[0]).toEqual({
      type: "room-open",
      label: "Open",
      glyph: "↗",
      payload: { slug: "room-1" },
    });
    expect(actions[0]?.destructive).toBeUndefined();
    const del = actions[1];
    expect(del).toMatchObject({
      type: "room-delete",
      label: "Delete room…",
      glyph: "✕",
      tone: "warn",
      destructive: true,
      payload: { slug: "room-1" },
    });
    expect(del?.confirm?.irreversible).toBeUndefined();
    expect(del?.confirm?.subject).toBeUndefined();
    expect(del?.confirm?.confirmLabel).toBe("Delete");
    expect(del?.confirm?.cancelLabel).toBe("Cancel");
  });

  test("the card's Open is a room-open carrying the slug; the board itself names no effect", () => {
    const board = buildRoomsIndexBoard([room({ slug: "room-xyz" })]);
    const open = cards(board)[0]?.actions?.find((a) => a.type === "room-open");
    expect((open?.payload as { slug: string })?.slug).toBe("room-xyz");
    // The open-canvas EFFECT is returned by onAction (server-side), never baked into
    // the board — mirrors the lens card's lens-open.
    expect(JSON.stringify(board)).not.toContain("open-canvas");
  });

  test("the slug rides the serialized board on the Delete payload (guards collect-rooms toContain)", () => {
    const board = buildRoomsIndexBoard([room({ slug: "room-xyz" })]);
    expect(JSON.stringify(board)).toContain("room-xyz");
    const del = cards(board)[0]?.actions?.find((a) => a.type === "room-delete");
    expect((del?.payload as { slug: string })?.slug).toBe("room-xyz");
  });
});

describe("buildRoomsIndexBoard tabled exhibits", () => {
  const exhibit = (id: string, sourceRoom: string, title = "") => ({
    id,
    board: { view: "board" as const, title, sections: [] },
    updatedAt: "2026-01-01T00:00:00.000Z",
    kind: "exhibit" as const,
    sourceRoom,
  });

  test("the delete confirm counts the exhibits it will take, and says nothing when there are none", () => {
    // The dialog is the only consent gate on this path, and the delete cascades — an
    // operator reads its enumeration as the whole blast radius.
    const bare = buildRoomsIndexBoard([room({ slug: "bare", name: "Bare", status: "done" })]);
    const bareBody = cards(bare)[0]?.actions?.find((a) => a.type === "room-delete")?.confirm?.body;
    expect(bareBody).toBe("Delete Bare? This permanently removes the session and its transcript.");

    const one = buildRoomsIndexBoard(
      [room({ slug: "solo", name: "Solo", status: "done" })],
      [],
      [exhibit("verdict", "solo")],
    );
    expect(cards(one)[0]?.actions?.find((a) => a.type === "room-delete")?.confirm?.body).toBe(
      "Delete Solo? This permanently removes the session, its transcript, and the 1 exhibit it tabled.",
    );

    const many = buildRoomsIndexBoard(
      [room({ slug: "pair", name: "Pair", status: "done" })],
      [],
      [exhibit("a", "pair"), exhibit("b", "pair")],
    );
    expect(cards(many)[0]?.actions?.find((a) => a.type === "room-delete")?.confirm?.body).toBe(
      "Delete Pair? This permanently removes the session, its transcript, and the 2 exhibits it tabled.",
    );
  });

  test("a closed card names its tabled exhibits — only THIS room's", () => {
    const board = buildRoomsIndexBoard(
      [room({ slug: "review", status: "done" })],
      [],
      [exhibit("assessment", "review", "Sample Assessment"), exhibit("elsewhere", "other-room")],
    );
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const [card] = cards(board);
    // Only THIS room's exhibits ride the card — sourceRoom is the join key.
    expect(card?.fields?.find((f) => f.label === "tabled")).toEqual({
      label: "tabled",
      value: "Sample Assessment",
      tone: "accent",
    });
    expect(card?.pill).toEqual({ label: "done", tone: "ok" });
    // The card names them; it does not link them. Every card lands on the same two
    // verbs, so its footprint is the same whether the room tabled nothing or ten.
    expect(card?.actions?.map((a) => a.type)).toEqual(["room-open", "room-delete"]);
  });

  test("an active card names what it tabled but links none of it open; an untitled exhibit falls back to its id", () => {
    const board = buildRoomsIndexBoard(
      [room({ slug: "live", status: "active" })],
      [],
      [exhibit("draft-plan", "live")],
    );
    const [card] = cards(board);
    expect(card?.fields?.find((f) => f.label === "tabled")).toEqual({
      label: "tabled",
      value: "draft-plan",
      tone: "accent",
    });
    expect(card?.pill).toEqual({ label: "active", tone: "info" });
    // A live room is reached through its own board, which lists its exhibits — the index
    // card says only that it has some.
    expect(card?.actions?.map((a) => a.type)).toEqual(["room-open"]);
  });

  test("no exhibits for a room → no tabled field (fail-soft like every provenance bit)", () => {
    const board = buildRoomsIndexBoard([room({ slug: "bare" })], [], []);
    expect(cards(board)[0]?.fields?.some((f) => f.label === "tabled")).toBe(false);
    expect(cards(board)[0]?.pill).toEqual({ label: "done", tone: "ok" });
  });

  test("several exhibits collapse to a toned count without adding actions", () => {
    const board = buildRoomsIndexBoard(
      [room({ slug: "review", status: "done" })],
      [],
      [
        exhibit("assessment", "review", "Sample Assessment"),
        exhibit("verdict", "review", "Final Verdict"),
      ],
    );
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const [card] = cards(board);
    expect(card?.fields?.find((f) => f.label === "tabled")).toEqual({
      label: "tabled",
      value: "2 exhibits",
      tone: "accent",
    });
    expect(card?.pill).toEqual({ label: "done", tone: "ok" });
    expect(card?.actions?.map((a) => a.type)).toEqual(["room-open", "room-delete"]);
  });

  test("the builder itself keeps only exhibits — a raw store listing can't leak lenses onto a card", () => {
    const standing = { ...exhibit("standing-view", "review"), kind: undefined };
    const board = buildRoomsIndexBoard(
      [room({ slug: "review", status: "done" })],
      [],
      [standing, exhibit("assessment", "review", "Sample Assessment")],
    );
    const [card] = cards(board);
    // The kind filter still guards the field and the delete count, even with no per-
    // exhibit link left to leak onto.
    expect(card?.fields?.find((f) => f.label === "tabled")).toEqual({
      label: "tabled",
      value: "Sample Assessment",
      tone: "accent",
    });
    expect(card?.actions?.find((a) => a.type === "room-delete")?.confirm?.body).toContain(
      "the 1 exhibit it tabled",
    );
  });

  test("no card links an exhibit open — that is the room's own board's job", () => {
    const board = buildRoomsIndexBoard(
      [room({ slug: "review", status: "done" }), room({ slug: "live", status: "active" })],
      [],
      [exhibit("a", "review"), exhibit("b", "review"), exhibit("c", "live")],
    );
    for (const card of cards(board)) {
      expect(card.actions?.some((a) => a.type === "lens-open")).toBe(false);
    }
  });
});
