# Per-Mind tools — scoping a speaker's tool rail

> **Status: implemented.** How a Mind's declared capabilities become the tool
> rail of its room turn. Companion to [A2A-communication.md](./A2A-communication.md)
> (the `Mind.tools` field) and [C1-agent-invocation.md](./C1-agent-invocation.md)
> (the `runAgentTurn` seam this projects onto). Where this and C1 disagree, C1 wins.

## The decision (one paragraph)

A speaker reaches **only** the tools its Mind declares, intersected with what the
room permits. `Mind.tools` is a list of **capability slugs** (a curated, friendly
vocabulary — *not* raw tool names); `RoomDriverDeps.turnTools` is the **room-safe
pool**, the ceiling of what any room turn may invoke (today just the lens write
seam). At each per-speaker turn the driver resolves the Mind's slugs to tool names
and intersects them with the pool. A Mind that declares nothing runs **text-only**
— the room default — never "all tools."

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

## Declaring tools (genesis)

The `chamber-genesis` workflow lets the authored soul declare capability slugs;
`chamber_emit_genesis` filters them to the known vocabulary
(`KNOWN_CAPABILITY_SLUGS`) before persisting, so an unknown slug is dropped rather
than failing the run. `Mind.tools` round-trips through `mind.json`
(`src/minds-store.ts`).

## Not in scope

Per-Mind *permissioning* — ASK/DENY at the tool-call seam — waits on the keelson
core policy layer (keelson #215). This delivers the mapping and least-privilege
scoping only. Extending the vocabulary is a one-line addition to `CAPABILITIES`
once a new room-safe tool exists.
