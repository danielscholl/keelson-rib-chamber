# Architecture — `@keelson/rib-chamber`

> How the rib produces its surfaces, and the **Keelson base seams** it builds
> on. Status: **genesis, rooms (all five strategies), and agent-authored lenses
> ship today** (see §10); the only remaining work is streamed partial board
> frames (`C4`). The base-gap analysis that gated the build — now resolved — is
> kept as a historical record in
> [design/base-gaps-history.md](./design/base-gaps-history.md). Concepts ported
> from `ianphil/chamber` (the originating multi-agent app) and `pi-chamber` (a
> prior tested port onto another harness).

## 1. The pipeline (one sentence)

A **genesis** or a **room turn** runs an **agent** (through a Keelson provider),
the agent emits a generic **canvas `board`** payload, the rib's **snapshot
binding** publishes it fail-closed to a `rib:chamber:*` key, and the bound
**view** renders it live in the SPA — no per-view React.

```text
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
  published to a key, rendered. Stateless, idempotent, user-triggered. The
  standing briefing and agent-authored lenses use this.
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
imperatively), `registerRegion()` (add a surface region at runtime for a room or
a lens, `C2`/`C5`), `getDataDir()` (the rib's persistent data home, `C3`),
`getCredential()` (namespace-scoped secrets).

## 4. Concept → Keelson seam map

| Chamber / pi-chamber | Keelson seam | Status |
|---|---|---|
| Procedures (Archon DAG) | `packages/workflows` | ✅ exists (same lineage) |
| Lens *renderer* (briefing/status-board) | canvas `board` view (`stats`/`segments`/`bars`/`table`/`cards`/`rows`) | ✅ shipped (OSDU `G1`) |
| Lens *as bound view* | `views[]` + `rib:chamber:*` key + board renderer | ✅ the OSDU pattern |
| Lens cell link / copy | board card `href` / `copyable` | ✅ shipped (OSDU `G2`) |
| Room transcript / participant bar | a `board` on `rib:chamber:room` + a Chamber surface | ✅ board + surface shipped (`G1`/`G4`) |
| Director controls (`/next`, `/inject`) | `onAction` round-trip | ✅ shipped (OSDU `G3`) |
| `room/strategies/*` (pure) | ported behind a Keelson orchestration context | ✅ wired (driver + all five strategies) |
| **Run an agent turn from rib code** | `ctx.runAgentTurn` (registry-routed provider seam) | ✅ wired (`C1`) |
| Mind storage (`SOUL.md`, memory…) | a blessed rib data home | ✅ wired (`C3` — `ctx.getDataDir`) |
| Agent-authored lens at runtime | dynamic region registration (`ctx.registerRegion`) | ✅ wired (`C2`) |
| Streaming a turn into a board | partial/streamed snapshot frames | ↔ whole-frame today (`C4` partial deferred) |
| Room with N participants | dynamic surface regions (`ctx.registerRegion`) | ✅ wired (`C5`) |

## 5. Data flow & snapshot-key map

All keys stay under `rib:chamber:*` (the scoped `SnapshotManager` enforces the
namespace).

| Surface region | Snapshot key | Producer | Shape |
|---|---|---|---|
| Roster (header) | `rib:chamber:roster` | per-Mind retire actions + a roster builder | `board` (cards: one per Mind) |
| Room transcript (main) | `rib:chamber:room` | the room loop (push) | `board` (rows/cards: one per turn) |
| Briefing (footer) | `rib:chamber:brief` | the rib attention gate (push; promotes on room-end / lens-change, watermark-gated) | `board` (briefing sections) |
| Agent-authored lens | `rib:chamber:lens:<mind>:<id>` | a Mind turn (lens write seam) | `board` (Mind's choice) |

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
| `spawn(mindSpec, prompt)` (child `pi` process) | run an agent turn (`C1`: `ctx.runAgentTurn`, registry-routed) |
| `emitMindStart/Delta/End` (`ctx.ui.setWidget`) | publish/patch a `board` frame on `rib:chamber:room` |
| `emitModeratorDecision`, `emitRoundMetrics` | board header segments / a `stats` section |
| persistence (`pi.appendEntry`) | write to the rib data home (`C3`) |
| director overrides (`/next`, `/inject`) | `onAction` → set pending overrides consumed each turn |

**Strategies (all five shipped):** `sequential` (round-robin), `concurrent`
(parallel round), `group-chat` (a moderator Mind picks the next speaker),
`open-floor` (speakers route the floor by nomination + end-vote), and `review`
(two Minds pinned to different providers — author, then reviewer). A `MindSpec`
is `{ slug, persona, model?, tools? }`. See
[reference/strategies](https://danielscholl.github.io/keelson-rib-chamber/reference/strategies/)
for the per-strategy contract.

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
rooted at the keelson home (the same root as `keelson.db`), named `rib-<id>`:

```text
<keelson-home>/rib-chamber/
  minds/<slug>/{SOUL.md, memory.md, rules.md, log.md, AGENT.md}
  rooms/<slug>/{room.json, transcript.jsonl}
  lenses/<id>.json
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

## 9. Base seams this rib uses

Everything the rib needs from the Keelson base has landed; it touches the shared
`Rib` contract / `RibContext` at these seams:

| Seam | `RibContext` / contract | Use |
|---|---|---|
| Run an agent turn | `ctx.runAgentTurn` | every genesis, room turn, and lens turn — registry-routed, so it inherits provider pinning, redaction, and credentials |
| Persistent data home | `ctx.getDataDir` | `<keelson-home>/rib-chamber/` — Minds, rooms, lenses |
| Dynamic regions | `ctx.registerRegion` | a room or an agent-authored lens adds its own surface region at runtime |
| Namespaced snapshots | `ctx.getSnapshotManager` | publish/recompose `board` frames under `rib:chamber:*` |
| Namespaced credentials | `ctx.getCredential` | rib-scoped secrets |

The gating analysis that sequenced this work (`C1`–`C5`, mapped to the OSDU
rib's `G0`–`G4`) is preserved — now resolved — in
[design/base-gaps-history.md](./design/base-gaps-history.md). Only `C4`
(partial/streamed board frames) is still a whole-frame MVP; see §11.

## 10. Current state

- **Briefing wired (rib-owned, substance-gated).** The footer Briefing is no longer
  a contributed workflow. The rib seeds `rib:chamber:brief` with a quiet board at boot
  and an attention gate (`evaluateBriefGate`, over `chamber-state` + a persisted
  `brief-watermark.json`) promotes it to one agent turn — published fail-closed
  (`validate` = `canvasViewSchema`, board kind) — ONLY when a room ended or a lens
  changed since the watermark; an unchanged Chamber runs no (paid) turn. A `views[]`
  descriptor renders it.
- **Genesis + roster wired.** Genesis authors a Mind via the `chamber-genesis` workflow: a
  `prompt` node reads a brief, authors the soul, and calls `chamber_emit_genesis`
  to persist `mind.json` + `SOUL.md` + seeded working-memory docs under the rib
  data home (`<keelson-home>/rib-chamber/minds/<slug>/`, via `ctx.getDataDir`). A
  `chamber-roster` collector reads those Minds back into a `board` of cards on
  `rib:chamber:roster`; a per-Mind board `retire` action removes one. The
  **Chamber** surface lands the roster in the header and settles the brief into the
  footer. Mutate-then-refresh, mirroring the OSDU action pattern; zero base change.
- **Rooms wired (all five strategies).** The room core is bound to the real seams in
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
  room (an in-flight turn can't always be hard-cancelled mid-stream) appends to
  its own old room dir, never the new one — past rooms persist under `rooms/` as
  history. Room actions fail closed without the seams. The controls are
  **board-baked** (the OSDU payload-carrying pattern), not static `actions[]`
  buttons (those dispatch type-only, which a payload-required control can't use):
  the roster board offers **Start room** (participants = the current Minds), and
  the room board offers **Call on \<mind\> / Stop** (active) or **Start again**
  (closed).
- **Agent-authored lenses wired.** A Mind can author its own canvas board during a
  turn (the lens write seam); the rib persists it (`lenses/<id>.json` via
  `lens-store`) and registers a **dynamic surface region** for it through
  `ctx.registerRegion` (`C2`), so a new lens becomes a live panel after boot with
  no React shipped from the rib. A lens's freshness fingerprint feeds the briefing
  attention gate.
- Reusable substrate confirmed available in the Keelson base: `board` view,
  surface/region layout, action round-trip, cell tone (`G0`–`G4`), and dynamic
  region registration.

## 11. Remaining work

Genesis, the roster, all five room strategies, agent-authored lenses, and the
briefing are wired on the Chamber surface; `ctx.runAgentTurn` is the
registry-routed provider seam (pinning, redaction, credentials), and rooms and
lenses register their own surface regions at runtime (`C2` / `C5`). What remains
is hardening, not features:

- **`C4` — partial / streamed board frames.** A turn that should paint tokens as
  they arrive needs incremental frame updates; the room loop already drains the
  turn stream but publishes a whole frame on completion today. Verify what
  `SnapshotManager` supports before building — partial frames may already exist.
