import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanvasBoardView } from "@keelson/shared";
import { createFileLensStore, type LensRecord, listLenses } from "../src/lens-store.ts";

const board = (title: string): CanvasBoardView => ({ view: "board", title, sections: [] });

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// Seed a lens.json directly (bypassing saveLens) so a test can craft a specific
// updatedAt / shape / id-mismatch the store would otherwise stamp itself.
async function seedLens(root: string, dir: string, record: unknown): Promise<void> {
  await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, dir, "lens.json"), JSON.stringify(record));
}

describe("createFileLensStore", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "chamber-lenses-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("round-trips a lens, creating the lenses tree on first write", async () => {
    const store = createFileLensStore(root);
    await store.saveLens({ id: "findings", board: board("Findings") });
    const [rec] = await listLenses(root);
    expect(rec?.id).toBe("findings");
    expect(rec?.board).toEqual(board("Findings"));
    expect(await pathExists(join(root, "findings", "lens.json"))).toBe(true);
  });

  it("stamps updatedAt server-side at save (caller passes only id + board)", async () => {
    const store = createFileLensStore(root);
    await store.saveLens({ id: "x", board: board("X") });
    const [rec] = await listLenses(root);
    expect(rec?.updatedAt).toBeDefined();
    expect(Number.isFinite(Date.parse(rec?.updatedAt ?? ""))).toBe(true);
  });

  it("re-emitting the same id overwrites in place, advancing updatedAt", async () => {
    const store = createFileLensStore(root);
    await store.saveLens({ id: "x", board: board("First") });
    const first = (await listLenses(root))[0]?.updatedAt ?? "";
    // Backdate the stored record so the next save's now() is strictly later, even
    // on a fast clock (the test asserts advancement, not just inequality).
    await seedLens(root, "x", {
      id: "x",
      board: board("First"),
      updatedAt: "2000-01-01T00:00:00.000Z",
    });
    await store.saveLens({ id: "x", board: board("Second") });
    const after = await listLenses(root);
    expect(after).toHaveLength(1); // one record, not two
    expect(after[0]?.board).toEqual(board("Second"));
    expect(Date.parse(after[0]?.updatedAt ?? "")).toBeGreaterThan(
      Date.parse("2000-01-01T00:00:00.000Z"),
    );
    expect(first).toBeTruthy();
  });

  it("rejects a path-traversal id on save and delete (FS boundary)", async () => {
    const store = createFileLensStore(root);
    await expect(store.saveLens({ id: "../escape", board: board("X") })).rejects.toThrow();
    await expect(store.deleteLens("../escape")).rejects.toThrow();
  });

  it("persists a pretty-printed JSON record (matches the room-store on-disk shape)", async () => {
    const store = createFileLensStore(root);
    await store.saveLens({ id: "x", board: board("X") });
    const raw = await readFile(join(root, "x", "lens.json"), "utf8");
    const parsed = JSON.parse(raw) as LensRecord;
    expect(parsed.id).toBe("x");
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("round-trips provenance (scope / maintainingMind / reason) alongside the board", async () => {
    const store = createFileLensStore(root);
    await store.saveLens({
      id: "findings",
      board: board("Findings"),
      scope: "status board",
      maintainingMind: "ada",
      reason: "added two risks",
    });
    const [rec] = await listLenses(root);
    expect(rec?.scope).toBe("status board");
    expect(rec?.maintainingMind).toBe("ada");
    expect(rec?.reason).toBe("added two risks");
  });

  it("omitted provenance stays absent — no undefined keys leak to disk", async () => {
    const store = createFileLensStore(root);
    await store.saveLens({ id: "bare", board: board("Bare") });
    const [rec] = await listLenses(root);
    expect(rec?.scope).toBeUndefined();
    expect(rec?.maintainingMind).toBeUndefined();
    expect(rec?.reason).toBeUndefined();
    // JSON.stringify drops undefined, so the keys are truly absent on disk.
    const raw = await readFile(join(root, "bare", "lens.json"), "utf8");
    expect(raw).not.toContain("scope");
    expect(raw).not.toContain("maintainingMind");
    expect(raw).not.toContain("reason");
  });
});

