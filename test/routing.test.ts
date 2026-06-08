import { describe, expect, test } from "bun:test";
import {
  allHeardInCycle,
  CONTROL_ACTIONS,
  extractTrailingJsonObject,
  leastSpoken,
  parseModeratorDecision,
  speakerCounts,
  stripControlJson,
} from "../src/routing.ts";
import type { TurnEntry } from "../src/types.ts";

const agentEntry = (from: string, over: Partial<TurnEntry> = {}): TurnEntry => ({
  messageId: "m",
  roomSlug: "r",
  turnIndex: 0,
  from,
  role: "agent",
  parts: [{ text: "hi" }],
  at: "2026-01-01T00:00:00.000Z",
  ...over,
});

describe("extractTrailingJsonObject (last balanced object)", () => {
  test("returns the last balanced object, skipping an earlier one", () => {
    expect(extractTrailingJsonObject('example {"a":1} then {"b":2}')).toBe('{"b":2}');
  });

  test("returns the only object when there is one", () => {
    expect(extractTrailingJsonObject('prose {"a":1}')).toBe('{"a":1}');
  });

  test("is string-aware — a brace inside a JSON string does not miscount", () => {
    expect(extractTrailingJsonObject('{"text":"a } b"}')).toBe('{"text":"a } b"}');
  });

  test("skips an earlier UNBALANCED brace in prose and finds the real object", () => {
    // a lone "{" (emoticon, set notation, stray brace) must not blind the scan
    expect(extractTrailingJsonObject('over to you :{\n{"action":"nominate","slug":"bob"}')).toBe(
      '{"action":"nominate","slug":"bob"}',
    );
    expect(extractTrailingJsonObject('{ {"action":"end"}')).toBe('{"action":"end"}');
  });

  test("returns null when there is no balanced object", () => {
    expect(extractTrailingJsonObject("just prose")).toBeNull();
    expect(extractTrailingJsonObject('unbalanced {"a":1')).toBeNull();
  });
});

describe("stripControlJson", () => {
  test("strips a trailing control tail and trims", () => {
    expect(stripControlJson('I nominate Bob.\n{"action":"nominate","slug":"bob"}')).toBe(
      "I nominate Bob.",
    );
  });

  test("strips a trailing close tail", () => {
    expect(stripControlJson('We are done.\n{"action":"close"}')).toBe("We are done.");
  });

  test("strips the real tail even when an earlier unbalanced brace precedes it", () => {
    expect(stripControlJson('hand off :{\n{"action":"nominate","slug":"x"}')).toBe("hand off :{");
  });

  test("leaves a control object that is NOT trailing (inline code example)", () => {
    const text = 'Reply with {"action":"nominate","slug":"x"} when you want to hand off.';
    expect(stripControlJson(text)).toBe(text);
  });

  test("leaves a trailing object whose action is not a control action", () => {
    const text = 'Here is data.\n{"action":"chat","note":"hi"}';
    expect(stripControlJson(text)).toBe(text);
  });

  test("leaves prose with no JSON untouched", () => {
    expect(stripControlJson("just talking, no json")).toBe("just talking, no json");
  });

  test("honours a custom action set", () => {
    const text = 'done\n{"action":"close"}';
    expect(stripControlJson(text, new Set(["nominate"]))).toBe(text); // close not in the set
  });
});

describe("CONTROL_ACTIONS", () => {
  test("covers both speaker and moderator directives", () => {
    for (const a of ["nominate", "pass", "end", "direct", "close"]) {
      expect(CONTROL_ACTIONS.has(a)).toBe(true);
    }
  });
});

