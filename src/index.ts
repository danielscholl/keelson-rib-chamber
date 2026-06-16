import { fileURLToPath } from "node:url";
import type {
  CommandCompletion,
  CommandInvokeResult,
  Rib,
  RibAction,
  RibActionResult,
  RibCommandDescriptor,
  RibContext,
  SnapshotManager,
  ToolContext,
  ToolDefinition,
} from "@keelson/shared";
import {
  asNonEmptyString,
  asStringArray,
  canvasBoardViewSchema,
  errText,
  expectView,
  z,
} from "@keelson/shared";
import { listAgents, resolveAgent } from "./agents.ts";
import { capabilityVocabulary, KNOWN_CAPABILITY_SLUGS } from "./capabilities.ts";
import { buildSeedFor } from "./compose.ts";
import { assertSafeSlug, slugify } from "./genesis.ts";
import {
  CHAMBER_SURFACE_ID,
  canonicalLensId,
  createLensRegistry,
  LENS_TOOL_NAME,
  type LensRegistry,
} from "./lens.ts";
import { type MindRecord, readMinds, readSoul, retireMind, scaffoldMind } from "./minds-store.ts";
import { chamberDataHome, mindsDir, roomsDir } from "./paths.ts";
import type { RoomStore } from "./ports.ts";
import { createRoomDriver, type RoomDriver } from "./room.ts";
import { type RoomConfigInput, roomConfigFromFlat } from "./room-config.ts";
import { createCoalescingPublisher } from "./room-publisher.ts";
import { createFileRoomStore, sweepClosedRooms } from "./room-store.ts";
import { DEFAULT_END_VOTE_THRESHOLD } from "./routing.ts";
import { getStrategy } from "./strategies/index.ts";
import { renderTranscript } from "./transcript.ts";
import type { Mind, RoomConfig, RoomStrategyName } from "./types.ts";

const BRIEF_KEY = "rib:chamber:brief";
const ROSTER_KEY = "rib:chamber:roster";
const ROOM_KEY = "rib:chamber:room";

// Upper bound on a room's turn budget. Each turn is a (paid) agent call, so an
// accidental or malicious huge budget would launch a runaway sequence; reject it.
const MAX_ROOM_TURN_BUDGET = 50;
// Default room length when a chat tool omits turnBudget. Applied after parse (not
// z.default()) because z.toJSONSchema — which the Copilot provider feeds the model
// — lists defaulted fields as `required`, forcing the model to supply them.
const DEFAULT_ROOM_TURN_BUDGET = 8;

// The room driver is a boot-time singleton: it holds in-flight turn state across
// onAction calls, so it is built once in registerTools (the only hook that runs
// with the full ctx — runAgentTurn + snapshot manager) and reused thereafter. It
// stays undefined when either seam is absent, and room actions then fail closed.
let driver: RoomDriver | undefined;
// The lens registry is a boot-time singleton too: it owns the per-subject snapshot
// registrations and surface regions, created once in registerTools and disposed in
// dispose() so a re-register doesn't duplicate-register. lensSm tracks the manager it
// was built against, so a re-bootstrap with a different one rebinds it.
let lensRegistry: LensRegistry | undefined;
let lensSm: SnapshotManager | undefined;
// Slugs whose auto-advance loop is running, so a re-start doesn't double-drive.
const loops = new Set<string>();
// Monotonic suffix so each room-start gets a brand-new slug (see freshRoomSlug).
let roomSeq = 0;
// The slug of the currently-active room (at most one, per the single-active
// invariant). Set when a room opens, cleared when it stops or its loop ends — so
// the chat tools can target "the room" without the server-assigned slug.
let activeSlug: string | undefined;
// The most-recent room, active or finished. Unlike activeSlug it survives the
// room ending, so chamber_room_status can still show a just-finished transcript.
// Cleared only on dispose.
let lastSlug: string | undefined;
let roomRetentionSweep = Promise.resolve();

// The roster the driver resolves a speaker's persona from each turn. Cached
// because it only changes when a Mind is created (the genesis tool) or retired
// (onAction); re-reading every mind dir per turn is avoidable disk I/O.
// invalidateRoster() clears it on any mutation and dispose() resets it, so a fresh
// boot re-reads. Assumes a fixed workspace per process — the cache is not keyed on
// KEELSON_WORKSPACE.
let roster: readonly Mind[] | undefined;
async function resolveMinds(): Promise<readonly Mind[]> {
  if (roster) return roster;
  const minds = await readMinds(mindsDir());
  // Only memoize a non-empty read: readMinds returns [] both for "no minds yet"
  // and for a transient readdir error, so caching [] would stick an empty roster
  // (every speaker -> "unknown mind", ending each room) until the next mutation.
  // Re-reading an empty dir each turn is cheap and self-heals once minds appear.
  if (minds.length > 0) roster = minds;
  return minds;
}
function invalidateRoster(): void {
  roster = undefined;
}

function queueRoomRetentionSweep(): void {
  const root = roomsDir();
  roomRetentionSweep = roomRetentionSweep.then(
    () => runRoomRetentionSweep(root),
    () => runRoomRetentionSweep(root),
  );
}

async function runRoomRetentionSweep(root: string): Promise<void> {
  try {
    await sweepClosedRooms(root);
  } catch (e) {
    console.error(`[rib-chamber] room retention sweep failed: ${errText(e)}`);
  }
}

// Absolute path to the roster collector, resolved at module load so the workflow
// node runs the right file regardless of the run's (nominal) cwd. fileURLToPath
// (not URL.pathname) decodes %20 etc. so an install path with a space resolves;
// it is shell-quoted where interpolated into the bash node below.
const ROSTER_COLLECTOR = fileURLToPath(new URL("../bin/collect-roster.ts", import.meta.url));

// The brief's JSON-Schema shape, used twice. As `output_format` it's the
// structured-output directive appended to the prompt (and flips the node to a
// structured producer so the bound-key publish bridge sees a value, not text).
// As `output_schema` it's the executor's fail-closed node guard: listing
// `properties` (not just `required`) makes a top-level type mismatch — e.g.
// `sections` returned as a string — fail the run loudly, instead of passing a
// keys-only check and then being silently dropped by the canvas `validate` on
// publish (a stale panel with no refresh error). The deep board check stays the
// canvas `validate` on the bound key below.
const BRIEF_SHAPE = {
  type: "object",
  // `title` is required here (the prompt contract asks for one and a titled
  // briefing reads better) even though the canvas board treats it as optional —
  // a stricter-than-canvas node guard, not a looser one. `view` stays a plain
  // string because the output_schema subset has no const/enum; the exact
  // "board" kind is enforced fail-closed by `validate` (expectView) on publish.
  required: ["view", "title", "sections"],
  properties: {
    view: { type: "string" },
    title: { type: "string" },
    sections: { type: "array" },
  },
} as const;

