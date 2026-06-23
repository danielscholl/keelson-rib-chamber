import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
import { stableHash } from "../genesis.ts";
import type { LensRecord } from "../lens-store.ts";

// The full canvas tone ramp, used to give each lens a deterministic identity dot
// hashed from its id — a stable per-lens hue (the roster's dotFor idiom), so cards
// read as distinct.
const DOT_TONES = [
  "ok",
  "warn",
  "error",
  "info",
  "caution",
  "brand",
  "accent",
  "neutral",
] as const satisfies readonly CanvasTone[];

// stableHash returns a base-36 string; parsing it back at radix 36 recovers the
// integer to mod across the ramp, so distinct ids spread across the tones.
function dotFor(id: string): CanvasTone {
  return DOT_TONES[Number.parseInt(stableHash(id), 36) % DOT_TONES.length]!;
}

// Pure: the persisted lenses -> a canvas `board` index of LIVING views, one card
// per lens (listLenses is already newest-first). Each card is THIN and honest: only
// data emit actually captures — the board title and a server-stamped freshness —
// with Open (the lens is live the whole time it exists, so its key always resolves)
// and a destructive Retire. scope / maintaining-Mind / reason stay OMITTED: emit
// captures only { id, board }, so surfacing them would be invented data. No lenses
// renders a single rows hint. Validated against canvasViewSchema in tests; the
// producer never parses (validation lives at the binding edge).
export function buildLensesIndexBoard(lenses: readonly LensRecord[]): CanvasBoardView {
  const sections: CanvasBoardView["sections"] =
    lenses.length === 0 ? emptySections() : [{ kind: "cards", items: lenses.map(cardFor) }];

  return {
    view: "board",
    title: "Lenses",
    header: {
      status: {
        label: `${lenses.length} ${lenses.length === 1 ? "lens" : "lenses"}`,
        tone: "accent" as CanvasTone,
      },
      chip: "library",
    },
    sections,
  };
}

// One lens -> one card: a hashed identity dot, the authored board title (or the id
// when untitled), the server-stamped freshness as the one field, and two actions —
// Open (the primary, non-destructive verb the host renders inline; the live key
// always resolves) and Retire (a destructive overflow action with a typed
// irreversible confirm). The id rides both action payloads + the dot hash. scope /
// by-Mind / reason are OMITTED — emit doesn't capture them.
function cardFor(lens: LensRecord) {
  const title = lens.board.title || lens.id;
  return {
    title,
    dot: dotFor(lens.id),
    fields: [{ label: "updated", value: `${relativeAgo(lens.updatedAt)} ago` }],
    actions: [
      {
        type: "lens-open",
        label: "Open",
        glyph: "↗",
        payload: { id: lens.id },
      },
      {
        type: "retire-lens",
        label: "Retire lens…",
        glyph: "✕",
        tone: "warn" as CanvasTone,
        destructive: true,
        payload: { id: lens.id },
        confirm: {
          irreversible: true,
          subject: lens.id,
          title: "Retire lens",
          body: `Retire ${title}? This permanently removes the lens.`,
          confirmLabel: "Retire",
          cancelLabel: "Cancel",
        },
      },
    ],
  };
}

// The empty/cold state: a single rows hint, so the region is a valid board even
// with no lenses yet (a fresh Chamber, or every lens retired).
function emptySections(): CanvasBoardView["sections"] {
  return [
    {
      kind: "rows",
      items: [
        {
          glyph: "neutral",
          text: "No lenses yet — a Mind authors one with /workflow run chamber-lens <subject>.",
        },
      ],
    },
  ];
}

// A coarse "<n> <unit>" relative span from an ISO timestamp to now — enough for a
// card's "updated … ago". Floors to the largest whole unit; an unparseable or
// future timestamp degrades to "just now" rather than a negative/NaN span.
function relativeAgo(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  const deltaMs = Number.isFinite(then) ? now - then : 0;
  if (deltaMs < 60_000) return "just now";
  const units: [number, string][] = [
    [86_400_000, "day"],
    [3_600_000, "hour"],
    [60_000, "minute"],
  ];
  for (const [ms, unit] of units) {
    const n = Math.floor(deltaMs / ms);
    if (n >= 1) return `${n} ${unit}${n === 1 ? "" : "s"}`;
  }
  return "just now";
}