describe("parseModeratorDecision (trailing object — same tail the stripper removes)", () => {
  test("parses a trailing direct decision after prose", () => {
    expect(
      parseModeratorDecision(
        'Bob raised a good point.\n{"action":"direct","next_speaker":"bob","direction":"go deeper"}',
      ),
    ).toEqual({ action: "direct", nextSpeaker: "bob", direction: "go deeper" });
  });

  test("only a recognized moderator action ('direct'/'close') routes; everything else is null", () => {
    // A non-vocabulary action, a missing action, or a bare/incidental object is
    // NOT a directive — stripControlJson would leave it, so the parser must too.
    expect(parseModeratorDecision('{"action":"route","next_speaker":"a"}')).toBeNull();
    expect(parseModeratorDecision('{"next_speaker":"a"}')).toBeNull();
    expect(parseModeratorDecision('{"action":"closing"}')).toBeNull();
    expect(parseModeratorDecision("here is my plan {}")).toBeNull();
    expect(parseModeratorDecision('{"note":"x"}')).toBeNull();
  });

  test("a recognized object that is NOT the trailing tail does not route (matches the stripper)", () => {
    // JSON mid-prose or followed by text: stripControlJson would leave it, so the
    // parser must not act on it (else it routes/closes on incidental text and the
    // JSON leaks into later prompt history).
    const followed = '{"action":"close"} — and here is my reasoning afterward';
    expect(parseModeratorDecision(followed)).toBeNull();
    expect(stripControlJson(followed)).toBe(followed); // stripper agrees: left intact
    expect(
      parseModeratorDecision('{"action":"direct","next_speaker":"a"} then more prose'),
    ).toBeNull();
  });

  test("'close' survives only when exactly 'close'", () => {
    expect(parseModeratorDecision('{"action":"close"}')).toEqual({ action: "close" });
  });

  test("tolerates camelCase nextSpeaker, trims, and drops empty/whitespace fields", () => {
    expect(parseModeratorDecision('{"action":"direct","nextSpeaker":"al"}')).toEqual({
      action: "direct",
      nextSpeaker: "al",
    });
    expect(
      parseModeratorDecision('{"action":"direct","next_speaker":" a ","direction":" go "}'),
    ).toEqual({
      action: "direct",
      nextSpeaker: "a",
      direction: "go",
    });
    expect(
      parseModeratorDecision('{"action":"direct","next_speaker":"  ","direction":"  "}'),
    ).toEqual({
      action: "direct",
    });
  });

  test("returns null for no object or malformed JSON", () => {
    expect(parseModeratorDecision("just prose, no decision")).toBeNull();
    expect(parseModeratorDecision('trailing {"action":"direct"')).toBeNull();
  });

  test("the parsed tail is exactly what stripControlJson removes (no route-but-don't-strip gap)", () => {
    const text = 'I will let Alice continue.\n{"action":"direct","next_speaker":"alice"}';
    expect(parseModeratorDecision(text)?.nextSpeaker).toBe("alice");
    expect(stripControlJson(text)).toBe("I will let Alice continue.");
  });
});

describe("speakerCounts / leastSpoken / nextUnheard / allHeardInCycle (global folds)", () => {
  const transcript: TurnEntry[] = [
    agentEntry("a"),
    agentEntry("b"),
    agentEntry("a"),
    agentEntry("mod"), // a moderator turn — under its own slug, excluded from a participant gate
    { ...agentEntry("director"), from: "director", role: "director" }, // not an agent turn
  ];

  test("speakerCounts folds agent turns by author, ignoring non-agent roles", () => {
    const counts = speakerCounts(transcript);
    expect(counts.get("a")).toBe(2);
    expect(counts.get("b")).toBe(1);
    expect(counts.get("mod")).toBe(1);
    expect(counts.get("director")).toBeUndefined();
  });

  test("leastSpoken is the first minimum, stable by participant order", () => {
    const counts = speakerCounts(transcript);
    expect(leastSpoken(["a", "b"], counts)).toBe("b");
    expect(leastSpoken(["a", "b", "c"], counts)).toBe("c"); // c=0 wins
    // It prefers an unheard participant (count 0 is the minimum) yet rotates once
    // all have spoken — so it doubles as the routing fallback (no monopoly).
    expect(leastSpoken([], counts)).toBeUndefined();
  });

  test("allHeardInCycle is the participation floor (excludes the moderator slug)", () => {
    const counts = speakerCounts(transcript);
    expect(allHeardInCycle(["a", "b"], counts, 1)).toBe(true);
    expect(allHeardInCycle(["a", "b"], counts, 2)).toBe(false); // b spoke once
    expect(allHeardInCycle(["a", "b", "c"], counts, 1)).toBe(false); // c unheard
    expect(allHeardInCycle([], counts, 1)).toBe(false);
  });
});
