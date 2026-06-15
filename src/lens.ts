import type { CanvasView, SnapshotManager } from "@keelson/shared";
import { expectView } from "@keelson/shared";
import { createCoalescingPublisher } from "./room-publisher.ts";

// A fixed pool of pre-declared lens snapshot keys. A Mind authors a lens by
// publishing a board to one of these slots (chamber_emit_lens); because the keys
// ship in the boot manifest, a freshly authored lens renders with no manifest
// re-fetch. Unbounded per-lens keys (rib:chamber:lens:<mind>:<id>) would need a
// base dynamic-view seam (registerView) the harness lacks today — see
// docs/design/phase3-lenses.md.
export const LENS_SLOT_COUNT = 3;

export function lensKey(slot: number): string {
  return `rib:chamber:lens:${slot}`;
}

export const LENS_KEYS: readonly string[] = Array.from({ length: LENS_SLOT_COUNT }, (_, i) =>
  lensKey(i),
);

// The seed a slot renders before any Mind authors into it: a valid, titled board
// with one hint row, so an empty slot reads as an empty panel rather than a
// loading skeleton. The authored board (with its own title) replaces it on publish.
export function emptyLensBoard(): CanvasView {
  return {
    view: "board",
    title: "Lens",
    sections: [
      {
        kind: "rows",
        items: [
          {
            text: "No lens yet — author one with /workflow run chamber-lens <subject>",
            glyph: "neutral",
          },
        ],
      },
    ],
  };
}

// Maps a logical lens id to a fixed slot, LRU. Re-authoring the same id reuses its
// slot (the panel updates in place); a new id takes the next free slot, then evicts
// the least-recently-authored once the pool is full. Pure and deterministic, so the
// routing is unit-testable apart from the publish side.
export interface SlotAllocator {
  allocate(id: string): number;
  slotOf(id: string): number | undefined;
}

export function createSlotAllocator(count: number): SlotAllocator {
  if (count < 1) throw new Error("lens slot pool needs at least one slot");
  const idToSlot = new Map<string, number>();
  // Least-recently-authored first; the eviction victim is always lru[0].
  const lru: string[] = [];
  const touch = (id: string): void => {
    const at = lru.indexOf(id);
    if (at >= 0) lru.splice(at, 1);
    lru.push(id);
  };
  return {
    allocate(id) {
      const existing = idToSlot.get(id);
      if (existing !== undefined) {
        touch(id);
        return existing;
      }
      let slot: number;
      if (idToSlot.size < count) {
        // Slots fill densely from 0 and never free (eviction reuses the victim's
        // slot), so the next free index is exactly the current occupancy count.
        slot = idToSlot.size;
      } else {
        const victim = lru.shift();
        if (victim === undefined) throw new Error("lens allocator: full pool with empty LRU");
        const victimSlot = idToSlot.get(victim);
        if (victimSlot === undefined) throw new Error("lens allocator: LRU/slot desync");
        slot = victimSlot;
        idToSlot.delete(victim);
      }
      idToSlot.set(id, slot);
      touch(id);
      return slot;
    },
    slotOf: (id) => idToSlot.get(id),
  };
}

// The publish side: registers each slot key on the snapshot manager (seeded +
// fail-closed via expectView), then routes a board to the id's slot and broadcasts
// a live frame. Holds the allocator, so re-authoring an id refreshes the same panel.
export interface LensRegistry {
  publish(id: string, board: CanvasView): Promise<{ slot: number }>;
}

export function createLensRegistry(sm: SnapshotManager): LensRegistry {
  const allocator = createSlotAllocator(LENS_SLOT_COUNT);
  const publishers = LENS_KEYS.map((key) => {
    const { publisher, latest } = createCoalescingPublisher(
      () => sm.recompose(key),
      emptyLensBoard(),
    );
    sm.register(key, latest, { validate: expectView(key, "board") });
    return publisher;
  });
  // Prime each slot so a client subscribing before any lens is authored gets the
  // seeded board, not a loading skeleton (the GET path doesn't lazy-compose).
  for (const key of LENS_KEYS) void sm.recompose(key);
  return {
    async publish(id, board) {
      // The manager swallows a validate throw at recompose (keeps the prior frame,
      // broadcasts nothing), so a board that fails the slot's expectView gate would
      // be dropped while the caller is told it published. Validate against the same
      // gate here, and BEFORE allocating, so a board we can't render fails closed
      // loudly and never evicts a live lens for nothing.
      expectView("rib:chamber:lens", "board")(board);
      const slot = allocator.allocate(id);
      const publisher = publishers[slot];
      if (!publisher) throw new Error(`lens slot ${slot} has no publisher`);
      await publisher.publish(board);
      return { slot };
    },
  };
}
