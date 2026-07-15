import { fileURLToPath } from "node:url";
import type { RibWorkflowContribution } from "@keelson/shared";
import { expectView } from "@keelson/shared";
import { DIGEST_KEY, LENSES_KEY, ROOMS_KEY, ROSTER_KEY } from "./keys.ts";
import { LENS_TOOL_NAME } from "./lens.ts";
import { HTML_LENS_TOOL_NAME } from "./lens-html.ts";
import { discoverLensWorkflows } from "./lens-workflows.ts";
import { chamberDataHome, lensWorkflowsDir } from "./paths.ts";
import {
  DIGEST_WF_PROMPT,
  GENESIS_WF_PROMPT,
  HTML_LENS_WF_PROMPT,
  LENS_REFRESH_WF_PROMPT,
  LENS_WF_PROMPT,
} from "./prompts.ts";

// The standing-digest write seam, referenced by both the tool registration and the
// chamber-digest workflow's author node (allowed_tools) — one source of truth.
export const DIGEST_TOOL_NAME = "chamber_emit_digest";
// The generic living-lens re-author workflow's name (see LENS_REFRESH_WF_PROMPT);
// also the default backing resolveLensRefresh assigns a living lens.
export const LENS_REFRESH_WORKFLOW = "chamber-lens-refresh";

// Absolute path to the roster collector, resolved at module load so the workflow
// node runs the right file regardless of the run's (nominal) cwd. fileURLToPath
// (not URL.pathname) decodes %20 etc. so an install path with a space resolves;
// it is shell-quoted where interpolated into the bash node below.
const ROSTER_COLLECTOR = fileURLToPath(new URL("../bin/collect-roster.ts", import.meta.url));
// The rooms-index collector, resolved the same way (see ROSTER_COLLECTOR).
const ROOMS_COLLECTOR = fileURLToPath(new URL("../bin/collect-rooms.ts", import.meta.url));
// The lenses-index collector, resolved the same way (see ROSTER_COLLECTOR).
const LENSES_COLLECTOR = fileURLToPath(new URL("../bin/collect-lenses.ts", import.meta.url));
// The exhibits-index collector, resolved the same way (see LENSES_COLLECTOR).
// The standing-digest collectors, resolved the same way (see ROSTER_COLLECTOR). The
// gate reads all three stores + the digest, so it bakes in the data home (not a single
// store dir); the publish collector reads the digest store from the same home.
const DIGEST_GATE_COLLECTOR = fileURLToPath(
  new URL("../bin/collect-digest-gate.ts", import.meta.url),
);
const DIGEST_PUBLISH_COLLECTOR = fileURLToPath(
  new URL("../bin/collect-digest-publish.ts", import.meta.url),
);

// POSIX single-quote: wrap a value and escape any embedded quote so a path
// (spaces, `$`, backticks, backslashes) reaches `bash -c` literally — never
// word-split or expanded.
function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// Every workflow name chamber handed the catalog, bundled and operator-authored
// alike, captured at activation. The emit tool reads this to tell an author their
// refresh backing won't run — the one moment that reaches them, since the host's
// refresh seam is fail-soft and an unrunnable backing is otherwise a silent 409 on
// every tick. The question it answers is the host's gate ("does this name carry rib
// provenance?"), which any contribution satisfies — so this must be the WHOLE set,
// not the lens-shaped part of it, or the caveat cries wolf over a backing that runs.
let contributedWorkflows: ReadonlySet<string> = new Set();

export function isChamberWorkflow(name: string): boolean {
  return contributedWorkflows.has(name);
}

export function contributeChamberWorkflows(): readonly RibWorkflowContribution[] {
  const bundled = bundledChamberWorkflows();
  const nameOf = (c: RibWorkflowContribution): string => (c.definition as { name: string }).name;
  // The bundled names are what a discovered file may not take: the catalog keeps one
  // definition per name, so a collision would drop the operator's file silently.
  const discovered = discoverLensWorkflows(lensWorkflowsDir(), new Set(bundled.map(nameOf)));
  const contributions = [...discovered.contributions, ...bundled];
  // Derived from what is actually returned, so a workflow added below is vouched for
  // without anyone remembering to list it twice.
  contributedWorkflows = new Set(contributions.map(nameOf));
  return contributions;
}

