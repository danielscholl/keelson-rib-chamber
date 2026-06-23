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
import { buildChamberState } from "../src/chamber-state.ts";
import { readMinds } from "../src/minds-store.ts";
import { chamberDataHome } from "../src/paths.ts";
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
  // The pulse is "build once" shared with the in-process gate: buildChamberState
  // reads the three stores, and the watermark's briefPromoted is the for-you signal.
  // Fail-soft — a state/watermark error drops the pulse, never the roster board.
  let pulse: Parameters<typeof buildRosterBoard>[2];
  try {
    const state = await buildChamberState({
      mindsDir: minds,
      roomsDir: join(home, "rooms"),
      lensesDir: join(home, "lenses"),
    });
    const watermark = await readWatermark(home);
    pulse = {
      forYou: watermark.briefPromoted,
      activeRooms: state.activeRoomCount,
      liveLenses: state.liveLensCount,
      minds: state.mindCount,
    };
  } catch {
    pulse = undefined;
  }
  process.stdout.write(JSON.stringify(buildRosterBoard(mindsList, excluded, pulse)));
}

await main();
