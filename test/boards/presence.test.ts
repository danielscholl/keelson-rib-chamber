import { describe, expect, test } from "bun:test";
import { canvasViewSchema } from "@keelson/shared";
import { buildChamberBoard } from "../../src/boards/presence.ts";
import type { PendingGenesis } from "../../src/pending-genesis.ts";
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

function actionsSection(board: Board) {
  const section = board.sections.find((s) => s.kind === "actions");
  if (section?.kind !== "actions") throw new Error("no actions section");
  return section;
}

describe("buildChamberBoard cold start", () => {
  test("0 minds renders the genesis launchpad, no cards, no pulse chip", () => {
    const board = buildChamberBoard([]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.header?.status?.label).toBe("No minds yet");
    expect(board.header?.chip).toBeUndefined();
    expect(board.sections.some((s) => s.kind === "cards")).toBe(false);
    // The freeform hero stays expanded at cold start — the launchpad IS the panel.
    const hero = actionsSection(board).items[0];
    expect(hero?.type).toBe("describe-own");
    expect(hero?.expanded).toBe(true);
  });

  test("an empty bench still shows the live pulse when a room is active", () => {
    // Reachable: retiring every Mind while a room runs (retire doesn't gate on
    // active-room membership). The head must surface the live room, not hide it.
    const board = buildChamberBoard([], [room({ status: "active" })]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.header?.chip).toBe("1 room · in session");
    // The genesis launchpad still renders alongside the pulse — the emptied
    // bench must stay authorable.
    const hero = actionsSection(board).items[0];
    expect(hero?.type).toBe("describe-own");
  });

  test("a stopped room is not in session — no pulse chip, footer on the bench", () => {
    const board = buildChamberBoard([mind({ identitySlot: 0 })], [room({ status: "stopped" })]);
    expect(board.header?.chip).toBe("bench at rest");
    expect(cards(board)[0]?.fields?.at(-1)?.value).toBe("on the bench");
  });
});

describe("buildChamberBoard seated", () => {
  test("one seat card per Mind — identity dot, hue-matched role pill, mission, verbs", () => {
    const minds = [
      mind({ slug: "jarvis", name: "Jarvis", identitySlot: 0 }),
      mind({ slug: "mycroft", name: "Mycroft", identitySlot: 1, role: "Research Partner" }),
    ];
    const board = buildChamberBoard(minds, []);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.header?.status?.label).toBe("2 minds convene here");
    expect(board.header?.chip).toBe("bench at rest");
    const items = cards(board);
    expect(items.map((c) => c.title)).toEqual(["Jarvis", "Mycroft"]);
    expect(items[0]?.dot).toBe(IDENTITY_SLOT_TONES[0]);
    expect(items[0]?.pill?.tone).toBe(IDENTITY_SLOT_TONES[0]);
    expect(items[1]?.pill?.label).toBe("Research Partner");
    // Mission line first, status footer last — stacked, not an inline meta row.
    expect(items[0]?.stacked).toBe(true);
    expect(items[0]?.fields?.[0]?.value).toBe("You are Jarvis.");
    expect(items[0]?.fields?.at(-1)?.value).toBe("on the bench");
    expect(items[0]?.actions?.map((a) => a.type)).toEqual(["enter-mind", "set-model", "retire"]);
  });

  test("a Mind past the ramp folds to neutral — and the pill stays untoned", () => {
    const minds = Array.from({ length: 6 }, (_, i) =>
      mind({ slug: `m${i}`, name: `M${i}`, identitySlot: i }),
    );
    const items = cards(buildChamberBoard(minds, []));
    expect(items[5]?.dot).toBe("neutral");
    expect(items[5]?.pill?.tone).toBeUndefined();
  });

  test("the lone-Mind nudge names the next act", () => {
    const board = buildChamberBoard([mind()], []);
    const rows = board.sections.find((s) => s.kind === "rows");
    expect(rows?.kind === "rows" && rows.items[0]?.text).toContain("Seat a second Mind");
  });

  test("the authoring row is a wrap strip: closed brief first, free starters after", () => {
    const board = buildChamberBoard([mind({ slug: "jarvis", identitySlot: 2 })], []);
    const author = actionsSection(board);
    expect(author.wrap).toBe(true);
    expect(author.items[0]?.type).toBe("describe-own");
    expect(author.items[0]?.expanded).toBeUndefined();
    // Jarvis is seated; the other starters remain, previewing their free hues.
    const labels = author.items.slice(1).map((i) => i.label);
    expect(labels.some((l) => l.includes("Jarvis"))).toBe(false);
    expect(labels.length).toBeGreaterThan(0);
  });
});

describe("buildChamberBoard status footer", () => {
  test("is room-scoped: session name when in one, a count past that, never a verb", () => {
    const minds = [mind({ slug: "jarvis", identitySlot: 0 })];
    const one = cards(
      buildChamberBoard(minds, [room({ status: "active", name: "Liveness decision" })]),
    );
    expect(one[0]?.fields?.at(-1)?.value).toBe("in session · Liveness decision");
    const two = cards(
      buildChamberBoard(minds, [
        room({ slug: "a", status: "active" }),
        room({ slug: "b", status: "active", participants: ["jarvis"] }),
      ]),
    );
    expect(two[0]?.fields?.at(-1)?.value).toBe("active in 2 rooms");
    const done = cards(buildChamberBoard(minds, [room({ status: "done" })]));
    expect(done[0]?.fields?.at(-1)?.value).toBe("on the bench");
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
    expect(items[0]?.fields?.at(-1)?.value).toBe("in session · Moderated debate");
  });
});

describe("buildChamberBoard pending genesis", () => {
  test("the boot card takes the next free seat and the launchpad is withheld", () => {
    const board = buildChamberBoard(
      [mind({ slug: "jarvis", identitySlot: 0 })],
      [],
      pending({ name: "Mycroft", role: "Research Partner" }),
      Date.parse("2026-07-12T09:00:05.000Z"),
    );
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const items = cards(board);
    expect(items.at(-1)?.pill?.label).toBe("authoring");
    expect(items.at(-1)?.dot).toBe(IDENTITY_SLOT_TONES[1]);
    expect(board.sections.some((s) => s.kind === "actions")).toBe(false);
  });

  test("a pending genesis on a cold bench shows the boot card, not the launchpad", () => {
    const board = buildChamberBoard([], [], pending(), Date.parse("2026-07-12T09:00:05.000Z"));
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.header?.status?.label).toBe("genesis under way");
    expect(cards(board)).toHaveLength(1);
    expect(board.sections.some((s) => s.kind === "actions")).toBe(false);
  });

  test("a genesis past the full ramp boots into the neutral fold", () => {
    const minds = Array.from({ length: 5 }, (_, i) =>
      mind({ slug: `m${i}`, name: `M${i}`, identitySlot: i }),
    );
    const board = buildChamberBoard(minds, [], pending(), Date.parse("2026-07-12T09:00:05.000Z"));
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(cards(board).at(-1)?.dot).toBe("neutral");
  });

  test("a cold-bench genesis beside a live room keeps both signals", () => {
    const board = buildChamberBoard(
      [],
      [room({ status: "active" })],
      pending(),
      Date.parse("2026-07-12T09:00:05.000Z"),
    );
    expect(board.header?.status?.label).toBe("genesis under way");
    expect(board.header?.chip).toBe("1 room · in session");
    expect(cards(board)).toHaveLength(1);
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
