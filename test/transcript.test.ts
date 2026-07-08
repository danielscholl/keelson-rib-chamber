import { describe, expect, test } from "bun:test";
import {
  buildManagerPrompt,
  buildModeratorPrompt,
  buildOpenFloorPrompt,
  buildReviewPrompt,
  buildSynthesisPrompt,
  buildTurnEntry,
  buildTurnPrompt,
  buildWorkerPrompt,
  renderTranscript,
  TRANSCRIPT_WINDOW_TURNS,
} from "../src/transcript.ts";
import type { TaskLedger, TurnEntry } from "../src/types.ts";

const entry = (over: Partial<TurnEntry> = {}): TurnEntry => ({
  messageId: "m",
  roomSlug: "r",
  turnIndex: 0,
  from: "a",
  role: "agent",
  parts: [{ text: "hi" }],
  at: "t",
  ...over,
});

describe("renderTranscript", () => {
  test("renders oldest->newest as from: text blocks", () => {
    const transcript = [
      entry({ from: "a", parts: [{ text: "hi" }] }),
      entry({ from: "b", parts: [{ text: "yo" }] }),
    ];
    expect(renderTranscript(transcript)).toBe("a: hi\n\nb: yo");
  });

  test("empty transcript renders empty string", () => {
    expect(renderTranscript([])).toBe("");
  });

  test("strips a trailing control directive from rendered history", () => {
    const rendered = renderTranscript([
      entry({
        from: "amy",
        parts: [{ text: 'Bob, your turn.\n{"action":"nominate","slug":"bob"}' }],
      }),
    ]);
    expect(rendered).toBe("amy: Bob, your turn.");
    expect(rendered).not.toContain("{");
  });

  test("does not mutate the raw entry text when rendering", () => {
    const raw = 'done\n{"action":"close"}';
    const e = entry({ from: "mod", parts: [{ text: raw }] });
    renderTranscript([e]);
    expect(e.parts[0]?.text).toBe(raw);
  });

  test("leaves an inline JSON example in prose intact", () => {
    const text = 'emit {"action":"nominate","slug":"x"} to hand off, but I will continue';
    expect(renderTranscript([entry({ from: "a", parts: [{ text }] })])).toBe(`a: ${text}`);
  });
});

describe("renderTranscript windowing", () => {
  // Zero-padded labels so substring assertions are unambiguous ("turn 004" never
  // matches "turn 040").
  const turns = (n: number): TurnEntry[] =>
    Array.from({ length: n }, (_, i) =>
      entry({ from: "a", parts: [{ text: `turn ${String(i).padStart(3, "0")}` }] }),
    );

  test("at the window size renders every turn with no elision marker", () => {
    const rendered = renderTranscript(turns(TRANSCRIPT_WINDOW_TURNS));
    expect(rendered).not.toContain("omitted");
    expect(rendered).toContain("turn 000");
    expect(rendered).toContain(`turn ${String(TRANSCRIPT_WINDOW_TURNS - 1).padStart(3, "0")}`);
  });

  test("over the window keeps only the last N turns behind an elision marker", () => {
    const total = TRANSCRIPT_WINDOW_TURNS + 5;
    const rendered = renderTranscript(turns(total));
    expect(rendered.startsWith("…(5 earlier turns omitted)")).toBe(true);
    // turns 000..004 dropped; the window opens at turn 005.
    expect(rendered).not.toContain("turn 000");
    expect(rendered).not.toContain("turn 004");
    expect(rendered).toContain("turn 005");
    expect(rendered).toContain(`turn ${String(total - 1).padStart(3, "0")}`);
  });

  test("the elision marker reports the omitted count (singular and plural)", () => {
    expect(
      renderTranscript(turns(TRANSCRIPT_WINDOW_TURNS + 1)).startsWith("…(1 earlier turn omitted)"),
    ).toBe(true);
    expect(
      renderTranscript(turns(TRANSCRIPT_WINDOW_TURNS + 3)).startsWith("…(3 earlier turns omitted)"),
    ).toBe(true);
  });

  test("still strips a control tail from a turn inside the window", () => {
    const transcript = [
      ...turns(TRANSCRIPT_WINDOW_TURNS),
      entry({
        from: "amy",
        parts: [{ text: 'Bob, your turn.\n{"action":"nominate","slug":"bob"}' }],
      }),
    ];
    const rendered = renderTranscript(transcript);
    expect(rendered).toContain("amy: Bob, your turn.");
    expect(rendered).not.toContain("{");
  });

  test("buildTurnPrompt keeps the topic and shows the marker when history exceeds the window", () => {
    const p = buildTurnPrompt({ topic: "Roadmap", transcript: turns(TRANSCRIPT_WINDOW_TURNS + 2) });
    expect(p.startsWith("Room topic: Roadmap")).toBe(true);
    expect(p).toContain("…(2 earlier turns omitted)");
    expect(p).toContain(`turn ${String(TRANSCRIPT_WINDOW_TURNS + 1).padStart(3, "0")}`);
  });
});

