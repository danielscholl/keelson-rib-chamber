import type { CanvasBoardView, CanvasPerson, CanvasTone } from "@keelson/shared";
import { isExhibit, type LensRecord } from "../lens-store.ts";
import { agoLabel } from "../relative-time.ts";
import { turnsLabel } from "../room-text.ts";
import { identityToneForSlot, type Mind, type Room } from "../types.ts";

// Pure: the persisted rooms -> a canvas `board`. Active rooms come first (most
// relevant), then closed (done/stopped) history; listRooms is already newest-first
// so order is preserved within each group. Every card offers Open (-> the room in the
// canvas drawer); a closed card adds a destructive Delete. No rooms at all renders a
// cold/empty state. `minds` resolves
// each participant slug to its Mind's display name + identity tone for the `with`
// people field; absent (a standalone call) the cast folds to bare slugs with the
// muted dot, mirroring lenses.ts's maintainer fold. `lenses` may be the raw
// store listing — the builder keeps only the exhibit kind itself (the invariant
// lives in the mechanism, not in each caller) and joins on the driver-witnessed
// sourceRoom SLUG, so a card NAMES the deliverables the room tabled and its delete
// dialog can count them. Reaching one is the room's own job: you open the room and
// its board lists them. Validated against canvasViewSchema in tests; the producer
// never parses (validation lives at the binding edge).
export function buildRoomsIndexBoard(
  rooms: readonly Room[],
  minds: readonly Mind[] = [],
  lenses: readonly LensRecord[] = [],
  outcomeSlugs: ReadonlySet<string> = new Set(),
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
      ? []
      : [
          {
            kind: "cards",
            items: ordered.map((r) =>
              cardFor(r, bySlug, tabledByRoom.get(r.slug) ?? [], outcomeSlugs),
            ),
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
// started-relative time. EVERY room offers an Open — a closed room's drawer holds its
// frozen transcript, a live room's streams turns as they land (roomOpenAction picks the
// key). Only a closed room adds the destructive Delete (overflow, a confirm dialog): the
// handler refuses a live room, so offering it would only promise a refusal.
function cardFor(
  room: Room,
  bySlug: ReadonlyMap<string, Mind>,
  tabled: readonly LensRecord[],
  outcomeSlugs: ReadonlySet<string>,
) {
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
      // lists its deliverables. Toned rather than pilled — the card's one pill
      // slot carries STATE, and a count keeps the footprint flat past one.
      ...(tabled.length > 0
        ? [
            {
              label: "tabled",
              value:
                tabled.length === 1
                  ? tabled[0]?.board.title || tabled[0]?.id
                  : `${tabled.length} exhibits`,
              tone: "accent" as CanvasTone,
            },
          ]
        : []),
    ],
  };
  if (room.status === "active") return { ...card, actions: [openAction(room)] };
  return {
    ...card,
    actions: [
      openAction(room),
      ...(outcomeSlugs.has(room.slug) ? [summaryAction(room)] : []),
      deleteAction(room, tabled),
    ],
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

function summaryAction(room: Room) {
  return {
    type: "room-summary",
    label: "Summary",
    glyph: "☰",
    payload: { slug: room.slug },
  };
}

// The delete cascades to the room's exhibits, so the dialog counts them: it is the only
// consent gate on the board path, and the operator reads its enumeration as the whole
// blast radius. A room that tabled nothing says nothing about exhibits.
function deleteAction(room: Room, tabled: readonly LensRecord[]) {
  const body =
    tabled.length === 0
      ? `Delete ${room.name}? This permanently removes the session and its transcript.`
      : `Delete ${room.name}? This permanently removes the session, its transcript, and the ${tabled.length} ${tabled.length === 1 ? "exhibit" : "exhibits"} it tabled.`;
  return {
    type: "room-delete",
    label: "Delete room…",
    glyph: "✕",
    tone: "warn" as CanvasTone,
    destructive: true,
    payload: { slug: room.slug },
    confirm: {
      title: "Delete room",
      body,
      confirmLabel: "Delete",
      cancelLabel: "Cancel",
    },
  };
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
