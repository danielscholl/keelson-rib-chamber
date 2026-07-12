import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { assertSafeSlug } from "./genesis.ts";
import type { RoomStore } from "./ports.ts";
import type { MindSlug, Room, TaskLedger, TurnEntry } from "./types.ts";

export const DEFAULT_CLOSED_ROOM_RETENTION = 25;

const ROOM_NAME_TOPIC_CAP = 60;

// Derive a meaningful room name from what a convene/start has on hand: the topic
// wins (trimmed, capped — a long opening prompt shouldn't become the whole name);
// otherwise the participants read as a roster ("alice & bob", "alice, bob +2");
// only a topic-less, participant-less room falls back to the bare "Room". Callers
// pass readable display names when they have them (the Mind record's name), else
// slugs — the helper doesn't care which.
export function deriveRoomName(topic: string | undefined, participants: readonly string[]): string {
  const trimmedTopic = (topic ?? "").trim();
  if (trimmedTopic) return truncateRoomTopic(trimmedTopic);

  const names = participants.map((p) => p.trim()).filter((p) => p.length > 0);
  if (names.length === 0) return "Room";
  if (names.length === 1) return names[0] as string;
  if (names.length === 2) return `${names[0]} & ${names[1]}`;
  return `${names[0]}, ${names[1]} +${names.length - 2}`;
}

function truncateRoomTopic(topic: string): string {
  if (topic.length <= ROOM_NAME_TOPIC_CAP) return topic;
  const capped = topic.slice(0, ROOM_NAME_TOPIC_CAP).trimEnd();
  const wordBoundary = capped.search(/\s+\S*$/);
  if (wordBoundary > 0) return `${capped.slice(0, wordBoundary)}…`;
  return `${capped}…`;
}

export interface SweepClosedRoomsOptions {
  keep?: number;
}

export interface SweepClosedRoomsResult {
  removed: MindSlug[];
  kept: MindSlug[];
  skipped: MindSlug[];
}

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

