---
title: How minds remember
description: Why a Mind curates its own durable memory once, at a room's close, and why that pass is cost-gated, serialized, and fail-closed
sidebar:
  order: 7
---

A Mind that only ever knew the room in front of it would relearn the same facts
every time you convened it. Chamber gives a Mind durable memory instead: a
`memory.md` it reads into every room turn, and curates for itself when a room
closes. Identity stays fixed; memory is the part that grows.

## Decision

A Mind curates its own memory once, at a room's close, not per turn. The read is
free: the Mind's durable memory and operating rules are folded into the system
prompt of every room turn, the same composer the direct chat uses. The write is a
single billed reflection turn, fired when the room ends, in which the Mind decides
what from the room it just lived is worth carrying into a different one.

Splitting read from write this way keeps the common path free. A Mind carries its
memory into every turn at no cost, and only pays when a room closes and there is
something to consolidate.

## What a reflection turn does

When a room closes, each reflecting Mind runs one turn over the room's transcript
and its own current `memory.md`. It returns the complete updated memory document,
not an addition, plus a one-line log entry. The store overwrites `memory.md` with
that document and appends the line to `log.md`.

The discipline lives in the prompt, not in code. The Mind is told it is not
summarizing the room: most of what happened belongs to that room alone and should
be forgotten. It keeps only what would make it sharper weeks from now in a
different room, a durable fact or a lesson about how it works, and when unsure it
keeps nothing. It records something as its own fact only if it would vouch for it,
otherwise it attributes the claim or drops it. Identity is not memory: the Mind
does not restate its soul.

## The cost gate is deterministic and free

Reflection runs only for a Mind that actually spoke at least one substantive,
non-aborted turn. A silent participant learned nothing, so it spends nothing, and
a room nobody spoke in triggers no reflection at all. That check is a plain set
intersection over the transcript, not a model call, so the gate itself is free.

The reflecting set is the room's Minds that spoke, including a facilitator that is
not a listed participant: a group-chat moderator or synthesizer, or a magentic
manager, reflects on a room it shaped if it authored turns. The set is bound to the
room's configured Minds, so a stray transcript entry can never summon a reflection,
and a Mind retired between speaking and the close is skipped.

## Serialized per Mind

The whole read, turn, and write is serialized per Mind. Two rooms closing at once
that share a Mind consolidate on each other's result instead of lose-updating: the
second reflection reads `memory.md` only after the first has written it. The read
sits inside that serialized chain, not before it, so the consolidation is always
over the latest memory.

## Fail closed

A reflection never damages a Mind's memory when it goes wrong:

- An empty or unparseable reply keeps the prior memory. A model that means "no
  change" is told to echo its current memory back, so a blank document is treated
  as a keep, never written. A bad turn cannot wipe hard-won memory.
- Over-cap text is rejected and the prior memory stands; the next close retries.
- A failed, timed-out, or aborted turn leaves memory untouched.
- The pass is fire-and-forget and never throws into the room loop, so a reflection
  fault cannot fail the room that triggered it.
- Shutdown aborts an in-flight reflection and drops its late write, the same way a
  room turn aborts on dispose.

## Identity stays immutable

Reflection writes only `memory.md` and `log.md`. The founding identity in
`SOUL.md`, and the operator-authored `rules.md`, are never touched by a reflection
turn. What a Mind *is* does not drift on its own; only what it has *learned*
accumulates, under a hard size cap so a growing memory can never crowd identity out
of the prompt budget. The exact caps are in [Data on disk](../../reference/data-on-disk/).

## Rejected alternatives

**Reflect after every turn.** Updating memory each turn would spend N paid turns
per room instead of one per speaker, and worse, a Mind would consolidate against a
half-finished room. Close-only reflection reasons over the whole arc of the room,
once, when there is something settled to keep.

**Write the room summary into memory.** Memory is not a transcript digest. Most of
a room is local to that room. The reflection prompt asks the narrower question, what
is worth carrying into a *different* room, which yields a far smaller and more
durable set than a summary would.

**Append-only memory.** Never deleting would let memory grow without bound, crowd
identity out of the prompt, and accumulate facts the next room proves stale.
Reflection revises in place: it keeps, sharpens, merges, or deletes each existing
item, then adds only what is genuinely new, capped.

## Related

- [Minds and genesis](../../concepts/minds/): the identity that memory attaches to.
- [Rooms and strategies](../../concepts/rooms/): the room close that fires reflection.
- [The agent-turn seam](../the-agent-turn-seam/): the seam a reflection turn runs on.
- [Data on disk](../../reference/data-on-disk/): the memory and log files, and their caps.
