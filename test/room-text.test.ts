import { describe, expect, test } from "bun:test";
import {
  clockTime,
  flattenMarkdown,
  formatDuration,
  formatTokenCount,
  outcomeReceipt,
  parseDecisionMarkers,
  parseOutcomeQuestions,
  splitOutcome,
  sumTurnUsage,
  topicContractTail,
  topicGist,
} from "../src/room-text.ts";

describe("clockTime", () => {
  test("formats an ISO timestamp as local HH:MM", () => {
    expect(clockTime("2026-07-05T17:28:20.888Z")).toMatch(/^\d{2}:\d{2}$/);
  });

  test("degrades to an em dash on an unparseable timestamp", () => {
    expect(clockTime("not-a-date")).toBe("—");
  });
});

describe("formatDuration", () => {
  test("floors to the largest whole unit", () => {
    expect(formatDuration("2026-07-05T17:26:00.000Z", "2026-07-05T17:32:00.000Z")).toBe("6 min");
    expect(formatDuration("2026-07-05T17:00:00.000Z", "2026-07-05T19:30:00.000Z")).toBe("2 hrs");
    expect(formatDuration("2026-07-05T00:00:00.000Z", "2026-07-07T00:00:00.000Z")).toBe("2 days");
  });

  test("sub-minute spans read as <1 min", () => {
    expect(formatDuration("2026-07-05T17:26:00.000Z", "2026-07-05T17:26:30.000Z")).toBe("<1 min");
  });

  test("undefined on an inverted or unparseable pair", () => {
    expect(formatDuration("2026-07-05T17:32:00.000Z", "2026-07-05T17:26:00.000Z")).toBeUndefined();
    expect(formatDuration("nope", "2026-07-05T17:26:00.000Z")).toBeUndefined();
  });
});

describe("formatTokenCount", () => {
  test("compacts to k above 1000", () => {
    expect(formatTokenCount(148_000)).toBe("148k");
    expect(formatTokenCount(950)).toBe("950");
    expect(formatTokenCount(0)).toBe("0");
  });

  test("degrades to 0 on a negative/non-finite input", () => {
    expect(formatTokenCount(Number.NaN)).toBe("0");
    expect(formatTokenCount(-5)).toBe("0");
  });
});

describe("sumTurnUsage", () => {
  test("sums whatever entries carry usage", () => {
    const sum = sumTurnUsage([
      { usage: { inputTokens: 100, outputTokens: 10 } },
      { usage: undefined },
      { usage: { inputTokens: 50, outputTokens: 5 } },
    ]);
    expect(sum).toEqual({ inputTokens: 150, outputTokens: 15 });
  });

  test("undefined when no entry carries usage", () => {
    expect(sumTurnUsage([{ usage: undefined }, {}])).toBeUndefined();
  });
});

describe("flattenMarkdown", () => {
  test("strips heading/bold/italic/code marks and folds bullets", () => {
    const text = "### Preconditions\n- **refuse**, don't *approximate*\n- run `git status`";
    expect(flattenMarkdown(text)).toBe(
      "Preconditions\n• refuse, don't approximate\n• run git status",
    );
  });

  test("never exceeds max, even after adding the continuation note", () => {
    const long = "word ".repeat(2000);
    const flattened = flattenMarkdown(long, 500);
    expect(flattened.length).toBeLessThanOrEqual(500);
    expect(flattened).toContain("continues");
  });

  test("passes short text through unchanged (module cap)", () => {
    expect(flattenMarkdown("plain text")).toBe("plain text");
  });

  test("never exceeds max even when the continuation note itself wouldn't fit", () => {
    const long = "word ".repeat(200);
    // The note text alone is ~45 chars — a max below that leaves no room for it.
    const flattened = flattenMarkdown(long, 20);
    expect(flattened.length).toBeLessThanOrEqual(20);
    expect(flattened).not.toContain("continues");
  });

  test("never mistakes a bare asterisk (arithmetic, a glob) for italic emphasis", () => {
    expect(flattenMarkdown("The throughput is 2 * 3 * 4 workers per shift.")).toBe(
      "The throughput is 2 * 3 * 4 workers per shift.",
    );
    expect(flattenMarkdown("Match every *.ts file.")).toBe("Match every *.ts file.");
    expect(flattenMarkdown("the *complete* set-membership oracle")).toBe(
      "the complete set-membership oracle",
    );
  });
});

describe("topicGist", () => {
  test("takes the first non-empty line, marks stripped", () => {
    expect(topicGist("\n\n**Design squad#144**: rollback for stopped runs.\n\nMore.")).toBe(
      "Design squad#144: rollback for stopped runs.",
    );
  });

  test("truncates a long first line", () => {
    const gist = topicGist(`a${"b".repeat(200)}`, 50);
    expect(gist.length).toBeLessThanOrEqual(50);
    expect(gist.endsWith("…")).toBe(true);
  });
});

describe("topicContractTail", () => {
  test("names decisions plus recognized contract vocabulary", () => {
    const topic = "...Acceptance criteria... test plan... out-of-scope...";
    expect(topicContractTail(topic, 6)).toBe(
      "produces 6 decisions · criteria · test plan · out-of-scope",
    );
  });

  test("undefined when nothing is detectable", () => {
    expect(topicContractTail("just a plain topic", 0)).toBeUndefined();
  });

  test("singular decision reads without a trailing s", () => {
    expect(topicContractTail("plain", 1)).toBe("produces 1 decision");
  });
});

