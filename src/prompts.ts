import { buildCanvasArtifactGuidance } from "@keelson/shared";
import { buildBoardCompositionGuidance } from "./board-guidance.ts";
import { capabilityVocabulary } from "./capabilities.ts";

// The briefing turn's prompt: an agent authors a canvas `board` rendered on the
// Chamber surface with no hand-coded UI. The gate appends a delta block (the rooms
// that ended / lenses that changed since the last briefing) so the briefing reports
// what is NEW — a count is not news. Tools are withheld so it composes from this.
export const BRIEF_PROMPT = `You are the editor of "Chamber" — Keelson's multi-agent operating layer (Minds you author, agent-to-agent Rooms, agent-authored Lenses). Compose a short operator BRIEFING of what is NEW since the operator last looked, and return it as a single canvas \`board\` view rendered directly on the Chamber surface with no hand-coded UI.

Lead with the change: a Room that ended and what it settled, a Lens a Mind authored or updated and what it now says. Be honest — write only what the delta below names; do NOT invent clusters, users, metrics, or a room's contents you cannot see, and do NOT restate how many Minds / Rooms / Lenses exist (the surface already shows those structurally — a count is not news).

Return ONE JSON object of this shape:
  { "view": "board", "title": string, "header"?: { "status"?: { "label": string, "tone"?: Tone } }, "sections": Section[] }
Tone is one of: ok, warn, error, neutral, info, caution, brand, accent.
Use 1-2 Section kinds, in a sensible order:
  - rows:  { "kind": "rows", "title"?: string, "items": [{ "text": string, "glyph"?: Tone, "trailing"?: string }] }
  - cards: { "kind": "cards", "title"?: string, "items": [{ "title": string, "pill"?: { "label": string, "tone"?: Tone }, "fields"?: [{ "label"?: string, "value": string|number }], "footnote"?: string }] }

Keep it tight: a status pill naming how much is new (e.g. "2 new"), then a short "rows" list — one line per ended Room or changed Lens, in the operator's language, with the outcome or gist. Add a card only when one change earns a sentence of interpretation. Concise, editorial copy.`;

// Genesis as a workflow: one agent turn reads a freeform brief, authors the SOUL.md
// body + a roster tagline, and persists the Mind by calling the chamber_emit_genesis
// tool (the deterministic write seam). It publishes no snapshot — its product is files
// on disk, which the chamber-roster collector then reflects. $ARGUMENTS carries the
// brief (chat `/workflow run chamber-genesis <brief>`); explicit $inputs.* are honored
// when a caller supplies them (CLI --inputs). The model is scoped to the one emit tool.
export const GENESIS_WF_PROMPT = `You are authoring the founding identity of a new persistent agent — a "Mind" — for Keelson's Chamber, a multi-agent operating layer.

Brief: $ARGUMENTS

(If these explicit fields are non-empty, prefer them over the brief — name: "$inputs.name", role: "$inputs.role", voice: "$inputs.voice", model: "$inputs.model", provider: "$inputs.provider". When model/provider are non-empty, pass them through verbatim — do not author or guess them.)

genesisId: "$inputs.genesisId" — an opaque run id, not part of the Mind's identity. When it is non-empty, pass it to the tool EXACTLY as given; never author, alter, or invent one, and omit it entirely when it is empty.

From the brief, decide the Mind's name, a short role title (1-4 words — e.g. "Chief of Staff", "Research Partner" — a label for a roster pill, NOT a sentence or description), and voice (how it speaks). Then write an honest founding document — do NOT invent tools, credentials, or capabilities it does not have; describe who it is, what it is for, and how it speaks.

Compose:
- soul: Markdown for the Mind's SOUL.md, with these sections in order:
    # <name>
    ## Persona  — who this Mind is, grounded in the role
    ## Mission  — what it exists to do
    ## Voice    — how it speaks (tone, length, habits)
- mission: 2 to 4 short declarative sentences for the Mind's seat card, under 200 characters total — verb-led behaviors in the Mind's own voice, never a role restatement (e.g. "Reads the telemetry. Names tradeoffs. Pushes back with evidence."). No Markdown.
- tagline: one line, at most 120 characters, summarizing the Mind for a roster card (no Markdown).
- tools: an OPTIONAL array of capability slugs the Mind may use inside a room — choose ONLY from this set: ${capabilityVocabulary()}. Include a slug only when the role genuinely calls for it; omit it (or use []) for a conversation-only Mind, and never invent a slug outside this set.

Then call the chamber_emit_genesis tool EXACTLY ONCE with { name, role, voice, soul, mission, tagline, tools, model?, provider?, genesisId? } to persist the Mind (include model/provider/genesisId only when provided) — do NOT print the JSON as your reply. After the tool returns, reply with EXACTLY one line: "Authored <name> (<slug>)", using the name you authored and the tool-returned slug verbatim.`;

