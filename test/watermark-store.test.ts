import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWatermark, watermarkFile, writeWatermark } from "../src/watermark-store.ts";

describe("watermark store", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "chamber-watermark-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test("a missing file reads as the empty (cold-start) watermark", async () => {
    expect(await readWatermark(home)).toEqual({
      ackedEndedRooms: [],
      lensFingerprints: {},
      briefPromoted: false,
      updatedAt: "",
    });
  });

  test("round-trips an advanced watermark across writes", async () => {
    const wm = {
      ackedEndedRooms: ["r1", "r2"],
      lensFingerprints: { a: "t1", b: "t2" },
      briefPromoted: true,
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await writeWatermark(wm, home);
    expect(await readWatermark(home)).toEqual(wm);
  });

  test("persists the file at the data-home path as the watermark JSON", async () => {
    await writeWatermark(
      {
        ackedEndedRooms: ["r1"],
        lensFingerprints: {},
        briefPromoted: false,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      home,
    );
    const raw = JSON.parse(await readFile(watermarkFile(home), "utf8")) as {
      ackedEndedRooms: string[];
    };
    expect(raw.ackedEndedRooms).toEqual(["r1"]);
  });

  test("a corrupt file degrades to the empty watermark rather than throwing", async () => {
    await mkdir(home, { recursive: true });
    await writeFile(watermarkFile(home), "{ not json");
    expect(await readWatermark(home)).toMatchObject({ briefPromoted: false, ackedEndedRooms: [] });
  });

  test("tolerant read drops malformed fields (non-array acked, non-string fingerprints)", async () => {
    await mkdir(home, { recursive: true });
    await writeFile(
      watermarkFile(home),
      JSON.stringify({
        ackedEndedRooms: "r1",
        lensFingerprints: { a: "t1", b: 7, c: null },
        briefPromoted: "yes",
        updatedAt: 5,
      }),
    );
    expect(await readWatermark(home)).toEqual({
      ackedEndedRooms: [],
      lensFingerprints: { a: "t1" },
      briefPromoted: false,
      updatedAt: "",
    });
  });

  test("overwriting leaves no stray temp file (atomic temp+rename)", async () => {
    await writeWatermark(
      { ackedEndedRooms: [], lensFingerprints: {}, briefPromoted: false, updatedAt: "a" },
      home,
    );
    await writeWatermark(
      { ackedEndedRooms: [], lensFingerprints: {}, briefPromoted: true, updatedAt: "b" },
      home,
    );
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(home);
    expect(entries.filter((e) => e.endsWith(".tmp"))).toEqual([]);
    expect((await readWatermark(home)).briefPromoted).toBe(true);
  });
});