// The producer: an agent turn (not a deterministic collector) emits the board,
// which the executor promotes to structured output and the rib binding
// publishes fail-closed via `validate`. This is the "an agent authors a lens"
// proof — zero React, no hand-coded route.
// Every contributed workflow declares mutates_checkout: false — chamber
// workflows write the rib data home and publish snapshots, never a project
// checkout, so the host's per-project mutation lock must not serialize them.
function bundledChamberWorkflows(): readonly RibWorkflowContribution[] {
  return [
    {
      // The roster producer: a deterministic collector that reads the
      // genesis-authored Minds from the data home and emits a board of cards.
      // Genesis mutates the data home via onAction; this refresh reflects it.
      definition: {
        name: "chamber-roster",
        mutates_checkout: false,
        description:
          'Use when: you want to see the agents (Minds) that have been created. Triggers: "show the roster", "list agents", "what minds exist". Does: reads the genesis-authored Minds from the Chamber data home and publishes a roster board (one card per Mind) to the Chamber Roster canvas. NOT for: creating or retiring agents (genesis is the chamber-genesis workflow; retire is a roster board action).',
        nodes: [
          {
            id: "collect",
            // The collector runs out-of-process (a bash node) and can't call
            // ctx.getDataDir, so bake the resolved data home in — captured in
            // registerTools, which runs before this. The collector derives the minds
            // dir, the draft, and the pulse's state dirs + watermark all from it, so
            // both sides read one path (buildChamberState backs the pulse here too).
            bash: `bun ${shQuote(ROSTER_COLLECTOR)} ${shQuote(chamberDataHome())}`,
            output_schema: { type: "object", required: ["view", "sections"] },
          },
        ],
      },
      bindSnapshotKey: ROSTER_KEY,
      validate: expectView(ROSTER_KEY, "board"),
    },
    {
      // The rooms-index producer (the chamber-roster sibling): a deterministic
      // collector that reads the persisted rooms from the data home and emits the
      // sessions index — active rooms first (status-only cards), then ended sessions
      // (each with Open + Delete). A room starting/ending or a room-delete refreshes
      // it; an active room ALSO renders as its own live per-slug panel.
      definition: {
        name: "chamber-rooms",
        mutates_checkout: false,
        description:
          'Use when: you want to see Chamber sessions — active rooms and ended history. Triggers: "show rooms", "list sessions", "room history". Does: reads the persisted rooms from the Chamber data home and publishes a sessions index (active rooms first as status-only cards, then ended rooms each with Open + a Delete control) to the Chamber Rooms canvas. NOT for: starting a room (the Convene composer) or stopping a live room (its inline controls).',
        nodes: [
          {
            id: "collect",
            // Out-of-process (a bash node), so bake the resolved data home in —
            // captured in registerTools, which runs before this. The collector reads
            // both the rooms and the minds (to tone each cast name by its Mind's
            // identity), so it bakes the home, not a single store dir (see the
            // lenses collector).
            bash: `bun ${shQuote(ROOMS_COLLECTOR)} ${shQuote(chamberDataHome())}`,
            output_schema: { type: "object", required: ["view", "sections"] },
          },
        ],
      },
      bindSnapshotKey: ROOMS_KEY,
      validate: expectView(ROOMS_KEY, "board"),
    },
    {
      // The lenses-index producer (the chamber-rooms sibling): a deterministic
      // collector that reads the persisted lenses from the data home and emits the
      // living-views index (one card per lens, each with Open + Retire). An author
      // or a retire refreshes it; each lens also renders as its own live per-id
      // panel, so this index sits alongside those, not in place of them.
      definition: {
        name: "chamber-lenses",
        mutates_checkout: false,
        description:
          'Use when: you want a single index of the living lenses Minds have authored. Triggers: "show the lenses", "list lenses", "what lenses exist". Does: reads the persisted lenses from the Chamber data home and publishes a living-views index (one card per lens, each with Open and a Retire control) to the Chamber Lenses canvas. NOT for: authoring a lens (the chamber-lens workflow) or viewing one (each lens has its own live panel; Open focuses it).',
        nodes: [
          {
            id: "collect",
            // Out-of-process (a bash node), so bake the resolved data home in —
            // captured in registerTools, which runs before this. The collector reads
            // both the lenses and the minds (to tone each lens's dot by its
            // maintaining Mind's identity), so it bakes the home, not a single store dir.
            bash: `bun ${shQuote(LENSES_COLLECTOR)} ${shQuote(chamberDataHome())}`,
            output_schema: { type: "object", required: ["view", "sections"] },
          },
        ],
      },
      bindSnapshotKey: LENSES_KEY,
      validate: expectView(LENSES_KEY, "board"),
    },
    {
      // The digest producer (agent-turn arm of the standing-lens cost guard): a
      // SELF-GATING bound workflow that re-authors a standing digest board with an
      // agent turn, but spends that turn only when the Chamber changed. `gate` (a cheap
      // bash read) emits { dirty, summary }; `author` runs ONLY when dirty (its `when:`),
      // composing the board from the gate's summary and persisting it via
      // chamber_emit_digest (which advances the fingerprint); `publish` always runs
      // (trigger_rule all_done) and re-reads the store to drive the key. The store it
      // writes (digest.json) is what the Briefing banner's "The read" register renders — the
      // digest no longer has a standing surface region of its own. It is MUTATION-DRIVEN,
      // not polled: refreshStandingPanels nudges it on every Chamber mutation (exactly
      // when the fingerprint can have changed), and the fingerprint gate keeps a no-op
      // nudge free. Trade-off vs the old 120s poll: a failed authoring self-heals on the
      // NEXT mutation rather than the next tick (a standing synthesis, so a brief
      // staleness after a rare failed turn is acceptable).
      definition: {
        name: "chamber-digest",
        mutates_checkout: false,
        description:
          'Use when: you want a standing, agent-authored synthesis of the Chamber\'s current shape. Triggers: "show the digest", "what is the chamber like now". Does: a gate detects whether the Chamber changed; on a change, one agent turn composes a digest board and persists it to the store the Briefing banner renders as its "The read" register. Nudged by the rib on each Chamber mutation, but spends a turn only when the Chamber changed. NOT for: the deterministic record feed, the delta Briefing, or authoring a Mind/room/lens.',
        nodes: [
          {
            id: "gate",
            // Out-of-process (a bash node), so bake the resolved data home in —
            // captured in registerTools, which runs before this (see the roster
            // collector). Emits { dirty, summary }; NO output_schema, so it stays text
            // output and never republishes to the key — it only drives `when:` and feeds
            // the author its source via $gate.output.summary.
            bash: `bun ${shQuote(DIGEST_GATE_COLLECTOR)} ${shQuote(chamberDataHome())}`,
          },
          {
            id: "author",
            depends_on: ["gate"],
            // The cost guard: the paid turn runs ONLY when the gate saw a change. A
            // false/absent dirty (a quiet tick, or a failed gate) skips this node — no
            // turn — so a quiet Chamber never spends one.
            when: "$gate.output.dirty == 'true'",
            prompt: DIGEST_WF_PROMPT,
            // chamber_emit_digest validates the board fail-closed; fail_on_tool_error
            // surfaces a bad authoring as a FAILED author node (visible in the run's
            // node rows) rather than a SUCCEEDED turn that wrote nothing. The run itself
            // is not failed — the always-on publish below rescues it (trigger_rule
            // all_done), so a transient bad turn never errors the nudged run, and the
            // un-advanced fingerprint drives a re-author on the next mutation-nudge.
            fail_on_tool_error: true,
            // Rib tools are default-off in workflow prompt nodes; opt in to the single
            // write seam by name (and nothing else).
            allowed_tools: [DIGEST_TOOL_NAME],
          },
          {
            id: "publish",
            depends_on: ["author"],
            // all_done, not the default all_success: publish must run whether author ran
            // (dirty), was skipped (quiet), or failed — so the key re-publishes the
            // cached board and a failed authoring self-heals (the fingerprint stays
            // un-advanced, so the next mutation-nudge re-authors).
            trigger_rule: "all_done",
            bash: `bun ${shQuote(DIGEST_PUBLISH_COLLECTOR)} ${shQuote(chamberDataHome())}`,
            output_schema: { type: "object", required: ["view", "sections"] },
          },
        ],
      },
      bindSnapshotKey: DIGEST_KEY,
      validate: expectView(DIGEST_KEY, "board"),
    },
    {
      // Genesis as a workflow: one prompt turn authors the soul and calls
      // chamber_emit_genesis to persist it. No bindSnapshotKey/validate — genesis
      // writes files (the roster collector reflects them), it does not publish a
      // board. allowed_tools scopes the turn to the single write seam: rib tools are
      // default-off in workflow prompt nodes, so it must opt in by name.
      definition: {
        name: "chamber-genesis",
        mutates_checkout: false,
        description:
          'Use when: create a new agent (Mind). Triggers: "create an agent", "new mind", "/workflow run chamber-genesis <brief>". Does: one agent turn reads a brief, authors a SOUL.md + roster tagline, and persists the Mind via chamber_emit_genesis. NOT for: retiring a Mind or running a room.',
        nodes: [
          {
            id: "genesis",
            prompt: GENESIS_WF_PROMPT,
            // Fail closed: chamber_emit_genesis writes the Mind and fails closed
            // on a slug collision; fail_on_tool_error makes that tool error fail
            // the run instead of reporting SUCCEEDED with no Mind written (#18).
            fail_on_tool_error: true,
            allowed_tools: ["chamber_emit_genesis"],
          },
        ],
      },
    },
    {
      // The lens producer: one agent turn composes a board for the subject and calls
      // chamber_emit_lens to publish it. No bindSnapshotKey — the per-subject key is
      // chosen at run time by the tool, not pinned to one static key.
      definition: {
        name: "chamber-lens",
        mutates_checkout: false,
        description:
          'Use when: have an agent author a one-screen LENS — a custom canvas board on a subject — onto the Chamber surface. Triggers: "author a lens", "show a board on X", "/workflow run chamber-lens <subject>". Does: one agent turn composes a canvas board for the subject and publishes it as its own Chamber lens panel (no hand-coded UI). NOT for: the standing Chamber Briefing (the rib-driven banner), genesis-ing agents, or running a room.',
        nodes: [
          {
            id: "compose",
            prompt: LENS_WF_PROMPT,
            // Fail closed: chamber_emit_lens validates the board and the workflow
            // should fail loudly if the publish errors, not report SUCCEEDED with
            // no lens rendered.
            fail_on_tool_error: true,
            allowed_tools: [LENS_TOOL_NAME],
          },
        ],
      },
    },
    {
      // The generic living-lens re-author: the refresh backing a lens gets when
      // its emit names no workflow of its own. Runs with input `lens` (the record
      // id); the turn re-reads the record and re-emits under the same id. No
      // bindSnapshotKey — the emit tool republishes the per-subject key itself,
      // and the region-declared /refresh gate admits unbound workflows.
      definition: {
        name: LENS_REFRESH_WORKFLOW,
        mutates_checkout: false,
        description:
          'Use when: re-compose a LIVING lens so its content is current — the refresh backing behind a lens authored with refresh set. Triggers: a lens panel\'s cadence or Refresh action (input `lens` = the lens id); "/workflow run chamber-lens-refresh" with inputs lens=<id>. Does: one agent turn re-reads the persisted lens and re-emits a fresh board under the same id via chamber_emit_lens. NOT for: authoring a new lens (chamber-lens), exhibits (a tabled deliverable never refreshes), or the standing Chamber Briefing.',
        inputs: { lens: { description: "the lens id to re-compose", required: true } },
        nodes: [
          {
            id: "refresh",
            prompt: LENS_REFRESH_WF_PROMPT,
            // Fail closed like chamber-lens: a rejected emit must fail the run,
            // not report SUCCEEDED with a stale panel.
            fail_on_tool_error: true,
            allowed_tools: ["chamber_list_lenses", LENS_TOOL_NAME],
          },
        ],
      },
    },
    {
      // The HTML lens producer (the chamber-lens sibling): one agent turn composes
      // a designed, self-contained HTML page for the subject and emits it via
      // chamber_emit_lens_html. No bindSnapshotKey — the per-subject key is chosen
      // at run time by the tool.
      definition: {
        name: "chamber-lens-html",
        mutates_checkout: false,
        description:
          'Use when: have an agent author a designed HTML LENS — a self-contained, token-themed page on a subject — rendered in a sandboxed iframe on the Chamber surface. Triggers: "author an html lens", "design a page on X", "/workflow run chamber-lens-html <subject>". Does: one agent turn composes a self-contained HTML page for the subject (keelson design tokens, validated palette) and publishes it as its own Chamber lens panel via chamber_emit_lens_html. NOT for: structured canvas boards (the chamber-lens workflow), the standing Chamber Briefing, genesis-ing agents, or running a room.',
        nodes: [
          {
            id: "compose",
            prompt: HTML_LENS_WF_PROMPT,
            // Deliberately NO fail_on_tool_error: a rejected palette or blocked
            // external resource is the retry signal — the turn reads the isError
            // report, fixes the markup, and emits again within the same node.
            allowed_tools: [HTML_LENS_TOOL_NAME],
          },
        ],
      },
    },
  ];
}
