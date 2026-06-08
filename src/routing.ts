// The control-action vocabulary, shared by the history stripper and — in later
// slices — the directive parsers + the prompt text that tells agents what to
// emit. One source of truth so the stripper and a future parser can never
// disagree on what counts as a control directive.
export const CONTROL_ACTIONS = new Set<string>(["nominate", "pass", "end", "direct", "close"]);

// Last balanced top-level {...}, scanned string-aware so a brace inside a JSON
// string never miscounts depth. A speaker may embed a JSON code example earlier
// in prose, so the trailing object is the one carrying a control directive. An
// earlier UNBALANCED "{" in prose (a lone brace, an emoticon like ":{", set
// notation) is skipped — the scan retries from the next "{" rather than
// abandoning the search, so a stray brace can't hide the real trailing object.
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
    if (end === -1) {
      i = start + 1; // unbalanced candidate — retry from the next "{"
      continue;
    }
    last = text.slice(start, end + 1);
    i = end + 1;
  }
  return last;
}

// Remove a control directive before re-feeding a message as history, so a
// speaker's nomination tail (or, in a later slice, a moderator's routing JSON)
// never leaks into the next speaker's prompt and gets mimicked. Strips ONLY a
// genuinely trailing object (nothing but whitespace after it) whose `action` is a
// control action — an inline JSON code example mid-prose is left intact.
// Render-only: the on-disk entry keeps the raw text.
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
