---
title: Room strategies
description: The pure strategy contract, the five shipped strategies, and the routing knobs that tune them
sidebar:
  order: 5
---

A **strategy** is the pure decision a room consults each turn to pick the next
speaker. It reads the room and its transcript and returns one step. It runs no
turns, calls no provider, and parses no text. This page is the contract; the
[capstone tutorial](../../tutorials/author-a-room-strategy/) walks through
authoring one.

## The Strategy contract

A strategy is a single function type:

```ts
export type Strategy = (input: StrategyInput) => StrategyStep;

export interface StrategyInput {
  room: Room;
  transcript: readonly TurnEntry[];
}
```

The input is `{ room, transcript }` and nothing else. The round cursor lives on
`room.round` (the authoritative count, not `turnIndex % participants`), so a
strategy reads it there. The transcript is needed because some strategies decide
on participation history, which the room object alone does not carry.

The return is one variant of `StrategyStep`:

```ts
export type StrategyStep =
  | { kind: "speak"; mind: MindSlug }
  | { kind: "speak-parallel"; minds: readonly MindSlug[] }
  | { kind: "moderate"; mind: MindSlug }
  | { kind: "synthesize"; mind: MindSlug }
  | { kind: "end" };
```

| Step | Fields | Meaning |
| --- | --- | --- |
| `speak` | `mind` | Run one named speaker this turn. |
| `speak-parallel` | `minds` | Run a whole round at once, fanned out. |
| `moderate` | `mind` | Hand control to a moderator Mind. |
| `synthesize` | `mind` | Run a synthesizer to write a closing turn. |
| `end` | none | Close the room. |

:::note
`synthesize` is part of the contract but no shipped strategy returns it. The
synthesizer turn is driver-emitted, not strategy-emitted, in the current code.
:::

## The registry

The five shipped strategies are registered by name in one record:

```ts
export const strategies: Partial<Record<RoomStrategyName, Strategy>> = {
  sequential,
  concurrent,
  "group-chat": groupChat,
  "open-floor": openFloor,
  review,
};
```

`RoomStrategyName` is the union of those five literals:

```ts
export type RoomStrategyName =
  | "sequential" | "concurrent" | "group-chat" | "open-floor" | "review";
```

`getStrategy(name)` resolves a strategy by an **own-property** check
(`Object.hasOwn`), not a bare index. A bare lookup would resolve inherited
members like `"constructor"` or `"__proto__"` to truthy non-strategy values and
let a crafted name slip through to crash the loop later. An unregistered name
throws `strategy "${name}" is not implemented`. The record is `Partial`, so a
union member that has no entry is a registry gap, not a type error.

## The five strategies

All five start with the same structural guards, in order, each returning
`{ kind: "end" }`: room not `active`, empty participant roster (review uses fewer
than two), and `turnIndex` at or past `turnBudget`. After the guards, each
decides differently.

| Strategy | Default | Decision | Special role |
| --- | --- | --- | --- |
| `sequential` | yes | Round-robin: `participants[turnIndex % length]`, one speaker per turn. | none |
| `concurrent` | | Returns `speak-parallel` over all participants every round. | none |
| `group-chat` | | Returns `moderate` to the configured moderator; ends if there is none. | moderator |
| `open-floor` | | Seeds with the least-spoken participant (else `participants[0]`). | none |
| `review` | | Author at turn 0, reviewer at turn 1, then ends. | author, reviewer |

### sequential

Pure round-robin keyed on `turnIndex`. It returns `{ kind: "speak", mind }` for
`participants[turnIndex % participants.length]`, or `end` when the roster is
empty. It reads room state only and is the default strategy.

### concurrent

A real parallel round. After the guards it returns
`{ kind: "speak-parallel", minds: room.participants }`. Every participant speaks
each round (it does not rotate by `turnIndex`). The driver runs the round's turns
concurrently, each prompted from the **same pre-round transcript**, so within a
round they do not hear each other. The driver trims the batch to the remaining
budget and appends the replies in participant order.

