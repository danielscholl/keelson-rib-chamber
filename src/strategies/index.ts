import type { RoomStrategyName, Strategy } from "../types.ts";
import { concurrent } from "./concurrent.ts";
import { groupChat } from "./group-chat.ts";
import { openFloor } from "./open-floor.ts";
import { review } from "./review.ts";
import { sequential } from "./sequential.ts";

// sequential rotates one speaker per turn by turnIndex; concurrent fans all
// participants out in one parallel round (the driver runs the round's turns at
// once). group-chat is the moderator-routed Phase 3 strategy; open-floor is the
// unmoderated one (each speaker nominates the next, the driver does the routing).
// review is the two-Mind, single-pass cross-vendor review (author then reviewer).
export const strategies: Partial<Record<RoomStrategyName, Strategy>> = {
  sequential,
  concurrent,
  "group-chat": groupChat,
  "open-floor": openFloor,
  review,
};

export function getStrategy(name: RoomStrategyName): Strategy {
  // Own-property only: a bare index would resolve inherited Object members
  // ("constructor", "__proto__", "toString") to truthy non-Strategy values, so a
  // crafted strategy string would slip past this guard and crash the loop later.
  const strategy = Object.hasOwn(strategies, name) ? strategies[name] : undefined;
  if (!strategy) throw new Error(`strategy "${name}" is not implemented`);
  return strategy;
}

export { concurrent, groupChat, openFloor, review, sequential };
