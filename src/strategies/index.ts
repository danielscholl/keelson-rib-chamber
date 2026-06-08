import type { RoomStrategyName, Strategy } from "../types.ts";
import { groupChat } from "./group-chat.ts";
import { sequential } from "./sequential.ts";

// concurrent aliases sequential in Phase 2: its parallel execution is deferred
// behind the snapshot-coalescing pump (docs/design/A2A-communication.md), so it
// runs serially for now rather than faking parallelism. group-chat is the
// moderator-routed Phase 3 strategy; open-floor is still absent, so getStrategy
// throws for it until it is registered.
export const strategies: Partial<Record<RoomStrategyName, Strategy>> = {
  sequential,
  concurrent: sequential,
  "group-chat": groupChat,
};

export function getStrategy(name: RoomStrategyName): Strategy {
  const strategy = strategies[name];
  if (!strategy) throw new Error(`strategy "${name}" is not implemented`);
  return strategy;
}

export { groupChat, sequential };
