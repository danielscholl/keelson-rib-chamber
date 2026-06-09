import { describe, expect, test } from "bun:test";
import {
  buildModeratorPrompt,
  buildOpenFloorPrompt,
  buildSynthesisPrompt,
  buildTurnEntry,
  renderTranscript,
} from "../src/transcript.ts";
import type { TurnEntry } from "../src/types.ts";

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
