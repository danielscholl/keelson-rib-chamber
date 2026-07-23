import { describe, expect, test } from "bun:test";
import { canvasViewSchema } from "@keelson/shared";
import { buildRoomBoard } from "../../src/boards/room.ts";
import type { LensRecord } from "../../src/lens-store.ts";
import { clockTime } from "../../src/room-text.ts";
import type { LedgerTask, Mind, Room, TurnEntry } from "../../src/types.ts";

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

const mind = (over: Partial<Mind> = {}): Mind => ({
  slug: "a",
  name: "Ada",
  role: "researcher",
  persona: "p",
  ...over,
});

type Board = ReturnType<typeof buildRoomBoard>;

function columnsSection(board: Board) {
  const s = board.sections.find((x) => x.kind === "columns");
  if (s?.kind !== "columns") throw new Error("expected a columns section");
  return s;
}

// The debate feed lives in the main (weight 1.9) column, as its one rows section.
function debateItems(board: Board) {
  const main = columnsSection(board).columns[0];
  const feed = main?.sections[0];
  if (feed?.kind !== "rows") throw new Error("expected the debate feed");
  return feed.items;
}
function debateTitle(board: Board) {
  const main = columnsSection(board).columns[0];
  const feed = main?.sections[0];
  if (feed?.kind !== "rows") throw new Error("expected the debate feed");
  return feed.title;
}

// Voices always leads the side (weight 1) column; Decisions follows when present.
function voicesItems(board: Board) {
  const side = columnsSection(board).columns[1];
  const voices = side?.sections[0];
  if (voices?.kind !== "rows") throw new Error("expected the Voices section");
  return voices.items;
}
function decisionsSectionOf(board: Board) {
  const side = columnsSection(board).columns[1];
  return side?.sections[1];
}

function actionsSection(board: Board) {
  const s = board.sections.find((x) => x.kind === "actions");
  if (s?.kind !== "actions") throw new Error("no actions section");
  return s;
}
// The vitals row is the one untitled top-level rows section (Topic/Plan both
// carry a title; the debate/Voices/Decisions rows live nested inside columns).
function vitalsRow(board: Board) {
  const s = board.sections.find((x) => x.kind === "rows" && x.title === undefined);
  return s?.kind === "rows" ? s.items[0] : undefined;
}
function outcomeCard(board: Board) {
  const s = board.sections.find((x) => x.kind === "cards" && x.title === "Outcome");
  if (s?.kind !== "cards") return undefined;
  return s.items[0];
}
function journeyItems(board: Board) {
  const s = board.sections.find((x) => x.kind === "journey");
  return s?.kind === "journey" ? s.items : undefined;
}
// The inline tool rows a turn's calls render as (icon "⚙"), in feed order.
function toolRowsIn(board: Board) {
  return debateItems(board).filter((it) => it.icon === "⚙");
}
// The Context meter is the `bars` section nested in the side (weight 1) column.
function contextBars(board: Board) {
  const side = columnsSection(board).columns[1];
  const bars = side?.sections.find((x) => x.kind === "bars");
  return bars?.kind === "bars" ? bars.items : undefined;
}

