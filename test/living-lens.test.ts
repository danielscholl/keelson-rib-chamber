import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CanvasBoardView,
  MessageChunk,
  RibContext,
  RibSurfaceRegion,
  SnapshotManager,
  ToolContext,
} from "@keelson/shared";
import rib from "../src/index.ts";
import { createLensRegistry, DEFAULT_LENS_REFRESH_CADENCE_MS, lensKey } from "../src/lens.ts";
import { createFileHtmlLensStore } from "../src/lens-html-store.ts";
import { createFileLensStore, type LensStore } from "../src/lens-store.ts";
import { htmlLensesDir, lensesDir, setChamberDataHome } from "../src/paths.ts";

const onAction = rib.onAction;
if (!onAction) throw new Error("rib is missing onAction");
const registerTools = rib.registerTools;
if (!registerTools) throw new Error("rib is missing registerTools");

const board = (title: string): CanvasBoardView => ({ view: "board", title, sections: [] });

// ---------------------------------------------------------------------------
// Registry wiring — a refresh-backed lens's region carries the re-compose
// workflow, its per-lens args, a clamped cadence, and the head verbs.
// ---------------------------------------------------------------------------

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

function memoryLensStore(): LensStore {
  const saved = new Map<string, unknown>();
  return {
    async saveLens(record) {
      saved.set(record.id, record);
    },
    async loadLens(id) {
      return saved.get(id) as Awaited<ReturnType<LensStore["loadLens"]>>;
    },
    async deleteLens(id) {
      saved.delete(id);
    },
  };
}

describe("living-lens region wiring", () => {
  it("a refresh-backed lens region carries workflow + per-lens args + the default cadence", async () => {
    const region = fakeRegisterRegion();
    const reg = createLensRegistry(fakeSnapshotManager(), region.register, memoryLensStore());
    await reg.publish("morning-brief", board("Morning Brief"), undefined, "lens", {
      workflow: "chamber-lens-refresh",
    });
    const wired = region.current(lensKey("morning-brief"));
    expect(wired?.workflow).toBe("chamber-lens-refresh");
    expect(wired?.workflowArgs).toEqual({ lens: "morning-brief" });
    expect(wired?.cadenceMs).toBe(DEFAULT_LENS_REFRESH_CADENCE_MS);
    expect(wired?.headActions?.map((a) => a.type)).toEqual(["retire-lens"]);
  });

  it("clamps a sub-floor cadence so a hand-edited record can't sink the region parse", async () => {
    const region = fakeRegisterRegion();
    const reg = createLensRegistry(fakeSnapshotManager(), region.register, memoryLensStore());
    await reg.reregister("fast", board("Fast"), "lens", { workflow: "w", cadenceMs: 1_000 });
    expect(region.current(lensKey("fast"))?.cadenceMs).toBe(30_000);
  });

  it("a plain lens region wires no workflow but still carries the retire head verb", async () => {
    const region = fakeRegisterRegion();
    const reg = createLensRegistry(fakeSnapshotManager(), region.register, memoryLensStore());
    await reg.publish("plain", board("Plain"));
    const wired = region.current(lensKey("plain"));
    expect(wired?.workflow).toBeUndefined();
    expect(wired?.headActions?.map((a) => a.type)).toEqual(["retire-lens"]);
  });

  it("an exhibit region carries the delete head verb and never refresh wiring", async () => {
    const region = fakeRegisterRegion();
    const reg = createLensRegistry(fakeSnapshotManager(), region.register, memoryLensStore());
    await reg.publish("verdict", board("Verdict"), undefined, "exhibit");
    const wired = region.current(lensKey("verdict"));
    expect(wired?.workflow).toBeUndefined();
    expect(wired?.headActions?.map((a) => a.type)).toEqual(["delete-exhibit"]);
  });

  it("re-publishing with a changed refresh swaps the region in place; unchanged leaves it alone", async () => {
    const region = fakeRegisterRegion();
    const reg = createLensRegistry(fakeSnapshotManager(), region.register, memoryLensStore());
    await reg.publish("brief", board("Brief"), undefined, "lens", { workflow: "w1" });
    expect(region.calls).toHaveLength(1);
    // Same wiring → no region churn (the SPA would remount the panel).
    await reg.publish("brief", board("Brief 2"), undefined, "lens", { workflow: "w1" });
    expect(region.calls).toHaveLength(1);
    // Changed backing → the region re-registers with the new workflow.
    await reg.publish("brief", board("Brief 3"), undefined, "lens", { workflow: "w2" });
    expect(region.calls).toHaveLength(2);
    expect(region.current(lensKey("brief"))?.workflow).toBe("w2");
    // Cleared backing → the wiring drops but the head verb stays.
    await reg.publish("brief", board("Brief 4"), undefined, "lens");
    const wired = region.current(lensKey("brief"));
    expect(wired?.workflow).toBeUndefined();
    expect(wired?.headActions?.map((a) => a.type)).toEqual(["retire-lens"]);
  });
});

// ---------------------------------------------------------------------------
// Store round-trip — refresh persists on lenses, never on exhibits, and a
// malformed block folds away instead of hiding the record.
// ---------------------------------------------------------------------------

