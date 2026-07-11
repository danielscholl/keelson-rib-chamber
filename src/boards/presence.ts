import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
import { identityToneForSlot, type Mind, type Room } from "../types.ts";

// Pure: the bench (Minds) + the rooms -> the Presence ribbon that leads the Chamber
// surface. Two registers side by side: the BENCH (one identity seat per Mind, its
// seat-for-life hue) and the LIVE PULSE (how many rooms are in session right now).
// "Present" here is bench identity — a Mind exists on the bench whether or not a room
// is running — so it stays honest under concurrency: a Mind can sit in several active
// rooms at once (activeRooms is a set), and the ribbon never collapses that into one
// per-Mind verb. The pulse counts sessions, not a single room; "who is speaking" stays
// in each room's own live panel, where it is unambiguous. Validated against
// canvasViewSchema in tests; the producer never parses (validation lives at the
// binding edge, like every other board).
export function buildPresenceBoard(
  minds: readonly Mind[],
  rooms: readonly Room[] = [],
): CanvasBoardView {
  const live = rooms.filter((r) => r.status === "active").length;

  const assembled =
    minds.length === 0
      ? { label: "No minds yet", tone: "neutral" as CanvasTone }
      : {
          label: `${minds.length} ${minds.length === 1 ? "mind" : "minds"} convene here`,
          tone: "brand" as CanvasTone,
        };

  // Cold start: the seats section needs at least one item, so a benchless Chamber is a
  // single calm line pointing at genesis rather than an empty identity row.
  if (minds.length === 0) {
    return {
      view: "board",
      header: { status: assembled },
      sections: [
        {
          kind: "rows",
          items: [{ glyph: "neutral", text: "Author a Mind in the Roster to assemble the bench." }],
        },
      ],
    };
  }

  // The bench: one identity seat per Mind, its hue for life (a sixth past the ramp
  // folds to neutral + name, the same rule the roster dot follows).
  const seats: CanvasBoardView["sections"][number] = {
    kind: "seats",
    items: minds.map((m) => ({
      tone: identityToneForSlot(m.identitySlot),
      filled: true,
      label: m.name,
    })),
  };

  // The live pulse: one stat that reads honestly at zero. A COUNT, not a room name —
  // a Mind may be seated in several concurrent rooms, so the ribbon counts sessions and
  // leaves "which room" to the Rooms region and each room's own live panel.
  const pulse: CanvasBoardView["sections"][number] = {
    kind: "stats",
    items: [
      live > 0
        ? {
            label: "Live now",
            value: `${live} ${live === 1 ? "room" : "rooms"}`,
            sub: "in session",
            tone: "info" as CanvasTone,
          }
        : {
            label: "Live now",
            value: "no room",
            sub: "on the bench",
            tone: "neutral" as CanvasTone,
          },
    ],
  };

  // Side by side: the bench reads left (identity), the pulse right (what is live).
  return {
    view: "board",
    header: { status: assembled },
    sections: [
      {
        kind: "columns",
        columns: [
          { weight: 3, sections: [seats] },
          { weight: 1, sections: [pulse] },
        ],
      },
    ],
  };
}
