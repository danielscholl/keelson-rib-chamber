import { DESIGN_TOKENS, designTokenCssBlock } from "@keelson/shared";
import type { LensRecord } from "../lens-store.ts";
import {
  type DecisionMarker,
  formatDuration,
  type OutcomeSplit,
  turnsLabel,
} from "../room-text.ts";
import { speakerCounts } from "../routing.ts";
import { identityToneForSlot, type Mind, type Room, type TurnEntry } from "../types.ts";
import { facilitatorRoles } from "./room.ts";
import { shapeLabel } from "./rooms.ts";

export interface RoomSummaryInput {
  room: Room;
  outcome: OutcomeSplit;
  minds: readonly Mind[];
  decisions: readonly DecisionMarker[];
  tabled: readonly LensRecord[];
  transcript: readonly TurnEntry[];
}

function esc(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      (
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        }) as const
      )[char as "&" | "<" | ">" | '"' | "'"],
  );
}

// The host's reserved identity hues as CSS custom properties, per theme, so a speaker
// wears the same hue here that its seat wears on every board. Emitted from DESIGN_TOKENS
// rather than written as hex: the frame is an opaque origin and cannot read the app's
// properties, so the values have to be inlined — but only from the one source.
function identityTokenCss(): string {
  const vars = (theme: "dark" | "light") =>
    Object.entries(DESIGN_TOKENS[theme].identity)
      .map(([name, hex]) => `--id-${name}: ${hex};`)
      .join(" ");
  return `:root { ${vars("dark")} }\n:root[data-theme="light"] { ${vars("light")} }`;
}

interface Voice {
  name: string;
  role: string;
  color: string;
  turns: number;
  // Absent when the room recorded no agent turns at all: like the room board's Voices
  // rows, a speaker with no share to draw carries no track rather than an empty one.
  share?: number;
}

// The room's own seat order — facilitators (accent, like the board's brand tone), then
// participants in their identity hue — each with its share of the agent turns. Shares the
// board's facilitatorRoles so the two readings of "who was in this room" cannot drift.
function voicesFor(
  room: Room,
  minds: readonly Mind[],
  transcript: readonly TurnEntry[],
): readonly Voice[] {
  const bySlug = new Map(minds.map((mind) => [mind.slug, mind]));
  const counts = speakerCounts(transcript);
  const spoken = [...counts.values()].reduce((sum, n) => sum + n, 0);
  const seen = new Set<string>();
  const voices: Voice[] = [];
  const add = (slug: string, role: string, color: string) => {
    if (seen.has(slug)) return;
    seen.add(slug);
    const turns = counts.get(slug) ?? 0;
    voices.push({
      name: bySlug.get(slug)?.name ?? slug,
      role,
      color,
      turns,
      ...(spoken > 0 ? { share: Math.round((turns / spoken) * 100) } : {}),
    });
  };
  for (const [slug, role] of facilitatorRoles(room)) add(slug, role, "var(--accent)");
  for (const slug of room.participants) {
    const mind = bySlug.get(slug);
    const tone = identityToneForSlot(mind?.identitySlot);
    add(
      slug,
      mind?.role?.trim() || "participant",
      tone === "neutral" ? "var(--muted)" : `var(--${tone})`,
    );
  }
  return voices;
}

function plural(n: number, one: string): string {
  return n === 1 ? one : `${one}s`;
}

function dayLabel(iso: string): string | undefined {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return undefined;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(ms));
}

// The 3-5 figures a reviewer scanning many rooms actually wants: how long the conversation
// ran, who was in it, what it settled, what it left behind. A figure that was never
// measured (a room with no closing stamp) is omitted rather than shown as zero.
function statTiles(input: RoomSummaryInput): readonly { value: string; label: string }[] {
  const { room, transcript, decisions, tabled } = input;
  const tiles = [
    { value: String(room.turnIndex), label: plural(room.turnIndex, "turn") },
    { value: String(room.participants.length), label: plural(room.participants.length, "speaker") },
  ];
  const closedAt = room.outcomeAt ?? [...transcript].reverse().find((entry) => entry.at)?.at;
  const elapsed = closedAt ? formatDuration(room.createdAt, closedAt) : undefined;
  if (elapsed) tiles.push({ value: elapsed, label: "elapsed" });
  if (decisions.length > 0) {
    tiles.push({ value: String(decisions.length), label: plural(decisions.length, "decision") });
  }
  if (tabled.length > 0) {
    tiles.push({ value: String(tabled.length), label: plural(tabled.length, "exhibit") });
  }
  return tiles;
}

