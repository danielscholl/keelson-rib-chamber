# A2A — how Minds communicate in Chamber

> **Status: decided (design), reviewed. Shapes Phase 2 (rooms) and Phase 3.**
> This records what agent-to-agent communication *is* and *is not* in the
> Keelson Chamber rib. Companion to [C1-agent-invocation.md](./C1-agent-invocation.md),
> which defines the turn seam this builds on — C1 is the source of truth for the
> `runAgentTurn` contract and the fire-and-return room loop; where this doc and
> C1 disagree, C1 wins. Concepts studied from `ianphil/chamber`
> (`.github/extensions/a2a-*`, `packages/services/src/a2a`, its
> `agent-vs-tool-surface.md` principle) and the `pi-chamber` strategy port
> (`ARCHITECTURE.md` §6).

## The decision (one paragraph)

**A2A is a room-internal, driver-mediated concept — not a subsystem.** Minds
communicate only as participants in a **room**, and the room **driver** is the
router: it holds the transcript, decides what happens next (the strategy), and
runs each speaker as one stateless `ctx.runAgentTurn` ([C1](./C1-agent-invocation.md)).
We **keep** chamber's *conceptual* model — the identity principle, a Mind
descriptor, a transcript message shape, a turn budget — and **reject** its
*transport* — the Switchboard relay, the mailbox, poll/lease/ack, per-Mind
inboxes, and autonomous long-lived Mind sessions. Chamber needs a message bus
because its Minds are independent processes; Keelson's room Minds are
driver-invoked stateless turns, so the driver already *is* the bus.

## The principle (Keelson invariant)

> **Identity is at the Mind level. Capabilities are not addressable.**

Adopted directly from chamber's `agent-vs-tool-surface.md`. Only a **Mind** (a
genesis'd, persistent reasoning identity) is an addressable participant. A rib,
a `registerTools` tool, a contributed workflow, an MCP server — these are
**capabilities a Mind invokes during its turn**, behind Keelson's permission /
redaction. They are never room participants and never "agents."

Enforcement in this rib (stated as gates, not just description):

- A room's `participants` and a `TurnEntry.from` are always a `MindSlug`, or one
  of the reserved authorities `"director"` / `"system"`. The driver never routes
  a turn to a tool.
- The **driver is the sole authority for `from`.** It stamps the Mind it
  actually invoked; an agent never self-asserts identity. `room-inject` forces
  `from: "director", role: "director"` server-side regardless of payload.
- A capability a Mind may use goes on the Mind's `tools` (mapped onto C1's turn
  tool args — see *Data shapes*), never into the participant set.

## The boundary rule

- **Multi-Mind ⟹ a room.** Mind-to-Mind conversation happens only inside a room.
- **Single-Mind ⟹ a turn, anywhere.** Genesis authoring a soul (Phase 1) and a
  Mind authoring a lens (Phase 3) are each *one* Mind running *one*
  `runAgentTurn` with no peer. That is the "lens (pull)" model, **not A2A**.
- **Minds persist but are dormant outside invocation.** A Mind exists in the
  roster (identity, soul, memory) with no running loop and no inbox; it does
  nothing until a room turn or a solo lens turn invokes it.

## Data shapes

Keelson-native, modeled on chamber's envelope but stripped of relay ceremony
(no `supportedInterfaces`, `protocolBinding`, `capabilities.streaming`, or
`taskId` — none have a consumer here). None of these types exist in the base
yet; like `runAgentTurn` (C1) they are **to be defined**, here in the rib.

**`MindSlug`** — `type MindSlug = string`. The single stable identifier for a
Mind. It **is** the directory slug under the rib data home (`minds/<slug>/`,
`rooms/<slug>/`, `ARCHITECTURE.md` §8) **and** the addressing identity in a
transcript. One name, used everywhere — no separate `id`.

**`Mind`** — the roster entry *and* the addressing identity. This *defines* the
`MindSpec` referenced in `ARCHITECTURE.md` §6 (not yet a base type):

```ts
interface Mind {
  slug: MindSlug;        // stable id + directory slug + transcript `from` value
  name: string;          // display name (roster card)
  persona: string;       // system prompt / role — the runAgentTurn `system`
  model?: string;        // optional model pin
  fallbackModels?: readonly string[]; // model-failover order (reliability, not cosmetic)
  tools?: readonly string[];          // capability slugs this Mind may invoke (see below)
  // soul/memory live as files under the rib data home (C3); not all loaded here
}
```

