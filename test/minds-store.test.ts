import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canvasViewSchema } from "@keelson/shared";
import { buildRosterBoard } from "../src/boards/roster.ts";
import {
  appendLog,
  LOG_ENTRY_CAP,
  LOG_MAX_ENTRIES,
  listMindRecords,
  MEMORY_DOC_CAP,
  type MindRecord,
  readMindDoc,
  readMinds,
  readSoul,
  retireMind,
  scaffoldMind,
  setMindModel,
  writeMemory,
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

describe("listMindRecords", () => {
  test("carries the server-stamped createdAt readMinds drops, newest first", async () => {
    await scaffoldMind(root, record({ createdAt: "2026-01-01T00:00:00.000Z" }), "# Scout");
    await scaffoldMind(
      root,
      record({ slug: "critic", name: "Critic", createdAt: "2026-02-01T00:00:00.000Z" }),
      "# Critic",
    );
    const records = await listMindRecords(root);
    expect(records.map((r) => r.slug)).toEqual(["critic", "scout"]);
    expect(records.map((r) => r.createdAt)).toEqual([
      "2026-02-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    ]);
  });

  test("a missing data home yields []", async () => {
    expect(await listMindRecords(join(root, "nope"))).toEqual([]);
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

describe("setMindModel", () => {
  test("sets model and provider on an existing Mind", async () => {
    await scaffoldMind(root, record(), "# Scout");
    await setMindModel(root, "scout", { model: " claude-opus-4.8 ", provider: " anthropic " });
    const [mind] = await readMinds(root);
    expect(mind?.model).toBe("claude-opus-4.8");
    expect(mind?.provider).toBe("anthropic");
  });

  test("sets model alone and drops provider", async () => {
    await scaffoldMind(root, record({ provider: "anthropic" }), "# Scout");
    await setMindModel(root, "scout", { model: "gpt-5.3-codex" });
    const [mind] = await readMinds(root);
    expect(mind?.model).toBe("gpt-5.3-codex");
    expect(mind?.provider).toBeUndefined();
  });

  test("blank model clears both model and provider", async () => {
    await scaffoldMind(
      root,
      record({ model: "claude-opus-4.8", provider: "anthropic" }),
      "# Scout",
    );
    await setMindModel(root, "scout", { model: " " });
    const [mind] = await readMinds(root);
    expect(mind?.model).toBeUndefined();
    expect(mind?.provider).toBeUndefined();
  });

  test("rejects provider without model", async () => {
    await scaffoldMind(root, record(), "# Scout");
    await expect(setMindModel(root, "scout", { provider: "anthropic" })).rejects.toThrow(
      /requires a model/,
    );
  });

  test("throws on unknown slug", async () => {
    await expect(setMindModel(root, "ghost", { model: "claude-opus-4.8" })).rejects.toThrow(
      /not found/,
    );
  });

  test("throws on unsafe slug", async () => {
    await expect(setMindModel(root, "../escape", { model: "claude-opus-4.8" })).rejects.toThrow();
  });

  test("preserves other mind record fields", async () => {
    await scaffoldMind(root, record({ tools: ["web"] }), "# Scout");
    await setMindModel(root, "scout", { model: "claude-opus-4.8", provider: "anthropic" });
    const rec = JSON.parse(await readFile(join(root, "scout", "mind.json"), "utf8")) as MindRecord;
    expect(rec.name).toBe("Scout");
    expect(rec.role).toBe("researcher");
    expect(rec.voice).toBe("terse");
    expect(rec.persona).toBe("Digs up facts.");
    expect(rec.tools).toEqual(["web"]);
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

describe("writeMemory", () => {
  test("overwrites memory.md with the consolidated text (revise, not append)", async () => {
    await scaffoldMind(root, record(), "# Scout\n\nIdentity.");
    await writeMemory(root, "scout", "# Working memory\n\n- Learned X.");
    expect(await readMindDoc(root, "scout", "memory.md")).toContain("Learned X.");
    // A second write REPLACES the first (consolidation), it does not append.
    await writeMemory(root, "scout", "# Working memory\n\n- Learned Y.");
    const memory = await readMindDoc(root, "scout", "memory.md");
    expect(memory).toContain("Learned Y.");
    expect(memory).not.toContain("Learned X.");
  });

  test("rejects over-cap text (fail closed), leaving the prior memory untouched", async () => {
    await scaffoldMind(root, record(), "# Scout\n\nIdentity.");
    await writeMemory(root, "scout", "kept memory");
    await expect(writeMemory(root, "scout", "x".repeat(MEMORY_DOC_CAP + 1))).rejects.toThrow(
      /exceeds/,
    );
    expect(await readMindDoc(root, "scout", "memory.md")).toContain("kept memory");
  });

  test("fails closed on a missing Mind and an unsafe slug", async () => {
    await expect(writeMemory(root, "ghost", "x")).rejects.toThrow(/not found/);
    await expect(writeMemory(root, "../escape", "x")).rejects.toThrow();
  });
});

describe("appendLog", () => {
  test("appends a timestamped, single-line entry under the header", async () => {
    await scaffoldMind(root, record(), "# Scout\n\nIdentity.");
    await appendLog(root, "scout", "reviewed the\nrelease  plan", "2026-06-26T00:00:00.000Z");
    const log = await readMindDoc(root, "scout", "log.md");
    expect(log).toContain("# Log");
    // a multi-line / multi-space entry is collapsed to one bullet line
    expect(log).toContain("- 2026-06-26T00:00:00.000Z — reviewed the release plan");
    // the genesis line is still present
    expect(log).toContain("genesis");
  });

  test("bounds the journal to the most recent LOG_MAX_ENTRIES entries", async () => {
    await scaffoldMind(root, record(), "# Scout\n\nIdentity.");
    for (let i = 0; i < LOG_MAX_ENTRIES + 10; i++) {
      await appendLog(root, "scout", `entry ${i}`, "2026-06-26T00:00:00.000Z");
    }
    const log = (await readMindDoc(root, "scout", "log.md")) ?? "";
    const bullets = log.split("\n").filter((l) => l.startsWith("- "));
    expect(bullets.length).toBe(LOG_MAX_ENTRIES);
    // the newest survives; the oldest (the genesis line) aged out
    expect(log).toContain(`entry ${LOG_MAX_ENTRIES + 9}`);
    expect(log).not.toContain("genesis");
  });

  test("caps a runaway entry at LOG_ENTRY_CAP characters", async () => {
    await scaffoldMind(root, record(), "# Scout\n\nIdentity.");
    await appendLog(root, "scout", "x".repeat(LOG_ENTRY_CAP * 2), "2026-06-26T00:00:00.000Z");
    const log = (await readMindDoc(root, "scout", "log.md")) ?? "";
    const entry = log.split("\n").find((l) => l.includes("xxxx")) ?? "";
    expect(entry.length).toBe(LOG_ENTRY_CAP);
  });

  test("fails closed on a missing Mind and an unsafe slug", async () => {
    await expect(appendLog(root, "ghost", "x", "t")).rejects.toThrow(/not found/);
    await expect(appendLog(root, "../escape", "x", "t")).rejects.toThrow();
  });
});
