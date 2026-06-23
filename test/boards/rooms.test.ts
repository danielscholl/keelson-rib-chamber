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

  test("only-active rooms → still the empty state (active never indexed)", () => {
    const board = buildRoomsIndexBoard([room({ status: "active" })]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.header?.status?.label).toBe("0 sessions");
    expect(board.sections.some((s) => s.kind === "cards")).toBe(false);
  });
});

describe("buildRoomsIndexBoard closed sessions", () => {
  test("valid; header counts closed sessions singular/plural, no 'active' count", () => {
    expect(buildRoomsIndexBoard([room()]).header?.status?.label).toBe("1 session");
    const two = buildRoomsIndexBoard([
      room({ slug: "room-1" }),
      room({ slug: "room-2", status: "stopped" }),
    ]);
    expect(canvasViewSchema.safeParse(two).success).toBe(true);
    expect(two.header?.status?.label).toBe("2 sessions");
    // Honest copy: the header never advertises an active count.
    expect(JSON.stringify(two)).not.toContain("active");
  });

  test("lists only CLOSED rooms — an active room is excluded from the cards", () => {
    const board = buildRoomsIndexBoard([
      room({ slug: "live", status: "active" }),
      room({ slug: "ended", status: "done" }),
    ]);
    const titles = cards(board);
    expect(titles).toHaveLength(1);
    expect(JSON.stringify(board)).toContain("ended");
    expect(JSON.stringify(board)).not.toContain("live");
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

  test("each card's only action is a destructive Delete with a typed irreversible confirm", () => {
    const board = buildRoomsIndexBoard([room({ slug: "room-1", name: "Q3 priorities" })]);
    const actions = cards(board)[0]?.actions ?? [];
    expect(actions).toHaveLength(1);
    const del = actions[0];
    expect(del).toMatchObject({
      type: "room-delete",
      label: "Delete room…",
      glyph: "✕",
      tone: "warn",
      destructive: true,
      payload: { slug: "room-1" },
    });
    expect(del?.confirm?.irreversible).toBe(true);
    expect(del?.confirm?.subject).toBe("room-1");
    expect(del?.confirm?.confirmLabel).toBe("Delete");
    expect(del?.confirm?.cancelLabel).toBe("Cancel");
  });

  test("no Open / open-canvas action on the card (deferred — no dead button)", () => {
    const board = buildRoomsIndexBoard([room()]);
    const types = cards(board).flatMap((c) => c.actions?.map((a) => a.type) ?? []);
    expect(types).not.toContain("open-canvas");
    expect(types).not.toContain("room-open");
    expect(JSON.stringify(board)).not.toContain("open-canvas");
  });

  test("the slug rides the serialized board on the Delete payload (guards collect-rooms toContain)", () => {
    const board = buildRoomsIndexBoard([room({ slug: "room-xyz" })]);
    expect(JSON.stringify(board)).toContain("room-xyz");
    const del = cards(board)[0]?.actions?.find((a) => a.type === "room-delete");
    expect((del?.payload as { slug: string }).slug).toBe("room-xyz");
  });
});
