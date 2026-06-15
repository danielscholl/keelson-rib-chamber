import { describe, expect, test } from "bun:test";
import type { CanvasBoardView, RibSurfaceRegion, SnapshotManager } from "@keelson/shared";
import { expectView } from "@keelson/shared";
import {
  CHAMBER_SURFACE_ID,
  canonicalLensId,
  createLensRegistry,
  emptyLensBoard,
  lensKey,
} from "../src/lens.ts";

const board = (title: string): CanvasBoardView => ({ view: "board", title, sections: [] });

describe("lens keys + placeholder", () => {
  test("keys a lens by its subject id under the chamber namespace", () => {
    expect(lensKey("release-risks")).toBe("rib:chamber:lens:release-risks");
  });

  test("emptyLensBoard is a renderable board view", () => {
    expect(() => expectView(lensKey("x"), "board")(emptyLensBoard())).not.toThrow();
  });
});

describe("canonicalLensId", () => {
  test("lowercases and hyphenates so a subject maps to one id", () => {
    expect(canonicalLensId("Release Risks")).toBe("release-risks");
    expect(canonicalLensId("  release---risks  ")).toBe("release-risks");
  });

  test("does not cap below the 64-char id limit (distinct long subjects stay distinct)", () => {
    const a = `${"x".repeat(50)}-a`;
    const b = `${"x".repeat(50)}-b`;
    expect(canonicalLensId(a)).not.toBe(canonicalLensId(b));
  });

  test("returns empty for an id with no usable characters", () => {
    expect(canonicalLensId("!!!")).toBe("");
  });
});

describe("lens registry", () => {
  // A SnapshotManager double that runs the registered composer and its validator on
  // recompose, capturing the validated frame — so a published board is proven to
  // flow through the same fail-closed gate the real manager applies. register throws
  // on a duplicate key like the real one, so a leaked registration surfaces loudly.
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

  // A registerRegion double recording each call and its unregister invocations.
  function fakeRegisterRegion() {
    const calls: { surfaceId: string; region: RibSurfaceRegion }[] = [];
    let unregisters = 0;
    return {
      register: (surfaceId: string, region: RibSurfaceRegion) => {
        calls.push({ surfaceId, region });
        return () => {
          unregisters += 1;
        };
      },
      calls,
      unregisters: () => unregisters,
    };
  }

  test("registers the snapshot key and a grouped surface region on first publish", async () => {
    const { sm, broadcasts, keys } = fakeSnapshotManager();
    const region = fakeRegisterRegion();
    const reg = createLensRegistry(sm, region.register);
    const { key } = await reg.publish("findings", board("Findings"));
    expect(key).toBe(lensKey("findings"));
    expect(keys()).toContain(lensKey("findings"));
    expect(region.calls).toHaveLength(1);
    expect(region.calls[0]?.surfaceId).toBe(CHAMBER_SURFACE_ID);
    expect(region.calls[0]?.region.key).toBe(lensKey("findings"));
    expect(region.calls[0]?.region.group).toBe("lens");
    expect(broadcasts.at(-1)).toEqual({ key: lensKey("findings"), view: board("Findings") });
  });

  test("re-authoring the same id updates the panel without re-registering", async () => {
    const { sm, broadcasts } = fakeSnapshotManager();
    const region = fakeRegisterRegion();
    const reg = createLensRegistry(sm, region.register);
    await reg.publish("a", board("A1"));
    await reg.publish("a", board("A2"));
    expect(region.calls).toHaveLength(1); // region added once, not per publish
    expect(broadcasts.at(-1)).toEqual({ key: lensKey("a"), view: board("A2") });
  });

  test("authors distinct subjects as distinct panels with no eviction", async () => {
    const { sm, keys } = fakeSnapshotManager();
    const region = fakeRegisterRegion();
    const reg = createLensRegistry(sm, region.register);
    for (const id of ["a", "b", "c", "d"]) await reg.publish(id, board(id));
    expect(keys()).toEqual(["a", "b", "c", "d"].map(lensKey));
    expect(region.calls.map((c) => c.region.key)).toEqual(["a", "b", "c", "d"].map(lensKey));
  });

  test("fails closed on a board the publish gate rejects, registering nothing", async () => {
    const { sm, keys } = fakeSnapshotManager();
    const region = fakeRegisterRegion();
    const reg = createLensRegistry(sm, region.register);
    // Duplicate table column keys pass canvasBoardViewSchema (the member schema) but
    // fail canvasViewSchema's uniqueness refine — the board the manager would
    // otherwise silently drop at recompose.
    const dupColumns = {
      view: "board",
      title: "Dup",
      sections: [{ kind: "table", columns: [{ key: "a" }, { key: "a" }], rows: [] }],
    } as unknown as CanvasBoardView;
    await expect(reg.publish("bad", dupColumns)).rejects.toThrow();
    expect(keys()).toEqual([]);
    expect(region.calls).toHaveLength(0);
    // A later valid lens still registers cleanly at its own key.
    await reg.publish("good", board("Good"));
    expect(keys()).toEqual([lensKey("good")]);
  });

  test("dispose releases both the snapshot keys and the surface regions", async () => {
    const { sm, keys } = fakeSnapshotManager();
    const region = fakeRegisterRegion();
    const reg = createLensRegistry(sm, region.register);
    await reg.publish("a", board("A"));
    await reg.publish("b", board("B"));
    reg.dispose();
    expect(keys()).toEqual([]);
    expect(region.unregisters()).toBe(2);
    // The keys are free, so a fresh registry on the same manager re-registers cleanly.
    const reg2 = createLensRegistry(sm, region.register);
    await expect(reg2.publish("a", board("A"))).resolves.toEqual({ key: lensKey("a") });
  });

  test("concurrent publishes of the same new id register the key once, both resolving", async () => {
    const { sm, keys } = fakeSnapshotManager();
    const region = fakeRegisterRegion();
    const reg = createLensRegistry(sm, region.register);
    // Two racing authors of the same not-yet-registered subject (the tool is both a
    // workflow seam and a room turn-tool) must not both reach sm.register and trip its
    // duplicate-key guard — the second finds the entry and just republishes.
    const [a, b] = await Promise.all([
      reg.publish("dup", board("A")),
      reg.publish("dup", board("B")),
    ]);
    expect(a.key).toBe(lensKey("dup"));
    expect(b.key).toBe(lensKey("dup"));
    expect(keys()).toEqual([lensKey("dup")]); // registered exactly once
    expect(region.calls).toHaveLength(1);
  });

  test("releases the snapshot registration if registerRegion throws", async () => {
    const { sm, keys } = fakeSnapshotManager();
    const reg = createLensRegistry(sm, () => {
      throw new Error("region limit reached");
    });
    await expect(reg.publish("x", board("X"))).rejects.toThrow(/region limit/);
    expect(keys()).toEqual([]); // no leaked snapshot key
  });
});
