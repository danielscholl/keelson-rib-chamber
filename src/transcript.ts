import type { MindSlug, TurnEntry } from "./types.ts";

// Render a transcript as the prompt context fed to the next speaker — oldest to
// newest, one "from: text" block per turn. Pure.
export function renderTranscript(transcript: readonly TurnEntry[]): string {
  return transcript
    .map((entry) => `${entry.from}: ${entry.parts.map((p) => p.text).join("\n")}`)
    .join("\n\n");
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
