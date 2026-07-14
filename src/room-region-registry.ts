import type { CanvasView, RibSurfaceRegion, SnapshotManager } from "@keelson/shared";
import { expectView } from "@keelson/shared";
import { CHAMBER_SURFACE_ID } from "./lens.ts";
import type { RoomPublisher } from "./ports.ts";
import { createCoalescingPublisher } from "./room-publisher.ts";
import type { MindSlug } from "./types.ts";

// Each room publishes its board under a per-slug key (rib:chamber:room:<slug>),
// registered as its own surface region through the harness `registerRegion` seam —
// the same mechanism lenses use. The rib withholds the room driver entirely when
// `registerRegion` is absent (see index.ts), so the registry requires it rather than
// publishing an invisible key that never renders.
//
// A key and its panel have DIFFERENT lifetimes: the panel is for a room that is live,
// but the key is what the Rooms index `Open` reads, so it survives the panel.

export function roomKey(slug: string): string {
  return `rib:chamber:room:${slug}`;
}

type RegisterRegion = (surfaceId: string, region: RibSurfaceRegion) => () => void;

// A RoomPublisher whose publish() routes each room's board to its own snapshot key
// and surface region, lazily registering both the first time a slug publishes.
// `retainOnly` keeps the named rooms' PANELS and drops the rest; dispose() releases
// everything.
export interface RoomRegionRegistry extends RoomPublisher {
  retainOnly(keep: Iterable<MindSlug>): void;
  dispose(): void;
}

interface RoomEntry {
  key: string;
  publisher: { publish(view: CanvasView): Promise<void> };
  unregisterSnapshot: () => void;
  // Cleared once the panel is retired — the key outlives it (see releaseRegion).
  unregisterRegion?: () => void;
}

export function createRoomRegionRegistry(
  sm: SnapshotManager,
  registerRegion: RegisterRegion,
): RoomRegionRegistry {
  const entries = new Map<string, RoomEntry>();

  // Register a slug's snapshot key and surface region. Fully synchronous between the
  // entries.get miss in publish and this entries.set, so two publishes racing the
  // same new slug can't both reach sm.register and trip its duplicate-key guard; the
  // second finds the entry and just republishes.
  function register(slug: MindSlug, title: string): RoomEntry {
    const key = roomKey(slug);
    const { publisher, latest } = createCoalescingPublisher(() => sm.recompose(key));
    const unregisterSnapshot = sm.register(key, latest, { validate: expectView(key, "board") });
    let unregisterRegion: () => void;
    try {
      unregisterRegion = registerRegion(CHAMBER_SURFACE_ID, {
        key,
        title,
        glyph: { char: "▦", tone: "brand" },
        group: "rooms",
        // The first room's groupTitle labels the whole "Rooms" zone the merge forms
        // from the per-slug regions, so the live room panels read as a titled lane.
        groupTitle: "Rooms",
      });
    } catch (e) {
      // A failed region add (e.g. the harness per-surface ceiling) must not leak the
      // snapshot registration we already made.
      unregisterSnapshot();
      throw e;
    }
    const entry: RoomEntry = { key, publisher, unregisterSnapshot, unregisterRegion };
    entries.set(slug, entry);
    return entry;
  }

  // Retire a room's PANEL but keep its key alive. A drawer opened on a live room reads
  // that key, and the host closes a subscription to a gone key permanently — so a room
  // ending under an open drawer must not take the board out from under it. The key then
  // outlives the panel, as roomViewKey's already does, until dispose.
  function releaseRegion(slug: string): void {
    const entry = entries.get(slug);
    if (!entry?.unregisterRegion) return;
    entry.unregisterRegion();
    entry.unregisterRegion = undefined;
  }

  function release(slug: string): void {
    const entry = entries.get(slug);
    if (!entry) return;
    entry.unregisterRegion?.();
    entry.unregisterSnapshot();
    entries.delete(slug);
  }

  return {
    async publish(slug, view) {
      let entry = entries.get(slug);
      if (!entry) {
        // The board carries the room name (buildRoomBoard sets title = room.name); use
        // it as the region's static identity, falling back to the slug.
        const title = "title" in view && typeof view.title === "string" && view.title;
        entry = register(slug, title || slug);
        // Seed the cache so a client subscribing the instant the panel appears reads
        // the seed board, not a 204 (the GET path doesn't lazy-compose). The entry is
        // already mapped, so this await can't reopen the duplicate-register race.
        await sm.recompose(entry.key);
      }
      await entry.publisher.publish(view);
    },
    retainOnly(keep) {
      const keepSet = keep instanceof Set ? keep : new Set(keep);
      for (const slug of [...entries.keys()]) {
        if (!keepSet.has(slug)) releaseRegion(slug);
      }
    },
    dispose() {
      for (const slug of [...entries.keys()]) release(slug);
    },
  };
}
