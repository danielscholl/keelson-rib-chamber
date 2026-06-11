import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { access, appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileRoomStore, sweepClosedRooms } from "../src/room-store.ts";
import type { Room, TurnEntry } from "../src/types.ts";

function makeRoom(over: Partial<Room> = {}): Room {
  return {
    slug: "room",
    name: "Room",
    strategy: "sequential",
    participants: ["alice", "bob"],
    status: "active",
    turnBudget: 4,
    turnIndex: 0,
    round: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function makeEntry(over: Partial<TurnEntry> = {}): TurnEntry {
  return {
    messageId: "m1",
    roomSlug: "room",
    turnIndex: 0,
    from: "alice",
    role: "agent",
    parts: [{ text: "hello" }],
    at: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("createFileRoomStore", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "chamber-rooms-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("round-trips a room, creating the rooms tree on first write", async () => {
    const store = createFileRoomStore(root);
    const room = makeRoom({ turnIndex: 2, pending: { nextSpeaker: "bob" } });
    await store.saveRoom(room);
    expect(await store.loadRoom("room")).toEqual(room);
  });

  it("returns undefined for an unknown room", async () => {
    const store = createFileRoomStore(root);
    expect(await store.loadRoom("nope")).toBeUndefined();
  });

  it("returns undefined for a malformed room.json rather than throwing", async () => {
    const store = createFileRoomStore(root);
    await mkdir(join(root, "bad"), { recursive: true });
    await writeFile(join(root, "bad", "room.json"), "{ not json");
    expect(await store.loadRoom("bad")).toBeUndefined();
  });

  it("preserves a present (non-zero) round through the load boundary", async () => {
    const store = createFileRoomStore(root);
    await store.saveRoom(makeRoom({ round: 5 }));
    expect((await store.loadRoom("room"))?.round).toBe(5);
  });

  it("defaults a missing round to 0 at the load boundary (older room.json)", async () => {
    const store = createFileRoomStore(root);
    await mkdir(join(root, "legacy"), { recursive: true });
    // A room.json persisted before `round` existed — must still load (isRoom does
    // not require round; the store defaults it).
    const legacy = {
      slug: "legacy",
      name: "Room",
      strategy: "sequential",
      participants: ["alice", "bob"],
      status: "active",
      turnBudget: 4,
      turnIndex: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    await writeFile(join(root, "legacy", "room.json"), JSON.stringify(legacy));
    const loaded = await store.loadRoom("legacy");
    expect(loaded?.status).toBe("active");
    expect(loaded?.turnIndex).toBe(1);
    expect(loaded?.round).toBe(0);
  });

  it("returns undefined for a room.json missing required fields", async () => {
    const store = createFileRoomStore(root);
    await mkdir(join(root, "partial"), { recursive: true });
    await writeFile(join(root, "partial", "room.json"), JSON.stringify({ slug: "partial" }));
    expect(await store.loadRoom("partial")).toBeUndefined();
  });

  it("returns undefined for a room.json with non-string participants", async () => {
    const store = createFileRoomStore(root);
    await mkdir(join(root, "corrupt"), { recursive: true });
    await writeFile(
      join(root, "corrupt", "room.json"),
      JSON.stringify({ ...makeRoom({ slug: "corrupt" }), participants: [1, "alice"] }),
    );
    expect(await store.loadRoom("corrupt")).toBeUndefined();
  });

  it("appends and loads a transcript in order", async () => {
    const store = createFileRoomStore(root);
    await store.appendTranscript("room", makeEntry({ messageId: "m1", turnIndex: 0 }));
    await store.appendTranscript("room", makeEntry({ messageId: "m2", turnIndex: 1, from: "bob" }));
    const out = await store.loadTranscript("room");
    expect(out.map((e) => e.messageId)).toEqual(["m1", "m2"]);
    expect(out[1]?.from).toBe("bob");
  });

  it("skips a malformed transcript line, keeping the valid ones", async () => {
    const store = createFileRoomStore(root);
    await store.appendTranscript("room", makeEntry({ messageId: "m1" }));
    await appendFile(join(root, "room", "transcript.jsonl"), "this is not json\n");
    await store.appendTranscript("room", makeEntry({ messageId: "m2" }));
    expect((await store.loadTranscript("room")).map((e) => e.messageId)).toEqual(["m1", "m2"]);
  });

  it("returns an empty transcript for a room with no log yet", async () => {
    const store = createFileRoomStore(root);
    expect(await store.loadTranscript("room")).toEqual([]);
  });

  it("rejects a path-traversal slug on every method (FS boundary)", async () => {
    const store = createFileRoomStore(root);
    await expect(store.saveRoom(makeRoom({ slug: "../escape" }))).rejects.toThrow();
    await expect(store.loadRoom("../escape")).rejects.toThrow();
    await expect(store.loadTranscript("../escape")).rejects.toThrow();
    await expect(store.appendTranscript("../escape", makeEntry())).rejects.toThrow();
  });

  it("sweeps only closed rooms beyond the newest keep count", async () => {
    const store = createFileRoomStore(root);
    await store.saveRoom(
      makeRoom({ slug: "closed-1", status: "done", createdAt: "2026-01-01T00:00:00.000Z" }),
    );
    await store.saveRoom(
      makeRoom({ slug: "closed-2", status: "stopped", createdAt: "2026-01-02T00:00:00.000Z" }),
    );
    await store.saveRoom(
      makeRoom({ slug: "closed-3", status: "done", createdAt: "2026-01-03T00:00:00.000Z" }),
    );
    await store.saveRoom(
      makeRoom({ slug: "closed-4", status: "stopped", createdAt: "2026-01-04T00:00:00.000Z" }),
    );
    await store.saveRoom(
      makeRoom({ slug: "active", status: "active", createdAt: "2026-01-05T00:00:00.000Z" }),
    );
    await mkdir(join(root, "bad-json"), { recursive: true });
    await writeFile(join(root, "bad-json", "room.json"), "{ not json");
    await mkdir(join(root, "not-room"), { recursive: true });
    await writeFile(join(root, "not-room", "room.json"), JSON.stringify({ slug: "not-room" }));
    await writeFile(join(root, "loose.txt"), "not a room dir");

    const result = await sweepClosedRooms(root, { keep: 2 });

    expect(result.kept).toEqual(["closed-4", "closed-3"]);
    expect(result.removed).toEqual(["closed-2", "closed-1"]);
    expect(result.skipped).toEqual(
      expect.arrayContaining(["active", "bad-json", "not-room", "loose.txt"]),
    );
    expect(await pathExists(join(root, "closed-4"))).toBe(true);
    expect(await pathExists(join(root, "closed-3"))).toBe(true);
    expect(await pathExists(join(root, "closed-2"))).toBe(false);
    expect(await pathExists(join(root, "closed-1"))).toBe(false);
    expect(await pathExists(join(root, "active"))).toBe(true);
    expect(await pathExists(join(root, "bad-json"))).toBe(true);
    expect(await pathExists(join(root, "not-room"))).toBe(true);
    expect(await pathExists(join(root, "loose.txt"))).toBe(true);
  });

  it("rejects an invalid keep count", async () => {
    await expect(sweepClosedRooms(root, { keep: -1 })).rejects.toThrow();
    await expect(sweepClosedRooms(root, { keep: 1.5 })).rejects.toThrow();
  });

  it("skips (never deletes) unsafe, slug-mismatched, and unparseable-date rooms", async () => {
    const store = createFileRoomStore(root);
    // A real closed room that SHOULD be pruned once over the keep count.
    await store.saveRoom(
      makeRoom({ slug: "closed", status: "done", createdAt: "2026-01-01T00:00:00.000Z" }),
    );
    // Unsafe directory name (assertSafeSlug rejects it) — skipped before any read.
    await mkdir(join(root, "Bad_Slug"), { recursive: true });
    await writeFile(
      join(root, "Bad_Slug", "room.json"),
      JSON.stringify(makeRoom({ slug: "Bad_Slug", status: "done" })),
    );
    // room.json whose slug disagrees with its directory — skipped.
    await mkdir(join(root, "mismatch"), { recursive: true });
    await writeFile(
      join(root, "mismatch", "room.json"),
      JSON.stringify(makeRoom({ slug: "other", status: "done" })),
    );
    // Valid shape but an unparseable createdAt — skipped, not deleted.
    await mkdir(join(root, "bad-date"), { recursive: true });
    await writeFile(
      join(root, "bad-date", "room.json"),
      JSON.stringify(makeRoom({ slug: "bad-date", status: "done", createdAt: "not-a-date" })),
    );

    const result = await sweepClosedRooms(root, { keep: 0 });

    expect(result.removed).toEqual(["closed"]);
    expect(result.skipped).toEqual(expect.arrayContaining(["Bad_Slug", "mismatch", "bad-date"]));
    expect(await pathExists(join(root, "Bad_Slug"))).toBe(true);
    expect(await pathExists(join(root, "mismatch"))).toBe(true);
    expect(await pathExists(join(root, "bad-date"))).toBe(true);
    expect(await pathExists(join(root, "closed"))).toBe(false);
  });

  it("breaks createdAt ties deterministically, keeping the newest slug", async () => {
    const store = createFileRoomStore(root);
    const at = "2026-02-02T00:00:00.000Z";
    await store.saveRoom(makeRoom({ slug: "tie-a", status: "done", createdAt: at }));
    await store.saveRoom(makeRoom({ slug: "tie-b", status: "done", createdAt: at }));
    await store.saveRoom(makeRoom({ slug: "tie-c", status: "done", createdAt: at }));

    const result = await sweepClosedRooms(root, { keep: 1 });

    // Equal createdAt → byte-order tie-break keeps the largest (newest) slug.
    expect(result.kept).toEqual(["tie-c"]);
    expect(result.removed).toEqual(["tie-b", "tie-a"]);
  });

  it("no-ops on a missing or empty rooms root", async () => {
    expect(await sweepClosedRooms(join(root, "missing"), { keep: 1 })).toEqual({
      removed: [],
      kept: [],
      skipped: [],
    });
    const empty = join(root, "empty");
    await mkdir(empty);
    expect(await sweepClosedRooms(empty, { keep: 1 })).toEqual({
      removed: [],
      kept: [],
      skipped: [],
    });
  });
});
