import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
import type { PendingGenesis } from "../pending-genesis.ts";
import { GENESIS_STARTERS } from "../starters.ts";
import { identityToneForSlot, type Mind, type Room } from "../types.ts";
import {
  bootCard,
  bootSlotsFor,
  describeOwnAction,
  freeSlots,
  mindCardActions,
  starterAction,
} from "./roster.ts";

type Section = CanvasBoardView["sections"][number];

// The bench's declared capacity: four set-size tracks per row. The open seat is
// permanent furniture riding the NEXT free seat — items lay out
// minds → boot card → open seat → pad ghosts, so composing happens exactly
// where the next Mind will land and the trailing pads round the last row up to
// capacity (the bench law).
const BENCH_COLUMNS = 4;

// The Chamber panel — the surface's one focal panel: the bench itself (a seat card
// per Mind), the boot card while a genesis runs, and the open author seat, in every
// state — the cold bench renders the same grid with the seat's brief open. The
// standalone roster board (boards/roster.ts) backs the chamber-roster workflow and
// canvas view, sharing this file's card verbs and launchpad builders so the two
// benches can't drift.
export function buildChamberBoard(
  minds: readonly Mind[],
  rooms: readonly Room[] = [],
  pending: readonly PendingGenesis[] = [],
  now: number = Date.now(),
): CanvasBoardView {
  const live = rooms.filter((r) => r.status === "active");

  const assembled =
    minds.length === 0
      ? {
          label: pending.length > 0 ? "genesis under way" : "No minds yet",
          tone: (pending.length > 0 ? "brand" : "neutral") as CanvasTone,
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
        : pending.length > 0
          ? undefined
          : "awaiting genesis";

  return {
    view: "board",
    header: { status: assembled, ...(chip ? { chip } : {}) },
    sections: benchSections(minds, rooms, pending, now),
  };
}

// Every state is the same four-track bench: seat cards, the boot card in the
// seat being taken while a genesis runs, the open author seat on the next free
// cell, and decorative pad ghosts trailing — never stretched, never withheld.
function benchSections(
  minds: readonly Mind[],
  rooms: readonly Room[],
  pending: readonly PendingGenesis[],
  now: number,
): Section[] {
  // readMinds is newest-first; the bench seats in arrival order — a Mind boots
  // into the leftmost open seat and stays there. Landed Minds group before pending
  // boot cards, so a genesis that lands out of authoring order can take an earlier
  // cell than a still-booting sibling; a shared reservation key would pin the cell
  // across the pending->landed hop — tracked as follow-up. Concurrent geneses each
  // hold a boot card, in the order they were authored (see bootSlotsFor for hues).
  const slots = bootSlotsFor(pending, minds);
  const seats = [
    ...[...minds].reverse().map((m) => seatCard(m, rooms)),
    ...pending.map((p, i) => bootCard(p, slots[i] ?? -1, now)),
  ];
  // Trailing pads round the last row up to capacity so the bench always reads
  // as full rows of seats; they carry nothing and place nothing.
  const pads = (BENCH_COLUMNS - ((seats.length + 1) % BENCH_COLUMNS)) % BENCH_COLUMNS;
  const sections: Section[] = [
    {
      kind: "cards",
      grid: true,
      columns: BENCH_COLUMNS,
      items: [
        ...seats,
        openSeat(minds, pending),
        ...Array.from({ length: pads }, () => ({ title: "Empty seat", ghost: true })),
      ],
    },
  ];
  if (minds.length === 1 && pending.length === 0) {
    sections.push({
      kind: "rows",
      items: [
        { glyph: "neutral", text: "Seat a second Mind to convene a Room.", trailing: "next" },
      ],
    });
  }
  return sections;
}

// One Mind -> one seat card: identity dot, the role pill wearing the same hue,
// the mission stanza (authored at genesis; pre-mission Minds fall back to the
// roster tagline), a room-scoped status footer, and the shared management verbs.
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
    fields: [{ value: mission(mind.mission?.trim() || mind.persona) }, status],
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

// The permanent open seat: the freeform brief plus the free starter voices. The
// brief's form is ALWAYS open — the seat IS the genesis form, wearing the same
// layout in every state so authoring never shape-shifts as the bench fills.
// While geneses run the seat keeps rendering (parallel authoring is supported —
// one marker per run), but every booting starter and every hue a boot card is
// taking are withheld so the seat can't offer a voice already being authored or
// preview a lie.
function openSeat(minds: readonly Mind[], pending: readonly PendingGenesis[]) {
  const seated = new Set(minds.map((m) => m.slug));
  for (const p of pending) {
    const starter = p.name ? GENESIS_STARTERS.find((s) => s.name === p.name) : undefined;
    if (starter) seated.add(starter.slug);
  }
  const free = new Set(freeSlots(minds));
  for (const slot of bootSlotsFor(pending, minds)) free.delete(slot);
  const starters =
    free.size > 0
      ? GENESIS_STARTERS.filter((s) => !seated.has(s.slug)).map((s) => starterAction(s, free))
      : [];
  return {
    title: "Open seat",
    ghost: true,
    footnote: "author a Mind, or seat a starter",
    actions: [describeOwnAction(), ...starters],
  };
}
