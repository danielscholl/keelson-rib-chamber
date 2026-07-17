---
title: The Chamber surface
description: The Chamber nav surface, its standing regions, the snapshot keys behind them, and the dynamic panels added at runtime
sidebar:
  order: 2
---

Chamber is a Keelson rib. It contributes one nav surface and the snapshot keys
that fill it. This page is the contract for that surface: the standing regions,
their bound keys and producers, the panels added at runtime, and the canvas
views.

The surface has a stable identity:

| Field | Value |
|---|---|
| `id` | `chamber` |
| `title` | `Chamber` |

The surface sets no `subtitle`, and declares no heading of its own. The nav tab
already names it, and the host renders no page-identity header for a surface
carrying neither a subtitle, a heading, nor a project chip. Chamber's header
collapses to nothing and its panels carry their own identity.

## Standing layout

The surface declares four standing regions: the Chamber panel, the Briefing, and
the two columns of its one standing row, Rooms and Lenses at half width each. Each
binds a snapshot key. The two index collectors carry a workflow binding and a
120000 ms cadence so they self-populate on open and refresh without being hammered.
The Chamber panel and the Briefing have no workflow: both are rib-driven and
recomposed in-process, and the panel recomposes on any roster, rooms, or draft
mutation. The Briefing has two publish paths: it is re-published on every mutation
so its record and digest registers stay current, and its attention gate separately
promotes or lapses the delta register.

| Region | Key | Workflow | Cadence (ms) | Collapsible | Glyph |
|---|---|---|---|---|---|
| Header | `rib:chamber:presence` | none (rib-driven) | none | yes | `◈` brand |
| Row 1 (full width) | `rib:chamber:brief` | none (rib-driven) | none | yes | `❖` brand |
| Row 2, column 1 | `rib:chamber:rooms` | `chamber-rooms` | 120000 | yes | `▦` brand |
| Row 2, column 2 | `rib:chamber:lenses` | `chamber-lenses` | 120000 | yes | `✦` accent |

The Briefing rides a full-width row rather than the `banner` slot, because a banner
is contractually uncollapsible (the banner region schema omits the flags) and the
operator has to be able to fold the narrator. A lone column stretches to the row's
full width, so it renders exactly where a banner would.

### How a panel opens

`collapsed` decides how a panel *opens* on a visit. The SPA takes it as a
mount-time initial value only, so it never folds under the operator mid-session,
and it cannot remember a manual expand.

Two regions set it. The Chamber panel is the focal panel only while the bench is
still being built: at two Minds there is a cast to convene, so from there it opens
folded and the standing row leads the daily view. Below that it opens expanded,
because there is nobody to convene yet and the panel is still the thing you came
to use. Its own compose sets the flag, which already reads the bench on every
roster mutation, which is exactly when assembly can change. The flip reaches the
client through the host's `invalidateManifest` seam, and only when the value
actually moves, so an idle recompose does not make every subscribed client
re-fetch. On a harness without that seam the change lands on the next reload.

The Briefing is collapsible but never auto-folds. It is the one narrator, so it
opens on every visit and folds only when the operator says so.

A panel is for what is continuously true; you enter what is happening. That is why
the standing layout holds two indexes and no room: a room is an activity you open
from its card. A lens is the middle case. By default it is a key plus an index
card, read in the drawer, which is the shape an exhibit has always had; it takes a
standing panel only when an operator pins it.

The Rooms index lists active rooms first, then closed ones. Every card carries
Open. An active room's Open focuses the live per-slug key its driver publishes to,
so the drawer streams turns as they land; a closed room's rebuilds a frozen board
from the persisted transcript. An active card carries Open alone. A closed one adds
the destructive Delete, because the delete handler refuses a live room, and adds
**Summary** when the room actually left an outcome to render. A card also names the exhibits its
room tabled (a `tabled` field, joined on the witnessed `sourceRoom` slug) but links
none of them open: an exhibit is opened from the Tabled section of its own room's
board.

## Dynamic regions

Pinned lenses and pinned per-subject HTML lenses are not in the static layout. A
producer registers each one at runtime with `registerRegion`, so the surface grows
panels as lenses are **pinned**, and sheds one when a lens is unpinned or its
record is retired. Authoring a lens does not add a panel: every lens registers its
key, and only a pinned one registers a region.

That predicate is what bounds the cost. A region carries the refresh wiring, and
lens regions are args-bearing, which the server heartbeat skips, so refresh is
client-driven and runs above the collapsed check. Before pinning, every living
lens billed an agent turn per tick while the Chamber tab was open, folded or not.
Pinning bounds that to the set the operator chose.

Every pinned panel is collapsible and arrives **collapsed**, so a standing view
costs one head strip of height until it is expanded. Each carries its own Retire
verb in the head's **⋯** menu (board or HTML), confirm-gated and reachable while
collapsed, alongside a non-destructive **Unpin from Chamber**. Once unpinned there
is no head, so the index card carries every verb and is the only way to pin one
back.

Rooms and exhibits register no region at all. A room is an activity you enter from
its index card, and an exhibit is reached from the room that tabled it, so each
holds a snapshot key with no panel of its own.

