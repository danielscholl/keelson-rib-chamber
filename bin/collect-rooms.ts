#!/usr/bin/env bun
/**
 * Rooms-index collector — the producer behind the `chamber-rooms` workflow. Reads
 * the persisted rooms (plus each magentic room's task ledger), the Minds, AND the
 * exhibits under the data home and prints
 * a canvas board-view JSON object (one card per room — active first, then ended
 * sessions, each cast name in its Mind's identity tone, each card listing the
 * exhibits the room tabled), and nothing else, to stdout. Degrades to a valid
 * empty index: a missing rooms/ dir (nothing convened yet) or any read error
 * yields `[]`, never a thrown collector; an unreadable minds or lenses dir just
 * folds the cast to bare slugs / drops the tabled links.
 */
import { join } from "node:path";
import { buildRoomsIndexBoard } from "../src/boards/rooms.ts";
import { listLenses } from "../src/lens-store.ts";
import { readMinds } from "../src/minds-store.ts";
import { chamberDataHome } from "../src/paths.ts";
import { createFileRoomStore, listRooms } from "../src/room-store.ts";
import type { TaskLedger } from "../src/types.ts";

// Tolerant parse, like every other read in this collector: a missing, malformed, or
// non-object argument yields no names rather than a thrown collector, and the index
// falls back to raw ids.
function parseProjectNames(raw: string | undefined): Record<string, string> {
  if (!raw?.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

async function main() {
  // The chamber-rooms bash node bakes the resolved data home in as argv[2] (the
  // keelson-home-rooted path the in-process rib captured), so this out-of-process
  // collector derives the rooms, minds, and lenses dirs from it. Fall back to
  // chamberDataHome() for a manual/standalone run.
  const home = process.argv[2]?.trim() || chamberDataHome();
  // argv[3] is a baked {id: name} map of the host's projects (the chamber-lenses
  // collector takes its workflow-versions map the same way): this process cannot reach
  // the projects seam, so without it a scoped room could only show a raw uuid. Baked at
  // contribution time, so a project added since then falls back to its id — which is
  // what an unresolvable project renders anyway.
  const projectNames = new Map<string, string>(Object.entries(parseProjectNames(process.argv[3])));
  const roomsRoot = join(home, "rooms");
  const [rooms, minds, lenses] = await Promise.all([
    listRooms(roomsRoot).catch(() => []),
    readMinds(join(home, "minds")).catch(() => []),
    listLenses(join(home, "lenses")).catch(() => []),
  ]);
  const outcomeSlugs = new Set(
    rooms.filter((room) => room.status !== "active" && room.outcomeAt).map((room) => room.slug),
  );
  // A magentic card's bar reads its plan composition off the room's ledger.json;
  // a missing or unreadable ledger just keeps the turn-fill bar, never a throw.
  const store = createFileRoomStore(roomsRoot);
  const ledgers = new Map<string, TaskLedger>();
  await Promise.all(
    rooms
      .filter((room) => room.strategy === "magentic")
      .map(async (room) => {
        const ledger = await store.loadLedger(room.slug).catch(() => undefined);
        if (ledger) ledgers.set(room.slug, ledger);
      }),
  );
  process.stdout.write(
    JSON.stringify(buildRoomsIndexBoard(rooms, minds, lenses, outcomeSlugs, ledgers, projectNames)),
  );
}

await main();
