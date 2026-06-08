import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
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

  const sections: CanvasBoardView["sections"] = [{ kind: "cards", items }];
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
