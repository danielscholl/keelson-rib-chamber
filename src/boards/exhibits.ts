import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
import type { LensRecord } from "../lens-store.ts";
import { agoLabel } from "../relative-time.ts";
import type { Room } from "../types.ts";

// Pure: the persisted exhibits -> a canvas `board` index of TABLED deliverables,
// one card per exhibit (the caller filters kind and listLenses is already
// newest-first). Unlike the lenses index, no exhibits yields ZERO sections — the
// region sets hideWhenEmpty, so the shelf only exists once a discussion has tabled
// something. Provenance is fail-soft like the lens cards: sourceRoom (the
// driver-witnessed producing room's slug) and reason each render only when
// present; `rooms` resolves the slug to the room's display name, falling back to
// the raw value (a deleted room, or a legacy record stamped with the name).
export function buildExhibitsIndexBoard(
  exhibits: readonly LensRecord[],
  rooms: readonly Room[] = [],
): CanvasBoardView {
  const roomName = new Map(rooms.map((r) => [r.slug, r.name.trim()]));
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
    sections:
      exhibits.length === 0
        ? []
        : [{ kind: "cards", items: exhibits.map((e) => cardFor(e, roomName)) }],
  };
}

// One exhibit -> one card. Provenance is fail-soft (absent on the record means
// absent on the card); Open rides lens-open because both species share the lens
// key namespace.
function cardFor(exhibit: LensRecord, roomName: ReadonlyMap<string, string>) {
  const title = exhibit.board.title || exhibit.id;
  const from = exhibit.sourceRoom
    ? roomName.get(exhibit.sourceRoom) || exhibit.sourceRoom
    : undefined;
  return {
    title,
    dot: "caution" as CanvasTone,
    fields: [
      ...(from ? [{ label: "from", value: `room · ${from}` }] : []),
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
