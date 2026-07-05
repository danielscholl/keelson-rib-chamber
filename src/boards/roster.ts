import type { CanvasActionItem, CanvasBoardView, CanvasTone } from "@keelson/shared";
import { GENESIS_STARTERS } from "../starters.ts";
import { identityToneForSlot, type Mind } from "../types.ts";

// The Chamber pulse: the one "for you" signal (a waiting briefing) the roster
// leads with. The three at-a-glance counts a prior version carried here (active
// rooms, live lenses, minds) each already read once elsewhere — the roster's own
// header chip, the Rooms region's header, the Lenses region's header — so
// repeating them here was the "4 minds in six places" finding; this pulse says
// only the one fact nothing else surfaces.
export interface RosterPulse {
  forYou: boolean;
}

// Pure: a roster of Minds -> a canvas `board`. Zero Minds renders a cold-start
// launchpad (author the first Mind); >=1 renders one card per Mind (Enter inline,
// Retire in the overflow) plus the Convene-a-room composer at >=2. `draftExcluded`
// is the server-side draft (deselected slugs) the chips reflect — absent/empty means
// all Minds selected. `pulse`, when present AND waiting, leads the board with one
// quiet line; omitted or quiet renders no pulse section at all — an idle Chamber
// shows nothing rather than a row of empty tiles.
// Validated against canvasViewSchema in tests; the producer never parses (validation
// lives at the binding edge).
export function buildRosterBoard(
  minds: readonly Mind[],
  draftExcluded: ReadonlySet<string> = new Set(),
  pulse?: RosterPulse,
): CanvasBoardView {
  const sections: CanvasBoardView["sections"] =
    minds.length === 0 ? coldStartSections() : [{ kind: "cards", items: minds.map(cardFor) }];

  // A room needs at least two Minds to be a conversation. The composer is a
  // toggle-chip per Mind against the server-side draft (each chip is a draft-set
  // action) plus a Convene action with NO participants in its payload — the server
  // resolves the participant set from the draft (all minus the excluded).
  if (minds.length >= 2) {
    const selectedCount = minds.filter((m) => !draftExcluded.has(m.slug)).length;
    const items: CanvasActionItem[] = minds.map((mind) => {
      const selected = !draftExcluded.has(mind.slug);
      return {
        type: "draft-set",
        label: mind.name,
        glyph: selected ? "✓" : "+",
        payload: { slug: mind.slug },
      };
    });
    // Convene needs >=2 still selected (validateStart's floor); omit it below that
    // so the chips can't surface a start the server would reject.
    if (selectedCount >= 2) {
      items.push({
        type: "convene",
        label: "Convene…",
        glyph: "▸",
        // The operator types the opening topic; it merges into the payload as
        // `topic` (conveneAction reads it). Omitting it falls back to the driver's
        // non-empty first-turn prompt.
        fields: [
          {
            name: "topic",
            label: "Topic",
            placeholder: "What should they discuss? (optional)",
            multiline: true,
          },
          // Free text, not a picker — a board action field has no select widget.
          // conveneAction resolves it by id OR name against the host's project
          // list (the same "id or name" convention squad's tools use), so the
          // room's `projectId` gets stamped without a new host affordance.
          {
            name: "project",
            label: "Project (optional)",
            placeholder: "name or id — leave blank for none",
          },
        ],
      });
    }
    sections.push({ kind: "actions", title: "Convene a room", items });
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

// The cold-start launchpad: an anchor sentence, an "Author a Mind" section (the
// three starter archetypes + a describe-your-own brief), and a "what's next" line.
// No locked Rooms/Lenses panels; no "convene <slug>" — the only "convene" is the
// next-step sentence.
function coldStartSections(): CanvasBoardView["sections"] {
  return [
    {
      kind: "rows",
      items: [
        {
          glyph: "brand",
          text: "A Chamber is a team of persistent Minds you author — they chat with you, meet each other in Rooms, and keep Lenses for ongoing work. Author your first Mind to start the Chamber.",
        },
      ],
    },
    {
      kind: "actions",
      title: "Author a Mind",
      items: [
        ...GENESIS_STARTERS.map((s) => ({
          type: "author-archetype",
          label: `${s.name} — ${s.tagline}`,
          glyph: "✦",
          payload: { slug: s.slug },
        })),
        {
          type: "describe-own",
          label: "Describe & author",
          glyph: "✎",
          fields: [
            {
              name: "brief",
              label: "Or describe your own",
              placeholder:
                'Who should this feel like? e.g. "Athena — a skeptical staff engineer who guards the architecture"',
              multiline: true,
            },
          ],
        },
      ],
    },
    {
      kind: "rows",
      items: [
        {
          glyph: "neutral",
          text: "Next: with two Minds you can convene a Room; any Mind can keep a Lens. Each appears as its own panel here once it exists.",
          trailing: "what's next",
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
