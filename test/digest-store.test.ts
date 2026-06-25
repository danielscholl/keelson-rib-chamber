import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanvasBoardView } from "@keelson/shared";
import {
  coldStartDigestBoard,
  type DigestRecord,
  digestFile,
  readDigest,
  writeDigest,
} from "../src/digest-store.ts";

const board: CanvasBoardView = {
  view: "board",
  title: "Digest",
  sections: [{ kind: "rows", items: [{ text: "live", glyph: "ok" }] }],
};

const record = (over: Partial<DigestRecord> = {}): DigestRecord => ({
  board,
  fingerprint: "fp-1",
  ...over,
});

describe("digest store", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "chamber-digest-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test("a missing file reads as null (cold start)", async () => {
    expect(await readDigest(home)).toBeNull();
  });

  test("round-trips an authored digest across writes", async () => {
    const r = record();
    await writeDigest(r, home);
    expect(await readDigest(home)).toEqual(r);
  });

  test("persists the file at the data-home path", async () => {
    await writeDigest(record({ fingerprint: "fp-x" }), home);
    const raw = JSON.parse(await readFile(digestFile(home), "utf8")) as { fingerprint: string };
    expect(raw.fingerprint).toBe("fp-x");
  });

  test("a corrupt file degrades to null rather than throwing", async () => {
    await mkdir(home, { recursive: true });
    await writeFile(digestFile(home), "{ not json");
    expect(await readDigest(home)).toBeNull();
  });

  test("a record missing the board or fingerprint reads as null", async () => {
    await mkdir(home, { recursive: true });
    await writeFile(digestFile(home), JSON.stringify({ fingerprint: "fp", updatedAt: "t" }));
    expect(await readDigest(home)).toBeNull();
    await writeFile(digestFile(home), JSON.stringify({ board, updatedAt: "t" }));
    expect(await readDigest(home)).toBeNull();
  });

  test("ignores unknown fields, returning just board + fingerprint", async () => {
    await mkdir(home, { recursive: true });
    await writeFile(digestFile(home), JSON.stringify({ board, fingerprint: "fp", extra: 5 }));
    expect(await readDigest(home)).toEqual({ board, fingerprint: "fp" });
  });

  test("overwriting leaves no stray temp file (atomic temp+rename)", async () => {
    await writeDigest(record({ fingerprint: "fp-a" }), home);
    await writeDigest(record({ fingerprint: "fp-b" }), home);
    const entries = await readdir(home);
    expect(entries.filter((e) => e.endsWith(".tmp"))).toEqual([]);
    expect((await readDigest(home))?.fingerprint).toBe("fp-b");
  });

  test("coldStartDigestBoard is a valid, titled board", () => {
    const cold = coldStartDigestBoard();
    expect(cold.view).toBe("board");
    expect(cold.title).toBe("Digest");
    expect(cold.sections.length).toBeGreaterThan(0);
  });
});
