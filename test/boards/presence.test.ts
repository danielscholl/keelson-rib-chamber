import { describe, expect, test } from "bun:test";
import { canvasViewSchema } from "@keelson/shared";
import { buildChamberBoard } from "../../src/boards/presence.ts";
import type { PendingGenesis } from "../../src/pending-genesis.ts";
import { MAX_ACTIVE_ROOMS } from "../../src/room-config.ts";
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

const pending = (over: Partial<PendingGenesis> = {}): PendingGenesis => ({
  startedAt: "2026-07-12T09:00:00.000Z",
  ...over,
});

type Board = ReturnType<typeof buildChamberBoard>;

function cards(board: Board) {
  const section = board.sections.find((s) => s.kind === "cards");
  if (section?.kind !== "cards") throw new Error("no cards section");
  return section.items;
}

// The open seat is permanent furniture: it rides the next free seat, directly
// after the seated Minds (and the boot card, while a genesis runs).
function openSeat(board: Board) {
  const seat = cards(board).find((c) => c.title === "Open seat");
  if (!seat) throw new Error("no open seat");
  return seat;
}

function padSeats(board: Board) {
  return cards(board).filter((c) => c.title === "Empty seat");
}

describe("buildChamberBoard cold start", () => {
  test("0 minds renders the four-seat bench: pads plus the open seat, brief open", () => {
    const board = buildChamberBoard([]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.header?.status?.label).toBe("No minds yet");
    expect(board.header?.chip).toBe("awaiting genesis");
    expect(cards(board).map((c) => c.title)).toEqual([
      "Open seat",
      "Empty seat",
      "Empty seat",
      "Empty seat",
    ]);
    // Pads are decorative: ghosts with no affordances.
    for (const pad of padSeats(board)) {
      expect(pad.ghost).toBe(true);
      expect(pad.actions).toBeUndefined();
    }
    // The freeform hero stays expanded at cold start — the seat IS the genesis form.
    const hero = openSeat(board).actions?.[0];
    expect(hero?.type).toBe("describe-own");
    expect(hero?.expanded).toBe(true);
    expect(board.sections.some((s) => s.kind === "actions")).toBe(false);
  });

  test("an empty bench still shows the live pulse when a room is active", () => {
    // Reachable: retiring every Mind while a room runs (retire doesn't gate on
    // active-room membership). The head must surface the live room, not hide it.
    const board = buildChamberBoard([], [room({ status: "active" })]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.header?.chip).toBe("1 room · in session");
    // The open seat still renders alongside the pulse — the emptied bench must
    // stay authorable.
    expect(openSeat(board).actions?.[0]?.type).toBe("describe-own");
  });

  test("a stopped room is not in session — no pulse chip, no session footer", () => {
    const board = buildChamberBoard([mind({ identitySlot: 0 })], [room({ status: "stopped" })]);
    expect(board.header?.chip).toBe("bench at rest");
    expect(cards(board)[0]?.fields?.map((f) => f.label)).toEqual([undefined]);
  });
});

