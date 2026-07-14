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
| `subtitle` | `Author Minds · convene Rooms · keep Lenses · table Exhibits · read the Briefing` |

## Standing layout

The surface declares four standing regions: the Chamber header, the Briefing
banner, and the two columns of its one standing row, Rooms and Lenses at half
width each. Each binds a snapshot key. The two index collectors carry a workflow
binding and a 120000 ms cadence so they self-populate on open and refresh without
being hammered. The Chamber header and the Briefing have no workflow: both are
rib-driven and recomposed in-process, and the header recomposes on any roster,
rooms, or draft mutation. The Briefing has two publish paths: it is re-published on
every mutation so its record and digest registers stay current, and its attention
gate separately promotes or lapses the delta register. The header and banner never
collapse, so the Chamber ribbon and the Briefing heartbeat are always on.

| Region | Key | Workflow | Cadence (ms) | Collapsible | Glyph |
|---|---|---|---|---|---|
| Header | `rib:chamber:presence` | none (rib-driven) | none | no | `◈` brand |
| Banner | `rib:chamber:brief` | none (rib-driven) | none | no | `❖` brand |
| Row 1, column 1 | `rib:chamber:rooms` | `chamber-rooms` | 120000 | yes | `▦` brand |
| Row 1, column 2 | `rib:chamber:lenses` | `chamber-lenses` | 120000 | yes | `✦` accent |

A panel is for what is continuously true; you enter what is happening. That is why
the standing layout holds two indexes and no room: a lens is a standing view and
keeps its own panel, while a room is an activity you open from its card.

The Rooms index lists active rooms first, then closed ones. Every card carries
Open. An active room's Open focuses the live per-slug key its driver publishes to,
so the drawer streams turns as they land; a closed room's rebuilds a frozen board
from the persisted transcript. Only a closed card adds the destructive Delete,
because the delete handler refuses a live room. A card also names the exhibits its
room tabled (a `tabled` field, joined on the witnessed `sourceRoom` slug) but links
none of them open: an exhibit is opened from the Tabled section of its own room's
board. The Lenses index sits alongside each lens's live panel.

## Dynamic regions

Live lenses and per-subject HTML lenses are not in the static layout. A producer
registers each one at runtime with `registerRegion`, so the surface grows panels as
lenses and HTML lenses are authored, and a lens panel sheds when its record is
retired. Every lens panel is collapsible, so a tall board folds to its head strip,
and each carries its own Retire verb in the head's **⋯** menu (board or HTML),
confirm-gated and reachable even while collapsed.

Rooms and exhibits register no region at all. A room is an activity you enter from
its index card, and an exhibit is reached from the room that tabled it, so each
holds a snapshot key with no panel of its own.

A [living lens](../../concepts/lenses/#a-living-lens-re-composes-itself)'s
region additionally wires its refresh workflow with `workflowArgs: { lens: id }`
and the record's cadence, so the host re-runs the re-author while the surface is
open and the panel head carries the "updated Xm ago" freshness clock.

| Region | Key | Title | Group | Group title | Glyph |
|---|---|---|---|---|---|
| Live lens | `rib:chamber:lens:{id}` | the lens `id` | `lens` | `Lenses` | `✦` accent |
| Live HTML lens | `rib:chamber:lens-html:{id}` | the lens `title` (falls back to `id`) | `lens` | `Lenses` | `❖` accent |

Lenses and exhibits share one key family (`rib:chamber:lens:{id}`) and one id
space, so the open path and the briefing's jump chips resolve either kind through
the same key. The record's kind decides whether there is a panel at all: a lens
gets one, an exhibit gets only the key.

Each lens gets its own per-id key and region. The key routes a re-publish back to
the same panel, so re-authoring a lens `id` updates that panel in place. The
harness enforces a per-surface region ceiling; a region the harness rejects unwinds
the snapshot registration it paired with, rather than leaving an orphaned key. The
group string is `lens` (singular) and the lane's rendered group title is `Lenses`;
the first lens to register sets it.

### The two room keys

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

The per-instance keys (`room:{slug}`, `lens:{id}`, `room-view:{slug}`) are not
declared as views. The host resolves a key's canvas kind by exact match against
this list and falls back to `view`, so a per-instance board renders without a
declaration. A per-subject HTML lens is the exception: it must push its own
`canvasKind: "html"` view at runtime, or the drawer would render its raw frame
through the board pipeline.

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