`Mind.tools` are **capability slugs**, not C1 tool descriptors. At the call site
the driver maps them onto C1's `runAgentTurn` tool rail (`resolveMindTools`),
intersected with the room-safe pool (`RoomDriverDeps.turnTools`); **omitting
`tools` yields a text-only turn — the room default** (no Bash/Edit between
conversation turns). The driver never passes `tools: mind.tools` directly:
`string[]` slugs are not the `{ name }[]` shape C1 expects, and selecting nothing
must mean text-only, not "all tools." See [per-mind-tools.md](./per-mind-tools.md)
for the vocabulary and the room-pool ceiling.

**`TurnEntry`** — one line of `rooms/<slug>/transcript.jsonl` (`ARCHITECTURE.md`
§8) and the unit the room board renders:

```ts
interface TurnEntry {
  messageId: string;
  roomSlug: MindSlug;    // the room's slug = the conversation thread (chamber's contextId)
  turnIndex: number;     // monotonic across the room; drives the turn budget
  round?: number;        // round number for round-based strategies (group-chat)
  from: MindSlug | "director" | "system"; // who authored it; "system" = driver/moderator-authored
  role: "agent" | "director" | "system";
  parts: { text: string }[];
  aborted?: boolean;     // turn was cancelled mid-flight (room-stop / dispose)
  at: string;            // ISO timestamp — stamped by the driver, never the agent
}
```

`roomSlug` is the only addressing context — there is no cross-room thread, so one
id suffices. A driver/moderator-authored entry (a round marker, a non-Mind
moderation note) uses `from: "system"`; a group-chat moderator that **is** a
Mind authors with its own `MindSlug`.

**`Room`** — `rooms/<slug>/room.json`; the state every `Strategy` reads:

```ts
interface Room {
  slug: MindSlug;
  name: string;
  strategy: "sequential" | "concurrent" | "group-chat" | "open-floor";
  participants: readonly MindSlug[]; // the closed set, fixed at room-start
  status: "active" | "stopped" | "done";
  turnBudget: number;    // max turns before the driver forces end (the hopCount analog)
  turnIndex: number;     // cursor, mirrors the last TurnEntry
  config?: {             // per-mode config (group-chat / open-floor / synthesis)
    moderator?: MindSlug;
    minRounds?: number;
    endVoteThreshold?: number;
    synthesizer?: MindSlug;
  };
  pending?: {            // one-shot director overrides, consumed-and-cleared per turn
    nextSpeaker?: MindSlug;     // force who speaks next (routing override)
    directionInjection?: string; // prepended to the next prompt (prompt override)
  };
  createdAt: string;
}
```

## The room driver is the router (composition with C1)

