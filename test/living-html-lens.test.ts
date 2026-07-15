import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  MessageChunk,
  RibContext,
  RibSurfaceRegion,
  SnapshotManager,
  ToolContext,
} from "@keelson/shared";
import rib from "../src/index.ts";
import { DEFAULT_LENS_REFRESH_CADENCE_MS } from "../src/lens.ts";
import { createHtmlLensRegistry, HTML_LENS_KEY, htmlLensKey } from "../src/lens-html.ts";
import { createFileHtmlLensStore, type HtmlLensStore } from "../src/lens-html-store.ts";
import { createFileLensStore } from "../src/lens-store.ts";
import { htmlLensesDir, lensesDir, lensWorkflowsDir, setChamberDataHome } from "../src/paths.ts";

const page = (body: string): string => `<html><body><p>${body}</p></body></html>`;

function fakeSnapshotManager(): SnapshotManager {
  const composers = new Map<string, () => unknown>();
  return {
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
}

function fakeRegisterRegion() {
  const calls: { surfaceId: string; region: RibSurfaceRegion }[] = [];
  const active = new Map<string, RibSurfaceRegion>();
  return {
    register: (surfaceId: string, region: RibSurfaceRegion) => {
      calls.push({ surfaceId, region });
      active.set(region.key, region);
      return () => {
        active.delete(region.key);
      };
    },
    calls,
    current: (key: string) => active.get(key),
  };
}

function memoryHtmlStore(): HtmlLensStore {
  const saved = new Map<string, unknown>();
  return {
    async save(record) {
      saved.set(record.id, record);
    },
    async load(id) {
      return saved.get(id) as Awaited<ReturnType<HtmlLensStore["load"]>>;
    },
    async delete(id) {
      if (!saved.delete(id)) throw new Error(`lens '${id}' not found`);
    },
  };
}

function declaredViews() {
  const views: { id: string; title?: string }[] = [];
  return {
    declare: (id: string, title?: string) => {
      const entry = { id, ...(title ? { title } : {}) };
      views.push(entry);
      return () => {
        const at = views.indexOf(entry);
        if (at >= 0) views.splice(at, 1);
      };
    },
    views,
  };
}

// ---------------------------------------------------------------------------
// Registry wiring — the canvas twin's living-lens region contract, on the HTML
// seam: a backing reaches the region, a re-emit swaps it in place, and identical
// markup is not re-broadcast.
// ---------------------------------------------------------------------------

describe("living-html-lens region wiring", () => {
  it("a refresh-backed html lens region carries workflow + per-lens args + the default cadence", async () => {
    const region = fakeRegisterRegion();
    const reg = createHtmlLensRegistry(fakeSnapshotManager(), region.register, memoryHtmlStore());
    await reg.publish(page("hi"), { id: "status", refresh: { workflow: "chamber-lens-status" } });
    const wired = region.current(htmlLensKey("status"));
    expect(wired?.workflow).toBe("chamber-lens-status");
    expect(wired?.workflowArgs).toEqual({ lens: "status" });
    expect(wired?.cadenceMs).toBe(DEFAULT_LENS_REFRESH_CADENCE_MS);
    expect(wired?.headActions?.map((a) => a.type)).toEqual(["retire-lens-html"]);
  });

  it("clamps a sub-floor cadence so a hand-edited record can't sink the region parse", async () => {
    const region = fakeRegisterRegion();
    const reg = createHtmlLensRegistry(fakeSnapshotManager(), region.register, memoryHtmlStore());
    await reg.reregister("fast", page("hi"), undefined, { workflow: "w", cadenceMs: 1_000 });
    expect(region.current(htmlLensKey("fast"))?.cadenceMs).toBe(30_000);
  });

  it("the region's workflowArgs carry the refresh's own inputs, which cannot shadow the lens id", async () => {
    const region = fakeRegisterRegion();
    const reg = createHtmlLensRegistry(fakeSnapshotManager(), region.register, memoryHtmlStore());
    await reg.publish(page("hi"), {
      id: "metrics",
      refresh: { workflow: "w", inputs: { repo: "acme/widget", lens: "evil" } },
    });
    expect(region.current(htmlLensKey("metrics"))?.workflowArgs).toEqual({
      repo: "acme/widget",
      lens: "metrics",
    });
  });

  it("a plain html lens region wires no workflow but still carries the retire head verb", async () => {
    const region = fakeRegisterRegion();
    const reg = createHtmlLensRegistry(fakeSnapshotManager(), region.register, memoryHtmlStore());
    await reg.publish(page("hi"), { id: "plain" });
    const wired = region.current(htmlLensKey("plain"));
    expect(wired?.workflow).toBeUndefined();
    expect(wired?.headActions?.map((a) => a.type)).toEqual(["retire-lens-html"]);
  });

  it("the legacy id-less canvas takes no refresh wiring and no retire verb", async () => {
    const region = fakeRegisterRegion();
    const reg = createHtmlLensRegistry(fakeSnapshotManager(), region.register, memoryHtmlStore());
    await reg.publish(page("hi"), { refresh: { workflow: "w" } });
    const wired = region.current(HTML_LENS_KEY);
    expect(wired?.workflow).toBeUndefined();
    expect(wired?.headActions).toBeUndefined();
  });

  it("re-emitting with a changed refresh swaps the region in place; unchanged leaves it alone", async () => {
    const region = fakeRegisterRegion();
    const reg = createHtmlLensRegistry(fakeSnapshotManager(), region.register, memoryHtmlStore());
    await reg.publish(page("1"), { id: "s", refresh: { workflow: "w1" } });
    expect(region.calls).toHaveLength(1);
    // Same wiring → no region churn (the SPA would remount the panel).
    await reg.publish(page("2"), { id: "s", refresh: { workflow: "w1" } });
    expect(region.calls).toHaveLength(1);
    // Changed backing → the region re-registers with the new workflow.
    await reg.publish(page("3"), { id: "s", refresh: { workflow: "w2" } });
    expect(region.calls).toHaveLength(2);
    expect(region.current(htmlLensKey("s"))?.workflow).toBe("w2");
    // Cleared backing → the wiring drops but the head verb stays.
    await reg.publish(page("4"), { id: "s" });
    const wired = region.current(htmlLensKey("s"));
    expect(wired?.workflow).toBeUndefined();
    expect(wired?.headActions?.map((a) => a.type)).toEqual(["retire-lens-html"]);
  });

  it("an inputs-only change rewires the region rather than stranding stale args", async () => {
    const region = fakeRegisterRegion();
    const reg = createHtmlLensRegistry(fakeSnapshotManager(), region.register, memoryHtmlStore());
    await reg.publish(page("1"), { id: "s", refresh: { workflow: "w", inputs: { env: "dev" } } });
    await reg.publish(page("2"), { id: "s", refresh: { workflow: "w", inputs: { env: "prod" } } });
    expect(region.calls).toHaveLength(2);
    expect(region.current(htmlLensKey("s"))?.workflowArgs).toEqual({ env: "prod", lens: "s" });
  });

  it("a changed title rewires the region and its views entry", async () => {
    const region = fakeRegisterRegion();
    const views = declaredViews();
    const reg = createHtmlLensRegistry(
      fakeSnapshotManager(),
      region.register,
      memoryHtmlStore(),
      views.declare,
    );
    await reg.publish(page("1"), { id: "s", title: "Before" });
    await reg.publish(page("2"), { id: "s", title: "After" });
    expect(region.current(htmlLensKey("s"))?.title).toBe("After");
    // One entry, not two: the stale declaration is released before the new one.
    expect(views.views).toEqual([{ id: "s", title: "After" }]);
  });

  it("does not re-broadcast identical markup — the tick that changed nothing earns no freshness", async () => {
    // The failure this exists for: a living page re-derived on cadence from unchanged
    // data would otherwise restamp the frame's composedAt every tick, so the panel head
    // reads "just now" forever.
    const region = fakeRegisterRegion();
    const recomposed: string[] = [];
    const sm = {
      register: () => () => {},
      async recompose(key: string) {
        recomposed.push(key);
        return undefined;
      },
      latest: () => undefined,
      keys: () => [],
      dispose: async () => {},
    } as unknown as SnapshotManager;
    const reg = createHtmlLensRegistry(sm, region.register, memoryHtmlStore());
    const composes = () => recomposed.filter((k) => k === htmlLensKey("s")).length;
    await reg.publish(page("same"), { id: "s" });
    const afterFirst = composes();
    await reg.publish(page("same"), { id: "s" });
    expect(composes()).toBe(afterFirst);
    // A changed page still publishes.
    await reg.publish(page("different"), { id: "s" });
    expect(composes()).toBeGreaterThan(afterFirst);
  });
});

// ---------------------------------------------------------------------------
// Store round-trip — refresh persists, a malformed one degrades to a lens with
// no cadence rather than a panel that won't register.
// ---------------------------------------------------------------------------

describe("html lens store refresh round-trip", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "chamber-html-store-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("persists a refresh backing and reads it back", async () => {
    const store = createFileHtmlLensStore(root);
    await store.save({
      id: "s",
      html: page("hi"),
      refresh: { workflow: "chamber-lens-s", cadenceMs: 60_000, inputs: { repo: "acme/widget" } },
    });
    expect((await store.load("s"))?.refresh).toEqual({
      workflow: "chamber-lens-s",
      cadenceMs: 60_000,
      inputs: { repo: "acme/widget" },
    });
  });

  it("honors a caller-supplied updatedAt over its own clock", async () => {
    const store = createFileHtmlLensStore(root);
    await store.save({ id: "s", html: page("hi"), updatedAt: "2020-01-01T00:00:00.000Z" });
    expect((await store.load("s"))?.updatedAt).toBe("2020-01-01T00:00:00.000Z");
  });

  it("folds a malformed refresh to absent, keeping the lens", async () => {
    // The panel must survive a hand-edited record: a bad backing costs the lens its
    // cadence, never its page (the region schema would throw on registration).
    await mkdir(join(root, "bad"), { recursive: true });
    await writeFile(join(root, "bad", "lens.html"), page("hi"));
    await writeFile(
      join(root, "bad", "meta.json"),
      JSON.stringify({
        id: "bad",
        updatedAt: "2026-01-01T00:00:00.000Z",
        refresh: { workflow: "w", cadenceMs: 1.5 },
      }),
    );
    const record = await createFileHtmlLensStore(root).load("bad");
    expect(record?.html).toBe(page("hi"));
    expect(record?.refresh).toBeUndefined();
  });

  it("folds a non-string refresh input to absent, keeping the lens", async () => {
    await mkdir(join(root, "badin"), { recursive: true });
    await writeFile(join(root, "badin", "lens.html"), page("hi"));
    await writeFile(
      join(root, "badin", "meta.json"),
      JSON.stringify({
        id: "badin",
        updatedAt: "2026-01-01T00:00:00.000Z",
        refresh: { workflow: "w", inputs: { n: 3 } },
      }),
    );
    const record = await createFileHtmlLensStore(root).load("badin");
    expect(record?.html).toBe(page("hi"));
    expect(record?.refresh).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tool behavior through the real rib: refresh resolution on emit, the merged
// lens list, and the kind-routed retire.
// ---------------------------------------------------------------------------

let workspace: string;
let tools: ReturnType<NonNullable<typeof rib.registerTools>>;

const registerTools = rib.registerTools;
if (!registerTools) throw new Error("rib is missing registerTools");

function makeCtx(sm: SnapshotManager): RibContext {
  return {
    getExec: () => ({
      runJSON: async () => ({ ok: true as const, data: undefined }),
      runText: async () => ({ ok: true as const, data: "" }),
    }),
    getSnapshotManager: () => sm,
    registerRegion: () => () => {},
    refreshWorkflow: async () => {},
  } as unknown as RibContext;
}

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

function tool(name: string) {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`${name} not registered`);
  return t;
}

async function emitHtml(input: Record<string, unknown>) {
  const t = makeToolCtx();
  await tool("chamber_emit_lens_html").execute(input, t.ctx);
  return t;
}

describe("living-html-lens emit", () => {
  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "chamber-living-html-"));
    setChamberDataHome(join(workspace, "chamber"));
  });
  afterAll(async () => {
    await rib.dispose?.();
    setChamberDataHome(undefined);
    await rm(workspace, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await rib.dispose?.();
    await rm(lensesDir(), { recursive: true, force: true });
    await rm(htmlLensesDir(), { recursive: true, force: true });
    tools = registerTools(makeCtx(fakeSnapshotManager()));
  });

  it("refuses a refresh that names no workflow — an html lens has no generic re-author", async () => {
    // The asymmetry with chamber_emit_lens, which fills in chamber-lens-refresh: nothing
    // generic can re-compose a page, so a defaulted backing would be one that churns.
    const t = await emitHtml({ id: "s", html: page("hi"), refresh: {} });
    expect(t.errored()).toBe(true);
    expect(t.out()).toContain("must name a `workflow`");
    // Fail-closed: nothing persisted.
    expect(await createFileHtmlLensStore(htmlLensesDir()).load("s")).toBeUndefined();
  });

  it("refuses a refresh on the legacy id-less canvas", async () => {
    const t = await emitHtml({ html: page("hi"), refresh: { workflow: "chamber-lens-x" } });
    expect(t.errored()).toBe(true);
    expect(t.out()).toContain("needs an `id`");
  });

  it("persists a named backing and wires it", async () => {
    const t = await emitHtml({
      id: "s",
      html: page("hi"),
      refresh: { workflow: "chamber-lens-s", cadenceMs: 60_000, inputs: { repo: "acme/widget" } },
    });
    expect(t.errored()).toBe(false);
    expect((await createFileHtmlLensStore(htmlLensesDir()).load("s"))?.refresh).toEqual({
      workflow: "chamber-lens-s",
      cadenceMs: 60_000,
      inputs: { repo: "acme/widget" },
    });
  });

  it("re-emit without refresh preserves the backing; refresh: null clears it", async () => {
    const store = createFileHtmlLensStore(htmlLensesDir());
    await emitHtml({ id: "s", html: page("1"), refresh: { workflow: "chamber-lens-s" } });
    // A producer re-emitting its page without repeating the config must not strip
    // its own backing — the first refresh would otherwise be the last.
    await emitHtml({ id: "s", html: page("2") });
    expect((await store.load("s"))?.refresh).toEqual({ workflow: "chamber-lens-s" });
    await emitHtml({ id: "s", html: page("3"), refresh: null });
    expect((await store.load("s"))?.refresh).toBeUndefined();
  });

  it("a refresh object PATCHES the prior backing", async () => {
    const store = createFileHtmlLensStore(htmlLensesDir());
    await emitHtml({
      id: "s",
      html: page("1"),
      refresh: { workflow: "chamber-lens-s", cadenceMs: 60_000, inputs: { env: "dev" } },
    });
    // A cadence-only re-emit keeps the workflow and inputs it never mentioned.
    await emitHtml({ id: "s", html: page("2"), refresh: { cadenceMs: 90_000 } });
    expect((await store.load("s"))?.refresh).toEqual({
      workflow: "chamber-lens-s",
      cadenceMs: 90_000,
      inputs: { env: "dev" },
    });
  });

  it("an unchanged page holds updatedAt; a changed page earns a new one", async () => {
    const store = createFileHtmlLensStore(htmlLensesDir());
    await emitHtml({ id: "s", html: page("same") });
    const first = (await store.load("s"))?.updatedAt;
    await emitHtml({ id: "s", html: page("same") });
    expect((await store.load("s"))?.updatedAt).toBe(first);
    await emitHtml({ id: "s", html: page("changed") });
    expect((await store.load("s"))?.updatedAt).not.toBe(first);
  });

  it("caveats a backing chamber does not contribute, and stays quiet about one it does", async () => {
    // The host runs only a rib-contributed workflow on a panel's cadence, and refuses
    // the rest silently — the emit reply is the one place the author can hear it. So a
    // workflow the operator placed in chamber's dir must earn silence, or the warning
    // cries wolf on the one path that actually works.
    const unvouched = await emitHtml({
      id: "s",
      html: page("hi"),
      refresh: { workflow: "my-local-workflow" },
    });
    expect(unvouched.errored()).toBe(false);
    expect(unvouched.out()).toContain("chamber does not contribute");
    await mkdir(lensWorkflowsDir(), { recursive: true });
    await writeFile(
      join(lensWorkflowsDir(), "status.yaml"),
      "description: derive\nnodes:\n  - id: n\n    bash: echo hi\n",
    );
    rib.contributeWorkflows?.({} as Parameters<NonNullable<typeof rib.contributeWorkflows>>[0]);
    const vouched = await emitHtml({
      id: "t",
      html: page("hi"),
      refresh: { workflow: "chamber-lens-status" },
    });
    expect(JSON.parse(vouched.out()).note).toBeUndefined();
    await rm(lensWorkflowsDir(), { recursive: true, force: true });
  });
});

