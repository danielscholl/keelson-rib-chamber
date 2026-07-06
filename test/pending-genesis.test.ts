import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearPendingGenesis,
  pendingGenesisFile,
  readPendingGenesis,
  writePendingGenesis,
} from "../src/pending-genesis.ts";

describe("pending-genesis store", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "chamber-pending-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test("a missing marker reads as null (no pending genesis)", async () => {
    expect(await readPendingGenesis(home)).toBeNull();
  });

  test("round-trips startedAt + optional name/role", async () => {
    await writePendingGenesis(
      { startedAt: "2026-07-05T18:00:00.000Z", name: "Mycroft", role: "Research Partner" },
      home,
    );
    expect(await readPendingGenesis(home)).toEqual({
      startedAt: "2026-07-05T18:00:00.000Z",
      name: "Mycroft",
      role: "Research Partner",
    });
  });

  test("a freeform marker keeps only startedAt (name/role absent)", async () => {
    await writePendingGenesis({ startedAt: "2026-07-05T18:00:00.000Z" }, home);
    expect(await readPendingGenesis(home)).toEqual({ startedAt: "2026-07-05T18:00:00.000Z" });
  });

  test("clear removes the marker (an absent file is a safe double-clear)", async () => {
    await writePendingGenesis({ startedAt: "2026-07-05T18:00:00.000Z" }, home);
    await clearPendingGenesis(home);
    expect(await readPendingGenesis(home)).toBeNull();
    // A second clear on the now-absent file must not throw.
    await clearPendingGenesis(home);
    expect(await readPendingGenesis(home)).toBeNull();
  });

  test("a torn/invalid file, or one without startedAt, degrades to null", async () => {
    await writeFile(pendingGenesisFile(home), "{ not json");
    expect(await readPendingGenesis(home)).toBeNull();
    await writeFile(pendingGenesisFile(home), JSON.stringify({ name: "Ghost" }));
    expect(await readPendingGenesis(home)).toBeNull();
  });
});
