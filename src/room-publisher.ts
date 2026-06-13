import type { CanvasView } from "@keelson/shared";
import type { RoomPublisher } from "./ports.ts";

// The room board's publish seam plus the coalescing pump that mirrors the base's
// bound-workflow publish. `recompose` coalesces concurrent calls onto one
// in-flight compose, so a publish that lands while another is composing would
// otherwise never broadcast its board — e.g. a director inject racing a turn's
// terminal commit, or the overlapping publishes a concurrent round can produce.
// The dirty flag re-runs the compose once more whenever a publish arrived
// mid-compose, so the latest board always reaches the canvas.
//
// `latest` is the registered snapshot composer (`() => CanvasView`): the manager
// reads it at compose time, so it must return the most recently published board.
// It is seeded with a valid empty board so a client subscribing before the first
// turn gets a well-formed view, not a loading skeleton.
export function createCoalescingPublisher(recompose: () => Promise<unknown>): {
  publisher: RoomPublisher;
  latest: () => CanvasView;
} {
  let latest: CanvasView = { view: "board", title: "Room", sections: [] };
  let composing = false;
  let dirty = false;
  const publisher: RoomPublisher = {
    async publish(view) {
      latest = view;
      if (composing) {
        dirty = true;
        return;
      }
      composing = true;
      try {
        do {
          dirty = false;
          await recompose();
        } while (dirty);
      } finally {
        composing = false;
      }
    },
  };
  return { publisher, latest: () => latest };
}
