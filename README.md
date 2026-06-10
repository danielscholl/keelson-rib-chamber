# @keelson/rib-chamber

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Keelson Rib](https://img.shields.io/badge/Keelson-rib-1e3a5f.svg)](https://github.com/danielscholl/keelson)
![Status: Experimental](https://img.shields.io/badge/status-experimental-orange.svg)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun-black.svg)](https://bun.sh/)

**Multi-agent rooms and agent-authored lenses for [Keelson](https://github.com/danielscholl/keelson).**

Chamber adds a multi-agent operating layer to the harness: persistent agents you
author on demand, rooms where they take agent-to-agent turns, and lenses where an
agent renders its own view onto the canvas. The harness stays domain-free — all
of the multi-agent machinery lives in the rib, and it ships **zero React** into
the trusted SPA.

> Status: **Phase 0.** The `chamber-brief` workflow renders an agent-authored
> board lens today; **genesis**, **rooms**, and on-demand lenses are next. See
> [docs/PRD.md](docs/PRD.md) for scope and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
> for the phase plan.

## What it adds

- **Genesis** — author a persistent agent on demand.
- **Rooms** — orchestrate agent-to-agent turns.
- **Lenses** — let an agent produce a structured view, rendered through Keelson's canvas.
- **Zero trusted React** — every view renders through the canvas contract, not hand-coded UI shipped from the rib.

## Install into Keelson

Into an installed Keelson (the managed home at `~/.keelson`):

```bash
keelson rib add https://github.com/danielscholl/keelson-rib-chamber
keelson serve
```

## Requirements

- A configured Keelson with a provider (Copilot or Claude) — or `KEELSON_PROVIDERS=stub` to try the wiring offline.
- No external CLIs. `@keelson/shared` comes from the harness as a peer dependency (one copy shared across the harness and every rib).

## Try it

Open `http://127.0.0.1:7878` → the **Chamber** surface, or run the briefing
workflow and watch its lens publish:

```bash
keelson workflow run chamber-brief --watch
```

The agent turn authors a canvas `board` lens, published fail-closed to
`rib:chamber:brief` and rendered on the Chamber surface with no hand-coded UI.

## How it works

Keelson already owns the *deterministic* half of Chamber — `packages/workflows`
(the Archon DAG) and the canvas `board` view that renders a lens. This rib adds
the *generative* half: agents that author their own lenses and orchestrate each
other through rooms. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the
phase plan and the Keelson base seams it depends on.

## Develop locally

```bash
bun install
bun link @keelson/shared   # resolve the contract from your local keelson checkout

bun test                   # rib identity + pure builder/strategy coverage
bun run typecheck
bun run check              # biome lint + format

# Wire into a local Keelson checkout (defaults to ../keelson; override with KEELSON_DIR):
bun run link:keelson
cd ../keelson && KEELSON_RIBS=chamber bun dev
```

Then open `http://127.0.0.1:5173` → the **Chamber** tab (or **Ribs**).

## Documentation

The docs site lives under [`docs/`](docs/) — an Astro Starlight project mirroring
Keelson's documentation tiers. Build it locally with `cd docs && bun install &&
bun run build`, or read [`docs/PRD.md`](docs/PRD.md) and
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for scope and the phase plan.

## Acknowledgments

This rib is a clean-room port of [Chamber](https://github.com/ianphil/chamber)
(MIT, by Ian Philpot), the originating multi-agent desktop app. It imports no
upstream code; Chamber's model — minds authored on demand (genesis),
agent-to-agent rooms, and agent-authored lenses — is re-typed here and driven by
the `Rib` contract. Full attribution lives in [NOTICE](NOTICE).

## License

Licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for
third-party attribution.
