# Per-Mind tools — scoping a speaker's tool rail

> **Status: implemented.** How a Mind's declared capabilities become the tool
> rail of its room turn. Companion to [A2A-communication.md](./A2A-communication.md)
> (the `Mind.tools` field) and [C1-agent-invocation.md](./C1-agent-invocation.md)
> (the `runAgentTurn` seam this projects onto). Where this and C1 disagree, C1 wins.

## The decision (one paragraph)

A speaker reaches **only** the tools its Mind declares, intersected with what the
room permits. `Mind.tools` is a list of **capability slugs** (a curated, friendly
vocabulary — *not* raw tool names); `RoomDriverDeps.turnTools` is the **room-safe
pool**, the ceiling of what any room turn may invoke (the lens write seam by
default; a coding room widens it — see [The coding tier](#the-coding-tier-opt-in)).
At each per-speaker turn the driver resolves the Mind's slugs to tool names and
intersects them with the pool. A Mind that declares nothing runs **text-only** —
the room default — never "all tools."

## Resolution

`resolveMindTools(mind, pool)` (`src/capabilities.ts`):

1. No declaration, or an empty/absent pool → `[]` (text-only).
2. Map each slug through `CAPABILITIES` (`{ lens: { tools: ["chamber_emit_lens"],
   summary: … } }`); unknown slugs map to nothing.
3. Keep only names present in the pool, deduped → `{ name }[]`.

The call site is per-speaker (`src/room.ts`, inside `runOneTurn`), so concurrent
rounds get independent rails for free — `runParallelTurn` maps `runOneTurn` per
Mind.

### Why intersect with the pool

The core turn seam (keelson #213, `apps/server/src/rib-agent-turn.ts`) projects a
turn's requested names against the **shared** registry and applies the denylist
floor — it does **not** scope a turn to its own rib (the `ribId` is threaded but
unused). The room-pool intersection is therefore chamber's own allowlist ceiling:
a Mind can never reach a room-control tool (`chamber_room_*`), the genesis write
seam, or another rib's tools — even via a hand-edited `mind.json` — because those
names are not in the pool. The curated `CAPABILITIES` map only ever names
room-safe tools, so the two layers are belt-and-suspenders.

## The coding tier (opt-in)

When the lens seam is wired, the default room-safe pool is the lens write seam
alone, so a room turn is text-or-lens — it never touches the filesystem; without
that seam, room turns are text-only. A room started with `coding: true`
(which **requires** a target `projectId`) layers the **coding pool** on top: the
host built-ins a coding slug authorizes — `code → Bash/Edit/Write`, `read → Read`
(`CODING_CAPABILITY_SLUGS` / `codingToolPool()`, `src/capabilities.ts`). The
intersection is unchanged, so a Mind still reaches only what it declares against
the now-wider pool — a text-only Mind in a coding room stays text-only.

**Granting and confining are one decision.** A turn is offered the coding tools
*only when there is a root to confine it to*: the driver sets the turn's
`allowedDirectories` to its cwd — the project root, or the neutral Chamber home if
the project was deleted mid-room — and withholds the tools entirely when neither
resolves (`runOneTurn`, `src/room.ts`). A `Bash`/`Edit`/`Write` turn therefore
never runs unconfined. The host enforces the boundary off `allowedDirectories`:
keelson's `path_confinement` policy (cross-provider, closing shell-redirect and
symlink escapes) plus the claude provider leaving `bypassPermissions` for the
SDK's `default` permission mode. Chamber's only job is to pass the root.

Why require a project: the project root *is* the confinement boundary. Without one
a coding room would be either unconfined (unsafe) or bounded to a directory with no
code to work on (useless), so `validateStart` rejects `coding` without `projectId`.

The C1 two-layer guarantee still holds on top. The coding built-ins ride the same
`tools` rail keelson's seam projects and gates, so the operator floor
(`KEELSON_WORKFLOW_TOOL_DENYLIST`) and the unified policy engine can still remove a
coding tool from a room turn with the tier on — verified in keelson core
(`apps/server/src/rib-agent-turn.test.ts`).

## Declaring tools (genesis)

The `chamber-genesis` workflow lets the authored soul declare capability slugs;
`chamber_emit_genesis` filters them to the known vocabulary
(`KNOWN_CAPABILITY_SLUGS`) before persisting, so an unknown slug is dropped rather
than failing the run. `Mind.tools` round-trips through `mind.json`
(`src/minds-store.ts`). The coding slugs (`code`/`read`) are part of the vocabulary
and so a Mind may declare them, but they resolve to nothing outside a coding room —
declaring `code` is harmless until the room opts into the tier.

## Not in scope

Per-Mind *permissioning* — ASK/DENY at the tool-call seam — waits on the keelson
core policy layer (keelson #215). This delivers the mapping and least-privilege
scoping only. Extending the vocabulary is a one-line addition to `CAPABILITIES`
once a new room-safe tool exists.
