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

// The briefing turn's copy contract: an editorial lead plus one reading per changed
// item, keyed by the ref the prompt named. Strings only — the board's layout is
// composed rib-side, so this is all the reply may contribute.
export interface BriefCopy {
  lead?: string;
  readings: Record<string, string>;
}

const LEAD_MAX = 360;
const READING_MAX = 280;

// Parse a briefing turn's reply into its copy, degrading PER FIELD: a missing or
// malformed lead/reading is dropped, never thrown — the deterministic register
// renders without it. Only strings survive, bounded so a runaway reply can't
// stretch the banner. Never throws; garbage yields empty copy.
export function parseBriefCopy(text: string): BriefCopy {
  let raw: unknown;
  try {
    raw = parseBoard(text);
  } catch {
    return { readings: {} };
  }
  if (typeof raw !== "object" || raw === null) return { readings: {} };
  const obj = raw as { lead?: unknown; readings?: unknown };
  const lead = boundedLine(obj.lead, LEAD_MAX);
  const readings: Record<string, string> = {};
  if (typeof obj.readings === "object" && obj.readings !== null) {
    for (const [key, value] of Object.entries(obj.readings)) {
      const line = boundedLine(value, READING_MAX);
      if (line) readings[key] = line;
    }
  }
  return { ...(lead ? { lead } : {}), readings };
}

function boundedLine(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const line = value.replace(/\s+/g, " ").trim();
  if (!line) return undefined;
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
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
