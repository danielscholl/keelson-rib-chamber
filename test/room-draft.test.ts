import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearDraft, draftFile, readDraft, toggleSelected } from "../src/room-draft.ts";

describe("room-draft persistence (the inclusion set)", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "chamber-draft-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test("a missing file reads as the empty default (nobody selected)", async () => {
    expect([...(await readDraft(home)).selected]).toEqual([]);
  });

  test("toggle seats then unseats a slug, persisting across reads", async () => {
    await toggleSelected("ada", home);
    expect([...(await readDraft(home)).selected]).toEqual(["ada"]);
    // A second toggle of the same slug unseats it (back to nobody).
    await toggleSelected("ada", home);
    expect([...(await readDraft(home)).selected]).toEqual([]);
  });

  test("the persisted file holds { selected: [...] } at the data-home path", async () => {
    await toggleSelected("bo", home);
    const raw = JSON.parse(await readFile(draftFile(home), "utf8")) as unknown;
    expect(raw).toEqual({ selected: ["bo"] });
  });

  test("selection is independent per slug", async () => {
    await toggleSelected("ada", home);
    await toggleSelected("bo", home);
    expect([...(await readDraft(home)).selected].sort()).toEqual(["ada", "bo"]);
    await toggleSelected("ada", home);
    expect([...(await readDraft(home)).selected]).toEqual(["bo"]);
  });

  test("clearDraft empties the cast", async () => {
    await toggleSelected("ada", home);
    await toggleSelected("bo", home);
    await clearDraft(home);
    expect([...(await readDraft(home)).selected]).toEqual([]);
  });

  test("a corrupt file degrades to the empty default rather than throwing", async () => {
    await mkdir(home, { recursive: true });
    await writeFile(draftFile(home), "{ not json");
    expect([...(await readDraft(home)).selected]).toEqual([]);
  });

  test("a well-formed file with a non-array selected degrades to no selection", async () => {
    await mkdir(home, { recursive: true });
    await writeFile(draftFile(home), JSON.stringify({ selected: "ada" }));
    expect([...(await readDraft(home)).selected]).toEqual([]);
  });

  test("non-string entries in selected are dropped", async () => {
    await mkdir(home, { recursive: true });
    await writeFile(draftFile(home), JSON.stringify({ selected: ["ada", 7, null, "bo"] }));
    expect([...(await readDraft(home)).selected].sort()).toEqual(["ada", "bo"]);
  });

  test("a draft written before assembly was derived reads for its cast, stale key ignored", async () => {
    await mkdir(home, { recursive: true });
    await writeFile(draftFile(home), JSON.stringify({ assembling: true, selected: ["ada"] }));
    const draft = await readDraft(home);
    expect([...draft.selected]).toEqual(["ada"]);
    expect(draft).not.toHaveProperty("assembling");
    // The next write drops the legacy key rather than carrying it forward.
    await toggleSelected("bo", home);
    expect(JSON.parse(await readFile(draftFile(home), "utf8")) as unknown).toEqual({
      selected: ["ada", "bo"],
    });
  });
});