describe("parseDecisionMarkers", () => {
  test("matches the room's own marker convention and skips a mere mention", () => {
    const text = [
      "**Q1 — Revert mechanics. Pinned proposal.**",
      "",
      "The whole thing hangs on one purist truth: baselineTree is the oracle. More prose follows.",
      "",
      "**Q2 flag — and it's a real one, not a courtesy.** My mechanics restore wholesale.",
      "",
      "**Q2 — Operator-work safety. Pinned.**",
      "",
      "Step 6 stays unconditional. A refusal gate that fires on a guess is theater.",
    ].join("\n");
    const markers = parseDecisionMarkers(text);
    expect(markers).toHaveLength(2);
    expect(markers[0]).toEqual({
      question: 1,
      title: "Revert mechanics",
      gist: "The whole thing hangs on one purist truth: baselineTree is the oracle.",
    });
    expect(markers[1]?.question).toBe(2);
    expect(markers[1]?.title).toBe("Operator-work safety");
  });

  test("empty on text with no markers", () => {
    expect(parseDecisionMarkers("just an ordinary turn")).toEqual([]);
  });

  test("back-to-back markers with no prose between them degrade to an empty gist, never bleeding into the next marker", () => {
    const text = [
      "**Q1 — Ship it. Pinned.**",
      "**Q2 — Timeline. Pinned.**",
      "**Q3 — Owner. Pinned.**",
    ].join("\n");
    const markers = parseDecisionMarkers(text);
    expect(markers.map((m) => m.gist)).toEqual(["", "", ""]);
    expect(markers.map((m) => m.question)).toEqual([1, 2, 3]);
  });
});

describe("splitOutcome", () => {
  const lastTurn = [
    "**Q4 — Worktree isolation. Pinned.**",
    "",
    "Successor lever, not built here.",
    "",
    "Six pinned. Handing the synthesis to the room.",
    "",
    "---",
    "",
    "## Pinned Design — #144 rollback for stopped/failed coordinator runs",
    "",
    "**Q1 — Revert mechanics.** Tree-membership against baselineTree is the oracle.",
    "",
    "**Q2 — Operator safety.** Step 6 unconditional.",
    "",
    "### Acceptance criteria (testable)",
    "- Rollback restores index+worktree to exactly baselineTree.",
    "- Pre-existing untracked files are never deleted.",
    "",
    "### Test plan (bun test + fake exec)",
    "- Fake exec shim records ordered commands.",
    "",
    "### Out-of-scope for #144",
    "Worktree-per-run substrate.",
  ].join("\n");

  test("splits at the --- / ## boundary, keeping the authored title", () => {
    const split = splitOutcome(lastTurn);
    expect(split.outcome?.title).toBe(
      "Pinned Design — #144 rollback for stopped/failed coordinator runs",
    );
    expect(split.debate).toContain("Six pinned. Handing the synthesis to the room.");
    expect(split.debate).not.toContain("Acceptance criteria");
    expect(split.outcome?.body).toContain("Acceptance criteria");
  });

  test("no outcome when there is no boundary", () => {
    const split = splitOutcome("just an ordinary closing turn, no document here.");
    expect(split.outcome).toBeUndefined();
    expect(split.debate).toBe("just an ordinary closing turn, no document here.");
  });

  test("parseOutcomeQuestions counts distinct restated questions", () => {
    const split = splitOutcome(lastTurn);
    expect(parseOutcomeQuestions(split.outcome?.body ?? "")).toEqual([1, 2]);
  });

  test("outcomeReceipt reads the document's own section headings", () => {
    const split = splitOutcome(lastTurn);
    const receipt = outcomeReceipt(split.outcome?.body ?? "");
    expect(receipt.decisions).toBe(2);
    expect(receipt.criteria).toBe(2);
    expect(receipt.hasTestPlan).toBe(true);
    expect(receipt.hasOutOfScope).toBe(true);
  });

  test("outcomeReceipt's negative branches: an absent section reads as absent, never inherited from a fully-populated fixture", () => {
    const sparse = "**Q1 — Ship it.** Done.";
    const receipt = outcomeReceipt(sparse);
    expect(receipt.criteria).toBeUndefined();
    expect(receipt.hasTestPlan).toBe(false);
    expect(receipt.hasOutOfScope).toBe(false);
  });

  test("a heading that negates its own label reads as absent, not present", () => {
    const body = [
      "**Q1 — Ship it.** Done.",
      "",
      "### No test plan needed for this decision",
      "",
      "### No acceptance criteria defined yet",
      "- placeholder",
      "- placeholder",
    ].join("\n");
    const receipt = outcomeReceipt(body);
    expect(receipt.hasTestPlan).toBe(false);
    expect(receipt.criteria).toBeUndefined();
  });

  test("finds the LAST --- / ## boundary, not the first, when the turn uses an earlier one for its own sub-heading", () => {
    const text = [
      "Some debate prose leading into an aside.",
      "",
      "---",
      "",
      "## Why not doubly so",
      "",
      "A mid-argument aside, not the real document.",
      "",
      "---",
      "",
      "## Pinned Design — the real synthesis",
      "",
      "The actual outcome content.",
    ].join("\n");
    const split = splitOutcome(text);
    expect(split.outcome?.title).toBe("Pinned Design — the real synthesis");
    expect(split.outcome?.body).toBe("The actual outcome content.");
    expect(split.debate).toContain("Why not doubly so");
  });
});
