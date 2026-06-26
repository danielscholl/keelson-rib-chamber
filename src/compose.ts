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

interface PromptSection {
  title: string;
  text: string | undefined;
  // A flex section is tail-truncated to fit the remaining budget rather than
  // dropped whole; a non-flex section is included only if it fits intact.
  flex: boolean;
}

// The budgeted stacking core both composers share: a protected identity header +
// body (head-truncated only if it alone overflows), then each section in priority
// order — included whole if it fits, tail-truncated if flex, dropped otherwise —
// and an optional protected footer. Clamped to the seed budget either way.
function stackMindPrompt(opts: {
  name: string;
  identity: string;
  sections: readonly PromptSection[];
  footer?: string;
}): string {
  const header = `# ${opts.name}`;
  const sep = "\n\n";
  const footerCost = opts.footer ? sep.length + opts.footer.length : 0;

  // Protected core. If header+identity(+footer) alone overflow, head-truncate the
  // identity body (keep its opening).
  const overhead = header.length + sep.length + "## Identity\n\n".length + footerCost;
  let body = opts.identity;
  if (overhead + body.length > MIND_PROMPT_BUDGET) {
    body =
      body.slice(0, Math.max(0, MIND_PROMPT_BUDGET - overhead - TRUNCATION.length)) + TRUNCATION;
  }

  const parts = [header, `## Identity\n\n${body}`];
  let used = parts.join(sep).length + footerCost;

  for (const { title, text, flex } of opts.sections) {
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

  if (opts.footer) parts.push(opts.footer);
  const out = parts.join(sep);
  return out.length > MIND_PROMPT_BUDGET ? out.slice(0, MIND_PROMPT_BUDGET) : out;
}

// The protected identity body both composers share: the authored SOUL, falling
// back to the roster persona when there is no readable soul.
async function composeIdentity(mindsRoot: string, mind: Mind): Promise<string> {
  const soulDoc = (await readMindDoc(mindsRoot, mind.slug, "SOUL.md"))?.trim();
  return soulDoc && soulDoc.length > 0 ? soulDoc : mind.persona.trim();
}

// The durable-memory + operating-rules section pair both composers stack onto the
// identity (each contributes only once it carries real content past the seed
// placeholder). The chat composer layers the log tail and footer on top.
async function memoryAndRulesSections(mindsRoot: string, mind: Mind): Promise<PromptSection[]> {
  return [
    {
      title: "Durable memory",
      text: substance(await readMindDoc(mindsRoot, mind.slug, "memory.md")),
      flex: false,
    },
    {
      title: "Operating rules",
      text: substance(await readMindDoc(mindsRoot, mind.slug, "rules.md")),
      flex: false,
    },
  ];
}

// A Mind + its on-disk soul files -> one direct-chat system prompt, <= the seed
// budget. Identity (SOUL, falling back to the roster persona) and the operating
// footer are protected; durable memory, rules, and the log tail fill the rest in
// that priority, the log truncating first, then dropping, before any section
// above it is touched.
export async function composeMindSystemPrompt(mindsRoot: string, mind: Mind): Promise<string> {
  return stackMindPrompt({
    name: mind.name,
    identity: await composeIdentity(mindsRoot, mind),
    sections: [
      ...(await memoryAndRulesSections(mindsRoot, mind)),
      {
        title: "Recent log",
        text: substance(await readMindDoc(mindsRoot, mind.slug, "log.md")),
        flex: true,
      },
    ],
    footer: `## Direct-chat operating rules\n\n${DIRECT_CHAT_RULES}`,
  });
}

// A Mind + its memory -> the system prompt for ONE room turn. Identity (SOUL,
// falling back to the roster persona) plus the Mind's durable memory and operating
// rules — what it has LEARNED and how it has decided to behave — so a Mind carries
// its growth into a room instead of starting amnesiac each turn (the close-only
// reflection pass is what fills memory.md). No direct-chat footer (the room turn
// prompt frames the turn) and no log tail (the episodic journal is for the chat
// view); same budget and empty-placeholder handling as the chat composer.
export async function composeRoomSystemPrompt(mindsRoot: string, mind: Mind): Promise<string> {
  return stackMindPrompt({
    name: mind.name,
    identity: await composeIdentity(mindsRoot, mind),
    sections: await memoryAndRulesSections(mindsRoot, mind),
  });
}

// The seed both entry points (the roster Enter action and the /mind agent
// resolver) hand to the harness, so the two can never drift. Structurally the
// shared OpenChatSeed; chamber emits it as opaque action data, so it needn't
// import the type. Carries the Mind's model when set so a seeded chat runs on it.
export async function buildSeedFor(
  mindsRoot: string,
  mind: Mind,
): Promise<{
  systemPrompt: string;
  name: string;
  openingPrompt: string;
  model?: string;
  providerId?: string;
}> {
  return {
    systemPrompt: await composeMindSystemPrompt(mindsRoot, mind),
    name: mind.name.slice(0, 80),
    openingPrompt: ENTER_OPENING_PROMPT,
    ...(mind.model ? { model: mind.model } : {}),
    ...(mind.provider ? { providerId: mind.provider } : {}),
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
