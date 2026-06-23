# AGENTS.md

This is the canonical project guidance for coding agents — Codex, GitHub
Copilot's coding agent, and (via an import in `CLAUDE.md`) Claude Code — working
in this repository. `CONTRIBUTING.md` is the authoritative human guide; this is
its agent-facing distillation.

## What this is

`@keelson/rib-chamber` is a **rib** (extension) for
[Keelson](https://github.com/danielscholl/keelson), the local-only agent harness.
A rib is a standalone package the harness discovers at runtime and attaches
through one typed contract — the `Rib` interface from `@keelson/shared`. Chamber
adds the multi-agent operating layer: **genesis** (author persistent agents —
Minds — on demand), **rooms** (agent-to-agent conversations under a turn
strategy), and **lenses** (agents author their own canvas boards). The harness
stays domain-free; all of that machinery lives here, and the rib ships **zero
React** into the trusted SPA.

## Commands

Bun. Everything is workspace-local; there is no monorepo.

```bash
bun install                  # one-time
bun link @keelson/shared     # resolve the Rib contract from a local keelson checkout

bun test                     # rib identity + pure builder/strategy coverage (uses stubs)
bun run typecheck            # tsc --noEmit (needs @keelson/shared linked)
bun run check                # Biome lint + format (required pre-PR)
bun run check:fix            # auto-fix safe lint/format

bun run link:keelson         # symlink this rib into ../keelson (override with KEELSON_DIR)
cd ../keelson && KEELSON_RIBS=chamber bun dev   # exercise it in a running harness
```

`CONTRIBUTING.md` gates every PR on `bun run check`, `bun run typecheck`, and
`bun test` all green. CI resolves `@keelson/shared` as a symlink to a
`danielscholl/keelson` checkout's `packages/shared` from `main`, so a harness
contract change that breaks this rib turns CI red here.

## Architecture

The whole rib is one `Rib` object exported from `src/index.ts`. It contributes:

- **Views + a surface** — three agent-authored snapshot keys
  (`rib:chamber:roster`, `rib:chamber:room`, `rib:chamber:brief`) bound to the
  canvas renderer, and the **Chamber** nav surface that lays them out. No
  hand-coded UI: every view is a board a producer publishes.
- **Workflows** (`contributeWorkflows`) — `chamber-roster` / `chamber-rooms` /
  `chamber-lenses` (deterministic collectors that read the data home), `chamber-lens`
  (one agent turn that authors a lens board), and `chamber-genesis` (one agent turn
  that authors a Mind's SOUL.md and persists it via the `chamber_emit_genesis` write
  seam). The **Briefing** (`rib:chamber:brief`) is NOT a workflow — it is the rib-owned
  attention gate (`evaluateBriefGate`, `src/chamber-state.ts` + `src/watermark-store.ts`):
  a room ending or a lens changing promotes it to one agent-authored board, gated
  fail-closed against a persisted watermark so a quiet Chamber runs no paid turn.
- **Tools** (`registerTools`) — the genesis write seam is always present; the
  room-control chat tools (`chamber_room_start` / `_say` / `_stop` / `_status`)
  and the room driver are built **only when** the host provides the agent-turn
  (`runAgentTurn`) and snapshot-manager seams. Absent those, room actions fail
  closed.
- **Actions** (`onAction`) — `enter-mind`, `retire`, and the payload-carrying
  `room-start` / `room-inject` / `room-stop` board actions.
- **Agents + commands** — every Mind is enterable as a keelson agent
  (`listAgents` / `resolveAgent`); `/mind` opens a Mind as a seeded chat and
  `/genesis` runs the chamber-genesis workflow.

Orchestration **strategies** (`src/strategies/`: `sequential`, `group-chat`,
`open-floor`, `concurrent`, registered in `index.ts`) are **pure** — they read
room state and return the next turn decision (`speak` / `end`). They do no I/O
and know nothing about providers or the host; the **driver** (`src/room.ts`)
owns turns, persistence, and publishing.

### Invariants worth protecting

- **Zero React into the trusted SPA.** Surfaces render through the canvas `board`
  contract, never hand-coded UI shipped from the rib.
- **Attach only through the `Rib` contract** (`@keelson/shared`). Don't reach
  around it into harness internals.
- **Strategies stay pure.** No I/O, no provider/host coupling in `src/strategies/`.
- **Fail closed.** Boards publish through `validate` (`expectView`) and node
  `output_schema` guards; the driver and room tools refuse to act when their seams
  are absent rather than half-running. A genesis write fails closed on a slug
  collision (`fail_on_tool_error`).
- **Paid turns are guarded.** Each room turn is a billed agent call: the turn
  budget is capped (`MAX_ROOM_TURN_BUDGET`), and `chamber_room_start` is a
  confirm-gated dry-run by default.
- **Single active room**, with a fresh slug per start — a late turn from a stopped
  room can't bleed into a new one. Mind/room slugs are path segments, guarded by
  `assertSafeSlug` / `isSafeSlug` before they touch the filesystem.

## Comments

`CONTRIBUTING.md` is authoritative. Default to **none**. Add a comment only when
it captures a non-obvious **why** a future reader needs — a hidden constraint, a
workaround, a non-obvious order dependency, an invariant from another module.

- No multi-paragraph blocks or bulleted `/* */` explanations. A one-sentence
  soft-wrap over two lines is fine.
- No PR-point-in-time narration ("Codex flagged…", "Per review…", "Addresses
  #N"). That belongs in the commit message or PR body.
- No what-just-changed notes, and no restating well-named code.

## Conventions

- **Commits**: conventional (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`,
  `test:`), one-sentence subject under ~70 chars. The squashed PR title is what
  release-please reads to build the changelog and pick the version bump, so the
  **PR title must be a conventional commit** (`pr-title.yml` enforces it).
- **PR body**: *What* / *Why now* / *Test plan* (the template), plus an optional
  *Risk & rollback*. No "Generated with" footers.
- **Workflow descriptions**: bundled workflows use the `Use when / Triggers /
  Does / NOT for` shape so the SPA workflow cards render scannably. Match it.
- **No abstractions ahead of a concrete second caller.**

## Documentation

The docs site lives under `docs/` — a self-contained **Astro Starlight** project
(its own `bun install` + lockfile). Read **`docs/STYLE.md`** (it extends keelson's
style guide) before adding or editing a docs page. Build locally with
`cd docs && bun install && bun run build`; `docs.yml` builds and deploys it on
every `docs/**` change.
