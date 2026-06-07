import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RoomStore } from "./ports.ts";
import type { MindSlug, Room, TurnEntry } from "./types.ts";

// File-based RoomStore (C3): one directory per room under the data home's rooms/
// root — room.json holds the current state, transcript.jsonl is the append-only
// turn log (the source of truth). `roomsRoot` is injected so the store is
// testable against a temp dir and path resolution stays in paths.ts. Reads are
// tolerant: a missing or corrupt file degrades to undefined / [] rather than
// throwing, mirroring readMinds — a half-written file can't crash the driver.

export function createFileRoomStore(roomsRoot: string): RoomStore {
  const roomDir = (slug: MindSlug) => join(roomsRoot, slug);
  const roomFile = (slug: MindSlug) => join(roomDir(slug), "room.json");
  const transcriptFile = (slug: MindSlug) => join(roomDir(slug), "transcript.jsonl");

  return {
    async loadRoom(slug) {
      try {
        const raw = await readFile(roomFile(slug), "utf8");
        const parsed: unknown = JSON.parse(raw);
        return isRoom(parsed) ? parsed : undefined;
      } catch {
        return undefined; // no room.json yet, or unreadable/unparseable
      }
    },

    async saveRoom(room) {
      await mkdir(roomDir(room.slug), { recursive: true });
      // room.json is rewritten every turn; write a temp then rename (atomic on
      // the same filesystem) so a crash mid-write can't leave a torn state file.
      const tmp = `${roomFile(room.slug)}.tmp`;
      await writeFile(tmp, `${JSON.stringify(room, null, 2)}\n`);
      await rename(tmp, roomFile(room.slug));
    },

    async appendTranscript(slug, entry) {
      await mkdir(roomDir(slug), { recursive: true });
      await appendFile(transcriptFile(slug), `${JSON.stringify(entry)}\n`);
    },

    async loadTranscript(slug) {
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