describe("buildChamberBoard seated", () => {
  test("one seat card per Mind — identity dot, hue-matched role pill, mission, verbs", () => {
    // readMinds hands the bench newest-first; seats render in arrival order, so
    // the elder Jarvis holds seat 1 and the newer Mycroft seats after him.
    const minds = [
      mind({ slug: "mycroft", name: "Mycroft", identitySlot: 1, role: "Research Partner" }),
      mind({ slug: "jarvis", name: "Jarvis", identitySlot: 0 }),
    ];
    const board = buildChamberBoard(minds, []);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.header?.status?.label).toBe("2 minds convene here");
    expect(board.header?.chip).toBe("bench at rest");
    const items = cards(board);
    expect(items.map((c) => c.title)).toEqual(["Jarvis", "Mycroft", "Open seat", "Empty seat"]);
    expect(items[0]?.dot).toBe(IDENTITY_SLOT_TONES[0]);
    expect(items[0]?.pill?.tone).toBe(IDENTITY_SLOT_TONES[0]);
    expect(items[1]?.pill?.label).toBe("Research Partner");
    // Mission line only — a Mind at rest carries no status prose, so the card body
    // never reads as a fourth sentence of the persona.
    expect(items[0]?.stacked).toBe(true);
    expect(items[0]?.fields?.[0]?.value).toBe("You are Jarvis.");
    expect(items[0]?.fields?.length).toBe(1);
    expect(items[0]?.actions?.map((a) => a.type)).toEqual(["enter-mind", "set-model", "retire"]);
  });

  test("a Mind past the ramp folds to neutral — and the pill stays untoned", () => {
    // Newest-first input (readMinds order); the sixth-authored M5 seats last.
    const minds = Array.from({ length: 6 }, (_, i) =>
      mind({ slug: `m${i}`, name: `M${i}`, identitySlot: i }),
    ).reverse();
    const items = cards(buildChamberBoard(minds, []));
    expect(items[5]?.dot).toBe("neutral");
    expect(items[5]?.pill?.tone).toBeUndefined();
  });

  test("the lone-Mind nudge names the next act", () => {
    const board = buildChamberBoard([mind()], []);
    const rows = board.sections.find((s) => s.kind === "rows");
    expect(rows?.kind === "rows" && rows.items[0]?.text).toContain("Seat a second Mind");
  });

  test("the bench is a declared-capacity grid carrying the ghost open seat", () => {
    const board = buildChamberBoard([mind({ slug: "jarvis", identitySlot: 2 })], []);
    const section = board.sections.find((s) => s.kind === "cards");
    if (section?.kind !== "cards") throw new Error("no cards section");
    expect(section.grid).toBe(true);
    expect(section.columns).toBe(4);
    const seat = openSeat(board);
    expect(seat.ghost).toBe(true);
    // The brief keeps its open form in every state (the seat never shape-shifts),
    // free starters after.
    expect(seat.actions?.[0]?.type).toBe("describe-own");
    expect(seat.actions?.[0]?.expanded).toBe(true);
    // Jarvis is seated; the other starters remain, previewing their free hues.
    const labels = (seat.actions ?? []).slice(1).map((i) => i.label);
    expect(labels.some((l) => l.includes("Jarvis"))).toBe(false);
    expect(labels.length).toBeGreaterThan(0);
  });

  test("the bench law: the open seat rides the next free seat, pads round the row", () => {
    // Newest-first input (readMinds order); the bench re-seats it arrival-first.
    const bench = (n: number) =>
      cards(
        buildChamberBoard(
          Array.from({ length: n }, (_, i) => mind({ slug: `m${i}`, name: `M${i}` })).reverse(),
          [],
        ),
      );
    // The seat directly follows the roster; trailing pads round up to capacity.
    expect(bench(0).map((c) => c.title)).toEqual([
      "Open seat",
      "Empty seat",
      "Empty seat",
      "Empty seat",
    ]);
    expect(bench(3).map((c) => c.title)).toEqual(["M0", "M1", "M2", "Open seat"]);
    // A full mind row rolls the seat onto the next row, leading it.
    expect(bench(4).map((c) => c.title)).toEqual([
      "M0",
      "M1",
      "M2",
      "M3",
      "Open seat",
      "Empty seat",
      "Empty seat",
      "Empty seat",
    ]);
    // Row two hosts four across; the seat trails the roster.
    expect(bench(7).map((c) => c.title)).toEqual([
      "M0",
      "M1",
      "M2",
      "M3",
      "M4",
      "M5",
      "M6",
      "Open seat",
    ]);
  });

  test("an authored mission outranks the tagline; absent falls back to it", () => {
    const withMission = cards(
      buildChamberBoard([mind({ mission: "Reads the telemetry. Names tradeoffs." })], []),
    );
    expect(withMission[0]?.fields?.[0]?.value).toBe("Reads the telemetry. Names tradeoffs.");
    const fallback = cards(buildChamberBoard([mind()], []));
    expect(fallback[0]?.fields?.[0]?.value).toBe("You are Jarvis.");
  });
});

