import type { MindSlug, TurnEntry } from "./types.ts";

// The control-action vocabulary, shared by the history stripper, the directive
// parsers, and the prompt text that tells agents what to emit. One source of
// truth so the stripper and a parser can never disagree on what counts as a
// control directive.
export const CONTROL_ACTIONS = new Set<string>(["nominate", "pass", "end", "direct", "close"]);

// group-chat routing defaults (chamber/pi-chamber sourced). minRounds is the
// participation floor before a moderator may close; maxSpeakerRepeats is the
// anti-monopoly cap that redirects an over-picked speaker to leastSpoken.
export const DEFAULT_MIN_ROUNDS = 1;
export const DEFAULT_MAX_SPEAKER_REPEATS = 2;

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

// A moderator's routing decision, parsed driver-side from its turn. The wire
// form is a trailing JSON object — the SAME object stripControlJson removes from
// rendered history. The parser only acts on a recognized moderator action
// ("direct"/"close", both members of CONTROL_ACTIONS), so anything the parser
// routes is something the stripper removes: no route-but-don't-strip leak. A
// trailing object that is NOT a moderator directive (a code example, `{}`, a
// stray `{"note":…}`, or a non-vocabulary action) returns null — the driver then
// falls back deterministically and the object is treated as ordinary prose.
export interface ModeratorDecision {
  action: "direct" | "close";
  nextSpeaker?: MindSlug;
  direction?: string;
}

export function parseModeratorDecision(text: string): ModeratorDecision | null {
  const json = extractTrailingJsonObject(text);
  if (!json) return null;
  // Only act on a GENUINELY trailing object (nothing but whitespace after it) —
  // the same tail-position test stripControlJson applies. A recognized object
  // mid-prose (an example, or JSON followed by more text) is not a directive: the
  // stripper would leave it, so the parser must not route on it either.
  const idx = text.lastIndexOf(json);
  if (text.slice(idx + json.length).trim().length > 0) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (parsed.action !== "direct" && parsed.action !== "close") return null;
  const action = parsed.action;
  // Tolerate both the snake_case wire key (what the prompt asks for) and camelCase.
  const next = parsed.next_speaker ?? parsed.nextSpeaker;
  const direction = parsed.direction;
  const nextTrimmed = typeof next === "string" ? next.trim() : "";
  const directionTrimmed = typeof direction === "string" ? direction.trim() : "";
  return {
    action,
    ...(nextTrimmed ? { nextSpeaker: nextTrimmed } : {}),
    ...(directionTrimmed ? { direction: directionTrimmed } : {}),
  };
}

// Count how many turns each Mind has authored. Folds over agent entries only
// (director/system turns don't count toward a speaker's participation), keyed by
// `from`. A moderator/synthesizer authors agent entries under its own slug, which
// callers exclude by only ever looking up participant slugs.
export function speakerCounts(transcript: readonly TurnEntry[]): Map<MindSlug, number> {
  const counts = new Map<MindSlug, number>();
  for (const entry of transcript) {
    if (entry.role === "agent") counts.set(entry.from, (counts.get(entry.from) ?? 0) + 1);
  }
  return counts;
}

// The first participant with the fewest turns, stable by participant order. The
// anti-monopoly fallback when a moderator over-picks one speaker.
export function leastSpoken(
  participants: readonly MindSlug[],
  counts: Map<MindSlug, number>,
): MindSlug | undefined {
  let pick: MindSlug | undefined;
  let min = Number.POSITIVE_INFINITY;
  for (const p of participants) {
    const c = counts.get(p) ?? 0;
    if (c < min) {
      min = c;
      pick = p;
    }
  }
  return pick;
}

// The first participant who has not spoken yet, else the first participant. The
// fallback when a moderator's pick is missing/unparseable/invalid.
export function nextUnheard(
  participants: readonly MindSlug[],
  counts: Map<MindSlug, number>,
): MindSlug | undefined {
  return participants.find((p) => (counts.get(p) ?? 0) === 0) ?? participants[0];
}

// The close gate: every participant has spoken at least `minRounds` times. A
// monotonic participation floor (not a per-round reset) — the moderator decides
// WHEN to close above it.
export function allHeardInCycle(
  participants: readonly MindSlug[],
  counts: Map<MindSlug, number>,
  minRounds: number,
): boolean {
  if (participants.length === 0) return false;
  return participants.every((p) => (counts.get(p) ?? 0) >= minRounds);
}
