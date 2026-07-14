import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearDraft,
  draftFile,
  readDraft,
  setAssembling,
  toggleSelected,
} from "../src/room-draft.ts";

describe("room-draft persistence (inclusion set + assembly mode)", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "chamber-draft-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test("a missing file reads as the empty default (not assembling, nobody selected)", async () => {
    const draft = await readDraft(home);
    expect(draft.assembling).toBe(false);
    expect([...draft.selected]).toEqual([]);
  });

  test("toggle seats then unseats a slug, persisting across reads", async () => {
    await toggleSelected("ada", home);
    expect([...(await readDraft(home)).selected]).toEqual(["ada"]);
    // A second toggle of the same slug unseats it (back to nobody).
    await toggleSelected("ada", home);
    expect([...(await readDraft(home)).selected]).toEqual([]);
  });

  test("the persisted file holds { assembling, selected: [...] } at the data-home path", async () => {
    await setAssembling(true, home);
    await toggleSelected("bo", home);
    const raw = JSON.parse(await readFile(draftFile(home), "utf8")) as {
      assembling: boolean;
      selected: string[];
    };
    expect(raw).toEqual({ assembling: true, selected: ["bo"] });
  });

  test("selection is independent per slug", async () => {
    await toggleSelected("ada", home);
    await toggleSelected("bo", home);
    expect([...(await readDraft(home)).selected].sort()).toEqual(["ada", "bo"]);
    await toggleSelected("ada", home);
    expect([...(await readDraft(home)).selected]).toEqual(["bo"]);
  });

  test("setAssembling(true) opens without disturbing the selection", async () => {
    await toggleSelected("ada", home);
    await setAssembling(true, home);
    const draft = await readDraft(home);
    expect(draft.assembling).toBe(true);
    expect([...draft.selected]).toEqual(["ada"]);
  });

  test("setAssembling(false) leaves assembly AND clears the cast", async () => {
    await setAssembling(true, home);
    await toggleSelected("ada", home);
    await toggleSelected("bo", home);
    await setAssembling(false, home);
    const draft = await readDraft(home);
    expect(draft.assembling).toBe(false);
    expect([...draft.selected]).toEqual([]);
  });

  test("clearDraft resets to the empty default", async () => {
    await setAssembling(true, home);
    await toggleSelected("ada", home);
    await clearDraft(home);
    const draft = await readDraft(home);
    expect(draft.assembling).toBe(false);
    expect([...draft.selected]).toEqual([]);
  });

  test("a corrupt file degrades to the empty default rather than throwing", async () => {
    await mkdir(home, { recursive: true });
    await writeFile(draftFile(home), "{ not json");
    const draft = await readDraft(home);
    expect(draft.assembling).toBe(false);
    expect([...draft.selected]).toEqual([]);
  });

  test("a well-formed file with a non-array selected degrades to no selection", async () => {
    await mkdir(home, { recursive: true });
    await writeFile(draftFile(home), JSON.stringify({ assembling: true, selected: "ada" }));
    const draft = await readDraft(home);
    expect(draft.assembling).toBe(true);
    expect([...draft.selected]).toEqual([]);
  });

  test("non-string entries in selected are dropped", async () => {
    await mkdir(home, { recursive: true });
    await writeFile(
      draftFile(home),
      JSON.stringify({ assembling: false, selected: ["ada", 7, null, "bo"] }),
    );
    expect([...(await readDraft(home)).selected].sort()).toEqual(["ada", "bo"]);
  });
});
