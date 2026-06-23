import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
import type { Room } from "../types.ts";

// Pure: the persisted rooms -> a canvas `board` that is the HISTORY of ENDED
// rooms. Active rooms keep their live inline per-slug panels (reconcileRoomPanels)
// and never appear here, so the index filters to closed (done/stopped) rooms only.
// No closed rooms renders a cold/empty state; otherwise one card per closed room,
// newest-first, each with a destructive Delete. Validated against canvasViewSchema
// in tests; the producer never parses (validation lives at the binding edge).
export function buildRoomsIndexBoard(rooms: readonly Room[]): CanvasBoardView {
  // Closed = done/stopped. listRooms is already newest-first, so this preserves
  // that order. A live room is surfaced by its own inline panel, not as a card.
  const closed = rooms.filter((r) => r.status !== "active");

  const sections: CanvasBoardView["sections"] =
    closed.length === 0 ? emptySections() : [{ kind: "cards", items: closed.map(cardFor) }];

  return {
    view: "board",
    title: "Rooms",
    header: {
      status: {
        label: `${closed.length} ${closed.length === 1 ? "session" : "sessions"}`,
        tone: "brand" as CanvasTone,
      },
      chip: "sessions",
    },
    sections,
  };
}

// One closed room -> one card: an identity dot toned by status, the
// `<status> · <turnIndex>/<turnBudget>` progress in a status-toned pill,
// participants and the started-relative time as fields, and a destructive Delete
// (an overflow action with a typed irreversible confirm). The slug rides the
// Delete payload.
function cardFor(room: Room) {
  return {
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
    actions: [
      {
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
      },
    ],
  };
}

// The empty/cold state: a single rows hint, so the region is a valid board even
// with no ended sessions yet (a fresh Chamber, or only live rooms running).
function emptySections(): CanvasBoardView["sections"] {
  return [
    {
      kind: "rows",
      items: [
        {
          glyph: "neutral",
          text: "No past sessions yet. Convene a Room from the Roster; once it ends it lands here, where you can delete it.",
        },
      ],
    },
  ];
}

// A closed room reads ok (done) or warn (stopped); active never appears here but
// is mapped for exhaustiveness (info, matching boards/room.ts's statusTone).
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

// A coarse "<n> <unit>" relative span from an ISO timestamp to now — enough for a
// card's "started … ago". Floors to the largest whole unit; an unparseable or
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
