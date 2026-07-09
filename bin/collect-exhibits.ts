#!/usr/bin/env bun
/**
 * Exhibits-index collector — the producer behind the `chamber-exhibits` workflow.
 * Reads the persisted lens-store records under the data home, keeps the exhibit
 * kind, and prints the exhibits index board (one card per tabled deliverable),
 * and nothing else, to stdout. Degrades to a valid empty index: a missing lenses/
 * dir or any read error yields zero exhibits (an empty board the region's
 * hideWhenEmpty folds away), never a thrown collector.
 */
import { join } from "node:path";
import { buildExhibitsIndexBoard } from "../src/boards/exhibits.ts";
import { isExhibit, listLenses } from "../src/lens-store.ts";
import { chamberDataHome } from "../src/paths.ts";

async function main() {
  // The chamber-exhibits bash node bakes the resolved data home in as argv[2]
  // (see collect-lenses.ts); fall back to chamberDataHome() for a standalone run.
  const home = process.argv[2]?.trim() || chamberDataHome();
  const records = await listLenses(join(home, "lenses")).catch(() => []);
  process.stdout.write(JSON.stringify(buildExhibitsIndexBoard(records.filter(isExhibit))));
}

await main();
