import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileHtmlLensStore, listHtmlLenses } from "../src/lens-html-store.ts";

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// Seed a lens dir directly (bypassing save) so a test can craft a specific
// updatedAt / shape / id-mismatch the store would otherwise stamp itself.
async function seedHtmlLens(
  root: string,
  dir: string,
  meta: unknown,
  html?: string,
): Promise<void> {
  await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, dir, "meta.json"), JSON.stringify(meta));
  if (html !== undefined) await writeFile(join(root, dir, "lens.html"), html);
}

describe("createFileHtmlLensStore", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "chamber-lenses-html-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("round-trips a lens (lens.html + meta.json), creating the tree on first write", async () => {
    const store = createFileHtmlLensStore(root);
    await store.save({ id: "findings", html: "<h1>Findings</h1>", title: "Findings" });
    const rec = await store.load("findings");
    expect(rec?.id).toBe("findings");
    expect(rec?.html).toBe("<h1>Findings</h1>");
    expect(rec?.title).toBe("Findings");
    expect(await pathExists(join(root, "findings", "lens.html"))).toBe(true);
    expect(await pathExists(join(root, "findings", "meta.json"))).toBe(true);
    // lens.html carries the raw markup, not a JSON encoding of it.
    expect(await readFile(join(root, "findings", "lens.html"), "utf8")).toBe("<h1>Findings</h1>");
  });

  it("stamps updatedAt server-side at save and leaves title absent when omitted", async () => {
    const store = createFileHtmlLensStore(root);
    await store.save({ id: "x", html: "<p>x</p>" });
    const rec = await store.load("x");
    expect(Number.isFinite(Date.parse(rec?.updatedAt ?? ""))).toBe(true);
    expect(rec && "title" in rec).toBe(false);
  });

  it("re-saving the same id overwrites in place, advancing updatedAt", async () => {
    const store = createFileHtmlLensStore(root);
    await store.save({ id: "x", html: "<p>first</p>" });
    // Backdate the stored meta so the next save's now() is strictly later.
    await seedHtmlLens(root, "x", { id: "x", updatedAt: "2000-01-01T00:00:00.000Z" });
    await store.save({ id: "x", html: "<p>second</p>" });
    const all = await listHtmlLenses(root);
    expect(all).toHaveLength(1);
    expect(all[0]?.html).toBe("<p>second</p>");
    expect(Date.parse(all[0]?.updatedAt ?? "")).toBeGreaterThan(
      Date.parse("2000-01-01T00:00:00.000Z"),
    );
  });

  it("rejects a path-traversal id on save and load (FS boundary)", async () => {
    const store = createFileHtmlLensStore(root);
    await expect(store.save({ id: "../escape", html: "<p>x</p>" })).rejects.toThrow();
    await expect(store.load("../escape")).rejects.toThrow();
  });

  it("load degrades to undefined on a missing lens or an id that drifted from its dir", async () => {
    const store = createFileHtmlLensStore(root);
    expect(await store.load("ghost")).toBeUndefined();
    await seedHtmlLens(root, "drifted", { id: "other", updatedAt: new Date().toISOString() }, "x");
    expect(await store.load("drifted")).toBeUndefined();
  });
});

describe("listHtmlLenses", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "chamber-lenses-html-list-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns [] for a missing root (ENOENT degrades, no throw)", async () => {
    expect(await listHtmlLenses(join(root, "never-created"))).toEqual([]);
  });

  it("lists newest-first by updatedAt", async () => {
    await seedHtmlLens(
      root,
      "old",
      { id: "old", updatedAt: "2020-01-01T00:00:00.000Z" },
      "<p>o</p>",
    );
    await seedHtmlLens(
      root,
      "new",
      { id: "new", updatedAt: "2026-01-01T00:00:00.000Z" },
      "<p>n</p>",
    );
    expect((await listHtmlLenses(root)).map((l) => l.id)).toEqual(["new", "old"]);
  });

  it("skips corrupt meta, missing html, empty html, and bad dates (fail-soft per entry)", async () => {
    const at = new Date().toISOString();
    await seedHtmlLens(root, "good", { id: "good", updatedAt: at }, "<p>g</p>");
    await mkdir(join(root, "corrupt"), { recursive: true });
    await writeFile(join(root, "corrupt", "meta.json"), "{ not json");
    await writeFile(join(root, "corrupt", "lens.html"), "<p>c</p>");
    await seedHtmlLens(root, "html-less", { id: "html-less", updatedAt: at });
    await seedHtmlLens(root, "empty", { id: "empty", updatedAt: at }, "");
    await seedHtmlLens(root, "bad-date", { id: "bad-date", updatedAt: "yesterday" }, "<p>b</p>");
    expect((await listHtmlLenses(root)).map((l) => l.id)).toEqual(["good"]);
  });
});
