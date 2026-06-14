import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldMind } from "../src/minds-store.ts";
import { mindsDir } from "../src/paths.ts";
import { listPersonas, resolvePersona } from "../src/personas.ts";

let workspace: string;
let prev: string | undefined;

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "chamber-personas-"));
  prev = process.env.KEELSON_WORKSPACE;
  process.env.KEELSON_WORKSPACE = workspace;
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
  if (prev === undefined) delete process.env.KEELSON_WORKSPACE;
  else process.env.KEELSON_WORKSPACE = prev;
  await rm(workspace, { recursive: true, force: true });
});

describe("listPersonas", () => {
  it("maps each Mind to slug/name/description, newest first", async () => {
    const personas = await listPersonas();
    expect(personas).toEqual([
      { slug: "bo", name: "Bo", description: "Ships things." },
      { slug: "ada", name: "Ada", description: "Digs up facts." },
    ]);
  });
});

describe("listPersonas clamping", () => {
  it("clamps an over-long name and description to the persona summary caps", async () => {
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
    const p = (await listPersonas()).find((x) => x.slug === "verbose");
    expect(p?.name.length).toBe(80);
    expect(p?.description.length).toBe(280);
  });
});

describe("resolvePersona", () => {
  it("resolves a known slug to a seed carrying the soul", async () => {
    const seed = await resolvePersona("ada");
    expect(seed).not.toBeNull();
    expect(seed?.name).toBe("Ada");
    expect(seed?.systemPrompt).toContain("relentless researcher");
    expect(seed?.systemPrompt.length).toBeLessThanOrEqual(8000);
    expect(seed?.openingPrompt.length).toBeGreaterThan(0);
  });

  it("returns null for an unknown slug", async () => {
    expect(await resolvePersona("ghost")).toBeNull();
  });

  it("returns null for an unsafe slug without throwing", async () => {
    expect(await resolvePersona("../escape")).toBeNull();
  });
});
