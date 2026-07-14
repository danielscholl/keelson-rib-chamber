# Copilot code review — instructions for @keelson/rib-chamber

Chamber is a **rib** (extension) for
[Keelson](https://github.com/danielscholl/keelson), the local-only agent harness
— a single-package Bun + TypeScript project. It adds the multi-agent layer
(genesis agents, agent-to-agent rooms, agent-authored lenses) and ships **zero
React**. See `AGENTS.md` for the full architecture.

## How to review

Be terse and cite `file:line`. Prefer a few high-signal findings over breadth.
This is single-user, local software — ignore speculative scale, multi-tenant, and
micro-optimization concerns. No poems, jokes, or emoji.

## Comment policy — do NOT push comments or docstrings

`CONTRIBUTING.md` sets a deliberate **no-narration** policy. Do **not**:

- Ask for docstrings or comment coverage. Comments are optional; a one-line
  soft-wrap is fine and should not be flagged.
- Suggest comments that narrate what a PR changed, restate well-named code, or
  recap review history.

A comment is warranted only when it captures a non-obvious **why** (a hidden
constraint, a workaround, an order dependency, an invariant from another module).
Flag a comment only when it *violates* the policy (narration / what-just-changed),
not when one is merely absent.

## Invariants to flag when a change breaks them

- **Zero React into the trusted SPA.** Surfaces render through the canvas `board`
  contract. Flag any hand-coded UI / React shipped from the rib.
- **Attach only through the `Rib` contract** (`@keelson/shared`). Flag reaching
  around it into harness internals, or a new hard dependency on a harness package
  beyond the `@keelson/shared` peer.
- **Strategies are pure** (`src/strategies/**`). Flag any I/O, provider call, or
  host coupling added there — a turn decision reads room state and returns
  `speak`/`end` only. The driver (`src/room.ts`) owns I/O.
- **Fail closed.** Boards publish through `validate` (`expectView`) and node
  `output_schema` guards; the driver and room tools refuse to act when their seams
  (`runAgentTurn`, snapshot manager) are absent. Flag a publish/produce path that
  could emit an unvalidated or malformed board, or a seam-absent path that
  half-runs instead of failing closed.
- **Paid agent turns are guarded.** Each room turn is a billed agent call. Flag a
  new room/turn entry point that bypasses the turn-budget cap
  (`MAX_ROOM_TURN_BUDGET`) or the `confirm`-gated dry-run on `chamber_room_start`.
- **Bounded concurrent rooms + fresh slug per start.** Rooms run concurrently,
  each on its own `rib:chamber:room:<slug>` key, capped at `MAX_ACTIVE_ROOMS`.
  Flag changes that could reuse a room slug, let a stopped room's late turn write
  into a new room's directory, or add a start path that bypasses the cap.
- **Slug safety.** Mind/room slugs are filesystem path segments. Flag any slug
  that reaches the filesystem without passing the safe-slug guard
  (`assertSafeSlug` / `isSafeSlug`).
- **Tool schema vs the model.** Tool input schemas are fed to the model via
  `z.toJSONSchema`, which lists `z.default()` fields as `required`. Flag a
  `.default()` added to an optional tool field where `.optional()` plus a
  post-parse default is intended (e.g. `confirm`, `turnBudget`).

## What NOT to flag

- Missing docstrings or comments (see the comment policy above).
- Tests (`test/**`) using `bun:test`, mock-vs-real tradeoffs, fakes under
  `test/helpers/`, or reaching across the package boundary as a drift guard —
  these are intentional.
- The absence of an abstraction — this repo avoids abstractions ahead of a
  concrete second caller.