// Phase 0 is a seam proof: an agent turn authors a canvas `board` that renders
// on the Chamber surface with no hand-coded UI. No data source is wired yet, so
// the brief is an honest, self-describing operator briefing about Chamber
// itself — not invented external metrics. Tools are withheld (allowed_tools: [])
// so the turn composes purely from this prompt.
const BRIEF_PROMPT = `You are the editor of "Chamber" — Keelson's multi-agent operating layer (genesis agents, agent-to-agent rooms, agent-authored lenses). Compose a one-screen operator BRIEFING and return it as a single canvas \`board\` view.

This is a live demonstration that an agent can author its own lens: your JSON is validated fail-closed and rendered directly on the Chamber surface, with no hand-coded UI. Do NOT invent clusters, users, or external metrics you cannot see — write an honest briefing about Chamber: what it is, what is live, and what is next.

Return ONE JSON object of this shape:
  { "view": "board", "title": string, "header"?: { "status"?: { "label": string, "tone"?: Tone } }, "sections": Section[] }
Tone is one of: ok, warn, error, neutral, info, caution, brand, accent.
Use 3-4 Section kinds, in a sensible order:
  - stats:    { "kind": "stats", "title"?: string, "items": [{ "label": string, "value": string|number, "sub"?: string, "tone"?: Tone }] }
  - segments: { "kind": "segments", "title"?: string, "items": [{ "label": string, "n": number, "tone"?: Tone }] }
  - rows:     { "kind": "rows", "title"?: string, "items": [{ "text": string, "glyph"?: Tone, "trailing"?: string }] }
  - cards:    { "kind": "cards", "title"?: string, "items": [{ "title": string, "pill"?: { "label": string, "tone"?: Tone }, "fields"?: [{ "label"?: string, "value": string|number }], "footnote"?: string }] }

Keep it tight: a status pill, ~3 KPI stats, a 3-5 item "rows" list (what's live / what's next), and 2-3 explanatory cards. Concise, editorial copy.

Example — copy this structure exactly, replace the content:
{ "view":"board","title":"Chamber Briefing","header":{"status":{"label":"Phase 0 · lens proof","tone":"brand"}},"sections":[{"kind":"stats","title":"Pulse","items":[{"label":"Minds","value":0,"sub":"genesis lands Phase 1","tone":"neutral"},{"label":"Rooms","value":0,"sub":"Phase 2","tone":"neutral"},{"label":"Lenses","value":1,"sub":"this briefing","tone":"ok"}]},{"kind":"rows","title":"Status","items":[{"text":"Agent-authored briefing lens","glyph":"ok","trailing":"live"},{"text":"Genesis + roster","glyph":"info","trailing":"next"},{"text":"Two-agent room","glyph":"neutral","trailing":"Phase 2"}]},{"kind":"cards","title":"What this proves","items":[{"title":"An agent authored this view","pill":{"label":"lens","tone":"brand"},"fields":[{"label":"key","value":"rib:chamber:brief"}],"footnote":"No hand-coded UI — the board came from an agent turn through Keelson's canvas."}]}] }`;

// Genesis as a workflow (the chamber-brief sibling): one agent turn reads a
// freeform brief, authors the SOUL.md body + a roster tagline, and persists the
// Mind by calling the chamber_emit_genesis tool (the deterministic write seam).
// Unlike brief it publishes no snapshot — its product is files on disk, which the
// chamber-roster collector then reflects. $ARGUMENTS carries the brief (chat
// `/workflow run chamber-genesis <brief>`); explicit $inputs.* are honored when a
// caller supplies them (CLI --inputs). The model is scoped to the one emit tool.
const GENESIS_WF_PROMPT = `You are authoring the founding identity of a new persistent agent — a "Mind" — for Keelson's Chamber, a multi-agent operating layer.

Brief: $ARGUMENTS

(If these explicit fields are non-empty, prefer them over the brief — name: "$inputs.name", role: "$inputs.role", voice: "$inputs.voice".)

From the brief, decide the Mind's name, role, and voice (how it speaks). Then write an honest founding document — do NOT invent tools, credentials, or capabilities it does not have; describe who it is, what it is for, and how it speaks.

Compose:
- soul: Markdown for the Mind's SOUL.md, with these sections in order:
    # <name>
    ## Persona  — who this Mind is, grounded in the role
    ## Mission  — what it exists to do
    ## Voice    — how it speaks (tone, length, habits)
- tagline: one line, at most 120 characters, summarizing the Mind for a roster card (no Markdown).
- tools: an OPTIONAL array of capability slugs the Mind may use inside a room — choose ONLY from this set: ${capabilityVocabulary()}. Include a slug only when the role genuinely calls for it; omit it (or use []) for a conversation-only Mind, and never invent a slug outside this set.

Then call the chamber_emit_genesis tool EXACTLY ONCE with { name, role, voice, soul, tagline, tools } to persist the Mind — do NOT print the JSON as your reply. After the tool returns, reply with a single short line naming the Mind you created.`;

// The lens authoring prompt (the chamber-brief sibling): one agent turn composes a
// canvas board on a subject and calls chamber_emit_lens to publish it. Unlike brief
// it is not pinned to one key — the tool routes by `id` to a per-subject key, so
// distinct subjects land in distinct panels and re-authoring a subject updates it.
const LENS_WF_PROMPT = `You are authoring a LENS for Keelson's Chamber — a one-screen canvas \`board\` view on a subject, rendered live on the Chamber surface with no hand-coded UI.

Subject: $ARGUMENTS

Compose ONE canvas board about the subject. Be honest — do NOT invent data you cannot see; if the subject is abstract, lay out its structure, parts, or status rather than fabricating metrics.

The board shape:
  { "view": "board", "title": string, "header"?: { "status"?: { "label": string, "tone"?: Tone } }, "sections": Section[] }
Tone is one of: ok, warn, error, neutral, info, caution, brand, accent.
Use 2-4 Section kinds, in a sensible order:
  - stats: { "kind":"stats", "title"?:string, "items":[{ "label":string, "value":string|number, "sub"?:string, "tone"?:Tone }] }
  - rows:  { "kind":"rows", "title"?:string, "items":[{ "text":string, "glyph"?:Tone, "trailing"?:string }] }
  - cards: { "kind":"cards", "title"?:string, "items":[{ "title":string, "pill"?:{ "label":string, "tone"?:Tone }, "fields"?:[{ "label"?:string, "value":string|number }], "footnote"?:string }] }

Then call the chamber_emit_lens tool EXACTLY ONCE with { id, board }:
  - id: a short, stable, kebab-case identifier for this subject (e.g. "release-risks") — re-authoring the same subject reuses its panel.
  - board: the canvas board object above.
Do NOT print the JSON as your reply. After the tool returns, reply with one short line naming the lens you authored.`;

// The rib's slash commands for the harness command registry (GET /api/commands).
// /mind opens a Mind as a seeded chat; /genesis authors a new Mind from a brief.
// All chamber vocabulary lives here — the harness knows only "a rib offered a
// command" and performs the closed effect the invoke returns.
const CHAMBER_COMMANDS: readonly RibCommandDescriptor[] = [
  {
    name: "mind",
    description: "Open a Mind as a seeded chat",
    argument: { hint: "<slug>", completes: true },
  },
  {
    name: "genesis",
    description: "Author a new Mind from a freeform brief",
    argument: { hint: "<brief>" },
  },
  {
    name: "lens",
    description: "Author a lens — a canvas board on a subject",
    argument: { hint: "<subject>" },
  },
];

// Slug type-ahead for /mind — the Minds on the roster, filtered by prefix.
async function completeChamberCommand(
  name: string,
  prefix: string,
): Promise<readonly CommandCompletion[]> {
  if (name !== "mind") return [];
  return (await listAgents())
    .filter((a) => a.slug.startsWith(prefix))
    .map((a) => ({ value: a.slug, description: a.description }));
}

// The message effect's text is capped by the shared commandEffectSchema (8000);
// keep the inline list under it so a large roster can't 500 the invoke route.
const MESSAGE_TEXT_BUDGET = 7000;
function boundedLines(header: string, rows: readonly string[]): string {
  const out = [header];
  let used = header.length;
  let shown = 0;
  for (const row of rows) {
    if (used + 1 + row.length > MESSAGE_TEXT_BUDGET) break;
    out.push(row);
    used += 1 + row.length;
    shown += 1;
  }
  if (shown < rows.length) out.push(`  …and ${rows.length - shown} more (type a slug to filter)`);
  return out.join("\n");
}

