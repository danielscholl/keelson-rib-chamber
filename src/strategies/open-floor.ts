import { leastSpoken, speakerCounts } from "../routing.ts";
import type { Strategy } from "../types.ts";

// Pure tier-3 seed/fallback for an unmoderated room. Returns `end` for the
// structural cases (not active / no participants / budget reached); otherwise the
// least-spoken participant, which seeds the first speaker (everyone at 0 ->
// participants[0]) and rotates fairly thereafter. The end-vote gate and peer
// nomination (both parse text) live in the driver's decideOpenFloor — this
// strategy reads the transcript only through speakerCounts and never parses.
export const openFloor: Strategy = ({ room, transcript }) => {
  if (room.status !== "active") return { kind: "end" };
  if (room.participants.length === 0) return { kind: "end" };
  if (room.turnIndex >= room.turnBudget) return { kind: "end" };
  const next = leastSpoken(room.participants, speakerCounts(transcript)) ?? room.participants[0];
  return next ? { kind: "speak", mind: next } : { kind: "end" };
};
