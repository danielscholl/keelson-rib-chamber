# Architecture — `@keelson/rib-chamber`

> How the rib produces the surfaces in [PRD.md](./PRD.md), and — most
> importantly — the **Keelson base gaps** it depends on. Status: **draft /
> design-first.** Concepts ported from `ianphil/chamber` (the originating
> multi-agent app) and `pi-chamber` (a prior tested port onto another harness).

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
  than a dashboard rib does.

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
| `contributeWorkflows` | The **genesis-authoring** workflow and the **newspaper/brief** lens workflow (a `bash`/`prompt` node + `output_schema` + `bindSnapshotKey` + fail-closed `validate`). |
| `onAction` | Genesis a Mind, retire a Mind, and **room control**: `start` / `next` / `inject` / `leave`. |
| `authStatus` | Probe that an agent provider/CLI is reachable. |
| `registerTools` | Not used at MVP (label-only stub in the base). |

`RibContext` surfaces the rib relies on: `getExec()` (shell a coding-agent CLI —
the MVP path for running a turn), `getSnapshotManager()` (publish board frames,
register keys imperatively), `getCredential()` (namespace-scoped secrets). It
does **not** today expose a provider — see `C1`.

## 4. Concept → Keelson seam map

| Chamber / pi-chamber | Keelson seam | Status |
|---|---|---|
| Procedures (Archon DAG) | `packages/workflows` | ✅ exists (same lineage) |
| Lens *renderer* (briefing/status-board) | canvas `board` view (`stats`/`segments`/`bars`/`table`/`cards`/`rows`) | ✅ shipped (OSDU `G1`) |
| Lens *as bound view* | `views[]` + `rib:chamber:*` key + board renderer | ✅ the OSDU pattern |
| Lens cell link / copy | board card `href` / `copyable` | ✅ shipped (OSDU `G2`) |
| Room transcript / participant bar | a `board` on `rib:chamber:room` + a Chamber surface | ✅ board + surface shipped (`G1`/`G4`) |
| Director controls (`/next`, `/inject`) | `onAction` round-trip | ✅ shipped (OSDU `G3`) |
| `room/strategies/*` (pure) | ported behind a Keelson orchestration context | ↔ portable (host adapter swap) |
| **Run an agent turn from rib code** | `getExec` CLI shell **or** a provider seam | ❌ **gap `C1`** |
| Mind storage (`SOUL.md`, memory…) | a blessed rib data home | ❌ **gap `C3`** |
| Agent-authored lens at runtime | dynamic view registration | ❌ **gap `C2`** |
| Streaming a turn into a board | partial/streamed snapshot frames | ⚠️ verify (`C4`) |
| Room with N participants | dynamic surface regions | ❌ **gap `C5`** |

## 5. Data flow & snapshot-key map

All keys stay under `rib:chamber:*` (the scoped `SnapshotManager` enforces the
namespace).

| Surface region | Snapshot key | Producer | Shape |
|---|---|---|---|
| Roster (header) | `rib:chamber:roster` | genesis/retire actions + a roster builder | `board` (cards: one per Mind) |
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

Mirrors chamber/pi-chamber, collapsed to a single agent turn:

1. **Scaffold** the Mind directory under the rib data home (`SOUL.md`,
   `memory.md`, `rules.md`, `log.md`, `AGENT.md` seeded from a template).
2. **Author the soul** — one agent turn receives a genesis prompt built from
   `{ name, role, voice }` and emits the founding documents (as JSON the rib
   writes, or by writing files directly).
3. **Validate** the required files are non-empty.
4. **Persist** and republish `rib:chamber:roster`.

Genesis can be an `onAction({ type: "genesis", payload })` or a contributed
`chamber-genesis` workflow. The action path is simpler for MVP; the workflow
path inherits provider pinning and determinism controls for free.

## 8. Persistence model

Minds and room transcripts live under a per-rib data home:

```
.keelson/chamber/
  minds/<slug>/{SOUL.md, memory.md, rules.md, log.md, AGENT.md}
  rooms/<slug>/{room.json, transcript.jsonl}
```

At MVP the rib resolves this path itself (it knows `KEELSON_WORKSPACE` /
`.keelson/`); the blessed form is a `ctx.getDataDir()` on `RibContext` (`C3`).

## 9. Keelson base gap analysis (the gating work)

The same virtuous cycle the OSDU rib ran with `G0`–`G4`: each gap below is
**domain-free and reusable by any rib**. Coordinate sequencing with whoever is
working the Keelson base, since these touch the shared `Rib` contract /
`RibContext`.

### C1 — Agent invocation from a rib *(load-bearing)*
`RibContext` exposes `getExec`, `getSnapshotManager`, `getCredential` — but no
way to **run an agent turn**. The entire room loop is "run a turn," so this
gates Phase 2.
- **MVP workaround:** `getExec().runText("copilot" | "claude" | …)` shelling a
  coding-agent CLI — exactly how `pi-chamber` spawns child `pi`. Ships zero base
  change but bypasses Keelson's provider registry.
- **Real fix:** a `ctx.runAgentTurn({ provider?, system, prompt, tools? })` seam
  that routes through the provider registry, so rooms inherit provider pinning
  (`KEELSON_WORKFLOW_PROVIDER`), redaction, and credentials. **Decide before
  Phase 2.**

### C2 — Dynamic / agent-authored view registration
`views[]` is static at activation. An agent-authored lens appears at *runtime*.
Snapshot keys can already be registered imperatively
(`getSnapshotManager().register(key, …)`), but the **UI view binding** is
static — there is no way to surface a new panel after boot.
- **Real fix:** let a rib register/unregister a `RibViewDescriptor` at runtime
  (and notify the SPA), so a Mind-authored `rib:chamber:lens:*` key becomes a
  live panel. This is the literal "agents create their own lenses" feature.

### C3 — Rib persistent data home
Minds/transcripts need a blessed writable location. Today a rib reaches into the
filesystem itself (works, unblessed).
- **Real fix:** `ctx.getDataDir()` (a per-rib directory under `.keelson/`), or a
  scoped store handle.

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
**C3** → Phase 2 needs **C1** (and verifies **C4**) → Phase 3 needs **C2** +
**C5**. `C1` is the first *real* base gap and the one to design first.

## 10. Current state

- Package scaffolded (`@keelson/rib-chamber`): config, a minimal `Rib`
  (`id: "chamber"`), an identity test, and these docs. `typecheck` / `test` /
  `check` are green.
- No runtime hooks wired yet — Phase 0 is the next build step.
- Reusable substrate confirmed available in the Keelson base: `board` view,
  surface/region layout, action round-trip, cell tone (`G0`–`G4`).

## 11. Next step

Build **Phase 0**: a `chamber-brief` workflow whose node has the provider emit a
`board` "briefing" payload, bound to `rib:chamber:brief` and validated
fail-closed through `canvasViewSchema`. It proves the agent-authored-lens idea
with zero base change and produces the first real board to lay the Chamber
surface around — then design **C1** (agent invocation) ahead of the room.
