import type { Strategy } from "../types.ts";

// A two-Mind, single-pass review: the author (participants[0]) speaks first and
// produces the artifact, then the reviewer (participants[1]) — pinned to a
// different provider, enforced at room-start — critiques it, then the room ends.
// Pure rhythm by turnIndex; the driver builds the reviewer's artifact-only prompt
// and runs the turns. Ends when the room is closed, has fewer than two
// participants, or has reached its budget. Review is EXEMPT from exhaustion
// synthesis: the reviewer's critique is itself the closing artifact (validateStart
// rejects a synthesizer for the same reason), so a summary turn would only
// restate it at the cost of a paid turn.
export const review: Strategy = ({ room }) => {
  if (room.status !== "active") return { kind: "end" };
  if (room.participants.length < 2) return { kind: "end" };
  if (room.turnIndex >= room.turnBudget) return { kind: "end" };
  const [author, reviewer] = room.participants;
  if (room.turnIndex === 0) return author ? { kind: "speak", mind: author } : { kind: "end" };
  if (room.turnIndex === 1) return reviewer ? { kind: "speak", mind: reviewer } : { kind: "end" };
  return { kind: "end" };
};