describe("buildTurnPrompt project context", () => {
  test("renders the project context between the topic and the conversation", () => {
    const p = buildTurnPrompt({
      topic: "How could this be better?",
      projectContext: 'This room is about the project "keelson-sample" (/repo).',
      transcript: [entry({ from: "amy", parts: [{ text: "opening" }] })],
    });
    const topicAt = p.indexOf("Room topic:");
    const projAt = p.indexOf("This room is about the project");
    const convoAt = p.indexOf("Conversation so far:");
    expect(topicAt).toBeGreaterThanOrEqual(0);
    expect(projAt).toBeGreaterThan(topicAt);
    expect(convoAt).toBeGreaterThan(projAt);
  });

  test("omits the project context when not provided (a non-project room is unchanged)", () => {
    const p = buildTurnPrompt({ topic: "T", transcript: [] });
    expect(p).not.toContain("This room is about the project");
  });
});

describe("buildModeratorPrompt", () => {
  test("non-empty with no topic/transcript; lists participants and the control vocabulary", () => {
    const p = buildModeratorPrompt({ transcript: [], participants: ["a", "b"] });
    expect(p.trim().length).toBeGreaterThan(0);
    expect(p).toContain("a, b");
    expect(p).toContain('"action":"direct"');
    expect(p).toContain('"action":"close"');
  });

  test("carries the topic and the stripped discussion so far", () => {
    const p = buildModeratorPrompt({
      topic: "Ship strategies?",
      transcript: [entry({ from: "a", parts: [{ text: "I think yes" }] })],
      participants: ["a", "b"],
    });
    expect(p).toContain("Room topic: Ship strategies?");
    expect(p).toContain("a: I think yes");
  });
});

describe("buildOpenFloorPrompt", () => {
  test("non-empty with no topic/transcript; lists participants and the nominate vocabulary", () => {
    const p = buildOpenFloorPrompt({ transcript: [], participants: ["a", "b"] });
    expect(p.trim().length).toBeGreaterThan(0);
    expect(p).toContain("a, b");
    expect(p).toContain('"action":"nominate"');
    expect(p).toContain('"action":"pass"');
    expect(p).toContain('"action":"end"');
  });

  test("carries the topic and the stripped discussion so far", () => {
    const p = buildOpenFloorPrompt({
      topic: "Ship it?",
      transcript: [entry({ from: "a", parts: [{ text: 'yes\n{"action":"end"}' }] })],
      participants: ["a", "b"],
    });
    expect(p).toContain("Room topic: Ship it?");
    expect(p).toContain("a: yes"); // the end-vote tail is stripped from rendered history
  });
});

describe("buildSynthesisPrompt", () => {
  test("non-empty even with an empty transcript and forbids routing JSON", () => {
    const p = buildSynthesisPrompt({ transcript: [] });
    expect(p.trim().length).toBeGreaterThan(0);
    expect(p.toLowerCase()).toContain("synthesize");
  });

  test("includes the topic and history when present", () => {
    const p = buildSynthesisPrompt({
      topic: "T",
      transcript: [entry({ from: "a", parts: [{ text: "point" }] })],
    });
    expect(p).toContain("Room topic: T");
    expect(p).toContain("a: point");
  });
});

