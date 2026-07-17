---
description: Prime understanding of the Chamber rib — the Rib contract surface, the room loop, and conventions
allowed-tools: Bash, Read, Glob, Grep
---

<prime-command>
  <objective>
    Build a working mental model of @keelson/rib-chamber — a Keelson rib that adds
    the multi-agent layer (genesis agents, agent-to-agent rooms, agent-authored
    lenses and exhibits, the standing Briefing) — fast enough to navigate it and
    respect its invariants before making a change.
  </objective>

  <constraints>
    <rule>Stay bounded. Read the few load-bearing files named below in full; for
      everything else, LIST and skim — don't deep-read.</rule>
    <rule>DO NOT read test files — note their existence and count only.</rule>
    <rule>DO NOT read every strategy or board — read one as the pattern, list the rest.</rule>
    <rule>DO NOT launch subagents — this is a single-pass orientation.</rule>
    <rule>CLAUDE.md / AGENTS.md are already project context; build on them, don't re-read.</rule>
  </constraints>

  <phase number="1" name="orient">
    <step name="layout">
      <action>Map the package shape — directories and rough size, not every file.</action>
      <command>git ls-files | sed 's#/[^/]*$##' | sort | uniq -c | sort -rn | head -20</command>
    </step>
    <step name="readme">
      <action>Read README.md.</action>
      <extract>The pitch: a rib adding genesis / rooms / lenses; zero React; driven
        from chat tools, the Chamber surface, or workflows.</extract>
    </step>
  </phase>

  <phase number="2" name="the-contract-surface">
    <intent>This rib is one Rib object plus its types. Read these.</intent>
    <step name="rib">
      <action>Read src/index.ts.</action>
      <extract>The exported `Rib`, and the fact that this file is a COMPOSITION ROOT
        — it wires modules, it does not implement them. Specifically: the mutable
        RIB_VIEWS array (statics, plus per-subject HTML lenses pushed at runtime via
        the declareView seam); the Chamber surface layout; contributeWorkflows
        delegating to workflows.ts; registerTools as assembly (see the seam ladder
        below); onAction delegating to dispatchChamberAction; the agents + commands
        seams; and dispose() composing the module teardowns.</extract>
      <extract>The SEAM LADDER in registerTools — the fail-closed shape worth
        internalizing. Genesis, digest, the read tools, and the cleanup tools need
        only the disk paths, so they are ALWAYS present. Lens/exhibit tools need the
        snapshot manager AND registerRegion. Room-control tools additionally need
        runAgentTurn. A missing seam means the tool is never returned — not a tool
        that half-works.</extract>
    </step>
    <step name="types">
      <action>Read src/types.ts.</action>
      <extract>Mind (incl. the identity-slot allocation rules), Room, RoomConfig,
        TaskLedger (magentic), RoomStrategyName, and the strategy decision types
        (StrategyInput / StrategyStep / Strategy).</extract>
    </step>
    <step name="driver">
      <action>Skim src/ports.ts (short — read it) and src/room.ts (~1600 lines —
        SKIM ONLY: the interfaces near the top, not the body).</action>
      <extract>ports.ts: the two seams — RoomStore (persistence; transcript is the
        source of truth) and RoomPublisher (the driver composes a board, the adapter
        routes it to the per-slug key).</extract>
      <extract>room.ts: RoomDriverDeps (store, publisher, runAgentTurn, minds
        resolver, plus optional project/tool/cwd resolvers), the RoomDriver interface
        (start / step / inject / stop / dispose), and StepOutcome — "advanced" |
        "ended" | "busy", three-way because a second stepper must tell a serial-gate
        no-op apart from a closed room.</extract>
    </step>
    <step name="modules">
      <action>LIST, don't read: each subsystem is a `bindX(seams)` / `disposeX()`
        pair built in registerTools and torn down in dispose().</action>
      <command>grep -rn 'export function bind\|export async function dispose\|export function dispose' src/*.ts</command>
      <extract>brief-gate (the rib-owned attention gate), reflection-gate (the
        close-only paid turn), runtime (host seams + the in-process Convene/Chamber
        panels), lens-runtime (the lens + HTML-lens registries), room-lifecycle
        (driver, key registry, room loop). Tools live under src/tools/, board
        actions under src/actions/.</extract>
    </step>
  </phase>

  <phase number="3" name="strategies-boards-workflows">
    <step name="strategies">
      <action>Read ONE strategy as the pattern (src/strategies/sequential.ts — 14
        lines); LIST the rest, don't read them.</action>
      <extract>A strategy is a pure `StrategyInput -> StrategyStep` function: it reads
        room state + transcript and returns speak / speak-parallel / moderate /
        synthesize / manage / assign / end. No I/O, no provider or host coupling —
        the driver runs the turns, parses any routing tail, and validates picks.</extract>
      <extract>There are SIX, registered in strategies/index.ts behind an
        `Object.hasOwn` guard (a bare index would resolve "constructor"/"__proto__" to
        a truthy non-Strategy): sequential (round-robin), concurrent (one parallel
        round), group-chat (moderator-routed), open-floor (each speaker nominates the
        next), review (two-Mind cross-vendor pass), magentic (a non-participant
        manager plans a task ledger and delegates). synthesis.ts is the shared
        close helper, not a strategy.</extract>
    </step>
    <step name="boards">
      <action>LIST src/boards/ and bin/; read at most ONE builder if you need the shape.</action>
      <extract>src/boards/ has FIVE DETERMINISTIC canvas-board builders the rib
        composes (canvas `board` data, zero React): lenses, presence, room, rooms,
        roster — plus two section helpers, activity and convene, that are composed
        into other boards rather than published themselves, and room-summary, which
        is NOT a board builder at all: it emits an HTML page
        (buildRoomSummaryHtml) for the room-summary action's own key. These are
        rib-built, NOT agent-authored — the roster, the Rooms index, and the live
        transcript are boards; a lens/exhibit is what a Mind authors. FIVE
        bin/collect-*.ts files: three (roster, rooms, lenses) are the deterministic
        collector behind a workflow of the same name; collect-digest-gate and
        collect-digest-publish are two nodes of the single chamber-digest
        workflow.</extract>
    </step>
    <step name="workflows">
      <action>Skim src/workflows.ts — names and node shape only. NB: some names are
        constants, not literals, so grep the `name:` key rather than the string
        "chamber" or you will undercount.</action>
      <command>grep -nE '^\s*name: ' src/workflows.ts</command>
      <extract>Eight: three deterministic collectors (chamber-roster / -rooms /
        -lenses) that just read the data home; four agent-turn authors
        (chamber-genesis, chamber-lens, chamber-lens-refresh, chamber-lens-html); and
        the self-gating chamber-digest (a gate node reads the fingerprint, the paid
        author node runs only when it advanced, an always-on publish node re-reads
        the store).</extract>
      <extract>The Briefing (rib:chamber:brief) is NOT a workflow — it is the
        rib-owned attention gate (evaluateBriefGate in brief-gate.ts), published
        in-process and gated fail-closed against a persisted watermark so a quiet
        Chamber runs no paid turn. The Chamber panel and Convene composer are
        likewise in-process (runtime.ts), which is why they bind no workflow.</extract>
    </step>
  </phase>

  <phase number="4" name="inventory">
    <step name="tests">
      <action>Count test files; report the count only.</action>
      <command>git ls-files 'test/**/*.test.ts' | wc -l</command>
    </step>
    <step name="commands"><command>ls .claude/commands/ 2>/dev/null</command></step>
  </phase>

  <phase number="5" name="conventions">
    <action>Skim CONTRIBUTING.md for the rules that gate a PR.</action>
    <points>
      <point>Green before a PR: `bun run check`, `bun run typecheck`, `bun test`.</point>
      <point>Invariants: index.ts stays a composition root (a new subsystem gets its
        own module + bindX/disposeX pair — index.ts gains wiring, not logic); zero
        React; strategies pure; attach only via the Rib contract; fail closed; paid
        turns budget-capped (MAX_ROOM_TURN_BUDGET) + confirm-gated; bounded
        concurrent rooms (MAX_ACTIVE_ROOMS), each on its own per-slug key, with
        a fresh slug per start; slugs are path segments, guarded by
        assertSafeSlug / isSafeSlug before they touch the filesystem.</point>
      <point>Comments: default to none; capture non-obvious why; no narration.</point>
      <point>No abstractions ahead of a concrete second caller.</point>
    </points>
  </phase>

  <phase number="6" name="summarize">
    <format>Concise markdown — no multi-page dump:</format>
    <sections>
      <section>Project: 1–2 sentences (a Keelson rib; the multi-agent layer).</section>
      <section>The Rib surface: views/surface, workflows, the tool seam ladder,
        actions, agents/commands — and index.ts as composition root over the
        bindX/disposeX modules.</section>
      <section>The room loop: strategies (pure) ⇄ driver (I/O) ⇄ publisher (fail-closed board).</section>
      <section>Commands: test / typecheck / check / link:keelson.</section>
      <section>Invariants to respect for the change at hand.</section>
      <section>Where to start: which file to open first.</section>
    </sections>
  </phase>

  <phase number="7" name="report-drift">
    <action>If anything you read contradicts this command file or AGENTS.md, SAY SO
      in a closing line — name the file and the specific claim. This rib moves fast;
      the code is the truth and these docs drift. Don't silently paper over it.</action>
  </phase>

  <anti-patterns>
    <avoid>Reading every strategy/board/test to "understand patterns" — read one, list the rest.</avoid>
    <avoid>Deep-reading src/room.ts. It is ~1600 lines; skim the interfaces at the top.</avoid>
    <avoid>Launching subagents.</avoid>
    <avoid>A multi-page summary.</avoid>
    <avoid>Trusting this file's inventories over the code. The counts and names here
      are a starting map, not a contract — the greps re-derive them.</avoid>
  </anti-patterns>
</prime-command>
