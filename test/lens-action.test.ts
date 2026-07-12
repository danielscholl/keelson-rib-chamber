import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RibContext, SnapshotManager } from "@keelson/shared";
import rib from "../src/index.ts";
import { createFileLensStore, listLenses } from "../src/lens-store.ts";
import { lensesDir, setChamberDataHome } from "../src/paths.ts";

const onAction = rib.onAction;
if (!onAction) throw new Error("rib is missing onAction");
const registerTools = rib.registerTools;
if (!registerTools) throw new Error("rib is missing registerTools");

const board = (title: string) => ({ view: "board" as const, title, sections: [] });

// A SnapshotManager double sufficient for the lens registry: register/recompose
// don't throw, so registerTools wires a real lensRegistry whose remove() the
// retire-lens action drives.
function fakeSnapshotManager(): SnapshotManager {
  const composers = new Map<string, () => unknown>();
  return {
    register(key: string, compose: () => unknown) {
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

// retireLensAction reads module singletons (the captured store/registry), not ctx,
// so a minimal ctx suffices for the onAction calls.
const actionCtx = {
  getExec: () => ({
    runJSON: async () => ({ ok: true as const, data: undefined }),
    runText: async () => ({ ok: true as const, data: "" }),
  }),
} as unknown as RibContext;

describe("author-lens onAction", () => {
  it("runs chamber-lens with the supplied subject and stays on the surface", async () => {
    const res = await onAction(
      { type: "author-lens", payload: { subject: "Architecture" } },
      actionCtx,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.data).toEqual({
      effect: "run-workflow",
      workflow: "chamber-lens",
      stay: true,
      args: "Architecture",
    });
  });

  it("fails closed on a missing subject", async () => {
    const res = await onAction({ type: "author-lens", payload: {} }, actionCtx);
    expect(res.ok).toBe(false);
    expect("error" in res && res.error).toMatch(/requires payload/);
  });
});

describe("retire-lens onAction", () => {
  let workspace: string;
  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "chamber-lens-action-"));
    setChamberDataHome(join(workspace, "chamber"));
  });
  afterAll(async () => {
    await rib.dispose?.();
    setChamberDataHome(undefined);
    await rm(workspace, { recursive: true, force: true });
  });
  beforeEach(async () => {
    // Fresh registry per test, on a clean on-disk slate: clear lenses/ before the
    // boot re-register runs so a prior test's lens can't be re-published (and
    // re-stamped) into this one.
    await rib.dispose?.();
    await rm(lensesDir(), { recursive: true, force: true });
    registerTools(makeCtx(fakeSnapshotManager()));
  });

  it("retires a lens: returns ok + { id, key } and removes it from disk", async () => {
    await createFileLensStore(lensesDir()).saveLens({ id: "alpha", board: board("Alpha") });
    const res = await onAction({ type: "retire-lens", payload: { id: "alpha" } }, actionCtx);
    expect(res).toEqual({ ok: true, data: { id: "alpha", key: "rib:chamber:lens:alpha" } });
    expect((await listLenses(lensesDir())).some((l) => l.id === "alpha")).toBe(false);
  });

  it("canonicalizes the payload id so the card's subject maps to the stored id", async () => {
    await createFileLensStore(lensesDir()).saveLens({ id: "release-risks", board: board("R") });
    const res = await onAction(
      { type: "retire-lens", payload: { id: "Release Risks" } },
      actionCtx,
    );
    expect(res.ok).toBe(true);
    expect((await listLenses(lensesDir())).some((l) => l.id === "release-risks")).toBe(false);
  });

  it("fails closed on a missing payload id", async () => {
    const res = await onAction({ type: "retire-lens", payload: {} }, actionCtx);
    expect(res.ok).toBe(false);
    expect("error" in res && res.error).toMatch(/requires payload/);
  });

  it("fails closed on an unknown id, surfacing not-found (no partial mutation)", async () => {
    await createFileLensStore(lensesDir()).saveLens({ id: "keep", board: board("Keep") });
    const res = await onAction({ type: "retire-lens", payload: { id: "ghost" } }, actionCtx);
    expect(res.ok).toBe(false);
    expect("error" in res && res.error).toMatch(/lens 'ghost' not found/);
    // The sibling is untouched.
    expect((await listLenses(lensesDir())).map((l) => l.id)).toEqual(["keep"]);
  });

  it("fails closed on an unsafe / unusable id", async () => {
    const res = await onAction({ type: "retire-lens", payload: { id: "!!!" } }, actionCtx);
    expect(res.ok).toBe(false);
    expect("error" in res && res.error).toMatch(/unsafe lens id/);
  });

  it("an unrouted action type still returns unknown action", async () => {
    const res = await onAction({ type: "not-a-verb" }, actionCtx);
    expect(res).toEqual({ ok: false, error: "unknown action 'not-a-verb'" });
  });
});

