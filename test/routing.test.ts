import { describe, expect, test } from "bun:test";
import {
  CONTROL_ACTIONS,
  extractJsonObject,
  extractTrailingJsonObject,
  parseModeratorDecision,
  parseNomination,
  stripControlJson,
} from "../src/routing.ts";

describe("extractJsonObject (first balanced object)", () => {
  test("returns the first balanced object", () => {
    expect(extractJsonObject('before {"a":1} after')).toBe('{"a":1}');
  });

  test("is string-aware — a brace inside a string does not miscount", () => {
    expect(extractJsonObject('{"text":"a } b"}')).toBe('{"text":"a } b"}');
  });

  test("handles nested objects", () => {
    expect(extractJsonObject('x {"a":{"b":1}} y')).toBe('{"a":{"b":1}}');
  });

  test("returns null when there is no object", () => {
    expect(extractJsonObject("no json here")).toBeNull();
  });

  test("returns null on an unbalanced object", () => {
    expect(extractJsonObject('{"a":1')).toBeNull();
  });
});

describe("extractTrailingJsonObject (last balanced object)", () => {
  test("returns the last balanced object, skipping an earlier one", () => {
    expect(extractTrailingJsonObject('example {"a":1} then {"b":2}')).toBe('{"b":2}');
  });

  test("returns the only object when there is one", () => {
    expect(extractTrailingJsonObject('prose {"a":1}')).toBe('{"a":1}');
  });

  test("returns null when there is no object", () => {
    expect(extractTrailingJsonObject("just prose")).toBeNull();
  });
});

describe("stripControlJson", () => {
  test("strips a trailing control tail and trims", () => {
    expect(stripControlJson('I nominate Bob.\n{"action":"nominate","slug":"bob"}')).toBe(
      "I nominate Bob.",
    );
  });

  test("strips a trailing moderator close tail", () => {
    expect(stripControlJson('We are done.\n{"action":"close"}')).toBe("We are done.");
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

describe("parseModeratorDecision", () => {
  test("parses a direct decision with next_speaker + direction", () => {
    expect(
      parseModeratorDecision('{"action":"direct","next_speaker":"bob","direction":"push back"}'),
    ).toEqual({ action: "direct", nextSpeaker: "bob", direction: "push back" });
  });

  test("parses a close decision", () => {
    expect(parseModeratorDecision('reasoning… {"action":"close"}')).toEqual({ action: "close" });
  });

  test("collapses an unknown/missing action to direct", () => {
    expect(parseModeratorDecision('{"next_speaker":"amy"}')).toEqual({
      action: "direct",
      nextSpeaker: "amy",
    });
  });

  test("returns null on malformed input", () => {
    expect(parseModeratorDecision("no decision here")).toBeNull();
  });
});

describe("parseNomination", () => {
  test("parses a trailing nominate with slug + reason", () => {
    expect(
      parseNomination('Over to you.\n{"action":"nominate","slug":"amy","reason":"her call"}'),
    ).toEqual({ action: "nominate", slug: "amy", reason: "her call" });
  });

  test("parses pass and end without a slug", () => {
    expect(parseNomination('thinking…\n{"action":"pass"}')).toEqual({ action: "pass" });
    expect(parseNomination('we are done\n{"action":"end"}')).toEqual({ action: "end" });
  });

  test("nominate without a slug collapses to null", () => {
    expect(parseNomination('{"action":"nominate"}')).toBeNull();
  });

  test("a non-control action returns null", () => {
    expect(parseNomination('{"action":"chat"}')).toBeNull();
  });

  test("ignores a non-trailing (inline) control object", () => {
    expect(
      parseNomination('end with {"action":"end"} when finished, but I am not done'),
    ).toBeNull();
  });

  test("the trailing object wins over an earlier code example", () => {
    expect(
      parseNomination('e.g. {"action":"nominate","slug":"x"}\n{"action":"nominate","slug":"real"}'),
    ).toEqual({ action: "nominate", slug: "real" });
  });
});

describe("vocabulary unification (route ⇒ strip)", () => {
  test("a nomination tail parseNomination routes is fully removed by stripControlJson", () => {
    const text = 'Bob should go next.\n{"action":"nominate","slug":"bob"}';
    expect(parseNomination(text)?.slug).toBe("bob");
    expect(stripControlJson(text)).toBe("Bob should go next.");
    expect(stripControlJson(text)).not.toContain("{");
  });

  test("an inline JSON example is neither routed nor stripped", () => {
    const text = 'You can emit {"action":"nominate","slug":"x"} to hand off — I will keep going.';
    expect(parseNomination(text)).toBeNull();
    expect(stripControlJson(text)).toBe(text);
  });

  test("CONTROL_ACTIONS covers both speaker and moderator directives", () => {
    for (const a of ["nominate", "pass", "end", "direct", "close"]) {
      expect(CONTROL_ACTIONS.has(a)).toBe(true);
    }
  });
});
