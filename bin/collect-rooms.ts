#!/usr/bin/env bun
/**
 * Rooms-index collector — the producer behind the `chamber-rooms` workflow. Reads
 * the persisted rooms AND the Minds under the data home and prints a canvas
 * board-view JSON object (one card per room — active first, then ended sessions,
 * each cast name in its Mind's identity tone), and nothing else, to stdout.
 * Degrades to a valid empty index: a missing rooms/ dir (nothing convened yet) or
 * any read error yields `[]`, never a thrown collector; an unreadable minds dir
 * just folds the cast to bare slugs.
 */
import { join } from "node:path";
import { buildRoomsIndexBoard } from "../src/boards/rooms.ts";
import { readMinds } from "../src/minds-store.ts";
import { chamberDataHome } from "../src/paths.ts";
import { listRooms } from "../src/room-store.ts";

async function main() {
  // The chamber-rooms bash node bakes the resolved data home in as argv[2] (the
  // keelson-home-rooted path the in-process rib captured), so this out-of-process
  // collector derives both the rooms and minds dirs from it. Fall back to
  // chamberDataHome() for a manual/standalone run.
  const home = process.argv[2]?.trim() || chamberDataHome();
  const [rooms, minds] = await Promise.all([
    listRooms(join(home, "rooms")).catch(() => []),
    readMinds(join(home, "minds")).catch(() => []),
  ]);
  process.stdout.write(JSON.stringify(buildRoomsIndexBoard(rooms, minds)));
}

await main();
