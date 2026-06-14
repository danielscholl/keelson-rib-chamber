---
description: Prime understanding of the Chamber rib — the Rib contract surface, the room loop, and conventions
allowed-tools: Bash, Read, Glob, Grep
---

<prime-command>
  <objective>
    Build a working mental model of @keelson/rib-chamber — a Keelson rib that adds
    the multi-agent layer (genesis agents, agent-to-agent rooms, agent-authored
    lenses) — fast enough to navigate it and respect its invariants before making
    a change.
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
      <extract>The exported `Rib`: views + the Chamber surface; contributeWorkflows
        (chamber-roster / -brief / -genesis); registerTools (genesis seam always;
        room tools only when runAgentTurn + snapshot seams exist); onAction; the
        agents + commands seams; and the fail-closed wiring.</extract>
    </step>
    <step name="types">
      <action>Read src/types.ts.</action>
      <extract>Mind, RoomConfig, the strategy decision type, RoomStrategyName.</extract>
    </step>
    <step name="driver">
      <action>Skim src/room.ts and src/ports.ts.</action>
      <extract>The driver owns turns, persistence, and publishing; the ports are the
        seams (store, publisher, runAgentTurn, minds resolver).</extract>
    </step>
  </phase>

  <phase number="3" name="strategies-and-lenses">
    <action>Read ONE strategy as the pattern; list the rest.</action>
    <points>
      <point>src/strategies/sequential.ts — a pure turn decision (speak/end). The
        others (group-chat, open-floor, concurrent) follow the same shape, registered
        in strategies/index.ts.</point>
      <point>src/boards/ — board builders for the roster and room lenses (canvas
        `board` data, no React). bin/collect-roster.ts is the roster collector.</point>
    </points>
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
      <point>Invariants: zero React; strategies pure; attach only via the Rib
        contract; fail closed; paid turns are budget-capped + confirm-gated.</point>
      <point>Comments: default to none; capture non-obvious why; no narration.</point>
    </points>
  </phase>

  <phase number="6" name="summarize">
    <format>Concise markdown — no multi-page dump:</format>
    <sections>
      <section>Project: 1–2 sentences (a Keelson rib; the multi-agent layer).</section>
      <section>The Rib surface: views/surface, workflows, tools, actions, agents/commands.</section>
      <section>The room loop: strategies (pure) ⇄ driver (I/O) ⇄ publisher (fail-closed board).</section>
      <section>Commands: test / typecheck / check / link:keelson.</section>
      <section>Invariants to respect for the change at hand.</section>
      <section>Where to start: which file to open first.</section>
    </sections>
  </phase>

  <anti-patterns>
    <avoid>Reading every strategy/board/test to "understand patterns" — read one, list the rest.</avoid>
    <avoid>Launching subagents.</avoid>
    <avoid>A multi-page summary.</avoid>
  </anti-patterns>
</prime-command>