// The lens authoring prompt: one agent turn composes a canvas board on a subject and
// calls chamber_emit_lens to publish it. It is not pinned to one key — the tool routes
// by `id` to a per-subject key, so distinct subjects land in distinct panels and
// re-authoring a subject updates it.
export const LENS_WF_PROMPT = `You are authoring a LENS for Keelson's Chamber — a one-screen canvas \`board\` view on a subject, rendered live on the Chamber surface with no hand-coded UI.

Subject: $ARGUMENTS

Compose ONE canvas board about the subject. Be honest — do NOT invent data you cannot see; if the subject is abstract, lay out its structure, parts, or status rather than fabricating metrics.

The board shape:
  { "view": "board", "title": string, "header"?: { "status"?: { "label": string, "tone"?: Tone } }, "sections": Section[] }
Tone is one of: ok, warn, error, neutral, info, caution, brand, accent. The chamber_emit_lens input schema carries every section kind's exact fields — read it there rather than guessing.

${buildBoardCompositionGuidance()}

Use as many sections as the subject earns and no more — typically 2-4.

Then call the chamber_emit_lens tool EXACTLY ONCE with { id, board, scope?, reason? }:
  - id: a short, stable, kebab-case identifier for this subject (e.g. "release-risks") — re-authoring the same subject reuses its panel.
  - board: the canvas board object above.
  - scope (optional): the board's kind in a word or two — e.g. "status board", "timeline", "checklist".
  - reason (optional): a short note on what this authoring changed (e.g. "added two new risks") — omit it on a first author.
Supply scope/reason only when you can name them truthfully; never invent provenance. Do NOT print the JSON as your reply. After the tool returns, reply with one short line naming the lens you authored.`;

// The generic re-author behind a living lens's refresh cadence: the panel's
// region runs this with input `lens` = the record id; the turn reads the
// current record and re-emits fresh content under the same id. A lens whose
// re-composition needs specific data-gathering names its own workflow instead.
export const LENS_REFRESH_WF_PROMPT = `You are REFRESHING an existing LENS for Keelson's Chamber — re-composing a standing canvas \`board\` view so its content is current.

Lens id: $inputs.lens

First call chamber_list_lenses with { "id": "$inputs.lens" } — the matching record carries the prior board, the composition you are refreshing. If no such lens exists, reply with one short line saying so and STOP; do not author a new lens.

Re-compose the SAME subject with fresh eyes: keep the board's shape and intent, update what changed, drop what no longer holds. Be honest — do NOT invent data you cannot see; if nothing changed, re-emit the board as it stands.

Then call the chamber_emit_lens tool EXACTLY ONCE with { id, board, scope?, maintainingMind?, reason? }:
  - id: the SAME id — this updates the existing panel.
  - set reason to a short note on what this refresh changed (e.g. "no change" or "two loops closed").
  - do NOT pass scope, maintainingMind, or refresh — omitting them keeps the lens's existing provenance and backing.
Do NOT print the JSON as your reply. After the tool returns, reply with one short line on what the refresh changed.`;

