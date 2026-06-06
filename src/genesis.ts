// Genesis — author a new Mind from a {name, role, voice} brief in one agent
// turn. Pure and provider-free: the turn is injected as a `GenesisAuthor` so the
// rib core never shells a CLI directly (the index adapter wires it to
// getExec/claude, swappable to ctx.runAgentTurn once C1 lands — symmetric with
// the room core's RunAgentTurn seam).

export interface GenesisBrief {
  name: string;
  role: string;
  voice: string;
  model?: string;
  tools?: readonly string[];
}

export interface GenesisDocs {
  // SOUL.md body — the founding persona/mission/voice doc the agent authors.
  soul: string;
  // A <=120-char persona summary for the roster card (Mind.persona).
  tagline: string;
}

// prompt -> the agent's raw text reply (expected to be the GenesisDocs JSON).
export type GenesisAuthor = (prompt: string) => Promise<string>;

const SLUG_MAX = 48;
const TAGLINE_MAX = 120;
const SAFE_SLUG = /^[a-z0-9][a-z0-9-]*$/;

export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/, "");
}

// Guard against path traversal: a slug becomes a directory name under the data
// home, so reject anything that isn't a bare kebab token (no `/`, `..`, etc.).
export function assertSafeSlug(slug: string): void {
  if (!SAFE_SLUG.test(slug)) throw new Error(`unsafe mind slug: ${JSON.stringify(slug)}`);
}

export function buildGenesisPrompt(brief: GenesisBrief): string {
  return `You are authoring the founding identity of a new persistent agent — a "Mind" — for Keelson's Chamber, a multi-agent operating layer. You are given a brief; write the Mind's soul.

Brief:
  name:  ${brief.name}
  role:  ${brief.role}
  voice: ${brief.voice}

Write an honest founding document for this Mind. Do NOT invent tools, credentials, or capabilities it does not have — describe who it is, what it is for, and how it speaks.

Return ONE JSON object and nothing else (no prose, no code fence):
  { "soul": string, "tagline": string }

- "soul" is Markdown for the Mind's SOUL.md. Use these sections, in order:
    # ${brief.name}
    ## Persona   — who this Mind is, grounded in the role
    ## Mission   — what it exists to do
    ## Voice     — how it speaks (tone, length, habits), grounded in the voice brief
- "tagline" is a single line, at most ${TAGLINE_MAX} characters, summarizing the Mind for a roster card (no Markdown).`;
}

// Fail-closed parse of the agent's reply. Fence-tolerant (the model may wrap the
// object in ```json), and validates both fields are non-empty so a malformed
// turn fails loudly here instead of persisting a blank Mind.
export function parseGenesisOutput(raw: string): GenesisDocs {
  const json = extractJsonObject(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error(`genesis output is not valid JSON: ${e instanceof Error ? e.message : e}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("genesis output is not a JSON object");
  }
  const { soul, tagline } = parsed as { soul?: unknown; tagline?: unknown };
  if (typeof soul !== "string" || soul.trim().length === 0) {
    throw new Error("genesis output: 'soul' must be a non-empty string");
  }
  if (typeof tagline !== "string" || tagline.trim().length === 0) {
    throw new Error("genesis output: 'tagline' must be a non-empty string");
  }
  return { soul: soul.trim(), tagline: truncate(tagline.trim(), TAGLINE_MAX) };
}

// Pull the first balanced {...} so a stray code fence or leading preamble from
// the CLI wrapper doesn't break JSON.parse.
function extractJsonObject(raw: string): string {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("genesis output contains no JSON object");
  }
  return raw.slice(start, end + 1);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
