import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canvasViewSchema } from "@keelson/shared";
import { buildRosterBoard } from "../src/boards/roster.ts";
import {
  type MindRecord,
  readMinds,
  readSoul,
  retireMind,
  scaffoldMind,
} from "../src/minds-store.ts";

let root: string;

const record = (over: Partial<MindRecord> = {}): MindRecord => ({
  slug: "scout",
  name: "Scout",
  role: "researcher",
  voice: "terse",
  persona: "Digs up facts.",
  createdAt: "2026-06-06T00:00:00.000Z",
  ...over,
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "chamber-minds-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("scaffoldMind", () => {
  test("writes the founding documents", async () => {
    await scaffoldMind(root, record(), "# Scout\n## Persona\nA researcher.");
    const dir = join(root, "scout");
    const soul = await readFile(join(dir, "SOUL.md"), "utf8");
    expect(soul).toContain("## Persona");
    const meta = JSON.parse(await readFile(join(dir, "mind.json"), "utf8")) as MindRecord;
    expect(meta.name).toBe("Scout");
    expect(meta.persona).toBe("Digs up facts.");
    // template-seeded working memory exists
    for (const f of ["AGENT.md", "memory.md", "rules.md", "log.md"]) {
      expect((await readFile(join(dir, f), "utf8")).length).toBeGreaterThan(0);
    }
  });

  test("refuses to clobber an existing Mind", async () => {
    await scaffoldMind(root, record(), "# Scout");
    await expect(scaffoldMind(root, record(), "# Scout again")).rejects.toThrow(/already exists/);
  });

  test("rejects an unsafe slug", async () => {
    await expect(scaffoldMind(root, record({ slug: "../escape" }), "# x")).rejects.toThrow();
  });
});

describe("readMinds", () => {
  test("returns the room-facing Mind shape, newest first", async () => {
    await scaffoldMind(root, record({ createdAt: "2026-01-01T00:00:00.000Z" }), "# Scout");
    await scaffoldMind(
      root,
      record({ slug: "critic", name: "Critic", createdAt: "2026-02-01T00:00:00.000Z" }),
      "# Critic",
    );
    const minds = await readMinds(root);
    expect(minds.map((m) => m.slug)).toEqual(["critic", "scout"]);
    expect(minds[0]?.name).toBe("Critic");
    expect(minds[0]?.persona).toBe("Digs up facts.");
  });

  test("carries model and tools through when present", async () => {
    await scaffoldMind(root, record({ model: "claude-x", tools: ["web"] }), "# Scout");
    const [mind] = await readMinds(root);
    expect(mind?.model).toBe("claude-x");
    expect(mind?.tools).toEqual(["web"]);
    expect(mind?.role).toBe("researcher");
  });

  test("an empty / missing data home yields an empty roster", async () => {
    expect(await readMinds(join(root, "nope"))).toEqual([]);
  });

  test("skips a directory without a parseable mind.json", async () => {
    await scaffoldMind(root, record(), "# Scout");
    await Bun.write(join(root, "junk", "notmind.txt"), "x");
    const minds = await readMinds(root);
    expect(minds.map((m) => m.slug)).toEqual(["scout"]);
  });

  test("a shape-drifted mind.json (valid JSON, bad shape) can't blank the roster", async () => {
    await scaffoldMind(root, record(), "# Scout");
    // valid JSON, but not a Mind record: would crash the sort/map if not guarded
    await Bun.write(join(root, "broken", "mind.json"), "null");
    await Bun.write(join(root, "nostrings", "mind.json"), JSON.stringify({ name: 42 }));
    const minds = await readMinds(root);
    expect(minds.map((m) => m.slug)).toEqual(["scout"]);
  });

  test("a record missing createdAt is kept (sorted last), not crashed on", async () => {
    await scaffoldMind(root, record({ createdAt: "2026-03-01T00:00:00.000Z" }), "# Scout");
    await Bun.write(
      join(root, "ada", "mind.json"),
      JSON.stringify({ name: "Ada", persona: "Computes." }), // no createdAt
    );
    const minds = await readMinds(root);
    expect(minds.map((m) => m.slug)).toEqual(["scout", "ada"]);
  });

  test("the directory name is the authoritative slug (ignores a drifted json slug)", async () => {
    await Bun.write(join(root, "realdir", "mind.json"), JSON.stringify(record({ slug: "ghost" })));
    const [mind] = await readMinds(root);
    expect(mind?.slug).toBe("realdir"); // not "ghost" — retire keys off the dir name
  });

  test("a record with a missing or non-string role reads back as an empty role", async () => {
    await Bun.write(
      join(root, "nora", "mind.json"),
      JSON.stringify({ name: "Nora", persona: "Notes.", createdAt: "2026-04-01T00:00:00.000Z" }),
    );
    await Bun.write(
      join(root, "numr", "mind.json"),
      JSON.stringify({
        name: "Numr",
        role: 7,
        persona: "Counts.",
        createdAt: "2026-04-02T00:00:00.000Z",
      }),
    );
    const minds = await readMinds(root);
    expect(minds.find((m) => m.slug === "nora")?.role).toBe("");
    expect(minds.find((m) => m.slug === "numr")?.role).toBe("");
  });

  test("the read-back minds build a valid roster board", async () => {
    await scaffoldMind(root, record(), "# Scout");
    const board = buildRosterBoard(await readMinds(root));
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
  });
});

describe("retireMind", () => {
  test("removes a Mind and is reflected in the next read", async () => {
    await scaffoldMind(root, record(), "# Scout");
    await retireMind(root, "scout");
    expect(await readMinds(root)).toEqual([]);
  });

  test("errors on an unknown slug and rejects an unsafe one", async () => {
    await expect(retireMind(root, "ghost")).rejects.toThrow(/not found/);
    await expect(retireMind(root, "../escape")).rejects.toThrow();
  });
});

describe("readSoul", () => {
  test("returns the authored SOUL.md body", async () => {
    await scaffoldMind(root, record(), "# Scout\n## Persona\nDigs up facts.");
    expect(await readSoul(root, "scout")).toContain("## Persona");
  });

  test("returns undefined for a missing Mind", async () => {
    expect(await readSoul(root, "nope")).toBeUndefined();
  });

  // Unlike the mutating helpers (which throw on a bad slug), readSoul is a
  // fail-soft read for the turn fallback: an unsafe slug returns undefined so the
  // room turn falls back to the tagline instead of rejecting the in-flight step.
  test("returns undefined (does not throw) for an unsafe slug", async () => {
    expect(await readSoul(root, "../escape")).toBeUndefined();
  });
});
