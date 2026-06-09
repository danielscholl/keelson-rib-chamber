import type { RoomStrategyName, Strategy } from "../types.ts";
import { groupChat } from "./group-chat.ts";
import { openFloor } from "./open-floor.ts";
import { sequential } from "./sequential.ts";

// concurrent aliases sequential in Phase 2: its parallel execution is deferred
// behind the snapshot-coalescing pump (docs/design/A2A-communication.md), so it
// runs serially for now rather than faking parallelism. group-chat is the
// moderator-routed Phase 3 strategy; open-floor is the unmoderated one (each
// speaker nominates the next, the driver does the routing).
export const strategies: Partial<Record<RoomStrategyName, Strategy>> = {
  sequential,
  concurrent: sequential,
  "group-chat": groupChat,
  "open-floor": openFloor,
};

export function getStrategy(name: RoomStrategyName): Strategy {
  // Own-property only: a bare index would resolve inherited Object members
  // ("constructor", "__proto__", "toString") to truthy non-Strategy values, so a
  // crafted strategy string would slip past this guard and crash the loop later.
  const strategy = Object.hasOwn(strategies, name) ? strategies[name] : undefined;
  if (!strategy) throw new Error(`strategy "${name}" is not implemented`);
  return strategy;
}

export { groupChat, openFloor, sequential };
