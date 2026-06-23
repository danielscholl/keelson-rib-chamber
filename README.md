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

> Status: **experimental.** Genesis, rooms (five turn strategies: **sequential**,
> **concurrent**, moderated **group-chat**, unmoderated **open-floor**, and
> cross-vendor **review**), and agent-authored lenses all work today —
> driven from chat tools, the Chamber surface, or workflows. The contract is
> still alpha. See the [documentation site](https://danielscholl.github.io/keelson-rib-chamber/) and
> [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design.

## What it adds

- **Genesis** — author persistent agents (Minds) on demand from a freeform brief.
- **Rooms** — run multi-agent conversations under five turn strategies: **sequential**, **concurrent**, moderated **group-chat**, unmoderated **open-floor**, and a cross-vendor **review**; steer them live (call on a speaker, inject a direction, stop).
- **Lenses** — agents author their own canvas boards — a briefing, the roster, the live room transcript — rendered through Keelson's canvas with no hand-coded UI.
- **Zero trusted React** — every view renders through the canvas contract, not UI shipped from the rib.

## Install into Keelson

Into an installed Keelson (the managed home at `~/.keelson`):

```bash
keelson rib add https://github.com/danielscholl/keelson-rib-chamber
keelson start
```

## Requirements

- A configured Keelson with a provider (Copilot or Claude) — or `KEELSON_PROVIDERS=stub` to try the wiring offline.
- No external CLIs. `@keelson/shared` comes from the harness as a peer dependency (one copy shared across the harness and every rib).

## Compatibility

| | |
|---|---|
| Chamber | `0.8.x` |
| Keelson shared contract | `@keelson/shared >= 0.12.0` (peer dependency) |
| Tested against | Keelson `main` (CI tracks the latest harness) |
| Status | Experimental — the `Rib` contract it builds on is still pre-1.0 |

`@keelson/shared` resolves from the harness, so an up-to-date `keelson` satisfies
the floor and `keelson update` keeps it current. The contract may still make
breaking changes before 1.0; pin a Chamber version against a known-good Keelson
if you need stability.

## Try it

Open `http://127.0.0.1:7878` → the **Chamber** surface, then:

- **Create an agent** — `keelson workflow run chamber-genesis "a terse SRE who reasons about blast radius"` (or ask chat to create one). It authors a Mind you'll see on the Roster.
- **Run a room** — ask chat to start a room between two Minds, or use the **Start room** control on the surface; steer it live and watch the transcript render as turns land.
- **See a lens** — `keelson workflow run chamber-lens "release risks"` runs one agent turn that authors a canvas board on the subject, published fail-closed and rendered with no hand-coded UI. The standing **Briefing** in the footer fills itself in — it promotes to an agent-authored board when a room ends or a lens changes, and stays quiet otherwise.

## How it works

Keelson already owns the *deterministic* half of Chamber — `packages/workflows`
(the Archon DAG) and the canvas `board` view that renders a lens. This rib adds
the *generative* half: agents authored on demand, rooms that orchestrate their
turns, and agents that author their own lenses. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design and the Keelson base
seams it builds on.

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
Keelson's documentation tiers, published at
[danielscholl.github.io/keelson-rib-chamber](https://danielscholl.github.io/keelson-rib-chamber/).
Build it locally with `cd docs && bun install && bun run build`. For the design
rationale and the Keelson base seams it builds on, see
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Acknowledgments

This rib is a clean-room port of [Chamber](https://github.com/ianphil/chamber)
(MIT, by Ian Philpot), the originating multi-agent desktop app. It imports no
upstream code; Chamber's model — minds authored on demand (genesis),
agent-to-agent rooms, and agent-authored lenses — is re-typed here and driven by
the `Rib` contract. Full attribution lives in [NOTICE](NOTICE).

## License

Licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for
third-party attribution.
