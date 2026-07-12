import type { CanvasBoardView, CanvasPerson, CanvasTone } from "@keelson/shared";
import { isExhibit, type LensRecord } from "../lens-store.ts";
import { agoLabel } from "../relative-time.ts";
import { turnsLabel } from "../room-text.ts";
import { identityToneForSlot, type Mind, type Room } from "../types.ts";

// Pure: the persisted rooms -> a canvas `board`. Active rooms come first (most
// relevant), then closed (done/stopped) history; listRooms is already newest-first
// so order is preserved within each group. An active room ALSO keeps its live inline
// per-slug panel (reconcileRoomPanels), so its index card is additive and status-only
// (no actions). A closed card offers Open (-> the room in the canvas drawer) and a
// destructive Delete. No rooms at all renders a cold/empty state. `minds` resolves
// each participant slug to its Mind's display name + identity tone for the `with`
// people field; absent (a standalone call) the cast folds to bare slugs with the
// muted dot, mirroring lenses.ts's maintainer fold. `lenses` may be the raw
// store listing — the builder keeps only the exhibit kind itself (the invariant
// lives in the mechanism, not in each caller) and joins on the driver-witnessed
// sourceRoom SLUG: a card lists the deliverables the room tabled, and a closed
// card links each one open. Validated against canvasViewSchema in tests; the
// producer never parses (validation lives at the binding edge).
export function buildRoomsIndexBoard(
  rooms: readonly Room[],
  minds: readonly Mind[] = [],
  lenses: readonly LensRecord[] = [],
): CanvasBoardView {
  const active = rooms.filter((r) => r.status === "active");
  const closed = rooms.filter((r) => r.status !== "active");
  const ordered = [...active, ...closed];
  const bySlug = new Map(minds.map((m) => [m.slug, m]));
  const tabledByRoom = new Map<string, LensRecord[]>();
  for (const record of lenses) {
    if (!isExhibit(record) || !record.sourceRoom) continue;
    const list = tabledByRoom.get(record.sourceRoom) ?? [];
    list.push(record);
    tabledByRoom.set(record.sourceRoom, list);
  }

  const sections: CanvasBoardView["sections"] =
    ordered.length === 0
      ? emptySections()
      : [
          {
            kind: "cards",
            items: ordered.map((r) => cardFor(r, bySlug, tabledByRoom.get(r.slug) ?? [])),
          },
        ];

  return {
    view: "board",
    title: "Rooms",
    header: {
      status: {
        label: `${ordered.length} ${ordered.length === 1 ? "session" : "sessions"}`,
        tone: "brand" as CanvasTone,
      },
      chip: "sessions",
    },
    sections,
  };
}

// One participant slug -> a people entry: the Mind's display name wearing its
// identity tone while the slug still resolves against the roster; a retired or
// unknown slug stays as the slug with no tone (the muted dot).
function personFor(slug: string, bySlug: ReadonlyMap<string, Mind>): CanvasPerson {
  const mind = bySlug.get(slug);
  if (!mind) return { name: slug };
  return { name: mind.name, tone: identityToneForSlot(mind.identitySlot) };
}

