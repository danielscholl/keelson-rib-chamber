import { describe, expect, test } from "bun:test";
import { canvasViewSchema } from "@keelson/shared";
import { buildActivityBoard, type MindActivity } from "../../src/boards/activity.ts";
import type { LensRecord } from "../../src/lens-store.ts";
import type { Room } from "../../src/types.ts";

const NOW = Date.parse("2026-06-24T12:00:00.000Z");
const at = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const mind = (over: Partial<MindActivity> = {}): MindActivity => ({
  name: "Ada",
  createdAt: at(DAY),
  ...over,
});

const room = (over: Partial<Room> = {}): Room => ({
  slug: "room-1",
  name: "Standup",
  strategy: "sequential",
  participants: ["ada", "bo"],
  status: "done",
  turnBudget: 8,
  turnIndex: 4,
  round: 0,
  createdAt: at(2 * HOUR),
  ...over,
});

const lens = (over: Partial<LensRecord> = {}): LensRecord => ({
  id: "release-risks",
  board: { view: "board", title: "Release Risks", sections: [] },
  updatedAt: at(30 * MIN),
  ...over,
});

type Board = ReturnType<typeof buildActivityBoard>;

function statsItems(board: Board) {
  const s = board.sections.find((x) => x.kind === "stats");
  if (s?.kind !== "stats") throw new Error("no stats section");
  return s.items;
}
function feedItems(board: Board) {
  const s = board.sections.find((x) => x.kind === "rows");
  if (s?.kind !== "rows") throw new Error("no rows section");
  return s.items;
}
const byLabel = (board: Board) => new Map(statsItems(board).map((i) => [i.label, i] as const));

describe("buildActivityBoard cold start", () => {
  test("valid board, Quiet header, zeroed neutral pulse, empty-feed hint", () => {
    const board = buildActivityBoard([], [], [], NOW);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.view).toBe("board");
    expect(board.title).toBe("Activity");
    expect(board.header?.chip).toBe("activity");
    expect(board.header?.status?.label).toBe("Quiet");
    expect(board.header?.status?.tone).toBe("neutral");
    const stats = byLabel(board);
    expect([...stats.keys()]).toEqual(["Minds", "Rooms", "Lenses", "Turns"]);
    for (const item of stats.values()) {
      expect(item.value).toBe(0);
      expect(item.tone).toBe("neutral");
    }
    const feed = feedItems(board);
    expect(feed).toHaveLength(1);
    expect(feed[0]?.text).toContain("No activity yet");
  });
});

describe("buildActivityBoard pulse", () => {
  test("counts each store and sums turnIndex into Turns", () => {
    const board = buildActivityBoard(
      [mind(), mind({ name: "Bo" })],
      [room({ slug: "r1", turnIndex: 4 }), room({ slug: "r2", turnIndex: 6, status: "active" })],
      [lens()],
      NOW,
    );
    const stats = byLabel(board);
    expect(stats.get("Minds")?.value).toBe(2);
    expect(stats.get("Rooms")?.value).toBe(2);
    expect(stats.get("Lenses")?.value).toBe(1);
    expect(stats.get("Turns")?.value).toBe(10);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
  });

  test("a non-zero count tones bright; a zero stays neutral (calm idle Chamber)", () => {
    const stats = byLabel(buildActivityBoard([mind()], [], [], NOW));
    expect(stats.get("Minds")?.tone).toBe("brand");
    expect(stats.get("Rooms")?.tone).toBe("neutral");
    expect(stats.get("Turns")?.tone).toBe("neutral");
  });
});

describe("buildActivityBoard feed", () => {
  test("unifies the three stores newest-first with per-kind icon, tone, and trailing", () => {
    const board = buildActivityBoard(
      [mind({ name: "Ada", createdAt: at(3 * DAY) })],
      [room({ slug: "r1", name: "Standup", status: "done", createdAt: at(2 * HOUR) })],
      [
        lens({
          id: "risks",
          board: { view: "board", title: "Risks", sections: [] },
          updatedAt: at(30 * MIN),
        }),
      ],
      NOW,
    );
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const feed = feedItems(board);
    expect(feed.map((i) => i.text)).toEqual([
      'Lens "Risks"',
      'Room "Standup" · done',
      "New Mind · Ada",
    ]);
    expect(feed.map((i) => i.icon)).toEqual(["❖", "▦", "✦"]);
    expect(feed.map((i) => i.glyph)).toEqual(["accent", "info", "brand"]);
    expect(feed.map((i) => i.trailing)).toEqual(["30 minutes ago", "2 hours ago", "3 days ago"]);
  });

  test("room status maps to a tone glyph and a verb", () => {
    const active = feedItems(buildActivityBoard([], [room({ status: "active" })], [], NOW))[0];
    expect(active?.glyph).toBe("ok");
    expect(active?.text).toContain("· active");
    const stopped = feedItems(buildActivityBoard([], [room({ status: "stopped" })], [], NOW))[0];
    expect(stopped?.glyph).toBe("neutral");
    expect(stopped?.text).toContain("· stopped");
  });

  test("a lens scope is appended to its feed text", () => {
    const board = buildActivityBoard([], [], [lens({ scope: "timeline" })], NOW);
    expect(feedItems(board)[0]?.text).toBe('Lens "Release Risks" · timeline');
  });

  test("an unparseable timestamp is counted in the pulse but dropped from the feed", () => {
    const board = buildActivityBoard(
      [mind({ name: "Ghost", createdAt: "" })],
      [],
      [lens({ updatedAt: at(MIN) })],
      NOW,
    );
    expect(byLabel(board).get("Minds")?.value).toBe(1);
    const feed = feedItems(board);
    expect(feed).toHaveLength(1);
    expect(feed.every((i) => !i.text.includes("Ghost"))).toBe(true);
  });

  test("caps the feed at 10 and names the remainder in an overflow row", () => {
    const many = Array.from({ length: 15 }, (_, i) =>
      lens({
        id: `l${i}`,
        board: { view: "board", title: `L${i}`, sections: [] },
        updatedAt: at((i + 1) * MIN),
      }),
    );
    const board = buildActivityBoard([], [], many, NOW);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const feed = feedItems(board);
    expect(feed).toHaveLength(11);
    expect(feed[0]?.text).toBe('Lens "L0"');
    expect(feed[10]?.text).toBe("…5 earlier");
    expect(feed[10]?.trailing).toBeUndefined();
  });
});

describe("buildActivityBoard header freshness", () => {
  test("reads the freshest event: brand while fresh, neutral as it cools, 'active now' at zero", () => {
    const fresh = buildActivityBoard([], [], [lens({ updatedAt: at(5 * MIN) })], NOW);
    expect(fresh.header?.status?.label).toBe("active 5 minutes ago");
    expect(fresh.header?.status?.tone).toBe("brand");
    const cool = buildActivityBoard([], [], [lens({ updatedAt: at(5 * HOUR) })], NOW);
    expect(cool.header?.status?.label).toBe("active 5 hours ago");
    expect(cool.header?.status?.tone).toBe("neutral");
    const now = buildActivityBoard([], [], [lens({ updatedAt: at(0) })], NOW);
    expect(now.header?.status?.label).toBe("active now");
  });
});
