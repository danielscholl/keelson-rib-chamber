import { describe, expect, test } from "bun:test";
import type { CanvasBoardView, SnapshotManager } from "@keelson/shared";
import { createRoomKeyRegistry, roomKey } from "../src/room-key-registry.ts";

const board = (title: string): CanvasBoardView => ({ view: "board", title, sections: [] });

describe("room key registry", () => {
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

  test("registers the per-slug snapshot key on first publish and validates the board", async () => {
    const { sm, broadcasts, keys } = fakeSnapshotManager();
    const reg = createRoomKeyRegistry(sm);

    await reg.publish("room-a", board("Design Review"));

    expect(keys()).toContain(roomKey("room-a"));
    // The published board flowed through the validator to a broadcast — boards publish
    // through expectView, registry included.
    expect(broadcasts.at(-1)).toEqual({ key: roomKey("room-a"), view: board("Design Review") });
  });

  test("registering a key seeds it, so an Open lands on a board rather than a 204", async () => {
    // The GET path does not lazy-compose, so between sm.register and the first board the
    // key would answer nothing. Registration therefore recomposes immediately, publishing
    // the coalescing publisher's placeholder. Asserting the exact SEQUENCE is the point:
    // any "did a broadcast happen" check passes on the real board's own recompose and so
    // would not notice the seed disappearing.
    const { sm, broadcasts } = fakeSnapshotManager();
    const reg = createRoomKeyRegistry(sm);

    await reg.publish("room-a", board("Fresh"));

    const mine = broadcasts.filter((b) => b.key === roomKey("room-a"));
    expect(mine).toHaveLength(2);
    expect(mine[0]?.view).toEqual({ view: "board", title: "Room", sections: [] });
    expect(mine[1]?.view).toEqual(board("Fresh"));
  });

  test("re-publishing the same slug updates in place — no second registration", async () => {
    const { sm, keys } = fakeSnapshotManager();
    const reg = createRoomKeyRegistry(sm);

    await reg.publish("room-a", board("First"));
    await reg.publish("room-a", board("Second")); // would throw on duplicate register

    expect(keys().filter((k) => k === roomKey("room-a"))).toHaveLength(1);
  });

  test("distinct slugs each get their own key", async () => {
    const { sm, keys } = fakeSnapshotManager();
    const reg = createRoomKeyRegistry(sm);

    await reg.publish("room-a", board("A"));
    await reg.publish("room-b", board("B"));

    expect(keys()).toEqual(expect.arrayContaining([roomKey("room-a"), roomKey("room-b")]));
  });

  test("release drops one room's key and reports whether it did", async () => {
    const { sm, keys } = fakeSnapshotManager();
    const reg = createRoomKeyRegistry(sm);

    await reg.publish("room-a", board("A"));
    await reg.publish("room-b", board("B"));

    expect(reg.release("room-a")).toBe(true);
    expect(keys()).toEqual([roomKey("room-b")]);
    // No-op on a slug that never published, and on a second release.
    expect(reg.release("room-a")).toBe(false);
    expect(reg.release("never-published")).toBe(false);
  });

  test("a released slug can register again — a re-publish is not a duplicate", async () => {
    const { sm, keys } = fakeSnapshotManager();
    const reg = createRoomKeyRegistry(sm);

    await reg.publish("room-a", board("A"));
    reg.release("room-a");
    await reg.publish("room-a", board("A again"));

    expect(keys()).toEqual([roomKey("room-a")]);
  });

  test("dispose releases every room's snapshot key", async () => {
    const { sm, keys } = fakeSnapshotManager();
    const reg = createRoomKeyRegistry(sm);

    await reg.publish("room-a", board("A"));
    await reg.publish("room-b", board("B"));
    reg.dispose();

    expect(keys()).toEqual([]);
  });

  test("concurrent first publishes of the same slug don't double-register", async () => {
    const { sm, keys } = fakeSnapshotManager();
    const reg = createRoomKeyRegistry(sm);

    await Promise.all([reg.publish("room-a", board("A1")), reg.publish("room-a", board("A2"))]);

    expect(keys().filter((k) => k === roomKey("room-a"))).toHaveLength(1);
  });
});
