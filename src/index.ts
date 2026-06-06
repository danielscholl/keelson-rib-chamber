import { fileURLToPath } from "node:url";
import type { CanvasView, Rib, RibAction, RibActionResult, RibContext } from "@keelson/shared";
import { canvasViewSchema } from "@keelson/shared";
import { buildGenesisPrompt, type GenesisAuthor, parseGenesisOutput, slugify } from "./genesis.ts";
import { type MindRecord, mindExists, retireMind, scaffoldMind } from "./minds-store.ts";
import { mindsDir } from "./paths.ts";

const BRIEF_KEY = "rib:chamber:brief";
const ROSTER_KEY = "rib:chamber:roster";

// Absolute path to the roster collector, resolved at module load so the workflow
// node runs the right file regardless of the run's (nominal) cwd. fileURLToPath
// (not URL.pathname) decodes %20 etc. so an install path with a space resolves;
// it is shell-quoted where interpolated into the bash node below.
const ROSTER_COLLECTOR = fileURLToPath(new URL("../bin/collect-roster.ts", import.meta.url));

// The coding-agent CLI genesis shells to author a soul. MVP only: it uses the
// CLI's ambient auth, so it ignores KEELSON_WORKFLOW_PROVIDER until C1's
// provider-routed runAgentTurn lands. Override the bin for non-claude setups.
const AGENT_BIN = process.env.CHAMBER_AGENT_BIN?.trim() || "claude";
const GENESIS_TIMEOUT_MS = 120_000;

// Validate through the canvas view union (not a bare member schema) so the
// producer-side guard enforces the same node-id / column-key uniqueness checks
// the SPA render gate runs — before a frame is ever broadcast. Mirrors the OSDU
// rib's expectView.
function expectView(key: string, kind: CanvasView["view"]) {
  return (data: unknown): CanvasView => {
    const view = canvasViewSchema.parse(data);
    if (view.view !== kind) throw new Error(`${key} expects a ${kind} view, got "${view.view}"`);
    return view;
  };
}

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

const rib: Rib = {
  id: "chamber",
  displayName: "Chamber",

  // Binds the agent-authored keys to the canvas renderer; the buttons appear on
  // the Ribs page and data arrives when the producers run.
  views: [
    { key: ROSTER_KEY, canvasKind: "view", title: "Roster" },
    { key: BRIEF_KEY, canvasKind: "view", title: "Briefing" },
  ],

  // The "new agent" / "retire" affordances on the Chamber surface dispatch to
  // onAction. The room controls (room-start/next/inject/stop) arrive in Phase 2.
  actions: [
    { type: "genesis", label: "New agent" },
    { type: "retire", label: "Retire agent" },
  ],

  // The Chamber nav tab. Phase 1 lands the roster in the header (the Minds you
  // genesis) and settles the brief into the footer; the room transcript fills
  // the rows in Phase 2.
  surfaces: [
    {
      id: "chamber",
      title: "Chamber",
      layout: {
        header: {
          key: ROSTER_KEY,
          workflow: "chamber-roster",
          title: "Roster",
          glyph: { char: "◇", tone: "brand" },
        },
        rows: [],
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
          'Use when: you want to see the agents (Minds) that have been created. Triggers: "show the roster", "list agents", "what minds exist". Does: reads the genesis-authored Minds from the Chamber data home and publishes a roster board (one card per Mind) to the Chamber Roster canvas. NOT for: creating or retiring agents (those are the New agent / Retire actions).',
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
  ],

  // Genesis a Mind (one agent turn authors its soul, the rib persists it) and
  // retire one. Both mutate the data home and return; the roster reflects the
  // change on the next chamber-roster refresh (the OSDU mutate-then-refresh
  // pattern). The room-* controls arrive with the Phase 2 room loop.
  onAction: (action, ctx) => {
    if (action.type === "genesis") return genesisAction(action, ctx);
    if (action.type === "retire") return retireAction(action);
    return { ok: false, error: `unknown action '${action.type}'` };
  },
};

// Shell the coding-agent CLI for one authoring turn. Isolated behind the
// GenesisAuthor seam so genesis.ts stays provider-free; collapses to
// ctx.runAgentTurn once C1 lands. `--output-format json` wraps the reply as
// `{ result }`; the inner text is the GenesisDocs JSON parseGenesisOutput reads.
function makeAuthor(ctx: RibContext): GenesisAuthor {
  return async (prompt) => {
    const res = await ctx
      .getExec()
      .runJSON<{ result?: string }>(AGENT_BIN, ["-p", prompt, "--output-format", "json"], {
        timeoutMs: GENESIS_TIMEOUT_MS,
      });
    if (!res.ok) throw new Error(res.error);
    const text = res.data?.result;
    if (typeof text !== "string" || text.trim().length === 0) {
      throw new Error(`${AGENT_BIN} returned no text`);
    }
    return text;
  };
}

async function genesisAction(action: RibAction, ctx: RibContext): Promise<RibActionResult> {
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  const name = asNonEmptyString(payload.name);
  const role = asNonEmptyString(payload.role);
  const voice = asNonEmptyString(payload.voice);
  if (!name || !role || !voice) {
    return { ok: false, error: "genesis requires payload { name, role, voice }" };
  }
  const slug = slugify(name); // always non-empty (falls back for non-Latin names)
  const model = asNonEmptyString(payload.model);
  const tools = asStringArray(payload.tools);
  try {
    // Fail a known collision before the ~120s (paid) authoring turn, not after.
    if (await mindExists(mindsDir(), slug)) {
      return { ok: false, error: `mind '${slug}' already exists` };
    }
    const raw = await makeAuthor(ctx)(buildGenesisPrompt({ name, role, voice }));
    const docs = parseGenesisOutput(raw);
    const record: MindRecord = {
      slug,
      name,
      role,
      voice,
      persona: docs.tagline,
      ...(model ? { model } : {}),
      ...(tools.length > 0 ? { tools } : {}),
      createdAt: new Date().toISOString(),
    };
    await scaffoldMind(mindsDir(), record, docs.soul);
    return { ok: true, data: { slug } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function retireAction(action: RibAction): Promise<RibActionResult> {
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  const slug = asNonEmptyString(payload.slug);
  if (!slug) return { ok: false, error: "retire requires payload { slug }" };
  try {
    await retireMind(mindsDir(), slug);
    return { ok: true, data: { slug } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function asNonEmptyString(v: unknown): string {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : "";
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export default rib;
