import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileRoomStore } from "../src/room-store.ts";
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
});