describe("lens-open onAction", () => {
  // lensOpenAction is pure — it reads only the payload id and returns the host
  // open-canvas effect over the live lens key. No store/registry, so the minimal
  // actionCtx suffices and no boot wiring is needed.
  it("returns the open-canvas effect over lensKey(id) so the host focuses the live lens", async () => {
    const res = await onAction({ type: "lens-open", payload: { id: "alpha" } }, actionCtx);
    expect(res).toEqual({
      ok: true,
      data: { effect: "open-canvas", key: "rib:chamber:lens:alpha", title: "alpha" },
    });
  });

  it("canonicalizes the payload id so the card's subject maps to the live key", async () => {
    const res = await onAction({ type: "lens-open", payload: { id: "Release Risks" } }, actionCtx);
    expect(res).toEqual({
      ok: true,
      data: {
        effect: "open-canvas",
        key: "rib:chamber:lens:release-risks",
        title: "release-risks",
      },
    });
  });

  it("fails closed on a missing payload id (no effect)", async () => {
    const res = await onAction({ type: "lens-open", payload: {} }, actionCtx);
    expect(res.ok).toBe(false);
    expect("error" in res && res.error).toMatch(/requires payload/);
  });

  it("fails closed on an unsafe / unusable id (no effect)", async () => {
    const res = await onAction({ type: "lens-open", payload: { id: "!!!" } }, actionCtx);
    expect(res.ok).toBe(false);
    expect("error" in res && res.error).toMatch(/unsafe lens id/);
  });
});

