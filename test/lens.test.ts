import { describe, expect, test } from "bun:test";
import type { CanvasBoardView, RibSurfaceRegion, SnapshotManager } from "@keelson/shared";
import { expectView } from "@keelson/shared";
import {
  boardsEqual,
  CHAMBER_SURFACE_ID,
  canonicalLensId,
  createLensRegistry,
  emptyLensBoard,
  lensKey,
  lensRefreshInputs,
} from "../src/lens.ts";
import type { LensStore } from "../src/lens-store.ts";

const board = (title: string): CanvasBoardView => ({ view: "board", title, sections: [] });

// An in-memory LensStore double recording every save/delete, so a test can assert
// publish persists and deleteLens is the caller's (the registry stays in-memory).
function fakeLensStore() {
  const saved = new Map<string, CanvasBoardView>();
  const deleted: string[] = [];
  const store: LensStore = {
    async saveLens(record) {
      saved.set(record.id, record.board);
    },
    async loadLens(id) {
      const board = saved.get(id);
      return board ? { id, board, updatedAt: "1970-01-01T00:00:00.000Z" } : undefined;
    },
    async deleteLens(id) {
      deleted.push(id);
      saved.delete(id);
    },
  };
  return { store, saved, deleted };
}

describe("lens keys + placeholder", () => {
  test("keys a lens by its subject id under the chamber namespace", () => {
    expect(lensKey("release-risks")).toBe("rib:chamber:lens:release-risks");
  });

  test("emptyLensBoard is a renderable board view", () => {
    expect(() => expectView(lensKey("x"), "board")(emptyLensBoard())).not.toThrow();
  });
});

