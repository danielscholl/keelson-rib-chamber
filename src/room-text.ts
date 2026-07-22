import type { CanvasTone } from "@keelson/shared";
import type { MindSlug, TurnEntry } from "./types.ts";

// Mechanical helpers for the room-view board: human time/duration/token
// formatting, a markdown-to-plain-text flattener (rows `detail` renders
// pre-wrapped PLAIN text, not markdown — see canvas.ts), and the decision-
// marker / outcome-document parsers the redesign reads out of the minds' own
// transcript text. Every parser here is a heuristic over content the minds
// already write under the room's own conventions — no schema change, and each
// degrades to an empty/undefined result on text that doesn't match rather than
// throwing, so a room authored under a different convention just renders
// without the affected affordance.

const HHMM = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

// The turns fraction shared by the rooms index card and the room panel's header
// chip so the two can't drift. Overflow means closing turns ran past the budget
// (synthesis and/or the grounding fidelity pass — a stop mid-fidelity persists
// overflow with no synthesis), so the label stays generic rather than naming
// synthesis.
export function turnsLabel(turnIndex: number, turnBudget: number): string {
  return turnIndex > turnBudget
    ? `${turnBudget}/${turnBudget} + closing`
    : `${turnIndex}/${turnBudget}`;
}

// "HH:MM" in the operator's local time zone — replaces the machine ISO stamp on
// the debate feed (receipt: a full ISO stamp for a six-minute conversation that
// happened an hour ago).
export function clockTime(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? HHMM.format(new Date(ms)) : "—";
}

// A coarse "<n> <unit>" span between two ISO timestamps — the debate's
// wall-clock length (distinct from relativeAgo's now-relative span). Undefined
// on an unparseable or inverted pair rather than a negative/NaN figure.
export function formatDuration(startIso: string, endIso: string): string | undefined {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  const deltaMs = end - start;
  const units: [number, string][] = [
    [86_400_000, "day"],
    [3_600_000, "hr"],
    [60_000, "min"],
  ];
  for (const [ms, unit] of units) {
    const n = Math.floor(deltaMs / ms);
    if (n >= 1) return `${n} ${unit}${n === 1 || unit === "min" ? "" : "s"}`;
  }
  return "<1 min";
}

// A compact "148k" / "950" token count — a stats tile at this scale reads a
// hero figure, not an exact one.
export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return String(Math.round(n));
  return `${Math.round(n / 1000)}k`;
}

// Sum every transcript entry's token usage — additive over however many
// entries actually carry it (older turns, or a provider that reported none,
// simply don't contribute). Undefined when NO entry carries usage, so the
// board omits the tokens stat entirely rather than showing a false zero.
export function sumTurnUsage(
  transcript: readonly Pick<TurnEntry, "usage">[],
): { inputTokens: number; outputTokens: number } | undefined {
  let inputTokens = 0;
  let outputTokens = 0;
  let any = false;
  for (const entry of transcript) {
    if (!entry.usage) continue;
    any = true;
    inputTokens += entry.usage.inputTokens;
    outputTokens += entry.usage.outputTokens;
  }
  return any ? { inputTokens, outputTokens } : undefined;
}

// The tone for a context-window fill, on the host's cross-surface convention: green
// under 70%, amber at/over 70%, red at/over 85%. Mirrors keelson's chat usage meter
// so a Mind running hot reads the same in a room as it does in a direct chat.
export function contextFillTone(pct: number): CanvasTone {
  if (pct >= 85) return "error";
  if (pct >= 70) return "warn";
  return "ok";
}

// The most recent context-window reading per speaker — the last turn each Mind took
// whose usage reported both a window and a fill. A provider that reports no window
// (a stub, or one that omits it) simply never lands in the map, so the caller renders
// no meter for that Mind rather than a false 0%. Keyed by the entry's `from`, so it
// covers facilitators and participants alike.
export function latestContextByMind(
  transcript: readonly TurnEntry[],
): Map<MindSlug, { contextTokens: number; contextWindow: number }> {
  const out = new Map<MindSlug, { contextTokens: number; contextWindow: number }>();
  for (const entry of transcript) {
    const u = entry.usage;
    if (!u || typeof u.contextTokens !== "number" || !u.contextWindow || u.contextWindow <= 0)
      continue;
    out.set(entry.from, { contextTokens: u.contextTokens, contextWindow: u.contextWindow });
  }
  return out;
}

