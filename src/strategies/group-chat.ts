import type { Strategy } from "../types.ts";
import { exhaustedSynthesis } from "./synthesis.ts";

// A moderator-routed group chat. The strategy is pure rhythm: while the room is
// active, under budget, and has a configured moderator, it hands control to that
// moderator. It never reads the moderator's reply — parsing the routing tail,
// validating the pick, the close gate, and running the speaker all live in the
// driver's `moderate` branch (the strategy never parses free text). At budget
// exhaustion, the moderator writes the closing synthesis.
export const groupChat: Strategy = ({ room, transcript }) => {
  if (room.status !== "active") return { kind: "end" };
  if (room.participants.length === 0) return { kind: "end" };
  const moderator = room.config?.moderator;
  if (room.turnIndex >= room.turnBudget) return exhaustedSynthesis(room, transcript, moderator);
  if (!moderator) return { kind: "end" };
  return { kind: "moderate", mind: moderator };
};