describe("lens store refresh round-trip", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "chamber-living-store-"));
  });

  it("persists refresh on a lens and strips it from an exhibit save", async () => {
    const store = createFileLensStore(root);
    await store.saveLens({
      id: "brief",
      board: board("Brief"),
      refresh: { workflow: "chamber-lens-refresh", cadenceMs: 60_000 },
    });
    expect((await store.loadLens("brief"))?.refresh).toEqual({
      workflow: "chamber-lens-refresh",
      cadenceMs: 60_000,
    });
    await store.saveLens({
      id: "verdict",
      board: board("Verdict"),
      kind: "exhibit",
      refresh: { workflow: "chamber-lens-refresh" },
    });
    expect((await store.loadLens("verdict"))?.refresh).toBeUndefined();
  });

  it("folds a malformed refresh block to absent, keeping the lens", async () => {
    await mkdir(join(root, "bad"), { recursive: true });
    await writeFile(
      join(root, "bad", "lens.json"),
      JSON.stringify({
        id: "bad",
        board: board("Bad"),
        updatedAt: "2026-01-01T00:00:00.000Z",
        refresh: { cadenceMs: "soon" },
      }),
    );
    const record = await createFileLensStore(root).loadLens("bad");
    expect(record?.id).toBe("bad");
    expect(record?.refresh).toBeUndefined();
  });

  it("folds a fractional cadence to absent — the harness region schema requires an integer", async () => {
    await mkdir(join(root, "frac"), { recursive: true });
    await writeFile(
      join(root, "frac", "lens.json"),
      JSON.stringify({
        id: "frac",
        board: board("Frac"),
        updatedAt: "2026-01-01T00:00:00.000Z",
        refresh: { workflow: "chamber-lens-refresh", cadenceMs: 45_000.5 },
      }),
    );
    const record = await createFileLensStore(root).loadLens("frac");
    expect(record?.id).toBe("frac");
    // Degrades to a non-refreshing panel, not a region registration that throws
    // and takes the whole panel with it.
    expect(record?.refresh).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tool + action behavior through the real rib: refresh resolution on emit,
// the refresh-lens verb, and the HTML lens retire path.
// ---------------------------------------------------------------------------

let workspace: string;
let tools: ReturnType<NonNullable<typeof rib.registerTools>>;
let refreshCalls: { name: string; inputs?: Record<string, string> }[];

function makeCtx(sm: SnapshotManager): RibContext {
  return {
    getExec: () => ({
      runJSON: async () => ({ ok: true as const, data: undefined }),
      runText: async () => ({ ok: true as const, data: "" }),
    }),
    getSnapshotManager: () => sm,
    registerRegion: () => () => {},
    refreshWorkflow: async (name: string, inputs?: Record<string, string>) => {
      refreshCalls.push({ name, ...(inputs ? { inputs } : {}) });
    },
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

describe("living-lens emit + verbs", () => {
  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "chamber-living-lens-"));
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
    refreshCalls = [];
    tools = registerTools(makeCtx(fakeSnapshotManager()));
  });

  it("emit with refresh: {} takes the bundled default workflow", async () => {
    const t = makeToolCtx();
    await tool("chamber_emit_lens").execute(
      { id: "brief", board: board("Brief"), refresh: {} },
      t.ctx,
    );
    expect(t.errored()).toBe(false);
    const record = await createFileLensStore(lensesDir()).loadLens("brief");
    expect(record?.refresh).toEqual({ workflow: "chamber-lens-refresh" });
  });

  it("re-emit without refresh preserves the backing; refresh: null clears it", async () => {
    const store = createFileLensStore(lensesDir());
    const t1 = makeToolCtx();
    await tool("chamber_emit_lens").execute(
      { id: "brief", board: board("Brief"), refresh: { workflow: "my-refresh" } },
      t1.ctx,
    );
    // A refresh turn re-emits the board without repeating the config — the
    // backing must survive, or the first refresh would strip itself.
    const t2 = makeToolCtx();
    await tool("chamber_emit_lens").execute({ id: "brief", board: board("Brief 2") }, t2.ctx);
    expect((await store.loadLens("brief"))?.refresh).toEqual({ workflow: "my-refresh" });
    const t3 = makeToolCtx();
    await tool("chamber_emit_lens").execute(
      { id: "brief", board: board("Brief 3"), refresh: null },
      t3.ctx,
    );
    expect((await store.loadLens("brief"))?.refresh).toBeUndefined();
  });

  it("a refresh object PATCHES the prior backing — a partial re-author can't swap or drop fields", async () => {
    const store = createFileLensStore(lensesDir());
    const t1 = makeToolCtx();
    await tool("chamber_emit_lens").execute(
      {
        id: "brief",
        board: board("Brief"),
        refresh: { workflow: "osdu-refresh", cadenceMs: 3_600_000 },
      },
      t1.ctx,
    );
    // Naming a custom workflow earns a caveat: the harness seam is fail-soft, so
    // a missing workflow would otherwise be a silent no-op forever.
    expect(JSON.parse(t1.out()).note).toContain("osdu-refresh");
    // Cadence-only re-author keeps the bespoke workflow (not the bundled default).
    const t2 = makeToolCtx();
    await tool("chamber_emit_lens").execute(
      { id: "brief", board: board("Brief 2"), refresh: { cadenceMs: 600_000 } },
      t2.ctx,
    );
    expect((await store.loadLens("brief"))?.refresh).toEqual({
      workflow: "osdu-refresh",
      cadenceMs: 600_000,
    });
    // Workflow-only re-author keeps the cadence.
    const t3 = makeToolCtx();
    await tool("chamber_emit_lens").execute(
      { id: "brief", board: board("Brief 3"), refresh: { workflow: "other-refresh" } },
      t3.ctx,
    );
    expect((await store.loadLens("brief"))?.refresh).toEqual({
      workflow: "other-refresh",
      cadenceMs: 600_000,
    });
  });

  it("chamber_list_lenses returns boards only on a single-lens fetch", async () => {
    const t = makeToolCtx();
    await tool("chamber_emit_lens").execute({ id: "brief", board: board("Brief") }, t.ctx);
    await tool("chamber_emit_lens").execute({ id: "other", board: board("Other") }, t.ctx);
    const all = makeToolCtx();
    await tool("chamber_list_lenses").execute({}, all.ctx);
    const listed = JSON.parse(all.out()).lenses as { id: string; board?: unknown }[];
    expect(listed.map((l) => l.id).sort()).toEqual(["brief", "other"]);
    expect(listed.every((l) => l.board === undefined)).toBe(true);
    const one = makeToolCtx();
    await tool("chamber_list_lenses").execute({ id: "brief" }, one.ctx);
    const fetched = JSON.parse(one.out()).lenses as { id: string; board?: CanvasBoardView }[];
    expect(fetched).toHaveLength(1);
    // The refresh turn re-composes from this board — the record must carry it.
    expect(fetched[0]?.board?.title).toBe("Brief");
  });

  it("refresh-lens fires the record's workflow with the lens id as input", async () => {
    const t = makeToolCtx();
    await tool("chamber_emit_lens").execute(
      { id: "brief", board: board("Brief"), refresh: {} },
      t.ctx,
    );
    refreshCalls = [];
    const res = await onAction(
      { type: "refresh-lens", payload: { id: "brief" } },
      {} as RibContext,
    );
    expect(res.ok).toBe(true);
    expect(refreshCalls).toEqual([{ name: "chamber-lens-refresh", inputs: { lens: "brief" } }]);
  });

  it("refresh-lens refuses a plain lens, an exhibit, and a missing id — with steering", async () => {
    const store = createFileLensStore(lensesDir());
    await store.saveLens({ id: "plain", board: board("Plain") });
    await store.saveLens({ id: "verdict", board: board("Verdict"), kind: "exhibit" });
    const plain = await onAction(
      { type: "refresh-lens", payload: { id: "plain" } },
      {} as RibContext,
    );
    expect(plain.ok).toBe(false);
    if (!plain.ok) expect(plain.error).toContain("no refresh backing");
    const exhibit = await onAction(
      { type: "refresh-lens", payload: { id: "verdict" } },
      {} as RibContext,
    );
    expect(exhibit.ok).toBe(false);
    if (!exhibit.ok) expect(exhibit.error).toContain("exhibit");
    const missing = await onAction(
      { type: "refresh-lens", payload: { id: "ghost" } },
      {} as RibContext,
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain("not found");
    expect(refreshCalls).toEqual([]);
  });

  it("retire-lens-html deletes the persisted HTML lens; a second retire fails closed", async () => {
    await createFileHtmlLensStore(htmlLensesDir()).save({
      id: "designed",
      html: "<p>hi</p>",
      title: "Designed",
    });
    const res = await onAction(
      { type: "retire-lens-html", payload: { id: "designed" } },
      {} as RibContext,
    );
    expect(res.ok).toBe(true);
    expect(await createFileHtmlLensStore(htmlLensesDir()).load("designed")).toBeUndefined();
    const again = await onAction(
      { type: "retire-lens-html", payload: { id: "designed" } },
      {} as RibContext,
    );
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toContain("not found");
  });

  it("retire-lens-html releases a live panel whose record vanished, instead of stranding a ghost", async () => {
    const t = makeToolCtx();
    await tool("chamber_emit_lens_html").execute(
      { html: "<p>ghost</p>", id: "ghosty", title: "Ghosty" },
      t.ctx,
    );
    expect(t.errored()).toBe(false);
    // The record disappears out from under the live panel (external tamper).
    await createFileHtmlLensStore(htmlLensesDir()).delete("ghosty");
    const res = await onAction(
      { type: "retire-lens-html", payload: { id: "ghosty" } },
      {} as RibContext,
    );
    // The verb converges: the panel is released even though the delete found
    // nothing on disk — a second retire then has truly nothing to remove.
    expect(res.ok).toBe(true);
    const again = await onAction(
      { type: "retire-lens-html", payload: { id: "ghosty" } },
      {} as RibContext,
    );
    expect(again.ok).toBe(false);
  });
});
