---
title: Author a lens
description: Render an agent-authored canvas board on a subject, and keep it current
sidebar:
  order: 5
---

A lens is a view a Mind authors itself: one agent turn composes a canvas board and
publishes it, with no hand-coded UI. This guide is the operator recipe for
authoring one, deciding whether it earns a place on the surface, and keeping it
current. For why a lens is a turn and not a participant, see
[Lenses](../../concepts/lenses/).

## Author one

There are two ways to author a lens, and both run the same single agent turn:

- **From chat or the command palette**, run `/lens {subject}`.
- **From the CLI**, run `keelson workflow run chamber-lens --arguments "{subject}"`.

Either path runs the `chamber-lens` workflow. The turn composes a board for the
subject and calls the emit tool once to publish it. The reply is one short line
naming the lens it authored, and it lands as a card in the **Lenses** index, where
**Open** reads it in the drawer.

## A card per subject, a panel by choice

Each lens is keyed by a short id derived from the subject. Re-authoring the same
subject reuses that id, so the turn updates that lens in place rather than adding
another. There is no fixed pool of slots: every new subject gets its own card.

Authoring does not put a lens on the Chamber surface. It takes a panel there only
when you **Pin** it, which promotes it to a full-width row, collapsed to its head
strip. Unpin puts it away and leaves the record, the card, and Open untouched.
Pinning is the operator's alone: it is not on `chamber_emit_lens`, is not an MCP
tool, and is not reachable from an HTML lens's iframe, because a page that could
pin itself is exactly the clutter pinning removes.

The rib sets no limit on how many lenses can exist, or how many may be pinned. The
only ceiling is the harness per-surface region limit. If adding a panel would
exceed it, the emit fails closed and unwinds cleanly, so a rejected lens never
leaves a half-registered panel behind.

:::note[Upgrading]
Lenses authored before pinning existed carry no `pinned` field, and absent means
unpinned. The Chamber surface clears itself on upgrade, and you pin back the one or
two you actually want on screen. There is no migration.
:::

## Keep a lens current automatically

Re-authoring the same subject is the manual way to keep a lens fresh. A lens can also
keep itself current. Pass a `refresh` object when you author it, and it becomes a
**living lens**:

- `refresh: { workflow?, cadenceMs?, inputs? }` names the workflow to re-run,
  feeding it the lens id plus any `inputs` you name. `workflow` defaults to
  `chamber-lens-refresh` (the bundled re-author), and `cadenceMs` defaults to one
  hour, floored at 30 seconds.
- On a re-author, omitting `refresh` keeps the existing backing, an object patches it
  (an omitted field keeps its prior value), and `refresh: null` clears it.

What fires it depends on whether the lens is pinned. A pinned lens ticks on its
cadence while the Chamber surface is open in a browser, because the cadence wiring
lives on the panel. An unpinned one re-composes on demand only, from the
**Refresh** verb on its index card.

