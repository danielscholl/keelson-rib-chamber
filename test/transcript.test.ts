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