export function createFileRoomStore(roomsRoot: string): RoomStore {
  // Per-write temp suffix so two overlapping saves of the same room (e.g. a
  // director inject racing a turn commit) never share a temp file and clobber
  // each other's rename.
  let writeSeq = 0;
  const roomDir = (slug: MindSlug) => join(roomsRoot, slug);
  const roomFile = (slug: MindSlug) => join(roomDir(slug), "room.json");
  const transcriptFile = (slug: MindSlug) => join(roomDir(slug), "transcript.jsonl");
  const ledgerFile = (slug: MindSlug) => join(roomDir(slug), "ledger.json");

  return {
    async loadRoom(slug) {
      assertSafeSlug(slug);
      return parseRoomJson(roomFile(slug));
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

    async loadLedger(slug) {
      assertSafeSlug(slug);
      return parseLedgerJson(ledgerFile(slug));
    },

    async saveLedger(slug, ledger) {
      assertSafeSlug(slug);
      await mkdir(roomDir(slug), { recursive: true });
      // Rewritten on every manage/assign turn; unique temp + atomic rename so a
      // crash mid-write can't tear it and concurrent writers can't share one temp
      // (mirrors saveRoom).
      const tmp = `${ledgerFile(slug)}.${++writeSeq}.tmp`;
      await writeFile(tmp, `${JSON.stringify(ledger, null, 2)}\n`);
      await rename(tmp, ledgerFile(slug));
    },

    async deleteRoom(slug) {
      assertSafeSlug(slug);
      const dir = roomDir(slug);
      // Fail closed on a missing room (mirrors retireMind): deleting an already-gone
      // room surfaces not-found rather than reporting success. Only ENOENT/ENOTDIR
      // map to not-found — a permission/I/O error must surface, not masquerade as
      // "gone" — and the path must be a directory (never rm a stray file at the slug).
      let st: Awaited<ReturnType<typeof stat>>;
      try {
        st = await stat(dir);
      } catch (e) {
        if (isNodeError(e) && (e.code === "ENOENT" || e.code === "ENOTDIR")) {
          throw new Error(`room '${slug}' not found`);
        }
        throw e;
      }
      if (!st.isDirectory()) throw new Error(`room '${slug}' not found`);
      // Authoritative active-guard: re-read the on-disk status (the driver rewrites
      // room.json every turn) and refuse a live room, so a delete can't race the
      // driver even when the in-memory activeRooms set is stale (a restart/crash or
      // a second process) — mirrors sweepClosedRooms's pre-rm re-read. A corrupt /
      // unparseable room.json stays deletable (cleanup).
      const current = await parseRoomJson(roomFile(slug));
      if (current?.status === "active") {
        throw new Error(`room '${slug}' is active — stop it before deleting it`);
      }
      await rm(dir, { recursive: true, force: true });
    },
  };
}

// Enumerate every persisted room (active and closed) as the room-facing shape,
// newest-first by createdAt. The same tolerant walk sweepClosedRooms does, but it
// returns the rooms instead of pruning and keeps active ones — the index
// collector's source. Degrades per entry (skips non-dirs / unsafe / mismatched /
// unparseable) and ENOENT → [], so one bad dir can't blank the index.
export async function listRooms(roomsRoot: string): Promise<Room[]> {
  let entries: { name: string; isDirectory(): boolean }[];
  try {
    entries = await readdir(roomsRoot, { withFileTypes: true });
  } catch (e) {
    if (isNodeError(e) && e.code === "ENOENT") return [];
    throw e;
  }

  const rooms: { room: Room; createdAtMs: number }[] = [];
  for (const entry of entries) {
    const slug = entry.name;
    if (!entry.isDirectory()) continue;
    try {
      assertSafeSlug(slug);
    } catch {
      continue;
    }
    const room = await parseRoomJson(join(roomsRoot, slug, "room.json"));
    const createdAtMs = room ? Date.parse(room.createdAt) : Number.NaN;
    if (!room || room.slug !== slug || !Number.isFinite(createdAtMs)) continue;
    rooms.push({ room, createdAtMs });
  }

  rooms.sort(
    (a, b) =>
      b.createdAtMs - a.createdAtMs ||
      // Tie on createdAt (same-millisecond mints): newer slug first, the same
      // byte-order tiebreak sweepClosedRooms uses (deterministic across locales).
      (a.room.slug < b.room.slug ? 1 : a.room.slug > b.room.slug ? -1 : 0),
  );
  return rooms.map((r) => r.room);
}

export async function sweepClosedRooms(
  roomsRoot: string,
  options: SweepClosedRoomsOptions = {},
): Promise<SweepClosedRoomsResult> {
  const keep = options.keep ?? DEFAULT_CLOSED_ROOM_RETENTION;
  if (!Number.isInteger(keep) || keep < 0) {
    throw new Error("closed room retention keep must be a non-negative integer");
  }

  const result: SweepClosedRoomsResult = { removed: [], kept: [], skipped: [] };
  let entries: { name: string; isDirectory(): boolean }[];
  try {
    entries = await readdir(roomsRoot, { withFileTypes: true });
  } catch (e) {
    if (isNodeError(e) && e.code === "ENOENT") return result;
    throw e;
  }

  const closedRooms: { slug: MindSlug; createdAtMs: number }[] = [];
  for (const entry of entries) {
    const slug = entry.name;
    if (!entry.isDirectory()) {
      result.skipped.push(slug);
      continue;
    }
    try {
      assertSafeSlug(slug);
    } catch {
      result.skipped.push(slug);
      continue;
    }

    const room = await parseRoomJson(join(roomsRoot, slug, "room.json"));
    const createdAtMs = room ? Date.parse(room.createdAt) : Number.NaN;
    if (!room || room.slug !== slug || !Number.isFinite(createdAtMs)) {
      result.skipped.push(slug);
      continue;
    }
    if (room.status === "active") {
      result.skipped.push(slug);
      continue;
    }
    closedRooms.push({ slug, createdAtMs });
  }

  closedRooms.sort(
    (a, b) =>
      b.createdAtMs - a.createdAtMs ||
      // Tie on createdAt (same-millisecond starts): keep the newer slug. Slugs
      // are `room-<ts36>-<seq36>`, so the larger slug is the later mint. Byte
      // order (not localeCompare) keeps retention deterministic across locales.
      (a.slug < b.slug ? 1 : a.slug > b.slug ? -1 : 0),
  );
  for (const [index, room] of closedRooms.entries()) {
    if (index < keep) {
      result.kept.push(room.slug);
      continue;
    }
    // Re-read room.json immediately before deleting: the scan above can be stale
    // if the room transitioned (e.g. became active) between enumeration and now.
    // Skip rather than delete if it no longer reads as the same closed room.
    const fresh = await parseRoomJson(join(roomsRoot, room.slug, "room.json"));
    if (!fresh || fresh.slug !== room.slug || fresh.status === "active") {
      result.skipped.push(room.slug);
      continue;
    }
    try {
      await rm(join(roomsRoot, room.slug), { recursive: true, force: true });
      result.removed.push(room.slug);
    } catch {
      // One unremovable dir (permissions/lock) must not abort the sweep; skip
      // it so the remaining closed rooms are still pruned.
      result.skipped.push(room.slug);
    }
  }

  return result;
}

// Parse a room.json, tolerant of a missing/corrupt/torn file (degrades to
// undefined). `round` was added after some rooms were persisted, so default it
// here at the load boundary. Shared by the store's loadRoom and the retention
// sweep so the isRoom shape + round back-compat default live in one place.
async function parseRoomJson(path: string): Promise<Room | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRoom(parsed)) return undefined;
    return { ...parsed, round: parsed.round ?? 0 };
  } catch {
    return undefined;
  }
}

