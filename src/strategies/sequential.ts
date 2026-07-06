import type { Strategy } from "../types.ts";
import { exhaustedSynthesis } from "./synthesis.ts";

// Pure round-robin over participants, keyed on turnIndex. Returns `end` when the
// room is not active or has no participants. At budget exhaustion, the last
// speaker writes the closing synthesis. It reads only room state and transcript —
// director overrides and richer routing are the driver's job; sequential just rotates.
export const sequential: Strategy = ({ room, transcript }) => {
  if (room.status !== "active") return { kind: "end" };
  if (room.participants.length === 0) return { kind: "end" };
  if (room.turnIndex >= room.turnBudget) return exhaustedSynthesis(room, transcript);
  const next = room.participants[room.turnIndex % room.participants.length];
  return next ? { kind: "speak", mind: next } : { kind: "end" };
};
