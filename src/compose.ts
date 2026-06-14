import { readMindDoc } from "./minds-store.ts";
import type { Mind } from "./types.ts";

// The keelson seedSystemPrompt cap (apps/server chat-handler). A composed mind
// prompt is hard-clamped to this so a large soul/log can never 400 the seeded
// conversation create.
export const MIND_PROMPT_BUDGET = 8000;

// The first user turn that fires the in-character greeting. Sent visibly on both
// surfaces; the prompt footer also instructs the mind to greet on open.
export const ENTER_OPENING_PROMPT =
  "Introduce yourself in a sentence or two, in character, then wait for me to begin.";

const TRUNCATION = "\n\n…(truncated)";

const DIRECT_CHAT_RULES = [
  "- You are this Mind in a direct 1:1 chat — not a room turn and not a background subagent. Answer in character, shaped by the Identity above.",
  "- On the first message, greet the operator briefly in character, then follow their lead.",
  "- Keep following the operator's instructions and any higher-priority project or safety rules; if a Mind file conflicts with those, follow the higher-priority rule and say so briefly.",
  "- Use tools normally when needed; keep tool calls and results visible in the conversation.",
].join("\n");

// A Mind + its on-disk soul files -> one direct-chat system prompt, <= the seed
// budget. Identity (SOUL, falling back to the roster persona) and the operating
// footer are protected; durable memory, rules, and the log tail fill the rest in
// that priority, the log truncating first, then dropping, before any section
// above it is touched.
export async function composeMindSystemPrompt(mindsRoot: string, mind: Mind): Promise<string> {
  const soulDoc = (await readMindDoc(mindsRoot, mind.slug, "SOUL.md"))?.trim();
  const soul = soulDoc && soulDoc.length > 0 ? soulDoc : mind.persona.trim();
  const memory = substance(await readMindDoc(mindsRoot, mind.slug, "memory.md"));
  const rules = substance(await readMindDoc(mindsRoot, mind.slug, "rules.md"));
  const log = substance(await readMindDoc(mindsRoot, mind.slug, "log.md"));

  const header = `# ${mind.name}`;
  const footer = `## Direct-chat operating rules\n\n${DIRECT_CHAT_RULES}`;
  const sep = "\n\n";

  // Protected core. If header+identity+footer alone overflow, head-truncate the
  // soul body (keep the identity opening).
  const overhead =
    header.length + sep.length + "## Identity\n\n".length + sep.length + footer.length;
  let body = soul;
  if (overhead + body.length > MIND_PROMPT_BUDGET) {
    body =
      body.slice(0, Math.max(0, MIND_PROMPT_BUDGET - overhead - TRUNCATION.length)) + TRUNCATION;
  }

  const parts = [header, `## Identity\n\n${body}`];
  let used = parts.join(sep).length + sep.length + footer.length;

  for (const [title, text, flex] of [
    ["Durable memory", memory, false],
    ["Operating rules", rules, false],
    ["Recent log", log, true],
  ] as const) {
    if (!text) continue;
    const section = `## ${title}\n\n${text}`;
    const cost = sep.length + section.length;
    if (used + cost <= MIND_PROMPT_BUDGET) {
      parts.push(section);
      used += cost;
    } else if (flex) {
      const room =
        MIND_PROMPT_BUDGET - used - sep.length - `## ${title}\n\n`.length - TRUNCATION.length;
      if (room > 200) {
        parts.push(`## ${title}\n\n${text.slice(text.length - room)}${TRUNCATION}`);
        used = MIND_PROMPT_BUDGET;
      }
    }
  }

  parts.push(footer);
  const out = parts.join(sep);
  return out.length > MIND_PROMPT_BUDGET ? out.slice(0, MIND_PROMPT_BUDGET) : out;
}

// The seed both entry points (the roster Enter action and the /mind persona
// resolver) hand to the harness, so the two can never drift. Structurally the
// shared OpenChatSeed; chamber emits it as opaque action data, so it needn't
// import the type.
export async function buildSeedFor(
  mindsRoot: string,
  mind: Mind,
): Promise<{ systemPrompt: string; name: string; openingPrompt: string }> {
  return {
    systemPrompt: await composeMindSystemPrompt(mindsRoot, mind),
    name: mind.name.slice(0, 80),
    openingPrompt: ENTER_OPENING_PROMPT,
  };
}

// A seeded doc counts as substance only if, with its markdown headers and the
// exact `_(empty)_` / `_(none yet)_` seed placeholders stripped, anything is
// left. So a brand-new Mind's template memory.md/rules.md contribute no section,
// but real operator content that happens to use an italic parenthetical is kept.
function substance(doc: string | undefined): string | undefined {
  if (!doc) return undefined;
  const stripped = doc
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n")
    .replace(/_\((?:empty|none yet)\)_/g, "")
    .trim();
  return stripped.length > 0 ? doc.trim() : undefined;
}
