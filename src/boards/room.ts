import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
import { flatFromRoomConfig } from "../room-config.ts";
import { speakerCounts, stripControlJson } from "../routing.ts";
import type { MindSlug, Room, TurnEntry } from "../types.ts";

// Pure: a room + its transcript -> a canvas `board` (a `rows` feed, one row per
// turn, plus a participant `segments` header). Validated against canvasViewSchema
// in tests.
export function buildRoomBoard(room: Room, transcript: readonly TurnEntry[]): CanvasBoardView {
  // Same fold the routing engine uses, so the board's per-speaker counts can never
  // drift from the anti-monopoly cap / close gate.
  const counts = speakerCounts(transcript);
  const segments = room.participants.map((slug) => ({ label: slug, n: counts.get(slug) ?? 0 }));

  const items = buildFeed(room, transcript);

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
            // Carry the topic so restarting a finished room keeps its subject, the
            // routing config (flat keys) so a finished group-chat/open-floor restarts
            // with the same config rather than failing start validation, and the
            // project target + coding tier so the restart runs against the same repo
            // with the same capabilities.
            ...(room.topic ? { topic: room.topic } : {}),
            ...(room.projectId ? { projectId: room.projectId } : {}),
            ...(room.coding ? { coding: room.coding } : {}),
            ...flatFromRoomConfig(room.config),
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
            ...(room.projectId ? { projectId: room.projectId } : {}),
            ...(room.coding ? { coding: room.coding } : {}),
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
        {
          // Re-open as an unmoderated open-floor: speakers nominate the next and
          // vote to close. No fields — the end-vote threshold has a default.
          type: "room-start",
          label: "Start open-floor",
          glyph: "◎",
          payload: {
            name: room.name,
            strategy: "open-floor",
            participants: room.participants,
            turnBudget: room.turnBudget,
            ...(room.topic ? { topic: room.topic } : {}),
            ...(room.projectId ? { projectId: room.projectId } : {}),
            ...(room.coding ? { coding: room.coding } : {}),
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

// One rows item — the feed mixes turn rows with thin round/termination markers.
type FeedItem = Extract<CanvasBoardView["sections"][number], { kind: "rows" }>["items"][number];

// The transcript feed: a row per turn, with a thin "Round N" divider wherever the
// round cursor advances and a single termination marker once the room closes.
// Facilitator turns (the moderator's routing, the synthesizer's closing summary)
// read distinctly from participant chatter — both are non-participant Minds, so an
// identity check on `from` is exact (start validation keeps them out of the roster).
function buildFeed(room: Room, transcript: readonly TurnEntry[]): FeedItem[] {
  const moderator = room.config?.moderator;
  const synthesizer = room.config?.synthesizer;
  const items: FeedItem[] = [];
  let prevRound: number | undefined;
  for (const entry of transcript) {
    if (entry.round !== undefined) {
      if (prevRound !== undefined && entry.round > prevRound) {
        items.push({ icon: "—", glyph: "neutral", text: `Round ${entry.round + 1}` });
      }
      prevRound = entry.round;
    }
    items.push(turnRow(entry, moderator, synthesizer));
  }
  const end = terminationMarker(room);
  if (end) items.push(end);
  return items;
}

function turnRow(
  entry: TurnEntry,
  moderator: MindSlug | undefined,
  synthesizer: MindSlug | undefined,
): FeedItem {
  const text = turnText(entry);
  const trailing = entry.aborted ? `${entry.at} · aborted` : entry.at;
  // An aborted turn reads as an error dot whoever authored it.
  if (entry.aborted) {
    return {
      glyph: "error",
      chip: { label: entry.from, tone: roleTone(entry.role) },
      text,
      trailing,
    };
  }
  if (entry.from === synthesizer) {
    return {
      glyph: "brand",
      chip: { label: entry.from, tone: "brand" },
      icon: "◆",
      text,
      trailing,
    };
  }
  if (entry.from === moderator) {
    return {
      glyph: "accent",
      chip: { label: entry.from, tone: "accent" },
      icon: "◇",
      text,
      trailing,
    };
  }
  return {
    glyph: roleTone(entry.role),
    chip: { label: entry.from, tone: roleTone(entry.role) },
    text,
    trailing,
  };
}

// A closed room ends with one thin marker: "Stopped" (interrupted) vs "Closed"
// (ran to a natural end). The room records no close reason, and the turn count
// can't tell a budget-gate close from a moderator close that lands on budget, so
// the marker stays coarse — the header's turnIndex/turnBudget chip already shows
// whether the budget was reached.
function terminationMarker(room: Room): FeedItem | undefined {
  if (room.status === "active") return undefined;
  if (room.status === "stopped") return { icon: "—", glyph: "warn", text: "Stopped" };
  return { icon: "—", glyph: "neutral", text: "Closed" };
}

function turnText(entry: TurnEntry): string {
  // Strip the trailing control directive (a moderator's routing JSON, an
  // open-floor speaker's nomination tail) the same way the prompt context does
  // (transcript.ts), so the machine-routing JSON never leaks into the rendered turn.
  const text = stripControlJson(entry.parts.map((p) => p.text).join("\n")).trim();
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
