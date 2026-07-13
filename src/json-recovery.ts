// Parse an agent's reply text into a candidate board object. The turn is JSON-only
// (the prompt asks for one object), but a live model commonly wraps it in a ```json
// fence or prefixes a sentence of prose — so strip a surrounding fence, then fall
// back to the first balanced {…}, before giving up. A throw still means no JSON
// object was recoverable; the caller treats that as fail-closed (prior board kept).
export function parseBoard(text: string): unknown {
  const unfenced = stripCodeFence(text.trim());
  try {
    return JSON.parse(unfenced);
  } catch (err) {
    const candidate = firstJsonObject(unfenced);
    if (candidate !== null && candidate !== unfenced) return JSON.parse(candidate);
    throw err;
  }
}

// Strip a single surrounding markdown code fence (```json … ``` or ``` … ```);
// returns the inner content, or the input unchanged when it isn't fenced.
function stripCodeFence(s: string): string {
  const m = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(s);
  return m?.[1]?.trim() ?? s;
}

// Recover the first complete JSON object embedded in `text` (e.g. after a leading
// sentence of prose). Tracks string/escape state so a brace inside a string value
// can't close the object early. Returns the substring, or null when none balances.
function firstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
    } else if (ch === "\\") {
      escaped = true;
    } else if (ch === '"') {
      inString = !inString;
    } else if (!inString) {
      if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
  }
  return null;
}
