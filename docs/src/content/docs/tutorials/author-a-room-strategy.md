---
title: Author a room strategy
description: Write a new pure strategy, register it, and unit-test it, the capstone of the Chamber tutorial rail
sidebar:
  order: 7
---

You have run rooms, moderated one, put them to work on real plans, and let one
write code. Now you will write the part that decides who speaks. A **strategy**
is the turn policy for
a room: a small, pure function
the driver consults every turn to ask "who is next?" This is the capstone, and it
is the one tutorial where the code you touch is the rib's own. Chamber is a
Keelson rib, so its strategies
live in the rib's own source, and adding one is three edits and a test.

The good news is that a strategy is the easiest kind of code to write, because the
contract forbids almost everything. No I/O, no provider calls, no text parsing.
You read two or three values and return one of seven shapes. That is the whole job.

## The contract

A strategy is a pure function. Its type, exactly as the rib declares it:

```ts
export type Strategy = (input: StrategyInput) => StrategyStep;

export interface StrategyInput {
  room: Room;
  transcript: readonly TurnEntry[];
  ledger?: TaskLedger; // present only when the room runs the magentic strategy
}
```

You receive `{ room, transcript }`. If the room runs the magentic strategy, `ledger` (a `TaskLedger`) is also present; for every other strategy it is absent. You return one `StrategyStep`,
the decision union:

```ts
export type StrategyStep =
  | { kind: "speak"; mind: MindSlug }
  | { kind: "speak-parallel"; minds: readonly MindSlug[] }
  | { kind: "moderate"; mind: MindSlug }
  | { kind: "synthesize"; mind: MindSlug }
  | { kind: "manage"; mind: MindSlug }
  | { kind: "assign"; mind: MindSlug; taskId: string }
  | { kind: "end" };
```

- `speak` names one Mind to take the next turn.
- `speak-parallel` names a set of Minds to run as one parallel round.
- `moderate` hands control to a moderator Mind, which routes rather than debates.
- `synthesize` asks for a closing summary turn.
- `manage` hands control to the manager Mind to (re)plan the task ledger. Used by the magentic strategy; a non-magentic strategy need not return it.
- `assign` assigns a pending ledger task to the named worker Mind. Also magentic-specific.
- `end` closes the room. It carries no field.

One note on `synthesize`: five of the six shipped strategies (sequential,
concurrent, group-chat, open-floor, magentic) return it at budget exhaustion
through the `exhaustedSynthesis` helper, which asks a configured synthesizer or
the last speaker to write a closing summary. `review` is the lone exception,
because its reviewer critique is already the closing artifact. The driver already
runs a `synthesize` step (`runCloseSynthesis`), so a new strategy can return it
with no extra driver work.

## The pure rule

A strategy may read `room` and `transcript` (and, for the magentic strategy, `ledger`), and it must return a
`StrategyStep`. That is the entire surface. It performs no I/O, talks to no
provider, never reads an agent's reply, and never parses free text. Routing-tail
parsing, validation, and spawning all live in the driver and in `src/routing.ts`.
A strategy proposes; the driver disposes.

This is why strategies are unit-testable in isolation and safe to add: the same
input always yields the same step, with no side effects to mock. Keep it that way.

When you need to read the transcript, reuse the pure helpers in `src/routing.ts`
rather than walking the entries yourself:

| Helper | What it answers |
| --- | --- |
| `speakerCounts(transcript)` | how many turns each Mind has taken (agent turns only) |
| `leastSpoken(participants, counts)` | the participant with the fewest turns, stable by order |
| `nextUnheard(participants, counts)` | the first Mind that has never spoken, else `participants[0]` |
| `allHeardInCycle(participants, counts, minRounds)` | has everyone spoken at least `minRounds` times |
| `roundOf(participants, transcript)` | the current round, the min agent-turn count across participants |
| `endVoteRatio(transcript, participants)` | fraction of participants whose current turn votes to end |

These read the transcript without parsing prose. If you find yourself reaching for
a regular expression, stop: that work belongs in the driver.

:::note
`room.round` is the authoritative round cursor. Read round-based decisions from
`room.round`, not from `turnIndex % participants`, so a director override or a
moderator's pick can perturb the rotation without losing the round count.
:::

## Add one in three edits

### 1. Write the strategy file

Create `src/strategies/{name}.ts` and export a `const` of type `Strategy`. Every
shipped strategy opens with the same three structural guards, in this order. The
first two always return `{ kind: "end" }`:

1. the room is not active (`room.status !== "active"`),
2. there are no participants (`room.participants.length === 0`).

The third guard, a spent turn budget (`room.turnIndex >= room.turnBudget`), is
where the shipped strategies diverge. Five of the six (sequential, concurrent,
group-chat, open-floor, magentic) return `exhaustedSynthesis(room, transcript)`,
a closing `synthesize` turn that degrades to `{ kind: "end" }` only when no
synthesizer Mind can be resolved. Only `review` returns `{ kind: "end" }` at
budget, because its reviewer critique is already the closing artifact.

Write those first, then decide. Here is a complete minimal strategy, a small
variation on the unmoderated `open-floor` policy: it seeds the least-spoken
participant each turn, but ends early once everyone has spoken at least one round.
It takes the simpler `review`-style path and returns `{ kind: "end" }` when the
budget is spent, rather than asking for a closing synthesis.

