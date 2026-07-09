import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
import type { LensRecord } from "../lens-store.ts";
import { agoLabel } from "../relative-time.ts";

// Pure: the persisted exhibits -> a canvas `board` index of TABLED deliverables,
// one card per exhibit (the caller filters kind and listLenses is already
// newest-first). Unlike the lenses index, no exhibits yields ZERO sections — the
// region sets hideWhenEmpty, so the shelf only exists once a discussion has tabled
// something. Provenance is fail-soft like the lens cards: sourceRoom (the
// driver-witnessed producing room) and reason each render only when present.
export function buildExhibitsIndexBoard(exhibits: readonly LensRecord[]): CanvasBoardView {
  return {
    view: "board",
    title: "Exhibits",
    header: {
      status: {
        label: `${exhibits.length} ${exhibits.length === 1 ? "exhibit" : "exhibits"}`,
        tone: "caution" as CanvasTone,
      },
      chip: "archive",
    },
    sections: exhibits.length === 0 ? [] : [{ kind: "cards", items: exhibits.map(cardFor) }],
  };
}

// One exhibit -> one card: the tabled board's title (or the id when untitled), the
// producing room as a "from" field when the driver witnessed one, the tabling time,
// the emit's reason as a "gist" line, and two actions — Open (the live key always
// resolves; exhibits share the lens key namespace so lens-open covers both) and a
// destructive Delete with a confirm dialog.
function cardFor(exhibit: LensRecord) {
  const title = exhibit.board.title || exhibit.id;
  return {
    title,
    dot: "caution" as CanvasTone,
    fields: [
      ...(exhibit.sourceRoom ? [{ label: "from", value: `room · ${exhibit.sourceRoom}` }] : []),
      { label: "tabled", value: agoLabel(exhibit.updatedAt) },
    ],
    ...(exhibit.reason ? { reason: { label: "gist", text: exhibit.reason } } : {}),
    actions: [
      {
        type: "lens-open",
        label: "Open",
        glyph: "↗",
        payload: { id: exhibit.id },
      },
      {
        type: "delete-exhibit",
        label: "Delete exhibit…",
        glyph: "✕",
        tone: "warn" as CanvasTone,
        destructive: true,
        payload: { id: exhibit.id },
        confirm: {
          title: "Delete exhibit",
          body: `Delete ${title}? This permanently removes the exhibit.`,
          confirmLabel: "Delete",
          cancelLabel: "Cancel",
        },
      },
    ],
  };
}
