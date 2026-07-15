import { describe, expect, test } from "bun:test";
import { buildRoomSummaryHtml } from "../../src/boards/room-summary.ts";
import { htmlLensStructuralError, htmlStringValidator } from "../../src/lens-html.ts";
import type { OutcomeSplit } from "../../src/room-text.ts";
import type { Mind, Room } from "../../src/types.ts";

const room: Room = {
  slug: "design-review",
  name: "Design review",
  strategy: "group-chat",
  participants: ["ada", "grace"],
  status: "done",
  turnBudget: 8,
  turnIndex: 8,
  round: 3,
  topic: "Should we ship the new scheduler?",
  config: { moderator: "grace" },
  createdAt: "2026-07-14T00:00:00.000Z",
};

const minds: Mind[] = [
  { slug: "ada", name: "Ada", role: "architect", persona: "Precise" },
  { slug: "grace", name: "Grace", role: "reviewer", persona: "Skeptical" },
];

const outcome: OutcomeSplit = {
  title: "Ship behind a flag",
  body: "Enable the scheduler for internal projects first.\n\nReview telemetry after one week.",
};

describe("buildRoomSummaryHtml", () => {
  test("builds valid self-contained meeting minutes without actions", () => {
    const html = buildRoomSummaryHtml(
      room,
      outcome,
      minds,
      [{ question: 1, title: "Rollout boundary", gist: "The team disagreed on scope." }],
      [
        {
          id: "rollout-plan",
          board: { view: "board", title: "Rollout plan", sections: [] },
          updatedAt: "2026-07-14T00:00:00.000Z",
        },
      ],
    );

    expect(htmlStringValidator("summary")(html)).toBe(html);
    expect(htmlLensStructuralError(html)).toBeUndefined();
    expect(html).toContain("Ada");
    expect(html).toContain("Grace");
    expect(html).toContain("Rollout boundary");
    expect(html).toContain("Enable the scheduler");
    expect(html).toContain("Rollout plan");
    expect(html).not.toContain("data-action");
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/<(?:a|button|form)\b/i);
  });

  test.each([
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    '"><script>alert(1)</script>',
    '<a href="javascript:alert(1)">click</a>',
  ])("escapes hostile outcome markup: %s", (payload) => {
    const html = buildRoomSummaryHtml(room, { ...outcome, body: payload }, minds, [], []);

    expect(html).not.toContain(payload);
    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toMatch(/<img\b/i);
    expect(html).not.toMatch(/<a\b[^>]*href\s*=\s*["']?javascript:/i);
    expect(html).not.toMatch(/<[^>]+\sonerror\s*=/i);
    expect(html).toContain("&lt;");
  });
});
