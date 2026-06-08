import { describe, expect, test } from "bun:test";
import { CONTROL_ACTIONS, extractTrailingJsonObject, stripControlJson } from "../src/routing.ts";

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
