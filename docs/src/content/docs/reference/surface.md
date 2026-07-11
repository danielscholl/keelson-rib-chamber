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

The surface declares seven standing regions: the Presence header, the Briefing
banner, the Roster row, the Convene row, the Rooms + Lenses row, and the Exhibits
row. Each binds a snapshot key. The index collectors carry a workflow binding and
a 120000 ms cadence so they self-populate on open and refresh without being
hammered. Presence, Convene, and the Briefing have no workflow: all three are
rib-driven and recomposed in-process. Presence and Convene recompose on any
mutation. The Briefing has two publish paths: it is re-published on every mutation
so its record and digest registers stay current, and its attention gate separately
promotes or lapses the delta register. The header and banner never collapse, so the
Presence ribbon and the Briefing heartbeat are always on.

| Region | Key | Workflow | Cadence (ms) | Collapsible | Glyph |
|---|---|---|---|---|---|
| Header | `rib:chamber:presence` | none (rib-driven) | none | no | `◈` brand |
| Banner | `rib:chamber:brief` | none (rib-driven) | none | no | `❖` brand |
| Row 1 | `rib:chamber:roster` | `chamber-roster` | 120000 | yes | `◇` brand |
| Row 2 | `rib:chamber:convene` | none (rib-driven) | none | yes | `＋` brand |
| Row 3, column 1 | `rib:chamber:rooms` | `chamber-rooms` | 120000 | yes | `▦` brand |
| Row 3, column 2 | `rib:chamber:lenses` | `chamber-lenses` | 120000 | yes | `✦` accent |
| Row 4 | `rib:chamber:exhibits` | `chamber-exhibits` | 120000 | yes | `▣` caution |

The Exhibits row additionally sets `hideWhenEmpty`: its collector emits zero
sections while no exhibits exist, so the shelf stays invisible until a
discussion has tabled something.

The Rooms index lists active rooms first, as status-only cards, then closed
rooms with Open and Delete actions. A card also lists the exhibits its room
tabled (a `tabled` field, joined on the witnessed `sourceRoom` slug), and a
closed card links each one open ahead of the room verbs: the provenance link
read the other way. An active room also gets its own live panel (below). The Lenses
index sits alongside each lens's live panel.

## Dynamic regions

Live rooms, live lenses, live exhibits, and per-subject HTML lenses are not in
the static layout. A producer registers each one at runtime with
`registerRegion`, so the surface grows panels as rooms convene, lenses and HTML
lenses are authored, and exhibits are tabled. A
lens or exhibit panel sheds when its record is retired or deleted. A room keeps
its panel while active, and after it ends the most recently finished room stays
visible until a newer room supersedes it, or the room is deleted. Every lens and
exhibit panel is collapsible, so a tall board folds to its head strip, and each
carries its own verb in the head's **⋯** menu (Retire on a lens, board or
HTML; Delete on an exhibit), confirm-gated and reachable even while collapsed.

A [living lens](../../concepts/lenses/#a-living-lens-re-composes-itself)'s
region additionally wires its refresh workflow with `workflowArgs: { lens: id }`
and the record's cadence, so the host re-runs the re-author while the surface is
open and the panel head carries the "updated Xm ago" freshness clock.

| Region | Key | Title | Group | Group title | Glyph |
|---|---|---|---|---|---|
| Live room | `rib:chamber:room:{slug}` | room name (falls back to slug) | `rooms` | `Rooms` | `▦` brand |
| Live lens | `rib:chamber:lens:{id}` | the lens `id` | `lens` | `Lenses` | `✦` accent |
| Live exhibit | `rib:chamber:lens:{id}` | the exhibit `id` | `exhibit` | `Exhibits` | `▣` caution |
| Live HTML lens | `rib:chamber:lens-html:{id}` | the lens `title` (falls back to `id`) | `lens` | `Lenses` | `❖` accent |

Lenses and exhibits share one key family (`rib:chamber:lens:{id}`) and one id
space (the record's kind decides which shelf its region joins), so the open
path and the briefing's jump chips resolve either kind through the same key.

Each active room gets its own per-slug key and region, and each lens its own
per-id key and region. The key routes a re-publish back to the same panel:
re-authoring a lens `id` updates that panel in place, and a room's turns stream
to its slug. The harness enforces a per-surface region ceiling; a region the
harness rejects unwinds the snapshot registration it paired with, rather than
leaving an orphaned key.

The group string for lenses is `lens` and for exhibits `exhibit` (singular);
the group titles rendered for the lanes are `Lenses` and `Exhibits`. The first
room, lens, or exhibit to register sets the group title for its lane.

### The Rooms index Open key

A closed room has no standing `rib:chamber:room:{slug}` region. Opening one from
the Rooms index rebuilds its board from the persisted transcript and publishes
it to a separate per-slug key:

```text
rib:chamber:room-view:{slug}
```

This key is snapshot-only: it has no surface region and no canvas view. It is
registered lazily on the first open of a slug and torn down when the rib is
disposed. It is per-slug so two clients opening two different closed rooms get
independent boards instead of colliding on one shared key.

## Canvas views

The surface declares eight canvas views. These bind the standing keys to the
canvas renderer; data arrives when the producers run.

| Key | `canvasKind` | Title |
|---|---|---|
| `rib:chamber:roster` | `view` | Roster |
| `rib:chamber:convene` | `view` | Convene |
| `rib:chamber:rooms` | `view` | Rooms |
| `rib:chamber:lenses` | `view` | Lenses |
| `rib:chamber:exhibits` | `view` | Exhibits |
| `rib:chamber:digest` | `view` | Digest |
| `rib:chamber:lens-html` | `html` | HTML Lens |
| `rib:chamber:brief` | `view` | Briefing |

The per-instance keys (`room:{slug}`, `lens:{id}`, `room-view:{slug}`) are not
declared as views. They are bound at runtime, the room and lens keys through
`registerRegion` and the room-view key through a snapshot registration alone. A
per-subject HTML lens is the exception: its `rib:chamber:lens-html:{id}` key
pushes its own `canvasKind: "html"` view at runtime, so the drawer renders the
raw HTML frame directly rather than through the board pipeline.

## Every panel is a board

The rib ships no React. Every panel above is a published board, a plain
`{ view: "board", title, header, sections }` value, drawn by the harness canvas.
Chamber's job is to keep those boards current; the harness owns how they render.
See [Data on disk](../data-on-disk/) for board shapes and
[Keelson snapshots](https://danielscholl.github.io/keelson/docs/reference/snapshots/)
for the substrate the keys live on.

## Related

- [Workflows](../workflows/): the collectors that fill the four standing keys.
- [Data on disk](../data-on-disk/): the board shapes each producer emits.
- [Rooms and strategies](../../concepts/rooms/): why a live room is its own panel.
- [Lenses](../../concepts/lenses/): why each lens is its own per-id key.
- [Keelson snapshots](https://danielscholl.github.io/keelson/docs/reference/snapshots/): the snapshot and board contract these keys ride on.
