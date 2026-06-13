import { describe, expect, test } from "bun:test";
import { canvasViewSchema } from "@keelson/shared";
import { buildRoomBoard } from "../../src/boards/room.ts";
import type { Room, TurnEntry } from "../../src/types.ts";

const room = (over: Partial<Room> = {}): Room => ({
  slug: "r",
  name: "Room",
  strategy: "sequential",
  participants: ["a", "b"],
  status: "active",
  turnBudget: 6,
  turnIndex: 0,
  round: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const entry = (over: Partial<TurnEntry> = {}): TurnEntry => ({
  messageId: "m",
  roomSlug: "r",
  turnIndex: 0,
  from: "a",
  role: "agent",
  parts: [{ text: "hello" }],
  at: "2026-01-01T00:00:00.000Z",
  ...over,
});

describe("buildRoomBoard", () => {
  test("empty transcript is valid; segments per participant with n=0", () => {
    const board = buildRoomBoard(room(), []);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.header?.segments).toEqual([
      { label: "a", n: 0 },
      { label: "b", n: 0 },
    ]);
  });

  test("one row per entry; segment counts match agent turns", () => {
    const board = buildRoomBoard(room(), [
      entry({ from: "a" }),
      entry({ from: "b" }),
      entry({ from: "a" }),
      entry({ from: "director", role: "director", parts: [{ text: "steer" }] }),
    ]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const section = board.sections[0];
    expect(section?.kind).toBe("rows");
    if (section?.kind === "rows") expect(section.items).toHaveLength(4);
    expect(board.header?.segments).toEqual([
      { label: "a", n: 2 },
      { label: "b", n: 1 },
    ]);
  });

  test("empty turn text is coalesced to a placeholder (text min(1))", () => {
    const board = buildRoomBoard(room(), [entry({ parts: [{ text: "" }] })]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
  });

  test("aborted entries and every status tone stay valid", () => {
    for (const status of ["active", "stopped", "done"] as const) {
      const board = buildRoomBoard(room({ status }), [
        entry({ aborted: true, parts: [{ text: "" }] }),
      ]);
      expect(canvasViewSchema.safeParse(board).success).toBe(true);
    }
  });

  test("an active room bakes Call-on-<participant> + Stop controls carrying the slug", () => {
    const board = buildRoomBoard(room({ slug: "r", participants: ["a", "b"] }), []);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const actions = board.sections.find((s) => s.kind === "actions");
    expect(actions?.kind).toBe("actions");
    if (actions?.kind !== "actions") throw new Error("no actions section");
    const byType = (t: string) => actions.items.filter((i) => i.type === t);
    // No manual "Next": turns auto-advance, so a manual stepper would only race
    // the loop.
    expect(byType("room-next")).toHaveLength(0);
    expect(byType("room-stop")[0]?.payload).toEqual({ slug: "r" });
    const calls = byType("room-inject").map((i) => i.payload);
    expect(calls).toEqual([
      { slug: "r", nextSpeaker: "a" },
      { slug: "r", nextSpeaker: "b" },
    ]);
  });

  test("a closed room offers Start-again + Start group-chat + Start open-floor", () => {
    for (const status of ["stopped", "done"] as const) {
      const board = buildRoomBoard(room({ status, participants: ["a", "b"], turnBudget: 6 }), []);
      expect(canvasViewSchema.safeParse(board).success).toBe(true);
      const actions = board.sections.find((s) => s.kind === "actions");
      if (actions?.kind !== "actions") throw new Error("no actions section");
      expect(actions.items.map((i) => i.type)).toEqual(["room-start", "room-start", "room-start"]);
      expect(actions.items.map((i) => i.label)).toEqual([
        "Start again",
        "Start group-chat",
        "Start open-floor",
      ]);
      // Start again — no slug (the server assigns a fresh one per start).
      expect(actions.items[0]?.payload).toMatchObject({ turnBudget: 6, participants: ["a", "b"] });
    }
  });

  test("a finished group-chat's Start-again round-trips the moderator config", () => {
    const board = buildRoomBoard(
      room({ status: "done", strategy: "group-chat", config: { moderator: "mod", minRounds: 2 } }),
      [],
    );
    const actions = board.sections.find((s) => s.kind === "actions");
    if (actions?.kind !== "actions") throw new Error("no actions section");
    expect(actions.items[0]?.payload).toMatchObject({
      strategy: "group-chat",
      moderator: "mod",
      minRounds: 2,
    });
  });

  test("a finished open-floor's Start-again round-trips the end-vote threshold", () => {
    const board = buildRoomBoard(
      room({ status: "done", strategy: "open-floor", config: { endVoteThreshold: 0.6 } }),
      [],
    );
    const actions = board.sections.find((s) => s.kind === "actions");
    if (actions?.kind !== "actions") throw new Error("no actions section");
    expect(actions.items[0]?.payload).toMatchObject({
      strategy: "open-floor",
      endVoteThreshold: 0.6,
    });
  });

  test("the Start group-chat action collects a moderator via a field form", () => {
    const board = buildRoomBoard(room({ status: "done", participants: ["a", "b"] }), []);
    const actions = board.sections.find((s) => s.kind === "actions");
    if (actions?.kind !== "actions") throw new Error("no actions section");
    const gc = actions.items.find((i) => i.label === "Start group-chat");
    expect(gc?.payload).toMatchObject({ strategy: "group-chat", participants: ["a", "b"] });
    expect(gc?.fields).toEqual([
      {
        name: "moderator",
        label: "Moderator (a Mind not in the room)",
        placeholder: "mind-slug",
        required: true,
      },
    ]);
  });

  test("the Start open-floor action carries the strategy with no required fields", () => {
    const board = buildRoomBoard(room({ status: "done", participants: ["a", "b"] }), []);
    const actions = board.sections.find((s) => s.kind === "actions");
    if (actions?.kind !== "actions") throw new Error("no actions section");
    const of = actions.items.find((i) => i.label === "Start open-floor");
    expect(of?.payload).toMatchObject({ strategy: "open-floor", participants: ["a", "b"] });
    expect(of?.fields).toBeUndefined();
  });

  test("a room with a topic shows it as a leading Topic section", () => {
    const board = buildRoomBoard(room({ topic: "Ship strategies before lenses?" }), []);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const first = board.sections[0];
    expect(first?.kind).toBe("rows");
    if (first?.kind === "rows") {
      expect(first.title).toBe("Topic");
      expect(first.items[0]?.text).toBe("Ship strategies before lenses?");
    }
  });

  test("no Topic section when the room has no topic", () => {
    const board = buildRoomBoard(room(), []);
    const titled = board.sections.find((s) => s.kind === "rows" && s.title === "Topic");
    expect(titled).toBeUndefined();
  });

  test("Start-again carries the room's topic so a restart keeps its subject", () => {
    const board = buildRoomBoard(room({ status: "done", topic: "Q3 roadmap" }), []);
    const actions = board.sections.find((s) => s.kind === "actions");
    if (actions?.kind !== "actions") throw new Error("no actions section");
    expect(actions.items[0]?.payload).toMatchObject({ topic: "Q3 roadmap" });
  });

  const feedOf = (board: ReturnType<typeof buildRoomBoard>) => {
    const feed = board.sections[0];
    if (feed?.kind !== "rows") throw new Error("expected a rows feed");
    return feed.items;
  };

  test("the synthesizer's closing summary reads as a distinct brand chip + icon", () => {
    const board = buildRoomBoard(
      room({
        status: "done",
        strategy: "group-chat",
        config: { moderator: "mod", synthesizer: "s" },
      }),
      [entry({ from: "a" }), entry({ from: "s", parts: [{ text: "in summary" }] })],
    );
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const items = feedOf(board);
    const summary = items.find((i) => i.text === "in summary");
    expect(summary?.chip).toEqual({ label: "s", tone: "brand" });
    expect(summary?.icon).toBe("◆");
    // a participant turn keeps the plain info tone and no leading icon
    const aTurn = items.find((i) => i.chip?.label === "a");
    expect(aTurn?.chip?.tone).toBe("info");
    expect(aTurn?.icon).toBeUndefined();
  });

  test("a moderator's routing turn reads as a distinct accent chip + icon", () => {
    const board = buildRoomBoard(room({ strategy: "group-chat", config: { moderator: "mod" } }), [
      entry({ from: "mod", parts: [{ text: "Bob, your take?" }] }),
      entry({ from: "b" }),
    ]);
    const modTurn = feedOf(board).find((i) => i.chip?.label === "mod");
    expect(modTurn?.chip).toEqual({ label: "mod", tone: "accent" });
    expect(modTurn?.icon).toBe("◇");
  });

  test("a round boundary inserts a single 'Round N' divider; the first round has none", () => {
    const board = buildRoomBoard(room(), [
      entry({ from: "a", round: 0 }),
      entry({ from: "b", round: 0 }),
      entry({ from: "a", round: 1 }),
      entry({ from: "b", round: 1 }),
    ]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const items = feedOf(board);
    expect(items.filter((i) => i.text.startsWith("Round ")).map((i) => i.text)).toEqual([
      "Round 2",
    ]);
    expect(items).toHaveLength(5); // 4 turns + 1 divider
  });

  test("an unstamped (pre-round-cursor) transcript inserts no dividers", () => {
    const items = feedOf(buildRoomBoard(room(), [entry({ from: "a" }), entry({ from: "b" })]));
    expect(items.some((i) => i.text.startsWith("Round "))).toBe(false);
    expect(items).toHaveLength(2);
  });

  test("a closed room ends with a termination marker: Stopped vs Closed", () => {
    const last = (board: ReturnType<typeof buildRoomBoard>) => {
      const items = feedOf(board);
      return items[items.length - 1];
    };
    expect(
      last(buildRoomBoard(room({ status: "stopped", turnIndex: 3 }), [entry()])),
    ).toMatchObject({ text: "Stopped", glyph: "warn" });
    // "done" stays coarse — a moderator close can also land on budget, so the
    // marker never claims "budget reached" (the header chip shows the count).
    expect(
      last(buildRoomBoard(room({ status: "done", turnIndex: 6, turnBudget: 6 }), [entry()]))?.text,
    ).toBe("Closed");
    expect(
      last(buildRoomBoard(room({ status: "done", turnIndex: 2, turnBudget: 6 }), [entry()]))?.text,
    ).toBe("Closed");
    // an active room carries no marker
    const active = feedOf(buildRoomBoard(room({ status: "active" }), [entry()]));
    expect(active.some((i) => i.text === "Stopped" || i.text === "Closed")).toBe(false);
  });

  test("N>2 participants render: a segment each and every turn as a row", () => {
    const board = buildRoomBoard(room({ participants: ["a", "b", "c"] }), [
      entry({ from: "a" }),
      entry({ from: "b" }),
      entry({ from: "c" }),
    ]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.header?.segments).toEqual([
      { label: "a", n: 1 },
      { label: "b", n: 1 },
      { label: "c", n: 1 },
    ]);
    expect(feedOf(board)).toHaveLength(3);
  });

  test("a trailing control directive is stripped from the rendered turn text", () => {
    const board = buildRoomBoard(room({ strategy: "open-floor" }), [
      entry({
        from: "a",
        parts: [
          {
            text: 'Ship the narrow gate.\n{"action":"nominate","slug":"b","reason":"pressure-test it"}',
          },
        ],
      }),
    ]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const row = feedOf(board).find((i) => i.chip?.label === "a");
    expect(row?.text).toBe("Ship the narrow gate.");
    expect(row?.text).not.toContain("nominate");
  });
});
