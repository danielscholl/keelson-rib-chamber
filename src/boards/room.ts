import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
import { speakerCounts } from "../routing.ts";
import type { Room, TurnEntry } from "../types.ts";

// Pure: a room + its transcript -> a canvas `board` (a `rows` feed, one row per
// turn, plus a participant `segments` header). Validated against canvasViewSchema
// in tests.
export function buildRoomBoard(room: Room, transcript: readonly TurnEntry[]): CanvasBoardView {
  // Same fold the routing engine uses, so the board's per-speaker counts can never
  // drift from the anti-monopoly cap / close gate.
  const counts = speakerCounts(transcript);
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
            // Carry the topic so restarting a finished room keeps its subject, and
            // the routing config (flat keys) so a finished group-chat restarts with
            // the same moderator rather than failing start validation.
            ...(room.topic ? { topic: room.topic } : {}),
            ...configPayload(room),
          },
        },
        {
          // Re-open as a moderated group-chat: a `fields` form (base #120) collects
          // the moderator slug, merged flat into the dispatched payload. The
          // moderator must be a Mind NOT among participants — start validation
          // rejects otherwise.
          type: "room-start",
          label: "Start group-chat",
          glyph: "◇",
          payload: {
            name: room.name,
            strategy: "group-chat",
            participants: room.participants,
            turnBudget: room.turnBudget,
            ...(room.topic ? { topic: room.topic } : {}),
          },
          fields: [
            {
              name: "moderator",
              label: "Moderator (a Mind not in the room)",
              placeholder: "mind-slug",
              required: true,
            },
          ],
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

// The room's routing config as flat payload keys, so "Start again" round-trips a
// group-chat through start validation. Sequential rooms carry no config and emit
// nothing.
function configPayload(room: Room): Record<string, string | number> {
  const c = room.config;
  if (!c) return {};
  return {
    ...(c.moderator ? { moderator: c.moderator } : {}),
    ...(c.synthesizer ? { synthesizer: c.synthesizer } : {}),
    ...(typeof c.minRounds === "number" ? { minRounds: c.minRounds } : {}),
    ...(typeof c.maxSpeakerRepeats === "number" ? { maxSpeakerRepeats: c.maxSpeakerRepeats } : {}),
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
