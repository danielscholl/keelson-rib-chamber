import { describe, expect, test } from "bun:test";
import { buildTurnEntry, renderTranscript } from "../src/transcript.ts";
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