describe("buildChamberBoard session footer", () => {
  test("is room-scoped: session name when in one, a count past that, absent otherwise", () => {
    const minds = [mind({ slug: "jarvis", identitySlot: 0 })];
    const one = cards(
      buildChamberBoard(minds, [room({ status: "active", name: "Liveness decision" })]),
    );
    expect(one[0]?.fields?.at(-1)).toMatchObject({
      label: "session",
      value: "Liveness decision",
      tone: "info",
    });
    const two = cards(
      buildChamberBoard(minds, [
        room({ slug: "a", status: "active" }),
        room({ slug: "b", status: "active", participants: ["jarvis"] }),
      ]),
    );
    expect(two[0]?.fields?.at(-1)).toMatchObject({ label: "session", value: "2 rooms" });
    const done = cards(buildChamberBoard(minds, [room({ status: "done" })]));
    expect(done[0]?.fields?.length).toBe(1);
  });

  test("counts a room the Mind moderates without being a participant", () => {
    const minds = [mind({ slug: "moneypenny", name: "Moneypenny", identitySlot: 1 })];
    const items = cards(
      buildChamberBoard(minds, [
        room({
          status: "active",
          participants: ["jarvis", "mycroft"],
          config: { moderator: "moneypenny" },
          name: "Moderated debate",
        }),
      ]),
    );
    expect(items[0]?.fields?.at(-1)).toMatchObject({
      label: "session",
      value: "Moderated debate",
    });
  });

  test("is orthogonal to the draft: seating a mid-session Mind keeps its session named", () => {
    // The two states answer different questions — the ring says "in this cast", the
    // field says "already talking over there" — so seating must not swallow the room.
    // Two Minds and headroom under the cap, else the bench withholds the seat toggle.
    const minds = [
      mind({ slug: "jarvis", name: "Jarvis", identitySlot: 0 }),
      mind({ slug: "mycroft", name: "Mycroft", identitySlot: 1 }),
    ];
    const board = buildChamberBoard(
      minds,
      [room({ status: "active", participants: ["jarvis"], name: "Liveness decision" })],
      [],
      Date.parse("2026-07-12T09:00:05.000Z"),
      { selected: new Set(["jarvis"]) },
    );
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const jarvis = cards(board).find((c) => c.title === "Jarvis");
    expect(jarvis?.selected).toBe(true);
    expect(jarvis?.fields?.at(-1)).toMatchObject({
      label: "session",
      value: "Liveness decision",
      tone: "info",
    });
    // The unseated Mind is in no room, so its card carries the mission alone.
    const mycroft = cards(board).find((c) => c.title === "Mycroft");
    expect(mycroft?.selected).toBe(false);
    expect(mycroft?.fields?.length).toBe(1);
  });
});

