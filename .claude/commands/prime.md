---
description: Prime understanding of the Chamber rib — the Rib contract surface, the room loop, and conventions
allowed-tools: Bash, Read, Glob, Grep
---

<prime-command>
  <objective>
    Build a working, current mental model of @keelson/rib-chamber — the
    multi-agent layer (genesis Minds, agent-to-agent rooms, agent-authored
    lenses, the standing Briefing) — fast enough to navigate it and respect its
    invariants before making a change. AGENTS.md (already in context) carries
    the stable contract, patterns, and invariants; this command's job is to
    discover what is true RIGHT NOW — the inventories, the seams, the wiring —
    from the code itself. Report only what you derived this pass; never recall a
    count, layout, or name list from memory or from a doc.
  </objective>

  <constraints>
    <rule>Stay bounded. Read the few load-bearing files named below; for
      everything else, LIST and skim — don't deep-read.</rule>
    <rule>src/room.ts is large (check with wc -l). NEVER read it whole — read
      only the interfaces/consts near the top that the phase-2 grep surfaces,
      not the driver body.</rule>
    <rule>DO NOT read test files — count them only.</rule>
    <rule>DO NOT read every strategy, board, or tool file — read ONE of each as
      the pattern, list the rest.</rule>
    <rule>DO NOT launch subagents — this is a single-pass orientation.</rule>
    <rule>AGENTS.md / CLAUDE.md are already project context; build on them, don't
      re-read them. The code is the truth. If something you read materially
      contradicts AGENTS.md or a docs/ page, note it in ONE closing line and move
      on — auditing docs is not this command's job.</rule>
  </constraints>

  <phase number="1" name="orient">
    <step name="layout">
      <action>Map the package shape — directories and rough sizes, not every file.</action>
      <command>git ls-files | sed 's#/[^/]*$##' | sort | uniq -c | sort -rn | head -20</command>
      <command>wc -l src/*.ts src/strategies/*.ts src/boards/*.ts | sort -rn | head -15</command>
    </step>
    <step name="readme">
      <action>Read README.md.</action>
      <learn>The current pitch: what the rib adds, how it is driven (chat tools,
        the Chamber surface, workflows), what it requires.</learn>
    </step>
  </phase>

  <phase number="2" name="the-contract-surface">
    <intent>index.ts is a COMPOSITION ROOT — small enough to read whole. It
      wires modules; it does not implement them.</intent>
    <step name="rib">
      <action>Read src/index.ts in full.</action>
      <learn>The exported `Rib`: which views/keys exist (and how RIB_VIEWS grows
        at runtime), the Chamber surface layout, what contributeWorkflows
        delegates to, how registerTools assembles the tool set, what onAction
        delegates to, the agents/commands seams, and what dispose composes.</learn>
      <learn>The seam-ladder shape in registerTools: which tools need only disk
        paths (always present), which need the snapshot/region seams, which need
        the agent-turn seam — and confirm a missing seam withholds the tool
        entirely rather than returning one that half-runs.</learn>
    </step>
    <step name="types">
      <action>Read src/types.ts.</action>
      <learn>Mind (including identity-slot rules), Room and RoomConfig, the
        strategy decision types (StrategyInput / StrategyStep / Strategy), and
        any ledger types the manager strategies use.</learn>
    </step>
    <step name="driver">
      <action>Read src/ports.ts (short). Skim only the top of src/room.ts.</action>
      <command>grep -nE 'export (interface|const|type|function) ' src/room.ts | head -20</command>
      <learn>The two seams (store vs publisher) and where the source of truth
        lives; the driver's dependency set and lifecycle interface; what the
        step-outcome states are and why they need to be distinguishable.</learn>
    </step>
    <step name="modules">
      <action>LIST the bindX/disposeX subsystem modules — don't read them.</action>
      <command>grep -rn 'export function bind\|export function dispose\|export async function dispose' src/*.ts</command>
      <learn>Which subsystems exist as bind/dispose pairs and what each owns
        (gates, runtime panels, lens registries, room lifecycle).</learn>
    </step>
  </phase>

  <phase number="3" name="strategies-boards-workflows">
    <step name="strategies">
      <action>Read ONE strategy as the pattern (sequential is the smallest);
        list the rest of src/strategies/.</action>
      <command>ls src/strategies/</command>
      <learn>The pure `StrategyInput -> StrategyStep` shape, the decision kinds
        it can return, how the registry guards lookup, and which file is a
        shared helper rather than a strategy.</learn>
    </step>
    <step name="boards">
      <action>LIST src/boards/ and bin/; read at most ONE builder if you need
        the shape.</action>
      <learn>Which boards are rib-built and deterministic vs what a Mind
        authors; which bin/ scripts back a collector workflow vs serve as nodes
        of a gated one; whether any builder emits something other than a board.</learn>
    </step>
    <step name="workflows">
      <action>Skim src/workflows.ts — names and node shapes only. Some names are
        constants, not string literals, so grep the `name:` key rather than a
        substring or you will undercount.</action>
      <command>grep -nE '^\s*name: ' src/workflows.ts</command>
      <learn>The current workflow set, which are deterministic collectors vs
        paid agent-turn authors, and how any self-gating workflow splits its
        gate / author / publish nodes.</learn>
      <learn>Which standing panels are NOT workflows (published in-process) and
        what gates their paid turns.</learn>
    </step>
  </phase>

  <phase number="4" name="inventory">
    <intent>Derive every number you will report. These commands are the only
      legitimate source for counts — not AGENTS.md, not docs/, not memory.</intent>
    <command>grep -cE '^\s*name: ' src/workflows.ts        # workflow + node names (eyeball which are workflows)</command>
    <command>grep -rhoE 'name: "chamber_[a-z_]+"' src/tools/ | sort -u   # chat tools</command>
    <command>git ls-files 'test/**/*.test.ts' | wc -l       # test files</command>
    <command>ls .claude/commands/ 2>/dev/null</command>
  </phase>

  <phase number="5" name="conventions">
    <action>Skim CONTRIBUTING.md for the rules that gate a PR — the required
      checks, commit/PR-title format, and architecture rules.</action>
  </phase>

  <phase number="6" name="summarize">
    <format>Concise markdown — no multi-page dump. Every count and name list
      must come from this pass's commands and reads.</format>
    <sections>
      <section>Project: 1–2 sentences.</section>
      <section>The Rib surface: views/surface, the workflow set as currently
        defined, the tool seam ladder, actions, agents/commands — and index.ts
        as composition root over the bindX/disposeX modules.</section>
      <section>The room loop: strategies (pure) ⇄ driver (I/O) ⇄ publisher
        (fail-closed board).</section>
      <section>Commands: the package scripts that gate a PR.</section>
      <section>Invariants bearing on the change at hand (from AGENTS.md,
        confirmed against what you just read).</section>
      <section>Where to start: which file to open first for this task.</section>
      <section>Only if found: one closing line naming any material contradiction
        between the code and AGENTS.md / docs/.</section>
    </sections>
  </phase>

  <anti-patterns>
    <avoid>Deep-reading src/room.ts — skim the interfaces at the top.</avoid>
    <avoid>Reading every strategy/board/tool file — one of each, list the rest.</avoid>
    <avoid>Reporting a count, layout, or name list you did not derive this pass.</avoid>
    <avoid>Turning orientation into a docs audit — one closing drift line at most.</avoid>
    <avoid>Launching subagents. A multi-page summary.</avoid>
  </anti-patterns>
</prime-command>