// The transcript's tool-call tally — total invocations and how many a matching
// tool_result flagged as errored. Zero total means the board omits the tool stat.
export function countToolCalls(transcript: readonly Pick<TurnEntry, "toolCalls">[]): {
  total: number;
  failed: number;
} {
  let total = 0;
  let failed = 0;
  for (const entry of transcript) {
    for (const call of entry.toolCalls ?? []) {
      total += 1;
      if (call.errored) failed += 1;
    }
  }
  return { total, failed };
}

// The italic pattern requires no whitespace just inside either delimiter (the
// CommonMark left/right-flanking rule, simplified) — without it, ordinary
// prose using a bare `*` for multiplication or a glob ("2 * 3 workers",
// "*.ts") reads as an emphasis span and the asterisks vanish.
function stripInlineMarks(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(?<!\*)\*(?!\*)(?!\s)([^*\n]+?)(?<!\s)\*(?!\*)/g, "$1");
}

function truncate(s: string, max: number): string {
  const trimmed = s.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1).trim()}…` : trimmed;
}

function flattenOnly(text: string): string {
  const structural = text.replace(/^#{1,6}\s+/gm, "").replace(/^[-*]\s+/gm, "• ");
  return stripInlineMarks(structural)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// rows `detail` is a pre-wrapped PLAIN text field capped at 4000 chars (see
// canvas.ts) — flatten a Mind's markdown into readable plain text for it
// (strip heading/bold/italic/code marks, fold bullets to "• ") rather than
// showing the raw syntax literally (the "raw" finding). Truncates ON A BREAK
// (a blank line or sentence end) so the cut reads clean, and ALWAYS leaves
// room for its own continuation note — the result never exceeds `max`, which
// matters because a longer string fails the schema and drops the whole board.
export function flattenMarkdown(text: string, max = 4000): string {
  const flattened = flattenOnly(text);
  if (flattened.length <= max) return flattened;
  const noteFor = (n: number) => `\n\n— continues · full text ${n.toLocaleString()} chars —`;
  const note = noteFor(flattened.length);
  // The note itself doesn't fit within `max` (only reachable at a pathologically
  // small max) — hard-truncate with no footer rather than append a note whose
  // own length would push the result past the caller's cap.
  if (note.length >= max) return flattened.slice(0, max);
  const budget = max - note.length;
  const cut = flattened.slice(0, budget);
  const lastBreak = Math.max(cut.lastIndexOf("\n\n"), cut.lastIndexOf(". "));
  const clipped = lastBreak > budget * 0.6 ? cut.slice(0, lastBreak + 1) : cut;
  return `${clipped.trimEnd()}${note}`;
}

// The topic's one-line gist: its first non-empty line, mechanically — no
// summarization runs at board-build time (a pure function, no agent turn). A
// topic that opens with a heading-style line (e.g. "GROUND TRUTH") shows that
// line verbatim; honest, if sometimes blunt, rather than inventing prose the
// room never wrote.
export function topicGist(topic: string, max = 160): string {
  const firstLine =
    topic
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  return truncate(stripInlineMarks(firstLine.replace(/^#{1,6}\s+/, "")), max);
}

// The room's contract tail — "produces N decisions · criteria · test plan" —
// read off decisions actually found in the debate plus vocabulary the topic
// itself uses, never authored. Undefined when nothing is detectable (no
// decisions yet and no recognizable contract language).
export function topicContractTail(topic: string, decisionCount: number): string | undefined {
  const parts: string[] = [];
  if (decisionCount > 0) {
    parts.push(`produces ${decisionCount} decision${decisionCount === 1 ? "" : "s"}`);
  }
  if (/acceptance criteria/i.test(topic)) parts.push("criteria");
  if (/test plan/i.test(topic)) parts.push("test plan");
  if (/out-of-scope|out of scope/i.test(topic)) parts.push("out-of-scope");
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

export interface DecisionMarker {
  question: number;
  title: string;
  gist: string;
}

// **Qn — Title. Pinned[ word].** — the decision-marker convention a room's own
// moderator ground rules establish (the minds write this themselves; it is not
// a schema the board defines). Requiring the trailing "Pinned" word is
// deliberate: it lets an aside that merely NAMES a question ("Q2 flag — ...")
// pass through unmatched, so only an actual pin trips this.
const DECISION_MARKER = /\*\*Q(\d+)\s*—\s*(.+?)\.\s*Pinned(?:\s+\w+)?\.\*\*/g;

// Every decision marker in `text`, in the order they appear, each paired with
// the gist — the first sentence of the paragraph immediately following the
// marker (the room writes the marker as its own standalone line, then argues
// the decision in the next paragraph). The gist scan is bounded to end at the
// NEXT marker (back-to-back markers with no prose between them yield an empty
// gist rather than bleeding into the next marker's own raw text).
export function parseDecisionMarkers(text: string): DecisionMarker[] {
  const matches = [...text.matchAll(DECISION_MARKER)];
  const out: DecisionMarker[] = [];
  matches.forEach((m, i) => {
    const question = Number(m[1]);
    const title = (m[2] ?? "").trim();
    if (!title || m.index === undefined || !Number.isFinite(question)) return;
    const start = m.index + m[0].length;
    const end = matches[i + 1]?.index ?? text.length;
    out.push({ question, title, gist: firstSentence(text.slice(start, end), 110) });
  });
  return out;
}

function firstSentence(text: string, max: number): string {
  const trimmed = text.replace(/^\s+/, "");
  if (!trimmed) return "";
  const stop = trimmed.search(/[.!?](\s|$)/);
  const cut = stop >= 0 ? trimmed.slice(0, stop + 1) : (trimmed.split("\n")[0] ?? trimmed);
  return truncate(stripInlineMarks(cut.replace(/\s+/g, " ")), max);
}

export interface OutcomeSplit {
  title: string;
  body: string;
}

// Split the LAST agent turn's text at its own `---` / `## Title` boundary — the
// room's own convention for closing a debate with a synthesized document
// (see the design review). Returns `{ debate: text }` with no `outcome` when
// the turn carries no such boundary — an in-progress room, or one whose last
// turn is ordinary debate — so the board renders no Outcome card, unchanged
// from a room authored before this convention existed. Uses the LAST such
// boundary in the text, not the first: a turn that structures its own prose
// with an earlier `---`/`##` aside (a sub-argument heading, say) must not have
// that aside mistaken for the closing document.
const OUTCOME_BOUNDARY_OPEN = /\n+-{3,}\s*\n+##\s+([^\n]+)\n+/g;

