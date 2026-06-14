import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSeedFor,
  composeMindSystemPrompt,
  ENTER_OPENING_PROMPT,
  MIND_PROMPT_BUDGET,
} from "../src/compose.ts";
import { type MindRecord, scaffoldMind } from "../src/minds-store.ts";
import type { Mind } from "../src/types.ts";

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

const mind = (over: Partial<Mind> = {}): Mind => ({
  slug: "scout",
  name: "Scout",
  persona: "Digs up facts.",
  ...over,
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "chamber-compose-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("composeMindSystemPrompt", () => {
  test("stacks the SOUL identity and the direct-chat footer", async () => {
    await scaffoldMind(root, record(), "# Scout\n\nI am Scout, a relentless researcher.");
    const prompt = await composeMindSystemPrompt(root, mind());
    expect(prompt).toContain("## Identity");
    expect(prompt).toContain("relentless researcher");
    expect(prompt).toContain("## Direct-chat operating rules");
    expect(prompt).toContain("greet the operator");
  });

  test("omits template memory and rules sections for a fresh Mind", async () => {
    await scaffoldMind(root, record(), "# Scout\n\nIdentity body.");
    const prompt = await composeMindSystemPrompt(root, mind());
    expect(prompt).not.toContain("## Durable memory");
    expect(prompt).not.toContain("## Operating rules");
    // the genesis log line is real substance and is kept
    expect(prompt).toContain("## Recent log");
  });

  test("keeps real memory content even when it uses an italic parenthetical", async () => {
    await scaffoldMind(root, record(), "# Scout\n\nIdentity body.");
    await writeFile(
      join(root, "scout", "memory.md"),
      "# Working memory\n\n_(launch ships Friday)_",
    );
    const prompt = await composeMindSystemPrompt(root, mind());
    expect(prompt).toContain("## Durable memory");
    expect(prompt).toContain("launch ships Friday");
  });

  test("includes memory and rules once they carry substance", async () => {
    await scaffoldMind(root, record(), "# Scout\n\nIdentity body.");
    await writeFile(
      join(root, "scout", "memory.md"),
      "# Working memory\n\nPrefers primary sources.",
    );
    await writeFile(join(root, "scout", "rules.md"), "# Rules\n\nNever pad a thin answer.");
    const prompt = await composeMindSystemPrompt(root, mind());
    expect(prompt).toContain("## Durable memory");
    expect(prompt).toContain("Prefers primary sources.");
    expect(prompt).toContain("## Operating rules");
    expect(prompt).toContain("Never pad a thin answer.");
  });

  test("falls back to the roster persona when SOUL.md is missing", async () => {
    // no scaffold — the minds dir doesn't exist at all
    const prompt = await composeMindSystemPrompt(root, mind({ persona: "Fallback identity." }));
    expect(prompt).toContain("Fallback identity.");
    expect(prompt).toContain("## Direct-chat operating rules");
  });

  test("an unsafe slug degrades to the persona fallback without throwing", async () => {
    const prompt = await composeMindSystemPrompt(
      root,
      mind({ slug: "../escape", persona: "Safe." }),
    );
    expect(prompt).toContain("Safe.");
  });

  test("a giant log is tail-truncated and the result stays within budget", async () => {
    await scaffoldMind(root, record(), "# Scout\n\nIdentity body.");
    const huge = `# Log\n\n${"old filler line\n".repeat(2000)}MOST_RECENT_ENTRY\n`;
    await writeFile(join(root, "scout", "log.md"), huge);
    const prompt = await composeMindSystemPrompt(root, mind());
    expect(prompt.length).toBeLessThanOrEqual(MIND_PROMPT_BUDGET);
    expect(prompt).toContain("MOST_RECENT_ENTRY"); // the tail survives
    expect(prompt).toContain("## Identity"); // identity is never dropped
  });

  test("a giant SOUL alone is clamped within budget", async () => {
    await scaffoldMind(root, record(), `# Scout\n\n${"x".repeat(20000)}`);
    const prompt = await composeMindSystemPrompt(root, mind());
    expect(prompt.length).toBeLessThanOrEqual(MIND_PROMPT_BUDGET);
    expect(prompt).toContain("## Direct-chat operating rules");
  });
});

describe("buildSeedFor", () => {
  test("returns a seed with the composed prompt, clamped name, and opener", async () => {
    await scaffoldMind(root, record(), "# Scout\n\nIdentity body.");
    const seed = await buildSeedFor(root, mind());
    expect(seed.systemPrompt).toContain("## Identity");
    expect(seed.systemPrompt.length).toBeLessThanOrEqual(MIND_PROMPT_BUDGET);
    expect(seed.name).toBe("Scout");
    expect(seed.openingPrompt).toBe(ENTER_OPENING_PROMPT);
  });

  test("clamps an over-long name to 80 chars", async () => {
    const seed = await buildSeedFor(root, mind({ name: "N".repeat(120) }));
    expect(seed.name.length).toBe(80);
  });

  test("carries the Mind's model when set, omits it otherwise", async () => {
    expect((await buildSeedFor(root, mind())).model).toBeUndefined();
    expect((await buildSeedFor(root, mind({ model: "claude-sonnet-4-6" }))).model).toBe(
      "claude-sonnet-4-6",
    );
  });

  test("carries the Mind's provider as providerId when set, omits it otherwise", async () => {
    expect((await buildSeedFor(root, mind())).providerId).toBeUndefined();
    expect((await buildSeedFor(root, mind({ provider: "claude" }))).providerId).toBe("claude");
  });
});
