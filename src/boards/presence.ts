import type { CanvasActionItem, CanvasBoardView, CanvasTone } from "@keelson/shared";
import type { PendingGenesis } from "../pending-genesis.ts";
import { GENESIS_STARTERS } from "../starters.ts";
import { identityToneForSlot, type Mind, type Room } from "../types.ts";
import { type ConveneProject, conveneShapeSection } from "./convene.ts";
import {
  bootCard,
  bootSlotsFor,
  describeOwnAction,
  freeSlots,
  mindCardActions,
  starterAction,
} from "./roster.ts";

type Section = CanvasBoardView["sections"][number];

// The convene draft the bench reads to render assembly — whether the composer is
// open and which Minds sit at the table. A structural shape (not the room-draft
// module's type) so this pure board builder stays free of the fs-backed store.
interface DraftView {
  assembling: boolean;
  selected: ReadonlySet<string>;
}

const NO_DRAFT: DraftView = { assembling: false, selected: new Set() };

// The bench's declared capacity: four set-size tracks per row. The open seat is
// permanent furniture riding the NEXT free seat — items lay out
// minds → boot card → open seat → pad ghosts, so composing happens exactly
// where the next Mind will land and the trailing pads round the last row up to
// capacity (the bench law).
const BENCH_COLUMNS = 4;

// The Chamber panel — the surface's one focal panel: the bench itself (a seat card
// per Mind), the boot card while a genesis runs, the open author seat, and — folded in
// from the retired Convene panel — the assembly composer that calls a subset of the
// bench to the table and starts a room. The standalone roster board (boards/roster.ts)
// backs the chamber-roster workflow and canvas view, sharing this file's card verbs and
// launchpad builders so the two benches can't drift.
export function buildChamberBoard(
  minds: readonly Mind[],
  rooms: readonly Room[] = [],
  pending: readonly PendingGenesis[] = [],
  now: number = Date.now(),
  draft: DraftView = NO_DRAFT,
  projects: readonly ConveneProject[] = [],
): CanvasBoardView {
  const live = rooms.filter((r) => r.status === "active");
  // Convening is only offered on a quiet bench with a cast to draw from and no room
  // already live — a genesis in flight suppresses it (the panel is ticking, so an open
  // composer form could be clobbered mid-input), and the single-active-room invariant
  // forbids a second room. Assembly can only render inside that window.
  const canConvene = minds.length >= 2 && pending.length === 0 && live.length === 0;
  const assembling = canConvene && draft.assembling;

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
      : assembling
        ? "assembling"
        : minds.length > 0
          ? "bench at rest"
          : pending.length > 0
            ? undefined
            : "awaiting genesis";

  return {
    view: "board",
    header: { status: assembled, ...(chip ? { chip } : {}) },
    sections: benchSections(minds, rooms, pending, now, {
      canConvene,
      assembling,
      draft,
      projects,
    }),
  };
}

// Every state is the same four-track bench: seat cards, the boot card in the
// seat being taken while a genesis runs, the open author seat on the next free
// cell, and decorative pad ghosts trailing. Below the bench sits the convene
// affordance — a one-click launcher at rest, the unfolded composer while assembling.
function benchSections(
  minds: readonly Mind[],
  rooms: readonly Room[],
  pending: readonly PendingGenesis[],
  now: number,
  convene: {
    canConvene: boolean;
    assembling: boolean;
    draft: DraftView;
    projects: readonly ConveneProject[];
  },
): Section[] {
  // readMinds is newest-first; the bench seats in arrival order — a Mind boots
  // into the leftmost open seat and stays there. Landed Minds group before pending
  // boot cards. Concurrent geneses each hold a boot card, in the order they were
  // authored (see bootSlotsFor for hues).
  const seatedOrder = [...minds].reverse();
  const slots = bootSlotsFor(pending, minds);
  const seats = [
    ...seatedOrder.map((m) =>
      seatCard(
        m,
        rooms,
        convene.assembling ? { selected: convene.draft.selected.has(m.slug) } : undefined,
      ),
    ),
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
  if (convene.assembling) {
    const cast = seatedOrder.filter((m) => convene.draft.selected.has(m.slug));
    if (cast.length >= 2) {
      sections.push({
        kind: "rows",
        items: [{ glyph: "brand", text: `${cast.length} at the table` }],
      });
      sections.push(conveneShapeSection(cast, convene.projects));
    } else {
      sections.push({
        kind: "rows",
        items: [{ glyph: cast.length === 1 ? "brand" : "neutral", text: assemblyHint(cast) }],
      });
    }
    sections.push({ kind: "actions", items: [assembleAction(false, "Cancel", "✕")] });
  } else if (convene.canConvene) {
    sections.push({
      kind: "actions",
      items: [assembleAction(true, "Convene a Room", "＋", "brand")],
    });
  }
  return sections;
}

function assemblyHint(cast: readonly Mind[]): string {
  if (cast.length === 0) return "Click a Mind to bring them to the table.";
  return `${cast[0]?.name} is at the table — click another Mind to choose a room shape.`;
}

// The footer convene control: one `assemble` verb that opens (`on: true`) or closes
// (`on: false`) the composer. The action handler flips the draft's assembling flag and
// recomposes the panel.
function assembleAction(
  on: boolean,
  label: string,
  glyph: string,
  tone?: CanvasTone,
): CanvasActionItem {
  return { type: "assemble", label, glyph, ...(tone ? { tone } : {}), payload: { on } };
}

// One Mind -> one seat card: identity dot, the role pill wearing the same hue,
// the mission stanza, a status footer, and the shared management verbs. While the
// operator is assembling a room the whole card becomes the participant toggle — a
// click flips the Mind in/out of the inclusion draft and the card rings when it is
// at the table — so the picker lives on the seats themselves, not a separate roster.
function seatCard(mind: Mind, rooms: readonly Room[], select?: { selected: boolean }) {
  const active = rooms.filter((r) => r.status === "active" && seatsMind(r, mind.slug));
  const status = select?.selected
    ? { value: "at the table", tone: "brand" as CanvasTone }
    : active.length === 0
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
    // Assembling: the card body IS the who's-in control (a `draft-set` toggle),
    // `selected` rings the ones at the table. The Enter/Model buttons keep their
    // own clicks — the renderer ignores card-body clicks that land on a child.
    ...(select
      ? { action: { type: "draft-set", payload: { slug: mind.slug } }, selected: select.selected }
      : {}),
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