// Inline marks on ALREADY-ESCAPED text: bold, code, and the same guarded single-asterisk
// emphasis room-text uses, so prose with a glob or a multiplication sign ("*.ts", "2 * 3")
// keeps its asterisks instead of silently becoming emphasis.
function inlineMarks(escaped: string): string {
  return escaped
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/(?<!\*)\*(?!\*)(?!\s)([^*\n]+?)(?<!\s)\*(?!\*)/g, "<em>$1</em>");
}

// Render the closing document's markdown as structure — headings, lists, emphasis — not as
// one pre-wrapped block. This page exists so an operator can read the close INSTEAD of the
// transcript, and a wall of undifferentiated text is exactly what sends them back to it.
// Every line is escaped BEFORE any markup is added, so an agent-authored document can never
// introduce an element of its own.
function renderDocument(body: string): string {
  const blocks: string[] = [];
  let list: { ordered: boolean; items: string[] } | undefined;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length === 0) return;
    blocks.push(`<p>${inlineMarks(esc(para.join(" ")))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const tag = list.ordered ? "ol" : "ul";
    const items = list.items.map((item) => `<li>${inlineMarks(esc(item))}</li>`).join("");
    blocks.push(`<${tag}>${items}</${tag}>`);
    list = undefined;
  };
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line === "") {
      flushPara();
      flushList();
      continue;
    }
    if (/^-{3,}$/.test(line) || /^\*{3,}$/.test(line)) {
      flushPara();
      flushList();
      blocks.push("<hr>");
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      flushPara();
      flushList();
      // The masthead owns the page's h1, so the document's own headings start at h2 and
      // anything deeper than one nesting level folds to h3 — a close that reaches h5
      // renders as hierarchy the reader can hold, not as six sizes of grey.
      const level = (heading[1] ?? "").length <= 2 ? 2 : 3;
      blocks.push(`<h${level}>${inlineMarks(esc(heading[2] ?? ""))}</h${level}>`);
      continue;
    }
    const bullet = /^[-*+]\s+(.+)$/.exec(line);
    const numbered = /^\d+[.)]\s+(.+)$/.exec(line);
    const item = bullet?.[1] ?? numbered?.[1];
    if (item !== undefined) {
      flushPara();
      const ordered = bullet === null;
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, items: [] };
      list.items.push(item);
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  return blocks.join("\n");
}

function voicesHtml(voices: readonly Voice[]): string {
  return voices
    .map((voice) => {
      const track =
        voice.share === undefined
          ? ""
          : `<span class="track"><span class="fill" style="width: ${voice.share}%; background: ${voice.color}"></span></span>`;
      return `<li class="voice">
        <span class="voice-top">
          <span class="voice-dot" style="background: ${voice.color}"></span>
          <span class="voice-name">${esc(voice.name)}</span>
          <span class="voice-turns">${voice.turns} ${plural(voice.turns, "turn")}</span>
        </span>
        <span class="voice-role">${esc(voice.role)}</span>
        ${track}
      </li>`;
    })
    .join("");
}

// Only rendered when the room actually pinned decisions. A room that never adopted the
// marker convention has its disagreements in the document's own prose, so a standing
// "none recorded" panel would answer "where did they disagree?" with a negative nobody
// checked — next to a document that often names the disagreement outright.
function decisionsHtml(decisions: readonly DecisionMarker[]): string {
  if (decisions.length === 0) return "";
  const items = decisions
    .map(
      (decision) => `<li>
        <p class="decision-title"><span class="qn">Q${decision.question}</span>${esc(
          decision.title,
        )}</p>
        <p class="decision-gist">${esc(decision.gist || "No disagreement detail was recorded.")}</p>
      </li>`,
    )
    .join("");
  return `<section class="panel">
      <h2 class="panel-head">Where they disagreed</h2>
      <ul class="decisions">${items}</ul>
    </section>`;
}

function producedHtml(tabled: readonly LensRecord[]): string {
  const body =
    tabled.length === 0
      ? '<p class="empty">Nothing was tabled — the close is the whole deliverable.</p>'
      : `<ul class="produced">${tabled
          .map((record) => `<li>${esc(record.board.title || record.id)}</li>`)
          .join("")}</ul>`;
  return `<section class="panel">
      <h2 class="panel-head">What it produced</h2>
      ${body}
    </section>`;
}

// A room's close as a page an operator can read INSTEAD of its transcript: the thesis and
// the question up top, the figures that size the conversation, the closing document as the
// hero, and who said what beneath it. Deterministic and unpaid — every word here is the
// room's own, extracted; no agent turn composes this page.
export function buildRoomSummaryHtml(input: RoomSummaryInput): string {
  const { room, outcome, minds, decisions, tabled, transcript } = input;
  const voices = voicesFor(room, minds, transcript);
  const tiles = statTiles(input);
  const closedOn = room.outcomeAt ? dayLabel(room.outcomeAt) : undefined;
  const eyebrow = ["Room summary", shapeLabel(room), closedOn ? `closed ${closedOn}` : undefined]
    .filter(Boolean)
    .join(" · ");
  // "budget", not "turns": the stat tile above already carries the count, and the two read
  // as a contradiction ("11" beside "10/10") unless this one names what it is measuring.
  const provenance = [
    room.slug,
    `budget ${turnsLabel(room.turnIndex, room.turnBudget)}`,
    `round ${room.round}`,
  ].join(" · ");

  return `<style>
${designTokenCssBlock()}
${identityTokenCss()}
  * { box-sizing: border-box; }
  body {
    background: var(--bg);
    color: var(--fg);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif;
    line-height: 1.6;
    margin: 0;
  }
  .sheet { margin: 0 auto; max-width: 72rem; padding: 40px 32px 56px; }
  /* The close reads at a proper measure in the main column while the rail keeps the
     scannable context — who spoke, what came out of it — beside it rather than three
     screens below. The rail sticks, so a long document never scrolls its own cast away. */
  .body {
    display: grid;
    gap: 40px;
    grid-template-columns: minmax(0, 1fr) 17rem;
    margin-top: 36px;
  }
  .main { grid-column: 1; grid-row: 1; min-width: 0; }
  .rail { align-self: start; grid-column: 2; grid-row: 1; position: sticky; top: 24px; }
  .mono {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-variant-numeric: tabular-nums;
  }
  .eyebrow {
    color: var(--muted);
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 0.72rem;
    letter-spacing: 0.14em;
    margin: 0;
    text-transform: uppercase;
  }
  h1 {
    color: var(--fg-strong);
    font-size: clamp(1.9rem, 4vw, 2.6rem);
    letter-spacing: -0.02em;
    line-height: 1.15;
    margin: 12px 0 0;
    text-wrap: balance;
  }
  .question {
    border-left: 2px solid var(--border);
    color: var(--muted);
    margin: 18px 0 0;
    max-width: 65ch;
    padding-left: 14px;
    white-space: pre-wrap;
  }
  .stats {
    display: grid;
    gap: 12px;
    grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
    margin-top: 32px;
  }
  .tile {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 14px 16px;
  }
  .tile-value {
    color: var(--fg-strong);
    display: block;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 1.65rem;
    font-variant-numeric: tabular-nums;
    line-height: 1.1;
  }
  .tile-label {
    color: var(--muted);
    display: block;
    font-size: 0.78rem;
    margin-top: 6px;
  }
  .panel { margin-top: 36px; }
  .main > .panel:first-child, .rail > .panel:first-child { margin-top: 0; }
  .panel-head {
    border-bottom: 1px solid var(--border);
    color: var(--muted);
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.12em;
    margin: 0 0 18px;
    padding-bottom: 8px;
    text-transform: uppercase;
  }
  .document { max-width: 65ch; }
  .document h2 {
    color: var(--fg-strong);
    font-size: 1.4rem;
    letter-spacing: -0.015em;
    margin: 36px 0 12px;
    text-wrap: balance;
  }
  /* The close writes bold sentence lead-ins constantly, so a heading has to out-rank one on
     more than weight: it gets the size step and the air above that a section break reads by. */
  .document h3 {
    color: var(--fg-strong);
    font-size: 1.15rem;
    letter-spacing: -0.01em;
    margin: 34px 0 10px;
    text-wrap: balance;
  }
  .document p { margin: 0 0 14px; }
  .document ul, .document ol { margin: 0 0 14px; padding-left: 1.25rem; }
  .document li { margin-bottom: 6px; }
  .document code {
    background: var(--card-2);
    border-radius: 4px;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 0.88em;
    padding: 1px 5px;
  }
  .document strong { color: var(--fg-strong); }
  .document hr { border: 0; border-top: 1px solid var(--border); margin: 26px 0; }
  .voices { display: grid; gap: 16px; list-style: none; margin: 0; padding: 0; }
  .voice-top { align-items: center; display: flex; gap: 8px; }
  .voice-dot { border-radius: 50%; flex: none; height: 8px; width: 8px; }
  .voice-name { color: var(--fg-strong); font-weight: 600; }
  .voice-role {
    color: var(--muted);
    display: block;
    font-size: 0.8rem;
    margin: 1px 0 6px 16px;
  }
  .track {
    background: var(--card-2);
    border: 1px solid var(--border);
    border-radius: 999px;
    display: block;
    height: 6px;
    margin-left: 16px;
    overflow: hidden;
  }
  .fill { display: block; height: 100%; }
  .voice-turns {
    color: var(--muted);
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 0.78rem;
    font-variant-numeric: tabular-nums;
    margin-left: auto;
  }
  .decisions { display: grid; gap: 16px; list-style: none; margin: 0; padding: 0; }
  .decision-title { color: var(--fg-strong); font-weight: 600; margin: 0; }
  .qn {
    color: var(--accent);
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    margin-right: 8px;
  }
  .decision-gist { color: var(--muted); margin: 4px 0 0; max-width: 65ch; }
  .produced { display: grid; gap: 8px; list-style: none; margin: 0; padding: 0; }
  .produced li { border-left: 2px solid var(--accent); padding-left: 12px; }
  .empty { color: var(--muted); margin: 0; }
  .provenance {
    border-top: 1px solid var(--border);
    color: var(--muted);
    font-size: 0.78rem;
    margin-top: 44px;
    padding-top: 14px;
  }
  .provenance p { margin: 0 0 4px; }
  /* Below the two-column threshold the rail stops sticking and leads instead: someone
     triaging a stack of rooms on a narrow drawer wants the cast and the figures first. */
  @media (max-width: 60rem) {
    .body { grid-template-columns: minmax(0, 1fr); gap: 0; }
    .main, .rail { grid-column: 1; grid-row: auto; }
    .rail { position: static; }
    .main > .panel:first-child { margin-top: 36px; }
  }
</style>
<main class="sheet">
  <header>
    <p class="eyebrow">${esc(eyebrow)}</p>
    <h1>${esc(outcome.title)}</h1>
    <p class="question">${esc(room.topic ?? "No room topic was recorded.")}</p>
  </header>
  <section class="stats">
    ${tiles
      .map(
        (tile) =>
          `<div class="tile"><span class="tile-value">${esc(
            tile.value,
          )}</span><span class="tile-label">${esc(tile.label)}</span></div>`,
      )
      .join("")}
  </section>
  <div class="body">
    <aside class="rail">
      <section class="panel">
        <h2 class="panel-head">Who was in the room</h2>
        <ul class="voices">${voicesHtml(voices)}</ul>
      </section>
      ${producedHtml(tabled)}
    </aside>
    <div class="main">
      <section class="panel">
        <h2 class="panel-head">What was decided</h2>
        <div class="document">${renderDocument(outcome.body)}</div>
      </section>
      ${decisionsHtml(decisions)}
    </div>
  </div>
  <footer class="provenance">
    <p class="mono">${esc(provenance)}</p>
    <p>Extracted from the room's own closing turn — no agent turn composed this page.</p>
  </footer>
</main>`;
}
