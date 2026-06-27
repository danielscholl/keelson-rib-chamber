#!/usr/bin/env bun
/**
 * Standing-digest PUBLISH collector — the key driver behind the chamber-digest
 * workflow. Reads the persisted digest AND the three stores under the data home and
 * prints the board the bound key should show this tick: the last agent-authored board
 * while the chamber has content, or the cold board once it empties (the gate withholds a
 * re-author of an empty chamber, so the stored board must not keep naming gone entities).
 * Runs every tick (the workflow's all_done publish node), so the bound key refreshes on
 * cadence — composedAt stays live — whether or not the author node ran this tick. Cheap
 * (disk reads, never an agent turn); a missing digest, or a store read error, degrades to
 * the stored/cold board, never a thrown collector.
 */
import { join } from "node:path";
import { hasDigestContent, readChamberRecords, reduceChamberState } from "../src/chamber-state.ts";
import { readDigest, resolveDigestPublishBoard } from "../src/digest-store.ts";
import { chamberDataHome } from "../src/paths.ts";

// Whether the live chamber holds any Mind/room/lens. A store read error assumes content,
// so a transient fault never blanks a populated digest — suppression is for a confirmed
// empty chamber only.
async function chamberHasContent(home: string): Promise<boolean> {
  try {
    const { minds, rooms, lenses } = await readChamberRecords({
      mindsDir: join(home, "minds"),
      roomsDir: join(home, "rooms"),
      lensesDir: join(home, "lenses"),
    });
    return hasDigestContent(reduceChamberState(minds, rooms, lenses));
  } catch {
    return true;
  }
}

async function main() {
  const home = process.argv[2]?.trim() || chamberDataHome();
  const record = await readDigest(home).catch(() => null);
  process.stdout.write(
    JSON.stringify(resolveDigestPublishBoard(record, await chamberHasContent(home))),
  );
}

await main();
