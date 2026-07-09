#!/usr/bin/env bun
/**
 * Lenses-index collector — the producer behind the `chamber-lenses` workflow. Reads
 * the persisted lenses AND the Minds under the data home and prints a canvas
 * board-view JSON object (the index of LIVING views, one card per lens, each dotted
 * in its maintaining Mind's identity tone), and nothing else, to stdout. Degrades to
 * a valid empty index: a missing lenses/ dir (none authored yet) or any read error
 * yields `[]`, never a thrown collector; an unreadable minds dir just folds the dots
 * to neutral.
 */
import { join } from "node:path";
import { buildLensesIndexBoard } from "../src/boards/lenses.ts";
import { isExhibit, listLenses } from "../src/lens-store.ts";
import { readMinds } from "../src/minds-store.ts";
import { chamberDataHome } from "../src/paths.ts";

async function main() {
  // The chamber-lenses bash node bakes the resolved data home in as argv[2] (the
  // keelson-home-rooted path the in-process rib captured), so this out-of-process
  // collector derives both the lenses and minds dirs from it. Fall back to
  // chamberDataHome() for a manual/standalone run.
  const home = process.argv[2]?.trim() || chamberDataHome();
  const [records, minds] = await Promise.all([
    listLenses(join(home, "lenses")).catch(() => []),
    readMinds(join(home, "minds")).catch(() => []),
  ]);
  // The store holds both species; this index is the LENSES shelf only — the
  // exhibits shelf has its own collector (collect-exhibits.ts).
  const lenses = records.filter((r) => !isExhibit(r));
  process.stdout.write(JSON.stringify(buildLensesIndexBoard(lenses, minds)));
}

await main();
