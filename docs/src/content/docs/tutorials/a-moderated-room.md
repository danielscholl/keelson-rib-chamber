---
title: Convene a moderated room
description: Run the moderated and unmoderated strategies, then steer a live room as the director
sidebar:
  order: 3
---

In [your first room](../your-first-room/) you ran the default sequential
strategy: Minds took turns round-robin and you watched the transcript fill in.
That is the simplest room. Now you will give a room a shape. You will hand
routing to a moderator, then take routing away entirely, then steer a live room
yourself. By the end you can pick the strategy that fits the conversation you
want and bend it while it runs.

:::note[Before you start]
A running keelson server with Chamber installed, and
[your first room](../your-first-room/) behind you. You need two or more Minds on
disk; if you do not have them yet, author a couple first, then come back. Every
room turn is a paid agent call, so expect to spend a few tokens.
:::

## Convene a moderated room

In a moderated room a **moderator** Mind decides who speaks next and when the
discussion has run its course. The moderator routes; it never debates. It is not
one of the speakers, so its turns do not land in the back-and-forth you are
trying to shape.

Ask in chat to start a `group-chat` room with a moderator that is not in the
speaker list. Ada, Bex, Cyrus, and Quill below stand in for Minds you authored,
so swap in your own names; naming them in plain language lets Chamber resolve the
slugs:

```text
Start a group-chat room with Ada, Bex, and Cyrus debating the rollback plan,
moderated by Quill.
```

The start tool reports what it would run and starts nothing until you approve,
because every turn is a paid agent call. Confirm, and the room opens. Quill
takes the first move: it reads the transcript, picks who should speak to the
question, and that Mind runs one turn. Quill picks again, and so on. When Quill
judges the discussion done, it closes the room. You did not set a speaking
order; the moderator built one turn by turn.

A few rules keep a moderated room honest:

- The moderator must be a real Mind that is **not** among the speakers. If you
  name a moderator but no strategy, the room infers `group-chat` for you.
- The moderator cannot close too early. A participation floor (`minRounds`)
  requires every speaker to have spoken before a close can land.
- No speaker can monopolize. If the moderator keeps picking the same Mind, the
  driver redirects the turn to whoever has spoken least.

You can also name a **synthesizer**: a Mind that writes a single closing summary
when the discussion ends. The synthesizer is not a speaker and is not the
moderator. Add one when you want the room to leave behind a tidy wrap-up rather
than ending on the last reply.

```text
Same room, and have Sage write a closing summary when it wraps.
```

:::caution[If a room will not start]
A few starts get rejected, all for the same kind of reason. If a `group-chat`
start is refused, your moderator is probably also in the speaker list; a
moderator routes and never debates, so it has to sit outside the speakers. If an
`open-floor` start is refused, you named a moderator or synthesizer, which that
strategy does not allow; drop them and let the speakers route themselves. A
`review` room refuses to start unless its two Minds are pinned to different
providers, so the critique is a genuine second vendor's read. And if any room
ends mid-discussion, it hit its turn budget; convene again with a higher
`turnBudget` (the ceiling is 50).
:::

## Convene an unmoderated room

Sometimes you do not want a Mind in charge of routing. In an `open-floor` room
nobody moderates. Each speaker nominates who goes next, and the room closes when
enough participants vote to end.

```text
Start an open-floor room with Ada, Bex, and Cyrus to brainstorm names.
```

There is no moderator and no synthesizer here; the room rejects them if you try
to add one. The speakers route themselves. To close, participants have to vote
to end, and the room shuts when the share of current end votes clears the
**end-vote threshold**. That threshold defaults to `0.49`, and the close is a
strict greater-than: at `0.49`, a single end vote in a two-Mind room (a ratio of
`0.5`) clears it and the room closes. Set the threshold to `0.5` and you require
strictly more than half, so a tie does not close.

Votes reflect a speaker's current standing, not a running tally. A Mind that
voted to end and then speaks again has withdrawn its vote.

The threshold is easier to feel as a table. The denominator is the participant
count; the numerator is how many of them most recently voted to end:

| Participants | End votes | Ratio | Closes at `0.49`? | Closes at `0.5`? |
| --- | --- | --- | --- | --- |
| 2 | 1 | 0.50 | yes | no |
| 2 | 2 | 1.00 | yes | yes |
| 3 | 1 | 0.33 | no | no |
| 3 | 2 | 0.67 | yes | yes |
| 4 | 2 | 0.50 | yes | no |