A pinned [living lens](../../concepts/lenses/#a-living-lens-re-composes-itself)'s
region additionally wires its refresh workflow with `workflowArgs: { lens: id }`
and the record's cadence, so the host re-runs the re-author while the surface is
open and the panel head carries the "updated Xm ago" freshness clock. An unpinned
living lens has no region, so nothing ticks: it re-composes from the Refresh verb
on its index card.

| Region | Key | Title | Group | Group title | Glyph |
|---|---|---|---|---|---|
| Pinned lens | `rib:chamber:lens:{id}` | the lens `id` | `lens:{id}` | `Pinned` | `✦` accent |
| Pinned HTML lens | `rib:chamber:lens-html:{id}` | the lens `title` (falls back to `id`) | `lens:{id}` | `Pinned` | `❖` accent |
| Legacy HTML canvas | `rib:chamber:lens-html` | `HTML Lens` | `lens` | `Lenses` | `❖` accent |

The group is **per id**, so each pinned lens is the only member of its own group.
The host chunks regions per group, so a shared group would render them three
across instead of a row each; one shared `groupTitle` of `Pinned` is what folds
those full-width rows back under a single header, and dynamic rows append after the
static ones. The legacy id-less HTML canvas is the exception: it has no record to
hold a pin and no card to pin it back from, so it is always panelled and keeps the
old shared `lens` group.

Lenses and exhibits share one key family (`rib:chamber:lens:{id}`) and one id
space, so the open path and the briefing's jump chips resolve either kind through
the same key. An exhibit registers a key and never a region, at any pin state.

Each lens gets its own per-id key. The key routes a re-publish back to the same
panel, so re-authoring a lens `id` updates that panel in place. The harness
enforces a per-surface region ceiling; a region the harness rejects unwinds the
snapshot registration it paired with, rather than leaving an orphaned key.

Unpinning drops the region only. It deliberately does not release the key or the
view declaration, both of which must outlive an unpin: the host resolves a key's
canvas kind by exact match, so an HTML lens without its declaration would have its
markup rendered through the board pipeline the moment Open focused it. Disk stays
authoritative, so a lens whose region registration failed heals on the next boot
rather than losing the pin forever.

### The three room keys

A live room's board streams to the key its driver publishes to, which the Rooms
index Open focuses:

```text
rib:chamber:room:{slug}
```

The registry that owns it registers a snapshot key and nothing else. A key outlives
the room that made it: it is released only when the room is deleted or the rib is
disposed, never when the room merely ends, because a drawer may still be reading it
and the host closes a subscription to a gone key permanently.

Opening a room that is no longer live rebuilds its board from the persisted
transcript and publishes it to a second per-slug key:

```text
rib:chamber:room-view:{slug}
```

This key is snapshot-only and has no canvas view. It is registered lazily on the
first open of a slug and torn down when the rib is disposed. It is per-slug so two
clients opening two different closed rooms get independent boards instead of
colliding on one shared key.

Which key an Open returns is decided by the driver's in-memory set, never by the
room record's status: a crash leaves a room marked active on disk with no key ever
registered for it, so trusting the record would hand back a key that does not
exist.

A closed room's card also offers a **Summary**, which composes its outcome into a
standalone HTML page on a third per-slug key:

```text
rib:chamber:room-summary:{slug}
```

The page is rib-built rather than agent-authored: the action reads the room's
persisted outcome, its Minds, its decision markers, and the exhibits it tabled, and
renders them deterministically. No agent turn runs, so a Summary is free. It rides
the HTML lens's own validation path (the string validator plus the structural
check) before it publishes, so a malformed page fails the action rather than
rendering. On a harness without the seams it needs, the action reports that the
summary is unavailable instead of half-running.

## Canvas views

The surface declares seven canvas views. These bind the standing keys to the
canvas renderer; data arrives when the producers run.

| Key | `canvasKind` | Title |
|---|---|---|
| `rib:chamber:presence` | `view` | The Chamber |
| `rib:chamber:roster` | `view` | Roster |
| `rib:chamber:rooms` | `view` | Rooms |
| `rib:chamber:lenses` | `view` | Lenses |
| `rib:chamber:digest` | `view` | Digest |
| `rib:chamber:lens-html` | `html` | HTML Lens |
| `rib:chamber:brief` | `view` | Briefing |

The per-instance board keys (`room:{slug}`, `lens:{id}`, `room-view:{slug}`) are
not declared as views. The host resolves a key's canvas kind by exact match against
this list and falls back to `view`, so a per-instance board renders without a
declaration.

The two HTML-bearing per-instance keys are the exception, and for the same reason:
`lens-html:{id}` and `room-summary:{slug}` each push their own `canvasKind: "html"`
entry at runtime, through the `declareView` seam, or the drawer would render their
raw markup through the board pipeline. That is why the rib's view array is mutable
rather than a static literal. An HTML lens's entry outlives an unpin: only the
region goes, because a key whose declaration went with it would render as a board
the moment Open focused it.

## Every panel is a board

The rib ships no React. Every panel above is a published board, a plain
`{ view: "board", title, header, sections }` value, drawn by the harness canvas.
Chamber's job is to keep those boards current; the harness owns how they render.
See [Data on disk](../data-on-disk/) for board shapes and
[Keelson snapshots](https://danielscholl.github.io/keelson/docs/reference/snapshots/)
for the substrate the keys live on.

## Related

- [Workflows](../workflows/): the collectors that fill the standing keys.
- [Data on disk](../data-on-disk/): the board shapes each producer emits.
- [Rooms and strategies](../../concepts/rooms/): why a room is entered, not panelled.
- [Lenses](../../concepts/lenses/): why each lens is its own per-id key.
- [Keelson snapshots](https://danielscholl.github.io/keelson/docs/reference/snapshots/): the snapshot and board contract these keys ride on.
