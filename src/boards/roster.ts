import type { CanvasActionItem, CanvasBoardView, CanvasTone } from "@keelson/shared";
import { GENESIS_STALL_MS, type PendingGenesis, pendingElapsedMs } from "../pending-genesis.ts";
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
export function describeOwnAction(): CanvasActionItem {
  return {
    type: "describe-own",
    label: "Author",
    glyph: "✦",
    tone: "brand" as CanvasTone,
    expanded: true,
    submitLabel: "Author",
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
export function starterAction(
  starter: (typeof GENESIS_STARTERS)[number],
  free?: ReadonlySet<number>,
): CanvasActionItem {
  const seatFree = !free || free.has(starter.seat);
  return {
    type: "author-archetype",
    label: starter.name,
    hint: `${starter.role} · ${starter.blurb}`,
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
  pending: readonly PendingGenesis[] = [],
  now: number = Date.now(),
): CanvasBoardView {
  // Each genesis in flight takes the next free seat as a boot card (a nod to the
  // original Chamber's genesis screen); the seated cards compose around them. Cold
  // start (no Mind, nothing pending) leads with the launchpad; a seated roster gets
  // it appended below (the minds.length >= 1 block). While geneses are pending
  // neither shows it — the boot cards carry the moment.
  const sections: CanvasBoardView["sections"] =
    minds.length === 0 && pending.length === 0
      ? coldStartSections()
      : seatedSections(minds, pending, now);

  // Authoring stays reachable in the seated state via the reused genesis launchpad,
  // appended below the cards + composer and withheld while a genesis is already in
  // flight (the boot cards carry that moment). Cold start has its own launchpad, so
  // this only fires once >=1 Mind is seated.
  if (minds.length >= 1 && pending.length === 0) {
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
// at genesis — see identityToneForSlot), the role in a single pill, persona as a
// field, and three actions — Enter (the primary verb, a non-destructive action
// the host renders inline on the card), the model control (an at-rest indicator
// whose dropdown re-pins the model), and Retire (a destructive overflow action
// with a confirm dialog).
function cardFor(mind: Mind) {
  const fields: { label: string; value: string }[] = [
    { label: "persona", value: truncate(mind.persona) },
  ];
  return {
    title: mind.name,
    dot: identityToneForSlot(mind.identitySlot),
    pill: { label: mind.role.trim() || "Mind" },
    fields,
    actions: mindCardActions(mind),
  };
}

// The three management verbs a Mind's card carries wherever it renders — the
// merged Chamber panel and this standalone roster board share them so the two
// benches can't drift on what a seat can do.
export function mindCardActions(mind: Mind): CanvasActionItem[] {
  return [
    {
      type: "enter-mind",
      label: `Enter ${mind.name}`,
      glyph: "→",
      payload: { slug: mind.slug },
    },
    // The current model reads off this action's label (the at-rest indicator).
    // A pick carries its provider via the `provider` companion key so the pin
    // stays a coherent pair; the clear row dispatches "" which setMindModel
    // reads as drop-the-pin.
    {
      type: "set-model",
      label: `Model — ${mind.model ?? "default"}`,
      glyph: "⚙",
      payload: { slug: mind.slug },
      fields: [
        {
          name: "model",
          label: "Model",
          placeholder: "default (inherit)",
          modelPicker: {
            providerField: "provider",
            ...(mind.provider ? { providerDefault: mind.provider } : {}),
          },
          ...(mind.model ? { defaultValue: mind.model } : {}),
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
  ];
}

// The identity slots (0..4) no seated Mind wears — the seats still open to author
// into, in ramp order. A Mind with no valid slot (authored before the field, or the
// neutral overflow) occupies nothing, mirroring nextFreeSlot's allocator.
export function freeSlots(minds: readonly Mind[]): number[] {
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
export function launchpadSections(
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

// The seats a list of pending geneses will land on, in marker (arrival) order: a
// starter's reserved seat when free and unclaimed (chamber_emit_genesis honors it —
// a marker carries a name ONLY for a starter, so the match can't misfire on a
// freeform brief), else the lowest unclaimed free slot, mirroring nextFreeSlot's
// allocator. Earlier markers claim their slots before later ones are placed, so two
// concurrent boot cards never preview the same hue. Shared by both benches so a
// boot card's hue always predicts the seat the Mind actually takes.
export function bootSlotsFor(
  pendings: readonly PendingGenesis[],
  minds: readonly Mind[],
): number[] {
  const open = new Set(freeSlots(minds));
  return pendings.map((pending) => {
    const starter = pending.name
      ? GENESIS_STARTERS.find((s) => s.name === pending.name)
      : undefined;
    const slot =
      starter && open.has(starter.seat)
        ? starter.seat
        : ([...open].sort((a, b) => a - b)[0] ?? IDENTITY_SLOT_COUNT);
    open.delete(slot);
    return slot;
  });
}

// The seat being taken while a genesis runs — the original Chamber's boot screen quoted
// in keelson's own ink: stacked mono lines (the card's `stacked` presentation), each a
// dim `>` prompt label with the readout riding the green `ok` field tone. The liturgy
// lines are honest: identity/purpose are known at action time for a starter (else
// "calibrating…"), and "voice: calibrating…" holds with a real elapsed count that each
// re-publish advances. Past the stall window — including an unparseable or future
// startedAt, per pendingElapsedMs — it flips to a warn card with a Dismiss.
export function bootCard(pending: PendingGenesis, slot: number, now: number) {
  const elapsedS = Math.floor(pendingElapsedMs(pending, now) / 1000);
  if (elapsedS >= GENESIS_STALL_MS / 1000) {
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
        {
          type: "dismiss-genesis",
          label: "Dismiss",
          glyph: "✕",
          tone: "warn" as CanvasTone,
          // The marker's startedAt is the boot card's identity: dismiss settles
          // exactly this genesis, never a sibling still authoring beside it.
          payload: { startedAt: pending.startedAt },
        },
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

// >=1 Mind (or geneses in flight): the seated cards, plus a boot card in each seat
// being taken. Authoring is no longer a dashed open-seat grid — buildRosterBoard
// appends the reused launchpad below (withheld while a genesis is pending, since the
// boot cards carry that moment). The lone-Mind nudge names the one act that unlocks
// the composer, and is likewise withheld while a genesis runs.
function seatedSections(
  minds: readonly Mind[],
  pending: readonly PendingGenesis[],
  now: number,
): CanvasBoardView["sections"] {
  // Each boot card takes the seat its genesis will land on (see bootSlotsFor).
  const slots = bootSlotsFor(pending, minds);
  const bootItems = pending.map((p, i) => bootCard(p, slots[i] ?? IDENTITY_SLOT_COUNT, now));

  const sections: CanvasBoardView["sections"] = [
    { kind: "cards", items: [...minds.map(cardFor), ...bootItems] },
  ];
  // With one Mind seated the composer hasn't appeared yet (it needs two). Name the
  // one act that unlocks it, so the lone-Mind roster still points forward.
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
