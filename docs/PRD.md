# PRD — `@keelson/rib-chamber`

> A multi-agent operating layer for Keelson: **genesis** agents, **agent-to-agent
> rooms**, and **agent-authored lenses**. Status: **draft / design-first.**
> Companion: [ARCHITECTURE.md](./ARCHITECTURE.md) (how it works + the base gaps).

## 1. Vision

Keelson today runs agents in two modes: **chat** (one agent, conversational) and
**workflows** (a deterministic DAG of agent steps, repeatable, authored in YAML).
Chamber adds the mode that's missing between them: **many persistent agents that
you author on demand, that talk to each other under a chosen turn strategy, and
that render their own views of what they are doing** through Keelson's canvas.

It is the *generative* counterpart to the *deterministic* workflow engine — and
the second rib archetype, after the OSDU rib, that proves how far the `Rib`
contract stretches.

## 2. Why this is the right second rib

The OSDU rib and Chamber sit at opposite corners of the design space. Building
both proves the harness across two axes instead of one.

| Axis | `rib-osdu` | `rib-chamber` |
|---|---|---|
| Archetype | External-system bridge → dashboard | Generative multi-agent → live surface |
| Data | Read-mostly, shells existing CLIs | Produced by running agents on demand |
| Views | Static, declared at activation | Static **and** agent-authored at runtime |
| Determinism | Deterministic collectors | Emergent, conversational |
| Execution | User-triggered one-shot workflows | Rib-initiated multi-turn loops |

Three things make it tractable rather than a year-long port:

1. **Keelson already owns the deterministic half of Chamber.**
   `packages/workflows` is the Archon DAG (chamber's "procedures"); the canvas
   `board` view (shipped via the OSDU rib's gap work) is the lens renderer. This
   rib only adds the *generative* half — genesis and rooms.
2. **The OSDU rib already built the lens-rendering substrate.** "An agent
   authors its own lens" reduces to "an agent emits a `board` payload to a
   `rib:chamber:*` key" — which renders through machinery that already exists.
3. **The orchestration is de-risked.** `pi-chamber` is a prior, bun-tested port
   of these concepts onto a different agent harness; its turn strategies are
   pure (decoupled from the host via an orchestration-context seam) and port
   across with the host adapter swapped for the `Rib` contract.

## 3. Concepts (in Keelson terms)

- **Mind** — a persistent agent identity. A directory under the rib's data home
  holding `SOUL.md` (persona/mission/voice), `memory.md` / `rules.md` / `log.md`
  (working memory), and `AGENT.md` (operating doctrine). File-based,
  git-versionable, cheap to create and inspect.
- **Genesis** — author a new Mind on demand. One agent turn writes the Mind's
  founding documents from a `{ name, role, voice }` brief.
- **Room** — put N Minds in a session and orchestrate turns between them via a
  pluggable **strategy** (sequential, concurrent, group-chat, open-floor). This
  is the agent-to-agent surface; a human can steer it (next speaker, inject).
- **Lens** — a view a Mind authors *itself*: the Mind emits a canvas `board`
  payload to a rib-namespaced snapshot key and it renders as a live panel, with
  no per-view UI code. The "newspaper" briefing is the first lens.

## 4. User-facing capabilities

- **The Chamber surface** — a primary nav tab composed of region-bound boards:
  a **roster** of Minds (header), the active **Room** transcript (main column),
  and a Mind-authored **briefing** lens (footer).
- **Genesis flow** — from the roster, "new agent" → `name / role / voice` → a
  Mind is authored and appears as a card.
- **Room flow** — select Minds → start a room → they take turns under the chosen
  strategy; **director controls** (next speaker, inject a steer) drive it; each
  turn streams into the transcript board.
- **Agent-authored lens** — a Mind renders its own dashboard of what it sees.
  The hero capability: the UI is produced by an agent, not hand-coded.

## 5. Hero scenario

> A user genesis-es two Minds — **Scout** (researches) and **Critic**
> (pressure-tests). They open a room in **sequential** mode and ask a question.
> Scout proposes; Critic critiques; each turn streams into the transcript board
> as it completes. Afterward Scout authors a **"findings" lens** — it emits a
> `board` with the key points as cards — which renders as a live panel in the
> Chamber footer. Everything on screen was produced by running agents through
> Keelson's existing canvas; none of it is hand-coded UI.

## 6. Phasing

Each phase ships something usable and forces at most one base-contract change,
mirroring how the OSDU rib sequenced its gaps. Gap IDs (`C1`–`C5`) are defined
in [ARCHITECTURE.md §9](./ARCHITECTURE.md).

| Phase | Deliverable | Base gap forced |
|---|---|---|
| **0 — Newspaper lens proof** | A contributed workflow whose prompt node has the provider emit a `board` (a "briefing"), published to `rib:chamber:brief`, rendered by the existing board view. Proves "an agent authors a lens." | **None** (seam proof) |
| **1 — Genesis + roster** | `onAction`/workflow scaffolds a Mind under the rib data home and authors its soul via one agent turn; the Chamber surface lists Minds as cards. | **C3** (rib data home) |
| **2 — Two-agent room** | Port `pi-chamber`'s pure strategies (sequential + concurrent) behind a Keelson orchestration context; `onAction` drives start/turn/next/inject/leave; transcript published as a board. | **C1** (agent invocation), maybe **C4** (streaming frames) |
| **3 — On-demand lenses + richer strategies** | Minds emit their own `rib:chamber:lens:<mind>:<id>` keys (dynamic views); add group-chat / open-floor. | **C2** (dynamic views), **C5** (dynamic regions) |

## 7. Non-goals (NOT for)

- **Not a replacement for workflows.** Determinism and repeatable operations stay
  in YAML workflows; rooms are the explicit *generative* mode, not a substitute.
- **Not a hosted or multi-user service.** Local-only, single-user — same as the
  rest of Keelson.
- **Not a port of chamber's app.** No Electron shell, no Copilot-SDK-specific
  machinery, no skills marketplace or cross-machine A2A relay in scope.
- **MVP excludes** handoff / magentic orchestration, agent self-modification of
  another Mind, and persistent rooms across server restarts (Phase 3+).

## 8. Success criteria

- A user can **genesis a Mind, run a two-agent room, and see an agent-authored
  lens** — all through the Chamber surface, with zero hand-coded view code.
- The orchestration strategies are **pure and unit-tested** (ported from
  `pi-chamber`), independent of the `Rib` adapter.
- The base gaps **C1–C5 are articulated**, and **C1** (how a rib invokes an
  agent turn) has a chosen, documented approach before Phase 2.
- The rib ships **zero React** into the SPA and stays within the
  `rib:chamber:*` namespace.
