import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertSafeSlug } from "./genesis.ts";
import type { RoomStore } from "./ports.ts";
import type { MindSlug, Room, TurnEntry } from "./types.ts";

// The file store adds `deleteRoom` beyond the core RoomStore port: a fresh
// `room-start` over a closed room must wipe the prior room.json + transcript so
// the new run begins at turnIndex 0 with an empty log (driver.start otherwise
// resumes the stored turnIndex).
export type FileRoomStore = RoomStore & { deleteRoom(slug: MindSlug): Promise<void> };

// File-based RoomStore (C3): one directory per room under the data home's rooms/
// root — room.json holds the current state, transcript.jsonl is the append-only
// turn log (the source of truth). `roomsRoot` is injected so the store is
// testable against a temp dir and path resolution stays in paths.ts. Reads are
// tolerant: a missing or corrupt file degrades to undefined / [] rather than
// throwing, mirroring readMinds — a half-written file can't crash the driver.
//
// Every method runs `assertSafeSlug` first: a slug becomes a directory name, so
// a traversal slug (`../minds/alice`) would otherwise read/write outside the
// rooms tree. This is the FS boundary, mirroring the minds store's guard.

export function createFileRoomStore(roomsRoot: string): FileRoomStore {
  // Per-write temp suffix so two overlapping saves of the same room (e.g. a
  // director inject racing a turn commit) never share a temp file and clobber
  // each other's rename.
  let writeSeq = 0;
  const roomDir = (slug: MindSlug) => join(roomsRoot, slug);
  const roomFile = (slug: MindSlug) => join(roomDir(slug), "room.json");
  const transcriptFile = (slug: MindSlug) => join(roomDir(slug), "transcript.jsonl");

  return {
    async loadRoom(slug) {
      assertSafeSlug(slug);
      try {
        const raw = await readFile(roomFile(slug), "utf8");
        const parsed: unknown = JSON.parse(raw);
        return isRoom(parsed) ? parsed : undefined;
      } catch {
        return undefined; // no room.json yet, or unreadable/unparseable
      }
    },

    async saveRoom(room) {
      assertSafeSlug(room.slug);
      await mkdir(roomDir(room.slug), { recursive: true });
      // room.json is rewritten every turn; write a unique temp then rename
      // (atomic on the same filesystem) so a crash mid-write can't leave a torn
      // state file and concurrent writers can't trample one shared temp.
      const tmp = `${roomFile(room.slug)}.${++writeSeq}.tmp`;
      await writeFile(tmp, `${JSON.stringify(room, null, 2)}\n`);
      await rename(tmp, roomFile(room.slug));
    },

    async appendTranscript(slug, entry) {
      assertSafeSlug(slug);
      await mkdir(roomDir(slug), { recursive: true });
      await appendFile(transcriptFile(slug), `${JSON.stringify(entry)}\n`);
    },

    async deleteRoom(slug) {
      assertSafeSlug(slug);
      await rm(roomDir(slug), { recursive: true, force: true });
    },

    async loadTranscript(slug) {
      assertSafeSlug(slug);
      let raw: string;
      try {
        raw = await readFile(transcriptFile(slug), "utf8");
      } catch {
        return []; // no transcript yet
      }
      const entries: TurnEntry[] = [];
      for (const line of raw.split("\n")) {
        if (line.trim().length === 0) continue;
        try {
          const parsed: unknown = JSON.parse(line);
          if (isTurnEntry(parsed)) entries.push(parsed);
        } catch {
          // skip a malformed line rather than dropping the whole transcript
        }
      }
      return entries;
    },
  };
}

function isRoom(value: unknown): value is Room {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.slug === "string" &&
    typeof r.name === "string" &&
    typeof r.strategy === "string" &&
    Array.isArray(r.participants) &&
    (r.status === "active" || r.status === "stopped" || r.status === "done") &&
    typeof r.turnBudget === "number" &&
    typeof r.turnIndex === "number" &&
    typeof r.createdAt === "string"
  );
}

function isTurnEntry(value: unknown): value is TurnEntry {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.messageId === "string" &&
    typeof e.roomSlug === "string" &&
    typeof e.turnIndex === "number" &&
    typeof e.from === "string" &&
    (e.role === "agent" || e.role === "director" || e.role === "system") &&
    Array.isArray(e.parts) &&
    typeof e.at === "string"
  );
}