function isRoom(value: unknown): value is Room {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.slug === "string" &&
    typeof r.name === "string" &&
    typeof r.strategy === "string" &&
    Array.isArray(r.participants) &&
    r.participants.every((p) => typeof p === "string") &&
    (r.status === "active" || r.status === "stopped" || r.status === "done") &&
    typeof r.turnBudget === "number" &&
    typeof r.turnIndex === "number" &&
    typeof r.createdAt === "string"
  );
}

// Parse a ledger.json. A missing file (no magentic room yet) or a corrupt/torn one
// degrades to undefined; a REAL read failure (EACCES/EIO) is rethrown rather than
// masked. The ledger has no append-only backstop, so a silent undefined here would
// make the driver reset to a fresh ledger and overwrite a valid one — fail closed on
// an I/O error instead, distinct from the genuinely-absent or malformed cases.
async function parseLedgerJson(path: string): Promise<TaskLedger | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    if (isNodeError(e) && (e.code === "ENOENT" || e.code === "ENOTDIR")) return undefined;
    throw e;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isTaskLedger(parsed) ? parsed : undefined;
  } catch (e) {
    if (e instanceof SyntaxError) return undefined; // corrupt/torn JSON — tolerant
    throw e;
  }
}

function isTaskLedger(value: unknown): value is TaskLedger {
  if (typeof value !== "object" || value === null) return false;
  const l = value as Record<string, unknown>;
  return (
    typeof l.roomSlug === "string" &&
    typeof l.goal === "string" &&
    typeof l.manager === "string" &&
    (l.status === "planning" || l.status === "executing" || l.status === "done") &&
    typeof l.updatedAt === "string" &&
    Array.isArray(l.tasks) &&
    l.tasks.every(isLedgerTask)
  );
}

function isLedgerTask(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t.id === "string" &&
    typeof t.description === "string" &&
    (t.assignee === undefined || typeof t.assignee === "string") &&
    (t.status === "pending" ||
      t.status === "in-progress" ||
      t.status === "completed" ||
      t.status === "failed") &&
    (t.result === undefined || typeof t.result === "string") &&
    typeof t.createdAt === "string" &&
    typeof t.updatedAt === "string"
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

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
