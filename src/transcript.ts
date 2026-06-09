import { stripControlJson } from "./routing.ts";
import type { MindSlug, TurnEntry } from "./types.ts";

// Render a transcript as the prompt context fed to the next speaker — oldest to
// newest, one "from: text" block per turn. A trailing control directive (a
// moderator's routing JSON, a speaker's nomination tail) is stripped so it never
// leaks into the next speaker's context and gets mimicked; the on-disk entry is
// untouched (the driver re-parses the raw text for routing). Pure.
export function renderTranscript(transcript: readonly TurnEntry[]): string {
  return transcript
    .map((entry) => `${entry.from}: ${stripControlJson(entry.parts.map((p) => p.text).join("\n"))}`)
    .join("\n\n");
}

// The prompt fed to the next speaker: the room topic (if any), the conversation
// so far, an optional director steer, and a standing instruction to reply in
// character. Always non-empty — a first turn (empty transcript, no topic) still
// yields the instruction, so the agent is never invoked with an empty prompt (a
// CLI errors on that). Pure.
export function buildTurnPrompt(input: {
  topic?: string;
  transcript: readonly TurnEntry[];
  directionInjection?: string;
}): string {
  const parts: string[] = [];
  const topic = input.topic?.trim();
  if (topic) parts.push(`Room topic: ${topic}`);
  const context = renderTranscript(input.transcript);
  parts.push(
    context.length > 0
      ? `Conversation so far:\n\n${context}`
      : "You are the first to speak — open the discussion.",
  );
  if (input.directionInjection) parts.push(`[director]: ${input.directionInjection}`);
  parts.push(
    "Respond with your next message in the conversation — in character, concise, no narration of others.",
  );
  return parts.join("\n\n");
}

// The moderator's prompt for a group-chat turn: the discussion so far plus an
// instruction to route or close by ending the reply with a single trailing JSON
// object. The control words are the SAME members of CONTROL_ACTIONS the parser
// reads and the stripper removes, so prompt, parser, and stripper never drift.
// Deliberation prose is encouraged and stays visible on the board; only the
// trailing JSON is stripped from the next speaker's context. Always non-empty.
export function buildModeratorPrompt(input: {
  topic?: string;
  transcript: readonly TurnEntry[];
  participants: readonly MindSlug[];
  directionInjection?: string;
}): string {
  const parts: string[] = [];
  const topic = input.topic?.trim();
  if (topic) parts.push(`Room topic: ${topic}`);
  const context = renderTranscript(input.transcript);
  parts.push(
    context.length > 0
      ? `Conversation so far:\n\n${context}`
      : "The discussion has not started yet — open it by directing the first speaker.",
  );
  parts.push(`Participants you may direct: ${input.participants.join(", ")}.`);
  if (input.directionInjection) parts.push(`[director]: ${input.directionInjection}`);
  parts.push(
    "You are the moderator. Briefly weigh the discussion, then END your reply with ONE JSON object on its own line:\n" +
      '{"action":"direct","next_speaker":"<participant>","direction":"<what they should address>"} to hand off, ' +
      'or {"action":"close"} to end the room. Pick next_speaker from the participants above.',
  );
  return parts.join("\n\n");
}

// The prompt for an open-floor (unmoderated) speaker: the discussion so far plus
// the nominate/pass/end vocabulary, so each speaker hands off or votes to close by
// ending its reply with a single trailing JSON object. The control words are the
// SAME members of CONTROL_ACTIONS the parser reads and the stripper removes, so
// prompt, parser, and stripper never drift. Always non-empty.
export function buildOpenFloorPrompt(input: {
  topic?: string;
  transcript: readonly TurnEntry[];
  participants: readonly MindSlug[];
  directionInjection?: string;
}): string {
  const parts: string[] = [];
  const topic = input.topic?.trim();
  if (topic) parts.push(`Room topic: ${topic}`);
  const context = renderTranscript(input.transcript);
  parts.push(
    context.length > 0
      ? `Conversation so far:\n\n${context}`
      : "You are the first to speak — open the discussion.",
  );
  parts.push(`Participants you may nominate: ${input.participants.join(", ")}.`);
  if (input.directionInjection) parts.push(`[director]: ${input.directionInjection}`);
  parts.push(
    "Speak in character, then END your reply with ONE JSON object on its own line:\n" +
      '{"action":"nominate","slug":"<participant>","reason":"<why>"} to hand off, ' +
      '{"action":"pass"} to defer, or {"action":"end"} to vote to close the room. ' +
      "Pick slug from the participants above (not yourself).",
  );
  return parts.join("\n\n");
}

// The closing synthesis prompt: the discussion so far plus an instruction to sum
// up. No routing JSON — synthesis is the room's last act. Always non-empty.
export function buildSynthesisPrompt(input: {
  topic?: string;
  transcript: readonly TurnEntry[];
}): string {
  const parts: string[] = [];
  const topic = input.topic?.trim();
  if (topic) parts.push(`Room topic: ${topic}`);
  const context = renderTranscript(input.transcript);
  if (context.length > 0) parts.push(`Conversation so far:\n\n${context}`);
  parts.push(
    "Synthesize the discussion into a concise closing summary — areas of agreement, open disagreements, and the recommendation. Speak in your own voice. Do not emit any routing JSON.",
  );
  return parts.join("\n\n");
}

export interface BuildTurnEntryInput {
  roomSlug: MindSlug;
  turnIndex: number;
  from: TurnEntry["from"];
  role: TurnEntry["role"];
  text: string;
  messageId: string;
  at: string;
  aborted?: boolean;
  round?: number;
}

// Build a transcript entry from driver-stamped fields. Centralised so the driver
// is the single author of `from` / `turnIndex` / `at` and the shape lives in one
// place.
export function buildTurnEntry(input: BuildTurnEntryInput): TurnEntry {
  return {
    messageId: input.messageId,
    roomSlug: input.roomSlug,
    turnIndex: input.turnIndex,
    ...(input.round !== undefined ? { round: input.round } : {}),
    from: input.from,
    role: input.role,
    parts: [{ text: input.text }],
    ...(input.aborted ? { aborted: true } : {}),
    at: input.at,
  };
}