```ts
import { leastSpoken, roundOf, speakerCounts } from "../routing.ts";
import type { Strategy } from "../types.ts";

// One round of fair rotation, then stop. Pure: reads the transcript only through
// the routing helpers and never parses text.
export const oneRound: Strategy = ({ room, transcript }) => {
  if (room.status !== "active") return { kind: "end" };
  if (room.participants.length === 0) return { kind: "end" };
  if (room.turnIndex >= room.turnBudget) return { kind: "end" };

  const counts = speakerCounts(transcript);
  if (roundOf(room.participants, transcript) >= 1) return { kind: "end" };

  const next = leastSpoken(room.participants, counts) ?? room.participants[0];
  return next ? { kind: "speak", mind: next } : { kind: "end" };
};
```

Note the explicit `.ts` import extensions and the trailing `?? participants[0]`
fallback: `leastSpoken` returns `undefined` on an empty roster, and the final
`return next ? ... : { kind: "end" }` keeps the function total.

### 2. Add the literal to the union

`RoomStrategyName` in `src/types.ts` is the only place the set of strategy names is
defined. Add your new string literal:

```ts
export type RoomStrategyName =
  | "sequential"
  | "concurrent"
  | "group-chat"
  | "open-floor"
  | "review"
  | "magentic"
  | "one-round";
```

### 3. Wire the registry

Edit `src/strategies/index.ts`: import your function and add it to the `strategies`
object literal. Quote the key if it contains a hyphen, matching `"group-chat"` and
`"open-floor"`.

```ts
import { magentic } from "./magentic.ts";
import { oneRound } from "./one-round.ts";

export const strategies: Partial<Record<RoomStrategyName, Strategy>> = {
  sequential,
  concurrent,
  "group-chat": groupChat,
  "open-floor": openFloor,
  review,
  magentic,
  "one-round": oneRound,
};
```

`getStrategy` resolves with `Object.hasOwn`, so adding the key is enough to make
the strategy selectable. You may re-export the function from the bottom of the
file to match convention, but that is optional. A name that is in the union but
not in the object throws `strategy "{name}" is not implemented` when a room tries
to use it.

## Test it

A strategy is a pure function, so a test constructs a `Room` and a `transcript` and
asserts the returned `StrategyStep`. No server, no fixtures, no mocks. The shipped
tests use small factory helpers and run under `bun test`:

```ts
import { describe, expect, test } from "bun:test";
import { oneRound } from "../../src/strategies/one-round.ts";
import type { Room, StrategyInput, TurnEntry } from "../../src/types.ts";

function room(overrides: Partial<Room> = {}): Room {
  return {
    slug: "r",
    name: "R",
    strategy: "one-round",
    participants: ["a", "b"],
    status: "active",
    turnBudget: 10,
    turnIndex: 0,
    round: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const agentEntry = (from: string): TurnEntry => ({
  messageId: "m",
  roomSlug: "r",
  turnIndex: 0,
  from,
  role: "agent",
  parts: [{ text: "hi" }],
  at: "2026-01-01T00:00:00.000Z",
});

function input(transcript: TurnEntry[] = [], overrides: Partial<Room> = {}): StrategyInput {
  return { room: room(overrides), transcript };
}

describe("one-round strategy", () => {
  test("seeds the first participant on an empty transcript", () => {
    expect(oneRound(input())).toEqual({ kind: "speak", mind: "a" });
  });

  test("ends once everyone has spoken a round", () => {
    const transcript = [agentEntry("a"), agentEntry("b")];
    expect(oneRound(input(transcript))).toEqual({ kind: "end" });
  });

  test("is pure (same input, same output, no mutation)", () => {
    const inp = input([agentEntry("a")]);
    const snapshot = JSON.stringify(inp);
    expect(oneRound(inp)).toEqual(oneRound(inp));
    expect(JSON.stringify(inp)).toBe(snapshot);
  });
});
```

Cover the three structural guards (not active, empty roster, budget reached), your
own decision branches, and a purity check that the input is not mutated. Run it
with `bun test test/strategies/one-round.test.ts`.

:::caution
A pure strategy test holds no module-scope state, so it needs no teardown. The
moment a test reaches past the pure function into a store, a driver, or anything
the rib keeps alive between tests, add per-test teardown (`afterEach`) that
disposes and resets that state. Chamber tests that skip this can pass locally yet
hang CI.
:::

## When the driver has to learn the step too

The strategy emits a `kind`; the driver executes it. For `speak`,
`speak-parallel`, `synthesize`, and `end`, that execution already exists, so a
strategy that returns only those is complete after the three edits and a test. For
`manage` and `assign`, the driver execution exists for the magentic strategy. But
if your strategy returns `moderate`, or relies on a routing tail (a moderator's
pick, a peer nomination, an end vote), the matching execution and fallback live in
the driver and in `src/routing.ts`, not in the strategy. The pure
function only names the step. Teaching the driver to run a new step is a larger
change than authoring the policy, and the design record explains why the split is
drawn there.

## What you proved

A room's turn policy is a pure function: read the room and the transcript, return
one of seven steps. You wrote one, added it to the union, wired it into the
registry, and tested it with no server, no fixture, no mock, because a strategy has
nothing to mock. That is what the whole rail was walking toward. The driver runs
the turns, parses the routing tails, and validates every pick; the strategy only
decides who is next. Hold that line and a new routing shape stays three edits and a
test. Cross it, into I/O or text parsing, and you have given up the one property
that made strategies easy to get right.

## Related

- [Strategies](../../reference/strategies/): the exact contract and every shipped strategy's decision logic.
- [Rooms and strategies](../../concepts/rooms/): why strategies are pure and the driver is the router.
- [Rooms and strategies design record](../../design/rooms-and-strategies/): the decision to split the policy from the driver, and the alternative rejected.
- [Run a room](../../guides/run-a-room/): drive a room from chat or the surface.
