import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
import { stableHash } from "../genesis.ts";
import type { LensRecord } from "../lens-store.ts";
import { relativeAgo } from "../relative-time.ts";

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
// per lens (listLenses is already newest-first). Each card carries the lens's
// title, a server-stamped freshness, and whatever PROVENANCE the authoring emit
// supplied (scope / maintaining-Mind / reason), plus Open (the lens is live the
// whole time it exists, so its key always resolves) and a destructive Retire. The
// provenance is fail-soft: a field the agent omitted is omitted from the card, so
// an emit of just { id, board } yields the plain title + freshness card. No lenses
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
// when untitled), the emit's provenance where present (scope as a calm pill,
// maintaining-Mind as a "by" field, the change note as the reason line), the
// server-stamped freshness as a field, and two actions — Open (the primary,
// non-destructive verb the host renders inline; the live key always resolves) and
// Retire (a destructive overflow action with a typed irreversible confirm). The id
// rides both action payloads + the dot hash. Each provenance bit is fail-soft:
// absent on the record means absent on the card.
function cardFor(lens: LensRecord) {
  const title = lens.board.title || lens.id;
  // by-Mind first, then freshness — the maintainer reads ahead of "how stale".
  const fields = [
    ...(lens.maintainingMind ? [{ label: "by", value: lens.maintainingMind }] : []),
    { label: "updated", value: `${relativeAgo(lens.updatedAt)} ago` },
  ];
  return {
    title,
    dot: dotFor(lens.id),
    ...(lens.scope ? { pill: { label: lens.scope, tone: "info" as CanvasTone } } : {}),
    fields,
    ...(lens.reason ? { reason: { label: "changed", text: lens.reason } } : {}),
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
