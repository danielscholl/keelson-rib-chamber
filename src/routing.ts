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

// open-floor end-vote default. The close gate is a STRICT `>` against this, so at
// 0.49 a single end vote in a 2-Mind room (ratio 0.5) closes, but an operator who
// sets 0.5 requires more than half (a 0.5 tie does not close).
export const DEFAULT_END_VOTE_THRESHOLD = 0.49;

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
  return parseTrailingControl(text, actions)?.head ?? text;
}

// The single trailing-control-directive contract, shared by the stripper and every
// directive parser so they can never disagree on what counts as a directive: a
// GENUINELY trailing balanced JSON object (nothing but whitespace after it) whose
// `action` is one of `actions`. Returns the parsed object plus the prose before it
// (`head`), or null. A recognized object mid-prose is NOT a directive — the
// stripper leaves it, so the parsers built on this must not route on it either.
function parseTrailingControl(
  text: string,
  actions: Set<string>,
): { parsed: Record<string, unknown>; head: string } | null {
  const json = extractTrailingJsonObject(text);
  if (!json) return null;
  const idx = text.lastIndexOf(json);
  if (text.slice(idx + json.length).trim().length > 0) return null; // not a tail
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null; // not JSON
  }
  if (typeof parsed.action !== "string" || !actions.has(parsed.action)) return null;
  return { parsed, head: text.slice(0, idx).trimEnd() };
}

const MODERATOR_ACTIONS = new Set<string>(["direct", "close"]);
const NOMINATION_ACTIONS = new Set<string>(["nominate", "pass", "end"]);

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
  const match = parseTrailingControl(text, MODERATOR_ACTIONS);
  if (!match) return null;
  const { parsed } = match;
  const action = parsed.action as "direct" | "close";
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

// An open-floor speaker's trailing directive, parsed driver-side from its turn.
// Same wire/strip discipline as parseModeratorDecision: a GENUINELY trailing JSON
// object whose action is in the open-floor vocabulary ("nominate"/"pass"/"end",
// all members of CONTROL_ACTIONS so the stripper removes whatever the parser
// routes). `nominate` without a slug is meaningless and collapses to null so the
// driver falls back deterministically. Anything else (a code example, a non-tail
// object, an off-vocabulary action) returns null.
export interface Nomination {
  action: "nominate" | "pass" | "end";
  slug?: MindSlug;
  reason?: string;
}

export function parseNomination(text: string): Nomination | null {
  const match = parseTrailingControl(text, NOMINATION_ACTIONS);
  if (!match) return null;
  const { parsed } = match;
  const action = parsed.action as "nominate" | "pass" | "end";
  const slugTrimmed = typeof parsed.slug === "string" ? parsed.slug.trim() : "";
  const reasonTrimmed = typeof parsed.reason === "string" ? parsed.reason.trim() : "";
  // A nomination must name who is next; without a slug it carries no routing.
  if (action === "nominate" && !slugTrimmed) return null;
  return {
    action,
    ...(slugTrimmed ? { slug: slugTrimmed } : {}),
    ...(reasonTrimmed ? { reason: reasonTrimmed } : {}),
  };
}

// The fraction of participants whose CURRENT standing is an end vote: a
// participant counts iff its most-recent agent turn parses to action "end". This
// is current standing, not an accumulating tally — a participant who votes end and
// then speaks again has withdrawn the vote — so no per-round reset is needed. The
// caller compares with a STRICT `>` against the threshold.
export function endVoteRatio(
  transcript: readonly TurnEntry[],
  participants: readonly MindSlug[],
): number {
  if (participants.length === 0) return 0;
  let votes = 0;
  for (const p of participants) {
    let latest: TurnEntry | undefined;
    for (const entry of transcript) {
      if (entry.role === "agent" && entry.from === p) latest = entry;
    }
    if (!latest) continue;
    const nom = parseNomination(latest.parts.map((part) => part.text).join("\n"));
    if (nom?.action === "end") votes++;
  }
  return votes / participants.length;
}
