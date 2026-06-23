#!/usr/bin/env bun
/**
 * Lenses-index collector — the producer behind the `chamber-lenses` workflow. Reads
 * the persisted lenses under the data home and prints a canvas board-view JSON
 * object (the index of LIVING views, one card per lens), and nothing else, to
 * stdout. Degrades to a valid empty index: a missing lenses/ dir (none authored
 * yet) or any read error yields `[]`, never a thrown collector.
 */
import { buildLensesIndexBoard } from "../src/boards/lenses.ts";
import { listLenses } from "../src/lens-store.ts";
import { lensesDir } from "../src/paths.ts";

async function main() {
  // The chamber-lenses bash node bakes the resolved lenses dir in as argv[2] (the
  // keelson-home-rooted path the in-process rib captured), so this out-of-process
  // collector reads the same dir without resolving the home itself. Fall back to
  // lensesDir() for a manual/standalone run.
  const dir = process.argv[2]?.trim() || lensesDir();
  let lenses: Awaited<ReturnType<typeof listLenses>> = [];
  try {
    lenses = await listLenses(dir);
  } catch {
    lenses = [];
  }
  process.stdout.write(JSON.stringify(buildLensesIndexBoard(lenses)));
}

await main();
