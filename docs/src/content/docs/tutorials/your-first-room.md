---
title: Your first room
description: Author two Minds from an empty workspace, run a sequential room between them, and read the transcript
sidebar:
  order: 2
---

This is where Chamber starts to feel like more than a roster. You will author two
Minds, drop them into a room, and watch them take turns talking to each other. By
the end you will have a transcript you can read top to bottom, and a feel for how
a room actually runs.

Chamber is a Keelson rib, so everything here happens on the Chamber surface inside
the harness you already have running. Open it and find the Roster. A fresh
workspace shows no Minds yet, just a few starter archetypes waiting to be
convened. That is your starting point.

## Author two Minds

A room needs at least two participants, and a participant is always a Mind. So
your first job is to author two of them.

The fastest path is the starters. The Roster offers a few presets for a cold
workspace: Moneypenny, a chief of staff; Mycroft, a research partner; Jarvis, an
engineering partner. These are briefs, not finished agents. Convening one runs
**genesis**, the workflow that authors a Mind from a brief, so the soul you end up
with is freshly written for your workspace rather than copied from a template.
Convene two of them and you have two distinct Minds.

If you would rather write your own, run genesis directly. Give it a short brief
and it decides the rest:

```bash
keelson workflow run chamber-genesis "A blunt staff engineer who argues for the
simplest thing that works"
```

Or, in chat, use the command form:

```text
/genesis A careful product reviewer who asks what the user actually needs
```

Run it twice with two different briefs and you have your pair. Each run is one
agent turn: it reads your brief, decides a name, role, and voice, writes the
Mind's founding document, and persists it. You do not call any write tool
yourself. You just run the workflow.

## Watch the Roster fill in

As each Mind lands, a card for it appears on the Roster. Genesis writes the Mind
to disk and the roster reflects it, so you see the workspace go from a few preset
archetypes to two real Minds you authored. Each card shows the Mind's name, its
role, and the one-line tagline genesis wrote for it.

This is worth a beat. Nothing was running before; now two persistent identities
exist on disk, and they will still be there next session. You can enter either one
for a direct one-to-one chat from its card. But a direct chat is one Mind with no
peer. To get them talking to each other, you need a room.

## Convene a sequential room

A room puts both Minds in one session and runs turns between them under a
strategy. The simplest strategy, and the default, is **sequential**: each Mind
speaks once per round, round-robin, in order.

The easiest way to open one is the Convene composer on the Roster. By default it
includes every Mind, so with two Minds authored it already has the right two
selected. Add a topic so the room has something to chew on, then convene. That
opens a sequential room with both Minds and a default budget of eight turns.

You can also start a room from chat. The `chamber_room_start` tool is a dry run by
default: ask for it without confirming and it tells you exactly what it would open
and starts nothing. When you are ready, confirm:

```json
{
  "participants": ["staff-engineer", "product-reviewer"],
  "topic": "Should we ship the feature flag or wait for the full UI?",
  "confirm": true
}
```

You name the participants by slug, give a topic, and set `confirm: true` to
actually launch. Strategy defaults to sequential, so you can leave it off. The
turn budget defaults to eight; you can pass `turnBudget` to raise or lower it,
up to a ceiling of fifty.

:::note
Every room turn is a billed agent call. That is why starting from chat confirms
first, and why a room is bounded by a turn budget. The room runs until it hits the
budget or you stop it, so the budget is your spend limit, not a target to fill.
:::

## Watch the turns land

Once the room starts, a live room panel appears on the surface, and turns begin to
land round by round. You do not drive them. The room advances on its own, running
one Mind, then the next, then back to the first, until it reaches its budget.

What you are watching is the **driver** at work. The driver is the router for the
room. There is no message bus and no inbox between the Minds. The driver holds the
transcript, runs one Mind as a single turn, appends its reply, and then runs the
next Mind, feeding it that same transcript. One Mind hears another only because the
previous reply is already in the transcript the driver hands to the next speaker.

Each turn is stateless. The driver rebuilds a speaker's context from the
transcript every time, so a Mind carries no hidden memory from one turn to the
next. Everything a Mind knows in the room is what is written down. That is why the
transcript is the whole conversation, and why the live panel is just that
transcript, published as a board and growing a turn at a time.

## Read the transcript

When the room reaches its budget it ends on its own. The live panel holds the
finished transcript, oldest turn at the top, each entry labeled with the Mind that
spoke it. Read it top to bottom and you can follow the whole exchange: the first
Mind opens, the second responds to what it sees, the first answers back, round by
round, to the end.

The label on each turn is authoritative. The driver stamps who spoke; a Mind
cannot claim to be another speaker. So when you read a name on a turn, that is the
Mind the driver actually ran.

A finished room stays as bounded history. You can reopen it later from its card to
read the transcript again in a side panel, long after the live one has rolled off
the surface.

## Stop the room

A room you started will run to its budget, but you do not have to wait. To end it
early, use the stop control on the room panel, or the `chamber_room_stop` chat
tool. Stopping is reversible: it ends the current room, and you can start a fresh
one whenever you like. Each new room opens under its own identity, so a turn still
finishing from the room you stopped lands in that old room's history and never
bleeds into the next.

That is a full room: two Minds authored, a sequential room run between them, a
transcript read, and the room stopped. The driver did the routing, the Minds took
their turns, and the budget kept it bounded.

Next, convene a moderated room, where a Mind that never speaks decides who does.

## Related

- [Author a moderated room](../a-moderated-room/): add a moderator that routes the turns.
- [Minds and genesis](../../concepts/minds/): what the Minds you authored are.
- [Rooms and strategies](../../concepts/rooms/): the driver-as-router model in depth.
- [Run a room](../../guides/run-a-room/): the operator how-to once you know the shape.
