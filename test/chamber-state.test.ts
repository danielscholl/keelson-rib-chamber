import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanvasBoardView } from "@keelson/shared";
import {
  buildChamberState,
  type ChamberState,
  diffAgainstWatermark,
} from "../src/chamber-state.ts";
import { createFileLensStore } from "../src/lens-store.ts";
import { scaffoldMind } from "../src/minds-store.ts";
import { createFileRoomStore } from "../src/room-store.ts";
import type { Room } from "../src/types.ts";
import type { Watermark } from "../src/watermark-store.ts";

const board: CanvasBoardView = { view: "board", title: "x", sections: [] };

function makeRoom(over: Partial<Room>): Room {
  return {
    slug: "room",
    name: "Room",
    strategy: "sequential",
    participants: ["a", "b"],
    status: "active",
    turnBudget: 4,
    turnIndex: 0,
    round: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function emptyWatermark(over: Partial<Watermark> = {}): Watermark {
  return {
    ackedEndedRooms: [],
    lensFingerprints: {},
    briefPromoted: false,
    updatedAt: "",
    ...over,
  };
}

describe("buildChamberState", () => {
  let home: string;
  let dirs: { mindsDir: string; roomsDir: string; lensesDir: string };
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "chamber-state-"));
    dirs = {
      mindsDir: join(home, "minds"),
      roomsDir: join(home, "rooms"),
      lensesDir: join(home, "lenses"),
    };
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  async function seedMind(slug: string): Promise<void> {
    await scaffoldMind(
      dirs.mindsDir,
      {
        slug,
        name: slug,
        role: "r",
        voice: "v",
        persona: `I am ${slug}.`,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      `soul ${slug}`,
    );
  }

  test("an empty data home reads as all-zero", async () => {
    const state = await buildChamberState(dirs);
    expect(state).toEqual({
      mindCount: 0,
      activeRoomCount: 0,
      endedRoomSlugs: [],
      liveLensCount: 0,
      lensFingerprints: {},
    });
  });

  test("counts minds, splits active vs ended rooms, and fingerprints lenses", async () => {
    await seedMind("ada");
    await seedMind("bo");
    const rooms = createFileRoomStore(dirs.roomsDir);
    await rooms.saveRoom(makeRoom({ slug: "live", status: "active" }));
    await rooms.saveRoom(makeRoom({ slug: "done", status: "done" }));
    await rooms.saveRoom(makeRoom({ slug: "stopped", status: "stopped" }));
    const lenses = createFileLensStore(dirs.lensesDir);
    await lenses.saveLens({ id: "findings", board });

    const state = await buildChamberState(dirs);
    expect(state.mindCount).toBe(2);
    expect(state.activeRoomCount).toBe(1);
    expect([...state.endedRoomSlugs].sort()).toEqual(["done", "stopped"]);
    expect(state.liveLensCount).toBe(1);
    expect(typeof state.lensFingerprints.findings).toBe("string");
  });
});

describe("diffAgainstWatermark", () => {
  const state = (over: Partial<ChamberState> = {}): ChamberState => ({
    mindCount: 2,
    activeRoomCount: 0,
    endedRoomSlugs: [],
    liveLensCount: 0,
    lensFingerprints: {},
    ...over,
  });

  test("cold start (empty watermark) treats every ended room + lens as new", () => {
    const s = state({
      endedRoomSlugs: ["r1", "r2"],
      lensFingerprints: { a: "t1", b: "t2" },
    });
    const delta = diffAgainstWatermark(s, emptyWatermark());
    expect(delta.newlyEndedRooms.sort()).toEqual(["r1", "r2"]);
    expect(delta.changedOrNewLenses.sort()).toEqual(["a", "b"]);
    expect(delta.hasSubstance).toBe(true);
  });

  test("an acked ended room is not new", () => {
    const s = state({ endedRoomSlugs: ["r1", "r2"] });
    const delta = diffAgainstWatermark(s, emptyWatermark({ ackedEndedRooms: ["r1"] }));
    expect(delta.newlyEndedRooms).toEqual(["r2"]);
  });

  test("a lens whose updatedAt advanced is changed", () => {
    const s = state({ lensFingerprints: { a: "t2" } });
    const delta = diffAgainstWatermark(s, emptyWatermark({ lensFingerprints: { a: "t1" } }));
    expect(delta.changedOrNewLenses).toEqual(["a"]);
    expect(delta.hasSubstance).toBe(true);
  });

  test("a lens with an unchanged updatedAt is NOT substance", () => {
    const s = state({ lensFingerprints: { a: "t1" } });
    const delta = diffAgainstWatermark(s, emptyWatermark({ lensFingerprints: { a: "t1" } }));
    expect(delta.changedOrNewLenses).toEqual([]);
    expect(delta.hasSubstance).toBe(false);
  });

  test("a brand-new lens id is changed", () => {
    const s = state({ lensFingerprints: { a: "t1", b: "t1" } });
    const delta = diffAgainstWatermark(s, emptyWatermark({ lensFingerprints: { a: "t1" } }));
    expect(delta.changedOrNewLenses).toEqual(["b"]);
  });

  test("a RETIRED lens (in the watermark, absent now) is NOT substance", () => {
    // Nothing currently live, but the watermark remembers a lens that's gone — a
    // retire alone must never promote the briefing.
    const s = state({ lensFingerprints: {} });
    const delta = diffAgainstWatermark(s, emptyWatermark({ lensFingerprints: { gone: "t1" } }));
    expect(delta.changedOrNewLenses).toEqual([]);
    expect(delta.hasSubstance).toBe(false);
  });

  test("fully acked state has no substance", () => {
    const s = state({ endedRoomSlugs: ["r1"], lensFingerprints: { a: "t1" } });
    const delta = diffAgainstWatermark(
      s,
      emptyWatermark({ ackedEndedRooms: ["r1"], lensFingerprints: { a: "t1" } }),
    );
    expect(delta.hasSubstance).toBe(false);
  });
});
