import { describe, expect, test } from "bun:test";
import type { CanvasView, SnapshotManager } from "@keelson/shared";
import { expectView } from "@keelson/shared";
import {
  createLensRegistry,
  createSlotAllocator,
  emptyLensBoard,
  LENS_KEYS,
  LENS_SLOT_COUNT,
  lensKey,
} from "../src/lens.ts";

const board = (title: string): CanvasView => ({ view: "board", title, sections: [] });

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
    expect(a.allocate("x")).toBe(0);
    expect(a.assignments().size).toBe(2);
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
});
