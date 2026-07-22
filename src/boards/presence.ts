import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
import type { PendingGenesis } from "../pending-genesis.ts";
import { MAX_ACTIVE_ROOMS } from "../room-config.ts";
import { GENESIS_STARTERS } from "../starters.ts";
import { identityToneForSlot, type Mind, type Room } from "../types.ts";
import { type ConveneProject, conveneScopeSection, conveneShapeSection } from "./convene.ts";
import {
  bootCard,
  bootSlotsFor,
  describeOwnAction,
  freeSlots,
  mindCardActions,
  starterAction,
} from "./roster.ts";

type Section = CanvasBoardView["sections"][number];

// The convene draft the bench reads to render assembly — which Minds sit at the
// table. A structural shape (not the room-draft module's type) so this pure board
// builder stays free of the fs-backed store.
interface DraftView {
  selected: ReadonlySet<string>;
  // Where a convened room runs. Held on the draft rather than asked per shape, so it
  // survives a change of shape and outlives the cast a convene clears.
  projectId?: string;
  coding?: boolean;
}

const NO_DRAFT: DraftView = { selected: new Set() };

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
  // Convening needs a cast and headroom under the cap — offering it at the cap would
  // compose a form startRoom then refuses. A genesis in flight suppresses it too (the panel
  // is ticking, so an open composer form could be clobbered mid-input). The cap here is
  // advisory: `live` is disk-derived while startRoom counts the driver's in-memory set, so a
  // stale-active room withholds the composer early rather than promising a start that fails.
  const canConvene = minds.length >= 2 && pending.length === 0 && live.length < MAX_ACTIVE_ROOMS;
  // Assembly is not a mode the operator enters — the cast IS the state. A seat click
  // seats a Mind and the bench is assembling exactly while someone is at the table, so
  // the hint that teaches the flow is never gated behind a button that only reveals it.
  const cast = canConvene ? [...minds].reverse().filter((m) => draft.selected.has(m.slug)) : [];
  const assembling = cast.length > 0;

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
      cast,
      draft,
      projects,
    }),
  };
}

// Every state is the same four-track bench: seat cards, the boot card in the
// seat being taken while a genesis runs, the open author seat on the next free
// cell, and decorative pad ghosts trailing. Below the bench sits the convene
// affordance, which unfolds from the cast itself: the invitation on an empty table,
// the shape tabs once two Minds are seated.
function benchSections(
  minds: readonly Mind[],
  rooms: readonly Room[],
  pending: readonly PendingGenesis[],
  now: number,
  convene: {
    canConvene: boolean;
    cast: readonly Mind[];
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
        convene.canConvene ? { selected: convene.draft.selected.has(m.slug) } : undefined,
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
  if (convene.canConvene) {
    const { cast } = convene;
    if (cast.length >= 2) {
      sections.push({
        kind: "rows",
        items: [{ glyph: "brand", text: castLine(cast, convene.draft, convene.projects) }],
      });
      // Where before how: the scope bar stands between the cast and the shape tabs, so
      // the table states its own context before the shape asks anything.
      const scope = conveneScopeSection(convene.projects, convene.draft);
      if (scope) sections.push(scope);
      sections.push(conveneShapeSection(cast));
    } else {
      // Brand-toned with nobody seated: this row is the bench's only invitation into
      // convening, so it has to pull like an affordance rather than read as a note.
      sections.push({ kind: "rows", items: [{ glyph: "brand", text: assemblyHint(cast) }] });
    }
  }
  return sections;
}

// Name the cast rather than count it: two or three names verify at a glance against the
// seats they were clicked from, in the same left-to-right order. Past three the list is
// the same work as a count, so it falls back to one.
function castLine(
  cast: readonly Mind[],
  scope: DraftView = NO_DRAFT,
  projects: readonly ConveneProject[] = [],
): string {
  const names = cast.map((m) => m.name);
  const who =
    names.length === 2
      ? `${names[0]} and ${names[1]} at the table`
      : names.length === 3
        ? `${names[0]}, ${names[1]}, and ${names[2]} at the table`
        : `${names.length} at the table`;
  // The table states its own context: an unresolvable id still shows, so a scope set
  // against a project the host has since dropped reads as stale rather than vanishing.
  if (!scope.projectId) return who;
  const project = projects.find((p) => p.id === scope.projectId)?.name ?? scope.projectId;
  return `${who} · ${project}${scope.coding ? " · can edit the repo" : ""}`;
}

function assemblyHint(cast: readonly Mind[]): string {
  if (cast.length === 0) return "Click a Mind to bring them to the table.";
  return `${cast[0]?.name} is at the table — click another Mind to convene.`;
}

// One Mind -> one seat card: identity dot, the role pill wearing the same hue,
// the mission stanza, a status footer, and the shared management verbs. Wherever the
// bench can convene at all, the whole card is the participant toggle — a click flips
// the Mind in/out of the inclusion draft and the card rings when it is at the table —
// so the picker lives on the seats themselves, not a separate roster.
function seatCard(mind: Mind, rooms: readonly Room[], select?: { selected: boolean }) {
  const active = rooms.filter((r) => r.status === "active" && seatsMind(r, mind.slug));
  // Bench vs table is carried by the card's own selection ring, not a line of prose:
  // an unlabelled field renders in the same face as the mission above it, so a resting
  // "on the bench" read as a fourth sentence of the persona. A session is the one state
  // nothing visual encodes, so it alone still prints — labelled, so it reads as metadata.
  const session =
    active.length === 0
      ? undefined
      : active.length === 1
        ? { label: "session", value: active[0]?.name ?? "", tone: "info" as CanvasTone }
        : { label: "session", value: `${active.length} rooms`, tone: "info" as CanvasTone };
  const tone = identityToneForSlot(mind.identitySlot);
  return {
    title: mind.name,
    dot: tone,
    pill: {
      label: mind.role.trim() || "Mind",
      ...(tone === "neutral" ? {} : { tone }),
    },
    // Stacked: the mission reads as its own line with the session as a quiet
    // footer beneath it, not an inline `·`-joined meta row.
    stacked: true,
    fields: [
      { value: mission(mind.mission?.trim() || mind.persona) },
      ...(session ? [session] : []),
    ],
    actions: mindCardActions(mind),
    // The card body IS the who's-in control (a `draft-set` toggle); `selected` rings
    // the ones at the table. The Enter/Model buttons keep their own clicks — the
    // renderer ignores card-body clicks that land on a child.
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
