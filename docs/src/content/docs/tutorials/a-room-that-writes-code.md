---
title: A room that writes code
description: Open the coding tier on a room, hand a build Mind one scoped backlog item, and watch it change a real project while a reviewer reads behind it
sidebar:
  order: 6
---

Every room so far reasoned, and you carried the results into the world
yourself: the red-team's five changes were yours to apply, the manager's plan
was yours to build. That division is the default on purpose. But Chamber can
lift it. A **coding room** lets a Mind that declares the `code` capability run
Bash, Edit, and Write inside its turn, confined to the project the room
targets. This page opens that tier deliberately, hands a build Mind one scoped
change, and puts a reviewer behind it, so the first time agents touch your
tree, you watch every layer of the machinery that keeps it bounded.

By the end you will have a real diff in a real project, produced by one Mind
and read by another, and you will have verified it the only way that counts:
by running the app.

:::note[Before you start]
A running keelson server with Copilot signed in, Chamber installed, and the
earlier room tutorials behind you. You also need a registered project you are
comfortable letting an agent edit. The natural one is the Cosmos app the
[keelson tutorial rail](https://danielscholl.github.io/keelson/docs/tutorials/frontend-mix/)
builds: its template ships a
[backlog](https://github.com/danielscholl/keelson-sample/blob/main/backlog.md)
of scoped items written for exactly this kind of session. Any real repository
works; just bring a bounded change you can verify. A coding turn runs longer
and spends more than a talk turn, so budget accordingly.
:::

## Text-only is the default, and that is a feature

A room's file access is tiered, and each tier is an explicit grant:

| Tier | How it opens | What a Mind can do |
| --- | --- | --- |
| Text-only | every room, by default | converse; nothing else |
| Project read | start the room with a `projectId` | read files under the project root; auto-granted to every speaker |
| Coding | add `coding: true` to a project room | Minds that declare `code` also run Bash, Edit, and Write, confined to the project root |

Two details matter before you open the third tier. First, the write tier's
capability gate is per-Mind: `coding: true` opens it on the room, but only a
Mind whose own record declares `code` can run Bash, Edit, or Write. Every
speaker in a project room already holds the read tier; a Mind without `code`
keeps that read access and nothing more. Second, the Convene panel's Build
tab targets a project (that is
the read tier) but never opens the coding tier. Opening it is a deliberate
act you take from chat or the `chamber_room_start` tool, where the flag is
spelled out in the call you confirm.

## Author the pair

You need a builder and a reader. Genesis assigns capabilities when the brief
asks for them, so ask:

```text
/genesis A hands-on build engineer who implements one scoped change at a time,
verifies it by running the project's own checks, and reports exactly what was
changed and why. Give it the read and code capabilities.

/genesis A skeptical code reviewer who reads what actually changed, judges it
against the stated task, and tables a written verdict. Give it the read and
lens capabilities.
```

Genesis names your Minds; note the two slugs. Check the roster cards: the
builder should carry `code`, the reviewer `read` and `lens` (the `lens`
capability is what lets it publish a verdict later). If you already have Minds
with those tools listed on their cards, reuse them.

Pinning is optional but pays here the way it pays in a magentic room: a
gpt-class model on the builder (direct, literal coding is its strength) and a
reasoning-class model on the reviewer buys you an implementation and a
critique that do not share reflexes.

## Pick the work

One item, small enough to read as one diff. From the Cosmos backlog, item 4
is the right shape:

> **Keyboard navigation (medium).** Let a keyboard visitor move through the
> catalog: previous/next between objects from a detail view, and a key to
> return to the catalog. Do not steal keys while a text input is focused.
> Accept when: you can open an object, walk the whole catalog without touching
> the mouse, and typing in the search field never triggers navigation.

Notice what the item does not say: which file, which framework, which
component. Every Cosmos build is different, so the item is written against
the spec, and finding the seam in *your* build is part of the builder's job.
That is not a gap in the tutorial; it is the actual work.

## Start the coding room

Make sure the project is registered, and note its **id**: the UUID
`keelson project add` prints when it registers (and `keelson project list`
prints thereafter):

```sh
keelson project add cosmos ~/code/my-frontend-mix
```

The `projectId` field below takes that id or the project name: the tool
resolves either against your project list, the same as the Convene panel, and
rejects an unresolvable one with an `unknown project` error that names where to
find a valid id.

Next, one operator move the room cannot do for you. The room confines writes
to the project root, but it does not manage your branches, so give the
session its own branch before anything is granted write access:

```sh
git switch -c room/keyboard-nav
```

Now start the room from chat. The start is a dry run until you confirm, so
ask for it without `confirm` first:

```json
{
  "participants": ["<builder>", "<reviewer>"],
  "topic": "Implement backlog item 4, keyboard navigation, exactly as written in backlog.md. Builder: find where the catalog and detail views live in this build, implement the item, run the project's checks, and report what changed file by file. Reviewer: read what actually changed, judge it against the item's acceptance check, and say plainly what you would still fix.",
  "projectId": "<your-project-id>",
  "coding": true,
  "turnBudget": 8
}
```

The dry run reports exactly what would open, names the coding tier, and
starts nothing. This is one report worth reading twice, because you are
granting write access. The strategy is the default `sequential`, so the two
Minds will alternate: build, review, respond, review again. `coding: true`
requires the `projectId`; a coding room with no project has nothing to
confine to and is rejected. When the report reads right, re-call the tool
with `confirm: true` added, and the room opens.

## Watch a turn that edits

The builder's first turn looks different from every turn you have watched so
far. It runs long, and while it runs the Mind is reading your tree, editing
files, and running commands inside that single turn. When the turn lands, the
transcript holds the builder's *account* of what it did. The tree holds what
it *did*. Keep those two straight: the transcript is the room's record of the
conversation, and the working tree is the record of the work.

Then the reviewer speaks, and the tiering shows its shape. The reviewer holds
the read tier, so it opens the files as they now sit and judges the change
against the item. It has no shell, so it cannot run `git diff` or the test
suite; it reads code and reasons. If its verdict asks for a fix, the builder's
next turn takes it, the same transcript-mediated exchange every room runs,
except the concession lands as an edit instead of a sentence.

You are still the director the whole way. `chamber_room_say` steers a coding
room exactly like a talk room:

```text
Direction: the search input still captures arrow keys. Fix the focus guard
before anything else.
```

:::caution[If the room misbehaves]
The failure modes are the tiers, misread. A rejected start with `coding: true`
usually means no `projectId` at all: a coding room has nothing to confine to
without one, and an unresolvable `projectId` (neither a known id nor a project
name) is rejected with an `unknown project` error. A
builder that talks about the change but edits nothing is missing the `code`
capability: check its roster card's tools list, and re-author it with the
brief asking for `read` and `code`. And a room that hits its budget mid-fix
is normal, coding turns are heavy; stop it, raise `turnBudget`, and convene
again. The branch you cut keeps a half-landed session harmless.
:::

## Table the verdict as an exhibit

One more move closes the loop, and it has to happen **while the room is
still live**: a stopped or exhausted room no longer takes a steer. Your
reviewer declared the `lens` capability,
which authorizes one tool inside a room turn: `chamber_table_exhibit`, which
publishes a canvas board as an **exhibit**, a room's tabled deliverable.
Once the review turns have settled the verdict, steer, pairing the direction
with a `callOn`:

```ts
chamber_room_say({
  callOn: "<reviewer>",
  direction: "Table an exhibit with your verdict: the item, what changed, the acceptance result, and anything still open.",
})
```

The `callOn` matters. A bare direction lands on whoever speaks next, and in a
sequential room that may be the builder, which does not hold `lens` and
cannot table anything (the capability gate is per-Mind, and it holds even
when the director asks). Calling on the reviewer hands it the turn and the
direction together.

The exhibit lands on the Chamber surface's Exhibits index, and its provenance
is worth noticing: the producing room is stamped by the driver, which
witnessed the tool run inside a turn it ran. The exhibit says which room
tabled it because the driver saw it happen, not because the board claims so.
Long after the room panel rolls off the surface, the verdict card remains,
pointing back at the session that produced it. See
[Exhibits](../../concepts/lenses/#exhibits-the-deliverable-sibling) for the
capability.

With the exhibit tabled, let the room run out its budget, or stop it from
the room panel (or `chamber_room_stop`); stopping is reversible, and the
transcript stays as bounded history either way.

## Verify like an operator

The room's claim is not the proof. When the room closes, verify the way you
would verify a colleague's branch: the summary first, then the actual edits,
then the running app.

```sh
git status
git diff --stat
git diff
bun run dev
```

Then walk the item's own acceptance check: open an object, traverse the whole
catalog from the keyboard, click into the search field and type. If the
change holds, commit it; if it does not, you have a transcript that tells you
what the builder thought it was doing, a diff that shows what it actually
did, and a reviewer's verdict on the gap. That triangulation is exactly what
a solo coding agent does not leave behind.

## What you proved

The gap between a room that reasons and a room that acts is one flag and one
capability, and everything else stays the machinery you already know: the
driver routes, the transcript records, the budget bounds, the director
steers. What changed is confinement made explicit, a tier the room opens only
when you spell it out, a capability only the Minds you authored for it carry,
and a branch you cut because the operator's own discipline is part of the
system too. You have now run the full arc a plan can travel through Chamber:
reviewed by a panel, produced by a manager, implemented by a builder, judged
by a reader, and verified by you.

A standing team that runs this build-review-verify loop as a matter of
policy, with gates on every pass, is a different rib's job: the
[Squad rail](https://danielscholl.github.io/keelson-rib-squad/tutorials/)
picks up the same project from here. Within Chamber, one tutorial remains:
the capstone, where you stop driving rooms and write the routing policy they
run on.

## Related

- [Author a room strategy](../author-a-room-strategy/): the capstone, the pure policy behind every room you have run.
- [One manager, many tasks](../one-manager-many-tasks/): the magentic room whose plan a coding room can implement.
- [Run a room](../../guides/run-a-room/): the full `chamber_room_start` field set, including `projectId` and `coding`.
- [Author a Mind](../../guides/author-a-mind/): the capability vocabulary (`read`, `code`, `lens`) and what each slug authorizes.
- [Exhibits](../../concepts/lenses/#exhibits-the-deliverable-sibling): the tabled deliverable the reviewer publishes.
