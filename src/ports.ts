import type { CanvasView } from "@keelson/shared";
import type { RunAgentTurn } from "./agent-turn.ts";
import type { MindSlug, Room, TaskLedger, TurnEntry } from "./types.ts";

export type { RunAgentTurn };

// Persistence seam. Backed by the rib data home (C3) later — room.json +
// transcript.jsonl under rooms/<slug>/; an in-memory fake in tests. The
// transcript is the source of truth; a room's turnIndex is reconcilable from it
// on resume.
export interface RoomStore {
  loadRoom(slug: MindSlug): Promise<Room | undefined>;
  saveRoom(room: Room): Promise<void>;
  appendTranscript(slug: MindSlug, entry: TurnEntry): Promise<void>;
  loadTranscript(slug: MindSlug): Promise<readonly TurnEntry[]>;
  // Remove a room's directory (room.json + transcript + ledger). Fails closed:
  // rejects an unsafe slug and throws when the room is absent (mirrors retireMind),
  // so a delete of an already-gone room surfaces rather than claiming success.
  deleteRoom(slug: MindSlug): Promise<void>;
  // The magentic task ledger, beside room.json under rooms/<slug>/. A non-magentic
  // room has none, so loadLedger degrades to undefined (tolerant of a
  // missing/corrupt file like loadRoom). saveLedger rewrites it atomically.
  loadLedger(slug: MindSlug): Promise<TaskLedger | undefined>;
  saveLedger(slug: MindSlug, ledger: TaskLedger): Promise<void>;
}

// Publish seam. The driver composes the finished board and hands it over with the
// owning room's slug; the adapter routes it to that room's per-slug snapshot key
// (rib:chamber:room:<slug>) and surface region. Keeping the snapshot key / register
// / coalescing discipline out of the core is deliberate — that is C1/C3 adapter
// territory (see room-region-registry.ts).
export interface RoomPublisher {
  publish(slug: MindSlug, view: CanvasView): Promise<void>;
}
