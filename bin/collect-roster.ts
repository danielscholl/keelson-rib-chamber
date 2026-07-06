#!/usr/bin/env bun
/**
 * Roster collector — the producer behind the `chamber-roster` workflow. Reads the
 * genesis-authored Minds under the data home and prints a canvas board-view JSON
 * object (one card per Mind, led by the Chamber pulse stats), and nothing else, to
 * stdout. Degrades to a valid roster: a missing minds/ dir (nothing genesis-ed yet)
 * or any read error yields an empty board with no pulse, never a thrown collector.
 */
import { join } from "node:path";
import { buildRosterBoard } from "../src/boards/roster.ts";
import { readMinds } from "../src/minds-store.ts";
import { chamberDataHome } from "../src/paths.ts";
import { readPendingGenesis } from "../src/pending-genesis.ts";
import { readDraftExclusion } from "../src/room-draft.ts";
import { readWatermark } from "../src/watermark-store.ts";

async function main() {
  // The chamber-roster bash node bakes the resolved data home in as argv[2] (the
  // keelson-home-rooted path the in-process rib captured), so this out-of-process
  // collector derives every dir + the watermark path from it without resolving the
  // home itself. Fall back to chamberDataHome() for a manual/standalone run.
  const home = process.argv[2]?.trim() || chamberDataHome();
  const minds = join(home, "minds");
  let mindsList: Awaited<ReturnType<typeof readMinds>> = [];
  try {
    mindsList = await readMinds(minds);
  } catch {
    mindsList = [];
  }
  // The Convene draft sits beside minds/ under the data home; tolerant read — a
  // missing/corrupt draft yields an empty (all-selected) set.
  const excluded = await readDraftExclusion(home);
  // The pulse is just the for-you signal — the watermark's briefPromoted flag.
  // Fail-soft — a watermark read error drops the pulse, never the roster board.
  let pulse: Parameters<typeof buildRosterBoard>[2];
  try {
    const watermark = await readWatermark(home);
    pulse = { forYou: watermark.briefPromoted };
  } catch {
    pulse = undefined;
  }
  // A genesis in flight renders a boot card in the seat being taken; a missing/corrupt
  // marker (the common case) is null — no boot card.
  const pending = await readPendingGenesis(home).catch(() => null);
  process.stdout.write(JSON.stringify(buildRosterBoard(mindsList, excluded, pulse, pending)));
}

await main();
