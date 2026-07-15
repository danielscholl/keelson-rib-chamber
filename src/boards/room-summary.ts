import type { LensRecord } from "../lens-store.ts";
import { type DecisionMarker, flattenMarkdown, type OutcomeSplit } from "../room-text.ts";
import type { Mind, Room } from "../types.ts";

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

function closingText(body: string): string {
  const paragraphs = body
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  return paragraphs.at(-1) ?? body;
}

export function buildRoomSummaryHtml(
  room: Room,
  outcome: OutcomeSplit,
  minds: readonly Mind[],
  decisions: readonly DecisionMarker[],
  tabled: readonly LensRecord[],
): string {
  const mindBySlug = new Map(minds.map((mind) => [mind.slug, mind]));
  const attendeeRoles = new Map<string, Set<string>>();
  for (const slug of room.participants) attendeeRoles.set(slug, new Set(["participant"]));
  if (room.config?.moderator) {
    const roles = attendeeRoles.get(room.config.moderator) ?? new Set<string>();
    roles.add("moderator");
    attendeeRoles.set(room.config.moderator, roles);
  }
  if (room.config?.manager) {
    const roles = attendeeRoles.get(room.config.manager) ?? new Set<string>();
    roles.add("manager");
    attendeeRoles.set(room.config.manager, roles);
  }

  const attendees = [...attendeeRoles]
    .map(([slug, roles]) => {
      const mind = mindBySlug.get(slug);
      return `<li><strong>${esc(mind?.name ?? slug)}</strong><span>${esc(
        [...roles].join(" · "),
      )}</span></li>`;
    })
    .join("");
  // Only rendered when the room actually pinned decisions. A room that never adopted the
  // marker convention has its disagreements in the document's own prose, so a standing
  // "none recorded" panel would answer "where did they disagree?" with a negative nobody
  // checked — next to a document that often names the disagreement outright.
  const disagreements = decisions
    .map(
      (decision) =>
        `<li><strong>Q${decision.question} · ${esc(decision.title)}</strong><p>${esc(
          decision.gist || "No disagreement detail was recorded.",
        )}</p></li>`,
    )
    .join("");
  const produced =
    tabled.length > 0
      ? tabled.map((record) => `<li>${esc(record.board.title || record.id)}</li>`).join("")
      : "<li>No exhibits were tabled.</li>";

  // Flattened, not capped: flattenMarkdown's cut exists for a board field's schema limit,
  // which an HTML page has none of. Left in, its continuation note would become the
  // document's last paragraph — and so be rendered below as the room's closing move.
  const documentText = flattenMarkdown(outcome.body, Number.POSITIVE_INFINITY);
  // The closing paragraph only earns its own panel when it is not the whole document —
  // a one-paragraph close would otherwise print verbatim twice under two headings.
  const next = closingText(documentText);
  const nextSection =
    next === documentText
      ? ""
      : `
      <section class="wide">
        <h2>Open items / next move</h2>
        <p class="next">${esc(next)}</p>
      </section>`;
  const disagreementsSection =
    disagreements === ""
      ? ""
      : `
      <section>
        <h2>Where they disagreed</h2>
        <ul>${disagreements}</ul>
      </section>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(room.name)} · Summary</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #101723;
      --surface: #182231;
      --surface-raised: #202d3e;
      --text: #edf3f8;
      --muted: #a9b7c6;
      --line: #35465a;
      --accent: #80c7bd;
    }
    :root[data-theme="light"] {
      color-scheme: light;
      --bg: #f3f6f8;
      --surface: #ffffff;
      --surface-raised: #edf3f5;
      --text: #172432;
      --muted: #526474;
      --line: #c8d3dc;
      --accent: #116b63;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif;
      line-height: 1.55;
    }
    main { width: min(920px, 100%); margin: 0 auto; padding: 48px 24px 64px; }
    header { border-bottom: 1px solid var(--line); padding-bottom: 28px; }
    .eyebrow {
      color: var(--accent);
      font-size: 0.78rem;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }
    h1 { font-size: clamp(2rem, 5vw, 3.8rem); letter-spacing: -0.04em; margin: 8px 0; }
    .subtitle { color: var(--muted); margin: 0; }
    .grid { display: grid; gap: 18px; grid-template-columns: repeat(2, minmax(0, 1fr)); margin-top: 24px; }
    section { background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 22px; }
    section.wide { grid-column: 1 / -1; }
    h2 { font-size: 0.82rem; letter-spacing: 0.08em; margin: 0 0 14px; text-transform: uppercase; }
    ul { list-style: none; margin: 0; padding: 0; }
    li { border-top: 1px solid var(--line); padding: 10px 0; }
    li:first-child { border-top: 0; padding-top: 0; }
    li:last-child { padding-bottom: 0; }
    li span { color: var(--muted); display: block; font-size: 0.84rem; }
    li p { color: var(--muted); margin: 4px 0 0; }
    .document {
      background: var(--surface-raised);
      border-left: 3px solid var(--accent);
      border-radius: 8px;
      margin-top: 14px;
      padding: 18px;
      white-space: pre-wrap;
    }
    .question, .next { margin: 0; white-space: pre-wrap; }
    @media (max-width: 680px) { .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <header>
      <div class="eyebrow">Meeting summary</div>
      <h1>${esc(room.name)}</h1>
      <p class="subtitle">${esc(outcome.title)}</p>
    </header>
    <div class="grid">
      <section>
        <h2>Attendees</h2>
        <ul>${attendees}</ul>
      </section>
      <section>
        <h2>The question</h2>
        <p class="question">${esc(room.topic ?? "No room topic was recorded.")}</p>
      </section>
      <section class="wide">
        <h2>What was decided</h2>
        <div class="document">${esc(documentText)}</div>
      </section>${disagreementsSection}
      <section>
        <h2>Produced</h2>
        <ul>${produced}</ul>
      </section>${nextSection}
    </div>
  </main>
</body>
</html>`;
}
