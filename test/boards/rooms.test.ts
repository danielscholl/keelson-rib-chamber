import { describe, expect, test } from "bun:test";
import { type CanvasTone, canvasViewSchema } from "@keelson/shared";
import { buildRoomsIndexBoard } from "../../src/boards/rooms.ts";
import type { Room } from "../../src/types.ts";

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
  test("no rooms → a valid board with the sessions header and no cards section", () => {
    const board = buildRoomsIndexBoard([]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.view).toBe("board");
    expect(board.header?.chip).toBe("sessions");
    expect(board.header?.status?.label).toBe("0 sessions");
    expect(board.sections.some((s) => s.kind === "cards")).toBe(false);
  });

  test("only-active rooms → indexed as status cards (NOT the empty state), counted", () => {
    const board = buildRoomsIndexBoard([room({ status: "active", turnIndex: 2, turnBudget: 6 })]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.header?.status?.label).toBe("1 session");
    const items = cards(board);
    expect(items).toHaveLength(1);
    expect(items[0]?.pill).toEqual({ label: "active · 2/6", tone: "info" });
    expect(items[0]?.dot).toBe("info");
    // An active room is status-only — already live in its inline panel — so its card
    // carries no actions (no frozen-snapshot Open, no orphaning Delete).
    expect(items[0]?.actions).toBeUndefined();
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

  test("active card is status-only (no actions); the closed card keeps Open + Delete", () => {
    const board = buildRoomsIndexBoard([
      room({ slug: "live", status: "active" }),
      room({ slug: "ended", status: "done" }),
    ]);
    const [activeCard, closedCard] = cards(board);
    expect(activeCard?.actions).toBeUndefined();
    expect(closedCard?.actions?.map((a) => a.type)).toEqual(["room-open", "room-delete"]);
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

  test("status pill = `<status> · <turnIndex>/<turnBudget>` with a status tone", () => {
    const done = cards(
      buildRoomsIndexBoard([room({ status: "done", turnIndex: 6, turnBudget: 6 })]),
    );
    expect(done[0]?.pill).toEqual({ label: "done · 6/6", tone: "ok" });
    const stopped = cards(
      buildRoomsIndexBoard([room({ status: "stopped", turnIndex: 3, turnBudget: 8 })]),
    );
    expect(stopped[0]?.pill).toEqual({ label: "stopped · 3/8", tone: "warn" });
  });

  test("fields carry the participants joined by ' · ' and a started-relative time", () => {
    const card = cards(buildRoomsIndexBoard([room({ participants: ["ada", "bo", "cy"] })]))[0];
    expect(card?.fields?.find((f) => f.label === "with")?.value).toBe("ada · bo · cy");
    const started = card?.fields?.find((f) => f.label === "started")?.value;
    // Rendered from createdAt — an "… ago" span, never an invented "ended" time.
    expect(String(started)).toMatch(/ ago$/);
    expect(card?.fields?.some((f) => f.label === "ended")).toBe(false);
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
    expect((open?.payload as { slug: string }).slug).toBe("room-xyz");
    // The open-canvas EFFECT is returned by onAction (server-side), never baked into
    // the board — mirrors the lens card's lens-open.
    expect(JSON.stringify(board)).not.toContain("open-canvas");
  });

  test("the slug rides the serialized board on the Delete payload (guards collect-rooms toContain)", () => {
    const board = buildRoomsIndexBoard([room({ slug: "room-xyz" })]);
    expect(JSON.stringify(board)).toContain("room-xyz");
    const del = cards(board)[0]?.actions?.find((a) => a.type === "room-delete");
    expect((del?.payload as { slug: string }).slug).toBe("room-xyz");
  });
});
