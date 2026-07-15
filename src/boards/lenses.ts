import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
import type { LensRecord } from "../lens-store.ts";
import { agoLabel } from "../relative-time.ts";
import { identityToneForSlot, type Mind } from "../types.ts";

// A lens's dot carries the identity of the Mind that MAINTAINS it (keelson#390),
// never a hash across the status ramp — a lens could otherwise wear error-red for no
// reason on the one surface that just adopted seat-for-life identity. maintainingMind
// is free text (a name or slug the agent supplied); resolve it against the roster,
// keyed on both, and fold an unknown/absent maintainer to neutral.
function maintainerTones(minds: readonly Mind[]): Map<string, CanvasTone> {
  const map = new Map<string, CanvasTone>();
  for (const m of minds) {
    const tone = identityToneForSlot(m.identitySlot);
    map.set(m.slug, tone);
    map.set(m.name.toLowerCase(), tone);
  }
  return map;
}

function dotFor(maintainingMind: string | undefined, tones: Map<string, CanvasTone>): CanvasTone {
  if (!maintainingMind) return "neutral";
  const key = maintainingMind.trim();
  return tones.get(key) ?? tones.get(key.toLowerCase()) ?? "neutral";
}

// Pure: the persisted lenses -> a canvas `board` index of LIVING views, one card
// per lens (listLenses is already newest-first). Each card carries the lens's
// title, its maintaining Mind's identity dot, a server-stamped freshness, and
// whatever PROVENANCE the authoring emit supplied (scope / maintaining-Mind / reason),
// plus Open (the lens is live the whole time it exists, so its key always resolves)
// and a destructive Retire. The provenance is fail-soft: a field the agent omitted is
// omitted from the card, so an emit of just { id, board } yields the plain title +
// freshness card (and a neutral dot). `minds` resolves the maintainer's tone; absent
// (a standalone call) folds every dot to neutral. No lenses renders ZERO sections — an
// empty library is just its header, like the Rooms index.
// Validated against canvasViewSchema in tests; the producer never parses.
export function buildLensesIndexBoard(
  lenses: readonly LensRecord[],
  minds: readonly Mind[] = [],
): CanvasBoardView {
  const tones = maintainerTones(minds);
  const sections: CanvasBoardView["sections"] =
    lenses.length === 0
      ? []
      : [{ kind: "cards", items: lenses.map((lens) => cardFor(lens, tones)) }];

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

// One lens -> one card: its maintaining Mind's identity dot (neutral when unknown),
// the authored board title (or the id when untitled), the emit's provenance where
// present (scope as a calm pill, maintaining-Mind as a "by" field, the change note as
// the reason line), the server-stamped freshness as a field, and two actions — Open
// (the primary, non-destructive verb the host renders inline; the live key always
// resolves) and Retire (a destructive overflow action with a confirm dialog). The id
// rides both action payloads. Each provenance bit is fail-soft: absent on the record
// means absent on the card.
function cardFor(lens: LensRecord, tones: Map<string, CanvasTone>) {
  const title = lens.board.title || lens.id;
  const pinned = lens.pinned === true;
  // by-Mind first, then freshness — the maintainer reads ahead of "how stale".
  const fields = [
    ...(lens.maintainingMind ? [{ label: "by", value: lens.maintainingMind }] : []),
    { label: "updated", value: agoLabel(lens.updatedAt) },
  ];
  return {
    title,
    dot: dotFor(lens.maintainingMind, tones),
    // The pin reads ahead of the scope: it says where the lens IS, which is what the
    // operator is scanning this index for. Only one pill fits, so a pinned lens wears
    // that rather than its authored kind.
    ...(pinned
      ? { pill: { label: "pinned", tone: "accent" as CanvasTone } }
      : lens.scope
        ? { pill: { label: lens.scope, tone: "info" as CanvasTone } }
        : {}),
    fields,
    ...(lens.reason ? { reason: { label: "changed", text: lens.reason } } : {}),
    actions: [
      {
        type: "lens-open",
        label: "Open",
        glyph: "↗",
        payload: { id: lens.id },
      },
      // Only a refresh-backed (living) lens offers the on-demand re-compose;
      // a plain lens changes by re-authoring, so the verb would mislead. It is also
      // the ONLY re-compose an unpinned lens has — its cadence lives on the panel.
      ...(lens.refresh
        ? [
            {
              type: "refresh-lens",
              label: "Refresh",
              glyph: "↻",
              payload: { id: lens.id },
            },
          ]
        : []),
      // One verb, label swapped, carrying the TARGET state — so a card rendered before
      // someone else's pin can't toggle against state it isn't showing.
      {
        type: "pin-lens",
        label: pinned ? "Unpin" : "Pin",
        glyph: "⊙",
        tone: "accent" as CanvasTone,
        payload: { id: lens.id, pinned: !pinned },
      },
      {
        type: "retire-lens",
        label: "Retire lens…",
        glyph: "✕",
        tone: "warn" as CanvasTone,
        destructive: true,
        payload: { id: lens.id },
        confirm: {
          title: "Retire lens",
          body: `Retire ${title}? This permanently removes the lens.`,
          confirmLabel: "Retire",
          cancelLabel: "Cancel",
        },
      },
    ],
  };
}