describe("deleteLens", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "chamber-lenses-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("removes a lens's dir; a sibling lens is untouched", async () => {
    const store = createFileLensStore(root);
    await store.saveLens({ id: "gone", board: board("Gone") });
    await store.saveLens({ id: "keep", board: board("Keep") });

    await store.deleteLens("gone");

    expect(await pathExists(join(root, "gone"))).toBe(false);
    expect((await listLenses(root)).map((l) => l.id)).toEqual(["keep"]);
  });

  it("throws 'lens <id> not found' for an unknown lens (not a silent no-op)", async () => {
    const store = createFileLensStore(root);
    await expect(store.deleteLens("nope")).rejects.toThrow(/lens 'nope' not found/);
  });

  it("runs assertSafeSlug first: a traversal id rejects before touching the FS", async () => {
    const store = createFileLensStore(root);
    await expect(store.deleteLens("../escape")).rejects.toThrow();
  });

  it("has no active-guard: a lens is always retireable (unlike a live room)", async () => {
    const store = createFileLensStore(root);
    await store.saveLens({ id: "live", board: board("Live") });
    // No room-like "active" refusal — deleteLens always removes.
    await expect(store.deleteLens("live")).resolves.toBeUndefined();
    expect(await pathExists(join(root, "live"))).toBe(false);
  });
});

describe("listLenses", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "chamber-lenses-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns one record per dir, newest-first by updatedAt", async () => {
    await seedLens(root, "old", {
      id: "old",
      board: board("Old"),
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await seedLens(root, "new", {
      id: "new",
      board: board("New"),
      updatedAt: "2026-03-01T00:00:00.000Z",
    });
    await seedLens(root, "mid", {
      id: "mid",
      board: board("Mid"),
      updatedAt: "2026-02-01T00:00:00.000Z",
    });
    expect((await listLenses(root)).map((l) => l.id)).toEqual(["new", "mid", "old"]);
  });

  it("breaks updatedAt ties deterministically, newest id first", async () => {
    const at = "2026-02-02T00:00:00.000Z";
    await seedLens(root, "tie-a", { id: "tie-a", board: board("A"), updatedAt: at });
    await seedLens(root, "tie-c", { id: "tie-c", board: board("C"), updatedAt: at });
    await seedLens(root, "tie-b", { id: "tie-b", board: board("B"), updatedAt: at });
    expect((await listLenses(root)).map((l) => l.id)).toEqual(["tie-c", "tie-b", "tie-a"]);
  });

  it("skips non-dirs, unsafe ids, id-mismatched, unparseable, and bad-date records", async () => {
    await seedLens(root, "good", {
      id: "good",
      board: board("Good"),
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    // Loose file (not a dir).
    await writeFile(join(root, "loose.txt"), "not a lens dir");
    // Unsafe directory name (assertSafeSlug rejects).
    await seedLens(root, "Bad_Slug", {
      id: "Bad_Slug",
      board: board("Bad"),
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    // lens.json whose id disagrees with its dir (dir name is authoritative).
    await seedLens(root, "mismatch", {
      id: "other",
      board: board("M"),
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    // Unparseable lens.json.
    await mkdir(join(root, "bad-json"), { recursive: true });
    await writeFile(join(root, "bad-json", "lens.json"), "{ not json");
    // Valid shape but an unparseable updatedAt.
    await seedLens(root, "bad-date", {
      id: "bad-date",
      board: board("D"),
      updatedAt: "not-a-date",
    });

    expect((await listLenses(root)).map((l) => l.id)).toEqual(["good"]);
  });

  it("skips a wrong-shape record (null board, missing fields) — can't blank the index", async () => {
    await seedLens(root, "good", {
      id: "good",
      board: board("Good"),
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await seedLens(root, "null-board", {
      id: "null-board",
      board: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await seedLens(root, "no-view", {
      id: "no-view",
      board: { title: "X" },
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect((await listLenses(root)).map((l) => l.id)).toEqual(["good"]);
  });

  it("ENOENT (missing lenses root) → []", async () => {
    expect(await listLenses(join(root, "missing"))).toEqual([]);
  });

  it("empty lenses root → []", async () => {
    const empty = join(root, "empty");
    await mkdir(empty);
    expect(await listLenses(empty)).toEqual([]);
  });
});
