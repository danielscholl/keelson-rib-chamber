import { describe, expect, test } from "bun:test";
import { canvasViewSchema } from "@keelson/shared";
import {
  type BriefSeatedMind,
  briefingJourneySection,
  briefingPeople,
  briefingPulseSection,
  briefingVerdictSection,
  buildDeltaRegister,
  type ChangedLensBrief,
  deriveEndedRoomBrief,
  type EndedRoomBrief,
} from "../../src/boards/briefing.ts";
import type { Room, TurnEntry } from "../../src/types.ts";

const room = (over: Partial<Room> = {}): Room => ({
  slug: "room-1",
  name: "Design Review",
  strategy: "sequential",
  participants: ["ada", "bo"],
  status: "done",
  turnBudget: 8,
  turnIndex: 4,
  round: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const entry = (over: Partial<TurnEntry> = {}): TurnEntry => ({
  messageId: "m1",
  roomSlug: "room-1",
  turnIndex: 0,
  from: "ada",
  role: "agent",
  parts: [{ text: "a turn" }],
  at: "2026-01-01T00:10:00.000Z",
  ...over,
});

const MINDS: BriefSeatedMind[] = [
  { slug: "ada", name: "Ada", identitySlot: 0 },
  { slug: "bo", name: "Bo", identitySlot: 1 },
];

const lensBrief = (over: Partial<ChangedLensBrief> = {}): ChangedLensBrief => ({
  id: "release-risks",
  title: "Release Risks",
  kind: "lens",
  ...over,
});

// Every built section must survive the same render gate the banner publishes through.
function expectValidBoard(sections: unknown[]): void {
  const parsed = canvasViewSchema.safeParse({ view: "board", title: "Briefing", sections });
  expect(parsed.success).toBe(true);
}

describe("deriveEndedRoomBrief", () => {
  test("reads the closing verdict title from a synthesized close's opening heading", () => {
    const brief = deriveEndedRoomBrief(room({ outcomeAt: "2026-01-01T01:00:00.000Z" }), [
      entry({ parts: [{ text: "debate" }] }),
      entry({
        messageId: "m2",
        turnIndex: 1,
        from: "bo",
        parts: [{ text: "## Ship it behind a flag\n\nThe room agreed on a staged rollout." }],
      }),
    ]);
    expect(brief.outcomeTitle).toBe("Ship it behind a flag");
  });

  test("a synthesized plain-prose close yields NO verdict title (no generic claim invented)", () => {
    const brief = deriveEndedRoomBrief(room({ outcomeAt: "2026-01-01T01:00:00.000Z" }), [
      entry({ parts: [{ text: "We wrapped up without a document." }] }),
    ]);
    expect(brief.outcomeTitle).toBeUndefined();
  });

  test("an unsynthesized room can still offer a verdict via the explicit boundary convention", () => {
    const brief = deriveEndedRoomBrief(room(), [
      entry({
        parts: [{ text: "debate text\n\n---\n\n## Two observations\n\nThe pair composes." }],
      }),
    ]);
    expect(brief.outcomeTitle).toBe("Two observations");
  });

  test("counts DISTINCT pinned-decision questions across the whole transcript", () => {
    const brief = deriveEndedRoomBrief(room(), [
      entry({ parts: [{ text: "**Q1 — Use bun. Pinned.**\n\nBecause speed." }] }),
      entry({
        messageId: "m2",
        turnIndex: 1,
        parts: [
          {
            text: "**Q1 — Use bun. Pinned.**\n\nRestated.\n\n**Q2 — Ship Friday. Pinned.**\n\nAgreed.",
          },
        ],
      }),
    ]);
    expect(brief.decisionCount).toBe(2);
  });
});

describe("briefingPulseSection", () => {
  const withVerdict: EndedRoomBrief = {
    room: room({ turnIndex: 9, turnBudget: 8, outcomeAt: "2026-01-01T01:00:00.000Z" }),
    transcript: [],
    outcomeTitle: "Ship it",
    decisionCount: 2,
  };

  test("one tile per nonzero delta fact, zero tiles skipped", () => {
    const pulse = briefingPulseSection([withVerdict], [lensBrief()]);
    expect(pulse?.kind).toBe("stats");
    const labels = pulse?.items.map((i) => i.label);
    expect(labels).toEqual(["room concluded", "turns spent", "decisions pinned", "lens changed"]);
    // The delta chip is the since-you-looked reading, on the countable events.
    expect(pulse?.items[0]?.delta).toEqual({ text: "+1", direction: "up", tone: "info" });
    expect(pulse?.items[1]?.value).toBe(9);
    expect(pulse?.items[1]?.sub).toBe("closing synthesis authored");
    expectValidBoard([pulse]);
  });

  test("no decisions and no lenses -> neither tile renders", () => {
    const pulse = briefingPulseSection([{ room: room(), transcript: [], decisionCount: 0 }], []);
    expect(pulse?.items.map((i) => i.label)).toEqual(["room concluded", "turns spent"]);
  });

  test("an exhibits-only lens delta is labelled as tabled, not changed", () => {
    const pulse = briefingPulseSection([], [lensBrief({ kind: "exhibit" })]);
    expect(pulse?.items[0]?.label).toBe("exhibit tabled");
  });

  test("an empty delta yields no section", () => {
    expect(briefingPulseSection([], [])).toBeUndefined();
  });
});

describe("briefingVerdictSection", () => {
  const transcript = [
    entry(),
    entry({ messageId: "m2", turnIndex: 1 }),
    entry({ messageId: "m3", turnIndex: 2, from: "bo" }),
  ];

  test("a verdict-bearing room's card leads with the room's own closing title", () => {
    const cards = briefingVerdictSection(
      [
        {
          room: room({ config: { moderator: "ada" } }),
          transcript,
          outcomeTitle: "Ship it behind a flag",
          decisionCount: 1,
          reading: "The room settled on a staged rollout.",
        },
      ],
      [],
      MINDS,
    );
    expect(cards?.kind).toBe("cards");
    const card = cards?.items[0];
    expect(card?.title).toBe("Ship it behind a flag");
    expect(card?.pill).toEqual({ label: "verdict", tone: "brand" });
    // The meta field keeps the room's name visible beneath the verdict title.
    expect(String(card?.fields?.[0]?.value)).toContain("Design Review");
    // The cast wears identity tones, never a bare hue.
    const cast = card?.fields?.find((f) => f.people);
    expect(cast?.people?.map((p) => p.name)).toEqual(["Ada", "Bo"]);
    expect(cast?.people?.[0]?.tone).toBe("id-blue");
    // Who carried it: speakerCounts as identity-toned share segments.
    expect(card?.bar).toEqual({
      segments: [
        { label: "Ada", n: 2, tone: "id-blue" },
        { label: "Bo", n: 1, tone: "id-amber" },
      ],
    });
    expect(card?.footnote).toBe("The room settled on a staged rollout.");
    expectValidBoard([cards]);
  });

  test("a room without a verdict keeps its name as the title and a status pill", () => {
    const cards = briefingVerdictSection(
      [{ room: room({ status: "stopped" }), transcript: [], decisionCount: 0 }],
      [],
      MINDS,
    );
    const card = cards?.items[0];
    expect(card?.title).toBe("Design Review");
    expect(card?.pill).toEqual({ label: "stopped", tone: "neutral" });
    // No transcript -> no share bar rather than an empty one.
    expect(card?.bar).toBeUndefined();
    expectValidBoard([cards]);
  });

  test("a changed lens renders as a provenance card with its reading", () => {
    const cards = briefingVerdictSection(
      [],
      [
        lensBrief({
          kind: "exhibit",
          scope: "status board",
          sourceRoom: "room-1",
          reading: "The risks now name the rollout gap.",
        }),
      ],
      MINDS,
    );
    const card = cards?.items[0];
    expect(card?.title).toBe("Release Risks");
    expect(card?.pill).toEqual({ label: "exhibit", tone: "accent" });
    expect(card?.fields).toEqual([
      { label: "scope", value: "status board" },
      { label: "from room", value: "room-1" },
    ]);
    expect(card?.footnote).toBe("The risks now name the rollout gap.");
    expectValidBoard([cards]);
  });
});

describe("briefingJourneySection", () => {
  test("a verdict-bearing room walks Convened to Verdict", () => {
    const journey = briefingJourneySection({
      room: room({ turnIndex: 11, outcomeAt: "2026-01-01T01:00:00.000Z" }),
      transcript: [],
      outcomeTitle: "Ship it behind a flag",
      decisionCount: 2,
    });
    expect(journey?.kind).toBe("journey");
    expect(journey?.items.map((i) => i.title)).toEqual([
      "Convened",
      "Debated",
      "Pinned",
      "Synthesized",
      "Verdict",
    ]);
    expect(journey?.items.at(-1)?.text).toBe("Ship it behind a flag");
    expectValidBoard([journey]);
  });

  test("a journey needs an ending — no verdict, no section", () => {
    expect(
      briefingJourneySection({ room: room(), transcript: [], decisionCount: 3 }),
    ).toBeUndefined();
  });
});

describe("briefingPeople", () => {
  test("dedupes casts across rooms and resolves lens maintainers to seated Minds", () => {
    const people = briefingPeople(
      [
        { room: room(), transcript: [], decisionCount: 0 },
        { room: room({ slug: "room-2", participants: ["ada"] }), transcript: [], decisionCount: 0 },
      ],
      [
        lensBrief({ maintainingMind: "Bo" }),
        lensBrief({ id: "x", title: "X", maintainingMind: "nobody" }),
      ],
      MINDS,
    );
    expect(people).toEqual([
      { name: "Ada", tone: "id-blue" },
      { name: "Bo", tone: "id-amber" },
    ]);
  });
});

describe("buildDeltaRegister", () => {
  const brief: EndedRoomBrief = {
    room: room({ outcomeAt: "2026-01-01T01:00:00.000Z" }),
    transcript: [],
    outcomeTitle: "Ship it",
    decisionCount: 0,
  };

  test("assembles pulse, lead, cards, journey in attention order", () => {
    const sections = buildDeltaRegister([brief], [], MINDS, "The bench shipped a verdict.");
    expect(sections.map((s) => s.kind)).toEqual(["stats", "rows", "cards", "journey"]);
    expect(JSON.stringify(sections[1])).toContain("The bench shipped a verdict.");
    expectValidBoard(sections);
  });

  test("no lead -> no prose row; two rooms -> no journey", () => {
    const sections = buildDeltaRegister(
      [brief, { ...brief, room: room({ slug: "room-2" }) }],
      [],
      MINDS,
    );
    expect(sections.map((s) => s.kind)).toEqual(["stats", "cards"]);
  });
});