That coupling is the point rather than an accident. Each tick of the bundled
re-author is a billed agent turn, so pinning is what bounds that spend to the views
you chose to keep in front of you. A refresh backing is still worth setting on a
lens you have not pinned; it just will not tick on its own until someone does. A
workflow of your own costs whatever you built it out of, down to nothing if it is
deterministic. For how a refresh turn re-reads and re-emits the board, see
[A living lens re-composes itself](../../concepts/lenses/#a-living-lens-re-composes-itself).

## Name a workflow the panel can actually run

The bundled authors can read files: `Read`, `Glob`, and `Grep`, and nothing else.
So a lens over a repo, a report, or a facts file is grounded in the thing itself,
and the bundled re-author re-reads that file rather than restating the board it
already wrote. What it cannot do is run a command or reach anything live.

That is where the line falls. A lens whose content is a **live or external**
measurement needs a refresh workflow of its own, and one constraint decides where
that workflow can live: the harness runs a panel's refresh only for a
**rib-contributed** workflow, so a file in the global workflows dir will never drive
a cadence, however correct it is.

Chamber contributes yours for you. A workflow file in
`{keelson-home}/rib-chamber/lens-workflows/` becomes `chamber-lens-{filename}`, which
a lens may then name. See
[A data lens names a workflow of its own](../../concepts/lenses/#a-data-lens-names-a-workflow-of-its-own)
for the rule, the trust boundary, and why the constraint exists.

An HTML lens takes the same backing, with one difference: its `refresh` must name a
`workflow`. There is no bundled re-author for a page to fall back on, so a living
HTML lens is always one your own producer keeps current.

## Provenance on the index card

A lens can carry three optional provenance fields, all supplied by the authoring
turn:

- **`scope`** names the board's kind in a word or two, for example "status board",
  "timeline", or "checklist". It renders as a calm pill on the card, when the card
  has a pill to spare: only one fits, and a pinned lens wears `pinned` instead,
  because where the lens is outranks what kind it is when you are scanning the
  index.
- **`reason`** is a short note on what this authoring changed, for example "added
  two new risks". It renders as a "changed" line, and is meant to be omitted on a
  first author.
- **`maintainingMind`** is the authoring Mind's own name. It renders first on the
  card, labeled "by".

The card also shows an "updated" time. That value is stamped by the server, never
supplied by the turn, and it records exactly one thing: when the **board** last
changed. A re-author that leaves the board structurally unchanged keeps the old
time rather than claiming a fresh one.

Read it for what it is. It is not a "last checked" time, and it cannot be: a
refresh that genuinely re-measures and finds the same numbers keeps the old stamp,
so a current board can read as old. That is the deliberate trade. The card cannot
tell a real re-measurement from a cosmetic re-emit, and of the two possible lies,
"nothing has changed since then" is the safer one. A lens that needs to assert when
its data was gathered should say so in the board itself, as a "data as of" line it
composes.

The `chamber-lens` workflow prompt asks the turn for `id`, `board`, `scope`, and
`reason`, so a lens authored through the workflow usually carries no
`maintainingMind`. That field is filled when `chamber_emit_lens` is called directly,
for example from chat, and it is preserved across a `chamber-lens-refresh`.

:::note
`scope` and `maintainingMind` are the lens's durable identity: re-authoring without
them keeps the existing values, and you clear one by passing `null`. `reason` is the
opposite, because it describes a single authoring: omit it and it clears, rather
than captioning the next revision with the last one's story.
:::

## Tabling a deliverable mid-room

A Mind cannot author a lens during a room turn: `chamber_emit_lens` is never on a
room turn rail. What a Mind can do mid-room is table an **exhibit**, a point-in-time
deliverable (a findings summary, an assessment, a plan) that lands in the **Tabled**
section of its own room's board. This is opt-in per Mind: only a Mind that declares the `lens` capability gets
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
**Retire lens…** verb in a pinned panel's head **⋯** menu, or call the
`chamber_retire_lens` tool with the lens id. Each removes the persisted lens record
and any panel it holds together. Retiring an id that does not exist fails closed.
An unpinned lens has no panel head, so its card is the only surface path.

Unlike a room, a lens has no active state, so there is nothing to stop first: a
retire takes effect immediately.

## How retiring relates to the briefing

The standing **Briefing** is also an agent-authored board, but it is not a
per-subject lens. It is rib-driven, and nothing runs it on demand: its gate is the
only path that may spend its turn, and every trigger is a Chamber mutation. That
turn is promoted only when a room ends or a lens changes since the last briefing,
which keeps a paid turn from firing on every surface refresh.

Authoring or re-authoring a lens counts as a change and can promote the briefing.
Retiring a lens does not: a retire alone never triggers a briefing turn. So if you
clear out stale lenses, the Briefing stays as it was until the next real change.

## Related

- [Lenses](../../concepts/lenses/): why a lens is a turn, not a participant, and how an exhibit differs.
- [Author a Mind](../author-a-mind/): declare the `lens` capability so a Mind can table an exhibit mid-room.
- [Workflows](../../reference/workflows/): the `chamber-lens` and `chamber-lens-refresh` workflow contracts.
- [Tools and commands](../../reference/tools-and-commands/): the emit and retire tool schemas.
