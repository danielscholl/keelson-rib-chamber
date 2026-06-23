import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearDraft,
  draftFile,
  readDraftExclusion,
  toggleDraftExclusion,
} from "../src/room-draft.ts";

describe("room-draft persistence (exclusion set)", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "chamber-draft-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test("a missing file reads as an empty (all-selected) set", async () => {
    expect([...(await readDraftExclusion(home))]).toEqual([]);
  });

  test("toggle adds then removes a slug, persisting across reads", async () => {
    await toggleDraftExclusion("ada", home);
    expect([...(await readDraftExclusion(home))]).toEqual(["ada"]);
    // A second toggle of the same slug removes it (back to all-selected).
    await toggleDraftExclusion("ada", home);
    expect([...(await readDraftExclusion(home))]).toEqual([]);
  });

  test("the persisted file holds { excluded: [...] } at the data-home path", async () => {
    await toggleDraftExclusion("bo", home);
    const raw = JSON.parse(await readFile(draftFile(home), "utf8")) as { excluded: string[] };
    expect(raw.excluded).toEqual(["bo"]);
  });

  test("toggle is independent per slug", async () => {
    await toggleDraftExclusion("ada", home);
    await toggleDraftExclusion("bo", home);
    expect([...(await readDraftExclusion(home))].sort()).toEqual(["ada", "bo"]);
    await toggleDraftExclusion("ada", home);
    expect([...(await readDraftExclusion(home))]).toEqual(["bo"]);
  });

  test("clearDraft resets to the empty (all-selected) set", async () => {
    await toggleDraftExclusion("ada", home);
    await toggleDraftExclusion("bo", home);
    await clearDraft(home);
    expect([...(await readDraftExclusion(home))]).toEqual([]);
  });

  test("a corrupt file degrades to an empty set rather than throwing", async () => {
    await mkdir(home, { recursive: true });
    await writeFile(draftFile(home), "{ not json");
    expect([...(await readDraftExclusion(home))]).toEqual([]);
  });

  test("a well-formed file with a non-array excluded degrades to empty", async () => {
    await mkdir(home, { recursive: true });
    await writeFile(draftFile(home), JSON.stringify({ excluded: "ada" }));
    expect([...(await readDraftExclusion(home))]).toEqual([]);
  });

  test("non-string entries in excluded are dropped", async () => {
    await mkdir(home, { recursive: true });
    await writeFile(draftFile(home), JSON.stringify({ excluded: ["ada", 7, null, "bo"] }));
    expect([...(await readDraftExclusion(home))].sort()).toEqual(["ada", "bo"]);
  });
});
