import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
import { relativeAgo } from "../relative-time.ts";
import type { Room } from "../types.ts";

// Pure: the persisted rooms -> a canvas `board`. Active rooms come first (most
// relevant), then closed (done/stopped) history; listRooms is already newest-first
// so order is preserved within each group. An active room ALSO keeps its live inline
// per-slug panel (reconcileRoomPanels), so its index card is additive and status-only
// (no actions). A closed card offers Open (-> the room in the canvas drawer) and a
// destructive Delete. No rooms at all renders a cold/empty state. Validated against
// canvasViewSchema in tests; the producer never parses (validation lives at the
// binding edge).
export function buildRoomsIndexBoard(rooms: readonly Room[]): CanvasBoardView {
  const active = rooms.filter((r) => r.status === "active");
  const closed = rooms.filter((r) => r.status !== "active");
  const ordered = [...active, ...closed];

  const sections: CanvasBoardView["sections"] =
    ordered.length === 0 ? emptySections() : [{ kind: "cards", items: ordered.map(cardFor) }];

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

// One room -> one card: an identity dot toned by status, the
// `<status> · <turnIndex>/<turnBudget>` progress in a status-toned pill, and
// participants + the started-relative time as fields. A CLOSED room adds an Open
// (focuses its transcript in the canvas drawer) and a destructive Delete (overflow,
// typed-irreversible confirm). An ACTIVE room is status-only: it is already live in
// its inline panel, so a frozen drawer snapshot would just go stale beside it (and
// the delete handler refuses a live room anyway).
function cardFor(room: Room) {
  const card = {
    title: room.name,
    dot: statusTone(room.status),
    pill: {
      label: `${room.status} · ${room.turnIndex}/${room.turnBudget}`,
      tone: statusTone(room.status),
    },
    fields: [
      { label: "with", value: room.participants.join(" · ") },
      // The Room model carries only createdAt — no end/close time — so this is an
      // honest "started <relative> ago", not an invented "ended" timestamp.
      { label: "started", value: `${relativeAgo(room.createdAt)} ago` },
    ],
  };
  return room.status === "active"
    ? card
    : { ...card, actions: [openAction(room), deleteAction(room)] };
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
      irreversible: true,
      subject: room.slug,
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
          text: "No sessions yet. Convene a Room from the Roster; it appears here while live, and stays as history once it ends.",
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
