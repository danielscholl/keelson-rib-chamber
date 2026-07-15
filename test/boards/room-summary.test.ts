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

  // A room that never adopted the marker convention has its disagreements in the document's
  // own prose. Answering "where did they disagree?" with a standing "none recorded" states a
  // negative nobody checked — next to a body that often names the disagreement outright.
  test("omits the disagreement panel rather than asserting there were none", () => {
    const html = buildRoomSummaryHtml(
      room,
      { title: "Closing summary", body: "The unresolved disagreement is whether to ship." },
      minds,
      [],
      [],
    );
    expect(html).not.toContain("Where they disagreed");
    expect(html).not.toContain("No disagreement markers were recorded");
    expect(html).toContain("The unresolved disagreement is whether to ship.");
  });

  test("keeps the disagreement panel when the room actually pinned decisions", () => {
    const html = buildRoomSummaryHtml(
      room,
      outcome,
      minds,
      [{ question: 1, title: "Rollout boundary", gist: "The team disagreed on scope." }],
      [],
    );
    expect(html).toContain("Where they disagreed");
    expect(html).toContain("Rollout boundary");
  });

  test("a one-paragraph close is not printed twice under two headings", () => {
    const body = "Agreement: ship it. Recommendation: behind a flag.";
    const html = buildRoomSummaryHtml(room, { title: "Ship it", body }, minds, [], []);
    expect(html).toContain(body);
    expect(html).not.toContain("Open items / next move");
    expect(html.split(body).length - 1).toBe(1);
  });

  test("a multi-paragraph close keeps its closing move as its own panel", () => {
    const html = buildRoomSummaryHtml(
      room,
      { title: "Ship it", body: "We agreed on the gate.\n\nNext: land the flag by Friday." },
      minds,
      [],
      [],
    );
    expect(html).toContain("Open items / next move");
    expect(html).toContain("Next: land the flag by Friday.");
  });

  test("renders the document as readable text, never literal markdown syntax", () => {
    const html = buildRoomSummaryHtml(
      room,
      { title: "Ship it", body: "### Acceptance criteria\n- **Met:** it ships in `prod`." },
      minds,
      [],
      [],
    );
    expect(html).not.toContain("### Acceptance criteria");
    expect(html).not.toContain("**Met:**");
    expect(html).toContain("Acceptance criteria");
    expect(html).toContain("• Met: it ships in prod.");
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
