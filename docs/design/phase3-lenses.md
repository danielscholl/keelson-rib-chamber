# Chamber Rib — Agent-Authored Lenses (C2, fixed-pool interim)

*Ships the PRD's "Lens" capability without a base-contract change, by pre-declaring
a small pool of lens snapshot keys instead of registering views dynamically.
Companion: [PRD.md](../PRD.md) §6 (Phase 3), [phase3-rooms.md](./phase3-rooms.md) §6
(why lenses are orthogonal to the room driver).*

## What a lens is

A **lens** is a view a Mind authors *itself*: one agent turn composes a canvas
`board` payload and publishes it to a `rib:chamber:lens:*` snapshot key, where it
renders as a live panel with no hand-coded UI. It is the *output* of a turn, not an
addressable peer — so it is orthogonal to the room strategies and does not ride the
room driver (`src/room.ts`).

Phase 0 already proved an agent can author *one fixed* lens (`chamber-brief` →
`rib:chamber:brief`, `src/index.ts`). This slice lets a Mind author lenses **on a
subject of its choosing**, the PRD §5 hero capability.

## The base gap, and why a fixed pool

The clean design is a Mind emitting an arbitrary `rib:chamber:lens:<mind>:<id>` key.
That needs **dynamic view registration**, which the harness lacks: a rib's `views`
is a static array read once at boot (`@keelson/shared` `Rib.views`), there is no
`registerView` seam, and the SPA only re-fetches the manifest on restart. Landing
that base seam is a separate epic (issue
[#28](https://github.com/danielscholl/keelson-rib-chamber/issues/28)).

The interim that needs **no base change**: pre-declare a fixed pool of lens keys in
the static manifest and let a tool fill them at run time. Because the keys ship in
the boot manifest, a freshly authored lens renders over the live WS push with no
manifest re-fetch.

## Mechanism (`src/lens.ts`)

- **Slot pool** — `LENS_SLOT_COUNT` (3) keys `rib:chamber:lens:0..2`, declared as
  static `views` and laid out in a Chamber surface row *after* the room row.
- **`createSlotAllocator(count)`** — a pure LRU map from a logical lens `id` to a
  fixed slot: re-authoring the same `id` reuses its slot (the panel updates in
  place); a new `id` takes the next free slot, then evicts the least-recently-
  authored once the pool is full. Pure and unit-tested apart from the publish side.
- **`createLensRegistry(sm)`** — registers each slot key on the snapshot manager via
  the shared coalescing publisher (`src/room-publisher.ts`), seeded with
  `emptyLensBoard()` and guarded fail-closed by `expectView(key, "board")`. Its
  `publish(id, board)` routes the board to the `id`'s slot and broadcasts.
- **`chamber_emit_lens` tool** (`src/index.ts`) — input `{ id, board }`, the board
  typed by `canvasBoardViewSchema`. The `id` is canonicalized (`Release Risks` →
  `release-risks`) by a lens-specific normalizer (not the Mind slugifier, whose
  48-char cap could collide distinct long subjects) so the same subject maps to one
  slot and re-authoring updates in place. Registered whenever the snapshot-manager seam is present (independent of the
  room's `runAgentTurn` seam). Mirrors the `chamber_emit_genesis` write-seam shape.
- **`chamber-lens` workflow + `/lens` command** — one prompt turn composes a board
  for `$ARGUMENTS` and calls `chamber_emit_lens` (the genesis pattern: `allowed_tools`
  + `fail_on_tool_error`). `/workflow run chamber-lens <subject>`, or the `/lens
  <subject>` slash command that mirrors `/genesis`, is the entry point.

## Decisions

- **Fixed pool size 3.** Small enough to lay out as one surface row; the LRU
  eviction keeps the pool honest under more subjects than slots. A constant, easy to
  tune.
- **No new publish abstraction.** Reuse `createCoalescingPublisher` with a
  per-slot seed (its only change: an optional `seed` argument; the room call site
  and its test are untouched).
- **Fail closed, loudly.** The tool parses the board with `canvasBoardViewSchema`
  (the model-facing shape), then `createLensRegistry.publish` re-validates through
  the full `canvasViewSchema` gate (`expectView`) *before* allocating a slot. The
  union gate carries the uniqueness refine the member schema lacks; without the
  eager check, a board that passes the member schema but fails the union (e.g. a
  table section with duplicate column keys) would be silently dropped at
  `recompose` — the manager swallows the validate throw and keeps the prior frame —
  while the caller is told it published. Validating before allocate also stops a bad
  board from evicting a live lens for nothing.
- **`id` is a routing key, not a path.** Lenses publish to fixed slot keys, never an
  `id`-named key on disk, so `id` needs no filesystem-safety guard (unlike Mind
  slugs) — but it is canonicalized (a lens-specific normalizer) for stable slot reuse.
- **Singleton lifecycle.** The slot pool is a module singleton created once in
  `registerTools` and disposed in `rib.dispose()` (the room-driver pattern). It owns
  the slot keys' snapshot registrations, so disposing releases them and a
  re-bootstrap re-registers without the manager rejecting duplicate keys.

## Deferred (still base-gated)

- **Unbounded per-Mind lens keys** (`rib:chamber:lens:<mind>:<id>`) — needs a base
  `registerView` seam + SPA manifest re-fetch. This slice is the interim; #28 stays
  open for the base path.
- **A Mind authoring a lens mid-room-turn** — the room turns do not yet expose
  `chamber_emit_lens` in their `allowed_tools`. Additive follow-up; the standing
  entry point is the `chamber-lens` workflow.
