---
title: Author a lens
description: Render an agent-authored canvas board on a subject, and keep it current
sidebar:
  order: 5
---

A lens is a view a Mind authors itself: one agent turn composes a canvas board and
publishes it as a live panel, with no hand-coded UI. This guide is the operator
recipe for authoring one and keeping it current. For why a lens is a turn and not a
participant, see [Lenses](../../concepts/lenses/).

## Author one

There are two ways to author a lens, and both run the same single agent turn:

- **From chat or the command palette**, run `/lens {subject}`.
- **From the CLI**, run `keelson workflow run chamber-lens --arguments "{subject}"`.

Either path runs the `chamber-lens` workflow. The turn composes a board for the
subject and calls the emit tool once to publish it. The reply is one short line
naming the lens it authored; the board renders on the Chamber surface under the
**Lenses** group.

## A panel per subject

Each lens is keyed by a short id derived from the subject. Re-authoring the same
subject reuses that id, so the turn updates that panel in place rather than adding
another. There is no fixed pool of slots: every new subject gets its own panel.

The rib sets no limit on how many lenses can exist. The only ceiling is the
harness per-surface region limit. If adding a panel would exceed it, the emit
fails closed and unwinds cleanly, so a rejected lens never leaves a half-registered
panel behind. Retire a lens you no longer need to make room.

## Keep a lens current automatically

Re-authoring the same subject is the manual way to keep a lens fresh. A lens can also
keep itself current. Pass a `refresh` object when you author it, and the panel becomes
a **living lens** that re-composes on a cadence:

- `refresh: { workflow?, cadenceMs? }` makes the panel re-run a catalog workflow on
  cadence, feeding it the lens id. `workflow` defaults to `chamber-lens-refresh` (the
  bundled re-author), and `cadenceMs` defaults to one hour, floored at 30 seconds.
- On a re-author, omitting `refresh` keeps the existing backing, an object patches it
  (an omitted field keeps its prior value), and `refresh: null` clears it.

A living lens also carries an on-demand **Refresh** verb on its panel head, so you can
force a re-compose between cadence ticks. Each refresh is a paid agent turn, so the
default cadence leans quiet. For how a refresh turn re-reads and re-emits the board,
see [A living lens re-composes itself](../../concepts/lenses/#a-living-lens-re-composes-itself).

## Provenance on the index card

A lens can carry three optional provenance fields, all supplied by the authoring
turn:

- **`scope`** names the board's kind in a word or two, for example "status board",
  "timeline", or "checklist". It renders as a calm pill on the card.
- **`reason`** is a short note on what this authoring changed, for example "added
  two new risks". It renders as a "changed" line, and is meant to be omitted on a
  first author.
- **`maintainingMind`** is the authoring Mind's own name. It renders first on the
  card, labeled "by".

The card also shows an "updated" time. That value is stamped by the server when
the lens is saved, not supplied by the turn, so it always reflects the real last
write.

The `chamber-lens` workflow prompt asks the turn for `id`, `board`, `scope`, and
`reason`, so a lens authored through the workflow usually carries no
`maintainingMind`. That field is filled when `chamber_emit_lens` is called directly,
for example from chat, and it is preserved across a `chamber-lens-refresh`.

:::caution
Provenance is replace-on-write. Re-authoring a lens without a field that was set
before clears the old value. If you want a `scope` or `reason` to persist, supply
it every time you re-author the subject.
:::

## Tabling a deliverable mid-room

A Mind cannot author a lens during a room turn: `chamber_emit_lens` is never on a
room turn rail. What a Mind can do mid-room is table an **exhibit**, a point-in-time
deliverable (a findings summary, an assessment, a plan) that lands on the Exhibits
shelf. This is opt-in per Mind: only a Mind that declares the `lens` capability gets
the exhibit tool on its turn rail. The slug keeps the historical name `lens`, but it
now authorizes `chamber_table_exhibit`, not lens authoring. A text-only Mind, the
room default, cannot table one. To declare the capability, see
[Author a Mind](../author-a-mind/).

An exhibit is not a lens, and the two carry provenance differently. The exhibit tool
takes only `{ id, board, reason? }`: there is no `maintainingMind` field, so a Mind
cannot sign an exhibit. Instead the room driver witness-stamps the exhibit with the
room it came from, so provenance is observed, not claimed. For the full lens/exhibit
split, see [Exhibits](../../concepts/lenses/#exhibits-the-deliverable-sibling).

## Let viewers annotate a lens

A board can let a viewer append a short note to the lens without re-authoring it.
Include an `actions` section in the board with one action whose `type` is
`"lens-note"`, `payload` is `{ id: "<this-lens-id>" }`, and a single multiline
field named `note`. Submitting the form appends the note to the lens's board in
place (no agent turn, no cost).

This is a deterministic write-back, not a re-prompt. The annotation does not
promote the standing briefing (that path is reserved for Mind-authored substance).

## Retire one

A lens can always be retired. Use the **Retire** action on the lens card, the
**Retire lens…** verb on the lens panel head, or call the `chamber_retire_lens` tool
with the lens id. Each removes the persisted lens record and its live panel together.
Retiring an id that does not exist fails closed.

Unlike a room, a lens has no active state, so there is nothing to stop first: a
retire takes effect immediately.

## How retiring relates to the briefing

The standing briefing on the surface footer is also an agent-authored board, but it
is not a per-subject lens. It is rib-driven and runs on demand. Its turn is promoted
only when a room ends or a lens changes since the last briefing, which keeps a paid
turn from firing on every surface refresh.

Authoring or re-authoring a lens counts as a change and can promote the briefing.
Retiring a lens does not: a retire alone never triggers a briefing turn. So if you
clear out stale lenses, the footer stays as it was until the next real change.

## Related

- [Lenses](../../concepts/lenses/): why a lens is a turn, not a participant, and how an exhibit differs.
- [Author a Mind](../author-a-mind/): declare the `lens` capability so a Mind can table an exhibit mid-room.
- [Workflows](../../reference/workflows/): the `chamber-lens` and `chamber-lens-refresh` workflow contracts.
- [Tools and commands](../../reference/tools-and-commands/): the emit and retire tool schemas.