describe("buildRoomBoard", () => {
  test("empty transcript is valid; no vitals stats (no turns, no scope)", () => {
    const board = buildRoomBoard(room(), []);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.sections.some((s) => s.kind === "stats")).toBe(false);
    // The header carries no per-mind segments anymore — Voices covers that.
    expect(board.header?.segments).toBeUndefined();
  });

  test("empty transcript has no journey section", () => {
    const board = buildRoomBoard(room(), []);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(journeyItems(board)).toBeUndefined();
  });

  test("an active early room shows Frame and Explore but not Record", () => {
    const board = buildRoomBoard(room({ status: "active", round: 0 }), [
      entry({ from: "a", turnIndex: 0 }),
      entry({ from: "b", turnIndex: 1 }),
    ]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(journeyItems(board)?.map((item) => item.title)).toEqual(["Frame", "Explore"]);
  });

  test("a done room with an outcome shows the full journey", () => {
    const board = buildRoomBoard(room({ status: "done", round: 1 }), [
      entry({
        from: "a",
        turnIndex: 0,
        round: 0,
        parts: [{ text: "**Q1 — Ship it. Pinned.**\n\nYes." }],
      }),
      entry({
        from: "b",
        turnIndex: 1,
        round: 1,
        parts: [
          {
            text: [
              "**Q2 — Name it. Pinned.**",
              "",
              "Done.",
              "",
              "---",
              "",
              "## Outcome",
              "",
              "**Q1 — Ship it.** Yes.",
              "",
              "**Q2 — Name it.** Done.",
            ].join("\n"),
          },
        ],
      }),
    ]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(journeyItems(board)?.map((item) => item.title)).toEqual([
      "Frame",
      "Explore",
      "Decide",
      "Record",
    ]);
  });

  test("an active room with decisions reaches Decide but not Record", () => {
    const board = buildRoomBoard(room({ status: "active", round: 1 }), [
      entry({ from: "a", round: 0, parts: [{ text: "**Q1 — Ship it. Pinned.**\n\nYes." }] }),
    ]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(journeyItems(board)?.map((item) => item.title)).toEqual(["Frame", "Explore", "Decide"]);
  });

  test("a stopped room with decisions but no outcome does not reach Record", () => {
    const board = buildRoomBoard(room({ status: "stopped", round: 1 }), [
      entry({ from: "a", round: 0, parts: [{ text: "**Q1 — Ship it. Pinned.**\n\nYes." }] }),
    ]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(journeyItems(board)?.map((item) => item.title)).toEqual(["Frame", "Explore", "Decide"]);
  });

  test("director injections alone never open the journey; agent turns drive the count", () => {
    const injected = buildRoomBoard(room(), [
      entry({ from: "director", role: "director", parts: [{ text: "steer" }] }),
      entry({ from: "director", role: "director", parts: [{ text: "steer again" }] }),
    ]);
    expect(canvasViewSchema.safeParse(injected).success).toBe(true);
    expect(journeyItems(injected)).toBeUndefined();

    const mixed = buildRoomBoard(room(), [
      entry({ from: "a", turnIndex: 0 }),
      entry({ from: "director", role: "director", parts: [{ text: "steer" }] }),
      entry({ from: "b", turnIndex: 1 }),
    ]);
    expect(canvasViewSchema.safeParse(mixed).success).toBe(true);
    const items = journeyItems(mixed);
    expect(items?.map((item) => item.title)).toEqual(["Frame", "Explore"]);
    expect(items?.find((item) => item.title === "Explore")?.text).toBe("2 turns recorded");
  });

  test("a marker-free done room with an outcome still reaches Decide, synthesis complete", () => {
    const board = buildRoomBoard(room({ status: "done", round: 1 }), [
      entry({ from: "a", turnIndex: 0, round: 0 }),
      entry({
        from: "b",
        turnIndex: 1,
        round: 1,
        parts: [{ text: "Closing thoughts.\n\n---\n\n## Outcome\n\nWe ship it." }],
      }),
    ]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const items = journeyItems(board);
    expect(items?.map((item) => item.title)).toEqual(["Frame", "Explore", "Decide", "Record"]);
    expect(items?.find((item) => item.title === "Decide")?.text).toBe("Synthesis complete");
  });

  test("an exhausted budget on a decision-free active room reads as synthesis pending", () => {
    const board = buildRoomBoard(room({ status: "active", round: 1, turnIndex: 6 }), [
      entry({ from: "a", turnIndex: 0 }),
      entry({ from: "b", turnIndex: 1 }),
    ]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const items = journeyItems(board);
    expect(items?.map((item) => item.title)).toEqual(["Frame", "Explore", "Decide"]);
    expect(items?.find((item) => item.title === "Decide")?.text).toBe("Synthesis pending");
  });

  test("a magentic ledger past planning backs Decide without pinned decisions", () => {
    const settled: LedgerTask = {
      id: "t1",
      description: "build it",
      status: "completed",
      createdAt: "t",
      updatedAt: "t",
    };
    const open: LedgerTask = { ...settled, id: "t2", status: "pending" };
    const board = buildRoomBoard(
      room({ strategy: "magentic", status: "active", config: { manager: "mgr" } }),
      [entry({ from: "a", turnIndex: 0 }), entry({ from: "b", turnIndex: 1 })],
      {
        roomSlug: "r",
        goal: "g",
        manager: "mgr",
        status: "executing",
        tasks: [settled, open],
        updatedAt: "t",
      },
    );
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const items = journeyItems(board);
    expect(items?.map((item) => item.title)).toEqual(["Frame", "Explore", "Decide"]);
    expect(items?.find((item) => item.title === "Decide")?.text).toBe("Plan executing · 1/2 tasks");
  });

  test("a planning ledger with no landed plan does not back Decide", () => {
    const board = buildRoomBoard(
      room({ strategy: "magentic", status: "active", config: { manager: "mgr" } }),
      [entry({ from: "a", turnIndex: 0 }), entry({ from: "b", turnIndex: 1 })],
      { roomSlug: "r", goal: "g", manager: "mgr", status: "planning", tasks: [], updatedAt: "t" },
    );
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(journeyItems(board)?.map((item) => item.title)).toEqual(["Frame", "Explore"]);
  });

  test("one row per entry in the debate column; Voices carries the turn counts", () => {
    const board = buildRoomBoard(room(), [
      entry({ from: "a" }),
      entry({ from: "b" }),
      entry({ from: "a" }),
      entry({ from: "director", role: "director", parts: [{ text: "steer" }] }),
    ]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(debateItems(board)).toHaveLength(4);
    const byLabel = new Map(voicesItems(board).map((v) => [v.chip?.label, v.trailing]));
    expect(byLabel.get("a")).toBe("2 turns");
    expect(byLabel.get("b")).toBe("1 turn");
  });

  test("Voices renders every participant even with zero turns, in participant order", () => {
    const board = buildRoomBoard(room({ participants: ["a", "b"] }), []);
    expect(voicesItems(board).map((v) => v.chip?.label)).toEqual(["a", "b"]);
    expect(voicesItems(board).every((v) => v.trailing === "0 turns")).toBe(true);
  });

  test("empty turn text is coalesced to a placeholder", () => {
    const board = buildRoomBoard(room(), [entry({ parts: [{ text: "" }] })]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(debateItems(board)[0]?.text).toBe("(no text)");
  });

  test("aborted entries and every status tone stay valid", () => {
    for (const status of ["active", "stopped", "done"] as const) {
      const board = buildRoomBoard(room({ status }), [
        entry({ aborted: true, parts: [{ text: "" }] }),
      ]);
      expect(canvasViewSchema.safeParse(board).success).toBe(true);
      expect(debateItems(board)[0]?.trailing).toContain("aborted");
    }
  });

  test("an active room bakes Call-on-<participant> + Stop controls carrying the slug", () => {
    const board = buildRoomBoard(room({ slug: "r", participants: ["a", "b"] }), [], undefined, [
      mind({ slug: "a", name: "Ada" }),
    ]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const actions = actionsSection(board);
    expect(actions.wrap).toBe(true);
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
    expect(byType("room-inject").map((i) => i.label)).toEqual(["Call on Ada", "Call on b"]);
  });

  test("a closed room offers Start-again + the alternate shapes by their shape words", () => {
    for (const status of ["stopped", "done"] as const) {
      const board = buildRoomBoard(room({ status, participants: ["a", "b"], turnBudget: 6 }), []);
      expect(canvasViewSchema.safeParse(board).success).toBe(true);
      const actions = actionsSection(board);
      expect(actions.wrap).toBe(true);
      expect(actions.items.map((i) => i.type)).toEqual([
        "room-start",
        "room-start",
        "room-start",
        "room-start",
      ]);
      expect(actions.items.map((i) => i.label)).toEqual([
        "Start again",
        "Start Debate",
        "Start Open floor",
        "Start Delegate",
      ]);
      const magentic = actions.items.find((i) => i.label === "Start Delegate");
      expect(magentic?.fields?.map((f) => f.name)).toEqual(["manager"]);
      expect(magentic?.payload).toMatchObject({ strategy: "magentic" });
      // Start again — no slug (the server assigns a fresh one per start).
      expect(actions.items[0]?.payload).toMatchObject({ turnBudget: 6, participants: ["a", "b"] });
    }
  });

  test("the header turns chip clamps closing-turn overflow like the index card", () => {
    const overflowed = buildRoomBoard(room({ status: "done", turnIndex: 9, turnBudget: 8 }), []);
    expect(canvasViewSchema.safeParse(overflowed).success).toBe(true);
    expect(overflowed.header?.chip).toBe("8/8 + closing");
    const normal = buildRoomBoard(room({ turnIndex: 3, turnBudget: 8 }), []);
    expect(normal.header?.chip).toBe("3/8");
  });

  test("a finished group-chat's Start-again round-trips the moderator config", () => {
    const board = buildRoomBoard(
      room({ status: "done", strategy: "group-chat", config: { moderator: "mod", minRounds: 2 } }),
      [],
    );
    const actions = actionsSection(board);
    expect(actions.items[0]?.payload).toMatchObject({
      strategy: "group-chat",
      moderator: "mod",
      minRounds: 2,
    });
  });

  test("a project-targeted room's restart actions all round-trip the projectId", () => {
    const board = buildRoomBoard(room({ status: "done", projectId: "p1" }), []);
    const actions = actionsSection(board);
    // Start again / group-chat / open-floor — all keep the project target so the
    // restart runs against the same repo rather than silently dropping it.
    for (const item of actions.items) {
      expect(item.payload).toMatchObject({ projectId: "p1" });
    }
  });

  test("an untargeted room's restart actions carry no projectId", () => {
    const board = buildRoomBoard(room({ status: "done" }), []);
    for (const item of actionsSection(board).items) {
      expect(item.payload).not.toHaveProperty("projectId");
    }
  });

  test("a grounded room's restart actions all round-trip the brief (flat groundingUrl + criteria)", () => {
    const board = buildRoomBoard(
      room({
        status: "done",
        grounding: { sourceUrl: "https://x/204", criteria: ["First", "Second"] },
      }),
      [],
    );
    // Every restart control keeps the brief, so "Start again" (and the mode switches)
    // rerun grounded rather than silently dropping it. criteria ride newline-joined, the
    // shape roomStartAction parses back.
    for (const item of actionsSection(board).items) {
      expect(item.payload).toMatchObject({
        groundingUrl: "https://x/204",
        criteria: "First\nSecond",
      });
    }
  });

  test("an ungrounded room's restart actions carry no grounding keys", () => {
    for (const item of actionsSection(buildRoomBoard(room({ status: "done" }), [])).items) {
      expect(item.payload).not.toHaveProperty("groundingUrl");
      expect(item.payload).not.toHaveProperty("criteria");
    }
  });

  test("a coding room's restart actions all round-trip the coding tier", () => {
    const board = buildRoomBoard(room({ status: "done", projectId: "p1", coding: true }), []);
    for (const item of actionsSection(board).items) {
      expect(item.payload).toMatchObject({ coding: true });
    }
  });

  test("a non-coding room's restart actions carry no coding flag", () => {
    const board = buildRoomBoard(room({ status: "done" }), []);
    for (const item of actionsSection(board).items) {
      expect(item.payload).not.toHaveProperty("coding");
    }
  });

  test("a finished open-floor's Start-again round-trips the end-vote threshold", () => {
    const board = buildRoomBoard(
      room({ status: "done", strategy: "open-floor", config: { endVoteThreshold: 0.6 } }),
      [],
    );
    expect(actionsSection(board).items[0]?.payload).toMatchObject({
      strategy: "open-floor",
      endVoteThreshold: 0.6,
    });
  });

  test("the Start Debate action collects a moderator via a field form", () => {
    const board = buildRoomBoard(room({ status: "done", participants: ["a", "b"] }), []);
    const gc = actionsSection(board).items.find((i) => i.label === "Start Debate");
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

  test("the Start Open floor action carries the strategy with no required fields", () => {
    const board = buildRoomBoard(room({ status: "done", participants: ["a", "b"] }), []);
    const of = actionsSection(board).items.find((i) => i.label === "Start Open floor");
    expect(of?.payload).toMatchObject({ strategy: "open-floor", participants: ["a", "b"] });
    expect(of?.fields).toBeUndefined();
  });

  test("a room with a topic shows it as a leading Topic section, gist + detail", () => {
    const board = buildRoomBoard(room({ topic: "Ship strategies before lenses?" }), []);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const topic = board.sections.find((s) => s.kind === "rows" && s.title === "Topic");
    if (topic?.kind !== "rows") throw new Error("expected a Topic section");
    expect(topic.items[0]?.text).toBe("Ship strategies before lenses?");
    expect(topic.items[0]?.detail).toBe("Ship strategies before lenses?");
  });

  test("the Topic trailing carries the contract tail computed from decisions + vocabulary", () => {
    const board = buildRoomBoard(
      room({
        topic: "Design it. Acceptance criteria matter. Also write a test plan.",
      }),
      [entry({ parts: [{ text: "**Q1 — Ship it. Pinned.**\n\nDone." }] })],
    );
    const topic = board.sections.find((s) => s.kind === "rows" && s.title === "Topic");
    if (topic?.kind !== "rows") throw new Error("expected a Topic section");
    expect(topic.items[0]?.trailing).toBe("produces 1 decision · criteria · test plan");
  });

  test("no Topic section when the room has no topic", () => {
    const board = buildRoomBoard(room(), []);
    expect(board.sections.some((s) => s.kind === "rows" && s.title === "Topic")).toBe(false);
  });

  test("Start-again carries the room's topic so a restart keeps its subject", () => {
    const board = buildRoomBoard(room({ status: "done", topic: "Q3 roadmap" }), []);
    expect(actionsSection(board).items[0]?.payload).toMatchObject({ topic: "Q3 roadmap" });
  });

  test("the synthesizer's closing summary reads as a distinct brand chip, no leading icon", () => {
    const board = buildRoomBoard(
      room({
        status: "done",
        strategy: "group-chat",
        config: { moderator: "mod", synthesizer: "s" },
      }),
      [entry({ from: "a" }), entry({ from: "s", parts: [{ text: "in summary" }] })],
    );
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const items = debateItems(board);
    const summary = items.find((i) => i.text === "in summary");
    expect(summary?.chip).toEqual({ label: "s", tone: "brand" });
    // The brand tone is the sole facilitator marker — every speaker row leads with
    // one toned bullet + chip and no icon, so the feed aligns on a single left edge.
    expect(summary?.icon).toBeUndefined();
    const aTurn = items.find((i) => i.chip?.label === "a");
    expect(aTurn?.chip?.tone).toBe("info");
    expect(aTurn?.icon).toBeUndefined();
  });

  test("a moderator's routing turn reads as a distinct brand chip, aligned with participants", () => {
    const board = buildRoomBoard(room({ strategy: "group-chat", config: { moderator: "mod" } }), [
      entry({ from: "mod", parts: [{ text: "Bob, your take?" }] }),
      entry({ from: "b" }),
    ]);
    const items = debateItems(board);
    const modTurn = items.find((i) => i.chip?.label === "mod");
    expect(modTurn?.chip).toEqual({ label: "mod", tone: "brand" });
    expect(modTurn?.glyph).toBe("brand");
    // No leading icon — the moderator's chip sits at the same left edge as a
    // participant's, distinguished only by its brand tone.
    expect(modTurn?.icon).toBeUndefined();
    expect(items.find((i) => i.chip?.label === "b")?.icon).toBeUndefined();
  });

  test("a participant wears its persisted identity-tone slot when minds[] resolves it", () => {
    const board = buildRoomBoard(
      room({ strategy: "group-chat", config: { moderator: "mod" }, participants: ["a", "b"] }),
      [entry({ from: "mod", parts: [{ text: "go" }] }), entry({ from: "a" })],
      undefined,
      [mind({ slug: "a", name: "Ada", identitySlot: 2 })],
    );
    const items = debateItems(board);
    const aTurn = items.find((i) => i.chip?.label === "Ada"); // the Mind's NAME, not slug
    expect(aTurn?.chip?.tone).toBe("id-teal");
    // the moderator keeps brand regardless of any identitySlot
    expect(items.find((i) => i.chip?.label === "mod")?.chip?.tone).toBe("brand");
  });

  test("a round boundary inserts a 'Round N' divider, INCLUDING the first round", () => {
    const board = buildRoomBoard(room(), [
      entry({ from: "a", round: 0 }),
      entry({ from: "b", round: 0 }),
      entry({ from: "a", round: 1 }),
      entry({ from: "b", round: 1 }),
    ]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const items = debateItems(board);
    expect(items.filter((i) => i.text.startsWith("Round ")).map((i) => i.text)).toEqual([
      "Round 1",
      "Round 2",
    ]);
    expect(items).toHaveLength(6); // 4 turns + 2 dividers
    expect(debateTitle(board)).toBe("Discussion · 2 rounds");
  });

  test("the debate title uses the room shape and omits the count without multiple rounds", () => {
    const oneRound = buildRoomBoard(room(), [entry({ round: 0 }), entry({ round: 0 })]);
    expect(debateTitle(oneRound)).toBe("Discussion");
    const noRounds = buildRoomBoard(room(), [entry({ round: undefined })]);
    expect(debateTitle(noRounds)).toBe("Discussion");
    const debate = buildRoomBoard(room({ strategy: "group-chat" }), [entry({ round: 0 })]);
    expect(debateTitle(debate)).toBe("Debate");
    const delegate = buildRoomBoard(room({ strategy: "magentic" }), [entry({ round: 0 })]);
    expect(debateTitle(delegate)).toBe("Delegate");
  });

  test("a round head names the questions decided within it", () => {
    const board = buildRoomBoard(room({ participants: ["a", "b"] }), [
      entry({ from: "a", round: 0, parts: [{ text: "**Q1 — Ship it. Pinned.**\n\nDone." }] }),
      entry({ from: "b", round: 0, parts: [{ text: "**Q2 — Name it. Pinned.**\n\nOk." }] }),
      entry({ from: "a", round: 1, parts: [{ text: "no decision here" }] }),
    ]);
    const items = debateItems(board);
    expect(items.find((i) => i.text.startsWith("Round 1"))?.text).toBe("Round 1 — decides Q1 · Q2");
    expect(items.find((i) => i.text.startsWith("Round 2"))?.text).toBe("Round 2");
  });

  test("an unstamped (pre-round-cursor) transcript inserts no dividers", () => {
    const board = buildRoomBoard(room(), [
      entry({ from: "a", round: undefined }),
      entry({ from: "b", round: undefined }),
    ]);
    const items = debateItems(board);
    expect(items.some((i) => i.text.startsWith("Round "))).toBe(false);
    expect(items).toHaveLength(2);
  });

  test("a closed room ends with a termination marker: Stopped vs Closed", () => {
    const last = (board: Board) => {
      const items = debateItems(board);
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
    const active = debateItems(buildRoomBoard(room({ status: "active" }), [entry()]));
    expect(active.some((i) => i.text === "Stopped" || i.text === "Closed")).toBe(false);
  });

  test("N>2 participants render: a Voices row each and every turn as a debate row", () => {
    const board = buildRoomBoard(room({ participants: ["a", "b", "c"] }), [
      entry({ from: "a" }),
      entry({ from: "b" }),
      entry({ from: "c" }),
    ]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(voicesItems(board).map((v) => v.chip?.label)).toEqual(["a", "b", "c"]);
    expect(voicesItems(board).every((v) => v.trailing === "1 turn")).toBe(true);
    expect(debateItems(board)).toHaveLength(3);
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
    const row = debateItems(board).find((i) => i.chip?.label === "a");
    expect(row?.text).toBe("Ship the narrow gate.");
    expect(row?.text).not.toContain("nominate");
  });

  test("vitals is one compact rows line, not a stats-tile grid", () => {
    const board = buildRoomBoard(room(), [
      entry({ at: "2026-01-01T17:26:00.000Z" }),
      entry({ at: "2026-01-01T17:32:00.000Z" }),
    ]);
    // A `stats` section renders as hero tiles — the wrong weight for secondary
    // facts riding beside the debate; vitals must never use it.
    expect(board.sections.some((s) => s.kind === "stats")).toBe(false);
    const row = vitalsRow(board);
    // Computed via clockTime, not hardcoded — clockTime renders in the runtime's
    // local time zone, so a literal "17:26" would only pass in UTC.
    expect(row?.text).toBe(
      `6 min · ${clockTime("2026-01-01T17:26:00.000Z")} → ${clockTime("2026-01-01T17:32:00.000Z")}`,
    );
  });

  test("no vitals row at all when there are no turns and no scope", () => {
    const empty = buildRoomBoard(room(), []);
    expect(vitalsRow(empty)).toBeUndefined();
  });

  test("token totals ride the vitals status line (no stats band); omitted when no turn carries usage", () => {
    const noUsage = buildRoomBoard(room(), [entry()]);
    expect(vitalsRow(noUsage)?.text).not.toContain("↑");

    const board = buildRoomBoard(room(), [
      entry({ usage: { inputTokens: 100_000, outputTokens: 8_000 } }),
      entry({ usage: { inputTokens: 48_000, outputTokens: 3_000 } }),
    ]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.sections.some((s) => s.kind === "stats")).toBe(false);
    expect(vitalsRow(board)?.text).toContain("↑ 148k in · ↓ 11k out");
  });

  test("the scope, when set, rides as a leading chip on the vitals row", () => {
    const withScope = buildRoomBoard(
      room({ projectId: "p1" }),
      [entry()],
      undefined,
      [],
      "keelson-rib-squad",
    );
    expect(vitalsRow(withScope)?.chip).toEqual({ label: "⌂ keelson-rib-squad", tone: "neutral" });
    const withoutScope = buildRoomBoard(room(), [entry()]);
    expect(vitalsRow(withoutScope)?.chip).toBeUndefined();
  });

  test("scope alone (no turns yet) still renders the vitals row", () => {
    const board = buildRoomBoard(room({ projectId: "p1" }), [], undefined, [], "keelson-rib-squad");
    const row = vitalsRow(board);
    expect(row?.chip?.label).toBe("⌂ keelson-rib-squad");
    expect(row?.text).toBe("No turns yet");
  });
});

describe("buildRoomBoard — decisions rail and outcome", () => {
  const decidedTranscript = [
    entry({
      messageId: "1",
      from: "a",
      round: 0,
      at: "2026-01-01T17:28:00.000Z",
      parts: [
        {
          text: "**Q1 — Revert mechanics. Pinned proposal.**\n\nTree membership is the oracle. More follows.",
        },
      ],
    }),
    entry({
      messageId: "2",
      from: "b",
      round: 0,
      at: "2026-01-01T17:32:00.000Z",
      parts: [
        {
          text: [
            "**Q2 — Ledger honesty. Pinned.**",
            "",
            "An event row, not a new terminal state.",
            "",
            "---",
            "",
            "## Pinned Design — a title the room authored",
            "",
            "**Q1 — Revert mechanics.** Tree membership is the oracle.",
            "",
            "**Q2 — Ledger honesty.** An event row.",
            "",
            "### Acceptance criteria",
            "- One.",
            "- Two.",
            "",
            "### Test plan",
            "- Fake exec.",
          ].join("\n"),
        },
      ],
    }),
  ];

  test("collects decisions into a rail section, tone by author", () => {
    const board = buildRoomBoard(room({ participants: ["a", "b"] }), decidedTranscript, undefined, [
      mind({ slug: "a", name: "Ada", identitySlot: 0 }),
      mind({ slug: "b", name: "Bo", identitySlot: 1 }),
    ]);
    const section = decisionsSectionOf(board);
    if (section?.kind !== "rows") throw new Error("expected the Decisions section");
    expect(section.title).toBe("Decisions · 2 of 2 decided");
    expect(section.items.map((i) => i.chip?.label)).toEqual(["Q1", "Q2"]);
    expect(section.items[0]?.chip?.tone).toBe("id-blue");
    expect(section.items[0]?.trailing).toBe("Ada · round 1");
  });

  test("no Decisions section when nothing is decided yet", () => {
    const board = buildRoomBoard(room(), [entry({ parts: [{ text: "just talking" }] })]);
    expect(decisionsSectionOf(board)).toBeUndefined();
  });

  test("decided-so-far reads a plain count before the outcome document exists", () => {
    const board = buildRoomBoard(room({ status: "active" }), [decidedTranscript[0]!]);
    const section = decisionsSectionOf(board);
    if (section?.kind !== "rows") throw new Error("expected the Decisions section");
    expect(section.title).toBe("Decisions · 1 decided");
  });

  test("a turn that decides a question carries the badge in its trailing", () => {
    const board = buildRoomBoard(room({ participants: ["a", "b"] }), decidedTranscript);
    const row = debateItems(board).find((i) => i.chip?.label === "a");
    expect(row?.trailing).toContain("Q1 decided");
  });

  test("an aborted turn's decision-marker-shaped text is never counted as a decision", () => {
    const board = buildRoomBoard(room(), [
      entry({
        from: "a",
        round: 0,
        aborted: true,
        parts: [{ text: "**Q1 — Ship it. Pinned.**\n\nDone." }],
      }),
    ]);
    // No Decisions rail, no "Qn decided" badge, and no "decides Qn" round head —
    // matches the debate row's own "(aborted)" treatment for the same turn.
    expect(decisionsSectionOf(board)).toBeUndefined();
    const row = debateItems(board).find((i) => i.chip?.label === "a");
    expect(row?.trailing).not.toContain("decided");
    expect(debateItems(board).find((i) => i.text.startsWith("Round"))?.text).toBe("Round 1");
  });

  test("a decision authored before the room had a round cursor renders with no round suffix", () => {
    const board = buildRoomBoard(room(), [
      entry({
        from: "a",
        round: undefined,
        parts: [{ text: "**Q1 — Ship it. Pinned.**\n\nDone." }],
      }),
    ]);
    const section = decisionsSectionOf(board);
    if (section?.kind !== "rows") throw new Error("expected the Decisions section");
    expect(section.items[0]?.trailing).toBe("a");
  });

  test("splits the outcome document out of the last turn into an Outcome card", () => {
    const board = buildRoomBoard(
      room({ status: "done", participants: ["a", "b"] }),
      decidedTranscript,
    );
    const card = outcomeCard(board);
    expect(card?.title).toBe("Pinned Design — a title the room authored");
    // The debate's last row shows only the pre-boundary content, not the document.
    const lastDebateRow = debateItems(board).find((i) => i.chip?.label === "b");
    expect(lastDebateRow?.text).not.toContain("Acceptance criteria");
    expect(lastDebateRow?.detail ?? lastDebateRow?.text).toContain("An event row");
  });

  test("the outcome receipt names the author, time, and a mechanical contract check", () => {
    const board = buildRoomBoard(
      room({ status: "done", participants: ["a", "b"] }),
      decidedTranscript,
      undefined,
      [mind({ slug: "b", name: "Bo" })],
    );
    const card = outcomeCard(board);
    const at = clockTime("2026-01-01T17:32:00.000Z");
    expect(card?.reason?.text).toBe(
      `synthesized by Bo · ${at} — ✓ delivers 2 decisions · 2 criteria · test plan`,
    );
  });

  test("the outcome card carries a copyAction field and an Explore-in-chat action", () => {
    const board = buildRoomBoard(room({ status: "done", slug: "r1" }), decidedTranscript);
    const card = outcomeCard(board);
    const copy = card?.fields?.find((f) => f.label === "Copy");
    expect(copy?.copyAction).toEqual({ type: "outcome-copy", payload: { slug: "r1" } });
    expect(card?.actions).toEqual([
      { type: "outcome-explore", label: "✦ Explore in chat", glyph: "✦", payload: { slug: "r1" } },
    ]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
  });

  test("no Outcome card when the last turn carries no --- / ## boundary", () => {
    const board = buildRoomBoard(room({ status: "done" }), [
      entry({ parts: [{ text: "just an ordinary closing remark" }] }),
    ]);
    expect(outcomeCard(board)).toBeUndefined();
  });
});

describe("buildRoomBoard — magentic plan + manager", () => {
  const ledger = (tasks: LedgerTask[]) => ({
    roomSlug: "r",
    goal: "g",
    manager: "mgr",
    status: "executing" as const,
    tasks,
    updatedAt: "t",
  });
  const t = (over: Partial<LedgerTask>): LedgerTask => ({
    id: "t1",
    description: "build it",
    status: "pending",
    createdAt: "t",
    updatedAt: "t",
    ...over,
  });

  test("renders a Plan section: one row per task, status glyph + assignee chip", () => {
    const board = buildRoomBoard(
      room({ strategy: "magentic", config: { manager: "mgr" }, topic: "ship it" }),
      [],
      ledger([
        t({
          id: "t1",
          description: "build parser",
          assignee: "alice",
          status: "completed",
          result: "did it",
        }),
        t({ id: "t2", description: "wire api", assignee: "bob", status: "in-progress" }),
        t({ id: "t3", description: "write tests", status: "pending" }),
      ]),
    );
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const plan = board.sections.find((s) => s.kind === "rows" && s.title?.startsWith("Plan"));
    if (plan?.kind !== "rows") throw new Error("expected a Plan section");
    expect(plan.title).toBe("Plan · executing");
    expect(plan.items.map((i) => [i.text, i.chip?.label, i.glyph])).toEqual([
      ["build parser", "alice", "ok"],
      ["wire api", "bob", "info"],
      ["write tests", undefined, "neutral"],
    ]);
    expect(plan.items[0]?.trailing).toBe("completed · did it");
  });

  test("no Plan section without a ledger; an empty ledger shows 'No tasks yet'", () => {
    const absent = buildRoomBoard(room({ strategy: "magentic", config: { manager: "mgr" } }), []);
    expect(absent.sections.some((s) => s.kind === "rows" && s.title?.startsWith("Plan"))).toBe(
      false,
    );
    // A persisted-but-empty ledger still surfaces its state (the reopen path loads it).
    const empty = buildRoomBoard(
      room({ strategy: "magentic", config: { manager: "mgr" } }),
      [],
      ledger([]),
    );
    const plan = empty.sections.find((s) => s.kind === "rows" && s.title?.startsWith("Plan"));
    if (plan?.kind !== "rows") throw new Error("expected a Plan section for an empty ledger");
    expect(plan.items).toEqual([{ glyph: "neutral", text: "No tasks yet" }]);
  });

  test("a manager turn reads as a distinct brand chip, no leading icon", () => {
    const board = buildRoomBoard(
      room({ strategy: "magentic", config: { manager: "mgr" } }),
      [
        entry({ from: "mgr", parts: [{ text: "here is the plan" }] }),
        entry({ from: "a", parts: [{ text: "did it" }] }),
      ],
      ledger([t({})]),
    );
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const items = debateItems(board);
    const mgrTurn = items.find((i) => i.chip?.label === "mgr");
    expect(mgrTurn?.glyph).toBe("brand");
    expect(mgrTurn?.chip?.tone).toBe("brand");
    expect(mgrTurn?.icon).toBeUndefined();
  });

  test("an active magentic room offers Stop but no per-worker Call-on", () => {
    const board = buildRoomBoard(
      room({ strategy: "magentic", status: "active", config: { manager: "mgr" } }),
      [],
      ledger([t({})]),
    );
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const actions = actionsSection(board);
    // The manager routes by the ledger, so a manual "Call on <worker>" override is
    // suppressed — only Stop remains.
    expect(actions.items.map((i) => i.type)).toEqual(["room-stop"]);
  });
});

describe("grounding section", () => {
  test("a grounded room's board shows the source and criteria under Grounding", () => {
    const board = buildRoomBoard(
      room({ grounding: { sourceUrl: "https://x/204", criteria: ["First", "Second"] } }),
      [],
    );
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const g = board.sections.find((s) => s.kind === "rows" && s.title === "Grounding");
    expect(g?.kind).toBe("rows");
    const texts = g?.kind === "rows" ? g.items.map((i) => i.text) : [];
    expect(texts).toContain("https://x/204");
    expect(texts).toContain("First");
    expect(texts).toContain("Second");
  });

  test("a source-only grounded room still shows the Grounding section", () => {
    const board = buildRoomBoard(
      room({ grounding: { sourceUrl: "https://x/spec", criteria: [] } }),
      [],
    );
    const g = board.sections.find((s) => s.kind === "rows" && s.title === "Grounding");
    expect(g?.kind).toBe("rows");
    const texts = g?.kind === "rows" ? g.items.map((i) => i.text) : [];
    expect(texts).toContain("https://x/spec");
  });

  test("an ungrounded room's board has no Grounding section", () => {
    const board = buildRoomBoard(room(), []);
    expect(board.sections.some((s) => s.kind === "rows" && s.title === "Grounding")).toBe(false);
  });
});

describe("buildRoomBoard — the Tabled section", () => {
  const exhibit = (over: Partial<LensRecord> = {}): LensRecord => ({
    id: "verdict",
    board: { view: "board", title: "The Verdict", sections: [] },
    updatedAt: "2026-01-01T00:00:00.000Z",
    kind: "exhibit",
    ...over,
  });

  function tabledSection(board: Board) {
    const s = board.sections.find((x) => x.kind === "cards" && x.title === "Tabled");
    return s?.kind === "cards" ? s : undefined;
  }

  test("a room that tabled nothing has no Tabled section", () => {
    expect(tabledSection(buildRoomBoard(room(), []))).toBeUndefined();
    // Explicitly empty is the same as omitted — the shelf exists only once used.
    expect(tabledSection(buildRoomBoard(room(), [], undefined, [], undefined, []))).toBeUndefined();
  });

  test("each exhibit is a card carrying Open and a confirm-gated delete", () => {
    const board = buildRoomBoard(room(), [], undefined, [], undefined, [exhibit()]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const items = tabledSection(board)?.items ?? [];
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe("The Verdict");
    expect(items[0]?.actions?.map((a) => a.type)).toEqual(["lens-open", "delete-exhibit"]);
    // Both verbs address the exhibit by id — a payload-less button could not.
    expect(items[0]?.actions?.[0]?.payload).toEqual({ id: "verdict" });
    expect(items[0]?.actions?.[1]?.payload).toEqual({ id: "verdict" });
    // The delete is destructive and asks first: this card is an exhibit's entry point.
    expect(items[0]?.actions?.[1]?.destructive).toBe(true);
    expect(items[0]?.actions?.[1]?.confirm?.title).toBe("Delete exhibit");
  });

  test("Tabled sits below the outcome and above the controls — controls stay last", () => {
    const board = buildRoomBoard(room(), [], undefined, [], undefined, [exhibit()]);
    const kinds = board.sections.map((s) => (s.kind === "cards" ? `cards:${s.title}` : s.kind));
    expect(kinds.at(-1)).toBe("actions");
    expect(kinds.at(-2)).toBe("cards:Tabled");
  });

  test("an untitled exhibit falls back to its id", () => {
    const board = buildRoomBoard(room(), [], undefined, [], undefined, [
      exhibit({ board: { view: "board", sections: [] } }),
    ]);
    expect(tabledSection(board)?.items[0]?.title).toBe("verdict");
  });

  test("a reason rides the card as its gist; absent leaves none", () => {
    const withReason = buildRoomBoard(room(), [], undefined, [], undefined, [
      exhibit({ reason: "the cluster is healthy" }),
    ]);
    expect(tabledSection(withReason)?.items[0]?.reason).toEqual({
      label: "gist",
      text: "the cluster is healthy",
    });
    const without = buildRoomBoard(room(), [], undefined, [], undefined, [exhibit()]);
    expect(tabledSection(without)?.items[0]?.reason).toBeUndefined();
  });

  test("no card restates the room it is already on — provenance would be noise", () => {
    const board = buildRoomBoard(room(), [], undefined, [], undefined, [
      exhibit({ sourceRoom: "r" }),
    ]);
    const fields = tabledSection(board)?.items[0]?.fields ?? [];
    expect(fields.map((f) => f.label)).toEqual(["tabled"]);
  });

  test("the vitals row is still found by kind — a titled Tabled cannot hijack it", () => {
    const board = buildRoomBoard(room({ turnIndex: 1 }), [entry()], undefined, [], undefined, [
      exhibit(),
    ]);
    expect(vitalsRow(board)).toBeDefined();
    expect(outcomeCard(board)).toBeUndefined();
  });
});

describe("buildRoomBoard · observability", () => {
  const withWindow = (input: number, ctx: number, window: number) =>
    ({ inputTokens: input, outputTokens: 100, contextTokens: ctx, contextWindow: window }) as const;

  test("a turn's trailing carries token spend but NOT the tool count (tools are their own rows)", () => {
    const board = buildRoomBoard(room(), [
      entry({
        turnIndex: 0,
        usage: { inputTokens: 12_400, outputTokens: 640 },
        toolCalls: [{ name: "Read", input: '{ "file_path": "services.py" }' }, { name: "Grep" }],
      }),
    ]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const turn = debateItems(board)[0];
    expect(turn?.trailing).toContain("↑12k ↓640");
    expect(turn?.trailing).not.toContain("⚙");
    // Two per-tool rows follow the turn.
    expect(toolRowsIn(board)).toHaveLength(2);
  });

  test("no usage leaves a bare time trailing", () => {
    const bare = buildRoomBoard(room(), [entry()]);
    expect(debateItems(bare)[0]?.trailing).not.toContain("↑");
    expect(toolRowsIn(bare)).toHaveLength(0);
  });

  test("each tool call renders as a collapsed row — gear, name, source chip; input JSON on expand; only failures trailed", () => {
    const board = buildRoomBoard(room(), [
      entry({
        toolCalls: [
          { name: "view", input: '{\n  "path": "README.md"\n}' },
          { name: "chamber_table_exhibit", input: '{ "id": "x" }' },
          { name: "Bash", input: '{ "command": "grep …" }', errored: true },
        ],
      }),
    ]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const rows = toolRowsIn(board);
    // Collapsed, the row is just the tool name — its input is disclosed under the caret.
    expect(rows.map((r) => r.text)).toEqual(["view", "chamber_table_exhibit", "Bash"]);
    expect(rows[0]?.detail).toBe('{\n  "path": "README.md"\n}');
    // Source chip: built-in for a plain tool, CHAMBER (brand-toned) for a chamber tool.
    expect(rows[0]?.chip).toMatchObject({ label: "BUILT-IN", tone: "neutral" });
    expect(rows[1]?.chip).toMatchObject({ label: "CHAMBER", tone: "brand" });
    // A persisted family (from the raw MCP name) drives the chip, not the stripped name.
    const mcp = buildRoomBoard(room(), [
      entry({ toolCalls: [{ name: "shell", family: "mcp", input: '{ "cmd": "ls" }' }] }),
    ]);
    expect(toolRowsIn(mcp)[0]?.chip).toMatchObject({ label: "MCP", tone: "neutral" });
    // A call with no input carries no detail — no empty caret to open.
    const bare = buildRoomBoard(room(), [entry({ toolCalls: [{ name: "Grep" }] })]);
    expect(toolRowsIn(bare)[0]).not.toHaveProperty("detail");
    // Success is NOT asserted (absent errored ≠ confirmed ok); only a known failure
    // is trailed, and it wears the error tone.
    expect(rows[0]?.trailing).toBeUndefined();
    expect(rows[0]?.glyph).toBeUndefined();
    expect(rows[2]?.trailing).toBe("failed");
    expect(rows[2]?.glyph).toBe("error");
  });

  test("Context bars appear per Mind whose latest turn reports a window, toned by fill", () => {
    const board = buildRoomBoard(
      room({ participants: ["a", "b"] }),
      [
        entry({ from: "a", turnIndex: 0, usage: withWindow(1, 148_000, 200_000) }), // 74% → warn
        entry({ from: "b", turnIndex: 1, usage: withWindow(1, 62_000, 200_000) }), // 31% → ok
      ],
      undefined,
      [mind({ slug: "a", name: "Ada" }), mind({ slug: "b", name: "Bo" })],
    );
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const bars = contextBars(board);
    expect(bars?.map((b) => b.label)).toEqual(["Ada", "Bo"]);
    expect(bars?.[0]).toMatchObject({ value: 148_000, total: 200_000, tone: "warn" });
    expect(bars?.[0]?.trailing).toBe("148k / 200k · 74%");
    expect(bars?.[1]?.tone).toBe("ok");
  });

  test("a fill at or over 85% tones the Context bar red (error)", () => {
    const board = buildRoomBoard(room({ participants: ["a"] }), [
      entry({ from: "a", usage: withWindow(1, 181_000, 200_000) }), // 90%
    ]);
    expect(contextBars(board)?.[0]?.tone).toBe("error");
  });

  test("Context tone uses the raw ratio, not the rounded percent, at the cutoffs", () => {
    const at695 = buildRoomBoard(room({ participants: ["a"] }), [
      entry({ from: "a", usage: withWindow(1, 139_000, 200_000) }), // 69.5% → ok, not warn
    ]);
    expect(contextBars(at695)?.[0]?.tone).toBe("ok");
    const at845 = buildRoomBoard(room({ participants: ["a"] }), [
      entry({ from: "a", usage: withWindow(1, 169_000, 200_000) }), // 84.5% → warn, not error
    ]);
    expect(contextBars(at845)?.[0]?.tone).toBe("warn");
  });

  test("the latest window reading per Mind wins", () => {
    const board = buildRoomBoard(room({ participants: ["a"] }), [
      entry({ from: "a", turnIndex: 0, usage: withWindow(1, 40_000, 200_000) }),
      entry({ from: "a", turnIndex: 1, usage: withWindow(1, 150_000, 200_000) }),
    ]);
    expect(contextBars(board)?.[0]?.value).toBe(150_000);
  });

  test("a stale reading is cleared when the Mind's latest turn reports no window", () => {
    const board = buildRoomBoard(room({ participants: ["a"] }), [
      entry({ from: "a", turnIndex: 0, usage: withWindow(1, 150_000, 200_000) }),
      entry({ from: "a", turnIndex: 1, usage: { inputTokens: 5, outputTokens: 5 } }), // no window
    ]);
    expect(contextBars(board)).toBeUndefined();
  });

  test("a tool row shows the bare name (no category-word marker doubling the verb)", () => {
    // "view" carries a "read" kind marker in toolPresentation; the row must not read "read view".
    const board = buildRoomBoard(room(), [
      entry({
        toolCalls: [{ name: "view", input: '{ "path": "README.md" }' }, { name: "foo__bar" }],
      }),
    ]);
    const texts = toolRowsIn(board).map((r) => r.text);
    expect(texts).toEqual(["view", "foo__bar"]);
    expect(texts.join("\n")).not.toMatch(/read view|foo__bar foo__bar/);
  });

  test("no Context section when no turn reports a window (provider omits it)", () => {
    const board = buildRoomBoard(room(), [
      entry({ usage: { inputTokens: 1000, outputTokens: 50 } }), // spend, but no window
    ]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(contextBars(board)).toBeUndefined();
    // Decisions still resolves at its usual slot when Context is absent.
    expect(vitalsRow(board)).toBeDefined();
  });

  test("the vitals line counts tool calls and flags failures", () => {
    const board = buildRoomBoard(room(), [
      entry({ turnIndex: 0, toolCalls: [{ name: "Read" }, { name: "Bash", errored: true }] }),
      entry({ turnIndex: 1, toolCalls: [{ name: "Grep" }] }),
    ]);
    expect(vitalsRow(board)?.text).toContain("⚙ 3 tools · 1 failed");
  });

  test("a single tool call reads singular on the vitals line", () => {
    const board = buildRoomBoard(room(), [entry({ toolCalls: [{ name: "Read" }] })]);
    expect(vitalsRow(board)?.text).toContain("⚙ 1 tool");
    expect(vitalsRow(board)?.text).not.toContain("⚙ 1 tools");
  });

  test("context-only usage (zero spend) shows the Context meter but no spend arrows", () => {
    const board = buildRoomBoard(room({ participants: ["a"] }), [
      // a real window, zero in/out — a context report, not measured spend
      entry({
        from: "a",
        usage: { inputTokens: 0, outputTokens: 0, contextTokens: 90_000, contextWindow: 200_000 },
      }),
    ]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    // Context meter renders...
    expect(contextBars(board)?.[0]?.value).toBe(90_000);
    // ...but neither the turn trailing nor the vitals line claims ↑0 ↓0 spend.
    expect(debateItems(board)[0]?.trailing).not.toContain("↑");
    expect(vitalsRow(board)?.text).not.toContain("↑");
  });

  test("a non-finite or negative context reading is dropped from the meter", () => {
    const nan = buildRoomBoard(room({ participants: ["a"] }), [
      entry({
        from: "a",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          contextTokens: Number.NaN,
          contextWindow: 200_000,
        },
      }),
    ]);
    expect(contextBars(nan)).toBeUndefined();
    const neg = buildRoomBoard(room({ participants: ["a"] }), [
      entry({
        from: "a",
        usage: { inputTokens: 1, outputTokens: 1, contextTokens: 100, contextWindow: 0 },
      }),
    ]);
    expect(contextBars(neg)).toBeUndefined();
  });
});