// Run a chamber command server-side and return the closed effect the surface
// performs. /mind resolves to an open-agent effect (the surface resolves the seed
// through the agents seam), or an inline list when called with no slug; /genesis
// to a run-workflow effect (chamber-genesis, brief as $ARGUMENTS).
async function invokeChamberCommand(name: string, arg: string): Promise<CommandInvokeResult> {
  const value = arg.trim();
  if (name === "mind") {
    const agents = await listAgents();
    if (agents.length === 0) {
      return {
        ok: true,
        effect: {
          effect: "message",
          text: "No Minds yet — author one with /genesis <brief>.",
        },
      };
    }
    if (value.length === 0) {
      const rows = agents.map((a) =>
        a.description ? `  ${a.slug} — ${a.description}` : `  ${a.slug}`,
      );
      return {
        ok: true,
        effect: { effect: "message", text: boundedLines("Minds:", rows) },
      };
    }
    if (!agents.some((a) => a.slug === value)) {
      return { ok: false, error: `No Mind "${value}".` };
    }
    return { ok: true, effect: { effect: "open-agent", ribId: "chamber", slug: value } };
  }
  if (name === "genesis") {
    if (value.length === 0) {
      return { ok: false, error: "usage: /genesis <brief> — describe the agent to author" };
    }
    return {
      ok: true,
      effect: { effect: "run-workflow", workflow: "chamber-genesis", args: value },
    };
  }
  if (name === "lens") {
    if (value.length === 0) {
      return { ok: false, error: "usage: /lens <subject> — describe the lens to author" };
    }
    return {
      ok: true,
      effect: { effect: "run-workflow", workflow: "chamber-lens", args: value },
    };
  }
  return { ok: false, error: `unknown command: ${name}` };
}

