import { describe, expect, test } from "bun:test";
import type {
  CanvasBoardView,
  RibContext,
  RibSurfaceRegion,
  SnapshotManager,
} from "@keelson/shared";
import rib from "../src/index.ts";
import { CHAMBER_SURFACE_ID, createLensRegistry, lensKey } from "../src/lens.ts";
import {
  createHtmlLensRegistry,
  emptyHtmlLens,
  HTML_LENS_KEY,
  htmlStringValidator,
} from "../src/lens-html.ts";
import type { LensStore } from "../src/lens-store.ts";

const board = (title: string): CanvasBoardView => ({ view: "board", title, sections: [] });

function fakeLensStore() {
  const saved = new Map<string, CanvasBoardView>();
  const store: LensStore = {
    async saveLens(record) {
      saved.set(record.id, record.board);
    },
    async loadLens(id) {
      const board = saved.get(id);
      return board ? { id, board, updatedAt: "1970-01-01T00:00:00.000Z" } : undefined;
    },
    async deleteLens(id) {
      saved.delete(id);
    },
  };
  return { store, saved };
}

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

function fakeRegisterRegion() {
  const calls: { surfaceId: string; region: RibSurfaceRegion }[] = [];
  return {
    register: (surfaceId: string, region: RibSurfaceRegion) => {
      calls.push({ surfaceId, region });
      return () => undefined;
    },
    calls,
  };
}

const actionCtx = {
  getExec: () => ({
    runJSON: async () => ({ ok: true as const, data: undefined }),
    runText: async () => ({ ok: true as const, data: "" }),
  }),
} as RibContext;

describe("HTML lens registry", () => {
  test("publishes an HTML string to the static html snapshot key", async () => {
    const { sm, broadcasts, keys } = fakeSnapshotManager();
    const region = fakeRegisterRegion();
    const reg = createHtmlLensRegistry(sm, region.register);
    const html = "<h1>Hello</h1>";

    const { key } = await reg.publish(html);

    expect(key).toBe(HTML_LENS_KEY);
    expect(keys()).toEqual([HTML_LENS_KEY]);
    expect(region.calls).toHaveLength(1);
    expect(region.calls[0]?.surfaceId).toBe(CHAMBER_SURFACE_ID);
    expect(region.calls[0]?.region.key).toBe(HTML_LENS_KEY);
    expect(region.calls[0]?.region.group).toBe("lens");
    expect(broadcasts[0]).toEqual({ key: HTML_LENS_KEY, view: emptyHtmlLens() });
    expect(broadcasts.at(-1)).toEqual({ key: HTML_LENS_KEY, view: html });
  });

  test("fails closed on non-string or empty HTML", () => {
    const validate = htmlStringValidator(HTML_LENS_KEY);
    expect(() => validate({})).toThrow(/expected an HTML string/);
    expect(() => validate("")).toThrow(/must not be empty/);
  });
});

describe("HTML lens rib wiring", () => {
  test("declares the html canvas key in rib.views", () => {
    expect(rib.views).toContainEqual({
      key: HTML_LENS_KEY,
      canvasKind: "html",
      title: "HTML Lens",
    });
  });

  test("routes the iframe back-channel verb through onAction", async () => {
    const res = await rib.onAction!({ type: "lens-html", payload: {} }, actionCtx);

    expect(res).toEqual({ ok: true, data: { key: HTML_LENS_KEY } });
  });

  test("fails closed on a malformed iframe payload", async () => {
    const res = await rib.onAction!({ type: "lens-html", payload: "oops" }, actionCtx);

    expect(res).toEqual({ ok: false, error: "lens-html requires an object payload" });
  });

  test("gates a destructive verb relayed from the iframe (origin canvas-html)", async () => {
    const res = await rib.onAction!(
      { type: "retire", payload: { slug: "alice" }, origin: "canvas-html" },
      actionCtx,
    );
    expect(res).toEqual({ ok: false, error: "'retire' is not permitted from an HTML lens" });
  });

  test("allows the safe lens verbs from the iframe (origin canvas-html)", async () => {
    const ack = await rib.onAction!(
      { type: "lens-html", payload: {}, origin: "canvas-html" },
      actionCtx,
    );
    expect(ack).toEqual({ ok: true, data: { key: HTML_LENS_KEY } });

    const open = await rib.onAction!(
      { type: "lens-open", payload: { id: "release-risks" }, origin: "canvas-html" },
      actionCtx,
    );
    expect(open).toEqual({
      ok: true,
      data: {
        effect: "open-canvas",
        key: "rib:chamber:lens:release-risks",
        title: "release-risks",
      },
    });
  });

  test("does NOT gate the same destructive verb from a trusted board action (origin absent)", async () => {
    // No origin = trusted host UI: the gate must not intercept, so this reaches
    // retireAction's own payload validation rather than the frame-gate refusal.
    const res = await rib.onAction!({ type: "retire", payload: {} }, actionCtx);
    expect(res).toEqual({ ok: false, error: "retire requires payload { slug }" });
  });
});

describe("board lens regression", () => {
  test("keeps chamber_emit_lens publishing to rib:chamber:lens:<id>", async () => {
    const { sm } = fakeSnapshotManager();
    const region = fakeRegisterRegion();
    const reg = createLensRegistry(sm, region.register, fakeLensStore().store);

    const { key } = await reg.publish("release-risks", board("Release Risks"));

    expect(key).toBe(lensKey("release-risks"));
    expect(key).toBe("rib:chamber:lens:release-risks");
  });
});