describe("lens tools cover both species", () => {
  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "chamber-lens-species-"));
    setChamberDataHome(join(workspace, "chamber"));
  });
  afterAll(async () => {
    await rib.dispose?.();
    setChamberDataHome(undefined);
    await rm(workspace, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await rib.dispose?.();
    await rm(lensesDir(), { recursive: true, force: true });
    await rm(htmlLensesDir(), { recursive: true, force: true });
    tools = registerTools(makeCtx(fakeSnapshotManager()));
  });

  async function listLensRows(input: Record<string, unknown> = {}) {
    const t = makeToolCtx();
    await tool("chamber_list_lenses").execute(input, t.ctx);
    return JSON.parse(t.out()) as {
      count: number;
      lenses: { id: string; kind: string; board?: unknown; title?: string }[];
    };
  }

  async function retire(input: Record<string, unknown>) {
    const t = makeToolCtx();
    await tool("chamber_retire_lens").execute(input, t.ctx);
    return t;
  }

  it("chamber_list_lenses returns both species, each marked with its kind", async () => {
    await tool("chamber_emit_lens").execute(
      { id: "board-one", board: { view: "board", title: "B", sections: [] } },
      makeToolCtx().ctx,
    );
    await emitHtml({ id: "page-one", html: page("hi"), title: "Page One" });
    const { lenses } = await listLensRows();
    expect(lenses.map((l) => [l.id, l.kind]).sort()).toEqual([
      ["board-one", "canvas"],
      ["page-one", "html"],
    ]);
    // The markup never rides the list: a page is far past the tool-result budget.
    expect(lenses.find((l) => l.kind === "html")).not.toHaveProperty("html");
    expect(lenses.find((l) => l.kind === "html")?.title).toBe("Page One");
  });

  it("one id can name both species, and a single-id fetch leads with the board-bearing row", async () => {
    // emitJsonList drops TRAILING rows to fit the cap, so a canvas row behind an html
    // row of the same id could lose the board a refresh turn fetched it for.
    await tool("chamber_emit_lens").execute(
      { id: "twin", board: { view: "board", title: "B", sections: [] } },
      makeToolCtx().ctx,
    );
    await emitHtml({ id: "twin", html: page("hi") });
    const { lenses } = await listLensRows({ id: "twin" });
    expect(lenses).toHaveLength(2);
    expect(lenses[0]?.kind).toBe("canvas");
    expect(lenses[0]?.board).toBeDefined();
  });

  it("chamber_retire_lens removes an html lens: record gone, panel released", async () => {
    await emitHtml({ id: "page-one", html: page("hi") });
    const t = await retire({ id: "page-one" });
    expect(t.errored()).toBe(false);
    expect(JSON.parse(t.out())).toMatchObject({ ok: true, kind: "html" });
    expect(await createFileHtmlLensStore(htmlLensesDir()).load("page-one")).toBeUndefined();
    // A second retire fails closed rather than reporting a success it didn't perform.
    expect((await retire({ id: "page-one" })).errored()).toBe(true);
  });

  it("refuses an ambiguous retire when one id names both species", async () => {
    // Destructive and unrecoverable: guessing would delete the lens the caller didn't mean.
    await tool("chamber_emit_lens").execute(
      { id: "twin", board: { view: "board", title: "B", sections: [] } },
      makeToolCtx().ctx,
    );
    await emitHtml({ id: "twin", html: page("hi") });
    const t = await retire({ id: "twin" });
    expect(t.errored()).toBe(true);
    expect(t.out()).toContain("names BOTH");
    // Neither was touched.
    expect(await createFileLensStore(lensesDir()).loadLens("twin")).toBeDefined();
    expect(await createFileHtmlLensStore(htmlLensesDir()).load("twin")).toBeDefined();
  });

  it("refuses rather than guessing when a twin exists but cannot be read", async () => {
    // The ambiguity probe must ask whether the id is TAKEN, not whether it parses:
    // both stores fold a torn record to undefined, so probing with a loader would let
    // a damaged twin read as absent and delete the readable species on a guess.
    await tool("chamber_emit_lens").execute(
      { id: "twin", board: { view: "board", title: "B", sections: [] } },
      makeToolCtx().ctx,
    );
    await emitHtml({ id: "twin", html: page("hi") });
    await writeFile(join(htmlLensesDir(), "twin", "meta.json"), "{ not json");
    // The html record is now unreadable...
    expect(await createFileHtmlLensStore(htmlLensesDir()).load("twin")).toBeUndefined();
    // ...but its id is still taken, so an unqualified retire must not touch the canvas one.
    const t = await retire({ id: "twin" });
    expect(t.errored()).toBe(true);
    expect(await createFileLensStore(lensesDir()).loadLens("twin")).toBeDefined();
    // kind is the way through, and it can still clear the damaged record.
    expect((await retire({ id: "twin", kind: "html" })).errored()).toBe(false);
    expect((await retire({ id: "twin" })).errored()).toBe(false);
  });

  it("kind picks the species when an id names both", async () => {
    await tool("chamber_emit_lens").execute(
      { id: "twin", board: { view: "board", title: "B", sections: [] } },
      makeToolCtx().ctx,
    );
    await emitHtml({ id: "twin", html: page("hi") });
    expect((await retire({ id: "twin", kind: "html" })).errored()).toBe(false);
    expect(await createFileHtmlLensStore(htmlLensesDir()).load("twin")).toBeUndefined();
    // The canvas twin is untouched, and now resolves without a kind.
    expect(await createFileLensStore(lensesDir()).loadLens("twin")).toBeDefined();
    expect((await retire({ id: "twin" })).errored()).toBe(false);
    expect(await createFileLensStore(lensesDir()).loadLens("twin")).toBeUndefined();
  });

  it("still steers a canvas-only id, exhibits included", async () => {
    await tool("chamber_emit_lens").execute(
      { id: "board-one", board: { view: "board", title: "B", sections: [] } },
      makeToolCtx().ctx,
    );
    const ok = await retire({ id: "board-one" });
    expect(JSON.parse(ok.out())).toMatchObject({ ok: true, kind: "canvas" });
    await tool("chamber_table_exhibit").execute(
      { id: "verdict", board: { view: "board", title: "V", sections: [] } },
      makeToolCtx().ctx,
    );
    const exhibit = await retire({ id: "verdict" });
    expect(exhibit.errored()).toBe(true);
    expect(exhibit.out()).toContain("chamber_delete_exhibit");
  });
});
