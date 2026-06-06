import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canvasViewSchema } from "@keelson/shared";
import { buildRosterBoard } from "../src/boards/roster.ts";
import { type MindRecord, readMinds, retireMind, scaffoldMind } from "../src/minds-store.ts";

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
