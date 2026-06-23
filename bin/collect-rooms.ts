#!/usr/bin/env bun
/**
 * Rooms-index collector — the producer behind the `chamber-rooms` workflow. Reads
 * the persisted rooms under the data home and prints a canvas board-view JSON
 * object (the index of ENDED sessions, one card per closed room), and nothing
 * else, to stdout. Degrades to a valid empty index: a missing rooms/ dir (nothing
 * convened yet) or any read error yields `[]`, never a thrown collector.
 */
import { buildRoomsIndexBoard } from "../src/boards/rooms.ts";
import { roomsDir } from "../src/paths.ts";
import { listRooms } from "../src/room-store.ts";

async function main() {
  // The chamber-rooms bash node bakes the resolved rooms dir in as argv[2] (the
  // keelson-home-rooted path the in-process rib captured), so this out-of-process
  // collector reads the same dir without resolving the home itself. Fall back to
  // roomsDir() for a manual/standalone run.
  const dir = process.argv[2]?.trim() || roomsDir();
  let rooms: Awaited<ReturnType<typeof listRooms>> = [];
  try {
    rooms = await listRooms(dir);
  } catch {
    rooms = [];
  }
  process.stdout.write(JSON.stringify(buildRoomsIndexBoard(rooms)));
}

await main();
