# Architecture — `@keelson/rib-chamber`

> How the rib produces the surfaces in [PRD.md](./PRD.md), and — most
> importantly — the **Keelson base gaps** it depends on. Status: **Phase 0
> wired; later phases design-first** (see §10). Concepts ported from
> `ianphil/chamber` (the originating multi-agent app) and `pi-chamber` (a prior
> tested port onto another harness).

## 1. The pipeline (one sentence)

A **genesis** or a **room turn** runs an **agent** (through a Keelson provider),
the agent emits a generic **canvas `board`** payload, the rib's **snapshot
binding** publishes it fail-closed to a `rib:chamber:*` key, and the bound
**view** renders it live in the SPA — no per-view React.

```
{name, role, voice}  or  room turn prompt
   │  runs an agent turn (provider / coding-agent CLI)
agent writes a Mind  OR  emits a board JSON payload
   │  fail-closed validate (canvasViewSchema)
rib bindSnapshotKey  ──►  SnapshotManager key  rib:chamber:*
   │  view descriptor { key, canvasKind:"view" }  +  surface region
Chamber tab  ──►  board renderer (live)
```

The board renderer, surface/region layout, action round-trip, and cell tone are
**already shipped** in the Keelson base (the OSDU rib's `G0`–`G4`). This rib
reuses all of it; what it adds is the machinery that *produces* the payloads —
genesis and the room loop.

## 2. Two execution models

The OSDU rib has exactly one: a **pull** model — the user clicks refresh, one
workflow runs, one board is published. Chamber needs that *plus* a new one.

- **Lens (pull).** Identical to OSDU: a workflow/turn produces a board,
  published to a key, rendered. Stateless, idempotent, user-triggered. Phase 0
  and agent-authored lenses (Phase 3) use this.
- **Room (push).** The rib drives a **multi-turn loop autonomously** —
  rib-initiated agent execution — publishing transcript frames as each turn
  completes, and accepting director inputs between turns. This is new for
  Keelson and is the reason Chamber exercises a different corner of the contract
  than a dashboard rib does. How Minds talk *inside* a room is the
  **driver-as-router** model — A2A is room-internal, not a relay/bus subsystem;
  see [design/A2A-communication.md](./design/A2A-communication.md).

## 2a. Note: determinism vs. generativity

Keelson's thesis is "repeatable operations live in YAML workflows, not chat
transcripts." A room is the opposite — emergent and non-deterministic. That is
**by design**: rooms are the generative counterpart to workflows, not a
replacement. `pi-chamber` shipped rooms *and* procedures side by side; Keelson
already owns the deterministic half (`packages/workflows`), so this rib only
adds the exploratory half. Keep the two framed as complementary modes.

## 3. Rib contract usage (`@keelson/shared` `Rib`)

| Hook | Use |
|---|---|
| `surfaces` | The **Chamber** nav tab — regions bound to roster / room / brief keys. |
| `views` | Static view descriptors for `rib:chamber:roster`, `:room`, `:brief`. |
| `contributeWorkflows` | The **chamber-genesis** workflow (a `prompt` node scoped via `allowed_tools` to the `chamber_emit_genesis` write tool), the **roster** collector, and the **newspaper/brief** lens workflow (`bash`/`prompt` node + `output_schema` + `bindSnapshotKey` + fail-closed `validate`). |
| `onAction` | Retire a Mind, and **room control** (canonical `action.type` literals): `room-start` / `room-next` / `room-inject` / `room-stop` — see [design/A2A-communication.md](./design/A2A-communication.md). |
| `authStatus` | Probe that an agent provider/CLI is reachable. |
| `registerTools` | Boot-time wiring: builds the room driver singleton and registers the push-fed `rib:chamber:room` snapshot (needs `runAgentTurn` + `getSnapshotManager`; room actions fail closed without them). |

`RibContext` surfaces the rib relies on: `runAgentTurn()` (run an agent turn —
the room loop's turn seam, `C1`), `getSnapshotManager()` (publish board frames, register keys
imperatively), `getCredential()` (namespace-scoped secrets).

## 4. Concept → Keelson seam map

| Chamber / pi-chamber | Keelson seam | Status |
|---|---|---|
| Procedures (Archon DAG) | `packages/workflows` | ✅ exists (same lineage) |
| Lens *renderer* (briefing/status-board) | canvas `board` view (`stats`/`segments`/`bars`/`table`/`cards`/`rows`) | ✅ shipped (OSDU `G1`) |
| Lens *as bound view* | `views[]` + `rib:chamber:*` key + board renderer | ✅ the OSDU pattern |
| Lens cell link / copy | board card `href` / `copyable` | ✅ shipped (OSDU `G2`) |
| Room transcript / participant bar | a `board` on `rib:chamber:room` + a Chamber surface | ✅ board + surface shipped (`G1`/`G4`) |
| Director controls (`/next`, `/inject`) | `onAction` round-trip | ✅ shipped (OSDU `G3`) |
| `room/strategies/*` (pure) | ported behind a Keelson orchestration context | ✅ wired (driver + `sequential`) |
| **Run an agent turn from rib code** | `ctx.runAgentTurn` (CLI MVP behind the seam) | ✅ wired (`C1`) |
| Mind storage (`SOUL.md`, memory…) | a blessed rib data home | ✅ wired (`C3` — `ctx.getDataDir`) |
| Agent-authored lens at runtime | dynamic view registration | ❌ **gap `C2`** |
| Streaming a turn into a board | partial/streamed snapshot frames | ↔ whole-frame MVP (`C4` partial deferred) |
| Room with N participants | dynamic surface regions | ❌ **gap `C5`** |

## 5. Data flow & snapshot-key map

All keys stay under `rib:chamber:*` (the scoped `SnapshotManager` enforces the
namespace).

| Surface region | Snapshot key | Producer | Shape |
|---|---|---|---|
| Roster (header) | `rib:chamber:roster` | per-Mind retire actions + a roster builder | `board` (cards: one per Mind) |
| Room transcript (main) | `rib:chamber:room` | the room loop (push) | `board` (rows/cards: one per turn) |
| Briefing (footer) | `rib:chamber:brief` | the `chamber-brief` workflow (pull) | `board` (briefing sections) |
| Agent-authored lens | `rib:chamber:lens:<mind>:<id>` | a Mind turn (Phase 3) | `board` (Mind's choice) |

The **Chamber surface** itself is not a key — it is a layout descriptor binding
these keys to page regions (header / rows / footer), exactly like the OSDU
`CIMPL` surface.

## 6. The orchestration core (ported from pi-chamber)

`pi-chamber` already isolated the hard part behind one seam: strategies receive
an **orchestration context** (a `spawn` function plus `emit*` callbacks) and
never touch the host API. Porting to Keelson reimplements that one object; the
strategy logic and its tests come across unchanged.

| pi-chamber seam | Keelson rib equivalent |
|---|---|
| `spawn(mindSpec, prompt)` (child `pi` process) | run an agent turn (`C1`: `getExec` CLI shell, then a provider seam) |
| `emitMindStart/Delta/End` (`ctx.ui.setWidget`) | publish/patch a `board` frame on `rib:chamber:room` |
| `emitModeratorDecision`, `emitRoundMetrics` | board header segments / a `stats` section |
| persistence (`pi.appendEntry`) | write to the rib data home (`C3`) |
| director overrides (`/next`, `/inject`) | `onAction` → set pending overrides consumed each turn |

**Strategies to port (in order):** `sequential`, `concurrent` (Phase 2);
`group-chat` (moderator picks next speaker), `open-floor` (speakers route the
floor) (Phase 3). A `MindSpec` is `{ slug, persona, model?, tools? }`.

## 7. Genesis flow

Genesis is the **`chamber-genesis` workflow** — a single `prompt` node scoped via
`allowed_tools` to the `chamber_emit_genesis` write tool:

1. **Author** — one agent turn reads a freeform brief (`$ARGUMENTS`), decides the
   Mind's `{ name, role, voice }`, and composes its `SOUL.md` body + a roster tagline.
2. **Persist** — the turn calls `chamber_emit_genesis`, whose handler slugifies the
   name, `scaffoldMind`s the directory (`mind.json`, `SOUL.md`, seeded `memory.md` /
   `rules.md` / `log.md` / `AGENT.md`), and invalidates the roster cache.
   `scaffoldMind` fails closed on a slug collision.
3. **Reflect** — the `chamber-roster` collector (a cadenced `bash` node) re-reads the
   Minds into the roster board; genesis itself publishes no snapshot.

Modeling genesis as a workflow (not an `onAction`) makes it triggerable from chat
(`/workflow run chamber-genesis <brief>`), the CLI, and the Workflows tab, and runs
the authoring turn through the provider abstraction instead of a shelled CLI.

## 8. Persistence model

Minds and room transcripts live under the rib's data home — a per-rib directory
rooted at the keelson home (the same root as `keelson.db`), namespaced by rib id:

```
<keelson-home>/chamber/
  minds/<slug>/{SOUL.md, memory.md, rules.md, log.md, AGENT.md}
  rooms/<slug>/{room.json, transcript.jsonl}
```

The rib resolves this from the blessed `ctx.getDataDir()` seam on `RibContext`,
captured once at activation (`setChamberDataHome`). The out-of-process roster
collector reads the same path baked into its workflow bash node, so the two
processes agree without a shared `KEELSON_WORKSPACE`.

Closed rooms are retained, not unbounded. Because every room start mints a fresh
unique slug, `rooms/` would otherwise grow forever; `sweepClosedRooms()`
(`src/room-store.ts`) prunes `done`/`stopped` room directories to the newest
`DEFAULT_CLOSED_ROOM_RETENTION` (25) by `createdAt`, never touching an `active`
room or an unreadable/unsafe directory. The sweep runs best-effort and
serialized at lifecycle-safe points — after the driver registers and after each
auto-advance loop exits — so it never races a room it is creating. There is no
TTL or operator override yet.

## 9. Keelson base gap analysis (the gating work)

The same virtuous cycle the OSDU rib ran with `G0`–`G4`: each gap below is
**domain-free and reusable by any rib**. Coordinate sequencing with whoever is
working the Keelson base, since these touch the shared `Rib` contract /
`RibContext`.

### C1 — Agent invocation from a rib *(load-bearing — **wired**, see [design/C1-agent-invocation.md](./design/C1-agent-invocation.md))*
**Landed.** The seam types + optional `ctx.runAgentTurn?` field shipped in
`@keelson/shared`, with a CLI-backed MVP impl (`makeRibAgentTurn`,
`claude -p … --output-format json` adapted to the `{ stream, result }`
dual-handle) bootstrapped in `apps/server`. The room driver consumes it through
`registerTools`. Original problem statement, kept for the record:
`RibContext` exposed `getExec`, `getSnapshotManager`, `getCredential` — but no
way to **run an agent turn**. The entire room loop is "run a turn," so this
gated Phase 2.
- **Decision:** add one **provider-shaped `ctx.runAgentTurn` seam** to
  `RibContext` (optional field, like `getSnapshotManager?`), with the contract
  committed up front and **two impls behind one signature**: a CLI-backed MVP,
  then a registry-routed real fix that inherits provider pinning
  (`KEELSON_WORKFLOW_PROVIDER`), redaction, and credentials with **zero
  room-loop change**. The MVP-shell vs real-seam framing below was *not* an
  either/or — they are the two impls of the same seam, in order.
- **Load-bearing constraint surfaced during design (verified):** the action
  route awaits `onAction` synchronously (`ribs-handler.ts:100`) under a 60s
  socket cap (`index.ts:90`), so the room loop must drive turns
  **fire-and-return** (`void driver.step(ctx); return { ok: true }`) and publish
  results as WS snapshot frames — never a blocking awaited turn.
- See the design record for the full contract, base changes, and open risks.

### C2 — Dynamic / agent-authored view registration
`views[]` is static at activation. An agent-authored lens appears at *runtime*.
Snapshot keys can already be registered imperatively
(`getSnapshotManager().register(key, …)`), but the **UI view binding** is
static — there is no way to surface a new panel after boot.
- **Real fix:** let a rib register/unregister a `RibViewDescriptor` at runtime
  (and notify the SPA), so a Mind-authored `rib:chamber:lens:*` key becomes a
  live panel. This is the literal "agents create their own lenses" feature.

### C3 — Rib persistent data home — **landed**
Minds/transcripts need a blessed writable location.
- **Resolved:** `ctx.getDataDir()` on `RibContext` returns a per-rib directory
  under the keelson home (`<keelson-home>/<rib-id>`). Chamber captures it at
  activation and no longer self-resolves via `KEELSON_WORKSPACE`.

### C4 — Streaming / partial board frames *(verify first)*
A turn that streams tokens into a board region needs incremental frame updates,
not just whole-frame replacement. The base's recent surface work (loading
shimmer / pulse) suggests partial frames may already exist.
- **Action:** verify what `SnapshotManager` supports before building; this may be
  a no-op.

### C5 — Dynamic surface regions
A room has a variable participant count; the surface layout
(`rows[].columns[]`) is static.
- **MVP workaround:** one room board with N cards/rows (no new regions).
- **Real fix:** regions that bind a *set* of keys, or a board section that
  fans out per participant.

**Dependency order:** Phase 0 needs **nothing** (seam proof) → Phase 1 needs
**C3** → Phase 2 needs **C1** (and settled **C4** as whole-frame) → Phase 3
needs **C2** + **C5**. `C1` has **landed** in `@keelson/shared` (contract + CLI
MVP), so Phase 2 is unblocked and wired.

## 10. Current state

- **Phase 0 wired.** A `chamber-brief` contributed workflow runs one agent turn
  (a `prompt` node, no deterministic collector) that authors a canvas `board`
  briefing; the executor promotes it to structured output and the rib binding
  publishes it fail-closed (`validate` = `canvasViewSchema`, board kind) to
  `rib:chamber:brief`. A `views[]` descriptor renders it.
- **Phase 1 wired.** Genesis authors a Mind via the `chamber-genesis` workflow: a
  `prompt` node reads a brief, authors the soul, and calls `chamber_emit_genesis`
  to persist `mind.json` + `SOUL.md` + seeded working-memory docs under the rib
  data home (`<keelson-home>/chamber/minds/<slug>/`, via `ctx.getDataDir`). A
  `chamber-roster` collector reads those Minds back into a `board` of cards on
  `rib:chamber:roster`; a per-Mind board `retire` action removes one. The
  **Chamber** surface lands the roster in the header and settles the brief into the
  footer. Mutate-then-refresh, mirroring the OSDU action pattern; zero base change.
- **Phase 2 wired.** The room core is bound to the real seams in
  `registerTools`: a file-based `RoomStore` (`rooms/<slug>/room.json` +
  `transcript.jsonl` under the data home), a **push publisher** (cache the
  driver's board, `recompose("rib:chamber:room")` — a live WS push, no collector
  or cadence poll), `runAgentTurn` (`C1`) for the turns, and the roster as the
  minds resolver. `room-start` opens a room under a **fresh unique slug** and
  kicks a **detached auto-advance loop** that drives `step()` to budget/stop,
  streaming each turn to the canvas (the loop is the sole stepper — no manual
  next to race it); `room-inject` is a director override (one-shot nextSpeaker),
  `room-stop` ends it. The driver's serial gate + generation gating keep one turn
  at a time and let a stop abort an in-flight turn, and a per-room write lock
  serializes inject vs. a turn's commit so a mid-turn inject can't revert
  `turnIndex`. A fresh slug per start means a turn still draining from a stopped
  room (the CLI MVP can't cancel an in-flight child) appends to its own old room
  dir, never the new one — past rooms persist under `rooms/` as history. Room
  actions fail closed without the seams. The controls are **board-baked** (the
  OSDU payload-carrying pattern), not static `actions[]` buttons (those dispatch
  type-only, which a payload-required control can't use): the roster board offers
  **Start room** (participants = the current Minds), and the room board offers
  **Call on \<mind\> / Stop** (active) or **Start again** (closed).
- Reusable substrate confirmed available in the Keelson base: `board` view,
  surface/region layout, action round-trip, cell tone (`G0`–`G4`).

## 11. Next step

Phases 0–2 are wired: genesis + roster, and a live two-agent room (auto-advance
loop, `C1` turns, push-published transcript) on the Chamber surface. What remains
is **Phase 3 + base hardening**:

- **Phase 3 — agent-authored lenses & richer rooms**, gated on **C2** (dynamic
  view registration so a Mind-authored `rib:chamber:lens:*` becomes a live panel)
  and **C5** (dynamic surface regions for N participants). The `group-chat` /
  `open-floor` strategies port here.
- **`C1` real fix** — swap the CLI MVP behind `ctx.runAgentTurn` for the
  registry-routed provider (provider pinning, redaction, credentials) with **zero
  room-loop change** (the seam is the boundary).
- **`C4`** — partial/streamed board frames if a turn should paint tokens as they
  arrive; the room loop already drains the turn stream (today it publishes
  whole-frame on completion).
