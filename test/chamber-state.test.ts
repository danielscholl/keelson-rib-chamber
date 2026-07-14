import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanvasBoardView } from "@keelson/shared";
import {
  buildChamberState,
  buildDigestSource,
  type ChamberState,
  chamberFingerprint,
  diffAgainstWatermark,
  hasDigestContent,
  reduceChamberState,
} from "../src/chamber-state.ts";
import { createFileLensStore, type LensRecord } from "../src/lens-store.ts";
import { scaffoldMind } from "../src/minds-store.ts";
import { createFileRoomStore } from "../src/room-store.ts";
import type { Mind, Room } from "../src/types.ts";
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
      exhibitCount: 0,
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
    exhibitCount: 0,
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

describe("chamberFingerprint", () => {
  const mind = (slug: string): Mind => ({ slug, name: slug, role: "r", persona: "p" });
  const lens = (id: string, updatedAt: string): LensRecord => ({ id, board, updatedAt });

  test("is stable for the same records", () => {
    const minds = [mind("ada")];
    const rooms = [makeRoom({ slug: "r1", status: "done" })];
    const lenses = [lens("a", "t1")];
    expect(chamberFingerprint(minds, rooms, lenses)).toBe(chamberFingerprint(minds, rooms, lenses));
  });

  test("is order-independent across Minds, rooms, and lenses", () => {
    const a = chamberFingerprint(
      [mind("ada"), mind("bo")],
      [makeRoom({ slug: "r1", status: "done" }), makeRoom({ slug: "r2", status: "active" })],
      [lens("x", "t1"), lens("y", "t2")],
    );
    const b = chamberFingerprint(
      [mind("bo"), mind("ada")],
      [makeRoom({ slug: "r2", status: "active" }), makeRoom({ slug: "r1", status: "done" })],
      [lens("y", "t2"), lens("x", "t1")],
    );
    expect(a).toBe(b);
  });

  test("a Mind swap with the SAME count changes the fingerprint (identity, not counts)", () => {
    // The cost-gate regression guard: retiring one Mind and creating another keeps the
    // count at 1 but must still re-author — so the fingerprint keys on slugs, not counts.
    expect(chamberFingerprint([mind("alice")], [], [])).not.toBe(
      chamberFingerprint([mind("bob")], [], []),
    );
  });

  test("a rename (same slug, different name) changes the fingerprint — the rendered name", () => {
    // buildDigestSource shows the name, so a slug-stable rename must re-author rather than
    // leave a stale name in the digest (no rename path exists today, but the fingerprint
    // captures everything rendered so a future one stays correct).
    const before: Mind = { slug: "ada", name: "Ada", role: "r", persona: "p" };
    const after: Mind = { slug: "ada", name: "Ada Lovelace", role: "r", persona: "p" };
    expect(chamberFingerprint([before], [], [])).not.toBe(chamberFingerprint([after], [], []));
  });

  test("an active room swapped for a different active room changes the fingerprint", () => {
    expect(chamberFingerprint([], [makeRoom({ slug: "r1", status: "active" })], [])).not.toBe(
      chamberFingerprint([], [makeRoom({ slug: "r2", status: "active" })], []),
    );
  });

  test("a room going active -> ended changes the fingerprint", () => {
    expect(chamberFingerprint([], [makeRoom({ slug: "r1", status: "active" })], [])).not.toBe(
      chamberFingerprint([], [makeRoom({ slug: "r1", status: "done" })], []),
    );
  });

  test("a lens whose updatedAt advanced changes the fingerprint", () => {
    expect(chamberFingerprint([], [], [lens("a", "t1")])).not.toBe(
      chamberFingerprint([], [], [lens("a", "t2")]),
    );
  });

  test("ignores per-turn churn — rooms differing only in turnIndex match", () => {
    // The cost floor: a live room's turnIndex advances every turn but must NOT re-author.
    expect(
      chamberFingerprint([], [makeRoom({ slug: "live", status: "active", turnIndex: 1 })], []),
    ).toBe(
      chamberFingerprint([], [makeRoom({ slug: "live", status: "active", turnIndex: 99 })], []),
    );
  });
});

describe("hasDigestContent", () => {
  const state = (over: Partial<ChamberState> = {}): ChamberState => ({
    mindCount: 0,
    activeRoomCount: 0,
    endedRoomSlugs: [],
    liveLensCount: 0,
    exhibitCount: 0,
    lensFingerprints: {},
    ...over,
  });

  test("an empty chamber has no content (so the gate withholds a paid turn)", () => {
    expect(hasDigestContent(state())).toBe(false);
  });

  test("any of active rooms / ended rooms / lenses / exhibits counts as content", () => {
    expect(hasDigestContent(state({ activeRoomCount: 1 }))).toBe(true);
    expect(hasDigestContent(state({ endedRoomSlugs: ["r1"] }))).toBe(true);
    expect(hasDigestContent(state({ liveLensCount: 1 }))).toBe(true);
    expect(hasDigestContent(state({ exhibitCount: 1 }))).toBe(true);
  });

  test("Minds alone are NOT content — a bench that has produced nothing has no shape", () => {
    // The digest prompt forbids restating counts, so a minds-only chamber leaves the
    // author nothing true to say; paying a turn for it buys atmosphere.
    expect(hasDigestContent(state({ mindCount: 5 }))).toBe(false);
    // But they ride along once the bench has actually produced something.
    expect(hasDigestContent(state({ mindCount: 5, endedRoomSlugs: ["r1"] }))).toBe(true);
  });
});

describe("buildDigestSource", () => {
  const mind = (name: string): Mind => ({
    slug: name.toLowerCase(),
    name,
    role: "r",
    persona: "p",
  });
  const lens = (id: string, title: string): LensRecord => ({
    id,
    board: { view: "board", title, sections: [] },
    updatedAt: "t1",
  });

  test("names the Minds, active/ended rooms, and lenses on disk", () => {
    const summary = buildDigestSource(
      [mind("Ada"), mind("Bo")],
      [
        makeRoom({ slug: "live", name: "Standup", status: "active" }),
        makeRoom({ slug: "retro", name: "Retro", status: "done" }),
      ],
      [lens("release-risks", "Release Risks")],
    );
    expect(summary).toContain("Minds (2): Ada, Bo");
    expect(summary).toContain("Active rooms (1): Standup");
    expect(summary).toContain("Ended rooms (1): Retro (done)");
    expect(summary).toContain("Lenses (1): Release Risks");
  });

  test("an empty chamber reads as 'none' in every category (honest, no fabrication)", () => {
    const summary = buildDigestSource([], [], []);
    expect(summary).toContain("Minds (0): none");
    expect(summary).toContain("Active rooms (0): none");
    expect(summary).toContain("Ended rooms (0): none");
    expect(summary).toContain("Lenses (0): none");
  });
});

describe("reduceChamberState", () => {
  test("reduces records the same way buildChamberState does (pure, no IO)", () => {
    const result = reduceChamberState(
      [{ slug: "ada", name: "Ada", role: "r", persona: "p" }],
      [makeRoom({ slug: "live", status: "active" }), makeRoom({ slug: "done", status: "done" })],
      [{ id: "f", board, updatedAt: "t1" }],
    );
    expect(result.mindCount).toBe(1);
    expect(result.activeRoomCount).toBe(1);
    expect(result.endedRoomSlugs).toEqual(["done"]);
    expect(result.liveLensCount).toBe(1);
    expect(result.lensFingerprints).toEqual({ f: "t1" });
  });
});