describe("buildChamberBoard pending genesis", () => {
  test("the boot card takes the next free seat; the open seat rests just after it", () => {
    const board = buildChamberBoard(
      [mind({ slug: "jarvis", identitySlot: 0 })],
      [],
      [pending({ name: "Mycroft", role: "Research Partner" })],
      Date.parse("2026-07-12T09:00:05.000Z"),
    );
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const items = cards(board);
    expect(items.map((c) => c.title)).toEqual(["Jarvis", "Mycroft", "Open seat", "Empty seat"]);
    expect(items[1]?.pill?.label).toBe("authoring");
    expect(items[1]?.dot).toBe(IDENTITY_SLOT_TONES[1]);
    // The seat keeps its open form while the genesis runs, and the booting
    // starter is withheld so it can't be authored twice.
    const seat = openSeat(board);
    expect(seat.actions?.[0]?.expanded).toBe(true);
    expect((seat.actions ?? []).map((a) => a.label).some((l) => l.includes("Mycroft"))).toBe(false);
    expect(board.sections.some((s) => s.kind === "actions")).toBe(false);
  });

  test("a pending genesis on a cold bench boots into the first seat, launchpad folded", () => {
    const board = buildChamberBoard([], [], [pending()], Date.parse("2026-07-12T09:00:05.000Z"));
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.header?.status?.label).toBe("genesis under way");
    const items = cards(board);
    expect(items).toHaveLength(4);
    expect(items[0]?.pill?.label).toBe("authoring");
    expect(openSeat(board).actions?.[0]?.expanded).toBe(true);
    expect(board.sections.some((s) => s.kind === "actions")).toBe(false);
  });

  test("two concurrent geneses hold a boot card each; the seat withholds both voices", () => {
    const board = buildChamberBoard(
      [],
      [],
      [
        pending({ name: "Moneypenny", role: "Chief of Staff" }),
        pending({
          startedAt: "2026-07-12T09:00:02.000Z",
          name: "Mycroft",
          role: "Research Partner",
        }),
      ],
      Date.parse("2026-07-12T09:00:05.000Z"),
    );
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const items = cards(board);
    expect(items.map((c) => c.title)).toEqual(["Moneypenny", "Mycroft", "Open seat", "Empty seat"]);
    // Each boot card previews its starter's reserved hue — never the same one twice.
    expect(items[0]?.dot).toBe(IDENTITY_SLOT_TONES[0]);
    expect(items[1]?.dot).toBe(IDENTITY_SLOT_TONES[1]);
    // Both booting voices are withheld from the seat; Jarvis stays offered.
    const labels = (openSeat(board).actions ?? []).map((a) => a.label);
    expect(labels.some((l) => l.includes("Moneypenny"))).toBe(false);
    expect(labels.some((l) => l.includes("Mycroft"))).toBe(false);
    expect(labels.some((l) => l.includes("Jarvis"))).toBe(true);
  });

  test("a genesis past the full ramp boots into the neutral fold", () => {
    const minds = Array.from({ length: 5 }, (_, i) =>
      mind({ slug: `m${i}`, name: `M${i}`, identitySlot: i }),
    );
    const board = buildChamberBoard(minds, [], [pending()], Date.parse("2026-07-12T09:00:05.000Z"));
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const boot = cards(board).find((c) => c.pill?.label === "authoring");
    expect(boot?.dot).toBe("neutral");
  });

  test("a cold-bench genesis beside a live room keeps both signals", () => {
    const board = buildChamberBoard(
      [],
      [room({ status: "active" })],
      [pending()],
      Date.parse("2026-07-12T09:00:05.000Z"),
    );
    expect(board.header?.status?.label).toBe("genesis under way");
    expect(board.header?.chip).toBe("1 room · in session");
    expect(cards(board)[0]?.pill?.label).toBe("authoring");
  });
});

describe("buildChamberBoard pulse chip", () => {
  test("counts concurrent active rooms", () => {
    const board = buildChamberBoard(
      [mind()],
      [
        room({ slug: "a", status: "active" }),
        room({ slug: "b", status: "active" }),
        room({ slug: "c", status: "done" }),
      ],
    );
    expect(board.header?.chip).toBe("2 rooms · in session");
  });
});

