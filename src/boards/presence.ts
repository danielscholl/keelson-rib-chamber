import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
import type { PendingGenesis } from "../pending-genesis.ts";
import { GENESIS_STARTERS } from "../starters.ts";
import { identityToneForSlot, type Mind, type Room } from "../types.ts";
import {
  bootCard,
  bootSlotFor,
  describeOwnAction,
  freeSlots,
  launchpadSections,
  mindCardActions,
  starterAction,
} from "./roster.ts";

type Section = CanvasBoardView["sections"][number];

// The Chamber panel — the surface's one focal panel: the bench itself (a seat card
// per Mind), the boot card while a genesis runs, and the authoring launchpad. The
// standalone roster board (boards/roster.ts) backs the chamber-roster workflow and
// canvas view, sharing this file's card verbs and launchpad builders so the two
// benches can't drift.
export function buildChamberBoard(
  minds: readonly Mind[],
  rooms: readonly Room[] = [],
  pending: PendingGenesis | null = null,
  now: number = Date.now(),
): CanvasBoardView {
  const live = rooms.filter((r) => r.status === "active");

  const assembled =
    minds.length === 0
      ? {
          label: pending ? "genesis under way" : "No minds yet",
          tone: (pending ? "brand" : "neutral") as CanvasTone,
        }
      : {
          label: minds.length === 1 ? "1 mind convenes here" : `${minds.length} minds convene here`,
          tone: "brand" as CanvasTone,
        };

  // The pulse rides the head chip, stated positively: what the bench IS doing.
  // Retiring every Mind while a room still runs is reachable, so the live count
  // outranks the empty bench — the head must never hide a live room.
  const chip =
    live.length > 0
      ? `${live.length} ${live.length === 1 ? "room" : "rooms"} · in session`
      : minds.length > 0
        ? "bench at rest"
        : undefined;

  const sections: Section[] =
    minds.length === 0 && !pending
      ? launchpadSections([], { title: "Genesis — author a Mind", rest: "awaiting genesis." })
      : seatedSections(minds, rooms, pending, now);

  return {
    view: "board",
    header: { status: assembled, ...(chip ? { chip } : {}) },
    sections,
  };
}

// >=1 Mind (or a genesis in flight): seat cards, a boot card in the seat being
// taken, the lone-Mind nudge, and the compact authoring row. The launchpad is
// withheld while a genesis runs — the boot card carries that moment.
function seatedSections(
  minds: readonly Mind[],
  rooms: readonly Room[],
  pending: PendingGenesis | null,
  now: number,
): Section[] {
  const sections: Section[] = [
    {
      kind: "cards",
      items: [
        ...minds.map((m) => seatCard(m, rooms)),
        ...(pending ? [bootCard(pending, bootSlotFor(pending, minds), now)] : []),
      ],
    },
  ];
  if (minds.length === 1 && !pending) {
    sections.push({
      kind: "rows",
      items: [
        { glyph: "neutral", text: "Seat a second Mind to convene a Room.", trailing: "next" },
      ],
    });
  }
  if (!pending) sections.push(authorRow(minds));
  return sections;
}

// One Mind -> one seat card: identity dot, the role pill wearing the same hue,
// the mission line (persona until an authored mission field lands),
// a room-scoped status footer, and the shared management verbs.
function seatCard(mind: Mind, rooms: readonly Room[]) {
  const active = rooms.filter((r) => r.status === "active" && seatsMind(r, mind.slug));
  const status =
    active.length === 0
      ? { value: "on the bench" }
      : active.length === 1
        ? { value: `in session · ${active[0]?.name}`, tone: "info" as CanvasTone }
        : { value: `active in ${active.length} rooms`, tone: "info" as CanvasTone };
  const tone = identityToneForSlot(mind.identitySlot);
  return {
    title: mind.name,
    dot: tone,
    pill: {
      label: mind.role.trim() || "Mind",
      ...(tone === "neutral" ? {} : { tone }),
    },
    // Stacked: the mission reads as its own line with the status as a quiet
    // footer beneath it, not an inline `·`-joined meta row.
    stacked: true,
    fields: [{ value: mission(mind.persona) }, status],
    actions: mindCardActions(mind),
  };
}

// Status is per (mind x room), never a global verb: a Mind can sit in several
// active rooms at once, so the footer counts sessions rather than pinning one
// "speaking" state — per-turn liveness stays in each room's own live panel.
// A moderator / synthesizer / manager seats in a room without being a participant.
function seatsMind(room: Room, slug: string): boolean {
  return (
    room.participants.includes(slug) ||
    room.config?.moderator === slug ||
    room.config?.synthesizer === slug ||
    room.config?.manager === slug
  );
}

function mission(persona: string): string {
  const trimmed = persona.trim();
  if (trimmed.length === 0) return "(no persona)";
  return trimmed.length > 200 ? `${trimmed.slice(0, 199)}…` : trimmed;
}

// The seated bench's authoring path: one wrap row — the freeform brief closed at
// rest (click opens its form; the cold-start hero stays expanded) plus the free
// starter voices, mirroring the standalone roster's launchpad rules.
function authorRow(minds: readonly Mind[]): Section {
  const seated = new Set(minds.map((m) => m.slug));
  const free = new Set(freeSlots(minds));
  const { expanded: _alwaysOpen, ...brief } = describeOwnAction();
  const starters =
    free.size > 0
      ? GENESIS_STARTERS.filter((s) => !seated.has(s.slug)).map((s) => starterAction(s, free))
      : [];
  return {
    kind: "actions",
    title: "Author another Mind",
    wrap: true,
    items: [{ ...brief, label: "Author a Mind", glyph: "＋" }, ...starters],
  };
}
