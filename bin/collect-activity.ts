#!/usr/bin/env bun
/**
 * Activity collector — the producer behind the `chamber-activity` workflow. Reads
 * all three Chamber stores under the data home and prints a canvas board-view JSON
 * object (the standing activity panel — cumulative pulse + a recent-events feed),
 * and nothing else, to stdout. A cheap DETERMINISTIC producer (disk reads, no agent
 * turn): the cost-safe arm of the standing-lens cost guard, so the host scheduler
 * can refresh it on cadence with no tab open. Degrades to a valid board: a missing
 * store dir or any read error drops that store's contribution, never a thrown
 * collector.
 */
import { join } from "node:path";
import { buildActivityBoard } from "../src/boards/activity.ts";
import { listLenses } from "../src/lens-store.ts";
import { listMindRecords } from "../src/minds-store.ts";
import { chamberDataHome } from "../src/paths.ts";
import { listRooms } from "../src/room-store.ts";

async function main() {
  // The chamber-activity bash node bakes the resolved data home in as argv[2] (the
  // keelson-home-rooted path the rib captured in-process), so this out-of-process
  // collector derives every store dir from it without resolving the home itself.
  // Fall back to chamberDataHome() for a manual/standalone run.
  const home = process.argv[2]?.trim() || chamberDataHome();
  // The stores degrade to [] on a missing dir; the catch covers a non-ENOENT read
  // error too, so one unreadable store can't blank the whole panel.
  const [minds, rooms, lenses] = await Promise.all([
    listMindRecords(join(home, "minds")).catch(() => []),
    listRooms(join(home, "rooms")).catch(() => []),
    listLenses(join(home, "lenses")).catch(() => []),
  ]);
  process.stdout.write(JSON.stringify(buildActivityBoard(minds, rooms, lenses)));
}

await main();
