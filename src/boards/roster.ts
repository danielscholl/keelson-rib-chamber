import type { CanvasActionItem, CanvasBoardView, CanvasTone } from "@keelson/shared";
import type { PendingGenesis } from "../pending-genesis.ts";
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

// The freeform-brief hero: the authored, personal path (describe a Mind in your own
// words). The board's one filled brand primary, its brief field open inline — no
// disclosure step between the operator and the authored path. Cold start and the
// seated "author another Mind" launchpad share it.
function describeOwnAction(): CanvasActionItem {
  return {
    type: "describe-own",
    label: "Author",
    glyph: "✦",
    tone: "brand" as CanvasTone,
    expanded: true,
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
// free. Only tone the preview when that seat is actually free (`free` unset, or the
// seat is in it): on a populated roster whose ramp already claimed the starter's seat
// the Mind would land elsewhere, so promising the hue would lie.
function starterAction(
  starter: (typeof GENESIS_STARTERS)[number],
  free?: ReadonlySet<number>,
): CanvasActionItem {
  const seatFree = !free || free.has(starter.seat);
  return {
    type: "author-archetype",
    label: `${starter.name} — ${starter.role}`,
    glyph: "✦",
    ...(seatFree ? { tone: identityToneForSlot(starter.seat) } : {}),
    payload: { slug: starter.slug },
  };
}

// Pure: a roster of Minds -> a canvas `board`. Zero Minds renders the genesis
// launchpad (the freeform-brief hero + the starter voices at rest); >=1 renders one
// card per Mind, and the same launchpad reused below as the "author another Mind" path
// (authoring never leaves the surface — the old dashed open-seat grid is gone; a sixth
// Mind past the five hues folds to neutral). `pulse`, when present AND waiting, leads
// the board with one quiet line; omitted or quiet renders no pulse section at all.
// Convening moved to its own region (boards/convene.ts), so the roster is Minds-only.
// Validated against canvasViewSchema in tests; the producer never parses (validation
// lives at the binding edge).
export function buildRosterBoard(
  minds: readonly Mind[],
  pulse?: RosterPulse,
  pending?: PendingGenesis | null,
  now: number = Date.now(),
): CanvasBoardView {
  // A genesis in flight takes the next free seat as a boot card (a nod to the original
  // Chamber's genesis screen); the seated cards compose around it. Cold start (no Mind,
  // no pending) leads with the launchpad; a seated roster gets it appended below (the
  // minds.length >= 1 block). While a genesis is pending neither shows it — the boot
  // card carries the moment.
  const sections: CanvasBoardView["sections"] =
    minds.length === 0 && !pending ? coldStartSections() : seatedSections(minds, pending, now);

  // Authoring stays reachable in the seated state via the reused genesis launchpad,
  // appended below the cards + composer and withheld while a genesis is already in
  // flight (the boot card carries that moment). Cold start has its own launchpad, so
  // this only fires once >=1 Mind is seated.
  if (minds.length >= 1 && !pending) {
    sections.push(...launchpadSections(minds, { title: "Author another Mind" }));
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
      // Once a Mind is seated, feed the host head its roster peek (an identity dot per
      // Mind, names on hover) and the collapse hint so the panel folds to its head strip
      // — the host collapses once, a manual toggle wins after. Cold start emits neither,
      // so the genesis launchpad stays open.
      ...(minds.length > 0
        ? {
            people: minds.map((m) => ({
              name: m.name,
              tone: identityToneForSlot(m.identitySlot),
            })),
            defaultCollapsed: true,
          }
        : {}),
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

// The genesis launchpad — the describe-own brief plus the starter voices not yet
// seated. Cold start leads with it (the filled hero, every free hue previewed, the
// void line at rest); a seated roster reuses it below the cards as the one "author
// another Mind" path, replacing the old dashed open-seat grid. Starters are offered
// only while a hue seat is free (a sixth Mind can still be authored freeform — it
// folds to neutral); an already-seated starter drops off (filtered by slug), and a
// starter whose preferred hue is taken stays but shows untoned.
function launchpadSections(
  minds: readonly Mind[],
  opts: { title: string; rest?: string },
): CanvasBoardView["sections"] {
  const seated = new Set(minds.map((m) => m.slug));
  const free = new Set(freeSlots(minds));
  const starters =
    free.size > 0
      ? GENESIS_STARTERS.filter((s) => !seated.has(s.slug)).map((s) => starterAction(s, free))
      : [];
  const sections: CanvasBoardView["sections"] = [
    { kind: "actions", title: opts.title, items: [describeOwnAction()] },
  ];
  if (starters.length > 0) {
    sections.push({
      kind: "actions",
      title: "Or seat a starter voice",
      wrap: true,
      items: starters,
    });
  }
  if (opts.rest) {
    sections.push({ kind: "rows", items: [{ glyph: "neutral", text: opts.rest }] });
  }
  return sections;
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

// >=1 Mind (or a genesis in flight): the seated cards, plus a boot card in the seat
// being taken when a genesis is pending. Authoring is no longer a dashed open-seat
// grid — buildRosterBoard appends the reused launchpad below (withheld while a genesis
// is pending, since the boot card carries that moment). The lone-Mind nudge names the
// one act that unlocks the composer, and is likewise withheld while a genesis runs.
function seatedSections(
  minds: readonly Mind[],
  pending: PendingGenesis | null | undefined,
  now: number,
): CanvasBoardView["sections"] {
  const open = freeSlots(minds);
  // The boot card takes the first free slot (or folds to neutral past the ramp).
  const bootItems = pending ? [bootCard(pending, open[0] ?? IDENTITY_SLOT_COUNT, now)] : [];

  const sections: CanvasBoardView["sections"] = [
    { kind: "cards", items: [...minds.map(cardFor), ...bootItems] },
  ];
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

// The cold-start launchpad: the freeform brief open inline under "Genesis — author a
// Mind" (the board's one filled button), the three starter voices as a compact chip
// row beneath it, and the void screen's line at rest. Shares launchpadSections with
// the seated "author another Mind" path — every hue is free here, so all starters
// preview their tone. While a genesis runs the boot card replaces this with a live count.
function coldStartSections(): CanvasBoardView["sections"] {
  return launchpadSections([], { title: "Genesis — author a Mind", rest: "awaiting genesis." });
}

function truncate(text: string, max = 120): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "(no persona)";
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}
