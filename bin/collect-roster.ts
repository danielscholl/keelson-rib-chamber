#!/usr/bin/env bun
/**
 * Roster collector — the producer behind the `chamber-roster` workflow. Reads
 * the genesis-authored Minds under the data home and prints a canvas board-view
 * JSON object (one card per Mind), and nothing else, to stdout. Degrades to a
 * valid empty roster: a missing minds/ dir (nothing genesis-ed yet) or any read
 * error yields `[]`, never a thrown collector.
 */
import { buildRosterBoard } from "../src/boards/roster.ts";
import { readMinds } from "../src/minds-store.ts";
import { mindsDir } from "../src/paths.ts";

async function main() {
  let minds: Awaited<ReturnType<typeof readMinds>> = [];
  try {
    minds = await readMinds(mindsDir());
  } catch {
    minds = [];
  }
  process.stdout.write(JSON.stringify(buildRosterBoard(minds)));
}

await main();
