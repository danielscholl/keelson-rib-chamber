import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteRoomExhibits, stampExhibitSources, tabledExhibitsFor } from "../src/lens-runtime.ts";
import { createFileLensStore, listLenses } from "../src/lens-store.ts";
import { lensesDir, setChamberDataHome } from "../src/paths.ts";
import type { Room } from "../src/types.ts";

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

const board = (title: string) => ({ view: "board" as const, title, sections: [] });

let workspace: string;

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "chamber-cascade-"));
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

const idsOnDisk = async () => (await listLenses(lensesDir())).map((r) => r.id).sort();

describe("deleteRoomExhibits", () => {
  test("removes exactly the room's exhibits and reports them", async () => {
    await seed("verdict", "exhibit", "demo");
    await seed("plan", "exhibit", "demo");

    expect((await deleteRoomExhibits("demo")).sort()).toEqual(["plan", "verdict"]);
    expect(await idsOnDisk()).toEqual([]);
  });

  test("another room's exhibit survives — sourceRoom is the safety property", async () => {
    await seed("mine", "exhibit", "demo");
    await seed("theirs", "exhibit", "other-room");

    expect(await deleteRoomExhibits("demo")).toEqual(["mine"]);
    expect(await idsOnDisk()).toEqual(["theirs"]);
    expect((await tabledExhibitsFor("other-room")).map((e) => e.id)).toEqual(["theirs"]);
  });

  test("a standing lens is never collateral, even stamped with the room's slug", async () => {
    // Only exhibits are a room's children. A lens is the operator's standing view and
    // outlives any room that happened to touch it.
    await seed("standing", "lens", "demo");
    await seed("deliverable", "exhibit", "demo");

    expect(await deleteRoomExhibits("demo")).toEqual(["deliverable"]);
    expect(await idsOnDisk()).toEqual(["standing"]);
  });

  test("an unstamped exhibit belongs to no room and is left alone", async () => {
    // Orphans are reachable only through chamber_list_exhibits / chamber_delete_exhibit;
    // a cascade must not sweep them just because they have no room.
    await seed("orphan", "exhibit");

    expect(await deleteRoomExhibits("demo")).toEqual([]);
    expect(await idsOnDisk()).toEqual(["orphan"]);
  });

  test("a room that tabled nothing deletes cleanly", async () => {
    await seed("theirs", "exhibit", "other-room");
    expect(await deleteRoomExhibits("demo")).toEqual([]);
    expect(await idsOnDisk()).toEqual(["theirs"]);
  });

  test("an empty lenses dir is not an error", async () => {
    await rm(lensesDir(), { recursive: true, force: true });
    expect(await deleteRoomExhibits("demo")).toEqual([]);
  });

  test("a second cascade finds nothing to do", async () => {
    await seed("verdict", "exhibit", "demo");
    expect(await deleteRoomExhibits("demo")).toEqual(["verdict"]);
    expect(await deleteRoomExhibits("demo")).toEqual([]);
  });

  test("an exhibit deleted before the cascade runs leaves its siblings to be cascaded", async () => {
    await seed("already-gone", "exhibit", "demo");
    await seed("survivor", "exhibit", "demo");
    await createFileLensStore(lensesDir()).deleteLens("already-gone");

    expect(await deleteRoomExhibits("demo")).toEqual(["survivor"]);
    expect(await idsOnDisk()).toEqual([]);
  });

  test("a stamp racing the cascade cannot resurrect the exhibit it deleted", async () => {
    // The reason the cascade rides the lens write queue: stampExhibitSources does
    // loadLens -> saveLens, and saveLens mkdirs, so a delete landing between the two
    // recreates the record. Queued, the stamp lands first and the cascade sees its write.
    // Unqueued, the cascade reads the pre-stamp sourceRoom, matches nothing, and the
    // stamp then writes the record back — a permanent orphan of a deleted room.
    await seed("verdict", "exhibit", "other");
    stampExhibitSources(["verdict"], ROOM);
    expect(await deleteRoomExhibits("demo")).toEqual(["verdict"]);
    expect(await idsOnDisk()).toEqual([]);
  });
});