### group-chat

Moderator-routed. The strategy is pure rhythm: it returns
`{ kind: "moderate", mind: moderator }` for the `RoomConfig.moderator`, and ends
when there is no moderator (alongside the shared guards). The moderator is not a
participant, so the speaker-count helpers exclude it. An optional synthesizer
Mind can write a closing turn. All routing-tail work, parsing the moderator's
pick, validating it against the roster, the close gate, and the anti-monopoly
redirect, lives in the driver, never in the strategy.

### open-floor

Unmoderated. The strategy returns
`{ kind: "speak", mind: leastSpoken(participants, counts) ?? participants[0] }`.
That serves as both the opening seed (everyone at zero turns falls to
`participants[0]`) and the fair-rotation fallback. The speakers route themselves:
each one nominates who goes next, and the room closes when enough of them vote to
end. Nomination parsing and the end-vote gate live in the driver, which uses the
strategy's least-spoken result whenever a nomination is missing or invalid.

### review

A two-Mind, single-pass critique. Its empty-roster guard is fewer than two
participants. It reads `const [author, reviewer] = room.participants`, returns
`{ kind: "speak", mind: author }` at `turnIndex === 0`, the reviewer at
`turnIndex === 1`, and `end` after. The author is `participants[0]` and the
reviewer is `participants[1]`. The two must be **pinned to different providers**,
enforced when the room starts, so the review is genuinely a second vendor's eyes.
The strategy itself is pure rhythm by `turnIndex`; the provider check runs at
room start, not in the strategy.

## The pure / driver split

A strategy reads only `room` and `transcript` and returns a `StrategyStep`. It
performs no I/O, calls no provider, never reads an agent's reply, and never parses
free text. Everything with side effects, running turns, parsing the routing tail,
validating a pick against `room.participants`, and spawning, lives in the driver
and in `src/routing.ts`.

A strategy may read the transcript **only through the pure helpers** in
`src/routing.ts`. These are pure functions, not strategies:

| Helper | Returns |
| --- | --- |
| `speakerCounts(transcript)` | Per-Mind agent-turn counts; director and system turns do not count. |
| `leastSpoken(participants, counts)` | First participant with the fewest turns, stable by roster order. |
| `nextUnheard(participants, counts)` | First never-spoken participant, else `participants[0]`. |
| `allHeardInCycle(participants, counts, minRounds)` | True when every participant has spoken at least `minRounds`. |
| `roundOf(participants, transcript)` | Minimum agent-turn count across participants; the round cursor. |
| `endVoteRatio(transcript, participants)` | Fraction whose current standing parses to an end vote. |

## Routing knobs

The routing constants live in `src/routing.ts`, not in any strategy, and each has
a per-room override on `RoomConfig`.

| Knob | Default | `RoomConfig` override | Effect |
| --- | --- | --- | --- |
| `minRounds` | `1` | `minRounds` | Participation floor before a moderator may close. |
| `maxSpeakerRepeats` | `2` | `maxSpeakerRepeats` | Anti-monopoly cap; an over-picked speaker is redirected to the least-spoken. |
| `endVoteThreshold` | `0.49` | `endVoteThreshold` | End-vote fraction; compared with a strict greater-than. |

The end-vote comparison is a strict `>`. At the `0.49` default, a single end vote
in a two-Mind room (ratio `0.5`) closes it. Set it to `0.5` and a `0.5` tie does
not close: an operator who wants more than half must say so.

## Related

- [Author a room strategy](../../tutorials/author-a-room-strategy/): the capstone walkthrough that uses this contract.
- [Rooms and strategies](../../concepts/rooms/): why the driver routes and strategies stay pure.
- [Tools and commands](../tools-and-commands/): the chat tools that start and steer a room.
- [Surface](../surface/): the snapshot keys a running room publishes.
