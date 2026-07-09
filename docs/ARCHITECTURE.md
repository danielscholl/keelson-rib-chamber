# Architecture — `@keelson/rib-chamber`

> This file is a short pointer. The authoritative architecture lives in the
> published documentation, which tracks the shipped rib:
> **[danielscholl.github.io/keelson-rib-chamber](https://danielscholl.github.io/keelson-rib-chamber/)**.

Chamber adds structured multi-agent review to Keelson: persistent agents you
author on demand (Minds), rooms where they take attributed agent-to-agent turns
under a turn strategy, and lenses where a Mind renders its own canvas board.
Keelson owns the deterministic half (the workflow engine and the canvas board
renderer); this rib adds the generative half and ships no React into the SPA.

## Where the architecture is documented

| Tier | What it covers |
|---|---|
| [Concepts](https://danielscholl.github.io/keelson-rib-chamber/concepts/) | The model: Minds, rooms and strategies, lenses, and when to convene a room. |
| [Design](https://danielscholl.github.io/keelson-rib-chamber/design/) | Decision records and the Keelson base seams the rib builds on: the agent-turn seam, communication and identity, rooms and strategies, per-Mind capabilities, and agent-authored lenses. |
| [Reference](https://danielscholl.github.io/keelson-rib-chamber/reference/) | The exact contract: the Chamber surface, the `rib:chamber:*` snapshot keys, the nine workflows, the chat tools and commands, the six room strategies, and the on-disk data. |
| [Guides](https://danielscholl.github.io/keelson-rib-chamber/guides/) | Task recipes: install and remove the rib, author a Mind, run a room, author a lens. |

Build the docs locally with `cd docs && bun install && bun run build`.

## Lineage

Chamber is a clean-room port of [Chamber](https://github.com/ianphil/chamber)
(MIT, by Ian Philpot), the originating multi-agent desktop app, by way of an
intermediate port (`pi-chamber`) onto an earlier harness. It imports no upstream
code; the model is re-typed against the Keelson `Rib` contract. Full attribution
lives in [NOTICE](../NOTICE).

The prior long-form design notes (the base-gap analysis that sequenced the
initial build) remain in this file's git history and have been superseded by the
Design tier above.