describe("lens-note onAction", () => {
  let workspace: string;
  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "chamber-lens-note-"));
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
    registerTools(makeCtx(fakeSnapshotManager()));
  });

  // Read the persisted board back through the store, the way the live panel would.
  const loadBoard = (id: string) => createFileLensStore(lensesDir()).loadLens(id);

  it("appends a note, creating a Notes rows section, and re-stamps the lens", async () => {
    await createFileLensStore(lensesDir()).saveLens({ id: "alpha", board: board("Alpha") });
    const res = await onAction(
      { type: "lens-note", payload: { id: "alpha", note: "first note" } },
      actionCtx,
    );
    expect(res).toEqual({ ok: true, data: { id: "alpha", key: "rib:chamber:lens:alpha" } });
    const rec = await loadBoard("alpha");
    expect(rec?.board.sections).toEqual([
      { kind: "rows", title: "Notes", items: [{ text: "first note" }] },
    ]);
  });

  it("accumulates successive notes in the one Notes section", async () => {
    await createFileLensStore(lensesDir()).saveLens({ id: "alpha", board: board("Alpha") });
    await onAction({ type: "lens-note", payload: { id: "alpha", note: "one" } }, actionCtx);
    await onAction({ type: "lens-note", payload: { id: "alpha", note: "two" } }, actionCtx);
    const rec = await loadBoard("alpha");
    expect(rec?.board.sections).toEqual([
      { kind: "rows", title: "Notes", items: [{ text: "one" }, { text: "two" }] },
    ]);
  });

  it("appends into an author-supplied Notes section rather than duplicating it", async () => {
    await createFileLensStore(lensesDir()).saveLens({
      id: "alpha",
      board: {
        view: "board",
        title: "Alpha",
        sections: [{ kind: "rows", title: "Notes", items: [{ text: "pre-existing" }] }],
      },
    });
    await onAction({ type: "lens-note", payload: { id: "alpha", note: "added" } }, actionCtx);
    const rec = await loadBoard("alpha");
    expect(rec?.board.sections).toEqual([
      { kind: "rows", title: "Notes", items: [{ text: "pre-existing" }, { text: "added" }] },
    ]);
  });

  it("preserves the lens's provenance across the write-back", async () => {
    await createFileLensStore(lensesDir()).saveLens({
      id: "alpha",
      board: board("Alpha"),
      scope: "status board",
      maintainingMind: "ada",
    });
    await onAction({ type: "lens-note", payload: { id: "alpha", note: "n" } }, actionCtx);
    const rec = await loadBoard("alpha");
    expect(rec?.scope).toBe("status board");
    expect(rec?.maintainingMind).toBe("ada");
  });

  it("canonicalizes the payload id so the card's subject maps to the stored lens", async () => {
    await createFileLensStore(lensesDir()).saveLens({ id: "release-risks", board: board("R") });
    const res = await onAction(
      { type: "lens-note", payload: { id: "Release Risks", note: "n" } },
      actionCtx,
    );
    expect(res.ok).toBe(true);
    const rec = await loadBoard("release-risks");
    expect(rec?.board.sections).toEqual([{ kind: "rows", title: "Notes", items: [{ text: "n" }] }]);
  });

  it("fails closed on a missing payload id", async () => {
    const res = await onAction({ type: "lens-note", payload: { note: "n" } }, actionCtx);
    expect(res.ok).toBe(false);
    expect("error" in res && res.error).toMatch(/requires payload/);
  });

  it("fails closed on a blank note (no mutation)", async () => {
    await createFileLensStore(lensesDir()).saveLens({ id: "alpha", board: board("Alpha") });
    const res = await onAction(
      { type: "lens-note", payload: { id: "alpha", note: "   " } },
      actionCtx,
    );
    expect(res.ok).toBe(false);
    expect("error" in res && res.error).toMatch(/non-empty note/);
    expect((await loadBoard("alpha"))?.board.sections).toEqual([]);
  });

  it("fails closed on an over-long note (no mutation)", async () => {
    await createFileLensStore(lensesDir()).saveLens({ id: "alpha", board: board("Alpha") });
    const res = await onAction(
      { type: "lens-note", payload: { id: "alpha", note: "x".repeat(501) } },
      actionCtx,
    );
    expect(res.ok).toBe(false);
    expect("error" in res && res.error).toMatch(/too long/);
    expect((await loadBoard("alpha"))?.board.sections).toEqual([]);
  });

  it("counts code points, not UTF-16 code units, against the length cap", async () => {
    await createFileLensStore(lensesDir()).saveLens({ id: "alpha", board: board("Alpha") });
    // 500 astral-plane code points = 1000 UTF-16 code units: a `.length` cap would
    // reject this, a code-point cap accepts it.
    const res = await onAction(
      { type: "lens-note", payload: { id: "alpha", note: "😀".repeat(500) } },
      actionCtx,
    );
    expect(res.ok).toBe(true);
  });

  it("serializes concurrent appends to the same lens so neither note is lost", async () => {
    await createFileLensStore(lensesDir()).saveLens({ id: "alpha", board: board("Alpha") });
    const [a, b] = await Promise.all([
      onAction({ type: "lens-note", payload: { id: "alpha", note: "one" } }, actionCtx),
      onAction({ type: "lens-note", payload: { id: "alpha", note: "two" } }, actionCtx),
    ]);
    expect(a.ok && b.ok).toBe(true);
    const section = (await loadBoard("alpha"))?.board.sections.find(
      (s) => s.kind === "rows" && s.title === "Notes",
    );
    const notes = section?.kind === "rows" ? section.items.map((i) => i.text).sort() : [];
    expect(notes).toEqual(["one", "two"]);
  });

  it("fails closed on an unknown lens, surfacing not-found", async () => {
    const res = await onAction(
      { type: "lens-note", payload: { id: "ghost", note: "n" } },
      actionCtx,
    );
    expect(res.ok).toBe(false);
    expect("error" in res && res.error).toMatch(/lens 'ghost' not found/);
  });

  it("fails closed on an unsafe / unusable id", async () => {
    const res = await onAction({ type: "lens-note", payload: { id: "!!!", note: "n" } }, actionCtx);
    expect(res.ok).toBe(false);
    expect("error" in res && res.error).toMatch(/unsafe lens id/);
  });
});

