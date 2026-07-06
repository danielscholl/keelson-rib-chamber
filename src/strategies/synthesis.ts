import type { MindSlug, Room, TurnEntry } from "../types.ts";

export function exhaustedSynthesis(
  room: Room,
  transcript: readonly TurnEntry[],
  fallback?: MindSlug,
): { kind: "synthesize"; mind: MindSlug } | { kind: "end" } {
  if (room.config?.synthesizer) return { kind: "synthesize", mind: room.config.synthesizer };
  const mind =
    fallback ??
    lastParticipantAgent(transcript, room.participants) ??
    previousParticipant(room.participants, room.turnIndex);
  return mind ? { kind: "synthesize", mind } : { kind: "end" };
}

export function lastParticipantAgent(
  transcript: readonly TurnEntry[],
  participants: readonly MindSlug[],
): MindSlug | undefined {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const from = transcript[i]?.from;
    if (from && participants.includes(from)) return from;
  }
}

function previousParticipant(
  participants: readonly MindSlug[],
  turnIndex: number,
): MindSlug | undefined {
  if (participants.length === 0) return undefined;
  return participants[Math.max(0, turnIndex - 1) % participants.length];
}
