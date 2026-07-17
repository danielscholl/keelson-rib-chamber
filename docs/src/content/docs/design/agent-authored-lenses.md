---
title: Agent-authored lenses
description: Why a lens is the output of one agent turn, why the publish is fail-closed, and how the standing briefing rides an attention gate
sidebar:
  order: 6
---

A lens is the rib's architectural hero: an agent authors its own view. One turn
composes a canvas board and publishes it, and it renders with no hand-coded UI.
This record states the shape that ships, the alternatives it replaced, and the
three decisions that keep it honest: a fail-closed publish, an operator-held pin
that decides what claims the surface, and an attention gate that keeps "an agent
authors its own view" from costing a turn it did not need.

## A lens is a turn, not a peer

A lens is the output of a single agent turn, not an addressable participant. It is
the product of one Mind's turn, the same way genesis produces a Mind and a room
turn produces a reply. That framing decides its place in the rib: because a lens
has no peer to talk to, it is orthogonal to rooms. It does not ride the room driver
and does not depend on a strategy.

One turn composes a board and publishes it to a `rib:chamber:lens:{id}` key, read
in the drawer from its index card and rendered on the surface only once pinned.
The lens seam,
`chamber_emit_lens`, is reachable two ways: as a standalone workflow turn
(`chamber-lens` or `chamber-lens-refresh`) and as a chat tool. It is not a room
turn-tool. Inside a room a Mind reaches a separate seam, `chamber_table_exhibit`,
which tables a first-class exhibit rather than a lens: a sibling species that
shares the store, id space, and key namespace but registers a key with no panel of
its own, carrying a driver-witnessed `sourceRoom` that reaches it from the Tabled
section of the room that tabled it.

## Fail closed before you register or persist

The board is validated through the full canvas gate before any key or region is
registered and before it is persisted. The publisher runs `expectView` over the
board first, registers the snapshot key and the surface region only if that passes,
then publishes, and writes the record to disk only after the live publish succeeds.

The order is the decision. The tool's input schema validates the board as a board
member, but the full view gate carries a uniqueness refine the member schema lacks.
A board that passes the member schema but fails the union, for example a table
section with duplicate column keys, would otherwise be accepted by the tool and
then silently dropped at recompose: the manager swallows the validate throw and
keeps the prior frame while the caller is told it published. The eager check makes
a bad board fail loudly at the call instead, and it stops that bad board from
evicting or re-registering a live panel for nothing.

## Per-id and unbounded

The shipped model is per-id and unbounded. Each subject gets its own key through
dynamic registration, and re-authoring the same id updates that lens in place
rather than adding another. The id is canonicalized into a stable routing key,
distinct from the Mind slugifier: no short length cap, so two long subjects cannot
collide on a shared prefix, and no synthetic fallback, so an id with no usable
characters is rejected rather than substituted.

The rib sets no fixed limit, no pool, and no eviction of its own. The only ceiling
is the harness per-surface region limit. A rejected region does not get silently
dropped: the registration unwinds cleanly, dropping the snapshot key it had already
made, and the failure surfaces rather than leaving a dangling key behind.

:::note
An earlier interim design used a small fixed pool of pre-declared lens keys, filled
at runtime and evicted least-recently-authored when full. It existed only because
the harness lacked dynamic view registration: a rib's views were a static array read
once at boot. Once region registration landed, the per-id model replaced the pool
outright. The fixed pool and its eviction are not the shipped behavior.
:::

## Indexed by default, pinned by choice

Unbounded per-id keys are cheap. Unbounded per-id *panels* were not, and the first
shape shipped both: a lens registered a key and a region together, so every subject
anyone ever authored claimed permanent surface. Now the region is registered only
when the lens is pinned, and an unpinned lens is a key plus an index card, read
through the drawer with the same verb an exhibit uses. That is the shape an exhibit
always had, so the predicate is one term rather than a second model.

The cost is what forced it. A region carries the refresh wiring, and lens regions
are args-bearing, which the server heartbeat skips, so refresh is client-driven and
runs above the collapsed check. Every living lens was billing an agent turn per
tick while the Chamber tab was open, read or not, folded or not. Pinning bounds
that to the set the operator chose, which makes "how many lenses may live" and "how
much do they cost" separate questions for the first time.

Pin is **operator-only**, and deliberately so. It is not on `chamber_emit_lens`, is
not an MCP tool, and is off `FRAME_SAFE_ACTIONS`, so an LLM-authored page cannot
pin itself to the surface. A lens that could claim main-surface real estate is the
claim-the-surface behavior the pin exists to end, and an authoring Mind is exactly
the party with an incentive to.

Two guards keep the state honest. `pinned` is a **required** publish parameter, so
a forgotten thread is a typecheck failure rather than a runtime surprise: every
publish rebuilds the record and the store writes only what it is handed, so a
dropped pin would have quietly unpinned a living lens on its own refresh cadence
within the hour. And pinning holds `updatedAt` rather than re-stamping it, because
the brief and digest gates fingerprint on that field and a re-stamp would buy two
paid turns for content that did not change.

Disk stays authoritative. A lens whose region registration failed has a record and
no live entry, so the pin path always runs its live half and re-registers from the
loaded record when it finds one missing, and the durable write is skipped only when
the record already agrees. A pin converges on the next attempt rather than
reporting success over a panel that never appeared.

## The briefing is rib-driven, not a lens

The standing Briefing is also an agent-authored board on its own key, but it is a
special case. It is not a per-subject lens and no Mind authors it on demand. It is
composed in-process from three attention-ordered registers: the Delta, the Digest,
and the Record. Only the Delta is agent-authored
and paid: the attention gate governs it alone, and that gate is the cost-safety
story for letting an agent author its own view. The Digest is read from
`digest.json`, authored by the separate `chamber-digest` workflow, and the Record is
a deterministic reverse-chron feed of recent activity that always renders.

The Briefing is seeded with a quiet board at boot, and a single gate is the only
path that may run the briefing turn. That turn is paid, so the gate runs it only
when there is substance to brief: a room ended, a lens changed, or an exhibit was
tabled since a persisted watermark. The exhibit case is not a special one. Both
species share the lens fingerprint set, so a tabled or re-tabled deliverable reads
as changed exactly as a re-authored lens does. A retire alone is not substance,
because a removed record is no longer in the current fingerprints the watermark is
compared against, so it never promotes the Briefing. When nothing has changed, the
quiet path authors nothing: no turn, and in the steady state no publish or write
either.

The briefing turn composes a board from metadata only. It is handed the names,
statuses, and turn counts of ended rooms and the scope and reason of changed lenses,
never any transcript text, and it runs with no tools. It cannot reach into a room's
content to write the Briefing.

Evaluations are serialized. A concurrent pair of triggers, a room ending as a lens
lands, await-chains so the second runs after the first. The first turn advances the
watermark, so the second typically re-reads as quiet and authors nothing. Concurrent
triggers collapse to at most one paid turn.

## Related

- [Lenses](../../concepts/lenses/): the concept, and the two ways to author one.
- [Per-mind capabilities](../per-mind-capabilities/): the `lens` capability a Mind declares to table an exhibit mid-room.
- [Keelson snapshots](https://danielscholl.github.io/keelson/docs/reference/snapshots/): the snapshot keys and board frames a lens publishes onto.
