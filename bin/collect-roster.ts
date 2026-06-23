#!/usr/bin/env bun
/**
 * Roster collector — the producer behind the `chamber-roster` workflow. Reads
 * the genesis-authored Minds under the data home and prints a canvas board-view
 * JSON object (one card per Mind), and nothing else, to stdout. Degrades to a
 * valid empty roster: a missing minds/ dir (nothing genesis-ed yet) or any read
 * error yields `[]`, never a thrown collector.
 */
import { dirname } from "node:path";
import { buildRosterBoard } from "../src/boards/roster.ts";
import { readMinds } from "../src/minds-store.ts";
import { mindsDir } from "../src/paths.ts";
import { readDraftExclusion } from "../src/room-draft.ts";

async function main() {
  // The chamber-roster bash node bakes the resolved minds dir in as argv[2] (the
  // keelson-home-rooted path the in-process rib captured), so this out-of-process
  // collector reads the same dir without resolving the home itself. Fall back to
  // mindsDir() for a manual/standalone run.
  const dir = process.argv[2]?.trim() || mindsDir();
  let minds: Awaited<ReturnType<typeof readMinds>> = [];
  try {
    minds = await readMinds(dir);
  } catch {
    minds = [];
  }
  // The Convene draft sits beside minds/ under the same data home; derive it from
  // the baked minds dir's parent so this process agrees with the in-process writer.
  // Tolerant read — a missing/corrupt draft yields an empty (all-selected) set.
  const excluded = await readDraftExclusion(dirname(dir));
  process.stdout.write(JSON.stringify(buildRosterBoard(minds, excluded)));
}

await main();
