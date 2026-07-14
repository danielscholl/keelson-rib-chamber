import type { CanvasView, SnapshotManager } from "@keelson/shared";
import { expectView } from "@keelson/shared";
import type { RoomPublisher } from "./ports.ts";
import { createCoalescingPublisher } from "./room-publisher.ts";
import type { MindSlug } from "./types.ts";

// Each room publishes its board under a per-slug key (rib:chamber:room:<slug>), which
// the Rooms index `Open` focuses to stream a live room into the drawer. A room is an
// activity, not a standing view, so it holds no surface panel — you enter it.
//
// A key outlives the room that made it: it is released only when the room is deleted or
// the rib disposes, never when the room merely ends, because the host closes a
// subscription to a gone key permanently and a drawer may still be reading it.

export function roomKey(slug: string): string {
  return `rib:chamber:room:${slug}`;
}

// A RoomPublisher whose publish() routes each room's board to its own snapshot key,
// lazily registering it the first time a slug publishes.
export interface RoomKeyRegistry extends RoomPublisher {
  // Returns whether a key was actually released (mirrors LensRegistry.remove).
  release(slug: MindSlug): boolean;
  dispose(): void;
}

interface RoomEntry {
  key: string;
  publisher: { publish(view: CanvasView): Promise<void> };
  unregisterSnapshot: () => void;
}

export function createRoomKeyRegistry(sm: SnapshotManager): RoomKeyRegistry {
  const entries = new Map<string, RoomEntry>();

  // Register a slug's snapshot key. Fully synchronous between the entries.get miss in
  // publish and this entries.set, so two publishes racing the same new slug can't both
  // reach sm.register and trip its duplicate-key guard; the second finds the entry and
  // just republishes.
  function register(slug: MindSlug): RoomEntry {
    const key = roomKey(slug);
    const { publisher, latest } = createCoalescingPublisher(() => sm.recompose(key));
    const unregisterSnapshot = sm.register(key, latest, { validate: expectView(key, "board") });
    const entry: RoomEntry = { key, publisher, unregisterSnapshot };
    entries.set(slug, entry);
    return entry;
  }

  function releaseEntry(slug: string): boolean {
    const entry = entries.get(slug);
    if (!entry) return false;
    entry.unregisterSnapshot();
    entries.delete(slug);
    return true;
  }

  return {
    async publish(slug, view) {
      let entry = entries.get(slug);
      if (!entry) {
        entry = register(slug);
        // Seed the cache so a client opening the room the instant it starts reads the
        // seed board, not a 204 (the GET path doesn't lazy-compose). The entry is
        // already mapped, so this await can't reopen the duplicate-register race.
        await sm.recompose(entry.key);
      }
      await entry.publisher.publish(view);
    },
    release: releaseEntry,
    dispose() {
      for (const slug of [...entries.keys()]) releaseEntry(slug);
    },
  };
}
