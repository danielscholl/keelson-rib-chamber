import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanvasBoardView, RibSurfaceRegion, SnapshotManager } from "@keelson/shared";
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
  test("an exhibit publish registers a collapsible region on the Exhibits shelf", async () => {
    const f = fakeSeams();
    const registry = createLensRegistry(f.sm, f.registerRegion, f.store);
    await registry.publish("assessment", board("Assessment"), { reason: "gist" }, "exhibit");
    expect(f.regions).toHaveLength(1);
    const region = f.regions[0];
    expect(region?.key).toBe(lensKey("assessment"));
    expect(region?.group).toBe("exhibit");
    expect(region?.groupTitle).toBe("Exhibits");
    expect(region?.glyph).toEqual({ char: "▣", tone: "caution" });
    expect(region?.collapsible).toBe(true);
    // The persisted record carries the kind so a restart reshelves it correctly.
    expect(f.saved).toEqual([{ id: "assessment", kind: "exhibit", sourceRoom: undefined }]);
  });

  test("a lens publish keeps the Lenses shelf and gains the collapse chevron", async () => {
    const f = fakeSeams();
    const registry = createLensRegistry(f.sm, f.registerRegion, f.store);
    await registry.publish("morning-brief", board("Morning Brief"));
    const region = f.regions[0];
    expect(region?.group).toBe("lens");
    expect(region?.groupTitle).toBe("Lenses");
    expect(region?.glyph).toEqual({ char: "✦", tone: "accent" });
    expect(region?.collapsible).toBe(true);
    expect(f.saved).toEqual([{ id: "morning-brief", kind: "lens", sourceRoom: undefined }]);
  });

  test("reregister reshelves by kind without re-saving (boot preserves updatedAt)", async () => {
    const f = fakeSeams();
    const registry = createLensRegistry(f.sm, f.registerRegion, f.store);
    await registry.reregister("assessment", board("Assessment"), "exhibit");
    expect(f.regions[0]?.group).toBe("exhibit");
    expect(f.saved).toEqual([]);
  });
});