describe("buildChamberBoard convene composer (folded in)", () => {
  const NOW = Date.parse("2026-07-12T09:00:05.000Z");
  const A = mind({ slug: "a", name: "Ada", identitySlot: 0, provider: "anthropic" });
  const B = mind({ slug: "b", name: "Bo", identitySlot: 1, provider: "openai" });
  // Assembly is derived from the cast, so a draft is only ever its inclusion set.
  const draft = (selected: string[] = []) => ({ selected: new Set(selected) });
  // A bench running n rooms, each its own — what listRooms hands the board.
  const liveRooms = (n: number) =>
    Array.from({ length: n }, (_, i) => room({ slug: `room-${i}`, status: "active" }));

  function actionSections(board: Board) {
    return board.sections.filter((s) => s.kind === "actions");
  }
  function seat(board: Board, title: string) {
    return cards(board).find((c) => c.title === title);
  }

  test("a quiet bench of 2+ Minds seats on a click — no launcher to press first", () => {
    const board = buildChamberBoard([A, B], []);
    expect(board.header?.chip).toBe("bench at rest");
    // Assembly is not a mode: there is no button to enter it, so the bench at rest
    // carries no actions section at all.
    expect(actionSections(board)).toHaveLength(0);
    // The seats are live toggles from rest — a click IS the entry.
    expect(seat(board, "Ada")?.action).toEqual({ type: "draft-set", payload: { slug: "a" } });
    expect(seat(board, "Ada")?.selected).toBe(false);
    // And the invitation that teaches it renders without a button gating it.
    expect(
      board.sections.some(
        (s) =>
          s.kind === "rows" &&
          s.items.some((i) => i.text === "Click a Mind to bring them to the table."),
      ),
    ).toBe(true);
  });

  test("no seat toggles with a lone Mind, a pending genesis, or a bench at the cap", () => {
    const lone = buildChamberBoard([mind()], []);
    const booting = buildChamberBoard([A, B], [], [pending()], NOW);
    const capped = buildChamberBoard([A, B], liveRooms(MAX_ACTIVE_ROOMS));
    for (const board of [lone, booting, capped]) {
      expect(actionSections(board)).toHaveLength(0);
      // canConvene gates the toggle itself, so a card outside the window can't seat.
      for (const card of cards(board).filter((c) => !c.ghost)) {
        expect(card.action).toBeUndefined();
        expect(card.selected).toBeUndefined();
      }
    }
  });

  test("assembling: seats become click-to-seat toggles, ringed — not labelled — when seated", () => {
    const board = buildChamberBoard([A, B], [], [], NOW, draft(["a"]));
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.header?.chip).toBe("assembling");
    const ada = seat(board, "Ada");
    // The whole card is the participant toggle now: a draft-set on the card body,
    // `selected` rings it; the management verbs stay their own buttons. Seating adds
    // no field — the ring IS the indicator, so seated and benched read identically
    // in the body and differ only in the frame.
    expect(ada?.action).toEqual({ type: "draft-set", payload: { slug: "a" } });
    expect(ada?.selected).toBe(true);
    expect(ada?.fields?.length).toBe(1);
    expect(ada?.actions?.map((a) => a.type)).toEqual(["enter-mind", "set-model", "retire"]);
    // The un-seated Mind carries the same toggle, not selected — same body, no ring.
    const bo = seat(board, "Bo");
    expect(bo?.action).toEqual({ type: "draft-set", payload: { slug: "b" } });
    expect(bo?.selected).toBe(false);
    expect(bo?.fields?.length).toBe(1);
  });

  test("with two seated the composer unfolds the shape tabs and named cast without Clear", () => {
    const board = buildChamberBoard([A, B], [], [], NOW, draft(["a", "b"]));
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const how = board.sections.find(
      (s) => s.kind === "actions" && s.title === "How should they convene?",
    );
    expect(how).toBeDefined();
    // Named, not counted — and in SEAT order, so the line reads left-to-right like the
    // cards it was clicked from. [A, B] arrives newest-first, so Bo is the elder and
    // holds the leftmost seat; the line has to agree with the bench, not with the input.
    expect(
      cards(board)
        .map((c) => c.title)
        .slice(0, 2),
    ).toEqual(["Bo", "Ada"]);
    const cast = board.sections.find(
      (s) => s.kind === "rows" && s.items.some((i) => i.text === "Bo and Ada at the table"),
    );
    expect(cast).toBeDefined();
    // Unseating is a click on the seat card, so the bench offers no Clear chip.
    expect(board.sections.some((s) => s.kind === "actions" && s.items[0]?.label === "Clear")).toBe(
      false,
    );
  });

  test("the cast is named to three, then falls back to a count", () => {
    const C = mind({ slug: "c", name: "Cy", identitySlot: 2 });
    const D = mind({ slug: "d", name: "Di", identitySlot: 3 });
    const castText = (board: Board) => {
      const row = board.sections.find(
        (s) => s.kind === "rows" && s.items.some((i) => i.text.endsWith("at the table")),
      );
      return row?.kind === "rows" ? row.items[0]?.text : undefined;
    };
    // Newest-first in, seat order out — the Oxford comma at three.
    expect(castText(buildChamberBoard([C, B, A], [], [], NOW, draft(["a", "b", "c"])))).toBe(
      "Ada, Bo, and Cy at the table",
    );
    // Past three, naming is the same work as counting, so it counts.
    expect(
      castText(buildChamberBoard([D, C, B, A], [], [], NOW, draft(["a", "b", "c", "d"]))),
    ).toBe("4 at the table");
  });

  test("with fewer than two seated the composer prompts specifically to seat more", () => {
    const howTab = (board: Board) =>
      board.sections.some((s) => s.kind === "actions" && s.title === "How should they convene?");
    const none = buildChamberBoard([A, B], [], [], NOW, draft([]));
    expect(howTab(none)).toBe(false);
    expect(
      none.sections.some(
        (s) =>
          s.kind === "rows" &&
          s.items.some((i) => i.text === "Click a Mind to bring them to the table."),
      ),
    ).toBe(true);
    // Exactly one seated names them and asks for one more — not a generic prompt.
    const one = buildChamberBoard([A, B], [], [], NOW, draft(["a"]));
    expect(howTab(one)).toBe(false);
    expect(
      one.sections.some(
        (s) =>
          s.kind === "rows" &&
          s.items.some((i) => i.text === "Ada is at the table — click another Mind to convene."),
      ),
    ).toBe(true);
  });

  test("assembly is suppressed by a pending genesis (never overlaps the tick)", () => {
    // A genesis in flight hides the composer (the panel is ticking) but the draft survives.
    const booting = buildChamberBoard([A, B], [], [pending()], NOW, draft(["a", "b"]));
    expect(booting.sections.some((s) => s.kind === "actions")).toBe(false);
    expect(seat(booting, "Ada")?.action).toBeUndefined();
  });

  test("a live room leaves assembly open — rooms run concurrently under the cap", () => {
    const live = buildChamberBoard(
      [A, B],
      [room({ status: "active" })],
      [],
      NOW,
      draft(["a", "b"]),
    );
    expect(live.header?.chip).toBe("1 room · in session");
    expect(live.sections.some((s) => s.kind === "actions")).toBe(true);
    expect(seat(live, "Ada")?.action).toEqual({ type: "draft-set", payload: { slug: "a" } });
  });

  test("assembly survives to one room short of the cap and closes at it", () => {
    const cast = draft(["a", "b"]);
    const under = buildChamberBoard([A, B], liveRooms(MAX_ACTIVE_ROOMS - 1), [], NOW, cast);
    expect(under.sections.some((s) => s.kind === "actions")).toBe(true);
    // At the cap the composer would only compose a start that startRoom refuses.
    const at = buildChamberBoard([A, B], liveRooms(MAX_ACTIVE_ROOMS), [], NOW, cast);
    expect(at.sections.some((s) => s.kind === "actions")).toBe(false);
    expect(seat(at, "Ada")?.action).toBeUndefined();
  });

  test("a closed room is not live — it never counts against the cap", () => {
    const closed = Array.from({ length: MAX_ACTIVE_ROOMS + 2 }, (_, i) =>
      room({ slug: `done-${i}`, status: "done" }),
    );
    const board = buildChamberBoard([A, B], closed, [], NOW, draft(["a", "b"]));
    expect(board.sections.some((s) => s.kind === "actions")).toBe(true);
  });
});
