import { describe, expect, test } from "bun:test";
import type { CanvasBoardView, SnapshotManager } from "@keelson/shared";
import { expectView } from "@keelson/shared";
import {
  createLensRegistry,
  createSlotAllocator,
  emptyLensBoard,
  LENS_KEYS,
  LENS_SLOT_COUNT,
  lensKey,
} from "../src/lens.ts";

const board = (title: string): CanvasBoardView => ({ view: "board", title, sections: [] });

describe("lens keys + placeholder", () => {
  test("declares LENS_SLOT_COUNT namespaced keys", () => {
    expect(LENS_KEYS).toHaveLength(LENS_SLOT_COUNT);
    expect(LENS_KEYS).toEqual([0, 1, 2].map(lensKey));
    for (const key of LENS_KEYS) expect(key).toMatch(/^rib:chamber:lens:\d+$/);
  });

  test("emptyLensBoard is a renderable board view", () => {
    expect(() => expectView(lensKey(0), "board")(emptyLensBoard())).not.toThrow();
  });
});

describe("slot allocator (LRU)", () => {
  test("fills free slots in order", () => {
    const a = createSlotAllocator(3);
    expect(a.allocate("x")).toBe(0);
    expect(a.allocate("y")).toBe(1);
    expect(a.allocate("z")).toBe(2);
  });

  test("re-allocating a mapped id reuses its slot", () => {
    const a = createSlotAllocator(3);
    a.allocate("x");
    a.allocate("y");
    expect(a.allocate("x")).toBe(0); // reused, not displaced
    expect(a.slotOf("y")).toBe(1);
  });

  test("evicts the least-recently-authored when the pool is full", () => {
    const a = createSlotAllocator(2);
    expect(a.allocate("x")).toBe(0);
    expect(a.allocate("y")).toBe(1);
    expect(a.allocate("z")).toBe(0); // full -> evict x (LRU) -> reuse slot 0
    expect(a.slotOf("x")).toBeUndefined();
    expect(a.slotOf("z")).toBe(0);
    expect(a.slotOf("y")).toBe(1);
  });

  test("re-authoring refreshes recency so the true LRU is evicted", () => {
    const a = createSlotAllocator(2);
    a.allocate("x"); // slot 0
    a.allocate("y"); // slot 1
    a.allocate("x"); // touch x -> y is now least-recent
    expect(a.allocate("z")).toBe(1); // evicts y, not x
    expect(a.slotOf("x")).toBe(0);
    expect(a.slotOf("y")).toBeUndefined();
  });

  test("rejects a zero-slot pool", () => {
    expect(() => createSlotAllocator(0)).toThrow();
  });
});

describe("lens registry", () => {
  // A SnapshotManager double that runs the registered composer and its validator on
  // recompose, capturing the validated frame — so a published board is proven to
  // flow through the same fail-closed gate the real manager applies.
  function fakeSnapshotManager() {
    const composers = new Map<string, () => unknown>();
    const validators = new Map<string, (d: unknown) => unknown>();
    const broadcasts: { key: string; view: unknown }[] = [];
    const sm = {
      register(key: string, compose: () => unknown, opts?: { validate?: (d: unknown) => unknown }) {
        composers.set(key, compose);
        if (opts?.validate) validators.set(key, opts.validate);
        return () => composers.delete(key);
      },
      async recompose(key: string) {
        const composed = await composers.get(key)?.();
        const view = validators.get(key)?.(composed) ?? composed;
        broadcasts.push({ key, view });
        return undefined;
      },
      latest: () => undefined,
      keys: () => [...composers.keys()],
      dispose: async () => {},
    } as unknown as SnapshotManager;
    return { sm, broadcasts, keys: () => [...composers.keys()] };
  }

  test("registers every lens slot key", () => {
    const { sm, keys } = fakeSnapshotManager();
    createLensRegistry(sm);
    for (const key of LENS_KEYS) expect(keys()).toContain(key);
  });

  test("publishes a board to the id's slot and broadcasts it", async () => {
    const { sm, broadcasts } = fakeSnapshotManager();
    const reg = createLensRegistry(sm);
    const { slot } = await reg.publish("findings", board("Findings"));
    expect(slot).toBe(0);
    const last = broadcasts.at(-1);
    expect(last?.key).toBe(lensKey(0));
    expect(last?.view).toEqual(board("Findings"));
  });

  test("re-authoring the same id updates the same slot", async () => {
    const { sm } = fakeSnapshotManager();
    const reg = createLensRegistry(sm);
    expect((await reg.publish("a", board("A1"))).slot).toBe(0);
    expect((await reg.publish("b", board("B"))).slot).toBe(1);
    expect((await reg.publish("a", board("A2"))).slot).toBe(0);
  });

  test("fails closed on a board the publish gate rejects, without consuming a slot", async () => {
    const { sm } = fakeSnapshotManager();
    const reg = createLensRegistry(sm);
    // Duplicate table column keys pass canvasBoardViewSchema (the member schema)
    // but fail canvasViewSchema's uniqueness refine — the board the manager would
    // otherwise silently drop at recompose.
    const dupColumns = {
      view: "board",
      title: "Dup",
      sections: [{ kind: "table", columns: [{ key: "a" }, { key: "a" }], rows: [] }],
    } as unknown as CanvasBoardView;
    await expect(reg.publish("bad", dupColumns)).rejects.toThrow();
    // The rejected board never allocated a slot — a later valid lens still takes 0.
    expect((await reg.publish("good", board("Good"))).slot).toBe(0);
  });

  test("publishing more ids than slots evicts the LRU slot and broadcasts the new board", async () => {
    const { sm, broadcasts } = fakeSnapshotManager();
    const reg = createLensRegistry(sm);
    // Fill every slot, oldest first.
    for (let i = 0; i < LENS_SLOT_COUNT; i++) await reg.publish(`fill-${i}`, board(`F${i}`));
    // One more id evicts the LRU (fill-0, in slot 0) and reuses its slot.
    expect((await reg.publish("overflow", board("Overflow"))).slot).toBe(0);
    const slot0 = broadcasts.filter((b) => b.key === lensKey(0)).at(-1);
    expect(slot0?.view).toEqual(board("Overflow"));
  });

  test("dispose releases the slot keys so a fresh pool can re-register", () => {
    // A strict manager that rejects duplicate keys, like the real SnapshotManager.
    const composers = new Map<string, () => unknown>();
    const sm = {
      register(key: string, compose: () => unknown) {
        if (composers.has(key)) throw new Error(`duplicate key ${key}`);
        composers.set(key, compose);
        return () => composers.delete(key);
      },
      recompose: async () => undefined,
      latest: () => undefined,
      keys: () => [...composers.keys()],
      dispose: async () => {},
    } as unknown as SnapshotManager;
    const first = createLensRegistry(sm);
    // A second pool on the same manager, before releasing the first, hits the
    // duplicate-key guard.
    expect(() => createLensRegistry(sm)).toThrow();
    // After dispose the keys are free and a fresh pool registers cleanly.
    first.dispose();
    expect(() => createLensRegistry(sm)).not.toThrow();
  });
});