export function splitOutcome(text: string): { debate: string; outcome?: OutcomeSplit } {
  OUTCOME_BOUNDARY_OPEN.lastIndex = 0;
  let last: RegExpExecArray | undefined;
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: the idiomatic exec-loop shape
  while ((match = OUTCOME_BOUNDARY_OPEN.exec(text)) !== null) last = match;
  if (!last || last.index === undefined) return { debate: text };
  const title = (last[1] ?? "").trim();
  const body = text.slice(last.index + last[0].length).trim();
  if (!title || !body) return { debate: text };
  return { debate: text.slice(0, last.index).trim(), outcome: { title, body } };
}

// The synthesis turn read as the room's outcome document. Distinct from splitOutcome,
// which the room board needs strict — there a boundary-less turn must stay whole in the
// debate feed, so no-match-means-nothing is the right degradation. Here the closing turn
// IS the document: `synthesized` carries the driver's own record that it ran one
// (room.outcomeAt), so a plain-prose close reads as the document rather than as nothing,
// and a mid-debate turn still can't be mistaken for a close.
//
// An opening `## Title` wins over a `---` boundary further down: the synthesis prompt asks
// the closer to open with one, which makes any later rule an aside INSIDE the document —
// the mirror of the aside splitOutcome's own last-boundary rule guards against.
const OPENING_TITLE = /^##\s+([^\n]+)\n+([\s\S]+)$/;

