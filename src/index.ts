import type { CanvasView, Rib } from "@keelson/shared";
import { canvasViewSchema } from "@keelson/shared";

const BRIEF_KEY = "rib:chamber:brief";

// Validate through the canvas view union (not a bare member schema) so the
// producer-side guard enforces the same node-id / column-key uniqueness checks
// the SPA render gate runs — before a frame is ever broadcast. Mirrors the OSDU
// rib's expectView.
function expectView(key: string, kind: CanvasView["view"]) {
  return (data: unknown): CanvasView => {
    const view = canvasViewSchema.parse(data);
    if (view.view !== kind) throw new Error(`${key} expects a ${kind} view`);
    return view;
  };
}

// Appended to the prompt as the structured-output directive (the prompt handler
// adds "respond with ONLY single-line JSON matching this schema"), which also
// flips the node to a structured producer so the bound-key publish bridge sees a
// value, not raw text. The authoritative contract is the prompt body + the
// canvas `validate` on the bound key below.
const BRIEF_OUTPUT_FORMAT = {
  type: "object",
  required: ["view", "sections"],
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

  // Binds the agent-authored briefing key to the canvas renderer; the button
  // appears on the Ribs page and data arrives when chamber-brief runs.
  views: [{ key: BRIEF_KEY, canvasKind: "view", title: "Briefing" }],

  // The Chamber nav tab. Phase 0 lays it out around the one board that exists;
  // genesis/roster (header) and the room transcript (rows) fill in per the phase
  // plan, with the brief settling into the footer.
  surfaces: [
    {
      id: "chamber",
      title: "Chamber",
      layout: {
        rows: [
          {
            columns: [
              {
                key: BRIEF_KEY,
                workflow: "chamber-brief",
                title: "Briefing",
                glyph: { char: "❖", tone: "brand" },
              },
            ],
          },
        ],
      },
    },
  ],

  // The producer: an agent turn (not a deterministic collector) emits the board,
  // which the executor promotes to structured output and the rib binding
  // publishes fail-closed via `validate`. This is the "an agent authors a lens"
  // proof — zero React, no hand-coded route.
  contributeWorkflows: () => [
    {
      definition: {
        name: "chamber-brief",
        description:
          'Use when: you want a one-screen briefing of the Chamber multi-agent layer. Triggers: "chamber briefing", "what is chamber doing", "show the chamber brief". Does: runs one agent turn that authors a canvas board (an operator briefing — status pulse, KPI stats, what\'s live / next, explanatory cards) and publishes it to the Chamber Briefing canvas. NOT for: genesis-ing agents or running a room.',
        nodes: [
          {
            id: "compose",
            prompt: BRIEF_PROMPT,
            output_format: BRIEF_OUTPUT_FORMAT,
            output_schema: { type: "object", required: ["view", "sections"] },
            allowed_tools: [],
          },
        ],
      },
      bindSnapshotKey: BRIEF_KEY,
      validate: expectView(BRIEF_KEY, "board"),
    },
  ],
};

export default rib;
