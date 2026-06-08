import type { Strategy } from "../types.ts";

// Pure round-robin over participants, keyed on turnIndex. Returns `end` when the
// room is not active, has no participants, or has reached its turn budget. It
// reads only room state — director overrides and richer routing are the driver's
// job; sequential just rotates (transcript/round are unused here).
export const sequential: Strategy = ({ room }) => {
  if (room.status !== "active") return { kind: "end" };
  if (room.participants.length === 0) return { kind: "end" };
  if (room.turnIndex >= room.turnBudget) return { kind: "end" };
  const next = room.participants[room.turnIndex % room.participants.length];
  return next ? { kind: "speak", mind: next } : { kind: "end" };
};
