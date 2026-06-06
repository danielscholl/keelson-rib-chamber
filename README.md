# @keelson/rib-chamber

A [Keelson](https://github.com/danielscholl/keelson) **rib** that brings a
multi-agent operating layer to the harness — **genesis** (author a persistent
agent on demand), **rooms** (orchestrate agent-to-agent turns), and
**agent-authored lenses** (agents that render their own views through the
canvas). The harness stays domain-free; all of the multi-agent machinery lives
here, and the rib ships **zero React** into the trusted SPA.

> Status: **Phase 0 wired.** The first hook is live — a `chamber-brief` workflow
> whose agent turn authors a canvas `board` "briefing" lens, published
> fail-closed to `rib:chamber:brief` and rendered on the **Chamber** surface with
> zero hand-coded UI. Genesis, rooms, and on-demand lenses follow per the phase
> plan. Read **[docs/PRD.md](docs/PRD.md)** for what the rib delivers and
> **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for how it works, the phase
> plan, and the Keelson base gaps it depends on.

## Why this rib

Where the OSDU rib is the *external-system bridge → dashboard* archetype
(read-mostly, CLI-shelling, static views), Chamber is its opposite: *generative
multi-agent → live surface*. It exists to flush out a second, orthogonal corner
of the `Rib` contract — and to prove that an agent can **author its own lens**
and render it through the same canvas the OSDU rib's board primitives already
ship.

The concepts are ported from two sources:

- **chamber** (`ianphil/chamber`) — the originating multi-agent desktop app
  (minds, lenses, genesis, A2A rooms).
- **pi-chamber** — a prior, tested port of those concepts onto a different
  agent harness; its pure orchestration strategies port across with the host
  adapter swapped for the `Rib` contract.

Keelson already owns the *deterministic* half of chamber — `packages/workflows`
(the Archon DAG) and the canvas `board` view (the lens renderer). This rib adds
the *generative* half.

## Develop against a local Keelson

```bash
bun install
bun link @keelson/shared        # resolves the contract from your local keelson checkout
                                # (or recreate node_modules/@keelson/shared by hand)

bun test            # rib identity + (later) pure builder/strategy coverage
bun run typecheck
bun run check       # biome lint + format

# Wire the rib into a local Keelson checkout (defaults to ../keelson; override with KEELSON_DIR):
bun run link:keelson
cd ../keelson && KEELSON_RIBS=chamber bun dev
```

Then open `http://127.0.0.1:5173` → the **Chamber** tab (or **Ribs**).

## License

Apache-2.0.
