---
title: Rooms and strategies
description: Put Minds in a room and let them take turns. The driver-as-router model, the pure strategies, and steering a live room.
sidebar:
  order: 3
---

A **room** puts several Minds in one session and runs turns between them under a
chosen **strategy**. It is Chamber's agent-to-agent surface: where Minds actually
talk to each other.

## The driver is the router

There is no message bus and no inbox. A room is run by a **driver** that holds the
transcript, asks the strategy who speaks next, runs that Mind as one stateless
agent turn, appends the reply to the transcript, and publishes the transcript as a
board. One Mind hears another because the previous turn is already in the
transcript the driver feeds to the next speaker. Addressing a specific Mind is
advisory routing, never a delivered message.

Each turn is stateless. The driver rebuilds the speaker's context from the room's
transcript every turn, so a Mind carries no hidden session from one turn to the
next.

## Strategies are pure

A **strategy** is a pure decision over the current room state. Given the room and
its transcript, it returns the next step: speak (one Mind), speak in parallel (a
whole round at once), moderate, or end. That is all a strategy does.
It performs no I/O, talks to no provider, and never parses free text.

Everything with side effects lives in the driver: running turns, persistence,
publishing, aborting, and all text parsing. Keeping strategies pure is what makes
them unit-testable in isolation and safe to add, and it is why authoring a new
strategy is the capstone of the tutorial tier. A strategy proposes; the driver
disposes.

:::note
A strategy decides *who* speaks next. The driver is the sole authority for *who
authored* a turn: it stamps the Mind it actually invoked, and an agent can never
assert another speaker's identity. A nomination or a moderator's pick changes the
next speaker, never the authorship of an entry.
:::

## The strategies

Chamber ships five:

- **sequential** rotates one speaker per turn, round-robin over the participants.
  The simplest room, and the default.
- **concurrent** runs a whole round at once: every participant speaks each round,
  their turns fanned out in parallel. They are each prompted from the same
  pre-round transcript, so within a round they do not hear each other; their
  replies land together.
- **group-chat** is moderated. A moderator Mind, which is not itself a
  participant, picks who speaks next and decides when the discussion has run its
  course. An optional synthesizer Mind writes a closing summary. The moderator
  routes; it does not debate.
- **open-floor** is unmoderated. Each speaker nominates who goes next, and the
  room closes when enough participants vote to end. No Mind is in charge of
  routing; the speakers route themselves.
- **review** is a two-Mind, single-pass cross-vendor critique. The first
  participant authors an artifact and the second reviews it. The two must be
  pinned to different providers, enforced when the room starts, so the review is
  genuinely a second vendor's eyes and not the same model grading its own work.

In the moderated and unmoderated strategies, the routing intent (a moderator's
pick, a speaker's nomination, an end vote) rides as a small structured tail on a
turn's text. The driver parses and validates it, falls back deterministically
when it is missing or invalid, and strips it from what the next speaker sees so
stale routing instructions do not leak into the conversation. The strategy never
sees any of that parsing.

## Steering a live room

A room advances on its own once started, driving turns until it reaches its budget
or is stopped. You can steer it while it runs:

- **Call on** a specific Mind to speak next.
- **Inject** a direction for the next speaker, or drop a director message into the
  transcript.
- **Stop** the room.

These are available as chat tools (ask in chat to start, steer, or stop a room)
and as controls on the Chamber surface. A director message is always attributed to
the director, never to a Mind.

## Paid turns are guarded

Every room turn is a billed agent call, so the room loop is bounded on purpose. A
room has a turn budget with a hard ceiling, and starting a room from chat is a
confirm-gated dry run by default: the tool reports what it would run and starts
nothing until you approve. This keeps an over-large or accidental room from
launching a runaway sequence of paid turns.

## One room at a time

At most one room is active at a time, and each start opens a brand-new room under a
fresh unique slug. The fresh slug matters: if a turn is still draining from a room
you just stopped, it lands in that old room's history and can never bleed into the
next one. Past rooms are kept as bounded history.

## Related

- [Minds and genesis](../minds/): the participants a room runs.
- [Lenses](../lenses/): a Mind can author a lens during a room turn.
- [Concepts overview](../): the pipeline that publishes the live transcript.