export function readOutcome(
  text: string,
  opts: { synthesized: boolean; fallbackTitle: string },
): { debate: string; outcome?: OutcomeSplit } {
  const trimmed = text.trim();
  if (!trimmed) return { debate: "" };
  if (opts.synthesized) {
    const titled = OPENING_TITLE.exec(trimmed);
    const title = titled?.[1]?.trim();
    const body = titled?.[2]?.trim();
    if (title && body) return { debate: "", outcome: { title, body } };
  }
  const split = splitOutcome(trimmed);
  if (split.outcome) return split;
  if (opts.synthesized) {
    return { debate: "", outcome: { title: opts.fallbackTitle, body: trimmed } };
  }
  return { debate: trimmed };
}

const OUTCOME_QUESTION = /\*\*Q(\d+)\s*—/g;

// Distinct question numbers the outcome document itself restates — the
// "of M" half of the decisions rail's "N of M decided" metric once a room
// closes with a synthesized document.
export function parseOutcomeQuestions(body: string): number[] {
  const seen = new Set<number>();
  for (const m of body.matchAll(OUTCOME_QUESTION)) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) seen.add(n);
  }
  return [...seen].sort((a, b) => a - b);
}

export interface OutcomeReceipt {
  decisions: number;
  criteria?: number;
  hasTestPlan: boolean;
  hasOutOfScope: boolean;
}

// The outcome card's receipt line — a mechanical contract check against the
// document's own section headings (### Acceptance criteria / Test plan /
// Out-of-scope), never an authored claim. A heading that itself negates the
// thing it names ("### No test plan needed") must not count as delivering
// it — findHeading rejects a match whose heading line reads as a negation.
export function outcomeReceipt(body: string): OutcomeReceipt {
  const criteriaSection = findHeading(body, /acceptance criteria/i);
  const criteria = criteriaSection
    ? criteriaSection.body.split("\n").filter((l) => /^\s*[-*]\s+/.test(l)).length
    : undefined;
  return {
    decisions: parseOutcomeQuestions(body).length,
    ...(criteria ? { criteria } : {}),
    hasTestPlan: Boolean(findHeading(body, /test plan/i)),
    hasOutOfScope: Boolean(findHeading(body, /out-of-scope|out of scope/i)),
  };
}

// A heading line that negates its own label — "No test plan needed", "No
// acceptance criteria defined" — reads as the label's ABSENCE, not its
// presence; only the text strictly before the label on the heading line is
// checked, so a body sentence like "not applicable" further down the section
// can't retroactively negate a heading that plainly names the section.
const NEGATES_LABEL = /\b(no|not|none|n\/a)\s*$/i;

function findHeading(body: string, label: RegExp): { heading: string; body: string } | undefined {
  // Wrap label.source in a non-capturing group: several labels (e.g.
  // "out-of-scope|out of scope") are themselves an alternation, which would
  // otherwise split the surrounding "###[^\n]* ... [^\n]*\n" pattern apart at
  // the `|` instead of joining inside it.
  const headingLine = new RegExp(`###[^\\n]*(?:${label.source})[^\\n]*\\n`, "i");
  const match = headingLine.exec(body);
  if (!match || match.index === undefined) return undefined;
  const labelMatch = new RegExp(label.source, "i").exec(match[0]);
  const before = labelMatch ? match[0].slice(0, labelMatch.index) : match[0];
  if (NEGATES_LABEL.test(before.replace(/^#{1,6}\s*/, "").trim())) return undefined;
  const rest = body.slice(match.index + match[0].length);
  const next = /\n###\s+/.exec(rest);
  return { heading: match[0], body: (next ? rest.slice(0, next.index) : rest).trim() };
}
