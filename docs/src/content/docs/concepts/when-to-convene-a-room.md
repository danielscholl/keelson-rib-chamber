---
title: When to convene a room
description: The decisions a single agent cannot check on its own, and which of the five strategies fits each one.
sidebar:
  order: 2
---

A single agent is good at doing the work. Give it a clear task and it executes.
It is weakest at the calls that have no built-in check: whether a plan is sound,
whether a design is right, whether the last step quietly carried a wrong
assumption forward as if it were true. Those are the calls a room is for.

Convene a room when a confident wrong answer would cost more than the few extra
turns spent arguing it out.

## What a room catches that one pass cannot

A single agent, or a linear chain of them, can be completely self-consistent and
still be wrong. Each step trusts the step before it, and unless you build a challenge
into the chain, nothing in it is asked to question the premise. A wrong assumption made early is not caught
later. It is inherited, implemented faithfully, and validated against itself, so
the whole run finishes green while the result stays wrong.

A room makes disagreement a first-class step. You put a second mind in the loop
whose job is to break the first one's output rather than agree with it. That mind
never inherited the premise, so it can see what the chain cannot. Consistency is
not the same as correctness, and only a challenger tells the two apart.

The [Many minds, one plan](../../tutorials/many-minds-one-plan/) tutorial is the
worked proof. It takes the plan a solo workflow wrote for a real app, convenes a
room to red-team it, and the room catches a data-contract defect that had passed
every downstream check.

## A room is not a workflow

Rooms do not replace
[workflows](https://danielscholl.github.io/keelson/docs/concepts/workflows/). A
workflow is the right tool for a repeatable operation you want to run the same way
every time. A room is the right tool for the generative work around it:
exploration, debate, a second opinion, red-teaming a decision before you commit to
it.

The two compose. A workflow can produce an artifact and a room can harden it. A
room can reach a decision and a workflow can carry it out. Keelson already owns the
deterministic half; Chamber adds the deliberative one.

## Which strategy fits the decision

The five strategies are five shapes of conversation. Pick by the kind of thinking
you want, not by the count of minds.

- **Sequential** runs one speaker per turn, round-robin. Reach for it when each
  turn should build on the last, like a layered analysis. It is the default.
- **Concurrent** runs every mind on the same moment at once, before any of them
  hears the others. Reach for it when you want independent first takes, not a
  discussion that anchors on whoever spoke first.
- **Group-chat** hands routing to a moderator that shapes the discussion toward a
  decision and closes it. Reach for it when you want a panel driven to one
  recommendation with someone keeping it on track.
- **Open-floor** lets the speakers route themselves and stop when enough of them
  vote to end. Reach for it for open brainstorming with no one in charge.
- **Review** is a single cross-vendor pass: one provider's model authors, another's
  reviews, and the two must be pinned to different providers. Reach for it when you
  want a genuinely independent second opinion, the read a model will not give you on
  its own output.

[Rooms and strategies](../rooms/) explains how the driver runs these, and the
[strategies reference](../../reference/strategies/) is the exact contract.

## The cost is real, and bounded

Every turn in a room is a paid agent call, so a room is bounded on purpose. It runs
to a turn budget with a hard ceiling, and starting one from chat is a confirm-gated
dry run by default: the tool reports what it would run and launches nothing until
you approve. Convene a room when the decision earns the turns. When the work does
not need a second mind, one agent is cheaper and just as good.

## Related

- [Many minds, one plan](../../tutorials/many-minds-one-plan/): the worked proof, a
  room hardening a real plan.
- [Rooms and strategies](../rooms/): how the driver routes turns and why strategies
  stay pure.
- [Room strategies](../../reference/strategies/): the exact contract for all five
  strategies.
- [Keelson workflows](https://danielscholl.github.io/keelson/docs/concepts/workflows/):
  the deterministic half a room complements.
