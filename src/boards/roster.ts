import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
import { stableHash } from "../genesis.ts";
import { GENESIS_STARTERS } from "../starters.ts";
import type { Mind } from "../types.ts";

// Default room length when starting from the roster (turns, not rounds). The
// director can run a different budget via the API; the baked button keeps it
// simple.
const DEFAULT_ROOM_TURN_BUDGET = 6;

// The full canvas tone ramp, used to give each Mind a deterministic identity dot
// hashed from its slug — a stable per-Mind hue, not a status.
const DOT_TONES = [
  "ok",
  "warn",
  "error",
  "info",
  "caution",
  "brand",
  "accent",
  "neutral",
] as const satisfies readonly CanvasTone[];

// stableHash returns a base-36 string; parsing it back at radix 36 recovers the
// integer to mod across the ramp, so distinct slugs spread across the tones.
function dotFor(slug: string): CanvasTone {
  return DOT_TONES[Number.parseInt(stableHash(slug), 36) % DOT_TONES.length]!;
}

// Pure: a roster of Minds -> a canvas `board`. Zero Minds renders a cold-start
// launchpad (author the first Mind); >=1 renders one card per Mind (Enter inline,
// Retire in the overflow) plus the Convene-a-room action section at >=2. Validated
// against canvasViewSchema in tests; the producer never parses (validation lives at
// the binding edge).
export function buildRosterBoard(minds: readonly Mind[]): CanvasBoardView {
  const sections: CanvasBoardView["sections"] =
    minds.length === 0 ? coldStartSections() : [{ kind: "cards", items: minds.map(cardFor) }];

  // A room needs at least two Minds to be a conversation; bake the participants
  // (all current Minds) into the start action so the payload-required control
  // works from the canvas, not just the API.
  if (minds.length >= 2) {
    sections.push({
      kind: "actions",
      title: "Convene a room",
      items: [
        {
          type: "room-start",
          label: "Start room",
          glyph: "▸",
          // The operator types the opening topic; it merges into the payload as
          // `topic` (roomStartAction reads it). Omitting it falls back to the
          // driver's non-empty first-turn prompt.
          fields: [
            {
              name: "topic",
              label: "Topic",
              placeholder: "What should they discuss? (optional)",
              multiline: true,
            },
          ],
          payload: {
            name: "Room",
            strategy: "sequential",
            participants: minds.map((m) => m.slug),
            turnBudget: DEFAULT_ROOM_TURN_BUDGET,
          },
        },
      ],
    });
  }

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

// One Mind -> one card: a hashed identity dot, the role in a single pill, persona
// (and model when set) as fields, and two actions — Enter (the primary verb, a
// non-destructive action the host renders inline on the card) and Retire (a
// destructive overflow action with a typed irreversible confirm gate). The slug
// rides both action payloads + the dot hash.
function cardFor(mind: Mind) {
  const fields: { label: string; value: string }[] = [
    { label: "persona", value: truncate(mind.persona) },
  ];
  if (mind.model) fields.push({ label: "model", value: mind.model });
  return {
    title: mind.name,
    dot: dotFor(mind.slug),
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
        type: "retire",
        label: "Retire Mind…",
        glyph: "✕",
        tone: "warn" as CanvasTone,
        destructive: true,
        payload: { slug: mind.slug },
        confirm: {
          irreversible: true,
          subject: mind.slug,
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
