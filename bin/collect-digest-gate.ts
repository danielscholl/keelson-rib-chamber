#!/usr/bin/env bun
/**
 * Standing-digest GATE collector — the cost guard behind the chamber-digest workflow.
 * Reads the three Chamber stores plus the persisted digest under the data home and
 * prints `{ "dirty": <bool>, "summary": <string> }` (and nothing else) to stdout.
 * `dirty` is true only when the chamber has content AND its structural fingerprint
 * differs from the one the last authoring persisted — so the workflow's `when:`-gated
 * author node (and its paid agent turn) runs ONLY on a real change. `summary` is the
 * compact, honest material the author synthesizes from (it has no tools to read the
 * stores itself), read via $gate.output.summary. A missing store/digest degrades to a
 * cold read (everything reads as new), never a thrown collector; a read failure stays
 * quiet (dirty:false) so a transient error never promotes a paid turn.
 */
import { join } from "node:path";
import {
  buildDigestSource,
  chamberFingerprint,
  hasDigestContent,
  reduceChamberState,
} from "../src/chamber-state.ts";
import { readDigest } from "../src/digest-store.ts";
import { listLenses } from "../src/lens-store.ts";
import { readMinds } from "../src/minds-store.ts";
import { chamberDataHome } from "../src/paths.ts";
import { listRooms } from "../src/room-store.ts";

async function main() {
  // The chamber-digest bash node bakes the resolved data home in as argv[2] (the
  // keelson-home-rooted path the rib captured in-process); fall back to chamberDataHome
  // for a manual/standalone run (see collect-activity).
  const home = process.argv[2]?.trim() || chamberDataHome();
  let dirty = false;
  let summary = "";
  try {
    // One read of the three stores backs both the fingerprint (dirty decision) and the
    // author's source summary. All return [] for a missing dir (cold start) without
    // throwing; the room/lens stores additionally re-throw a real read error (e.g.
    // EACCES), caught below to fail the gate closed (dirty:false) rather than authoring
    // off a partial fingerprint. The minds store masks a real error as [] (best-effort —
    // narrowing it would regress the room driver's self-heal), so a transient minds fault
    // at worst spends one self-correcting turn. readDigest is independent of the store
    // reads, so it joins the same parallel batch.
    const [minds, rooms, lenses, stored] = await Promise.all([
      readMinds(join(home, "minds")),
      listRooms(join(home, "rooms")),
      listLenses(join(home, "lenses")),
      readDigest(home),
    ]);
    const state = reduceChamberState(minds, rooms, lenses);
    // hasDigestContent also means emptying a populated chamber (all Minds/rooms/lenses
    // removed) goes quiet rather than spending a turn on an empty digest — the last
    // board lingers until new content arrives.
    dirty =
      hasDigestContent(state) &&
      chamberFingerprint(minds, rooms, lenses) !== (stored?.fingerprint ?? "");
    // Only the author reads the summary, and it runs solely when dirty, so skip the
    // string work on a quiet tick.
    summary = dirty ? buildDigestSource(minds, rooms, lenses) : "";
  } catch {
    // Fail closed: a real store read error must not author — stay quiet so a transient
    // fault never promotes a paid turn or stamps a partial fingerprint.
    dirty = false;
    summary = "";
  }
  process.stdout.write(JSON.stringify({ dirty, summary }));
}

await main();
