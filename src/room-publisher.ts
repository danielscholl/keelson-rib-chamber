import type { CanvasView } from "@keelson/shared";

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
// It is seeded with `seed` (default: an empty Room board; the lens pool passes its
// own placeholder) so a client subscribing before the first publish gets a
// well-formed view, not a loading skeleton.
//
// `published` is the view a compose actually put on the key, undefined until one
// has. It is NOT `latest`, which moves before the compose it feeds and keeps moving
// when that compose throws or coalesces someone else's board onto the key — so a
// caller asking "is this already what the surface shows?" must ask this instead.
export function createCoalescingPublisher<T>(
  recompose: () => Promise<unknown>,
  seed: T,
): {
  publisher: { publish(view: T): Promise<void> };
  latest: () => T;
  published: () => T | undefined;
};
export function createCoalescingPublisher(
  recompose: () => Promise<unknown>,
  seed?: CanvasView,
): {
  publisher: { publish(view: CanvasView): Promise<void> };
  latest: () => CanvasView;
  published: () => CanvasView | undefined;
};
export function createCoalescingPublisher<T>(
  recompose: () => Promise<unknown>,
  seed: T = { view: "board", title: "Room", sections: [] } as T,
): {
  publisher: { publish(view: T): Promise<void> };
  latest: () => T;
  published: () => T | undefined;
} {
  let latest: T = seed;
  let published: T | undefined;
  let composing = false;
  let dirty = false;
  const publisher = {
    async publish(view: T): Promise<void> {
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
        // Only the pump records what landed, and only once the loop settles: dirty
        // is false here, so the last compose read exactly this board. A coalesced
        // caller returns above without claiming a landing it never made, and a
        // throwing compose skips this entirely.
        published = latest;
      } finally {
        composing = false;
      }
    },
  };
  return { publisher, latest: () => latest, published: () => published };
}
