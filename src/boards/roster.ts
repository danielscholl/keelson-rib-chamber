import type {
  CanvasActionField,
  CanvasActionItem,
  CanvasBoardView,
  CanvasTone,
} from "@keelson/shared";
import { GENESIS_STARTERS } from "../starters.ts";
import { IDENTITY_SLOT_COUNT, identityToneForSlot, isValidSlot, type Mind } from "../types.ts";

// The Chamber pulse: the one "for you" signal (a waiting briefing) the roster
// leads with. The three at-a-glance counts a prior version carried here (active
// rooms, live lenses, minds) each already read once elsewhere — the roster's own
// header chip, the Rooms region's header, the Lenses region's header — so
// repeating them here was the "4 minds in six places" finding; this pulse says
// only the one fact nothing else surfaces.
export interface RosterPulse {
  forYou: boolean;
}

// The cold-start orientation sentence — what a Chamber is, and the single next act.
const ANCHOR =
  "A Chamber is a team of persistent Minds you author — they chat with you, meet each other in Rooms, and keep Lenses for ongoing work. Author your first Mind to start the Chamber.";

// The bridge caption under the authoring actions: "Author" is the verb on the
// button, but genesis is the project's own word (the /genesis command, the
// chamber-genesis workflow), so the surface teaches the equivalence at the moment
// the operator performs it rather than hiding it.
const GENESIS_BRIDGE =
  "Authoring runs the genesis rite — /genesis in chat, chamber-genesis in workflows.";

// The freeform-brief hero: the authored, personal path (describe a Mind in your own
// words). `glyph`/`label`/`tone` vary by placement — the cold-start hero is the
// filled brand primary; a populated open seat is a quieter ✎ prompt.
function describeOwnAction(variant: "hero" | "seat"): CanvasActionItem {
  return {
    type: "describe-own",
    label: variant === "hero" ? "Describe & author your own…" : "Author…",
    glyph: variant === "hero" ? "✦" : "✎",
    ...(variant === "hero" ? { tone: "brand" as CanvasTone } : {}),
    fields: [
      {
        name: "brief",
        label: "Who should this Mind feel like?",
        placeholder: 'e.g. "Athena — a skeptical staff engineer who guards the architecture"',
        multiline: true,
      },
    ],
  };
}

// A starter archetype as an author action, previewing the identity hue it will wear
// when authored (keelson#390) — chamber_emit_genesis honors the starter's `seat` when
// free. Only tone the preview when that seat is actually free (`free`, or the cold
// start where every seat is): on a populated roster whose ramp already claimed the
// starter's seat it would land elsewhere, so promising the hue would lie.
function starterAction(
  starter: (typeof GENESIS_STARTERS)[number],
  free?: ReadonlySet<number>,
): CanvasActionItem {
  const seatFree = !free || free.has(starter.seat);
  return {
    type: "author-archetype",
    label: `${starter.name} — ${starter.tagline}`,
    glyph: "✦",
    ...(seatFree ? { tone: identityToneForSlot(starter.seat) } : {}),
    payload: { slug: starter.slug },
  };
}

// Pure: a roster of Minds -> a canvas `board`. Zero Minds renders the genesis
// launchpad (the freeform-brief hero + the starter voices + a short journey);
// >=1 renders one card per Mind plus a dashed OPEN-SEAT card for each identity slot
// still free (authoring never leaves the surface), and the Convene composer at >=2.
// `draftExcluded` is the server-side draft (deselected slugs) the chips reflect —
// absent/empty means all Minds selected. `pulse`, when present AND waiting, leads the
// board with one quiet line; omitted or quiet renders no pulse section at all.
// Validated against canvasViewSchema in tests; the producer never parses (validation
// lives at the binding edge).
export function buildRosterBoard(
  minds: readonly Mind[],
  draftExcluded: ReadonlySet<string> = new Set(),
  pulse?: RosterPulse,
): CanvasBoardView {
  const sections: CanvasBoardView["sections"] =
    minds.length === 0 ? coldStartSections() : seatedSections(minds);

  // A room needs at least two Minds to be a conversation. The composer splits into
  // "who's in" (identity-toned toggle chips against the server-side draft) and
  // "…and how" (one action per room shape, each teaching its own fields). The shapes
  // are gated on the 2-speaker floor (validateStart's minimum) so that floor can't be
  // violated from here; a shape's own preconditions — a Debate/Build facilitator that
  // is a non-participant Mind, a cross-vendor Review pair — are still enforced
  // server-side, surfacing a clear error when the current draft can't satisfy them.
  if (minds.length >= 2) {
    const selectedCount = minds.filter((m) => !draftExcluded.has(m.slug)).length;
    const chips: CanvasActionItem[] = minds.map((mind) => {
      const selected = !draftExcluded.has(mind.slug);
      return {
        type: "draft-set",
        label: mind.name,
        glyph: selected ? "✓" : "+",
        // The "who" of a room is picked here; wear each Mind's identity tone so the
        // cast is chosen in colour, not from a monochrome name list.
        tone: identityToneForSlot(mind.identitySlot),
        payload: { slug: mind.slug },
      };
    });
    sections.push({ kind: "actions", title: "Convene a room — who's in", items: chips });
    if (selectedCount >= 2) {
      sections.push({ kind: "actions", title: "…and how", items: shapeActions() });
    }
  }

  // The one waiting-for-you signal, when true — a Mind's first read is "is
  // anything waiting for me?" — leads the board. Nothing renders when quiet.
  if (pulse?.forYou) sections.unshift(forYouSection());

  return {
    view: "board",
    title: "Roster",
    header: {
      status: {
        label: `${minds.length} ${minds.length === 1 ? "mind" : "minds"}`,
        tone: "brand" as CanvasTone,
      },
      chip: "roster",
    },
    sections,
  };
}