So the default `0.49` lets a bare majority close, and lets a single vote close a
two-Mind room. Raise it to `0.5` when you want strictly more than half, so a tie
keeps the room open.

## Steer a live room

A room advances on its own once it starts, driving turns until it hits its
budget or you stop it. You do not have to sit back. You are the **director**,
and you can reach into any running room.

**Call on a specific Mind.** Override whoever was about to go and hand the next
turn to the Mind you name:

```text
Call on Cyrus next.
```

In chat this is `chamber_room_say` with a `callOn`; on the Chamber surface it is
the room's Call on control. The Mind you name has to be a current participant:
`chamber_room_say` rejects a `callOn` that names a Mind not in the room, with an
error that lists the valid participants, rather than silently dropping it. In a
moderated or unmoderated room a call-on wins outright: it does not route through
the moderator or wait for a nomination.

**Inject a direction.** Steer what the next turn is about without naming a
speaker:

```text
Direction: focus on the rollback risk, not the timeline.
```

In chat this is `chamber_room_say` with a `direction`. In a moderated room the
direction goes to the moderator, who still decides who speaks. In an unmoderated
or sequential room it goes straight to the next speaker.

**Drop a director message.** Put a line into the transcript itself:

```text
Say to the room: we have ten minutes left.
```

This is `chamber_room_say` with `text`. A director message is always attributed
to the director, never to a Mind. No agent can speak as the director, and the
director never speaks as an agent. When you want to stop a room outright, ask to
stop it; a stopped room is reversible, so you can start a fresh one right after.

## A second pair of eyes: review

One more strategy is worth knowing. A `review` room is a two-Mind, single-pass
cross-vendor critique: the first Mind authors an artifact and the second
reviews it. The two Minds must be pinned to **different providers**, enforced
when the room starts, so the critique is genuinely a second vendor's eyes and
not the same model grading its own work. See the
[strategies reference](../../reference/strategies/) for its exact rules.

## Which strategy for which job

You have now driven or seen most of the shapes. The reach-for-it guide:

| When you want to | Reach for | Who routes |
| --- | --- | --- |
| layer a few takes in a fixed order | `sequential` | round-robin |
| get every Mind's first reaction at once | `concurrent` | one parallel round |
| drive a discussion to a decision | `group-chat` | a moderator Mind |
| let a group converge on its own | `open-floor` | the speakers, by vote |
| get a cross-vendor critique of one artifact | `review` | author, then reviewer |
| divide a build into owned, non-overlapping tasks | `magentic` | a manager Mind |

The split that matters most: `group-chat` and `open-floor` talk something out,
`magentic` divides work up, `review` checks one thing with fresh eyes. Pick by the
verb, not the vibe.

## What you proved

A room's routing is something you choose, not something fixed. You handed it to a
moderator that drove a `group-chat` to a close, took it away entirely and let an
`open-floor` converge on a vote, and then seized it live as the director, calling
on a Mind, injecting a direction, and dropping a line into the transcript. Same
Minds, same seam; only the turn policy changed. That policy is the one piece of a
room you have used but never written, which is exactly what the capstone fixes.

## Where to go next

You have now run two more routing shapes, the moderated `group-chat` and the
unmoderated `open-floor`, and steered a live room as director. With the
sequential room from before, that is three of the six strategies driven
first-hand; `concurrent` (a parallel round), `review` (the cross-vendor pass
above), and `magentic` (a manager-led build) round out the set, and the
[strategies reference](../../reference/strategies/) has all six.

You have the routing shapes; the next two tutorials put them to work on a real
build before you write any code. In
[Many minds, one plan](../many-minds-one-plan/) you convene a moderated room to
red-team a plan and catch the defects a linear pipeline ships; in
[One manager, many tasks](../one-manager-many-tasks/) you run a magentic room to
produce a plan with no gaps and no overlap. Then the capstone,
[author your own room strategy](../author-a-room-strategy/), has you write a
routing policy of your own, a pure decision the rib drives through the same seam
these six use.

## Related

- [Many minds, one plan](../many-minds-one-plan/): the next step, these strategies on a real plan.
- [Author your own room strategy](../author-a-room-strategy/): the capstone, a pure strategy you write.
- [Your first room](../your-first-room/): the sequential room this page builds on.
- [Rooms and strategies](../../concepts/rooms/): why the driver routes and strategies stay pure.
- [Strategies reference](../../reference/strategies/): the exact contract for all six strategies.
