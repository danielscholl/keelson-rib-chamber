import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
import type { HtmlLensRecord } from "../lens-html-store.ts";
import type { LensRecord, LensRefresh } from "../lens-store.ts";
import { agoLabel } from "../relative-time.ts";
import { identityToneForSlot, type Mind } from "../types.ts";

// The two lens species flattened to what a card needs. They live in separate stores
// with separate key namespaces (so one id can name both a canvas lens and an HTML
// one), and an HTML record carries no provenance at all — it has no maintaining Mind,
// scope, or reason to show. Normalizing here keeps that asymmetry in one place instead
// of spreading `species === "html"` checks through the card builder.
interface IndexEntry {
  id: string;
  species: "canvas" | "html";
  title: string;
  updatedAt: string;
  pinned: boolean;
  refresh?: LensRefresh;
  maintainingMind?: string;
  scope?: string;
  reason?: string;
}

function canvasEntry(lens: LensRecord): IndexEntry {
  return {
    id: lens.id,
    species: "canvas",
    title: lens.board.title || lens.id,
    updatedAt: lens.updatedAt,
    pinned: lens.pinned === true,
    ...(lens.refresh ? { refresh: lens.refresh } : {}),
    ...(lens.maintainingMind ? { maintainingMind: lens.maintainingMind } : {}),
    ...(lens.scope ? { scope: lens.scope } : {}),
    ...(lens.reason ? { reason: lens.reason } : {}),
  };
}

function htmlEntry(lens: HtmlLensRecord): IndexEntry {
  return {
    id: lens.id,
    species: "html",
    title: lens.title || lens.id,
    updatedAt: lens.updatedAt,
    pinned: false,
    ...(lens.refresh ? { refresh: lens.refresh } : {}),
  };
}

// Interleave the species newest-first. Each store hands its own list already ordered,
// so this only decides where the two streams cross: ties (and an unparseable stamp)
// compare equal and a stable sort leaves them exactly as given, which is what keeps
// this builder's promise to preserve its callers' order. Re-sorting ties on the id —
// listLenses's tiebreak, which it needs because readdir order is arbitrary — would
// reorder cards its caller had already put in the right sequence.
function mergeNewestFirst(entries: IndexEntry[]): IndexEntry[] {
  return entries.sort((a, b) => {
    const delta = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    return Number.isFinite(delta) ? delta : 0;
  });
}

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
  htmlLenses: readonly HtmlLensRecord[] = [],
): CanvasBoardView {
  const tones = maintainerTones(minds);
  const entries = mergeNewestFirst([...lenses.map(canvasEntry), ...htmlLenses.map(htmlEntry)]);
  const sections: CanvasBoardView["sections"] =
    entries.length === 0
      ? []
      : [{ kind: "cards", items: entries.map((entry) => cardFor(entry, tones)) }];

  return {
    view: "board",
    title: "Lenses",
    header: {
      status: {
        label: `${entries.length} ${entries.length === 1 ? "lens" : "lenses"}`,
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
function cardFor(entry: IndexEntry, tones: Map<string, CanvasTone>) {
  const { id, title, species, pinned } = entry;
  const html = species === "html";
  // by-Mind first, then freshness — the maintainer reads ahead of "how stale". The
  // species rides a FIELD rather than the pill: only one pill fits and the pin has
  // claimed it, but the two stores have separate id spaces, so one subject can name
  // both a canvas lens and a designed page and the index must not read as duplicates.
  const fields = [
    ...(html ? [{ label: "kind", value: "page" }] : []),
    ...(entry.maintainingMind ? [{ label: "by", value: entry.maintainingMind }] : []),
    { label: "updated", value: agoLabel(entry.updatedAt) },
  ];
  return {
    title,
    dot: dotFor(entry.maintainingMind, tones),
    // The pin reads ahead of the scope: it says where the lens IS, which is what the
    // operator is scanning this index for. Only one pill fits, so a pinned lens wears
    // that rather than its authored kind.
    ...(pinned
      ? { pill: { label: "pinned", tone: "accent" as CanvasTone } }
      : entry.scope
        ? { pill: { label: entry.scope, tone: "info" as CanvasTone } }
        : {}),
    fields,
    ...(entry.reason ? { reason: { label: "changed", text: entry.reason } } : {}),
    actions: [
      {
        type: "lens-open",
        label: "Open",
        glyph: "↗",
        // The kind picks the key namespace: a page's board lives under lens-html:<id>,
        // so an unqualified open would focus a canvas key that may not exist.
        payload: { id, kind: species },
      },
      // Only a refresh-backed (living) lens offers the on-demand re-compose;
      // a plain lens changes by re-authoring, so the verb would mislead. It is also
      // the ONLY re-compose an unpinned lens has — its cadence lives on the panel.
      ...(entry.refresh
        ? [
            {
              type: "refresh-lens",
              label: "Refresh",
              glyph: "↻",
              payload: { id, kind: species },
            },
          ]
        : []),
      // One verb, label swapped, carrying the TARGET state — so a card rendered before
      // someone else's pin can't toggle against state it isn't showing. Canvas only for
      // now: an HTML lens still holds its panel unconditionally.
      ...(html
        ? []
        : [
            {
              type: "pin-lens",
              label: pinned ? "Unpin" : "Pin",
              glyph: "⊙",
              tone: "accent" as CanvasTone,
              payload: { id, pinned: !pinned },
            },
          ]),
      {
        type: html ? "retire-lens-html" : "retire-lens",
        label: "Retire lens…",
        glyph: "✕",
        tone: "warn" as CanvasTone,
        destructive: true,
        payload: { id },
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
