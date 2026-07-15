import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CanvasBoardView,
  MessageChunk,
  RibContext,
  RibSurfaceRegion,
  SnapshotManager,
  ToolContext,
  ToolDefinition,
} from "@keelson/shared";
import { DESIGN_TOKENS } from "@keelson/shared";
import rib from "../src/index.ts";
import { CHAMBER_SURFACE_ID, createLensRegistry, lensKey } from "../src/lens.ts";
import {
  createHtmlLensRegistry,
  declaredHtmlPalettes,
  emptyHtmlLens,
  HTML_LENS_KEY,
  htmlLensKey,
  htmlLensStructuralError,
  htmlStringValidator,
} from "../src/lens-html.ts";
import {
  createFileHtmlLensStore,
  type HtmlLensStore,
  listHtmlLenses,
} from "../src/lens-html-store.ts";
import type { LensStore } from "../src/lens-store.ts";
import { htmlLensesDir, setChamberDataHome } from "../src/paths.ts";

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

function fakeHtmlLensStore() {
  const saved = new Map<string, { html: string; title?: string }>();
  const store: HtmlLensStore = {
    async save(record) {
      saved.set(record.id, {
        html: record.html,
        ...(record.title ? { title: record.title } : {}),
      });
    },
    async load(id) {
      const rec = saved.get(id);
      return rec
        ? {
            id,
            html: rec.html,
            updatedAt: "1970-01-01T00:00:00.000Z",
            ...(rec.title ? { title: rec.title } : {}),
          }
        : undefined;
    },
    async delete(id) {
      if (!saved.delete(id)) throw new Error(`lens '${id}' not found`);
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

function fakeDeclareView() {
  const declared: { id: string; title?: string }[] = [];
  return {
    declare: (id: string, title?: string) => {
      const entry = { id, ...(title ? { title } : {}) };
      declared.push(entry);
      return () => {
        const at = declared.indexOf(entry);
        if (at >= 0) declared.splice(at, 1);
      };
    },
    declared,
  };
}

const actionCtx = {
  getExec: () => ({
    runJSON: async () => ({ ok: true as const, data: undefined }),
    runText: async () => ({ ok: true as const, data: "" }),
  }),
} as RibContext;

describe("HTML lens registry", () => {
  test("publishes an id-less emit to the legacy fixed key, in-memory only", async () => {
    const { sm, broadcasts, keys } = fakeSnapshotManager();
    const region = fakeRegisterRegion();
    const store = fakeHtmlLensStore();
    const views = fakeDeclareView();
    const reg = createHtmlLensRegistry(sm, region.register, store.store, views.declare);
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
    // The legacy single canvas persists nothing and declares no per-subject view.
    expect(store.saved.size).toBe(0);
    expect(views.declared).toEqual([]);
  });

  test("publishes a per-subject emit to its own key, region, views entry, and store", async () => {
    const { sm, broadcasts, keys } = fakeSnapshotManager();
    const region = fakeRegisterRegion();
    const store = fakeHtmlLensStore();
    const views = fakeDeclareView();
    const reg = createHtmlLensRegistry(sm, region.register, store.store, views.declare);
    const html = "<h1>Release risks</h1>";

    const { key } = await reg.publish(html, { id: "release-risks", title: "Release Risks" });

    expect(key).toBe(htmlLensKey("release-risks"));
    expect(key).toBe("rib:chamber:lens-html:release-risks");
    expect(keys()).toEqual([key]);
    expect(region.calls).toHaveLength(1);
    expect(region.calls[0]?.region).toMatchObject({
      key,
      title: "Release Risks",
      group: "lens",
      groupTitle: "Lenses",
    });
    expect(broadcasts.at(-1)).toEqual({ key, view: html });
    expect(store.saved.get("release-risks")).toEqual({ html, title: "Release Risks" });
    expect(views.declared).toEqual([{ id: "release-risks", title: "Release Risks" }]);
  });

  test("re-emitting the same id updates the panel in place (one region, one views entry)", async () => {
    const { sm, broadcasts } = fakeSnapshotManager();
    const region = fakeRegisterRegion();
    const store = fakeHtmlLensStore();
    const views = fakeDeclareView();
    const reg = createHtmlLensRegistry(sm, region.register, store.store, views.declare);

    await reg.publish("<p>v1</p>", { id: "status" });
    await reg.publish("<p>v2</p>", { id: "status" });

    expect(region.calls).toHaveLength(1);
    expect(views.declared).toHaveLength(1);
    expect(broadcasts.at(-1)).toEqual({ key: htmlLensKey("status"), view: "<p>v2</p>" });
    expect(store.saved.get("status")).toEqual({ html: "<p>v2</p>" });
  });

  test("distinct subjects land on distinct keys, untitled panels fall back to the id", async () => {
    const { sm, keys } = fakeSnapshotManager();
    const region = fakeRegisterRegion();
    const reg = createHtmlLensRegistry(
      sm,
      region.register,
      fakeHtmlLensStore().store,
      fakeDeclareView().declare,
    );

    await reg.publish("<p>a</p>", { id: "alpha" });
    await reg.publish("<p>b</p>", { id: "beta" });

    expect(keys().sort()).toEqual([htmlLensKey("alpha"), htmlLensKey("beta")]);
    expect(region.calls.map((c) => c.region.title)).toEqual(["alpha", "beta"]);
  });

  test("reregister re-establishes the live key WITHOUT re-saving (boot path)", async () => {
    const { sm, broadcasts, keys } = fakeSnapshotManager();
    const store = fakeHtmlLensStore();
    const reg = createHtmlLensRegistry(
      sm,
      fakeRegisterRegion().register,
      store.store,
      fakeDeclareView().declare,
    );

    const { key } = await reg.reregister("persisted", "<p>from disk</p>", "Persisted");

    expect(key).toBe(htmlLensKey("persisted"));
    expect(keys()).toEqual([key]);
    expect(broadcasts.at(-1)).toEqual({ key, view: "<p>from disk</p>" });
    expect(store.saved.size).toBe(0);
  });

  test("dispose releases keys, regions, and per-subject views entries", async () => {
    const { sm, keys } = fakeSnapshotManager();
    const views = fakeDeclareView();
    const reg = createHtmlLensRegistry(
      sm,
      fakeRegisterRegion().register,
      fakeHtmlLensStore().store,
      views.declare,
    );
    await reg.publish("<p>x</p>", { id: "subject" });
    await reg.publish("<p>y</p>");
    expect(keys()).toHaveLength(2);

    reg.dispose();

    expect(keys()).toEqual([]);
    expect(views.declared).toEqual([]);
  });

  test("fails closed on non-string or empty HTML", () => {
    const validate = htmlStringValidator(HTML_LENS_KEY);
    expect(() => validate({})).toThrow(/expected an HTML string/);
    expect(() => validate("")).toThrow(/must not be empty/);
  });
});

describe("HTML lens publish gates", () => {
  test("htmlLensStructuralError rejects external scripts and stylesheets, passes inline", () => {
    expect(htmlLensStructuralError('<script src="https://cdn.example/x.js"></script>')).toMatch(
      /frame CSP/,
    );
    expect(htmlLensStructuralError('<link rel="stylesheet" href="https://x/y.css">')).toMatch(
      /frame CSP/,
    );
    expect(
      htmlLensStructuralError("<style>p{color:red}</style><script>1</script>"),
    ).toBeUndefined();
  });

  test("declaredHtmlPalettes reads per-mode declarations off the body tag", () => {
    const palettes = declaredHtmlPalettes(
      '<body data-palette-dark="#8b7cf6, #bd8622" data-palette-light="#6d4fe0">x</body>',
    );
    expect(palettes.dark).toEqual(["#8b7cf6", "#bd8622"]);
    expect(palettes.light).toEqual(["#6d4fe0"]);
  });

  test("a bare data-palette covers both modes; no body tag declares nothing", () => {
    const both = declaredHtmlPalettes('<body data-palette="#8b7cf6,#bd8622">x</body>');
    expect(both.dark).toEqual(["#8b7cf6", "#bd8622"]);
    expect(both.light).toEqual(["#8b7cf6", "#bd8622"]);
    expect(declaredHtmlPalettes("<p>no body</p>")).toEqual({});
  });
});

// A ToolContext that records emitted chunks so a test can read the tool's output.
function makeToolCtx() {
  const chunks: MessageChunk[] = [];
  const ctx: ToolContext = {
    cwd: ".",
    emit: (c) => chunks.push(c),
    abortSignal: new AbortController().signal,
  };
  return {
    ctx,
    out: () => chunks.map((c) => (c as { content?: string }).content ?? "").join(""),
    errored: () => chunks.some((c) => (c as { isError?: boolean }).isError === true),
  };
}

describe("chamber_emit_lens_html tool", () => {
  const registerTools = rib.registerTools;
  if (!registerTools) throw new Error("rib is missing registerTools");

  let workspace: string;
  let harness: ReturnType<typeof fakeSnapshotManager>;
  let tools: readonly ToolDefinition[];

  function makeCtx(sm: SnapshotManager): RibContext {
    return {
      getExec: () => ({
        runJSON: async () => ({ ok: true as const, data: undefined }),
        runText: async () => ({ ok: true as const, data: "" }),
      }),
      getSnapshotManager: () => sm,
      registerRegion: () => () => {},
    } as unknown as RibContext;
  }

  function emitTool(): ToolDefinition {
    const t = tools.find((x) => x.name === "chamber_emit_lens_html");
    if (!t) throw new Error("chamber_emit_lens_html not registered");
    return t;
  }

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "chamber-lens-html-tool-"));
    setChamberDataHome(join(workspace, "chamber"));
  });
  afterAll(async () => {
    await rib.dispose?.();
    setChamberDataHome(undefined);
    await rm(workspace, { recursive: true, force: true });
  });
  beforeEach(async () => {
    // Fresh registry per test on a clean on-disk slate, so a prior test's lens
    // can't be boot-re-registered into this one.
    await rib.dispose?.();
    await rm(htmlLensesDir(), { recursive: true, force: true });
    harness = fakeSnapshotManager();
    tools = registerTools(makeCtx(harness.sm));
  });

  test("an emit with an id publishes per-subject and persists to the html lens store", async () => {
    const t = makeToolCtx();
    await emitTool().execute(
      { html: "<h1>Risks</h1>", id: "release-risks", title: "Release Risks" },
      t.ctx,
    );
    expect(t.errored()).toBe(false);
    expect(JSON.parse(t.out())).toEqual({ ok: true, key: htmlLensKey("release-risks") });
    expect(harness.keys()).toContain(htmlLensKey("release-risks"));
    const persisted = await listHtmlLenses(htmlLensesDir());
    expect(persisted.map((l) => l.id)).toEqual(["release-risks"]);
    expect(persisted[0]?.html).toBe("<h1>Risks</h1>");
    expect(persisted[0]?.title).toBe("Release Risks");
    // The drawer resolves the per-subject key's kind through the live views list.
    expect(rib.views).toContainEqual({
      key: htmlLensKey("release-risks"),
      canvasKind: "html",
      title: "Release Risks",
    });
  });

  test("an emit without an id still lands on the legacy fixed key, unpersisted", async () => {
    const t = makeToolCtx();
    await emitTool().execute({ html: "<h1>Legacy</h1>" }, t.ctx);
    expect(t.errored()).toBe(false);
    expect(JSON.parse(t.out())).toEqual({ ok: true, key: HTML_LENS_KEY });
    expect(harness.keys()).toContain(HTML_LENS_KEY);
    expect(await listHtmlLenses(htmlLensesDir())).toEqual([]);
  });

  test("canonicalizes the id so one subject maps to one key", async () => {
    const t = makeToolCtx();
    await emitTool().execute({ html: "<p>x</p>", id: "Release Risks" }, t.ctx);
    expect(JSON.parse(t.out())).toEqual({ ok: true, key: htmlLensKey("release-risks") });
  });

  test("rejects an id with no usable characters", async () => {
    const t = makeToolCtx();
    await emitTool().execute({ html: "<p>x</p>", id: "!!!" }, t.ctx);
    expect(t.errored()).toBe(true);
    expect(t.out()).toMatch(/no usable characters/);
  });

  test("rejects an external <script src> fail-closed (nothing published or persisted)", async () => {
    const t = makeToolCtx();
    await emitTool().execute(
      { html: '<script src="https://cdn.example/chart.js"></script>', id: "chart" },
      t.ctx,
    );
    expect(t.errored()).toBe(true);
    expect(t.out()).toMatch(/frame CSP/);
    expect(harness.keys()).not.toContain(htmlLensKey("chart"));
    expect(await listHtmlLenses(htmlLensesDir())).toEqual([]);
  });

  test("rejects an external stylesheet fail-closed", async () => {
    const t = makeToolCtx();
    await emitTool().execute(
      { html: '<link rel="stylesheet" href="https://fonts.example/x.css">', id: "styled" },
      t.ctx,
    );
    expect(t.errored()).toBe(true);
    expect(t.out()).toMatch(/frame CSP/);
  });

  test("rejects a gray palette fail-closed with the per-check report (nothing published)", async () => {
    const t = makeToolCtx();
    await emitTool().execute(
      {
        html: '<body data-palette-dark="#777777,#787878"><p>grays</p></body>',
        id: "gray-chart",
      },
      t.ctx,
    );
    expect(t.errored()).toBe(true);
    expect(t.out()).toMatch(/\[FAIL/);
    expect(t.out()).toMatch(/chroma-floor/);
    expect(harness.keys()).not.toContain(htmlLensKey("gray-chart"));
    expect(await listHtmlLenses(htmlLensesDir())).toEqual([]);
  });

  test("accepts the keelson series slots per declared mode (the reference palettes pass)", async () => {
    const t = makeToolCtx();
    const html = `<body data-palette-dark="${DESIGN_TOKENS.dark.series.join(",")}" data-palette-light="${DESIGN_TOKENS.light.series.join(",")}"><p>chart</p></body>`;
    await emitTool().execute({ html, id: "series-chart" }, t.ctx);
    expect(t.errored()).toBe(false);
    expect(JSON.parse(t.out())).toEqual({ ok: true, key: htmlLensKey("series-chart") });
  });

  test("rejects an unparseable palette value fail-closed", async () => {
    const t = makeToolCtx();
    await emitTool().execute(
      { html: '<body data-palette-dark="tomato,cyan"><p>x</p></body>', id: "named-colors" },
      t.ctx,
    );
    expect(t.errored()).toBe(true);
    expect(t.out()).toMatch(/data-palette-dark/);
  });
});

