import type { MindSlug, TurnEntry } from "./types.ts";

// Render a transcript as the prompt context fed to the next speaker — oldest to
// newest, one "from: text" block per turn. Pure.
export function renderTranscript(transcript: readonly TurnEntry[]): string {
  return transcript
    .map((entry) => `${entry.from}: ${entry.parts.map((p) => p.text).join("\n")}`)
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
  if (input.topic) parts.push(`Room topic: ${input.topic}`);
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
