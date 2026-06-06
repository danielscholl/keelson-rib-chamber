import type { RoomStrategyName, Strategy } from "../types.ts";
import { sequential } from "./sequential.ts";

// concurrent aliases sequential in Phase 2: its parallel execution is deferred
// behind the snapshot-coalescing pump (docs/design/A2A-communication.md), so it
// runs serially for now rather than faking parallelism. group-chat / open-floor
// are Phase 3 — absent here, so getStrategy throws until they are registered.
export const strategies: Partial<Record<RoomStrategyName, Strategy>> = {
  sequential,
  concurrent: sequential,
};

export function getStrategy(name: RoomStrategyName): Strategy {
  const strategy = strategies[name];
  if (!strategy) throw new Error(`strategy "${name}" is not implemented`);
  return strategy;
}

export { sequential };
