import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
import { agoLabel } from "../relative-time.ts";
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

// One room -> one card: an identity dot toned by status, one job per encoding — the
// pill carries STATE (the status word) and the bar carries MAGNITUDE (turn progress),
// where the prior version packed both into a `done · 12/12` pill string. The numbers
// stay as a field in ink, alongside the room shape (strategy + facilitator), the
// participants, and the started-relative time. A CLOSED room adds an Open (focuses its
// transcript in the canvas drawer) and a destructive Delete (overflow, a confirm
// dialog). An ACTIVE room is status-only: it is already live in its inline panel, so a
// frozen drawer snapshot would just go stale beside it (and the delete handler refuses
// a live room anyway).
function cardFor(room: Room) {
  const tone = statusTone(room.status);
  const card = {
    title: room.name,
    dot: tone,
    pill: { label: room.status, tone },
    bar: { value: room.turnIndex, total: room.turnBudget },
    fields: [
      { label: "turns", value: `${room.turnIndex}/${room.turnBudget}` },
      // The round cursor is meaningful only for round-based strategies (it stays 0
      // for a plain sequential room), so surface it only once it has advanced.
      ...(room.round > 0 ? [{ label: "round", value: String(room.round) }] : []),
      { label: "shape", value: shapeLabel(room) },
      { label: "with", value: room.participants.join(" · ") },
      // The Room model carries only createdAt — no end/close time — so this is an
      // honest "started <relative> ago", not an invented "ended" timestamp.
      { label: "started", value: agoLabel(room.createdAt) },
    ],
  };
  return room.status === "active"
    ? card
    : { ...card, actions: [openAction(room), deleteAction(room)] };
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
      return mgr ? `build · ${mgr} manages` : "build";
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
