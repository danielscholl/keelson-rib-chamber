import type {
  CanvasActionField,
  CanvasActionItem,
  CanvasBoardView,
  CanvasTone,
} from "@keelson/shared";
import type { PendingGenesis } from "../pending-genesis.ts";
import { GENESIS_STARTERS, type GenesisStarter } from "../starters.ts";
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
    label: variant === "hero" ? "Author" : "Author…",
    glyph: variant === "hero" ? "✦" : "✎",
    // The hero is the board's one filled primary, its brief field open inline —
    // no disclosure step between the operator and the authored path.
    ...(variant === "hero" ? { tone: "brand" as CanvasTone, expanded: true } : {}),
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
  pending?: PendingGenesis | null,
  now: number = Date.now(),
): CanvasBoardView {
  // A genesis in flight takes the next free seat as a boot card (a nod to the original
  // Chamber's genesis screen); the seated + open seats compose around it. Only the cold
  // start with no pending genesis shows the launchpad — once authoring is underway, the
  // boot card carries the moment.
  const sections: CanvasBoardView["sections"] =
    minds.length === 0 && !pending ? coldStartSections() : seatedSections(minds, pending, now);

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
    // The cast wraps as toggle chips (many can be in); the shapes are a tabs strip
    // (exactly one mechanism, keelson#417): picking a shape closes any sibling form
    // and opens its own as a stable full-width panel below the strip, so switching
    // shapes never reflows the row the way per-chip mid-row breaking did.
    sections.push({
      kind: "actions",
      title: "Convene a room — who's in",
      wrap: true,
      items: chips,
    });
    if (selectedCount >= 2) {
      sections.push({ kind: "actions", title: "…and how", tabs: true, items: shapeActions() });
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

// The genesis stall window (seconds): past it, a pending genesis is presumed wedged
// (the workflow failed without clearing the marker), so the boot card offers a Dismiss.
const GENESIS_STALL_S = 180;

// The seat being taken while a genesis runs — the original Chamber's boot screen quoted
// in keelson's own ink: stacked mono lines (the card's `stacked` presentation), each a
// dim `>` prompt label with the readout riding the green `ok` field tone. The liturgy
// lines are honest: identity/purpose are known at action time for a starter (else
// "calibrating…"), and "voice: calibrating…" holds with a real elapsed count that each
// roster re-publish advances. Past the stall window it flips to a warn card with a
// Dismiss.
function bootCard(pending: PendingGenesis, slot: number, now: number) {
  const started = Date.parse(pending.startedAt);
  // An unparseable startedAt (a hand-edited marker) has no honest elapsed — present it
  // as stalled so it always carries a Dismiss, never a stuck "NaNs" card.
  const elapsedS = Number.isFinite(started)
    ? Math.max(0, Math.floor((now - started) / 1000))
    : GENESIS_STALL_S;
  if (elapsedS >= GENESIS_STALL_S) {
    return {
      title: pending.name ?? "Genesis",
      dot: "warn" as CanvasTone,
      pill: { label: "stalled", tone: "warn" as CanvasTone },
      fields: [
        {
          value: `genesis has not landed in ${Math.floor(elapsedS / 60)}m — the workflow may have failed.`,
        },
      ],
      actions: [
        { type: "dismiss-genesis", label: "Dismiss", glyph: "✕", tone: "warn" as CanvasTone },
      ],
    };
  }
  const line = (text: string) => ({ label: ">", value: text, tone: "ok" as CanvasTone });
  return {
    title: pending.name ?? "Genesis",
    dot: identityToneForSlot(slot),
    pill: { label: "authoring", tone: "brand" as CanvasTone },
    stacked: true,
    fields: [
      line("writing SOUL.md…"),
      line(`identity: ${pending.name ?? "calibrating…"}`),
      line(`purpose: ${pending.role ?? "calibrating…"}`),
      line(`voice: calibrating… · ${elapsedS}s`),
    ],
  };
}

// >=1 Mind (or a genesis in flight): the seated cards, a boot card in the seat being
// taken when a genesis is pending, then a dashed open-seat card per remaining free slot.
// Past five Minds (or a fully-seated ramp) no seat remains, so a quiet Author action
// keeps authoring reachable — a sixth Mind folds to neutral + name (the host rule). The
// quiet Author action and the lone-Mind nudge are withheld while a genesis is pending
// (authoring is already underway).
function seatedSections(
  minds: readonly Mind[],
  pending: PendingGenesis | null | undefined,
  now: number,
): CanvasBoardView["sections"] {
  const open = freeSlots(minds);
  const openSet = new Set(open);
  const seatedSlugs = new Set(minds.map((m) => m.slug));
  const freeStarters = GENESIS_STARTERS.filter((s) => !seatedSlugs.has(s.slug)).map((s) =>
    starterAction(s, openSet),
  );

  // The boot card takes the first free slot (or folds to neutral past the ramp); the
  // remaining free slots become open seats.
  const bootItems = pending ? [bootCard(pending, open[0] ?? IDENTITY_SLOT_COUNT, now)] : [];
  const openSlots = pending ? open.slice(1) : open;
  const openSeats = openSlots.map((slot, i) => openSeatCard(slot, i === 0 ? freeStarters : []));

  const sections: CanvasBoardView["sections"] = [
    { kind: "cards", items: [...minds.map(cardFor), ...bootItems, ...openSeats] },
  ];
  if (openSeats.length === 0 && !pending) {
    sections.push({
      kind: "actions",
      title: "Author a Mind",
      items: [describeOwnAction("seat")],
    });
  }
  // With one Mind seated the composer hasn't appeared yet (it needs two). Name the
  // one act that unlocks it, so the lone-Mind roster still points forward.
  if (minds.length === 1 && !pending) {
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
    // Short chip labels now the shapes wrap as a compact row; each shape's own
    // mechanism (a moderator, a cross-vendor pair, a manager) is taught by its form
    // and enforced server-side, so the qualifier need not ride the chip.
    {
      type: "convene",
      label: "Debate",
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
      label: "Review",
      glyph: "✓",
      payload: { strategy: "review" },
      fields: [topicField],
    },
    {
      type: "convene",
      label: "Build",
      glyph: "⚑",
      payload: { strategy: "magentic" },
      fields: [topicField, managerField, projectField, turnsField],
    },
  ];
}

// A starter archetype as a seated-alternative card: the seat hue it will wear, the
// role as its pill, the voice's energy as the footnote, one Author action. The cold
// start is the only caller — every seat is free there, so the hue preview is truthful.
function starterCard(starter: GenesisStarter) {
  return {
    title: starter.name,
    dot: identityToneForSlot(starter.seat),
    pill: { label: starter.role },
    footnote: starter.blurb,
    actions: [
      {
        type: "author-archetype",
        label: `Author ${starter.name}`,
        glyph: "✦",
        payload: { slug: starter.slug },
      },
    ],
  };
}

// The cold-start launchpad, mirroring the design review's hero hierarchy: the anchor
// sentence, the freeform brief open inline under "Genesis — author a Mind" (the one
// filled button on the board), the /genesis bridge caption, the starter voices as
// seated-alternative cards below an "or" divider, and the void screen's line at rest.
// No what's-next strip: the anchor names the journey and the seated roster's own
// nudges teach Meet/Convene when they become actionable. No locked Rooms/Lenses
// panels; no "convene <slug>".
function coldStartSections(): CanvasBoardView["sections"] {
  return [
    { kind: "rows", items: [{ glyph: "brand", text: ANCHOR }] },
    {
      kind: "actions",
      title: "Genesis — author a Mind",
      items: [describeOwnAction("hero")],
    },
    { kind: "rows", items: [{ glyph: "neutral", text: GENESIS_BRIDGE, trailing: "genesis" }] },
    {
      kind: "cards",
      title: "Or seat a starter voice",
      boxed: true,
      items: GENESIS_STARTERS.map(starterCard),
    },
    // The original Chamber's void screen, quoted at rest — while a genesis runs, the
    // boot card in the seat replaces this stillness with a live count.
    { kind: "rows", items: [{ glyph: "neutral", text: "awaiting genesis." }] },
  ];
}

function truncate(text: string, max = 120): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "(no persona)";
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}