// The HTML lens authoring prompt: one agent turn composes a designed,
// self-contained HTML page on a subject and emits it via chamber_emit_lens_html.
// The design contract is the shared canvas guidance (tokens, frame rules, chart
// rules) rather than chamber-local prose, so the page reads as part of keelson.
export const HTML_LENS_WF_PROMPT = `You are authoring an HTML LENS for Keelson's Chamber — ONE designed, self-contained HTML page on a subject, rendered live in a sandboxed iframe on the Chamber surface with no hand-coded UI.

Subject: $ARGUMENTS

${buildCanvasArtifactGuidance()}

(In this run canvas_publish and canvas_design_guide are NOT available — the guidance above is the full contract; publish with the chamber_emit_lens_html tool instead.)

Compose ONE page about the subject. Be honest — do NOT invent data you cannot see; if the subject is abstract, lay out its structure, parts, or status rather than fabricating metrics.

Then call the chamber_emit_lens_html tool with { html, id, title? }:
  - html: the complete self-contained page markup (inline all CSS/JS; theme through the token block above; the host supplies the document shell).
  - id: a short, stable, kebab-case identifier for this subject (e.g. "release-risks") — re-emitting the same id updates the same panel.
  - title (optional): a short human title for the panel head.
If the tool rejects the emit (a failing palette report or a blocked external script/stylesheet), fix the markup or colors it names and call the tool again — do not drop the palette declaration to dodge the check. Do NOT print the HTML as your reply. After the tool returns, reply with one short line naming the lens you authored.`;

// The standing-digest authoring prompt: one agent turn synthesizes the Chamber's
// current shape into a canvas board and calls chamber_emit_digest to persist it. No
// $ARGUMENTS — the digest is scheduler-driven, so the gate hands it the live state via
// $gate.output.summary. Distinct from the Briefing (the delta banner): this is a
// standing synthesis of what IS, not what just changed.
export const DIGEST_WF_PROMPT = `You are authoring the standing DIGEST for Keelson's Chamber — a multi-agent operating layer (Minds you author, agent-to-agent Rooms, agent-authored Lenses). The digest is a one-screen canvas \`board\` view that tells an operator what the bench's work ADDS UP TO, rendered live on the Chamber surface with no hand-coded UI. It re-composes only when the Chamber changes, so write an honest SYNTHESIS of the state below — NOT a changelog of what just happened (the Briefing covers deltas), and NOT a restatement of how many Minds / Rooms / Lenses exist (the surface shows those structurally — a count is not a synthesis).

Current Chamber state:
$gate.output.summary

Compose ONE canvas board that INTERPRETS this state: what is this team working on, what has it produced, what is the one thing worth noticing. Be honest: name only what is in the state above; do NOT invent Minds, rooms, lenses, users, or metrics you cannot see. If the Chamber is sparse, keep the digest to a sentence or two rather than padding it to fill sections.

Report what IS, never what WILL BE. Do not write about the bench's potential or readiness, about what a future room or lens would mean, or about what is "waiting" to happen — a standing synthesis describes the state in front of you, not the one you expect next. If the state shows little, say little, plainly, in the operator's language. Plainness is correct; reaching for atmosphere when there is nothing to report is not.

The board shape:
  { "view": "board", "title": string, "header"?: { "status"?: { "label": string, "tone"?: Tone } }, "sections": Section[] }
Tone is one of: ok, warn, error, neutral, info, caution, brand, accent.
Use 1-2 Section kinds, in a sensible order:
  - rows:  { "kind":"rows", "title"?:string, "items":[{ "text":string, "glyph"?:Tone, "trailing"?:string }] }
  - cards: { "kind":"cards", "title"?:string, "items":[{ "title":string, "pill"?:{ "label":string, "tone"?:Tone }, "fields"?:[{ "label"?:string, "value":string|number }], "footnote"?:string }] }

Then call the chamber_emit_digest tool EXACTLY ONCE with { board }: the canvas board object above. Do NOT print the JSON as your reply. After the tool returns, reply with one short line naming the digest you authored.`;