describe("HTML lens boot re-registration", () => {
  const registerTools = rib.registerTools;
  if (!registerTools) throw new Error("rib is missing registerTools");

  let workspace: string;
  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "chamber-lens-html-boot-"));
    setChamberDataHome(join(workspace, "chamber"));
  });
  afterAll(async () => {
    await rib.dispose?.();
    setChamberDataHome(undefined);
    await rm(workspace, { recursive: true, force: true });
  });

  function makeCtx(sm: SnapshotManager): RibContext {
    return {
      getExec: () => ({
        runJSON: async () => ({ ok: true as const, data: undefined }),
        runText: async () => ({ ok: true as const, data: "" }),
      }),
      getSnapshotManager: () => sm,
      registerRegion: () => () => {},
    } as unknown as RibContext;
  }

  // Poll until the snapshot key appears (boot reconcile is fire-and-forget) — a
  // condition wait instead of an arbitrary sleep, so a slow runner can't flake.
  async function waitForKey(keys: () => string[], key: string): Promise<void> {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (keys().includes(key)) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`snapshot key ${key} never appeared within 2000ms`);
  }

  test("re-publishes every persisted html lens on boot, recomposed with the same html", async () => {
    const authored = "2026-01-01T00:00:00.000Z";
    const store = createFileHtmlLensStore(htmlLensesDir());
    await store.save({ id: "persisted-a", html: "<h1>A</h1>", title: "A" });
    // Backdate one record so the test can also prove reregister never re-stamps.
    await store.save({ id: "vintage", html: "<h1>V</h1>" });
    await writeFile(
      join(htmlLensesDir(), "vintage", "meta.json"),
      JSON.stringify({ id: "vintage", updatedAt: authored }),
    );

    await rib.dispose?.();
    const harness = fakeSnapshotManager();
    registerTools(makeCtx(harness.sm));
    await waitForKey(harness.keys, htmlLensKey("persisted-a"));
    await waitForKey(harness.keys, htmlLensKey("vintage"));

    // Recomposed frames serve the persisted markup after the restart.
    const lastFor = (key: string) => harness.broadcasts.filter((b) => b.key === key).at(-1);
    expect(lastFor(htmlLensKey("persisted-a"))?.view).toBe("<h1>A</h1>");
    expect(lastFor(htmlLensKey("vintage"))?.view).toBe("<h1>V</h1>");
    // Boot goes through reregister, never save: the authored updatedAt survives.
    const vintage = (await listHtmlLenses(htmlLensesDir())).find((l) => l.id === "vintage");
    expect(vintage?.updatedAt).toBe(authored);
    // The views entry comes back too, so the drawer renders html after restart.
    expect(
      rib.views?.some((v) => v.key === htmlLensKey("vintage") && v.canvasKind === "html"),
    ).toBe(true);
  });

  test("a living html lens comes back with its refresh wiring, not just its markup", async () => {
    // The reconcile is the only path that rebuilds a panel's region after a restart, so
    // dropping refresh here would cost every living html lens its cadence on every
    // restart — silently, since nothing re-reads the record to notice.
    await createFileHtmlLensStore(htmlLensesDir()).save({
      id: "living",
      html: "<h1>L</h1>",
      refresh: { workflow: "chamber-lens-living", cadenceMs: 60_000, inputs: { env: "prod" } },
    });

    await rib.dispose?.();
    const harness = fakeSnapshotManager();
    const regions = new Map<string, RibSurfaceRegion>();
    const ctx = {
      ...makeCtx(harness.sm),
      registerRegion: (_surfaceId: string, region: RibSurfaceRegion) => {
        regions.set(region.key, region);
        return () => regions.delete(region.key);
      },
    } as unknown as RibContext;
    registerTools(ctx);
    await waitForKey(harness.keys, htmlLensKey("living"));

    const wired = regions.get(htmlLensKey("living"));
    expect(wired?.workflow).toBe("chamber-lens-living");
    expect(wired?.cadenceMs).toBe(60_000);
    expect(wired?.workflowArgs).toEqual({ env: "prod", lens: "living" });
  });
});

describe("HTML lens rib wiring", () => {
  test("declares the legacy html canvas key in rib.views", () => {
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
