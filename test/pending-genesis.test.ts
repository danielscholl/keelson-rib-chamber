import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendPendingGenesis,
  clearPendingGenesis,
  GENESIS_STALL_MS,
  pendingElapsedMs,
  pendingGenesisFile,
  readPendingGeneses,
  removeLandedGenesis,
  removePendingGenesisAt,
} from "../src/pending-genesis.ts";

describe("pending-genesis store", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "chamber-pending-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test("a missing marker file reads as an empty list (no pending geneses)", async () => {
    expect(await readPendingGeneses(home)).toEqual([]);
  });

  test("round-trips markers with optional name/role, in arrival order", async () => {
    await appendPendingGenesis(
      { startedAt: "2026-07-05T18:00:00.000Z", name: "Mycroft", role: "Research Partner" },
      home,
    );
    await appendPendingGenesis({ startedAt: "2026-07-05T18:00:05.000Z" }, home);
    expect(await readPendingGeneses(home)).toEqual([
      { startedAt: "2026-07-05T18:00:00.000Z", name: "Mycroft", role: "Research Partner" },
      { startedAt: "2026-07-05T18:00:05.000Z" },
    ]);
  });

  test("a same-stamp append nudges startedAt so dismiss identity stays unique", async () => {
    await appendPendingGenesis({ startedAt: "2026-07-05T18:00:00.000Z", name: "A" }, home);
    await appendPendingGenesis({ startedAt: "2026-07-05T18:00:00.000Z", name: "B" }, home);
    const stamps = (await readPendingGeneses(home)).map((m) => m.startedAt);
    expect(new Set(stamps).size).toBe(2);
  });

  test("a legacy single-object file reads as a one-marker list", async () => {
    await writeFile(
      pendingGenesisFile(home),
      JSON.stringify({ startedAt: "2026-07-05T18:00:00.000Z", name: "Mycroft" }),
    );
    expect(await readPendingGeneses(home)).toEqual([
      { startedAt: "2026-07-05T18:00:00.000Z", name: "Mycroft" },
    ]);
  });

  test("a landing settles its own marker by name; a freeform landing settles the oldest unnamed", async () => {
    await appendPendingGenesis({ startedAt: "2026-07-05T18:00:00.000Z", name: "Jarvis" }, home);
    await appendPendingGenesis({ startedAt: "2026-07-05T18:00:01.000Z" }, home);
    await appendPendingGenesis({ startedAt: "2026-07-05T18:00:02.000Z", name: "Mycroft" }, home);
    // Named landing: exactly Mycroft's marker settles.
    expect((await removeLandedGenesis("Mycroft", home)).map((m) => m.name)).toEqual([
      "Jarvis",
      undefined,
    ]);
    // Freeform landing (authored name matches nothing): the unnamed marker settles.
    expect((await removeLandedGenesis("Athena", home)).map((m) => m.name)).toEqual(["Jarvis"]);
    // No unnamed marker left: the oldest settles outright so nothing pins forever.
    expect(await removeLandedGenesis("Vesper", home)).toEqual([]);
    expect(await readPendingGeneses(home)).toEqual([]);
  });

  test("removePendingGenesisAt settles exactly the stamped marker", async () => {
    await appendPendingGenesis({ startedAt: "2026-07-05T18:00:00.000Z", name: "A" }, home);
    await appendPendingGenesis({ startedAt: "2026-07-05T18:00:01.000Z", name: "B" }, home);
    expect(
      (await removePendingGenesisAt("2026-07-05T18:00:00.000Z", home)).map((m) => m.name),
    ).toEqual(["B"]);
    // An unknown stamp removes nothing.
    expect(
      (await removePendingGenesisAt("2026-01-01T00:00:00.000Z", home)).map((m) => m.name),
    ).toEqual(["B"]);
  });

  test("clear removes every marker (an absent file is a safe double-clear)", async () => {
    await appendPendingGenesis({ startedAt: "2026-07-05T18:00:00.000Z" }, home);
    await clearPendingGenesis(home);
    expect(await readPendingGeneses(home)).toEqual([]);
    // A second clear on the now-absent file must not throw.
    await clearPendingGenesis(home);
    expect(await readPendingGeneses(home)).toEqual([]);
  });

  test("a torn/invalid file, or entries without startedAt, degrade to fewer markers", async () => {
    await writeFile(pendingGenesisFile(home), "{ not json");
    expect(await readPendingGeneses(home)).toEqual([]);
    await writeFile(pendingGenesisFile(home), JSON.stringify({ name: "Ghost" }));
    expect(await readPendingGeneses(home)).toEqual([]);
    await writeFile(
      pendingGenesisFile(home),
      JSON.stringify([{ name: "Ghost" }, { startedAt: "2026-07-05T18:00:00.000Z" }]),
    );
    expect(await readPendingGeneses(home)).toEqual([{ startedAt: "2026-07-05T18:00:00.000Z" }]);
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