> **Update (2026-07-14): superseded — single-active lifted (#29 Slice B).** Gap C5
> closed, then retired for rooms. Rooms now publish to per-room
> `rib:chamber:room:<slug>` keys, so several run concurrently under a
> `MAX_ACTIVE_ROOMS` cap (`src/room-config.ts`); `room-start` no longer refuses
> a second room. A room holds no surface region: it is an activity entered from the
> Rooms index, whose `Open` focuses the driver's per-slug key
> (`src/room-key-registry.ts`). Fresh-slug-per-start is kept, and the driver is still
> the router — only the one-key simplification and the single-active rule below are
> retired. The section below is retained for history.

The driver owns room state under the rib data home and publishes the transcript
to the **single** `rib:chamber:room` board key ([C1](./C1-agent-invocation.md)).
It **registers that key imperatively, exactly once, at `room-start`** (it is not
a `contributeWorkflows` bound key, and the base throws on a duplicate register —
`snapshot-manager.ts:35`).

**Single active room (load-bearing).** Because the design uses one fixed
`rib:chamber:room` key (C1's simplification), **at most one room is active at a
time.** `room-start` MUST refuse — or tear down + re-register — when a room is
already active. (Multiple concurrent rooms would require per-room keys
`rib:chamber:room:<slug>` and a dynamic surface region — gap C5 — which breaks
C1's one-key simplification; explicitly out of scope.) `room-start` on an
existing slug resumes from the persisted `transcript.jsonl` rather than
restarting.

A turn, driven **fire-and-return** from `onAction` (the C1 60s-idleTimeout
constraint — never await the turn in the handler):

1. **Consume director overrides.** Read and clear `room.pending` (`nextSpeaker`, `directionInjection`).
2. **Ask the strategy what's next** — `strategy(room) → StrategyStep` (below). A `nextSpeaker` override forces a `speak` step for that Mind.
3. **Execute the step.** For a speaking turn: compose the prompt from `{ Mind.persona (as `system`) + the transcript so far + any directionInjection }`, then `ctx.runAgentTurn({ system, prompt, /* tools mapped from Mind.tools */, abortSignal })`. Context is rebuilt from the rib-held transcript each turn — Minds are stateless (`resumeSessionId` inert, per C1).
4. **Append + publish.** Append the result as a `TurnEntry` (driver stamps `from`, `turnIndex`, `at`); `recompose("rib:chamber:room")`.
5. **Enforce the budget.** When `turnIndex` reaches `turnBudget`, or the strategy returns `end`, mark the room `done`. This is the loop guard for emergent strategies (chamber's `MAX_HOPS` analog).

The driver is the *only* router. There is no inbox, no delivery, no poll. "B
hears what A said" because A's `TurnEntry` is in the transcript the driver feeds
to B. There is **no directed request/reply or task lifecycle** — every turn is a
broadcast append; addressing a specific Mind is advisory (the strategy's pick or
the director's inject text), never an awaited task, so chamber's
`returnImmediately` and name/alias disambiguation have no analog here.

**Frame publishing.** The driver registers and `recompose`s `rib:chamber:room`
imperatively. The serialize-and-re-run "dirty-flag pump" that defends against
snapshot coalescing lives on the *bound-workflow* publish path (`ribs.ts:261-277`),
**not** the imperative path. Phase 2's serial gate (one turn at a time) means
recomposes never overlap, so this composes today; but any future strategy that
relaxes the serial gate must adopt that pump (C1's open risk), not just "run more
turns."

## Strategies decide; the driver executes

A strategy is a **pure decision over current room state** — but its decision is
richer than "next speaker," so it can express moderation, synthesis, and the
concurrent case (reconciling with `ARCHITECTURE.md` §6, whose orchestration
context is exactly *driver runs the turn + publishes; strategy decides*):

```ts
type StrategyStep =
  | { kind: "speak"; mind: MindSlug }              // run this Mind's turn
  | { kind: "speak-parallel"; minds: readonly MindSlug[] } // concurrent (see below)
  | { kind: "moderate"; mind: MindSlug }           // a moderator Mind turn that picks next
  | { kind: "synthesize"; mind: MindSlug }         // a synthesis turn
  | { kind: "end" };                               // room/round done

type Strategy = (room: Room) => StrategyStep;
```

The driver executes the step (the `spawn`/`emit*` half of §6): it runs the
turn(s) via `ctx.runAgentTurn`, appends the `TurnEntry`(s), recomposes, and
enforces the budget. The strategy never spawns or publishes.

- **sequential** (Phase 2): round-robin `speak` over `participants` until budget.
- **concurrent** (Phase 2 — *structurally present, execution deferred*): returns `speak-parallel`, but **Phase 2 runs it serially** (the publish-coalescing constraint, C1). Spawning N turns in parallel is what makes it concurrent; that is deferred behind the pump, not the strategy shape. Until then `concurrent` behaves like `sequential` — stated honestly so no one "finishes" it by removing the gate and hitting the coalescing bug. (Reconcile with PRD §6: Phase 2 ships **sequential**; concurrent's parallel execution is deferred.)
- **group-chat** (Phase 3): a `moderate` turn (the moderator Mind) picks the next speaker, then a `speak` for the chosen Mind; optional `synthesize` to close a round.
- **open-floor** (Phase 3): the last speaker nominates the next; the driver reads the nomination from its `TurnEntry`.

**Nomination is a validated routing hint, never an identity.** Any Mind-derived
nominee (open-floor, or a moderator's pick) MUST be validated against
`room.participants` (the closed set fixed at `room-start`); the driver rejects
`"director"`, `"system"`, and non-participant slugs, and falls back
deterministically (or returns `end`) on invalid input. A nomination changes who
speaks; it never changes who *authored* an entry.

## Director controls (`onAction`, all fire-and-return)

Canonical `action.type` literals — **`room-start` / `room-next` / `room-inject`
/ `room-stop`** (these are the strings dispatched through `onAction`; the
identical set appears in `ARCHITECTURE.md` §3 and C1):

- **`room-start`** — create/activate (subject to single-active-room above); register the key; seed `participants`.
- **`room-next`** — advance one turn (one driver step). Manual stepping; the director gate.
- **`room-inject`** — set `pending.directionInjection` and/or append a visible `TurnEntry { from: "director" }` (forced server-side). Director overrides are *one-shot pending state consumed before the next turn*, not only a transcript append — a `nextSpeaker` override is routing, a `directionInjection` is a prompt prepend.
- **`room-stop`** — `room.status = "stopped"`; abort any in-flight turn (below).

Results reach the SPA as `snapshot_update` frames on `rib:chamber:room` over the
existing WS — never as the `onAction` HTTP response (C1).

**Cancellation wiring (joins C1).** The driver holds a **per-room
`AbortController`**. `room-stop` (and the rib's `dispose()`) call `.abort()`;
that signal is the `abortSignal` passed into `ctx.runAgentTurn` (C1 line 47). Per
C1, the `runAgentTurn` impl must fire `iterator.return()` on abort — that is what
actually unsticks a hung turn (the Claude SDK ignores its own `abortSignal`,
`prompt.ts:276`). A turn aborted mid-flight is recorded with `aborted: true`.

## Explicitly rejected (and why)

| Rejected | Why |
|---|---|
| Relay / Switchboard / mailbox, poll-lease-ack | Chamber's **cross-install** transport. Keelson rooms are in-process and driver-orchestrated; there are no independent sessions to deliver to. Building it fights C1's stateless-turn + fire-and-return model. |
| Autonomous long-lived per-Mind sessions + inboxes | Minds are dormant outside invocation; no session to receive into. |
| Tools / ribs / workflows as A2A-addressable peers | Violates the principle; routes around Keelson's permission gate; fractures the conversation graph. |
| Directed request/reply + task lifecycle (`taskId`, `returnImmediately`) | Every turn is a broadcast append; the driver never blocks awaiting a peer. No consumer for tasks at MVP. |
| Full Google-A2A envelope (`supportedInterfaces`, streaming caps, alias disambiguation) | No interop consumer in Keelson; the strategy picks from a closed set, so there is nothing to disambiguate. |
| Multiple concurrently-active rooms | Collides with the single `rib:chamber:room` key (C1); needs per-room keys + dynamic regions (C5). Out of scope. |

## Reserved (cheap future, not designed for now)

The `TurnEntry` shape stays envelope-compatible, so **if** a cross-boundary need
ever arises (a Keelson Mind ↔ an *external* autonomous agent), it is an additive
**egress capability the Mind invokes during its turn** — a gated tool, addressed
by the local Mind. It MUST NOT add the external agent to `room.participants` or
emit a `TurnEntry` whose `from` is the external id (that would re-derive
chamber's rejected `COPILOT_EXTENSION` anti-pattern, closed issue #247). The
local Mind owns the address; the external peer stays behind the gate. We are
**not** building toward it.

## What this unblocks (and the Phase 2 minimum)

- **Phase 1 (genesis + roster):** the `Mind` descriptor + roster. No A2A yet.
- **Phase 2 (rooms):** driver + transcript + `sequential` strategy + director gate + turn budget + cancellation. **Minimum to start, all required:**
  1. the C1 `runAgentTurn` contract **landed in `@keelson/shared`** (verified absent today);
  2. a writable rib data home — gap **C3**, or the documented self-resolve fallback (`ARCHITECTURE.md` §8);
  3. the `Mind` / `TurnEntry` / `Room` shapes above (defined in this rib);
  4. the single-active-room + imperative-register discipline.
  Ship `sequential`; treat `concurrent` as deferred honestly.
- **Phase 3:** `group-chat` / `open-floor` strategies (moderate/synthesize/nominate) + solo-Mind agent-authored lenses.

## Open risks (carried forward)

- **Transcript token growth** (also a C1 risk): rebuilding context from a growing transcript across N Minds grows the prompt linearly — needs a documented truncation/summarization strategy before rooms scale.
- **Turn-budget tuning:** too low truncates real conversation, too high risks runaway cost. Per-room and director-visible.
- **Concurrent vs the pump:** relaxing the serial gate requires the dirty-flag pump on the imperative recompose path, or frames silently coalesce (C1 open risk).
- **Strategy/data-model field parity:** `fallbackModels`, `config` thresholds, and round semantics are modeled from the `pi-chamber` port (`ARCHITECTURE.md` §6); validate the exact field list against the actual `pi-chamber` `StrategyInput`/`SavedRoom` types when porting, and pin the source commit alongside this doc so each keep/drop/port claim is traceable.
