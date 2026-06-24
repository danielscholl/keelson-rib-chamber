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
| `subtitle` | `Author Minds · convene Rooms · keep Lenses · read the Briefing` |

## Standing layout

The surface declares four standing regions: a header, one row of two columns,
and a footer. Each binds a snapshot key. The three collectors carry a workflow
binding and a 120000 ms cadence so they self-populate on open and refresh
without being hammered. The Briefing footer has no workflow: it is rib-driven,
seeded with a quiet board at boot and republished only by the attention gate.

| Region | Key | Workflow | Cadence (ms) | Collapsible | Glyph |
|---|---|---|---|---|---|
| Header | `rib:chamber:roster` | `chamber-roster` | 120000 | no | `◇` brand |
| Row, column 1 | `rib:chamber:rooms` | `chamber-rooms` | 120000 | yes | `▦` brand |
| Row, column 2 | `rib:chamber:lenses` | `chamber-lenses` | 120000 | yes | `✦` accent |
| Footer | `rib:chamber:brief` | none (rib-driven) | none | yes | `❖` brand |

The Rooms index lists active rooms first, as status-only cards, then closed
rooms with Open and Delete actions. An active room also gets its own live panel
(below). The Lenses index sits alongside each lens's live panel.

## Dynamic regions

Live rooms and live lenses are not in the static layout. A producer registers
each one at runtime with `registerRegion`, so the surface grows panels as rooms
convene and lenses are authored. A lens panel sheds when the lens retires. A room
keeps its panel while active, and after it ends the most recently finished room
stays visible until a newer room supersedes it, or the room is deleted.

| Region | Key | Title | Group | Group title | Glyph |
|---|---|---|---|---|---|
| Live room | `rib:chamber:room:{slug}` | room name (falls back to slug) | `rooms` | `Rooms` | `▦` brand |
| Live lens | `rib:chamber:lens:{id}` | the lens `id` | `lens` | `Lenses` | `✦` accent |

Each active room gets its own per-slug key and region, and each lens its own
per-id key and region. The key routes a re-publish back to the same panel:
re-authoring a lens `id` updates that panel in place, and a room's turns stream
to its slug. The harness enforces a per-surface region ceiling; a region the
harness rejects unwinds the snapshot registration it paired with, rather than
leaving an orphaned key.

The group string for lenses is `lens` (singular); the group title rendered for
the lane is `Lenses`. The first room or lens to register sets the group title
for its lane.

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

The surface declares four canvas views, all of `canvasKind` `view`. These bind
the standing keys to the canvas renderer; data arrives when the producers run.

| Key | `canvasKind` | Title |
|---|---|---|
| `rib:chamber:roster` | `view` | Roster |
| `rib:chamber:rooms` | `view` | Rooms |
| `rib:chamber:lenses` | `view` | Lenses |
| `rib:chamber:brief` | `view` | Briefing |

The per-instance keys (`room:{slug}`, `lens:{id}`, `room-view:{slug}`) are not
declared as views. They are bound at runtime, the room and lens keys through
`registerRegion` and the room-view key through a snapshot registration alone.

## Every panel is a board

The rib ships no React. Every panel above is a published board, a plain
`{ view: "board", title, header, sections }` value, drawn by the harness canvas.
Chamber's job is to keep those boards current; the harness owns how they render.
See [Data on disk](../data-on-disk/) for board shapes and
[Keelson snapshots](https://danielscholl.github.io/keelson/docs/reference/snapshots/)
for the substrate the keys live on.

## Related

- [Workflows](../workflows/): the collectors that fill the three standing keys.
- [Data on disk](../data-on-disk/): the board shapes each producer emits.
- [Rooms and strategies](../../concepts/rooms/): why a live room is its own panel.
- [Lenses](../../concepts/lenses/): why each lens is its own per-id key.
- [Keelson snapshots](https://danielscholl.github.io/keelson/docs/reference/snapshots/): the snapshot and board contract these keys ride on.