describe("buildReviewPrompt", () => {
  test("carries the contract, the attributed artifact, and the review instruction", () => {
    const p = buildReviewPrompt({
      contract: "Ship a parser",
      artifact: "here is my parser",
      author: "scribe",
    });
    expect(p).toContain("Ship a parser");
    expect(p).toContain("here is my parser");
    expect(p).toContain("from scribe");
    expect(p.toLowerCase()).toContain("review");
    expect(p.toLowerCase()).toContain("different vendor");
  });

  test("is artifact-only — never renders the windowed transcript framing", () => {
    const p = buildReviewPrompt({ contract: "c", artifact: "the artifact" });
    expect(p).not.toContain("Conversation so far");
  });

  test("is non-empty with no contract and an empty artifact", () => {
    const p = buildReviewPrompt({ artifact: "" });
    expect(p.trim().length).toBeGreaterThan(0);
    expect(p).toContain("no artifact to review");
  });

  test("omits the contract line when none is given", () => {
    const p = buildReviewPrompt({ artifact: "x" });
    expect(p).not.toContain("Contract / acceptance criteria");
  });

  test("coding mode sends the reviewer to the repo and reframes the artifact as a summary", () => {
    const p = buildReviewPrompt({
      contract: "Add a parser",
      artifact: "I added parser.ts",
      author: "scribe",
      coding: true,
    });
    // The author's text is context (a summary), not the deliverable to grade.
    expect(p).toContain("The author's summary of the change from scribe");
    expect(p).not.toContain("Artifact to review");
    // The reviewer is pointed at the files, not the prose.
    expect(p).toContain("read the files they changed");
    expect(p).not.toContain("Review ONLY the artifact above");
    // The cross-vendor framing is preserved.
    expect(p.toLowerCase()).toContain("different vendor");
  });

  test("coding mode with no summary still points the reviewer at the repository", () => {
    const p = buildReviewPrompt({ artifact: "", coding: true });
    expect(p).toContain("inspect the repository for the change");
    expect(p).toContain("read the files they changed");
  });
});

describe("buildTurnEntry", () => {
  test("stamps the provided fields and wraps text in parts", () => {
    expect(
      buildTurnEntry({
        roomSlug: "r",
        turnIndex: 3,
        from: "a",
        role: "agent",
        text: "x",
        messageId: "m",
        at: "t",
      }),
    ).toEqual({
      messageId: "m",
      roomSlug: "r",
      turnIndex: 3,
      from: "a",
      role: "agent",
      parts: [{ text: "x" }],
      at: "t",
    });
  });

  test("includes aborted/round only when set", () => {
    const e = buildTurnEntry({
      roomSlug: "r",
      turnIndex: 0,
      from: "a",
      role: "agent",
      text: "",
      messageId: "m",
      at: "t",
      aborted: true,
      round: 2,
    });
    expect(e.aborted).toBe(true);
    expect(e.round).toBe(2);
  });
});

describe("buildManagerPrompt", () => {
  test("non-empty; lists workers and the plan/done vocabulary, empty plan reads as such", () => {
    const p = buildManagerPrompt({ transcript: [], workers: ["alice", "bob"] });
    expect(p.trim().length).toBeGreaterThan(0);
    expect(p).toContain("alice, bob");
    expect(p).toContain('"action":"plan"');
    expect(p).toContain('"action":"done"');
    expect(p).toContain("No tasks planned yet");
  });

  test("carries the goal, the ledger tasks with status, and the stripped progress", () => {
    const ledger: TaskLedger = {
      roomSlug: "r",
      goal: "ship it",
      manager: "mgr",
      status: "executing",
      tasks: [
        {
          id: "t1",
          description: "build parser",
          assignee: "alice",
          status: "completed",
          result: "done",
          createdAt: "t",
          updatedAt: "t",
        },
      ],
      updatedAt: "t",
    };
    const p = buildManagerPrompt({
      topic: "ship it",
      ledger,
      transcript: [entry({ from: "alice", parts: [{ text: "built it" }] })],
      workers: ["alice", "bob"],
    });
    expect(p).toContain("Goal: ship it");
    expect(p).toContain("[completed] build parser (alice)");
    expect(p).toContain("alice: built it");
  });
});

describe("buildWorkerPrompt", () => {
  test("carries the assigned task and forbids routing JSON", () => {
    const p = buildWorkerPrompt({ task: "wire the api", transcript: [] });
    expect(p.trim().length).toBeGreaterThan(0);
    expect(p).toContain("wire the api");
    expect(p.toLowerCase()).toContain("do not emit any routing json");
  });

  test("coding mode points the worker at the repo; plain mode does not", () => {
    const plain = buildWorkerPrompt({ task: "x", transcript: [] });
    const coding = buildWorkerPrompt({ task: "x", transcript: [], coding: true });
    expect(coding.toLowerCase()).toContain("repository at your working directory");
    expect(plain.toLowerCase()).not.toContain("repository at your working directory");
  });
});
