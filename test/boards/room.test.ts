import { describe, expect, test } from "bun:test";
import { canvasViewSchema } from "@keelson/shared";
import { buildRoomBoard } from "../../src/boards/room.ts";
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

describe("buildRoomBoard", () => {
  test("empty transcript is valid; no vitals stats (no turns, no scope)", () => {
    const board = buildRoomBoard(room(), []);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.sections.some((s) => s.kind === "stats")).toBe(false);
    // The header carries no per-mind segments anymore — Voices covers that.
    expect(board.header?.segments).toBeUndefined();
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
    const board = buildRoomBoard(room({ slug: "r", participants: ["a", "b"] }), []);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const actions = actionsSection(board);
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

  test("a closed room offers Start-again + Start group-chat + open-floor + magentic", () => {
    for (const status of ["stopped", "done"] as const) {
      const board = buildRoomBoard(room({ status, participants: ["a", "b"], turnBudget: 6 }), []);
      expect(canvasViewSchema.safeParse(board).success).toBe(true);
      const actions = actionsSection(board);
      expect(actions.items.map((i) => i.type)).toEqual([
        "room-start",
        "room-start",
        "room-start",
        "room-start",
      ]);
      expect(actions.items.map((i) => i.label)).toEqual([
        "Start again",
        "Start group-chat",
        "Start open-floor",
        "Start magentic",
      ]);
      // Start magentic collects the manager via a field (a Mind not in the room).
      const magentic = actions.items.find((i) => i.label === "Start magentic");
      expect(magentic?.fields?.map((f) => f.name)).toEqual(["manager"]);
      expect(magentic?.payload).toMatchObject({ strategy: "magentic" });
      // Start again — no slug (the server assigns a fresh one per start).
      expect(actions.items[0]?.payload).toMatchObject({ turnBudget: 6, participants: ["a", "b"] });
    }
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

  test("the Start group-chat action collects a moderator via a field form", () => {
    const board = buildRoomBoard(room({ status: "done", participants: ["a", "b"] }), []);
    const gc = actionsSection(board).items.find((i) => i.label === "Start group-chat");
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
    const of = actionsSection(board).items.find((i) => i.label === "Start open-floor");
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
    expect(debateTitle(board)).toBe("Debate · 2 rounds");
  });

  test("the debate title omits the round count for a single round or no round data", () => {
    const oneRound = buildRoomBoard(room(), [entry({ round: 0 }), entry({ round: 0 })]);
    expect(debateTitle(oneRound)).toBe("Debate");
    const noRounds = buildRoomBoard(room(), [entry({ round: undefined })]);
    expect(debateTitle(noRounds)).toBe("Debate");
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

  test("token usage sums across turns onto the same line, omitted when no turn carries it", () => {
    const noUsage = buildRoomBoard(room(), [entry()]);
    expect(vitalsRow(noUsage)?.text).not.toContain("↑");

    const board = buildRoomBoard(room(), [
      entry({ usage: { inputTokens: 100_000, outputTokens: 8_000 } }),
      entry({ usage: { inputTokens: 48_000, outputTokens: 3_000 } }),
    ]);
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
