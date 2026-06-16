---
title: Lenses
description: An agent authors its own canvas board. How a single turn renders a live panel with no hand-coded UI.
sidebar:
  order: 4
---

A **lens** is a view a Mind authors itself. One agent turn composes a canvas board
and publishes it, and it renders as a live panel on the Chamber surface with no
hand-coded UI. The view is produced by an agent, not written by hand. That is the
rib's hero capability.

## A lens is the output of a turn

A lens is not a participant and not an agent. It is the product of a single Mind's
turn, the same way genesis produces a Mind and a room turn produces a reply.
Because it is a solo turn with no peer, a lens is orthogonal to rooms: it does not
ride the room driver and does not depend on a strategy. (Minds talking to each
other is a [room](../rooms/); a Mind authoring a view is a turn.)

## The board, and the pipeline it rides

A board is a generic canvas payload: a title, an optional status, and a few kinds
of section (stats, rows, cards, segments, and so on). It is the harness's own
shape, not Chamber's, and the harness already knows how to render one. See the
keelson docs for the board contract.

Authoring a lens uses the same pipeline as everything else in Chamber. The turn
emits a board, the rib validates it fail-closed before anything renders, and the
bound view draws it live. A board that does not validate is rejected loudly rather
than rendered half-formed or dropped without a word.

## A panel per subject

Each lens is keyed by a short subject id, and each new subject gets its own panel
on the Chamber surface. Re-authoring the same subject updates that panel in place
rather than adding another. The rib sets no fixed limit on how many lenses can
exist; the harness enforces a per-surface ceiling.

## Two ways to author one

- **As a workflow.** Run `/lens <subject>`, or
  `keelson workflow run chamber-lens "<subject>"`. One turn composes a board for
  the subject and publishes it. This is the standalone entry point.
- **During a room.** A Mind that declares the `lens` capability can author a lens
  mid-room, for example to surface a findings summary after a discussion. A Mind
  with no declared capability is text-only, so this is opt-in per Mind. See
  [Minds and genesis](../minds/) for declaring capabilities.

## Every panel is authored

The standing briefing on the surface footer is a board an agent turn composes. It
was the first proof that an agent can author its own view, and it still runs on
demand. It is a fixed board on its own key, not one of the per-subject lenses
described here, but the principle is the same: a view composed by an agent, not
written by hand. The roster and the live room transcript are boards too, so every
panel on the Chamber surface is a published board, never hand-coded UI.

## Related

- [Minds and genesis](../minds/): declaring the `lens` capability.
- [Rooms and strategies](../rooms/): authoring a lens mid-room.
- [Concepts overview](../): the publish pipeline a lens shares.
