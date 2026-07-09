---
title: Run a room
description: Convene Minds into a room, pick a strategy, and steer the live conversation from chat or the board
sidebar:
  order: 4
---

A room puts several Minds in one session and runs turns between them. This guide
is for the operator convening and steering one. Chamber is a Keelson rib, so a
room lives on the Chamber surface and responds to chat tools the same way the rest
of the harness does. For why rooms work the way they do, see
[Rooms and strategies](../../concepts/rooms/).

## Convene a room

The fastest way to start a room is the Convene composer region, a separate
collapsible board directly below the Roster. (The Roster itself is now Minds-only.)
It needs at least two Minds before it can open one.

The Convene draft is an exclusion set, not a pick list. Every current Mind starts
selected. You deselect the ones you want to leave out, and Convene opens a room
with whoever is still selected. The first toggle drops a single Mind rather than
clearing your whole roster, which matches the common case of running everyone but
one.

Once two or more Minds stay selected, Convene surfaces a `…and how` shape picker
with five tabs, each opening a small form and starting its own strategy:

- **Discussion** (sequential): the default.
- **Debate** (group-chat): needs a chair, a Mind left out of the cast.
- **Open floor** (open-floor): unmoderated.
- **Review**: a single-pass critique of exactly two Minds pinned to different
  providers.
- **Build** (magentic): needs a manager, a Mind left out of the cast.

Shapes the current cast cannot satisfy are disabled with the reason shown. See
[Choose a strategy](#choose-a-strategy) below and
[Strategies](../../reference/strategies/) for the per-shape contract. Once a room
opens, the draft resets to all Minds selected, ready for the next one.

## Start from chat

In chat, the `chamber_room_start` tool opens a room. It is confirm-gated. Without
`confirm:true`, the tool reports what it *would* start and runs nothing, a dry run.
You re-call it with `confirm:true` once you approve what it described.

```text
Would open a room with {who} on {topic} for {turnBudget} turns
(each turn is a paid agent call). Re-call chamber_room_start with
confirm:true once the user approves.
```

The gate exists because each turn is a paid agent call. The dry run lets you see
the participant list, topic, and budget before anything bills.

```ts
chamber_room_start({
  participants: ["scout", "auditor"],
  topic: "review the rollback plan",
  strategy: "sequential",
  turnBudget: 8,
  confirm: true,
})
```

`participants` is required and needs at least two distinct Minds. `topic`,
`strategy`, and `turnBudget` are optional. To target the room at a keelson
project, pass `projectId`. That alone grants Read to every speaker, confined to the
project root, so even a plain Discussion can read the repo it targets. Add
`coding: true` to open the coding tier on top, so Minds that declare the `code`
capability can run Bash, Edit, and Write, confined to the room cwd (the project
root, or the neutral home if the project vanished). The tool schema and the full
set of start fields live in
[Tools and commands](../../reference/tools-and-commands/).

## Choose a strategy

A strategy decides who speaks next. Chamber ships six:

- **sequential** rotates one speaker per turn, round-robin. The default.
- **concurrent** runs a whole round at once, every participant in parallel.
- **group-chat** is moderated: a moderator Mind routes and decides when to close.
- **open-floor** is unmoderated: each speaker nominates the next, and votes end it.
- **review** is a two-Mind, single-pass critique. The two Minds must be pinned to
  different providers, enforced when the room starts.
- **magentic** is manager-led: a manager Mind plans a task ledger and delegates each
  task to a worker, replanning until the goal is met.

Each strategy has its own required config and routing rules.
[Strategies](../../reference/strategies/) is the authoritative contract; this
guide only names them.

## Turn budget and concurrency

A room runs its own turns until it hits its budget or you stop it.

- **Turn budget** defaults to 8 and is capped at 50. Each turn is a billed agent
  call, so the ceiling keeps an over-large or accidental room from launching a
  runaway sequence. When a room finishes by exhausting its budget, every strategy
  except review appends one extra billed closing-synthesis turn, so it bills up to
  `turnBudget + 1` agent calls (51 at the cap). A room you stop early, or run as
  review, is unaffected.
- **Concurrency**: several rooms can run at once, up to six. Each gets its own
  panel on the surface and its own turn loop.

## Steer a live room

A room advances on its own, but you can steer it while it runs. The chat tool is
`chamber_room_say`, which takes one or more of:

- **`direction`**: guidance fed into the next speaker's prompt.
- **`callOn`**: nominate a current participant to speak next. The Mind must be an
  active participant in the room, or the call is rejected.
- **`text`**: a director message dropped into the transcript. It is always
  attributed to the director, never to a Mind, no matter what the payload says.

```ts
chamber_room_say({ direction: "focus on the failure modes, not the happy path" })
chamber_room_say({ callOn: "auditor" })
chamber_room_say({ text: "skip the preamble and get to the recommendation" })
```

On the board, the same controls appear as **Call on \<Mind\>** and **Stop**. To end
a room from chat, use `chamber_room_stop`. Stopping is reversible: you can start a
new room afterward.

:::note
A nomination or a director message changes who speaks or adds a director entry. It
never changes who *authored* a turn. The driver stamps the Mind it actually ran,
and no message can claim another speaker's identity.
:::

## The Rooms index

The Rooms index shows every room, active and closed.

- **Active rooms** appear as status-only cards alongside their own live panel,
  where the transcript streams as turns land.
- **Closed rooms** offer **Open** and **Delete**. Open reopens the transcript in a
  drawer, rebuilt from the saved log, with the room's start controls so you can
  relaunch a similar session. Delete is rejected while a room is active: stop it
  first.

Past rooms are kept as bounded history, so the index does not grow without limit.

## Related

- [Rooms and strategies](../../concepts/rooms/): the driver-as-router model behind a room.
- [Strategies](../../reference/strategies/): the contract for each of the six strategies.
- [Tools and commands](../../reference/tools-and-commands/): full schemas for the room chat tools.
- [Author a Mind](../author-a-mind/): create the participants a room runs.