function forYouSection(): CanvasBoardView["sections"][number] {
  return {
    kind: "rows",
    items: [{ glyph: "brand", text: "A briefing is waiting for you.", trailing: "Briefing" }],
  };
}

// One Mind -> one card: its host identity-tone dot (keelson#390, assigned once
// at genesis — see identityToneForSlot), the role in a single pill, persona
// (and model when set) as fields, and two actions — Enter (the primary verb, a
// non-destructive action the host renders inline on the card) and Retire (a
// destructive overflow action with a confirm dialog).
function cardFor(mind: Mind) {
  const fields: { label: string; value: string }[] = [
    { label: "persona", value: truncate(mind.persona) },
  ];
  if (mind.model) fields.push({ label: "model", value: mind.model });
  return {
    title: mind.name,
    dot: identityToneForSlot(mind.identitySlot),
    pill: { label: mind.role.trim() || "Mind" },
    fields,
    actions: [
      {
        type: "enter-mind",
        label: `Enter ${mind.name}`,
        glyph: "→",
        payload: { slug: mind.slug },
      },
      {
        type: "set-model",
        label: "Set model…",
        glyph: "⚙",
        payload: { slug: mind.slug },
        fields: [
          {
            name: "model",
            label: "Model",
            placeholder: mind.model ?? "e.g. claude-opus-4.8 (blank to clear)",
          },
          {
            name: "provider",
            label: "Provider",
            placeholder: mind.provider ?? "optional, e.g. anthropic",
          },
        ],
      },
      {
        type: "retire",
        label: "Retire Mind…",
        glyph: "✕",
        tone: "warn" as CanvasTone,
        destructive: true,
        payload: { slug: mind.slug },
        confirm: {
          title: "Retire Mind",
          body: `Retire ${mind.name}? This permanently deletes the Mind and its SOUL.`,
          confirmLabel: "Retire",
          cancelLabel: "Cancel",
        },
      },
    ],
  };
}

// The identity slots (0..4) no seated Mind wears — the seats still open to author
// into, in ramp order. A Mind with no valid slot (authored before the field, or the
// neutral overflow) occupies nothing, mirroring nextFreeSlot's allocator.
function freeSlots(minds: readonly Mind[]): number[] {
  const taken = new Set<number>();
  for (const m of minds) {
    if (isValidSlot(m.identitySlot)) taken.add(m.identitySlot);
  }
  const open: number[] = [];
  for (let slot = 0; slot < IDENTITY_SLOT_COUNT; slot++) {
    if (!taken.has(slot)) open.push(slot);
  }
  return open;
}

// A dashed OPEN-SEAT card in the hue it would assign: authoring stays on the surface
// at every roster size (the "vanishing authoring" finding). Each carries the freeform
// Author verb; the first also offers the starter voices not yet seated, so seating a
// starter stays reachable past the cold start without repeating the buttons on every
// seat.
function openSeatCard(slot: number, extraStarters: CanvasActionItem[]) {
  const actions: CanvasActionItem[] = [describeOwnAction("seat"), ...extraStarters];
  return {
    title: "Open seat",
    dot: identityToneForSlot(slot),
    footnote:
      extraStarters.length > 0
        ? "Describe a Mind, or seat a starter voice."
        : "Author a Mind into this seat.",
    actions,
  };
}

