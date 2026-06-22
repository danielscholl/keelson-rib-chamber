import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listAgents, resolveAgent } from "../src/agents.ts";
import { scaffoldMind } from "../src/minds-store.ts";
import { mindsDir, setChamberDataHome } from "../src/paths.ts";

let workspace: string;

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "chamber-agents-"));
  setChamberDataHome(join(workspace, "chamber"));
  await scaffoldMind(
    mindsDir(),
    {
      slug: "ada",
      name: "Ada",
      role: "researcher",
      voice: "terse",
      persona: "Digs up facts.",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    "I am Ada, a relentless researcher.",
  );
  await scaffoldMind(
    mindsDir(),
    {
      slug: "bo",
      name: "Bo",
      role: "builder",
      voice: "warm",
      persona: "Ships things.",
      createdAt: "2026-02-01T00:00:00.000Z",
    },
    "I am Bo, a builder.",
  );
});

afterAll(async () => {
  setChamberDataHome(undefined);
  await rm(workspace, { recursive: true, force: true });
});

describe("listAgents", () => {
  it("maps each Mind to slug/name/description, newest first", async () => {
    const agents = await listAgents();
    expect(agents).toEqual([
      { slug: "bo", name: "Bo", description: "Ships things." },
      { slug: "ada", name: "Ada", description: "Digs up facts." },
    ]);
  });
});

describe("listAgents clamping", () => {
  it("clamps an over-long name and description to the agent summary caps", async () => {
    await scaffoldMind(
      mindsDir(),
      {
        slug: "verbose",
        name: "N".repeat(120),
        role: "r",
        voice: "v",
        persona: "p".repeat(400),
        createdAt: "2026-03-01T00:00:00.000Z",
      },
      "Verbose soul.",
    );
    const a = (await listAgents()).find((x) => x.slug === "verbose");
    expect(a?.name.length).toBe(80);
    expect(a?.description.length).toBe(280);
  });
});

describe("resolveAgent", () => {
  it("resolves a known slug to a seed carrying the soul", async () => {
    const seed = await resolveAgent("ada");
    expect(seed).not.toBeNull();
    expect(seed?.name).toBe("Ada");
    expect(seed?.systemPrompt).toContain("relentless researcher");
    expect(seed?.systemPrompt.length).toBeLessThanOrEqual(8000);
    expect(seed?.openingPrompt.length).toBeGreaterThan(0);
  });

  it("carries the Mind's model into the seed when set, omits it otherwise", async () => {
    await scaffoldMind(
      mindsDir(),
      {
        slug: "tuned",
        name: "Tuned",
        role: "r",
        voice: "v",
        persona: "Runs on a pinned model.",
        model: "claude-sonnet-4-6",
        createdAt: "2026-04-01T00:00:00.000Z",
      },
      "Tuned soul.",
    );
    expect((await resolveAgent("tuned"))?.model).toBe("claude-sonnet-4-6");
    expect((await resolveAgent("ada"))?.model).toBeUndefined();
  });

  it("returns null for an unknown slug", async () => {
    expect(await resolveAgent("ghost")).toBeNull();
  });

  it("returns null for an unsafe slug without throwing", async () => {
    expect(await resolveAgent("../escape")).toBeNull();
  });
});
