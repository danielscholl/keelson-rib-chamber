---
title: One manager, many tasks
description: Convene a magentic room where a manager decomposes a build into a task ledger, hands each task to a worker, and leaves a plan with no gaps and no overlap — then build from it.
sidebar:
  order: 5
---

In [Many minds, one plan](../many-minds-one-plan/) a room *reviewed* a plan
someone else wrote: a moderator drove a panel to red-team a contract and catch its
defects. This tutorial uses a different shape for the opposite job — *producing* the
plan in the first place, when the build is big enough that one planner leaves holes.

A `magentic` room puts a **manager** in charge. The manager does not debate; it
decomposes. It breaks the goal into a small task ledger, hands each task to the
worker whose lane fits, and replans until the goal is covered. Where an open-floor
room has everyone talk about everything — and two voices often cover the same
ground while a third area goes untouched — the manager guarantees every part of the
build is owned by exactly one worker. That is the shape you reach for when you mean
to **build** something, not just discuss it.

By the end you will have convened a magentic room on a build brief, watched a
manager carve the work into non-overlapping tasks, read back a plan with no gaps and
no overlap, and turned it into a running app.

:::note[Before you start]
A running keelson server with the Copilot provider signed in, Chamber installed,
and the earlier room tutorials behind you ([your first room](../your-first-room/)
and [a moderated room](../a-moderated-room/)). Every room turn is a paid agent call,
so expect to spend real tokens. You also need a **build brief** — a spec for
something with separable parts (a UI with a visual layer and an interaction layer,
an API with separable endpoints). This page uses the Cosmos app brief from the
keelson [frontend-mix tutorial](https://danielscholl.github.io/keelson/docs/tutorials/frontend-mix/),
but any multi-part build works.
:::

## When one planner leaves holes

A single planning model goes deep on the parts it finds interesting and thin on the
rest. Put two minds in a free discussion and they tend to cover the same ground
twice while a third area gets nothing. For a build, those are the two failures you
cannot afford: a **gap** the build then has to guess at, and an **overlap** the
build implements twice. A manager fixes both by *assigning*. It decides the lanes
up front, and each worker owns exactly one — so coverage is complete and nothing is
said twice.

## Author a manager and workers

A magentic room needs a **manager** and two or more **workers**. The manager isn't
one of the workers — it drives the room but never owns a lane. Author them with
[genesis](../../concepts/minds/). Give the manager a decomposition mandate, and give
each worker a distinct lane, so the manager has clean seams to cut along:

```text
/genesis A delivery manager who decomposes a build into a small task ledger, assigns each task to the worker whose lane fits, and replans until the goal is covered with no gaps and no overlap.
/genesis A visual design engineer who owns the look: layout, palette, type, and how things are rendered.
/genesis A frontend engineer who owns structure: the view map, components, state, and the interactions.
```

Genesis names each Mind from its brief, so yours will get their own names — note
the three you get back, you will name them when you convene.

The pin below is optional: a magentic room runs fine with every Mind on one model.
But the design lane is the one that most rewards a UI-strong model, so it is worth
pinning one there. After genesis, open the design worker's card on the Chamber
surface and use its **Set model…** action, or pre-pin at authoring time with
workflow inputs:

```text
keelson workflow run chamber-genesis "a visual design engineer who owns the look: layout, palette, type, and rendering" --inputs model=gemini-3.1-pro-preview --inputs provider=copilot
```

Either way the pin is one optional step; it just makes the lane the design worker
owns stronger where it matters most.

## Convene the magentic room

A magentic room needs the `magentic` strategy and a `manager` that is **not** one of
the workers — the same rule a moderator follows: it drives the turns, it never takes
a lane. Naming a manager with no strategy infers `magentic` for you, the way naming a
moderator infers `group-chat`. In chat, substitute the three names genesis gave you
and paste your own build brief where the topic points:

```text
Start a magentic room with <design-worker> and <frontend-worker>, managed by <manager>.
Topic: decompose and plan the build of my app. <paste your build brief here>. Each
worker must return a buildable spec for its lane — named sections, exact values,
concrete layout — not a mood board.
```

For the Cosmos example, the brief to paste is the full spec the keelson
[frontend-mix](https://danielscholl.github.io/keelson/docs/tutorials/frontend-mix/)
tutorial ships. Starting from chat is a confirm-gated dry run, because every turn is
billed. Confirm, and the manager takes the first move.

## Watch the manager split the work

The first thing the manager does is not talk — it **plans**. It writes a task
ledger (persisted as `ledger.json` beside the transcript, so it survives a restart)
and assigns each task to a worker. Read the transcript top to bottom and watch the
seams the manager cuts:

**The manager's opening turn is the decomposition.** You will see it not weigh in on
the design but divide the work and route it — typically into two non-overlapping
lanes. An opening turn looks something like this (an illustration — yours will name
your own workers and lanes):

> I'll split this into two parallel design tracks, anchored to the visitor's jobs.
> The design worker owns the visual foundation — palette, type, and how the cosmos
> is rendered procedurally; this gates everything else's look. The frontend worker
> owns the interaction surfaces — the view map plus how browse, filter, search,
> detail, and the reaction are laid out as concrete components. Both must produce
> buildable specs, not mood boards.

**Each worker then settles its assigned task — and only its task.** Each should
return only its lane: the design worker the palette hexes, the type pairing, and the
procedural render recipes; the frontend worker the view map, the filter logic, and
the detail layout. Because the manager assigned non-overlapping lanes, neither one
re-covers the other's ground, and neither leaves a hole the other was supposed to
fill.

**When every task has settled, the manager closes or replans.** If the goal is
covered, it closes the ledger and the room ends; if a lane is thin or a seam was
missed, it hands back to itself and assigns the gap. The loop is bounded by the turn
budget like every other room.

## Read the result — coverage without overlap

Lay the workers' turns side by side and you have a single complete spec: every part
of the build is owned, and nothing is owned twice. That is the magentic payoff. A
moderated room spends its turns driving a *discussion* to a decision; a magentic room
spends its turns making sure the *plan* has no gaps and no duplication — which is
exactly what a plan-as-contract needs before a build implements it.

:::tip
A worker's spec can be long, and the Chamber surface and `chamber_room_status` show
each turn bounded for readability. To copy a worker's full spec verbatim — to feed it
to a build — read the turn straight from the room's transcript on disk. See
[Data on disk](../../reference/data-on-disk/) for the path.
:::

## Build from it

The room is text-only: the Minds plan, you build. Two ways to turn the spec into a
running app:

- **Hand it to the keelson build.** Paste the consolidated spec back as `plan.md` and
  run the [frontend-mix](https://danielscholl.github.io/keelson/docs/tutorials/frontend-mix/)
  workflow, the same plan-then-build handoff
  [Many minds, one plan](../many-minds-one-plan/) uses for its reviewed contract.
- **Or have a Mind build it.** Author a build-engineer Mind, pinned to a UI-strong
  model, and convene a room of two with a **turn budget of 1** (see
  [Run a room](../../guides/run-a-room/) for the budget control) — only the first
  speaker runs, so its single turn is the whole build. Ask it to implement the spec
  as one self-contained file. That turn *is* the file: read the full turn from the
  transcript on disk (the [Data on disk](../../reference/data-on-disk/) path),
  save it as `index.html`, and open it.

Either way, the plan the manager assembled is the contract the build implements.
Because it has no gaps, the build has nothing to guess at; because it has no overlap,
nothing gets built twice.

## What you proved

A magentic room is the shape for a build. Where a sequential room layers an analysis
and a moderated room drives a discussion to a decision, a manager-led room treats the
goal as *work to be divided*: it cuts the build into lanes, gives each lane one owner,
and replans until the whole is covered. The plan it leaves behind is complete and
non-redundant — the contract a build can implement cleanly, assembled by a room
instead of a single planner who would have gone deep in one place and thin
everywhere else.

## Related

- [When to convene a room](../../concepts/when-to-convene-a-room/): which of the six strategies fits which decision.
- [Many minds, one plan](../many-minds-one-plan/): the sibling job — *review* a plan with a moderated room, rather than *produce* one with a manager.
- [Run a room](../../guides/run-a-room/): the operator how-to once you know the shape.
- [Room strategies](../../reference/strategies/): magentic's exact contract — the manager, the ledger, and the routing.
- [One workflow, many models](https://danielscholl.github.io/keelson/docs/tutorials/frontend-mix/): the keelson build this plan can feed.
