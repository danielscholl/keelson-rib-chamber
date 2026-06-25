#!/usr/bin/env bun
/**
 * Standing-digest PUBLISH collector — the key driver behind the chamber-digest
 * workflow. Reads the persisted digest under the data home and prints the last
 * agent-authored board (or the cold-start board when none exists yet) to stdout, and
 * nothing else. Runs every tick (the workflow's all_done publish node), so the bound
 * key refreshes on cadence — composedAt stays live — whether or not the author node
 * ran this tick. Cheap (a disk read, never an agent turn); a missing/torn digest
 * degrades to the cold board, never a thrown collector.
 */
import { coldStartDigestBoard, readDigest } from "../src/digest-store.ts";
import { chamberDataHome } from "../src/paths.ts";

async function main() {
  const home = process.argv[2]?.trim() || chamberDataHome();
  const record = await readDigest(home).catch(() => null);
  process.stdout.write(JSON.stringify(record?.board ?? coldStartDigestBoard()));
}

await main();
