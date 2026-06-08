import type { MindSlug } from "./types.ts";

// The control-action vocabulary, shared by the parsers, the history stripper, and
// the prompt text that tells agents what to emit. One source of truth: a tail the
// stripper removes is exactly a tail a parser would route, so a routing directive
// can never leak into the next speaker's rendered context (route ⇒ strip).
export const CONTROL_ACTIONS = new Set<string>(["nominate", "pass", "end", "direct", "close"]);

// First balanced top-level {...}, scanned string-aware so a brace inside a JSON
// string never miscounts depth. Used for a moderator decision — the reply is the
// decision, so the first object wins.
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// Last balanced top-level {...}. A speaker may embed a JSON code example earlier
// in prose, so the trailing object is the one carrying the control directive.
export function extractTrailingJsonObject(text: string): string | null {
  let last: string | null = null;
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf("{", i);
    if (start === -1) break;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let j = start; j < text.length; j++) {
      const ch = text[j];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\" && inString) {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === "{") depth++;
      if (ch === "}") {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end === -1) break; // unbalanced — stop rather than loop forever
    last = text.slice(start, end + 1);
    i = end + 1;
  }
  return last;
}

// Remove a control directive before re-feeding a message as history, so a
// moderator's routing JSON or a speaker's nomination tail never leaks into the
// next speaker's prompt. Strips ONLY a genuinely trailing object (nothing but
// whitespace after it) whose `action` is a control action — an inline JSON code
// example mid-prose is left intact. Render-only: the on-disk entry keeps the raw
// text; the driver still re-parses it for routing.
export function stripControlJson(text: string, actions: Set<string> = CONTROL_ACTIONS): string {
  const json = extractTrailingJsonObject(text);
  if (!json) return text;
  const idx = text.lastIndexOf(json);
  if (text.slice(idx + json.length).trim().length > 0) return text; // not a tail
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    if (typeof parsed.action === "string" && actions.has(parsed.action)) {
      return text.slice(0, idx).trimEnd();
    }
  } catch {
    // not JSON — leave as-is
  }
  return text;
}

// A moderator's routing decision: `{"action":"direct","next_speaker":"<slug>","direction":"…"}`
// or `{"action":"close"}`. `action` collapses to "close" only when it is exactly
// "close", else "direct" (the routing default). Null on malformed input so the
// caller falls back deterministically.
export interface ModeratorDecision {
  action: "direct" | "close";
  nextSpeaker?: MindSlug;
  direction?: string;
}

export function parseModeratorDecision(text: string): ModeratorDecision | null {
  const json = extractJsonObject(text);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const nextSpeaker =
      typeof parsed.next_speaker === "string" && parsed.next_speaker.trim().length > 0
        ? parsed.next_speaker.trim()
        : undefined;
    const direction =
      typeof parsed.direction === "string" && parsed.direction.trim().length > 0
        ? parsed.direction.trim()
        : undefined;
    const action: ModeratorDecision["action"] = parsed.action === "close" ? "close" : "direct";
    return {
      action,
      ...(nextSpeaker ? { nextSpeaker } : {}),
      ...(direction ? { direction } : {}),
    };
  } catch {
    return null;
  }
}

// A speaker's trailing routing tail: `{"action":"nominate"|"pass"|"end","slug"?:"…","reason"?:"…"}`.
// Routes only a genuinely trailing object — the same notion the stripper uses, so
// a directive the parser honours is exactly one the history stripper removes. A
// "nominate" without a slug is meaningless and collapses to null so the caller's
// fallback runs instead.
export interface Nomination {
  action: "nominate" | "pass" | "end";
  slug?: MindSlug;
  reason?: string;
}

export function parseNomination(text: string): Nomination | null {
  const json = extractTrailingJsonObject(text);
  if (!json) return null;
  const idx = text.lastIndexOf(json);
  if (text.slice(idx + json.length).trim().length > 0) return null; // not a tail — ignore inline JSON
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const action = typeof parsed.action === "string" ? parsed.action : "";
    if (action !== "nominate" && action !== "pass" && action !== "end") return null;
    const slug =
      typeof parsed.slug === "string" && parsed.slug.trim().length > 0
        ? parsed.slug.trim()
        : undefined;
    const reason =
      typeof parsed.reason === "string" && parsed.reason.trim().length > 0
        ? parsed.reason.trim()
        : undefined;
    if (action === "nominate" && !slug) return null;
    return {
      action,
      ...(slug ? { slug } : {}),
      ...(reason ? { reason } : {}),
    };
  } catch {
    return null;
  }
}
