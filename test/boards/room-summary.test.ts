import { describe, expect, test } from "bun:test";
import { buildRoomSummaryHtml, type RoomSummaryInput } from "../../src/boards/room-summary.ts";
import { htmlLensStructuralError, htmlStringValidator } from "../../src/lens-html.ts";
import type { OutcomeSplit } from "../../src/room-text.ts";
import type { Mind, Room, TurnEntry } from "../../src/types.ts";

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
  { slug: "ada", name: "Ada", role: "architect", persona: "Precise", identitySlot: 0 },
  { slug: "grace", name: "Grace", role: "reviewer", persona: "Skeptical", identitySlot: 1 },
];

const outcome: OutcomeSplit = {
  title: "Ship behind a flag",
  body: "Enable the scheduler for internal projects first.\n\nReview telemetry after one week.",
};

function turn(from: string, index: number): TurnEntry {
  return {
    messageId: `m${index}`,
    roomSlug: room.slug,
    turnIndex: index,
    from,
    role: "agent",
    parts: [{ text: "…" }],
    at: "2026-07-14T00:05:00.000Z",
  };
}

function build(over: Partial<RoomSummaryInput> = {}): string {
  return buildRoomSummaryHtml({
    room,
    outcome,
    minds,
    decisions: [],
    tabled: [],
    transcript: [],
    ...over,
  });
}

