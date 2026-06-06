import type { Strategy } from "../types.ts";

// Pure round-robin over participants, keyed on turnIndex. Returns `end` when the
// room is not active, has no participants, or has reached its turn budget. It
// does NOT read room.pending — the driver applies director overrides and only
// falls back to the strategy when there is none.
export const sequential: Strategy = (room) => {
  if (room.status !== "active") return { kind: "end" };
  if (room.participants.length === 0) return { kind: "end" };
  if (room.turnIndex >= room.turnBudget) return { kind: "end" };
  const next = room.participants[room.turnIndex % room.participants.length];
  return next ? { kind: "speak", mind: next } : { kind: "end" };
};
