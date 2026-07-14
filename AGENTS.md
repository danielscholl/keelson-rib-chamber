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

- **Views + a surface** — eight static snapshot keys: seven defined in `src/keys.ts`
  (`rib:chamber:presence`, `:roster`, `:rooms`, `:lenses`, `:exhibits`, `:digest`,
  `:brief`) plus `rib:chamber:lens-html`, defined in `src/lens-html.ts`, alongside
  dynamic per-room (`rib:chamber:room:<slug>` for live rooms,
  `rib:chamber:room-view:<slug>` for the drawer view) and per-lens keys, bound to the
  canvas renderer, and the **Chamber** nav surface that lays them out. `RIB_VIEWS` is
  mutable: each per-subject HTML lens pushes its own `canvasKind: "html"` entry at
  runtime via the `declareView` seam, because the host resolves a key's canvas kind
  by EXACT match. No hand-coded UI: every view is a board a producer publishes.
- **Workflows** (`contributeWorkflows`, `src/workflows.ts`) — nine. Four
  deterministic collectors that read the data home (`chamber-roster` /
  `chamber-rooms` / `chamber-lenses` / `chamber-exhibits`, each backed by a
  `bin/collect-*.ts`); four agent-turn authors (`chamber-genesis` writes a Mind's
  SOUL.md via the `chamber_emit_genesis` seam; `chamber-lens` authors a lens board;
  `chamber-lens-refresh` re-emits a living lens under the same id;
  `chamber-lens-html` authors a sandboxed HTML page); and `chamber-digest`
  (self-gating: a gate bash node reads the Chamber fingerprint, an agent-turn author
  node runs only when the fingerprint advanced, and an always-on publish node
  re-reads the store every tick — so the Digest board stays live but a paid turn
  fires only on a real change). The **Briefing** (`rib:chamber:brief`) is NOT a
  workflow — it is the rib-owned attention gate (`evaluateBriefGate`,
  `src/brief-gate.ts`, backed by `src/chamber-state.ts` and `src/watermark-store.ts`):
  a room ending or a lens changing promotes it to one agent-authored board, gated
  fail-closed against a persisted watermark so a quiet Chamber runs no paid turn.
  The Chamber panel and Convene composer are likewise in-process (`runtime.ts`),
  which is why they bind no workflow.
- **Tools** (`registerTools`) — a **seam ladder**, so a missing host seam means a tool
  is never returned rather than one that half-runs. Always present (they need only the
  disk paths): the `chamber_emit_genesis` and `chamber_emit_digest` write seams, five
  read-only tools (`chamber_list_minds` / `_list_rooms` / `_list_lenses` /
  `_list_exhibits` / `chamber_room_transcript`), and two cleanup tools
  (`chamber_retire_mind`, `chamber_room_delete`). The lens and exhibit tools
  (`chamber_emit_lens`, `chamber_retire_lens`, `chamber_table_exhibit`,
  `chamber_delete_exhibit`, `chamber_emit_lens_html`) need the snapshot-manager **and**
  `registerRegion` seams. The room-control chat tools (`chamber_room_start` / `_say` /
  `_stop` / `_status`) and the room driver additionally need the agent-turn
  (`runAgentTurn`) seam. Absent those, room actions fail closed.
- **Actions** (`onAction` → `dispatchChamberAction`, `src/actions/`) — payload-carrying
  board actions rather than a static `actions[]`, since a payload-less button can't
  carry input: entering and managing Minds (`enter-mind`, `retire`, `set-model`, the
  genesis boot-card verbs), the bench draft that assembles a cast (`draft-set`,
  `convene` — unseating is a second click on the seat card), the room controls
  (`room-start` / `room-inject` / `room-stop` / `room-delete` / `room-open`), and the
  lens/exhibit verbs. Actions relayed from a sandboxed HTML-lens iframe arrive with
  origin `canvas-html` and are gated to a non-paid, non-destructive subset
  (`FRAME_SAFE_ACTIONS`) — that markup is LLM-authored and can auto-fire on load, so
  it must never reach `retire` / `room-*` / `set-model` / `convene`.
- **Agents + commands** — every Mind is enterable as a keelson agent
  (`listAgents` / `resolveAgent`); `/mind` opens a Mind as a seeded chat,
  `/genesis` authors a new Mind from a brief, and `/lens <subject>` authors a
  canvas lens board on a subject.

`src/index.ts` is only the **composition root** — the `Rib` literal, `registerTools`
as assembly, `onAction` delegating to `dispatchChamberAction`, and `dispose` composing
the module teardowns. Each subsystem lives in its own module: the briefing gate
(`brief-gate.ts`), reflection gate (`reflection-gate.ts`), host-seam + standing-panel
runtime (`runtime.ts`), lens registries (`lens-runtime.ts`), and room lifecycle + driver
wiring (`room-lifecycle.ts`) each expose a `bindX(seams)` / `disposeX()` pair; the MCP
tools live under `src/tools/` and the board action handlers under `src/actions/`.

Orchestration **strategies** (`src/strategies/`: `sequential`, `group-chat`,
`open-floor`, `concurrent`, `review`, `magentic`, registered in `strategies/index.ts`
behind an own-property guard, so a crafted strategy name can't resolve an inherited
`Object` member) are **pure** — they read room state plus the transcript and return the
next turn decision (`speak` / `speak-parallel` / `moderate` / `synthesize` / `manage` /
`assign` / `end`; `synthesis.ts` is a shared close helper, not a strategy). They do no I/O
and know nothing about providers or the host; the **driver** (`src/room.ts`)
owns turns, persistence, and publishing.

### Invariants worth protecting

- **`index.ts` stays a composition root.** It declares the `Rib` and wires modules —
  it does not grow implementations back. A new subsystem (state + functions) gets its
  own module with a `bindX(seams)` / `disposeX()` pair built in `registerTools` and torn
  down in `dispose()`; `index.ts` gains wiring lines, not logic.
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
- **Bounded concurrent rooms, fresh slug per start.** Rooms run concurrently —
  each on its own `rib:chamber:room:<slug>` key and surface region — capped at
  `MAX_ACTIVE_ROOMS`, since every room drives its own loop of paid turns. Each
  start mints a fresh slug, so a late turn from a stopped room can't bleed into a
  new one. Mind/room slugs are path segments, guarded by `assertSafeSlug` /
  `isSafeSlug` before they touch the filesystem.

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
