import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stampExhibitSources, tabledExhibitsFor } from "../src/lens-runtime.ts";
import { createFileLensStore } from "../src/lens-store.ts";
import { lensesDir, setChamberDataHome } from "../src/paths.ts";
import type { Room } from "../src/types.ts";

const board = (title: string) => ({ view: "board" as const, title, sections: [] });

const ROOM: Room = {
  slug: "demo",
  name: "Sample Review",
  strategy: "sequential",
  participants: ["a", "b"],
  status: "active",
  turnBudget: 2,
  turnIndex: 0,
  round: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
};

let workspace: string;

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "chamber-tabled-"));
  setChamberDataHome(join(workspace, "chamber"));
});
afterAll(async () => {
  setChamberDataHome(undefined);
  await rm(workspace, { recursive: true, force: true });
});
beforeEach(async () => {
  await rm(lensesDir(), { recursive: true, force: true });
});

async function seed(id: string, kind: "lens" | "exhibit", sourceRoom?: string) {
  await createFileLensStore(lensesDir()).saveLens({
    id,
    board: board(id),
    kind,
    ...(sourceRoom ? { sourceRoom } : {}),
  });
}

// The stamp is fire-and-forget onto the lens write queue, so a test has to wait for it
// rather than assert straight after the call.
function settled(check: () => boolean, tries = 50): Promise<void> {
  return new Promise((resolve, reject) => {
    let n = 0;
    const tick = () => {
      if (check()) return resolve();
      if (++n > tries) return reject(new Error("stamp never settled"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe("tabledExhibitsFor", () => {
  test("returns only this room's exhibits — sourceRoom is the join key", async () => {
    await seed("mine", "exhibit", "demo");
    await seed("theirs", "exhibit", "other-room");
    const tabled = await tabledExhibitsFor("demo");
    expect(tabled.map((e) => e.id)).toEqual(["mine"]);
  });

  test("a lens never rides a room board, even stamped with its slug", async () => {
    // A lens is a standing view the operator authors; only exhibits are a room's
    // deliverable. The kind filter is what keeps the two shelves from re-crossing.
    await seed("standing", "lens", "demo");
    await seed("deliverable", "exhibit", "demo");
    expect((await tabledExhibitsFor("demo")).map((e) => e.id)).toEqual(["deliverable"]);
  });

  test("an unstamped exhibit belongs to no room", async () => {
    await seed("orphan", "exhibit");
    expect(await tabledExhibitsFor("demo")).toEqual([]);
  });

  test("a room that tabled nothing, and a lenses dir that does not exist, both yield none", async () => {
    await seed("theirs", "exhibit", "other-room");
    expect(await tabledExhibitsFor("demo")).toEqual([]);
    await rm(lensesDir(), { recursive: true, force: true });
    expect(await tabledExhibitsFor("demo")).toEqual([]);
  });
});

describe("stampExhibitSources — the republish hook", () => {
  test("republishes the stamped room, once for the batch", async () => {
    await seed("one", "exhibit");
    await seed("two", "exhibit");
    const republished: string[] = [];
    stampExhibitSources(["one", "two"], ROOM, async (slug) => {
      republished.push(slug);
    });
    await settled(() => republished.length > 0);
    // One republish for the whole batch, not one per id.
    expect(republished).toEqual(["demo"]);
    expect((await tabledExhibitsFor("demo")).map((e) => e.id).sort()).toEqual(["one", "two"]);
  });

  test("a stamp that changes nothing republishes nothing", async () => {
    // Already stamped: no write, so no board could have changed.
    await seed("one", "exhibit", "demo");
    const republished: string[] = [];
    stampExhibitSources(["one"], ROOM, async (slug) => {
      republished.push(slug);
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(republished).toEqual([]);
  });

  test("a failing republish never poisons the stamp", async () => {
    await seed("one", "exhibit");
    let called = false;
    stampExhibitSources(["one"], ROOM, async () => {
      called = true;
      throw new Error("publisher is gone");
    });
    await settled(() => called);
    // The stamp is the durable half; the republish is a courtesy on top of it.
    expect((await tabledExhibitsFor("demo")).map((e) => e.id)).toEqual(["one"]);
  });
});