describe("boot lens re-registration", () => {
  let workspace: string;
  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "chamber-lens-boot-"));
    setChamberDataHome(join(workspace, "chamber"));
  });
  afterAll(async () => {
    await rib.dispose?.();
    setChamberDataHome(undefined);
    await rm(workspace, { recursive: true, force: true });
  });

  // Poll until the snapshot key appears (boot reconcile is fire-and-forget) — a
  // condition wait instead of an arbitrary sleep, so a slow runner can't flake.
  async function waitForKey(sm: { keys(): readonly string[] }, key: string): Promise<void> {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (sm.keys().includes(key)) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`snapshot key ${key} never appeared within 2000ms`);
  }

  it("re-publishes every persisted lens on boot so its snapshot key survives a restart", async () => {
    // Seed two lenses on disk (as if authored in a prior process), then boot.
    const store = createFileLensStore(lensesDir());
    await store.saveLens({ id: "persisted-a", board: board("A") });
    await store.saveLens({ id: "persisted-b", board: board("B") });

    await rib.dispose?.();
    const sm = fakeSnapshotManager();
    registerTools(makeCtx(sm));
    await waitForKey(sm, "rib:chamber:lens:persisted-a");
    await waitForKey(sm, "rib:chamber:lens:persisted-b");
  });

  it("preserves a persisted lens's authored updatedAt across boot (no re-stamp)", async () => {
    // Seed a lens.json directly with a fixed PAST updatedAt — saveLens would stamp
    // "now", so write the record by hand — then boot. Re-registration must re-establish
    // the live key WITHOUT rewriting the record, preserving authored freshness.
    const authored = "2026-01-01T00:00:00.000Z";
    await mkdir(join(lensesDir(), "vintage"), { recursive: true });
    await writeFile(
      join(lensesDir(), "vintage", "lens.json"),
      JSON.stringify({ id: "vintage", board: board("Vintage"), updatedAt: authored }),
    );

    await rib.dispose?.();
    const sm = fakeSnapshotManager();
    registerTools(makeCtx(sm));
    // Wait for reconcile to actually re-register before checking the record, so the
    // test proves reregister ran and did NOT re-stamp (not just that nothing ran yet).
    await waitForKey(sm, "rib:chamber:lens:vintage");

    const rec = (await listLenses(lensesDir())).find((l) => l.id === "vintage");
    expect(rec?.updatedAt).toBe(authored);
  });

  it("re-registers cleanly even when a corrupt record is present (fail-soft per entry)", async () => {
    const store = createFileLensStore(lensesDir());
    await store.saveLens({ id: "good-lens", board: board("Good") });
    // A corrupt lens.json alongside the good one — listLenses skips it.
    await mkdir(join(lensesDir(), "corrupt"), { recursive: true });
    await writeFile(join(lensesDir(), "corrupt", "lens.json"), "{ not json");

    await rib.dispose?.();
    const sm = fakeSnapshotManager();
    registerTools(makeCtx(sm));
    await waitForKey(sm, "rib:chamber:lens:good-lens");

    // The valid lens re-registered (waitForKey above); the corrupt one never publishes.
    expect(sm.keys()).not.toContain("rib:chamber:lens:corrupt");
  });
});
