---
title: The rooms model
description: Why room strategies are pure decisions and the driver owns execution, turn identity, and budget
sidebar:
  order: 5
---

A room runs turns between several Minds. This record states how that loop is split:
a **strategy** is a pure decision over room state, and the **driver** does everything
with a side effect. Several smaller decisions hang off that split, all of them in
service of one invariant: the driver is the sole author of a turn's identity.

## Strategies decide, the driver executes

A strategy is a pure function of the current room state. It returns one step: speak
one Mind, speak a parallel round, hand control to a moderator, synthesize, or end.
It performs no I/O, calls no provider, never reads an agent's reply, and never parses
free text. The driver does all the rest: parsing routing tails, validating a pick
against the participant set, spawning the agent turn, persisting the transcript,
publishing the board, and aborting.

The rejected alternative was to let a strategy reach the provider or parse a reply,
so it could route on what an agent said. That folds the rib's correctness story,
generation gating, the write lock, abort, and the active-room reservation, into code
that also makes decisions, and it makes a strategy untestable in isolation. Keeping
the strategy pure is why authoring one is a self-contained exercise and why it is the
[capstone tutorial](../../tutorials/author-a-room-strategy/).

The line holds because of one rule about identity. A strategy decides who speaks
next; the driver decides who authored a turn. The driver stamps the Mind it actually
invoked into the entry, and an agent can never assert another speaker. A moderator's
pick or a peer nomination moves the next speaker, never the authorship of an entry.

## Why the input is `{ room, transcript }`

The strategy input is `{ room, transcript }`, not `room` alone. The narrow input
would have been cleaner, but it is genuinely too thin. The group-chat close gate
asks whether everyone has spoken enough rounds, and open-floor asks whether the last
speaker nominated anyone. Both are participation questions the room object does not
carry; they live in the transcript.

Widening the input is the minimal honest answer. The alternative, handing the
strategy a reader callback or letting it parse the transcript itself, would make it
effectful and reopen the door this split closes. So the strategy gets the transcript
read-only and may touch it **only** through the pure helpers in `src/routing.ts`
(`speakerCounts`, `leastSpoken`, and the rest). It still parses nothing.

## Why `round` is stored, not derived

The round count lives on `room.round`. Deriving it as `turnIndex % participants`
would be cheaper, and it would be wrong. A director override or a moderator's pick
perturbs the rotation: a turn that the modulus assumes belongs to participant N can
go to someone else entirely, and from then on the derived round drifts from reality.
The driver computes the round from actual agent turns and stores it, so a strategy
that reads `room.round` reads the truth even after the rotation has been steered.

## The moderator is not a participant

In group-chat the moderator is a roster Mind that is deliberately not a member of
`room.participants`. It routes; it does not debate. Keeping it out of the participant
set buys three things for free: the speaker-count helpers never see it, so it cannot
be redirected as an over-talkative speaker; `buildRoomBoard` never fans it into a
speaker segment or a Call-on control; and it adds no phantom to the speaker count.
It is a Mind, just not a speaker.

## Budget gating

Every agent turn ticks the budget by exactly one, and a step never starts a turn it
cannot finish within budget. A moderated step is the one place this matters: a
`moderate` step can consume up to **two** ticks, the moderator turn and then the
speaker it routes to, so the driver checks for both before it begins.

The moderator turn is appended as a visible entry. This rib's invariant is one append
per turn, so a hidden moderator that routes without leaving a trace was rejected.
Only the routing-JSON tail is stripped from the next speaker's prompt, so a stale
instruction does not leak into the conversation, but the moderator's reasoning stays
on the record.

## True concurrent rounds

A parallel round runs N turns concurrently, then appends all N and publishes **once**.
It is not N live-streamed frames arriving one at a time. The N speakers are each
prompted from the same pre-round transcript, so within a round they do not hear each
other, and their replies land together.

Two things make this correct. Output order is pinned to the strategy's decision
order, not to whichever turn finishes first, so a fast Mind cannot reorder the round.
And the imperative publish path the rib drives carries the same coalescing the bound
workflow path has, so a burst of concurrent results collapses into one rendered frame
rather than thrashing the surface. The coalescing and cancellation mechanics are the
harness's; see the [Keelson docs](https://danielscholl.github.io/keelson/).

## Open-floor precedence

Open-floor resolves the next speaker through three tiers, in order:

1. A director **call-on** wins. A live operator instruction beats anything an agent
   said.
2. Else a validated prior **nomination**: the last speaker's pick, if it parsed and
   passed validation.
3. Else the strategy's **seed or fallback**: the least-spoken participant, or
   `participants[0]` when everyone is at zero.

A nomination is an advisory routing hint, never an identity claim. The driver
validates any agent-derived nominee against the fixed participant set, the closed
roster set at room start, and rejects `director`, `system`, and non-participants. An
invalid or missing nomination falls through to the strategy's deterministic result.
This is the same identity rule stated plainly: a nomination changes who speaks next;
it can never change who authored a turn or admit a Mind the room did not start with.

## Related

- [Room strategies](../../reference/strategies/): the exact contract, the five strategies, and the routing knobs.
- [Author a room strategy](../../tutorials/author-a-room-strategy/): the capstone walkthrough built on this split.
- [Rooms](../../concepts/rooms/): the driver-as-router model, end to end.
- [Communication and identity](../communication-and-identity/): why a Mind, not a capability, is an addressable speaker.
- [Keelson documentation](https://danielscholl.github.io/keelson/): the harness that owns turn execution, coalescing, and cancellation.