// >=1 Mind: the seated cards, then a dashed open-seat card per free identity slot.
// Past five Minds (or a fully-seated ramp) no seat remains, so a quiet Author action
// keeps authoring reachable — a sixth Mind folds to neutral + name (the host rule).
function seatedSections(minds: readonly Mind[]): CanvasBoardView["sections"] {
  const open = freeSlots(minds);
  const openSet = new Set(open);
  const seatedSlugs = new Set(minds.map((m) => m.slug));
  const freeStarters = GENESIS_STARTERS.filter((s) => !seatedSlugs.has(s.slug)).map((s) =>
    starterAction(s, openSet),
  );
  const openSeats = open.map((slot, i) => openSeatCard(slot, i === 0 ? freeStarters : []));

  const sections: CanvasBoardView["sections"] = [
    { kind: "cards", items: [...minds.map(cardFor), ...openSeats] },
  ];
  if (openSeats.length === 0) {
    sections.push({
      kind: "actions",
      title: "Author a Mind",
      items: [describeOwnAction("seat")],
    });
  }
  // With one Mind seated the composer hasn't appeared yet (it needs two). Name the
  // one act that unlocks it, so the lone-Mind roster still points forward.
  if (minds.length === 1) {
    sections.push({
      kind: "rows",
      items: [
        { glyph: "neutral", text: "Seat a second Mind to convene a Room.", trailing: "next" },
      ],
    });
  }
  return sections;
}

// The topic/project/moderator/manager/turns fields the shape actions collect. Kept in
// one place so each shape draws only the fields its strategy uses.
const topicField: CanvasActionField = {
  name: "topic",
  label: "Topic",
  placeholder: "What should they discuss? (optional)",
  multiline: true,
};
const projectField: CanvasActionField = {
  name: "project",
  label: "Project (optional)",
  placeholder: "name or id — leave blank for none",
};
const turnsField: CanvasActionField = {
  name: "turns",
  label: "Turns (optional)",
  placeholder: "default 8",
};
const moderatorField: CanvasActionField = {
  name: "moderator",
  label: "Moderator — a Mind not in the room",
  placeholder: "name or slug — e.g. moneypenny",
  required: true,
};
const managerField: CanvasActionField = {
  name: "manager",
  label: "Manager — a Mind not in the room",
  placeholder: "name or slug — e.g. moneypenny",
  required: true,
};

// One action per room shape the driver speaks — each dispatches `convene` with its
// strategy and only the fields that strategy needs (conveneAction resolves the draft
// for participants, and validateStart enforces each strategy's rules). The board's
// former single hard-pinned "sequential" Convene became these five.
function shapeActions(): CanvasActionItem[] {
  return [
    {
      type: "convene",
      label: "Discussion",
      glyph: "▸",
      payload: { strategy: "sequential" },
      fields: [topicField, projectField],
    },
    {
      type: "convene",
      label: "Debate — moderated",
      glyph: "◆",
      payload: { strategy: "group-chat" },
      fields: [topicField, moderatorField, turnsField],
    },
    {
      type: "convene",
      label: "Open floor",
      glyph: "⊙",
      payload: { strategy: "open-floor" },
      fields: [topicField, turnsField],
    },
    {
      type: "convene",
      label: "Review — cross-vendor",
      glyph: "✓",
      payload: { strategy: "review" },
      fields: [topicField],
    },
    {
      type: "convene",
      label: "Build — magentic",
      glyph: "⚑",
      payload: { strategy: "magentic" },
      fields: [topicField, managerField, projectField, turnsField],
    },
  ];
}

// The cold-start launchpad: the anchor sentence, a "Genesis — author a Mind" section
// (the freeform-brief hero first, then the starter archetypes each in its seat hue),
// the /genesis bridge caption, and a three-step journey. No locked Rooms/Lenses
// panels; no "convene <slug>".
function coldStartSections(): CanvasBoardView["sections"] {
  return [
    { kind: "rows", items: [{ glyph: "brand", text: ANCHOR }] },
    {
      kind: "actions",
      title: "Genesis — author a Mind",
      items: [describeOwnAction("hero"), ...GENESIS_STARTERS.map((s) => starterAction(s))],
    },
    { kind: "rows", items: [{ glyph: "neutral", text: GENESIS_BRIDGE, trailing: "genesis" }] },
    {
      kind: "rows",
      items: [
        {
          icon: "1",
          glyph: "brand",
          text: "Author — the genesis rite seats a Mind with a soul that persists.",
        },
        {
          icon: "2",
          glyph: "neutral",
          text: "Meet — enter it for a 1:1 chat. What it learns, it keeps.",
        },
        {
          icon: "3",
          glyph: "neutral",
          text: "Convene — with two Minds seated, open a Room on a topic.",
        },
      ],
    },
  ];
}

function truncate(text: string, max = 120): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "(no persona)";
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}