const rib: Rib = {
  id: "chamber",
  displayName: "Chamber",

  // Binds the agent-authored keys to the canvas renderer; data arrives when the
  // producers (the roster collector, the brief turn, the room driver) run.
  views: [
    { key: ROSTER_KEY, canvasKind: "view", title: "Roster" },
    { key: ROOM_KEY, canvasKind: "view", title: "Room" },
    { key: BRIEF_KEY, canvasKind: "view", title: "Briefing" },
  ],

  // No static actions[]: a payload-less button can't carry input, so every Chamber
  // control lives where its context is. Genesis is the chamber-genesis workflow (it
  // needs a freeform brief); retire and the room controls (start/inject/stop) are
  // payload-carrying board actions (the OSDU pattern) that reach onAction below.

  // The Chamber nav tab. The roster sits in the header (the Minds you genesis),
  // the live room transcript fills the row, and the brief settles into the
  // footer. The room region carries no workflow: it is push-fed — the driver
  // recomposes ROOM_KEY on every turn (no collector, no cadence poll). Lens panels
  // are not declared here: a Mind authors them at runtime (chamber_emit_lens),
  // each registering its own region below the room row via the registerRegion seam.
  surfaces: [
    {
      id: CHAMBER_SURFACE_ID,
      title: "Chamber",
      layout: {
        header: {
          key: ROSTER_KEY,
          workflow: "chamber-roster",
          title: "Roster",
          // The roster is a cheap deterministic collector that only changes on
          // genesis/retire; a modest cadence keeps it self-populating on open and
          // fresh after a new Mind without hammering. The Briefing footer is left
          // cadence-free on purpose — it is a paid agent turn, refreshed on demand.
          cadenceMs: 120_000,
          glyph: { char: "◇", tone: "brand" },
        },
        rows: [
          { columns: [{ key: ROOM_KEY, title: "Room", glyph: { char: "▦", tone: "brand" } }] },
        ],
        footer: {
          key: BRIEF_KEY,
          workflow: "chamber-brief",
          title: "Briefing",
          glyph: { char: "❖", tone: "brand" },
        },
      },
    },
  ],

  // The producer: an agent turn (not a deterministic collector) emits the board,
  // which the executor promotes to structured output and the rib binding
  // publishes fail-closed via `validate`. This is the "an agent authors a lens"
  // proof — zero React, no hand-coded route.
  contributeWorkflows: () => [
    {
      // The roster producer: a deterministic collector that reads the
      // genesis-authored Minds from the data home and emits a board of cards.
      // Genesis mutates the data home via onAction; this refresh reflects it.
      definition: {
        name: "chamber-roster",
        description:
          'Use when: you want to see the agents (Minds) that have been created. Triggers: "show the roster", "list agents", "what minds exist". Does: reads the genesis-authored Minds from the Chamber data home and publishes a roster board (one card per Mind) to the Chamber Roster canvas. NOT for: creating or retiring agents (genesis is the chamber-genesis workflow; retire is a roster board action).',
        nodes: [
          {
            id: "collect",
            bash: `bun ${JSON.stringify(ROSTER_COLLECTOR)}`,
            output_schema: { type: "object", required: ["view", "sections"] },
          },
        ],
      },
      bindSnapshotKey: ROSTER_KEY,
      validate: expectView(ROSTER_KEY, "board"),
    },
    {
      definition: {
        name: "chamber-brief",
        description:
          'Use when: you want a one-screen briefing of the Chamber multi-agent layer. Triggers: "chamber briefing", "what is chamber doing", "show the chamber brief". Does: runs one agent turn that authors a canvas board (an operator briefing — status pulse, KPI stats, what\'s live / next, explanatory cards) and publishes it to the Chamber Briefing canvas. NOT for: genesis-ing agents or running a room.',
        nodes: [
          {
            id: "compose",
            prompt: BRIEF_PROMPT,
            output_format: BRIEF_SHAPE,
            output_schema: BRIEF_SHAPE,
            allowed_tools: [],
          },
        ],
      },
      bindSnapshotKey: BRIEF_KEY,
      validate: expectView(BRIEF_KEY, "board"),
    },
    {
      // Genesis as a workflow: one prompt turn authors the soul and calls
      // chamber_emit_genesis to persist it. No bindSnapshotKey/validate — genesis
      // writes files (the roster collector reflects them), it does not publish a
      // board. allowed_tools scopes the turn to the single write seam: rib tools are
      // default-off in workflow prompt nodes, so it must opt in by name.
      definition: {
        name: "chamber-genesis",
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
      // The lens producer (the chamber-brief sibling, but key-routed): one agent
      // turn composes a board for the subject and calls chamber_emit_lens to publish
      // it. No bindSnapshotKey — the per-subject key is chosen at run time by the
      // tool, not pinned to one static key.
      definition: {
        name: "chamber-lens",
        description:
          'Use when: have an agent author a one-screen LENS — a custom canvas board on a subject — onto the Chamber surface. Triggers: "author a lens", "show a board on X", "/workflow run chamber-lens <subject>". Does: one agent turn composes a canvas board for the subject and publishes it as its own Chamber lens panel (no hand-coded UI). NOT for: the standing Chamber briefing (chamber-brief), genesis-ing agents, or running a room.',
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
  ],

  // Boot-time wiring of the room loop. Registers the push-fed room snapshot and
  // builds the driver against the real seams: runAgentTurn (C1) for the turns,
  // the snapshot manager as the publisher (publish caches the board and
  // recomposes ROOM_KEY — a live WS push, no collector), the FS data home as the
  // store, and the roster as the minds resolver. Both seams are optional, so the
  // driver stays undefined on a host without them and room actions fail closed.
  registerTools: (ctx: RibContext) => {
    // The genesis write seam is always available: genesis is a workflow whose
    // prompt node calls chamber_emit_genesis, and the write needs no room driver.
    // The room-control tools (and the driver) require the C1 agent-turn + snapshot
    // seams, so they only appear when those are present.
    const genesisTool = makeGenesisTool();
    const sm = ctx.getSnapshotManager?.();
    const registerRegion = ctx.registerRegion;
    const run = ctx.runAgentTurn;
    // Lenses render via the registerRegion seam, so the registry and its emit tool
    // wire up only when BOTH the snapshot manager and registerRegion are present —
    // independent of the room's C1 agent-turn seam (the room tools below additionally
    // require runAgentTurn). Without registerRegion the tool is withheld (fail closed)
    // rather than publishing invisible, unbounded keys that never render. Created once
    // (a module singleton, like the room driver) and reused on a later registerTools so
    // its keys aren't registered twice. If a different manager arrives (a re-bootstrap
    // without an intervening dispose), rebuild against it rather than publishing through
    // the stale manager. Build the replacement BEFORE disposing the old one, so a failed
    // rebuild leaves the existing registry and lensSm consistent.
    if (sm && registerRegion && sm !== lensSm) {
      const next = createLensRegistry(sm, registerRegion);
      lensRegistry?.dispose();
      lensRegistry = next;
      lensSm = sm;
    }
    const lensTools = sm && registerRegion && lensRegistry ? [makeLensTool(lensRegistry)] : [];
    if (sm && run) {
      // Seed a valid empty board so a client subscribing before the first turn
      // gets a well-formed view; every publish replaces it with the live board.
      // The coalescing pump lives in createCoalescingPublisher so it is unit-
      // tested apart from the rib boot — true concurrent depends on it to not
      // lose a frame when a parallel round's commit and a director inject overlap.
      const { publisher, latest } = createCoalescingPublisher(() => sm.recompose(ROOM_KEY));
      sm.register(ROOM_KEY, latest, { validate: expectView(ROOM_KEY, "board") });
      const roomStore = createFileRoomStore(roomsDir());
      driver = createRoomDriver({
        store: roomStore,
        publisher,
        runAgentTurn: run,
        minds: resolveMinds,
        readSoul: (slug) => readSoul(mindsDir(), slug),
        turnCwd: chamberDataHome(),
        // When the lens seam is wired, let a Mind author a lens mid-room: the C1
        // turn seam resolves this name to the rib's registered chamber_emit_lens
        // def and projects it to the provider. Without it, room turns stay text-only.
        ...(lensRegistry ? { turnTools: [{ name: LENS_TOOL_NAME }] } : {}),
      });
      queueRoomRetentionSweep();
      // Prime the cache so a client subscribing before the first turn gets the
      // seeded board, not a 204 / loading skeleton (the GET path doesn't
      // lazy-compose).
      void sm.recompose(ROOM_KEY);
      // Expose the room controls as chat tools (start / say / stop / status),
      // sharing the same driver + store this hook just built. Returned only when
      // the seams are present (no driver -> no tools), mirroring how the actions
      // fail closed.
      return [genesisTool, ...lensTools, ...roomControlTools(roomStore)];
    }
    return [genesisTool, ...lensTools];
  },

  // Retire a Mind (removes it, then refreshes the roster — the OSDU
  // mutate-then-refresh pattern). The room-* controls drive the room loop; the
  // transcript pushes to the canvas as turns land (no refresh needed). Turns
  // advance on their own (the auto-advance loop), so there is no manual step.
  onAction: (action) => {
    switch (action.type) {
      case "enter-mind":
        return enterMindAction(action);
      case "retire":
        return retireAction(action);
      case "room-start":
        return roomStartAction(action);
      case "room-inject":
        return roomInjectAction(action);
      case "room-stop":
        return roomStopAction(action);
      default:
        return { ok: false, error: `unknown action '${action.type}'` };
    }
  },

  // Agents: every Mind is enterable as a keelson agent (GET /api/agents, the /mind
  // command's source). resolveAgent builds the same seed the roster Enter action
  // does (buildSeedFor), so the two entry points can't drift.
  listAgents: () => listAgents(),
  resolveAgent: (slug: string) => resolveAgent(slug),

  // Slash commands: /mind opens a Mind as a seeded chat (resolved through the
  // agents seam via the open-agent effect); /genesis authors a new Mind by running
  // the chamber-genesis workflow with the brief as $ARGUMENTS.
  listCommands: () => CHAMBER_COMMANDS,
  completeCommand: (name, prefix) => completeChamberCommand(name, prefix),
  invokeCommand: (name, arg) => invokeChamberCommand(name, arg),

  // Shutdown: stop the auto-advance loops and abort any in-flight turn so a CLI
  // child can't keep running (or publish) after teardown. driver.dispose() sets
  // the disposal flag the loop observes (so it stops between turns), and the
  // in-flight turn drops its late append/commit instead of writing post-teardown
  // — so a room caught mid-turn is left as-is on disk (status stays "active"; a
  // fresh process re-reads it), not finalized to "stopped". Resets the roster
  // cache too, so a re-boot re-reads minds.
  dispose: async () => {
    loops.clear();
    activeSlug = undefined;
    lastSlug = undefined;
    invalidateRoster();
    lensRegistry?.dispose();
    lensRegistry = undefined;
    lensSm = undefined;
    await driver?.dispose();
  },
};

const ROOM_DISABLED: RibActionResult = {
  ok: false,
  error: "room controls require the C1 agent-turn seam and a snapshot manager",
};

// Drive turns on their own until the room leaves "active" (budget reached, or a
// stop/inject ended it). Detached and idempotent per slug: room-start kicks it,
// the driver's serial gate + generation gating keep one turn at a time, and a
// stop aborts the in-flight turn so step() reports the room is no longer active
// and the loop exits. step() is the sole room.json reader for the drive decision
// (it returns a StepOutcome), so the loop no longer re-reads it. Errors are
// logged, never thrown into the (already-returned) action.
function ensureLoop(slug: string): void {
  if (!driver || driver.isDisposed() || loops.has(slug)) return;
  loops.add(slug);
  const activeDriver = driver;
  void (async () => {
    try {
      while (!activeDriver.isDisposed()) {
        // Stop only when the room left "active" (budget reached, stopped, or
        // superseded). "busy" can't occur here — this loop is the sole stepper
        // and awaits each step fully — so anything but "ended" means keep going.
        if ((await activeDriver.step(slug)) === "ended") break;
      }
    } catch (e) {
      console.error(`[rib-chamber] room loop '${slug}' failed: ${errText(e)}`);
      // The loop died mid-room: the driver still holds this slug as its active
      // room and room.json is still "active". Force-stop so the driver and disk
      // agree with the cleared module activeSlug below — otherwise the room is
      // invisible to the tools yet blocks every restart ("a room is already active").
      try {
        await activeDriver.stop(slug);
      } catch (stopErr) {
        console.error(`[rib-chamber] failed to stop wedged room '${slug}': ${errText(stopErr)}`);
      }
    } finally {
      loops.delete(slug);
      // The room left "active" — drop it as the chat tools' target.
      if (activeSlug === slug) activeSlug = undefined;
      queueRoomRetentionSweep();
    }
  })();
}

// Validate + canonicalize room-start inputs, shared by startRoom and the
// chamber_room_start dry-run so the dry-run never advertises a start the real
// path would reject. De-dupes participants and requires at least two DISTINCT
// valid speakers — the tool schema's min(2) counts RAW entries, so ["a","a"]
// would otherwise collapse to a one-Mind room — and that each names a real Mind,
// since the chat tool takes free-form slugs (a typo would otherwise open a room
// that dies on "unknown mind" mid-rotation after burning paid turns).
type StartConfigInput = RoomConfigInput;

// The positive-integer floor for the routing knobs both group-chat and open-floor
// accept. Floored at the shared boundary so every entry point (chat tool, board
// action, a direct API payload) is protected — a 0 minRounds would open the close
// gate immediately, a 0 maxSpeakerRepeats would redirect every pick. Returns an
// error message, or null when the knobs are valid/absent.
function routingKnobError(config: StartConfigInput): string | null {
  if (
    config.minRounds !== undefined &&
    (!Number.isInteger(config.minRounds) || config.minRounds < 1)
  ) {
    return "minRounds must be a positive integer";
  }
  if (
    config.maxSpeakerRepeats !== undefined &&
    (!Number.isInteger(config.maxSpeakerRepeats) || config.maxSpeakerRepeats < 1)
  ) {
    return "maxSpeakerRepeats must be a positive integer";
  }
  return null;
}

async function validateStart(
  participants: readonly string[],
  turnBudget: number,
  strategy: string,
  config: StartConfigInput = {},
): Promise<
  { ok: true; participants: string[]; config?: RoomConfig } | { ok: false; error: string }
> {
  const deduped = [...new Set(participants)];
  if (deduped.length < 2 || !deduped.every(isValidParticipant)) {
    return {
      ok: false,
      error: "a room needs at least 2 distinct participants (safe Mind slugs, not director/system)",
    };
  }
  if (!Number.isInteger(turnBudget) || turnBudget <= 0 || turnBudget > MAX_ROOM_TURN_BUDGET) {
    return { ok: false, error: `turnBudget must be an integer in 1..${MAX_ROOM_TURN_BUDGET}` };
  }
  // Reject an unknown/unregistered strategy here (the dry-run calls validateStart but
  // not driver.start), so a typo or an unimplemented strategy can't be advertised as
  // startable and then fail in driver.start's getStrategy on the confirmed path.
  try {
    getStrategy(strategy as RoomStrategyName);
  } catch {
    return { ok: false, error: `unknown strategy "${strategy}"` };
  }
  const minds = await resolveMinds();
  const known = new Set(minds.map((m) => m.slug));
  const missing = deduped.filter((s) => !known.has(s));
  if (missing.length > 0) {
    return {
      ok: false,
      error: `unknown Mind(s): ${missing.join(", ")} — genesis them first or check the roster`,
    };
  }
  // group-chat needs a moderator Mind that routes but never speaks: it must be a
  // real Mind and NOT in the speaker pool (so isValidNominee rejects nominating it
  // and the board never counts it as a speaker — see docs/design/phase3-rooms.md §1).
  if (strategy === "group-chat") {
    const moderator = config.moderator;
    if (!moderator) {
      return { ok: false, error: "group-chat needs a moderator Mind — set `moderator`" };
    }
    if (!isValidParticipant(moderator)) {
      return { ok: false, error: "moderator must be a safe Mind slug (not director/system)" };
    }
    if (!known.has(moderator)) {
      return {
        ok: false,
        error: `unknown moderator Mind: ${moderator} — genesis it first or check the roster`,
      };
    }
    if (deduped.includes(moderator)) {
      return {
        ok: false,
        error: "the moderator must not also be a participant — it routes, it does not speak",
      };
    }
    if (config.synthesizer) {
      // Same safe/reserved-slug guard as the moderator: a synthesizer authors a
      // role:"agent" turn, so it must never be a reserved authority (director/system).
      if (!isValidParticipant(config.synthesizer)) {
        return { ok: false, error: "synthesizer must be a safe Mind slug (not director/system)" };
      }
      if (!known.has(config.synthesizer)) {
        return { ok: false, error: `unknown synthesizer Mind: ${config.synthesizer}` };
      }
      if (deduped.includes(config.synthesizer)) {
        return {
          ok: false,
          error:
            "the synthesizer must not also be a participant — it writes the closing summary, it does not debate",
        };
      }
      if (config.synthesizer === moderator) {
        return {
          ok: false,
          error: "the synthesizer must not also be the moderator — they are distinct roles",
        };
      }
    }
    const knobError = routingKnobError(config);
    if (knobError) return { ok: false, error: knobError };
    const roomConfig: RoomConfig = {
      moderator,
      ...(config.synthesizer ? { synthesizer: config.synthesizer } : {}),
      ...(typeof config.minRounds === "number" ? { minRounds: config.minRounds } : {}),
      ...(typeof config.maxSpeakerRepeats === "number"
        ? { maxSpeakerRepeats: config.maxSpeakerRepeats }
        : {}),
    };
    return { ok: true, participants: deduped, config: roomConfig };
  }
  // open-floor is unmoderated: every speaker nominates the next and the room closes
  // by an end-vote. Same routing-knob floors as group-chat, plus the end-vote
  // threshold (a (0,1) fraction; the close gate is a strict `>` against it).
  if (strategy === "open-floor") {
    // open-floor has no routing Mind: speakers nominate each other and vote to
    // close. Reject a moderator/synthesizer rather than silently dropping it, so an
    // operator who reused a group-chat payload sees why the field had no effect.
    if (config.moderator) {
      return {
        ok: false,
        error: "open-floor has no moderator — every speaker nominates the next",
      };
    }
    if (config.synthesizer) {
      return { ok: false, error: "open-floor has no closing synthesizer — drop `synthesizer`" };
    }
    const knobError = routingKnobError(config);
    if (knobError) return { ok: false, error: knobError };
    if (
      config.endVoteThreshold !== undefined &&
      (!Number.isFinite(config.endVoteThreshold) ||
        config.endVoteThreshold <= 0 ||
        config.endVoteThreshold >= 1)
    ) {
      return { ok: false, error: "endVoteThreshold must be a number in (0,1)" };
    }
    const roomConfig: RoomConfig = {
      ...(typeof config.minRounds === "number" ? { minRounds: config.minRounds } : {}),
      ...(typeof config.maxSpeakerRepeats === "number"
        ? { maxSpeakerRepeats: config.maxSpeakerRepeats }
        : {}),
      endVoteThreshold: config.endVoteThreshold ?? DEFAULT_END_VOTE_THRESHOLD,
    };
    return { ok: true, participants: deduped, config: roomConfig };
  }
  // review is a two-Mind, single-pass cross-vendor critique: participants[0]
  // authors the artifact, participants[1] reviews it. Roles are positional, so it
  // needs no routing Mind and no config — but it DOES require the two Minds to run
  // on different providers (the whole point), so a same-vendor or unpinned pair is
  // rejected here rather than running a pointless same-model review.
  if (strategy === "review") {
    if (deduped.length !== 2) {
      return {
        ok: false,
        error: "review needs exactly 2 participants: the author, then the reviewer",
      };
    }
    if (turnBudget < 2) {
      return {
        ok: false,
        error: "review needs a turnBudget of at least 2 (one author turn, one review turn)",
      };
    }
    if (config.moderator) {
      return {
        ok: false,
        error: "review has no moderator — the reviewer critiques the author's artifact directly",
      };
    }
    if (config.synthesizer) {
      return { ok: false, error: "review has no synthesizer — the reviewer's turn is the close" };
    }
    const authorSlug = deduped[0];
    const reviewerSlug = deduped[1];
    if (authorSlug === undefined || reviewerSlug === undefined) {
      return {
        ok: false,
        error: "review needs exactly 2 participants: the author, then the reviewer",
      };
    }
    const bySlug = new Map(minds.map((m) => [m.slug, m]));
    const authorProvider = bySlug.get(authorSlug)?.provider;
    const reviewerProvider = bySlug.get(reviewerSlug)?.provider;
    if (!authorProvider || !reviewerProvider) {
      return {
        ok: false,
        error:
          "review must be cross-vendor: pin a provider on both the author and the reviewer Mind, set to different providers",
      };
    }
    if (authorProvider === reviewerProvider) {
      return {
        ok: false,
        error: `review must be cross-vendor: ${authorSlug} and ${reviewerSlug} both use "${authorProvider}" — pin them to different providers`,
      };
    }
    return { ok: true, participants: deduped };
  }
  return { ok: true, participants: deduped };
}

// Open a fresh-slug room and kick its auto-advance loop. The shared core behind
// both the board's room-start action and the chamber_room_start chat tool, so
// validation, the single-active reservation, and the fresh-slug discipline live
// in one place. Each start opens a brand-new room under a unique slug: the CLI
// MVP can't cancel an in-flight turn, so a turn still draining from a stopped
// room must land in its own old dir, never a reused one. Past closed rooms remain
// as bounded history under rooms/ via the retention sweep.
async function startRoom(
  input: {
    participants: readonly string[];
    turnBudget: number;
    name?: string;
    strategy?: string;
    topic?: string;
  } & RoomConfigInput,
): Promise<RibActionResult> {
  // Refuse once disposed: driver.start() doesn't check, so without this a start
  // after dispose() would write an "active" room whose loop never runs (ensureLoop
  // bails on isDisposed) — a phantom room nothing ever clears.
  if (!driver || driver.isDisposed()) return ROOM_DISABLED;
  const strategy = ((input.strategy ?? "").trim() || "sequential") as RoomStrategyName;
  const valid = await validateStart(input.participants, input.turnBudget, strategy, {
    moderator: input.moderator,
    minRounds: input.minRounds,
    synthesizer: input.synthesizer,
    maxSpeakerRepeats: input.maxSpeakerRepeats,
    endVoteThreshold: input.endVoteThreshold,
  });
  if (!valid.ok) return { ok: false, error: valid.error };
  const name = (input.name ?? "").trim() || "Room";
  // Normalize here so both entry points (the chat tool and the board action)
  // store a trimmed topic or none — a whitespace-only topic becomes no topic.
  const topic = (input.topic ?? "").trim();
  const slug = freshRoomSlug();
  const activeDriver = driver;
  try {
    // driver.start reserves the single active slot synchronously (before any
    // await), so concurrent starts can't both pass — the second rejects here.
    await activeDriver.start({
      slug,
      name,
      strategy,
      participants: valid.participants,
      turnBudget: input.turnBudget,
      ...(topic ? { topic } : {}),
      ...(valid.config ? { config: valid.config } : {}),
    });
    activeSlug = slug;
    lastSlug = slug;
    ensureLoop(slug);
    return { ok: true, data: { slug } };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

// Inject director overrides into a room: a direction for the next speaker, a
// nominated next speaker, and/or a director message. Shared by the board's
// room-inject action and the chamber_room_say chat tool.
async function injectRoom(
  slug: string,
  input: { directionInjection?: string; nextSpeaker?: string; text?: string },
): Promise<RibActionResult> {
  if (!driver) return ROOM_DISABLED;
  if (!isSafeSlug(slug)) return { ok: false, error: `unsafe room slug: ${JSON.stringify(slug)}` };
  try {
    const applied = await driver.inject(slug, {
      ...(input.directionInjection ? { directionInjection: input.directionInjection } : {}),
      ...(input.nextSpeaker ? { nextSpeaker: input.nextSpeaker } : {}),
      ...(input.text ? { text: input.text } : {}),
    });
    // driver.inject silently no-ops on a room that is no longer active; surface
    // that as a failure so a chat tool can't claim a dropped steer landed.
    if (!applied) return { ok: false, error: "the room is no longer active" };
    return { ok: true, data: { slug } };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

// Stop a room and drop it as the active target. Shared by the board's room-stop
// action and the chamber_room_stop chat tool.
async function stopRoom(slug: string): Promise<RibActionResult> {
  if (!driver) return ROOM_DISABLED;
  if (!isSafeSlug(slug)) return { ok: false, error: `unsafe room slug: ${JSON.stringify(slug)}` };
  try {
    await driver.stop(slug);
    if (activeSlug === slug) activeSlug = undefined;
    return { ok: true, data: { slug } };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

function roomStartAction(action: RibAction): Promise<RibActionResult> {
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  // Routing config arrives as flat payload keys — a board action's collected
  // `fields` (base #120) merge in flat, so `moderator`/`endVoteThreshold` etc. are
  // plain keys, not nested. roomConfigFromFlat owns that flat-key contract.
  return startRoom({
    participants: asStringArray(payload.participants),
    turnBudget: typeof payload.turnBudget === "number" ? payload.turnBudget : 0,
    name: asNonEmptyString(payload.name) || undefined,
    strategy: asNonEmptyString(payload.strategy) || undefined,
    topic: asNonEmptyString(payload.topic) || undefined,
    ...roomConfigFromFlat(payload),
  });
}

async function roomInjectAction(action: RibAction): Promise<RibActionResult> {
  const resolved = requireRoomSlug(action);
  if ("error" in resolved) return resolved.error;
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  return injectRoom(resolved.slug, {
    directionInjection: asNonEmptyString(payload.directionInjection) || undefined,
    nextSpeaker: asNonEmptyString(payload.nextSpeaker) || undefined,
    text: asNonEmptyString(payload.text) || undefined,
  });
}

async function roomStopAction(action: RibAction): Promise<RibActionResult> {
  const resolved = requireRoomSlug(action);
  if ("error" in resolved) return resolved.error;
  return stopRoom(resolved.slug);
}

// Resolve the target room slug for a control. With server-assigned slugs there
// is no default: a payload-less call (a stale/static button or an API client
// that forgot the slug) must fail closed rather than hit a legacy `room` dir.
function requireRoomSlug(action: RibAction): { slug: string } | { error: RibActionResult } {
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  const slug = asNonEmptyString(payload.slug);
  if (!slug) return { error: { ok: false, error: "this room control requires payload { slug }" } };
  if (!isSafeSlug(slug)) {
    return { error: { ok: false, error: `unsafe room slug: ${JSON.stringify(slug)}` } };
  }
  return { slug };
}

// A unique, path-safe room slug per start (timestamp + counter), so every room
// gets its own rooms/<slug>/ dir and a late turn from a prior room can't bleed
// into a new one. Matches SAFE_SLUG (lowercase alnum + hyphens).
function freshRoomSlug(): string {
  return `room-${Date.now().toString(36)}-${(roomSeq++).toString(36)}`;
}

// A room participant must be a safe slug and not a reserved authority: "director"
// and "system" are driver-stamped roles, never speakers (a room with one would
// just end on its turn — an unknown mind).
function isValidParticipant(slug: string): boolean {
  return slug !== "director" && slug !== "system" && isSafeSlug(slug);
}

// True if the slug is a bare kebab token (no traversal, non-empty). assertSafeSlug
// throws on a bad slug; this is its non-throwing predicate form.
function isSafeSlug(slug: string): boolean {
  try {
    assertSafeSlug(slug);
    return true;
  } catch {
    return false;
  }
}

// Open a mind as a seeded chat: compose its soul into a system prompt and hand
// the harness an "open-chat" directive (the generic seam the SPA interprets to
// start a fresh seeded conversation). Read-only against minds/ — resolving via
// resolveMinds() returns the unknown-mind error on a retire-then-enter race.
async function enterMindAction(action: RibAction): Promise<RibActionResult> {
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  const slug = asNonEmptyString(payload.slug);
  if (!slug) return { ok: false, error: "enter-mind requires payload { slug }" };
  try {
    const mind = (await resolveMinds()).find((m) => m.slug === slug);
    if (!mind) return { ok: false, error: `unknown Mind: ${slug}` };
    const seed = await buildSeedFor(mindsDir(), mind);
    return { ok: true, data: { effect: "open-chat", seed } };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

async function retireAction(action: RibAction): Promise<RibActionResult> {
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  const slug = asNonEmptyString(payload.slug);
  if (!slug) return { ok: false, error: "retire requires payload { slug }" };
  try {
    await retireMind(mindsDir(), slug);
    invalidateRoster(); // a Mind is gone — drop it from the cached roster
    return { ok: true, data: { slug } };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

// Tool results stream to chat as `tool_result` chunks; keep each well under the
// chat context budget. Truncation is signalled, never silent.
const MAX_TOOL_RESULT_CHARS = 16_000;
function boundedText(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  const omitted = text.length - MAX_TOOL_RESULT_CHARS;
  return `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n…(truncated — ${omitted} more chars)`;
}
function emitResult(ctx: ToolContext, content: string, isError = false): void {
  ctx.emit({ type: "tool_result", toolUseId: "", content, ...(isError ? { isError: true } : {}) });
}

// turnBudget/confirm are .optional() (not .default()) on purpose: z.toJSONSchema
// — which the Copilot provider feeds the model — lists defaulted fields as
// `required`, which would force the model to send `confirm` (defeating the
// dry-run/omit path) and `turnBudget`. Defaults are applied after parse instead.
const roomStartSchema = z.object({
  participants: z.array(z.string()).min(2),
  turnBudget: z.number().int().min(1).max(MAX_ROOM_TURN_BUDGET).optional(),
  name: z.string().optional(),
  topic: z.string().optional(),
  // Routing config. `strategy` defaults to sequential; `moderator` is required
  // (and validated) only for "group-chat"; `endVoteThreshold` tunes "open-floor"'s
  // close. All optional so a plain two-Mind room needs none of them.
  strategy: z.string().optional(),
  moderator: z.string().optional(),
  synthesizer: z.string().optional(),
  minRounds: z.number().int().min(1).optional(),
  maxSpeakerRepeats: z.number().int().min(1).optional(),
  endVoteThreshold: z.number().optional(),
  confirm: z.boolean().optional(),
});
const roomSaySchema = z
  .object({
    direction: z.string().optional(),
    callOn: z.string().optional(),
    text: z.string().optional(),
  })
  .refine((v) => Boolean(v.direction || v.callOn || v.text), {
    message: "provide at least one of: direction, callOn, text",
  });
const emptyToolSchema = z.object({});

// Render the active room + its transcript as chat-legible text. Reads through the
// same store the driver writes, so it reflects the latest committed turn.
async function renderRoomStatus(store: RoomStore): Promise<string> {
  // Capture once: the auto-advance loop can clear activeSlug between awaits. Fall
  // back to lastSlug so a just-finished/stopped room is still readable (its
  // room.json + transcript persist); the header reports the status either way.
  const slug = activeSlug ?? lastSlug;
  if (!slug) return "No Chamber room yet. Start one with chamber_room_start.";
  const room = await store.loadRoom(slug);
  if (!room) return "No Chamber room yet. Start one with chamber_room_start.";
  const transcript = await store.loadTranscript(slug);
  const head =
    `Room "${room.name}" (${slug}) — ${room.status}, turn ${room.turnIndex}/${room.turnBudget}; ` +
    `participants: ${room.participants.join(", ")}.`;
  const body = transcript.length > 0 ? renderTranscript(transcript) : "(no turns yet)";
  return boundedText(`${head}\n\n${body}`);
}

// Genesis write seam: the chamber-genesis workflow's prompt node authors the soul
// + tagline and calls this tool to persist the Mind. Deterministic and in-process
// (it reuses scaffoldMind), so the generative half stays in the prompt and the
// write half stays testable.
const genesisEmitSchema = z.object({
  name: z.string().min(1),
  role: z.string().min(1),
  voice: z.string().min(1),
  soul: z.string().min(1),
  tagline: z.string().min(1),
  // Capability slugs the Mind may invoke in a room (see CAPABILITY_TOOLS).
  // Unknown slugs are dropped at persist; omitted/empty keeps the Mind text-only.
  tools: z.array(z.string()).optional(),
});

function makeGenesisTool(): ToolDefinition {
  return {
    name: "chamber_emit_genesis",
    description:
      "Internal write-seam for the chamber-genesis workflow: persist an authored Mind (SOUL.md + record) under minds/<slug>. The workflow's prompt turn authors { soul, tagline, optional capability tools }; this tool only writes, failing closed on a slug collision. To create an agent, run the chamber-genesis workflow (e.g. /workflow run chamber-genesis <brief>) rather than calling this directly.",
    inputSchema: genesisEmitSchema,
    state_changing: true,
    async execute(input, ctx) {
      const parsed = genesisEmitSchema.safeParse(input);
      if (!parsed.success) {
        emitResult(ctx, `chamber_emit_genesis: ${parsed.error.message}`, true);
        return;
      }
      const { name, role, voice, soul, tagline, tools } = parsed.data;
      try {
        const knownTools = tools
          ? [...new Set(tools.filter((s) => KNOWN_CAPABILITY_SLUGS.has(s)))]
          : [];
        const record: MindRecord = {
          slug: slugify(name),
          name,
          role,
          voice,
          // The roster card truncates for display (with an ellipsis); store the
          // authored tagline trimmed, not hard-cut.
          persona: tagline.trim(),
          createdAt: new Date().toISOString(),
          ...(knownTools.length > 0 ? { tools: knownTools } : {}),
        };
        await scaffoldMind(mindsDir(), record, soul);
        invalidateRoster();
        emitResult(ctx, JSON.stringify({ ok: true, slug: record.slug }));
      } catch (e) {
        emitResult(ctx, `chamber_emit_genesis failed: ${errText(e)}`, true);
      }
    },
  };
}

// Lens publish seam: the chamber-lens workflow's prompt node composes a canvas
// board and calls this tool to publish it under a per-subject key. `id` routes
// re-authoring of the same subject back to the same panel; the board is validated
// fail-closed (the key's expectView guard) before it is broadcast.
const lensEmitSchema = z.object({
  id: z.string().min(1).max(64),
  board: canvasBoardViewSchema,
});

function makeLensTool(registry: LensRegistry): ToolDefinition {
  return {
    name: LENS_TOOL_NAME,
    description:
      "Author a lens: render a canvas `board` you compose onto the Chamber surface, where it shows live as its own panel with no hand-coded UI — a Mind surfacing what it sees (e.g. a findings summary after a room discussion). `id` is a short, stable kebab-case identifier for the subject (re-authoring the same id updates the same panel); `board` is the canvas board view. Call it once per lens. The chamber-lens workflow (/workflow run chamber-lens <subject>) is the standalone entry point.",
    inputSchema: lensEmitSchema,
    state_changing: true,
    async execute(input, ctx) {
      const parsed = lensEmitSchema.safeParse(input);
      if (!parsed.success) {
        emitResult(ctx, `chamber_emit_lens: ${parsed.error.message}`, true);
        return;
      }
      // Canonicalize the id into a stable routing key (the prompt asks for kebab-case,
      // but a model may send "Release Risks"). A lens-specific normalizer, NOT the
      // Mind slugifier: no 48-char cap (which would collide distinct long subjects)
      // and no synthetic fallback — an id with no usable characters is rejected.
      const id = canonicalLensId(parsed.data.id);
      if (!id) {
        emitResult(ctx, "chamber_emit_lens: id has no usable characters", true);
        return;
      }
      try {
        const { key } = await registry.publish(id, parsed.data.board);
        emitResult(ctx, JSON.stringify({ ok: true, key }));
      } catch (e) {
        emitResult(ctx, `chamber_emit_lens failed: ${errText(e)}`, true);
      }
    },
  };
}

// The room controls as chat tools — the second `step()` consumer the StepOutcome
// soundness (#10/#13) was built for. Fire-and-return: start kicks the existing
// auto-advance loop; status reads progress; say/stop steer the single active room
// (its slug resolved from module state, since the server assigns it). start
// self-gates on an in-tool `confirm` flag because each turn is a paid agent call
// (keelson chat has no pause-and-confirm gate yet — the OSDU lifecycle pattern).
function roomControlTools(store: RoomStore): ToolDefinition[] {
  return [
    {
      name: "chamber_room_status",
      description:
        'Use when the user asks what is happening in the Chamber room — "what are they saying", "show the room", "room status". Returns the active room\'s participants, status, turn count, and the conversation so far. Read-only. NOT for starting or stopping a room.',
      inputSchema: emptyToolSchema,
      state_changing: false,
      async execute(_input, ctx) {
        try {
          emitResult(ctx, await renderRoomStatus(store));
        } catch (e) {
          emitResult(ctx, `chamber_room_status failed: ${errText(e)}`, true);
        }
      },
    },
    {
      name: "chamber_room_start",
      description:
        'Open a Chamber room where the named agent Minds converse turn-by-turn (turnBudget paid agent turns total, default 8). Provide a `topic` to frame the discussion — strongly recommended, since it is what the first speaker responds to. For a moderated discussion set strategy:"group-chat" and a `moderator` Mind slug (a Mind NOT among participants — it routes who speaks and decides when to close); optional `synthesizer` authors a closing summary. For a cross-vendor review set strategy:"review" with exactly two participants pinned to different providers — the first authors an artifact, the second (a different vendor) reviews it. State-changing: set confirm:true ONLY after the user has approved — without confirm the tool reports what it would start and runs nothing. participants are Mind slugs (see the Roster); needs at least two. Rejected if a room is already active — stop it first. NOT for creating a Mind (that is the New agent / genesis action).',
      inputSchema: roomStartSchema,
      state_changing: true,
      requires_confirmation: true,
      async execute(input, ctx) {
        const parsed = roomStartSchema.safeParse(input);
        if (!parsed.success) {
          emitResult(ctx, `chamber_room_start: ${parsed.error.message}`, true);
          return;
        }
        const { participants, name } = parsed.data;
        const topic = (parsed.data.topic ?? "").trim() || undefined;
        const turnBudget = parsed.data.turnBudget ?? DEFAULT_ROOM_TURN_BUDGET;
        const confirm = parsed.data.confirm ?? false;
        const moderator = (parsed.data.moderator ?? "").trim() || undefined;
        // A `moderator` with no explicit strategy means a moderated room — infer
        // group-chat so validateStart enforces its rules and the dry-run label below
        // matches what actually starts (an explicit strategy still wins).
        const strategy =
          (parsed.data.strategy ?? "").trim() || (moderator ? "group-chat" : "sequential");
        const synthesizer = (parsed.data.synthesizer ?? "").trim() || undefined;
        const minRounds = parsed.data.minRounds;
        const maxSpeakerRepeats = parsed.data.maxSpeakerRepeats;
        const endVoteThreshold = parsed.data.endVoteThreshold;
        // Validate up front (including roster membership + group-chat moderator
        // rules) so the dry-run never advertises a start the confirm path rejects.
        const valid = await validateStart(participants, turnBudget, strategy, {
          moderator,
          synthesizer,
          minRounds,
          maxSpeakerRepeats,
          endVoteThreshold,
        });
        if (!valid.ok) {
          emitResult(ctx, `chamber_room_start: ${valid.error}`, true);
          return;
        }
        // A room is already active: both the dry-run and the confirmed start would
        // fail driver.start's single-active reservation, so reject before prompting.
        if (activeSlug) {
          emitResult(
            ctx,
            "chamber_room_start: a room is already active — stop it first with chamber_room_stop.",
            true,
          );
          return;
        }
        const who = valid.participants.join(", ");
        const topicNote = topic ? ` on "${topic}"` : " (no topic set)";
        const modeNote =
          strategy === "group-chat" && moderator
            ? ` (group-chat, moderated by ${moderator})`
            : strategy === "review"
              ? ` (review: ${valid.participants[0]} reviewed by ${valid.participants[1]})`
              : "";
        if (!confirm) {
          emitResult(
            ctx,
            `Would open a room with ${who}${topicNote}${modeNote} for ${turnBudget} turns (each turn is a paid agent call). Re-call chamber_room_start with confirm:true once the user approves.`,
          );
          return;
        }
        // A user abort during the awaits above must not still open a paid room.
        if (ctx.abortSignal.aborted) return;
        const res = await startRoom({
          participants,
          turnBudget,
          name,
          topic,
          strategy,
          moderator,
          synthesizer,
          minRounds,
          maxSpeakerRepeats,
          endVoteThreshold,
        });
        if (res.ok) {
          const slug = (res.data as { slug?: string } | undefined)?.slug ?? "";
          emitResult(
            ctx,
            `Opened room "${slug}" with ${who}. It auto-advances — watch the Chamber surface or call chamber_room_status to read progress.`,
          );
        } else {
          emitResult(ctx, `chamber_room_start failed: ${res.error}`, true);
        }
      },
    },
    {
      name: "chamber_room_say",
      description:
        'Steer the active Chamber room: `direction` sets guidance for the next speaker, `callOn` nominates a specific Mind to go next, `text` drops a director message into the transcript. Use when the user wants to nudge the conversation ("tell them to wrap up", "let Alice answer"). At least one field required. NOT for starting or stopping the room.',
      inputSchema: roomSaySchema,
      state_changing: true,
      async execute(input, ctx) {
        const parsed = roomSaySchema.safeParse(input);
        if (!parsed.success) {
          emitResult(ctx, `chamber_room_say: ${parsed.error.message}`, true);
          return;
        }
        const slug = activeSlug;
        if (!slug) {
          emitResult(
            ctx,
            "No active Chamber room to steer. Start one with chamber_room_start.",
            true,
          );
          return;
        }
        const { direction, callOn, text } = parsed.data;
        // The driver only honors nextSpeaker when it exactly matches an active
        // participant slug — otherwise step() silently drops it and falls back to
        // the strategy. Reject up front so the tool can't report a dropped
        // nomination ("Alice" vs "alice", a typo, a non-participant) as sent.
        if (callOn) {
          const room = await store.loadRoom(slug);
          if (!room?.participants.includes(callOn)) {
            emitResult(
              ctx,
              `chamber_room_say: "${callOn}" is not a participant — call on one of the room's Minds.`,
              true,
            );
            return;
          }
        }
        // injectRoom does the truthiness filtering; pass the fields straight through.
        const res = await injectRoom(slug, {
          directionInjection: direction,
          nextSpeaker: callOn,
          text,
        });
        emitResult(
          ctx,
          res.ok ? "Sent to the room." : `chamber_room_say failed: ${res.error}`,
          !res.ok,
        );
      },
    },
    {
      name: "chamber_room_stop",
      description:
        'Stop the active Chamber room (halts its turns). Use when the user says "stop the room", "end it". Reversible — a new room can be started afterward. NOT for retiring a Mind.',
      inputSchema: emptyToolSchema,
      state_changing: true,
      async execute(_input, ctx) {
        const slug = activeSlug;
        if (!slug) {
          emitResult(ctx, "No active Chamber room to stop.", true);
          return;
        }
        const res = await stopRoom(slug);
        emitResult(
          ctx,
          res.ok ? "Stopped the room." : `chamber_room_stop failed: ${res.error}`,
          !res.ok,
        );
      },
    },
  ];
}

export default rib;
