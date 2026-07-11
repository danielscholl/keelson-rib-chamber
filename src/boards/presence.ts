import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
import { identityToneForSlot, type Mind, type Room } from "../types.ts";

// Leaf sections only (no nested columns) — what a column may hold and what this ribbon
// emits; a leaf is assignable both at top level and inside a `columns` column.
type Section = Extract<
  CanvasBoardView["sections"][number],
  { kind: "columns" }
>["columns"][number]["sections"][number];

// Live status is per (mind × room), never per Mind: a Mind can sit in several active
// rooms at once (activeRooms is a set), so the pulse COUNTS live sessions rather than
// naming one room or pinning a single "speaking" verb — per-turn liveness stays in each
// room's own live panel.
export function buildPresenceBoard(
  minds: readonly Mind[],
  rooms: readonly Room[] = [],
): CanvasBoardView {
  const live = rooms.filter((r) => r.status === "active").length;
  const pulse = pulseSection(live);

  const assembled =
    minds.length === 0
      ? { label: "No minds yet", tone: "neutral" as CanvasTone }
      : {
          label: `${minds.length} ${minds.length === 1 ? "mind" : "minds"} convene here`,
          tone: "brand" as CanvasTone,
        };

  // No bench: the seats section needs at least one item. Retiring every Mind while a room
  // is still live is reachable (retire doesn't gate on active-room membership), so keep
  // the pulse whenever a session runs — the ribbon must never hide a live room.
  if (minds.length === 0) {
    const nudge: Section = {
      kind: "rows",
      items: [{ glyph: "neutral", text: "Author a Mind in the Roster to assemble the bench." }],
    };
    return {
      view: "board",
      header: { status: assembled },
      sections: live > 0 ? [pulse, nudge] : [nudge],
    };
  }

  // One identity seat per Mind, its hue for life (a sixth past the ramp folds to neutral
  // + name, the same rule the roster dot follows).
  const seats: Section = {
    kind: "seats",
    items: minds.map((m) => ({
      tone: identityToneForSlot(m.identitySlot),
      filled: true,
      label: m.name,
    })),
  };

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

function pulseSection(live: number): Section {
  return {
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
}
