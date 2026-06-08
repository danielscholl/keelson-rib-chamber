import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
import type { Room, TurnEntry } from "../types.ts";

// Pure: a room + its transcript -> a canvas `board` (a `rows` feed, one row per
// turn, plus a participant `segments` header). Validated against canvasViewSchema
// in tests.
export function buildRoomBoard(room: Room, transcript: readonly TurnEntry[]): CanvasBoardView {
  const counts = new Map<string, number>();
  for (const entry of transcript) {
    if (entry.role === "agent") counts.set(entry.from, (counts.get(entry.from) ?? 0) + 1);
  }
  const segments = room.participants.map((slug) => ({ label: slug, n: counts.get(slug) ?? 0 }));

  const items = transcript.map((entry) => ({
    glyph: entry.aborted ? ("error" as CanvasTone) : roleTone(entry.role),
    chip: { label: entry.from, tone: roleTone(entry.role) },
    text: turnText(entry),
    trailing: entry.aborted ? `${entry.at} · aborted` : entry.at,
  }));

  // Surface the room's framing topic above the feed so an operator watching the
  // board sees what the discussion is about — it otherwise lives only in the
  // (system-side) turn prompt.
  const topic = room.topic?.trim();
  const topicSection: CanvasBoardView["sections"] = topic
    ? [{ kind: "rows", title: "Topic", items: [{ glyph: "brand", text: topic }] }]
    : [];

  return {
    view: "board",
    title: room.name,
    header: {
      status: { label: room.status, tone: statusTone(room.status) },
      chip: `${room.turnIndex}/${room.turnBudget}`,
      ...(segments.length > 0 ? { segments } : {}),
    },
    // The topic banner, the transcript feed, then board-baked controls. Each
    // action carries the room slug as payload (a static actions[] button can't),
    // so onAction routes to the right room. Payload-required controls have to
    // live here, not in the rib's static actions list — those dispatch type-only.
    sections: [...topicSection, { kind: "rows", items }, roomControls(room)],
  };
}

// The controls section: while a room is active, a per-participant "Call on
// <slug>" (a one-shot nextSpeaker override) and Stop (turns advance on their
// own); once it ends, a single "Start again" that re-runs the same config under
// a fresh room. Each control carries the room slug so onAction targets it.
function roomControls(room: Room): CanvasBoardView["sections"][number] {
  if (room.status !== "active") {
    return {
      kind: "actions",
      title: "Controls",
      items: [
        {
          type: "room-start",
          label: "Start again",
          glyph: "▸",
          payload: {
            name: room.name,
            strategy: room.strategy,
            participants: room.participants,
            turnBudget: room.turnBudget,
            // Carry the topic so restarting a finished room keeps its subject.
            ...(room.topic ? { topic: room.topic } : {}),
          },
        },
      ],
    };
  }
  return {
    kind: "actions",
    title: "Controls",
    items: [
      ...room.participants.map((p) => ({
        type: "room-inject",
        label: `Call on ${p}`,
        glyph: "↳",
        payload: { slug: room.slug, nextSpeaker: p },
      })),
      {
        type: "room-stop",
        label: "Stop",
        glyph: "■",
        tone: "warn" as CanvasTone,
        destructive: true,
        payload: { slug: room.slug },
      },
    ],
  };
}

function turnText(entry: TurnEntry): string {
  const text = entry.parts
    .map((p) => p.text)
    .join("\n")
    .trim();
  return text.length > 0 ? text : "(no text)";
}

function roleTone(role: TurnEntry["role"]): CanvasTone {
  switch (role) {
    case "director":
      return "accent";
    case "system":
      return "neutral";
    default:
      return "info";
  }
}

function statusTone(status: Room["status"]): CanvasTone {
  switch (status) {
    case "active":
      return "info";
    case "stopped":
      return "warn";
    default:
      return "ok";
  }
}
