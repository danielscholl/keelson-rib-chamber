import type { CanvasView } from "@keelson/shared";
import type { RunAgentTurn } from "./agent-turn.ts";
import type { MindSlug, Room, TurnEntry } from "./types.ts";

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
}

// Publish seam. The driver composes the finished board and hands it over; the
// adapter maps publish() to getSnapshotManager().recompose("rib:chamber:room")
// later. Keeping the snapshot key / register / coalescing discipline out of the
// core is deliberate — that is C1/C3 adapter territory.
export interface RoomPublisher {
  publish(view: CanvasView): Promise<void>;
}
