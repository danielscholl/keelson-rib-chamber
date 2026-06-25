import { describe, expect, test } from "bun:test";
import {
  allHeardInCycle,
  CONTROL_ACTIONS,
  endVoteRatio,
  extractTrailingJsonObject,
  leastSpoken,
  parseMagenticPlan,
  parseModeratorDecision,
  parseNomination,
  roundOf,
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

describe("roundOf (completed all-heard cycles)", () => {
  // a=2, b=1, mod=1 (a non-participant slug), director not an agent turn.
  const transcript: TurnEntry[] = [
    agentEntry("a"),
    agentEntry("b"),
    agentEntry("a"),
    agentEntry("mod"),
  ];

  test("is the minimum agent-turn count across participants", () => {
    expect(roundOf(["a", "b"], transcript)).toBe(1); // min(2, 1)
    expect(roundOf(["a"], transcript)).toBe(2);
  });

  test("is 0 until everyone has spoken at least once", () => {
    expect(roundOf(["a", "b", "c"], transcript)).toBe(0); // c unheard
    expect(roundOf(["a", "b"], [agentEntry("a")])).toBe(0); // b unheard
  });

  test("ignores non-participant (moderator) turns and an empty roster/transcript", () => {
    expect(roundOf(["a", "b"], transcript)).toBe(1); // mod's turn doesn't lift it
    expect(roundOf([], transcript)).toBe(0);
    expect(roundOf(["a", "b"], [])).toBe(0);
  });
});

describe("parseNomination (trailing object — same tail the stripper removes)", () => {
  test("parses a trailing nominate after prose", () => {
    expect(
      parseNomination(
        'Alice, take it from here.\n{"action":"nominate","slug":"alice","reason":"data"}',
      ),
    ).toEqual({ action: "nominate", slug: "alice", reason: "data" });
  });

  test("parses pass and end (no slug needed)", () => {
    expect(parseNomination('I\'ll defer.\n{"action":"pass"}')).toEqual({ action: "pass" });
    expect(parseNomination('We\'ve converged.\n{"action":"end"}')).toEqual({ action: "end" });
  });

  test("nominate WITHOUT a slug is meaningless -> null", () => {
    expect(parseNomination('{"action":"nominate"}')).toBeNull();
    expect(parseNomination('{"action":"nominate","slug":"   "}')).toBeNull();
  });

  test("only the open-floor vocabulary routes; everything else is null", () => {
    expect(parseNomination('{"action":"direct","next_speaker":"a"}')).toBeNull(); // moderator action
    expect(parseNomination('{"action":"vote","slug":"a"}')).toBeNull();
    expect(parseNomination('{"slug":"a"}')).toBeNull();
    expect(parseNomination("here is my plan {}")).toBeNull();
  });

  test("a recognized object that is NOT the trailing tail does not route (matches the stripper)", () => {
    const followed = '{"action":"nominate","slug":"a"} — and here is why afterward';
    expect(parseNomination(followed)).toBeNull();
    expect(stripControlJson(followed)).toBe(followed); // stripper agrees: left intact
  });

  test("leaves an inline JSON example in prose alone (returns null)", () => {
    expect(
      parseNomination('Reply with {"action":"nominate","slug":"x"} to hand off, but I continue'),
    ).toBeNull();
  });

  test("trims slug/reason and returns null for no object or malformed JSON", () => {
    expect(parseNomination('{"action":"nominate","slug":" bob ","reason":" why "}')).toEqual({
      action: "nominate",
      slug: "bob",
      reason: "why",
    });
    expect(parseNomination("just prose, no directive")).toBeNull();
    expect(parseNomination('trailing {"action":"nominate"')).toBeNull();
  });

  test("the parsed nominate tail is exactly what stripControlJson removes (no leak)", () => {
    const text = 'Over to Bob.\n{"action":"nominate","slug":"bob"}';
    expect(parseNomination(text)?.slug).toBe("bob");
    expect(stripControlJson(text)).toBe("Over to Bob.");
  });
});

describe("endVoteRatio (current standing, not an accumulating tally)", () => {
  const endTail = '{"action":"end"}';
  const nomTail = (slug: string) => `{"action":"nominate","slug":"${slug}"}`;

  test("counts distinct participants whose latest turn votes end, over participant count", () => {
    const transcript: TurnEntry[] = [
      agentEntry("a", { parts: [{ text: `done\n${endTail}` }] }),
      agentEntry("b", { parts: [{ text: `done\n${endTail}` }] }),
    ];
    expect(endVoteRatio(transcript, ["a", "b"])).toBe(1);
  });

  test("a single end vote in a 2-Mind room is ratio 0.5 (caller applies strict >)", () => {
    const transcript: TurnEntry[] = [
      agentEntry("a", { parts: [{ text: `done\n${endTail}` }] }),
      agentEntry("b", { parts: [{ text: `more to say\n${nomTail("a")}` }] }),
    ];
    expect(endVoteRatio(transcript, ["a", "b"])).toBe(0.5);
  });

  test("vote-then-speak-again withdraws the vote (latest entry wins)", () => {
    const transcript: TurnEntry[] = [
      agentEntry("a", { parts: [{ text: `done\n${endTail}` }] }),
      agentEntry("a", { parts: [{ text: "actually one more thing" }] }),
    ];
    expect(endVoteRatio(transcript, ["a", "b"])).toBe(0);
  });

  test("ignores a non-participant author and an empty participant pool", () => {
    const transcript: TurnEntry[] = [
      agentEntry("ghost", { parts: [{ text: `done\n${endTail}` }] }),
      agentEntry("a", { parts: [{ text: `done\n${endTail}` }] }),
    ];
    expect(endVoteRatio(transcript, ["a", "b"])).toBe(0.5); // ghost not counted
    expect(endVoteRatio(transcript, [])).toBe(0);
  });
});

describe("CONTROL_ACTIONS covers the magentic vocabulary", () => {
  test("includes plan and done so the stripper removes a manager's trailing JSON", () => {
    expect(CONTROL_ACTIONS.has("plan")).toBe(true);
    expect(CONTROL_ACTIONS.has("done")).toBe(true);
    // The board / next-prompt history strips a manager's trailing plan tail.
    expect(
      stripControlJson('Here is the plan.\n{"action":"plan","tasks":[{"description":"x"}]}'),
    ).toBe("Here is the plan.");
  });
});

describe("parseMagenticPlan", () => {
  test("parses a plan with tasks and assignees from the trailing object", () => {
    const text =
      'I will split this up.\n{"action":"plan","tasks":[{"description":"build parser","assignee":"alice"},{"description":"wire api","assignee":"bob"}]}';
    expect(parseMagenticPlan(text)).toEqual({
      action: "plan",
      tasks: [
        { description: "build parser", assignee: "alice" },
        { description: "wire api", assignee: "bob" },
      ],
    });
  });

  test("parses a done directive with a summary", () => {
    expect(parseMagenticPlan('All shipped.\n{"action":"done","summary":"complete"}')).toEqual({
      action: "done",
      tasks: [],
      summary: "complete",
    });
  });

  test("drops a task with no description and trims whitespace", () => {
    const text = '{"action":"plan","tasks":[{"description":"  do it  "},{"assignee":"x"}]}';
    expect(parseMagenticPlan(text)).toEqual({ action: "plan", tasks: [{ description: "do it" }] });
  });

  test("tolerates worker/mind synonyms for the assignee key", () => {
    expect(
      parseMagenticPlan('{"action":"plan","tasks":[{"description":"a","worker":"bob"}]}'),
    ).toEqual({ action: "plan", tasks: [{ description: "a", assignee: "bob" }] });
  });

  test("returns null for a non-magentic trailing object or plain prose", () => {
    expect(parseMagenticPlan("just talking, no directive")).toBeNull();
    expect(parseMagenticPlan('routing\n{"action":"close"}')).toBeNull();
  });

  test("ignores a recognized object mid-prose (not a genuine tail)", () => {
    expect(parseMagenticPlan('{"action":"plan","tasks":[]} and then more prose')).toBeNull();
  });
});
