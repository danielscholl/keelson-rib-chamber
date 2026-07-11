import { describe, expect, test } from "bun:test";
import { canvasViewSchema } from "@keelson/shared";
import { buildPresenceBoard } from "../../src/boards/presence.ts";
import { IDENTITY_SLOT_TONES, type Mind, type Room } from "../../src/types.ts";

const mind = (over: Partial<Mind> = {}): Mind => ({
  slug: "jarvis",
  name: "Jarvis",
  role: "Engineering Partner",
  persona: "You are Jarvis.",
  ...over,
});

const room = (over: Partial<Room> = {}): Room => ({
  slug: "room-1",
  name: "Cluster lifecycle",
  strategy: "sequential",
  participants: ["jarvis", "mycroft"],
  status: "active",
  turnBudget: 6,
  turnIndex: 0,
  round: 0,
  createdAt: "2026-07-11T20:00:00.000Z",
  ...over,
});

function seats(board: ReturnType<typeof buildPresenceBoard>) {
  const col = board.sections.find((s) => s.kind === "columns");
  if (col?.kind !== "columns") throw new Error("no columns section");
  const seatsSection = col.columns.flatMap((c) => c.sections).find((s) => s.kind === "seats");
  if (seatsSection?.kind !== "seats") throw new Error("no seats section");
  return seatsSection.items;
}

function pulse(board: ReturnType<typeof buildPresenceBoard>) {
  const col = board.sections.find((s) => s.kind === "columns");
  if (col?.kind !== "columns") throw new Error("no columns section");
  const stats = col.columns.flatMap((c) => c.sections).find((s) => s.kind === "stats");
  if (stats?.kind !== "stats") throw new Error("no stats section");
  return stats.items[0]!;
}

describe("buildPresenceBoard cold start", () => {
  test("0 minds is a valid board with a genesis nudge and no seats", () => {
    const board = buildPresenceBoard([]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.header?.status?.label).toBe("No minds yet");
    // No columns/seats at cold start — the seats section can't render zero items.
    expect(board.sections.some((s) => s.kind === "columns")).toBe(false);
    const rows = board.sections.find((s) => s.kind === "rows");
    expect(rows?.kind === "rows" && rows.items[0]?.text).toContain("assemble the bench");
  });

  test("an empty bench still shows the live pulse when a room is active", () => {
    // Reachable: retiring every Mind while a room runs (retire doesn't gate on active-room
    // membership). The ribbon must surface the live room, not hide it behind the nudge.
    const board = buildPresenceBoard([], [room({ status: "active" })]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.header?.status?.label).toBe("No minds yet");
    const stats = board.sections.find((s) => s.kind === "stats");
    expect(stats?.kind === "stats" && stats.items[0]?.value).toBe("1 room");
    // The genesis nudge still rides alongside the pulse.
    expect(board.sections.some((s) => s.kind === "rows")).toBe(true);
  });
});

describe("buildPresenceBoard seated", () => {
  test("one identity seat per Mind, each named and toned for life", () => {
    const minds = [
      mind({ slug: "jarvis", name: "Jarvis", identitySlot: 0 }),
      mind({ slug: "mycroft", name: "Mycroft", identitySlot: 1 }),
      mind({ slug: "moneypenny", name: "Moneypenny", identitySlot: 2 }),
    ];
    const board = buildPresenceBoard(minds, []);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.header?.status?.label).toBe("3 minds convene here");
    const s = seats(board);
    expect(s.map((x) => x.label)).toEqual(["Jarvis", "Mycroft", "Moneypenny"]);
    expect(s.map((x) => x.tone)).toEqual([
      IDENTITY_SLOT_TONES[0],
      IDENTITY_SLOT_TONES[1],
      IDENTITY_SLOT_TONES[2],
    ]);
    expect(s.every((x) => x.filled === true)).toBe(true);
  });

  test("a sixth Mind past the ramp folds to neutral, never an invented hue", () => {
    const minds = Array.from({ length: 6 }, (_, i) =>
      mind({ slug: `m${i}`, name: `M${i}`, identitySlot: i }),
    );
    const s = seats(buildPresenceBoard(minds, []));
    expect(s[5]?.tone).toBe("neutral");
    expect(s[5]?.label).toBe("M5");
  });
});

describe("buildPresenceBoard live pulse", () => {
  test("no active room reads 'no room · on the bench'", () => {
    const board = buildPresenceBoard([mind()], [room({ status: "done" })]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const p = pulse(board);
    expect(p.value).toBe("no room");
    expect(p.tone).toBe("neutral");
  });

  test("counts concurrent active rooms — never a single room name", () => {
    // The multi-room reality: two rooms live at once, Minds seated across both. The
    // ribbon reports the COUNT, not one room, and never a per-Mind 'speaking' verb.
    const rooms = [
      room({ slug: "a", status: "active", participants: ["jarvis", "mycroft"] }),
      room({ slug: "b", status: "active", participants: ["jarvis", "moneypenny"] }),
      room({ slug: "c", status: "done" }),
    ];
    const board = buildPresenceBoard([mind()], rooms);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const p = pulse(board);
    expect(p.value).toBe("2 rooms");
    expect(p.tone).toBe("info");
    expect(p.sub).toBe("in session");
  });

  test("a single active room reads singular", () => {
    const p = pulse(buildPresenceBoard([mind()], [room({ status: "active" })]));
    expect(p.value).toBe("1 room");
  });
});
