import { describe, expect, test } from "bun:test";
import type { CanvasBoardView, RibSurfaceRegion, SnapshotManager } from "@keelson/shared";
import { createRoomRegionRegistry, roomKey } from "../src/room-region-registry.ts";

const board = (title: string): CanvasBoardView => ({ view: "board", title, sections: [] });

describe("room region registry", () => {
  test("keys a room by its slug under the chamber namespace", () => {
    expect(roomKey("room-abc")).toBe("rib:chamber:room:room-abc");
  });

  // A SnapshotManager double that runs the registered composer + validator on
  // recompose and records broadcasts; register throws on a duplicate key and the
  // returned handle removes it, so a leaked or double registration surfaces loudly.
  function fakeSnapshotManager() {
    const composers = new Map<string, () => unknown>();
    const validators = new Map<string, (d: unknown) => unknown>();
    const broadcasts: { key: string; view: unknown }[] = [];
    const sm = {
      register(key: string, compose: () => unknown, opts?: { validate?: (d: unknown) => unknown }) {
        if (composers.has(key)) throw new Error(`duplicate key ${key}`);
        composers.set(key, compose);
        if (opts?.validate) validators.set(key, opts.validate);
        return () => {
          composers.delete(key);
          validators.delete(key);
        };
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

  // A registerRegion double recording each call and tracking which region keys are
  // currently registered (so release/dispose are observable).
  function fakeRegisterRegion(opts: { throwOnKey?: string } = {}) {
    const calls: { surfaceId: string; region: RibSurfaceRegion }[] = [];
    const active = new Set<string>();
    return {
      register: (surfaceId: string, region: RibSurfaceRegion) => {
        if (opts.throwOnKey === region.key) throw new Error("region limit reached");
        calls.push({ surfaceId, region });
        active.add(region.key);
        return () => {
          active.delete(region.key);
        };
      },
      calls,
      active,
    };
  }

  test("registers the per-slug snapshot key and a grouped surface region on first publish", async () => {
    const { sm, broadcasts, keys } = fakeSnapshotManager();
    const region = fakeRegisterRegion();
    const reg = createRoomRegionRegistry(sm, region.register);

    await reg.publish("room-a", board("Design Review"));

    expect(keys()).toContain(roomKey("room-a"));
    expect(region.active.has(roomKey("room-a"))).toBe(true);
    const call = region.calls.find((c) => c.region.key === roomKey("room-a"));
    expect(call?.surfaceId).toBe("chamber");
    expect(call?.region.group).toBe("rooms");
    // The region carries the zone title so the merge labels the "Rooms" lane.
    expect(call?.region.groupTitle).toBe("Rooms");
    // Region title comes from the board (buildRoomBoard sets it to the room name).
    expect(call?.region.title).toBe("Design Review");
    // The published board flowed through the validator to a broadcast.
    expect(broadcasts.at(-1)).toEqual({ key: roomKey("room-a"), view: board("Design Review") });
  });

  test("re-publishing the same slug updates in place — no second registration", async () => {
    const { sm, keys } = fakeSnapshotManager();
    const region = fakeRegisterRegion();
    const reg = createRoomRegionRegistry(sm, region.register);

    await reg.publish("room-a", board("First"));
    await reg.publish("room-a", board("Second")); // would throw on duplicate register

    expect(keys().filter((k) => k === roomKey("room-a"))).toHaveLength(1);
    expect(region.calls.filter((c) => c.region.key === roomKey("room-a"))).toHaveLength(1);
  });

  test("distinct slugs each get their own key and region", async () => {
    const { sm, keys } = fakeSnapshotManager();
    const region = fakeRegisterRegion();
    const reg = createRoomRegionRegistry(sm, region.register);

    await reg.publish("room-a", board("A"));
    await reg.publish("room-b", board("B"));

    expect(keys()).toEqual(expect.arrayContaining([roomKey("room-a"), roomKey("room-b")]));
    expect(region.active.has(roomKey("room-a"))).toBe(true);
    expect(region.active.has(roomKey("room-b"))).toBe(true);
  });

  test("retainOnly keeps the named slugs and unregisters the rest", async () => {
    const { sm, keys } = fakeSnapshotManager();
    const region = fakeRegisterRegion();
    const reg = createRoomRegionRegistry(sm, region.register);

    await reg.publish("room-a", board("A"));
    await reg.publish("room-b", board("B"));
    await reg.publish("room-c", board("C"));
    reg.retainOnly(["room-b", "room-c"]);

    expect(keys()).toEqual(expect.arrayContaining([roomKey("room-b"), roomKey("room-c")]));
    expect(keys()).not.toContain(roomKey("room-a"));
    expect(region.active.has(roomKey("room-a"))).toBe(false);
    expect(region.active.has(roomKey("room-b"))).toBe(true);
    expect(region.active.has(roomKey("room-c"))).toBe(true);
  });

  test("retainOnly([]) releases every room panel", async () => {
    const { sm, keys } = fakeSnapshotManager();
    const region = fakeRegisterRegion();
    const reg = createRoomRegionRegistry(sm, region.register);

    await reg.publish("room-a", board("A"));
    reg.retainOnly([]);

    expect(keys()).toEqual([]);
    expect(region.active.size).toBe(0);
  });

  test("dispose releases every room's snapshot key and region", async () => {
    const { sm, keys } = fakeSnapshotManager();
    const region = fakeRegisterRegion();
    const reg = createRoomRegionRegistry(sm, region.register);

    await reg.publish("room-a", board("A"));
    await reg.publish("room-b", board("B"));
    reg.dispose();

    expect(keys()).toEqual([]);
    expect(region.active.size).toBe(0);
  });

  test("a failed region add rolls back the snapshot registration (no dangling key)", async () => {
    const { sm, keys } = fakeSnapshotManager();
    const region = fakeRegisterRegion({ throwOnKey: roomKey("room-x") });
    const reg = createRoomRegionRegistry(sm, region.register);

    await expect(reg.publish("room-x", board("X"))).rejects.toThrow(/region limit/);
    expect(keys()).not.toContain(roomKey("room-x"));
  });

  test("concurrent first publishes of the same slug don't double-register", async () => {
    const { sm, keys } = fakeSnapshotManager();
    const region = fakeRegisterRegion();
    const reg = createRoomRegionRegistry(sm, region.register);

    await Promise.all([reg.publish("room-a", board("A1")), reg.publish("room-a", board("A2"))]);

    expect(keys().filter((k) => k === roomKey("room-a"))).toHaveLength(1);
    expect(region.calls.filter((c) => c.region.key === roomKey("room-a"))).toHaveLength(1);
  });
});