describe("buildRoomSummaryHtml", () => {
  test("builds valid self-contained meeting minutes without actions", () => {
    const html = build({
      decisions: [{ question: 1, title: "Rollout boundary", gist: "The team disagreed on scope." }],
      tabled: [
        {
          id: "rollout-plan",
          board: { view: "board", title: "Rollout plan", sections: [] },
          updatedAt: "2026-07-14T00:00:00.000Z",
        },
      ],
    });

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
    const html = build({
      outcome: {
        title: "Closing summary",
        body: "The unresolved disagreement is whether to ship.",
      },
    });
    expect(html).not.toContain("Where they disagreed");
    expect(html).not.toContain("No disagreement markers were recorded");
    expect(html).toContain("The unresolved disagreement is whether to ship.");
  });

  test("keeps the disagreement panel when the room actually pinned decisions", () => {
    const html = build({
      decisions: [{ question: 1, title: "Rollout boundary", gist: "The team disagreed on scope." }],
    });
    expect(html).toContain("Where they disagreed");
    expect(html).toContain("Rollout boundary");
  });

  test("the closing document is printed exactly once", () => {
    const body = "Agreement: ship it. Recommendation: behind a flag.";
    const html = build({ outcome: { title: "Ship it", body } });
    expect(html).toContain(body);
    expect(html.split(body).length - 1).toBe(1);
  });

  test("a compliant grounded close does not relabel its criteria section", () => {
    const html = build({
      outcome: {
        title: "Ship it",
        body: "## Ship behind a flag\n\nAgreement is clear.\n\n### Acceptance criteria\n- Met: it ships.",
      },
    });
    expect(html).not.toContain("Open items / next move");
  });

  // The page exists to be read INSTEAD of the transcript, so the close renders as document
  // structure — headings, lists, emphasis — not as one pre-wrapped block of grey.
  test("renders the document as structure, never literal markdown syntax", () => {
    const html = build({
      outcome: {
        title: "Ship it",
        body: "### Acceptance criteria\n- **Met:** it ships in `prod`.",
      },
    });
    expect(html).not.toContain("### Acceptance criteria");
    expect(html).not.toContain("**Met:**");
    expect(html).toContain("<h3>Acceptance criteria</h3>");
    expect(html).toContain("<li><strong>Met:</strong> it ships in <code>prod</code>.</li>");
  });

  test("numbered steps keep their ordering, and a rule breaks the document", () => {
    const html = build({
      outcome: { title: "Ship it", body: "1. Land the flag\n2. Watch telemetry\n\n---\n\nDone." },
    });
    expect(html).toContain("<ol><li>Land the flag</li><li>Watch telemetry</li></ol>");
    expect(html).toContain("<hr>");
  });

  // A glob or a multiplication sign is not emphasis — the page reads prose the same way
  // room-text's own inline stripper does, so asterisks survive where they are literal.
  test("leaves a literal asterisk alone instead of eating it as emphasis", () => {
    const html = build({
      outcome: { title: "Ship it", body: "Rename *.ts and scale 2 * 3 pods." },
    });
    expect(html).toContain("Rename *.ts and scale 2 * 3 pods.");
    expect(html).not.toContain("<em>");
  });

  test("sizes the room from its own record and transcript", () => {
    const html = build({
      transcript: [turn("ada", 0), turn("ada", 1), turn("grace", 2), turn("grace", 3)],
    });
    // Two of four agent turns each: an equal share, direct-labelled with the count.
    expect(html).toContain("2 turns");
    expect(html).toContain("width: 50%");
    expect(html).toContain('>8</span><span class="tile-label">turns<');
    expect(html).toContain('>2</span><span class="tile-label">speakers<');
  });

  // A room with no turns recorded has no share to draw, so its speakers carry no track —
  // the room board's own rule, rather than a row of empty meters reading as zero.
  test("draws no share track before the room has taken a turn", () => {
    expect(build()).not.toContain('class="track"');
  });

  // A speaker wears the hue its seat wears everywhere else — except a facilitator, which
  // wears the accent on every surface. A Mind with no slot folds to the muted ink rather
  // than being assigned an invented one.
  test("tones each speaker by its host identity slot", () => {
    const html = build({ room: { ...room, config: {} } });
    expect(html).toContain("var(--id-blue)");
    expect(html).toContain("var(--id-amber)");
    // Grace moderates in the base room, so she wears the facilitator accent, not her slot.
    expect(build()).not.toContain("var(--id-amber)");
    const unslotted = build({
      room: { ...room, config: {} },
      minds: [{ slug: "ada", name: "Ada", role: "architect", persona: "" }],
    });
    expect(unslotted).toContain("var(--muted)");
  });

  test("a room that tabled nothing says so rather than dropping the section", () => {
    const html = build();
    expect(html).toContain("What it produced");
    expect(html).toContain("Nothing was tabled");
  });

  test("closes with provenance naming the room and denying a paid turn", () => {
    const html = build();
    expect(html).toContain("design-review");
    expect(html).toContain("budget 8/8");
    expect(html).toContain("no agent turn composed this page");
  });

  // The page has no schema cap, so the close renders whole rather than ending in
  // flattenMarkdown's own "— continues —" note.
  test("a very long close renders whole, never truncated into a footer", () => {
    const body = `We agreed on the gate.\n\n${"word ".repeat(30_000)}\n\nNext: land the flag.`;
    const html = build({ outcome: { title: "Ship it", body } });
    expect(html).not.toContain("continues");
    expect(html).not.toContain("full text");
    expect(html).toContain("Next: land the flag.");
  });

  test.each([
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    '"><script>alert(1)</script>',
    '<a href="javascript:alert(1)">click</a>',
    "# <img src=x onerror=alert(1)>",
    "- <script>alert(1)</script>",
    "**<script>alert(1)</script>**",
  ])("escapes hostile outcome markup: %s", (payload) => {
    const html = build({ outcome: { ...outcome, body: payload } });

    expect(html).not.toContain(payload);
    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toMatch(/<img\b/i);
    expect(html).not.toMatch(/<a\b[^>]*href\s*=\s*["']?javascript:/i);
    expect(html).not.toMatch(/<[^>]+\sonerror\s*=/i);
    expect(html).toContain("&lt;");
  });

  // A Mind's name is agent-authored, so it reaches the page as data like the document does.
  test.each(["Ada <script>alert(1)</script>", 'Ada" onload="alert(1)'])(
    "escapes a hostile speaker name: %s",
    (name) => {
      const html = build({ minds: [{ slug: "ada", name, role: "architect", persona: "" }] });
      expect(html).not.toContain(name);
      expect(html).not.toMatch(/<script\b/i);
      // The quote is escaped, so the payload stays inside the span's text instead of
      // closing an attribute and opening a handler.
      expect(html).not.toContain('" onload="');
      expect(html).toContain("&");
    },
  );
});
