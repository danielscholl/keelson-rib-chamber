import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanvasBoardView, RibSurfaceRegion, SnapshotManager } from "@keelson/shared";
import { hasDigestContent, reduceChamberState } from "../src/chamber-state.ts";
import { createLensRegistry, lensKey } from "../src/lens.ts";
import { createFileLensStore, isExhibit, type LensStore, listLenses } from "../src/lens-store.ts";

const board = (title: string): CanvasBoardView => ({ view: "board", title, sections: [] });

describe("lens store — the exhibit kind", () => {
  test("kind + sourceRoom round-trip; absent kind stays the lens default", async () => {
    const root = await mkdtemp(join(tmpdir(), "chamber-exhibit-store-"));
    try {
      const store = createFileLensStore(root);
      await store.saveLens({ id: "plain", board: board("Plain") });
      await store.saveLens({
        id: "assessment",
        board: board("Assessment"),
        kind: "exhibit",
        sourceRoom: "sample-review",
        reason: "honest promise, empty shelf",
      });
      const plain = await store.loadLens("plain");
      expect(plain?.kind).toBeUndefined();
      expect(isExhibit(plain ?? {})).toBe(false);
      const exhibit = await store.loadLens("assessment");
      expect(exhibit?.kind).toBe("exhibit");
      expect(exhibit?.sourceRoom).toBe("sample-review");
      expect(isExhibit(exhibit ?? {})).toBe(true);
      // listLenses returns BOTH species — the indexes/tools split by kind.
      expect((await listLenses(root)).map((l) => l.id).sort()).toEqual(["assessment", "plain"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an explicit lens kind serializes like the pre-split default (no kind key)", async () => {
    const root = await mkdtemp(join(tmpdir(), "chamber-exhibit-store-"));
    try {
      const store = createFileLensStore(root);
      await store.saveLens({ id: "view", board: board("View"), kind: "lens" });
      const rec = await store.loadLens("view");
      expect(rec).toBeDefined();
      expect("kind" in (rec ?? {})).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a corrupt kind string degrades to the lens default instead of hiding the record", async () => {
    const root = await mkdtemp(join(tmpdir(), "chamber-exhibit-store-"));
    try {
      await mkdir(join(root, "weird"), { recursive: true });
      await writeFile(
        join(root, "weird", "lens.json"),
        JSON.stringify({
          id: "weird",
          board: board("Weird"),
          updatedAt: "2026-01-01T00:00:00.000Z",
          kind: "banana",
        }),
      );
      const [rec] = await listLenses(root);
      expect(rec?.id).toBe("weird");
      expect(rec?.kind).toBeUndefined();
      expect(isExhibit(rec ?? {})).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("lens store — the witness-stamp updatedAt override", () => {
  test("a save carrying updatedAt preserves it (a provenance stamp is not a re-tabling)", async () => {
    const root = await mkdtemp(join(tmpdir(), "chamber-exhibit-store-"));
    try {
      const store = createFileLensStore(root);
      await store.saveLens({ id: "assessment", board: board("A"), kind: "exhibit" });
      const tabled = await store.loadLens("assessment");
      await store.saveLens({
        ...(tabled ?? { id: "assessment", board: board("A") }),
        sourceRoom: "sample-review",
      });
      const stamped = await store.loadLens("assessment");
      expect(stamped?.sourceRoom).toBe("sample-review");
      expect(stamped?.updatedAt).toBe(tabled?.updatedAt ?? "");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("chamber state — exhibits count as digest content", () => {
  test("an exhibits-only chamber is not 'empty' to the digest gate", () => {
    const state = reduceChamberState(
      [],
      [],
      [
        {
          id: "assessment",
          board: board("Assessment"),
          updatedAt: "2026-01-01T00:00:00.000Z",
          kind: "exhibit",
        },
      ],
    );
    expect(state.liveLensCount).toBe(0);
    expect(state.exhibitCount).toBe(1);
    expect(hasDigestContent(state)).toBe(true);
  });
});

// A SnapshotManager double + region recorder mirroring lens.test.ts, so the
// registry's kind-routed region registration is provable without a live surface.
function fakeSeams() {
  const composers = new Map<string, () => unknown>();
  const sm = {
    register(key: string, compose: () => unknown) {
      if (composers.has(key)) throw new Error(`duplicate key ${key}`);
      composers.set(key, compose);
      return () => composers.delete(key);
    },
    async recompose(key: string) {
      await composers.get(key)?.();
      return undefined;
    },
    latest: () => undefined,
    keys: () => [...composers.keys()],
    dispose: async () => {},
  } as unknown as SnapshotManager;
  const regions: RibSurfaceRegion[] = [];
  const registerRegion = (_surfaceId: string, region: RibSurfaceRegion) => {
    regions.push(region);
    return () => {
      const at = regions.indexOf(region);
      if (at >= 0) regions.splice(at, 1);
    };
  };
  const saved: { id: string; kind?: string; sourceRoom?: string }[] = [];
  const store: LensStore = {
    async saveLens(record) {
      saved.push({ id: record.id, kind: record.kind, sourceRoom: record.sourceRoom });
    },
    async loadLens() {
      return undefined;
    },
    async deleteLens() {},
  };
  return { sm, registerRegion, regions, store, saved };
}

describe("lens registry — kind-routed shelves", () => {
  test("an exhibit publish registers its key and NO panel", async () => {
    const f = fakeSeams();
    const registry = createLensRegistry(f.sm, f.registerRegion, f.store);
    await registry.publish("assessment", board("Assessment"), false, { reason: "gist" }, "exhibit");
    // An exhibit is a room's deliverable, reached from the room that tabled it — it earns
    // no standing panel. The KEY still registers: it is what lens-open focuses, so the
    // room board's Tabled cards read it.
    expect(f.regions).toHaveLength(0);
    expect(f.sm.keys()).toContain(lensKey("assessment"));
    // The persisted record carries the kind so a restart reshelves it correctly.
    expect(f.saved).toEqual([{ id: "assessment", kind: "exhibit", sourceRoom: undefined }]);
  });

  test("a pinned lens publish takes the Pinned shelf and arrives collapsed", async () => {
    const f = fakeSeams();
    const registry = createLensRegistry(f.sm, f.registerRegion, f.store);
    await registry.publish("morning-brief", board("Morning Brief"), true);
    const region = f.regions[0];
    expect(region?.group).toBe("lens:morning-brief");
    expect(region?.groupTitle).toBe("Pinned");
    expect(region?.glyph).toEqual({ char: "✦", tone: "accent" });
    expect(region?.collapsible).toBe(true);
    expect(region?.collapsed).toBe(true);
    expect(f.saved).toEqual([{ id: "morning-brief", kind: "lens", sourceRoom: undefined }]);
  });

  test("reregister restores an exhibit's key without re-saving (boot preserves updatedAt)", async () => {
    const f = fakeSeams();
    const registry = createLensRegistry(f.sm, f.registerRegion, f.store);
    await registry.reregister("assessment", board("Assessment"), false, "exhibit");
    // Boot brings the key back so a tabled exhibit is openable across a restart, and
    // still no panel.
    expect(f.sm.keys()).toContain(lensKey("assessment"));
    expect(f.regions).toHaveLength(0);
    expect(f.saved).toEqual([]);
  });

  test("a lens re-published AS an exhibit loses its panel and keeps its key", async () => {
    // The kind crossing: rewireRegion drops the region when a subject becomes an
    // exhibit, rather than leaving a stale Lenses panel behind it.
    const f = fakeSeams();
    const registry = createLensRegistry(f.sm, f.registerRegion, f.store);
    await registry.publish("crosser", board("Crosser"), true);
    expect(f.regions).toHaveLength(1);
    await registry.reregister("crosser", board("Crosser"), false, "exhibit");
    expect(f.regions).toHaveLength(0);
    expect(f.sm.keys()).toContain(lensKey("crosser"));
  });
});
