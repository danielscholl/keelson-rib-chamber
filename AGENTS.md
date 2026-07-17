# AGENTS.md

This is the canonical project guidance for coding agents — Codex, GitHub
Copilot's coding agent, and (via an import in `CLAUDE.md`) Claude Code — working
in this repository. `CONTRIBUTING.md` is the authoritative human guide; this is
its agent-facing distillation.

It records only what stays true across changes: the contract, the commands, the
recurring patterns, and the invariants. Inventories — how many views, workflows,
tools, strategies, or actions exist and what they are named — live in the code,
change often, and are deliberately NOT recorded here. Derive them from the code
when you need them; the `/prime` command does exactly that.

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

## Architecture (the shapes, not the inventory)

The whole rib is one `Rib` object exported from `src/index.ts` — and `index.ts`
is only the **composition root**: the `Rib` literal, `registerTools` as
assembly, `onAction` delegating to `dispatchChamberAction`, and `dispose`
composing the module teardowns. Each subsystem lives in its own module exposing
a `bindX(seams)` / `disposeX()` pair built in `registerTools` and torn down in
`dispose()`. The recurring shapes:

- **Every view is a board a producer publishes.** No hand-coded UI. `RIB_VIEWS`
  is mutable by design: per-subject HTML lenses push their own
  `canvasKind: "html"` entries at runtime via the `declareView` seam, because
  the host resolves a key's canvas kind by EXACT match. Static keys live in
  `src/keys.ts`; live rooms and lenses get dynamic per-slug keys.
- **Workflows** (`contributeWorkflows`, `src/workflows.ts`) come in two producer
  shapes: deterministic **collectors** (`bin/collect-*.ts` scripts that read the
  data home) and paid **agent-turn authors** (genesis, the lens family). Where a
  paid turn must not fire idle, the workflow self-gates: a cheap gate node reads
  a persisted fingerprint/watermark and the author node runs only when it
  advanced. Not everything is a workflow — the Briefing is the rib-owned
  attention gate (`brief-gate.ts`), published in-process and gated fail-closed
  against a persisted watermark, and the Chamber panel and Convene composer are
  likewise in-process (`runtime.ts`), which is why those bind no workflow.
- **Tools are a seam ladder.** `registerTools` returns a tool only when every
  host seam it needs is present — a missing seam means the tool is never
  returned, not one that half-runs. The rungs: disk-path-only tools (write
  seams, read-only listers, cleanup) are always present; lens/exhibit tools need
  the snapshot-manager and `registerRegion` seams; room-control tools and the
  room driver additionally need the agent-turn seam (`runAgentTurn`).
- **Actions** (`onAction` → `dispatchChamberAction`, `src/actions/`) are
  payload-carrying board actions rather than a static `actions[]`, since a
  payload-less button can't carry input. Actions relayed from a sandboxed
  HTML-lens iframe arrive with origin `canvas-html` and are gated to a non-paid,
  non-destructive subset (`FRAME_SAFE_ACTIONS`) — that markup is LLM-authored
  and can auto-fire on load, so it must never reach a destructive, paid, or
  self-promoting verb.
- **Strategies are pure.** An orchestration strategy (`src/strategies/`) reads
  room state plus the transcript and returns the next turn decision; it does no
  I/O and knows nothing about providers or the host. The **driver**
  (`src/room.ts`) owns turns, persistence, and publishing. The strategy registry
  sits behind an own-property guard so a crafted strategy name can't resolve an
  inherited `Object` member.
- **Agents + commands** — every Mind is enterable as a keelson agent
  (`listAgents` / `resolveAgent`), and slash commands front the same seams the
  boards use.

## Layout (where things live)

- `src/index.ts` — the composition root (wiring, never implementations).
- `src/room.ts` — the room driver (turns, persistence, publishing);
  `src/ports.ts` — its two seams (RoomStore, RoomPublisher);
  `src/room-lifecycle.ts` — driver + key-registry wiring.
- `src/strategies/` — the pure turn strategies plus the shared synthesis close
  helper; registered in `strategies/index.ts`.
- `src/brief-gate.ts` / `src/reflection-gate.ts` — the paid-turn gates;
  `src/runtime.ts` — host seams + the in-process standing panels;
  `src/lens-runtime.ts` — the lens registries.
- `src/boards/` — deterministic board builders the rib composes (a lens/exhibit
  is what a Mind authors; these are the rib-built boards).
- `src/tools/` — the MCP tools; `src/actions/` — the board action handlers.
- `src/workflows.ts` — the workflow definitions; `bin/` — the out-of-process
  collectors behind the deterministic ones.
- `src/types.ts` — Mind, Room, strategy decision types; `src/keys.ts` — the
  static snapshot keys; the `*-store.ts` modules — file-based persistence.

## Invariants worth protecting

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
  each on its own per-slug key — capped at `MAX_ACTIVE_ROOMS`, since every room
  drives its own loop of paid turns. Each start mints a fresh slug, so a late
  turn from a stopped room can't bleed into a new one. Mind/room slugs are path
  segments, guarded by `assertSafeSlug` / `isSafeSlug` before they touch the
  filesystem.

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
