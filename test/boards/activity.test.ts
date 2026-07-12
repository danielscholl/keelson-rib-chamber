import { describe, expect, test } from "bun:test";
import { canvasViewSchema } from "@keelson/shared";
import { type MindActivity, recordSection } from "../../src/boards/activity.ts";
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

// recordSection is one of the Briefing footer's sections; wrap it in a minimal valid
// board so the same canvasViewSchema render gate can prove it.
function wrap(section: ReturnType<typeof recordSection>) {
  return { view: "board" as const, title: "Briefing", sections: [section] };
}

describe("recordSection cold start", () => {
  test("a valid 'The record' rows section with a single empty-feed hint", () => {
    const section = recordSection([], [], [], NOW);
    expect(section.kind).toBe("rows");
    expect(section.title).toBe("The record");
    expect(section.items).toHaveLength(1);
    expect(section.items[0]?.text).toContain("No activity yet");
    expect(canvasViewSchema.safeParse(wrap(section)).success).toBe(true);
  });
});

describe("recordSection feed", () => {
  test("unifies the three stores newest-first with per-kind icon, tone, and trailing", () => {
    const section = recordSection(
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
    expect(canvasViewSchema.safeParse(wrap(section)).success).toBe(true);
    expect(section.items.map((i) => i.text)).toEqual([
      'Lens "Risks"',
      'Room "Standup" · done',
      "New Mind · Ada",
    ]);
    expect(section.items.map((i) => i.icon)).toEqual(["❖", "▦", "✦"]);
    expect(section.items.map((i) => i.glyph)).toEqual(["accent", "info", "brand"]);
    expect(section.items.map((i) => i.trailing)).toEqual([
      "30 minutes ago",
      "2 hours ago",
      "3 days ago",
    ]);
  });

  test("room status maps to a tone glyph and a verb", () => {
    const active = recordSection([], [room({ status: "active" })], [], NOW).items[0];
    expect(active?.glyph).toBe("ok");
    expect(active?.text).toContain("· active");
    const stopped = recordSection([], [room({ status: "stopped" })], [], NOW).items[0];
    expect(stopped?.glyph).toBe("neutral");
    expect(stopped?.text).toContain("· stopped");
  });

  test("a fresh event reads 'just now', not 'just now ago'", () => {
    const section = recordSection([], [], [lens({ updatedAt: at(0) })], NOW);
    expect(section.items[0]?.trailing).toBe("just now");
    // An older event still gets the ' ago' suffix.
    const older = recordSection([], [], [lens({ updatedAt: at(5 * MIN) })], NOW);
    expect(older.items[0]?.trailing).toBe("5 minutes ago");
  });

  test("a lens scope is appended to its feed text", () => {
    const section = recordSection([], [], [lens({ scope: "timeline" })], NOW);
    expect(section.items[0]?.text).toBe('Lens "Release Risks" · timeline');
  });

  test("an exhibit record reads as tabled, not as a lens", () => {
    const section = recordSection([], [], [lens({ kind: "exhibit" })], NOW);
    expect(canvasViewSchema.safeParse(wrap(section)).success).toBe(true);
    expect(section.items[0]).toMatchObject({
      icon: "▣",
      glyph: "accent",
      text: 'Exhibit "Release Risks" · tabled',
    });
  });

  test("an entry with an unparseable timestamp is dropped from the feed", () => {
    const section = recordSection(
      [mind({ name: "Ghost", createdAt: "" })],
      [],
      [lens({ updatedAt: at(MIN) })],
      NOW,
    );
    expect(section.items).toHaveLength(1);
    expect(section.items.every((i) => !i.text.includes("Ghost"))).toBe(true);
  });

  test("caps the feed at 8 and names the remainder in an overflow row", () => {
    const many = Array.from({ length: 15 }, (_, i) =>
      lens({
        id: `l${i}`,
        board: { view: "board", title: `L${i}`, sections: [] },
        updatedAt: at((i + 1) * MIN),
      }),
    );
    const section = recordSection([], [], many, NOW);
    expect(canvasViewSchema.safeParse(wrap(section)).success).toBe(true);
    expect(section.items).toHaveLength(9);
    expect(section.items[0]?.text).toBe('Lens "L0"');
    expect(section.items[8]?.text).toBe("…7 earlier");
    expect(section.items[8]?.trailing).toBeUndefined();
  });

  test("a caller may pass a tighter cap for the always-on banner glance", () => {
    const many = Array.from({ length: 15 }, (_, i) =>
      lens({
        id: `l${i}`,
        board: { view: "board", title: `L${i}`, sections: [] },
        updatedAt: at((i + 1) * MIN),
      }),
    );
    // limit 4 → 4 shown + one overflow row naming the remainder (15 - 4 = 11).
    const section = recordSection([], [], many, NOW, 4);
    expect(canvasViewSchema.safeParse(wrap(section)).success).toBe(true);
    expect(section.items).toHaveLength(5);
    expect(section.items[0]?.text).toBe('Lens "L0"');
    expect(section.items[4]?.text).toBe("…11 earlier");
    expect(section.items[4]?.trailing).toBeUndefined();
  });
});
