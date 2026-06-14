import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
import { GENESIS_STARTERS } from "../starters.ts";
import type { Mind } from "../types.ts";

// Default room length when starting from the roster (turns, not rounds). The
// director can run a different budget via the API; the baked button keeps it
// simple.
const DEFAULT_ROOM_TURN_BUDGET = 6;

// Pure: a roster of Minds -> a canvas `board` of cards (one per Mind). Validated
// against canvasViewSchema in tests; the producer never parses (validation lives
// at the binding edge, like the Phase 0 brief).
export function buildRosterBoard(minds: readonly Mind[]): CanvasBoardView {
  const items = minds.map((mind) => {
    const fields: { label: string; value: string }[] = [
      { label: "persona", value: truncate(mind.persona) },
    ];
    if (mind.model) fields.push({ label: "model", value: mind.model });
    const footnote =
      mind.tools && mind.tools.length > 0 ? `tools: ${mind.tools.join(", ")}` : undefined;
    return {
      title: mind.name,
      pill: { label: mind.slug, tone: "neutral" as CanvasTone },
      fields,
      ...(footnote ? { footnote } : {}),
    };
  });

  // An empty roster is a new operator's first screen; genesis can't be a baked
  // button (it needs a freeform brief), so point them at the path that authors
  // Minds — asking the agent in Chat — and offer the starter archetypes as a
  // ready-made first move (the agent authors each from model-local knowledge).
  const sections: CanvasBoardView["sections"] =
    minds.length === 0
      ? [
          {
            kind: "rows",
            title: "Get started",
            items: [
              {
                glyph: "brand",
                text: "No Minds yet. Open Chat and ask the agent to convene a roster — describe the minds you want, or start with a preset below (e.g. “convene Moneypenny”).",
              },
              ...GENESIS_STARTERS.map((s) => ({
                glyph: "info" as CanvasTone,
                text: `${s.name} — ${s.tagline}`,
                trailing: `convene ${s.slug}`,
              })),
            ],
          },
        ]
      : [{ kind: "cards", items }];
  // A room needs at least two Minds to be a conversation; bake the participants
  // (all current Minds) into the start action so the payload-required control
  // works from the canvas, not just the API.
  if (minds.length >= 2) {
    sections.push({
      kind: "actions",
      title: "Room",
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
  // Enter a Mind for a direct 1:1 chat — the primary, non-destructive verb. The
  // action returns an open-chat directive (its soul seeded as the system prompt)
  // the harness turns into a fresh seeded conversation.
  if (minds.length > 0) {
    sections.push({
      kind: "actions",
      title: "Enter",
      items: minds.map((mind) => ({
        type: "enter-mind",
        label: `Enter ${mind.name}`,
        glyph: "→",
        payload: { slug: mind.slug },
      })),
    });
  }
  // One destructive Retire button per Mind — the slug to remove is on the card, so
  // it rides as the action payload (the room-control pattern), reaching onAction.
  // Genesis (the inverse) is the chamber-genesis workflow instead: authoring a soul
  // needs a freeform brief a payload-less button can't carry.
  if (minds.length > 0) {
    sections.push({
      kind: "actions",
      title: "Retire",
      items: minds.map((mind) => ({
        type: "retire",
        label: `Retire ${mind.name}`,
        glyph: "✕",
        tone: "warn" as CanvasTone,
        destructive: true,
        payload: { slug: mind.slug },
      })),
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

function truncate(text: string, max = 120): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "(no persona)";
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}