describe("lensRefreshInputs", () => {
  test("passes the lens id alone when the backing carries no inputs", () => {
    expect(lensRefreshInputs("release-risks")).toEqual({ lens: "release-risks" });
  });

  test("merges the backing's own inputs alongside the id", () => {
    expect(lensRefreshInputs("metrics", { repo: "acme/widget" })).toEqual({
      repo: "acme/widget",
      lens: "metrics",
    });
  });

  // `lens` is the one input the refresh contract guarantees its producer, and the
  // inputs beside it come from agent-authored lens data.
  test("a stored input cannot shadow the lens id", () => {
    expect(lensRefreshInputs("metrics", { lens: "somewhere-else" })).toEqual({ lens: "metrics" });
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

// boardsEqual decides whether a re-author is a change at all, so it gates both the
// panel's freshness and the paid brief/digest turns behind it. A false "changed"
// restores the bug; a false "unchanged" strands a real edit.
describe("boardsEqual", () => {
  const nested = (label: string): CanvasBoardView => ({
    view: "board",
    title: "Findings",
    sections: [
      { kind: "stats", items: [{ label, value: "3" }] },
      { kind: "rows", title: "Notes", items: [{ text: "a", glyph: "ok" }, { text: "b" }] },
    ],
  });

  test("compares nested sections and items, not just the top level", () => {
    expect(boardsEqual(nested("Met"), nested("Met"))).toBe(true);
    // The only difference is three levels down, inside a section's item.
    expect(boardsEqual(nested("Met"), nested("Unmet"))).toBe(false);
  });

  test("ignores object key order — a board off disk need not match the emit's order", () => {
    const a = { view: "board", title: "T", sections: [] } as CanvasBoardView;
    const b = { sections: [], title: "T", view: "board" } as unknown as CanvasBoardView;
    expect(boardsEqual(a, b)).toBe(true);
  });

  test("reads an explicit undefined as absent — JSON drops the key, the emit may not", () => {
    const withKey = { view: "board", title: "T", sections: [], header: undefined };
    const without = { view: "board", title: "T", sections: [] };
    expect(boardsEqual(withKey as CanvasBoardView, without as CanvasBoardView)).toBe(true);
  });

  test("a missing item is a change, not a match on the shared prefix", () => {
    const two = nested("Met");
    const one = { ...two, sections: [two.sections[0]] } as CanvasBoardView;
    expect(boardsEqual(two, one)).toBe(false);
  });

  test("distinguishes a value from its string form, so 3 never equals '3'", () => {
    const num = { view: "board", title: "T", sections: [], header: { count: 3 } };
    const str = { view: "board", title: "T", sections: [], header: { count: "3" } };
    expect(boardsEqual(num as unknown as CanvasBoardView, str as unknown as CanvasBoardView)).toBe(
      false,
    );
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
    // Arms a one-shot recompose failure, so a test can leave the live key behind the
    // board its publish requested (the publisher assigns `latest` before composing).
    let failOnce = false;
    // Holds the next recompose open, so a test can land a second publish inside the
    // pump's await and drive the coalescing path deterministically.
    let gate: Promise<void> | undefined;
    let openGate: (() => void) | undefined;
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
        if (failOnce) {
          failOnce = false;
          throw new Error("broadcast down");
        }
        if (gate) {
          const held = gate;
          gate = undefined;
          await held;
        }
        const composed = await composers.get(key)?.();
        const view = validators.get(key)?.(composed) ?? composed;
        broadcasts.push({ key, view });
        return undefined;
      },
      latest: () => undefined,
      keys: () => [...composers.keys()],
      dispose: async () => {},
    } as unknown as SnapshotManager;
    return {
      sm,
      broadcasts,
      keys: () => [...composers.keys()],
      failNextRecompose: () => {
        failOnce = true;
      },
      holdNextRecompose: () => {
        gate = new Promise<void>((r) => {
          openGate = r;
        });
        return () => openGate?.();
      },
    };
  }

  // A registerRegion double recording each call, its unregister invocations, and
  // the set of currently-registered region keys — so a single remove() releasing
  // exactly one region (not the survivors) is observable.
  function fakeRegisterRegion() {
    const calls: { surfaceId: string; region: RibSurfaceRegion }[] = [];
    const active = new Set<string>();
    let unregisters = 0;
    return {
      register: (surfaceId: string, region: RibSurfaceRegion) => {
        calls.push({ surfaceId, region });
        active.add(region.key);
        return () => {
          unregisters += 1;
          active.delete(region.key);
        };
      },
      calls,
      active,
      unregisters: () => unregisters,
    };
  }

  test("registers the snapshot key and a grouped surface region on first publish", async () => {
    const { sm, broadcasts, keys } = fakeSnapshotManager();
    const region = fakeRegisterRegion();
    const reg = createLensRegistry(sm, region.register, fakeLensStore().store);
    const { key } = await reg.publish("findings", board("Findings"));
    expect(key).toBe(lensKey("findings"));
    expect(keys()).toContain(lensKey("findings"));
    expect(region.calls).toHaveLength(1);
    expect(region.calls[0]?.surfaceId).toBe(CHAMBER_SURFACE_ID);
    expect(region.calls[0]?.region.key).toBe(lensKey("findings"));
    expect(region.calls[0]?.region.group).toBe("lens");
    // The region carries the zone title so the merge labels the "Lenses" lane.
    expect(region.calls[0]?.region.groupTitle).toBe("Lenses");
    expect(broadcasts.at(-1)).toEqual({ key: lensKey("findings"), view: board("Findings") });
  });

  test("re-authoring the same id updates the panel without re-registering", async () => {
    const { sm, broadcasts } = fakeSnapshotManager();
    const region = fakeRegisterRegion();
    const reg = createLensRegistry(sm, region.register, fakeLensStore().store);
    await reg.publish("a", board("A1"));
    await reg.publish("a", board("A2"));
    expect(region.calls).toHaveLength(1); // region added once, not per publish
    expect(broadcasts.at(-1)).toEqual({ key: lensKey("a"), view: board("A2") });
  });

  test("an identical re-author does not re-broadcast — the panel's freshness is the board's", async () => {
    const { sm, broadcasts } = fakeSnapshotManager();
    const region = fakeRegisterRegion();
    const reg = createLensRegistry(sm, region.register, fakeLensStore().store);
    await reg.publish("a", board("A"));
    // The seed compose on register, then the authored board.
    expect(broadcasts).toHaveLength(2);
    // A cadence refresh that found nothing to change: re-composing would restamp the
    // frame and read as "updated just now" over numbers nothing re-measured.
    await reg.publish("a", board("A"));
    expect(broadcasts).toHaveLength(2);
    expect(broadcasts.at(-1)).toEqual({ key: lensKey("a"), view: board("A") });
  });

  test("broadcasts every real change, including a revert to a board published before", async () => {
    const { sm, broadcasts } = fakeSnapshotManager();
    const region = fakeRegisterRegion();
    const reg = createLensRegistry(sm, region.register, fakeLensStore().store);
    await reg.publish("a", board("A"));
    await reg.publish("a", board("A2"));
    // A revert differs from the LIVE board, so it is a change like any other.
    await reg.publish("a", board("A"));
    expect(broadcasts).toHaveLength(4);
    expect(broadcasts.at(-1)).toEqual({ key: lensKey("a"), view: board("A") });
  });

  test("a re-author of the stored board still converges a panel a failed save left ahead", async () => {
    const { sm, broadcasts } = fakeSnapshotManager();
    const region = fakeRegisterRegion();
    const { store } = fakeLensStore();
    const reg = createLensRegistry(sm, region.register, store);
    await reg.publish("a", board("A"));
    // publish() persists only after the live publish succeeds, so a store that throws
    // leaves the panel on "B" while disk still says "A".
    const saveLens = store.saveLens;
    store.saveLens = () => Promise.reject(new Error("disk full"));
    await expect(reg.publish("a", board("B"))).rejects.toThrow("disk full");
    store.saveLens = saveLens;
    // The refresh workflow re-emits the STORED board. It must reach the surface:
    // skipping on the stored board would call this unchanged and strand "B" on the
    // panel with no later refresh able to converge it.
    await reg.publish("a", board("A"));
    expect(broadcasts.at(-1)).toEqual({ key: lensKey("a"), view: board("A") });
  });

  test("a retry after a failed broadcast republishes — the skip tracks what actually reached the surface", async () => {
    const { sm, broadcasts, failNextRecompose } = fakeSnapshotManager();
    const region = fakeRegisterRegion();
    const reg = createLensRegistry(sm, region.register, fakeLensStore().store);
    await reg.publish("a", board("A"));
    // The broadcast of B fails, so the panel is still showing A.
    failNextRecompose();
    await expect(reg.publish("a", board("B"))).rejects.toThrow("broadcast down");
    // The refresh turn retries the same board. Skipping here would persist B while
    // the panel stayed on A, with no later refresh able to converge them.
    await reg.publish("a", board("B"));
    expect(broadcasts.at(-1)).toEqual({ key: lensKey("a"), view: board("B") });
  });

  test("a publish coalesced into another's compose leaves the tracker on what the key really shows", async () => {
    const { sm, broadcasts, holdNextRecompose } = fakeSnapshotManager();
    const region = fakeRegisterRegion();
    const reg = createLensRegistry(sm, region.register, fakeLensStore().store);
    await reg.publish("a", board("A"));

    // B enters the pump and stalls inside its compose; C then lands, coalesces onto
    // that in-flight compose (publish returns without composing), and the pump's
    // dirty loop is what actually puts C on the key. So B resolves LAST while C is
    // what the panel shows.
    const open = holdNextRecompose();
    const bPublish = reg.publish("a", board("B"));
    await new Promise((r) => setTimeout(r, 0));
    await reg.publish("a", board("C"));
    open();
    await bPublish;
    expect(broadcasts.at(-1)).toEqual({ key: lensKey("a"), view: board("C") });

    // A refresh re-emits B, the board the store still holds. It must reach the key:
    // a tracker that recorded B (the last publish to resolve) would skip here and
    // leave C on the panel with nothing able to converge it.
    await reg.publish("a", board("B"));
    expect(broadcasts.at(-1)).toEqual({ key: lensKey("a"), view: board("B") });
  });

  test("authors distinct subjects as distinct panels with no eviction", async () => {
    const { sm, keys } = fakeSnapshotManager();
    const region = fakeRegisterRegion();
    const reg = createLensRegistry(sm, region.register, fakeLensStore().store);
    for (const id of ["a", "b", "c", "d"]) await reg.publish(id, board(id));
    expect(keys()).toEqual(["a", "b", "c", "d"].map(lensKey));
    expect(region.calls.map((c) => c.region.key)).toEqual(["a", "b", "c", "d"].map(lensKey));
  });

  test("fails closed on a board the publish gate rejects, registering nothing", async () => {
    const { sm, keys } = fakeSnapshotManager();
    const region = fakeRegisterRegion();
    const reg = createLensRegistry(sm, region.register, fakeLensStore().store);
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
    const reg = createLensRegistry(sm, region.register, fakeLensStore().store);
    await reg.publish("a", board("A"));
    await reg.publish("b", board("B"));
    reg.dispose();
    expect(keys()).toEqual([]);
    expect(region.unregisters()).toBe(2);
    // The keys are free, so a fresh registry on the same manager re-registers cleanly.
    const reg2 = createLensRegistry(sm, region.register, fakeLensStore().store);
    await expect(reg2.publish("a", board("A"))).resolves.toEqual({ key: lensKey("a") });
  });

  test("concurrent publishes of the same new id register the key once, both resolving", async () => {
    const { sm, keys } = fakeSnapshotManager();
    const region = fakeRegisterRegion();
    const reg = createLensRegistry(sm, region.register, fakeLensStore().store);
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
    const reg = createLensRegistry(
      sm,
      () => {
        throw new Error("region limit reached");
      },
      fakeLensStore().store,
    );
    await expect(reg.publish("x", board("X"))).rejects.toThrow(/region limit/);
    expect(keys()).toEqual([]); // no leaked snapshot key
  });

  test("remove releases one lens's snapshot key AND surface region, leaving siblings", async () => {
    const { sm, keys } = fakeSnapshotManager();
    const region = fakeRegisterRegion();
    const reg = createLensRegistry(sm, region.register, fakeLensStore().store);
    await reg.publish("a", board("A"));
    await reg.publish("b", board("B"));
    reg.remove("a");
    expect(keys()).toEqual([lensKey("b")]); // a's snapshot key dropped, b's kept
    expect([...region.active]).toEqual([lensKey("b")]); // a's region dropped, b's kept
    expect(region.unregisters()).toBe(1); // exactly one release
  });

  test("remove of an unknown/never-published id is a no-op", async () => {
    const { sm, keys } = fakeSnapshotManager();
    const region = fakeRegisterRegion();
    const reg = createLensRegistry(sm, region.register, fakeLensStore().store);
    await reg.publish("a", board("A"));
    expect(() => reg.remove("never")).not.toThrow();
    expect(keys()).toEqual([lensKey("a")]); // the existing lens is untouched
    expect(region.unregisters()).toBe(0);
  });

  test("after remove, re-publishing the same id re-registers cleanly (both handles fired)", async () => {
    const { sm, keys } = fakeSnapshotManager();
    const region = fakeRegisterRegion();
    const reg = createLensRegistry(sm, region.register, fakeLensStore().store);
    await reg.publish("a", board("A1"));
    reg.remove("a");
    // A leaked snapshot key would trip the manager's duplicate-key guard; a leaked
    // region would double-count — re-publishing cleanly proves both handles fired.
    await expect(reg.publish("a", board("A2"))).resolves.toEqual({ key: lensKey("a") });
    expect(keys()).toEqual([lensKey("a")]);
    expect([...region.active]).toEqual([lensKey("a")]);
  });

  test("dispose still releases all after a prior single remove (no double-release)", async () => {
    const { sm, keys } = fakeSnapshotManager();
    const region = fakeRegisterRegion();
    const reg = createLensRegistry(sm, region.register, fakeLensStore().store);
    await reg.publish("a", board("A"));
    await reg.publish("b", board("B"));
    reg.remove("a");
    reg.dispose();
    expect(keys()).toEqual([]);
    // a released once (by remove) + b released once (by dispose) = 2, not 3.
    expect(region.unregisters()).toBe(2);
  });

  test("publish persists the board to the store after the validate gate passes", async () => {
    const { sm } = fakeSnapshotManager();
    const region = fakeRegisterRegion();
    const { store, saved } = fakeLensStore();
    const reg = createLensRegistry(sm, region.register, store);
    await reg.publish("x", board("X"));
    expect(saved.get("x")).toEqual(board("X"));
  });

  test("a publish that fails the validate gate does NOT persist (fail-closed)", async () => {
    const { sm } = fakeSnapshotManager();
    const region = fakeRegisterRegion();
    const { store, saved } = fakeLensStore();
    const reg = createLensRegistry(sm, region.register, store);
    const dupColumns = {
      view: "board",
      title: "Dup",
      sections: [{ kind: "table", columns: [{ key: "a" }, { key: "a" }], rows: [] }],
    } as unknown as CanvasBoardView;
    await expect(reg.publish("bad", dupColumns)).rejects.toThrow();
    expect(saved.size).toBe(0); // an unrenderable board never reaches disk
  });
});
