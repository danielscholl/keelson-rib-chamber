import type { Strategy } from "../types.ts";

// Fan every participant out in one parallel round, then end. Pure: returns the
// speak-parallel step while the room is active and under budget — the driver runs
// the round's turns concurrently (each prompted from the same pre-round
// transcript, so they don't hear each other), trims the batch to the remaining
// budget, and appends the replies in participant order. Unlike sequential it does
// not rotate by turnIndex: every participant speaks each round.
export const concurrent: Strategy = ({ room }) => {
  if (room.status !== "active") return { kind: "end" };
  if (room.participants.length === 0) return { kind: "end" };
  if (room.turnIndex >= room.turnBudget) return { kind: "end" };
  return { kind: "speak-parallel", minds: room.participants };
};