// One room -> one card: an identity dot toned by status, one job per encoding — the
// pill carries STATE (the status word) and the bar carries MAGNITUDE (turn progress),
// where the prior version packed both into a `done · 12/12` pill string. The numbers
// stay as a field in ink, alongside the room shape (strategy + facilitator), the
// cast (a people field — each name in its Mind's identity hue), and the
// started-relative time. A CLOSED room adds an Open (focuses its transcript in the
// canvas drawer) and a destructive Delete (overflow, a confirm dialog). An ACTIVE
// room is status-only: it is already live in its inline panel, so a frozen drawer
// snapshot would just go stale beside it (and the delete handler refuses a live
// room anyway).
function cardFor(room: Room, bySlug: ReadonlyMap<string, Mind>, tabled: readonly LensRecord[]) {
  const tone = statusTone(room.status);
  const cappedTurnIndex = Math.min(room.turnIndex, room.turnBudget);
  const card = {
    title: room.name,
    dot: tone,
    pill: { label: room.status, tone },
    bar: { value: cappedTurnIndex, total: room.turnBudget },
    fields: [
      { label: "turns", value: turnsLabel(room.turnIndex, room.turnBudget) },
      // The round cursor is meaningful only for round-based strategies (it stays 0
      // for a plain sequential room), so surface it only once it has advanced.
      ...(room.round > 0 ? [{ label: "round", value: String(room.round) }] : []),
      { label: "shape", value: shapeLabel(room) },
      // A people field rejects an empty list, so a drifted no-participant record
      // simply omits the cast rather than failing the whole board's validation.
      ...(room.participants.length > 0
        ? [{ label: "with", people: room.participants.map((p) => personFor(p, bySlug)) }]
        : []),
      // The Room model carries only createdAt — no end/close time — so this is an
      // honest "started <relative> ago", not an invented "ended" timestamp.
      { label: "started", value: agoLabel(room.createdAt) },
      // The exhibits this room tabled (driver-witnessed sourceRoom), so the
      // provenance link reads both ways: the exhibit names its room, the room
      // lists its deliverables.
      ...(tabled.length > 0
        ? [{ label: "tabled", value: tabled.map((e) => e.board.title || e.id).join(" · ") }]
        : []),
    ],
  };
  if (room.status === "active") return card;
  // Closed rooms link each tabled exhibit open ahead of the room verbs — the
  // deliverable is usually what you came back for, the transcript second.
  return {
    ...card,
    actions: [...tabled.map((e) => openExhibitAction(e)), openAction(room), deleteAction(room)],
  };
}

function openExhibitAction(exhibit: LensRecord) {
  return {
    type: "lens-open",
    label: `▣ ${exhibit.board.title || exhibit.id}`,
    payload: { id: exhibit.id },
  };
}

// The room's shape named for the meta line: the strategy in plain words, plus the
// facilitator a moderated/managed room routes through — so the index reads how a room
// runs, not just that it exists.
function shapeLabel(room: Room): string {
  const mod = room.config?.moderator;
  const mgr = room.config?.manager;
  switch (room.strategy) {
    case "group-chat":
      return mod ? `debate · ${mod} moderates` : "debate";
    case "magentic":
      return mgr ? `delegate · ${mgr} manages` : "delegate";
    case "open-floor":
      return "open floor";
    case "review":
      return "review";
    case "concurrent":
      return "concurrent";
    default:
      return "discussion";
  }
}

function openAction(room: Room) {
  return {
    type: "room-open",
    label: "Open",
    glyph: "↗",
    payload: { slug: room.slug },
  };
}

function deleteAction(room: Room) {
  return {
    type: "room-delete",
    label: "Delete room…",
    glyph: "✕",
    tone: "warn" as CanvasTone,
    destructive: true,
    payload: { slug: room.slug },
    confirm: {
      title: "Delete room",
      body: `Delete ${room.name}? This permanently removes the session and its transcript.`,
      confirmLabel: "Delete",
      cancelLabel: "Cancel",
    },
  };
}

// The empty/cold state: a single rows hint, so the region is a valid board even
// with no rooms yet (a fresh Chamber).
function emptySections(): CanvasBoardView["sections"] {
  return [
    {
      kind: "rows",
      items: [
        {
          glyph: "neutral",
          text: "No sessions yet. Convene a Room above; it appears here while live, and stays as history once it ends.",
        },
      ],
    },
  ];
}

// active reads info (live), stopped warn, done ok — matching boards/room.ts.
function statusTone(status: Room["status"]): CanvasTone {
  switch (status) {
    case "active":
      return "info";
    case "stopped":
      return "warn";
    default:
      return "ok";
  }
}
