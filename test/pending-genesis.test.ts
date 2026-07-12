import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearPendingGenesis,
  GENESIS_STALL_MS,
  pendingElapsedMs,
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

// The one elapsed rule the boot card and the boot-time reconcile both read — its
// branches decide whether an orphaned marker ticks, for how long, or presents the
// Dismiss immediately, so each arm is pinned here.
describe("pendingElapsedMs", () => {
  const NOW = Date.parse("2026-07-12T12:00:00.000Z");
  const at = (offsetMs: number) => ({
    startedAt: new Date(NOW + offsetMs).toISOString(),
  });

  test("a past marker reports its real elapsed", () => {
    expect(pendingElapsedMs(at(-45_000), NOW)).toBe(45_000);
  });

  test("a marker inside the future skew clamps to zero (still authoring)", () => {
    expect(pendingElapsedMs(at(10_000), NOW)).toBe(0);
  });

  test("a marker beyond the future skew counts as fully stalled", () => {
    expect(pendingElapsedMs(at(120_000), NOW)).toBe(GENESIS_STALL_MS);
  });

  test("an unparseable startedAt counts as fully stalled", () => {
    expect(pendingElapsedMs({ startedAt: "not-a-date" }, NOW)).toBe(GENESIS_STALL_MS);
  });

  test("a marker past the stall window reports at least the window", () => {
    expect(pendingElapsedMs(at(-GENESIS_STALL_MS - 60_000), NOW)).toBeGreaterThanOrEqual(
      GENESIS_STALL_MS,
    );
  });
});
