import { describe, expect, test } from "bun:test";
import { assertSafeSlug, buildGenesisPrompt, parseGenesisOutput, slugify } from "../src/genesis.ts";

describe("slugify", () => {
  test("kebab-cases a name", () => {
    expect(slugify("Scout the Researcher")).toBe("scout-the-researcher");
  });

  test("strips punctuation and collapses separators", () => {
    expect(slugify("  Ada, Lovelace!! ")).toBe("ada-lovelace");
  });

  test("a name with no letters or digits yields an empty slug", () => {
    expect(slugify("!!!")).toBe("");
  });

  test("the produced slug is always path-safe", () => {
    expect(() => assertSafeSlug(slugify("Scout / ../ Critic"))).not.toThrow();
  });
});

describe("assertSafeSlug", () => {
  test("rejects path traversal and separators", () => {
    expect(() => assertSafeSlug("../etc")).toThrow();
    expect(() => assertSafeSlug("a/b")).toThrow();
    expect(() => assertSafeSlug("")).toThrow();
    expect(() => assertSafeSlug("Caps")).toThrow();
  });
});

describe("buildGenesisPrompt", () => {
  test("embeds the brief and asks for the GenesisDocs JSON shape", () => {
    const prompt = buildGenesisPrompt({ name: "Scout", role: "researcher", voice: "terse" });
    expect(prompt).toContain("Scout");
    expect(prompt).toContain("researcher");
    expect(prompt).toContain("terse");
    expect(prompt).toContain('"soul"');
    expect(prompt).toContain('"tagline"');
  });
});

describe("parseGenesisOutput", () => {
  test("parses a clean JSON object", () => {
    const docs = parseGenesisOutput(
      '{"soul":"# Scout\\n## Persona\\nA researcher.","tagline":"Digs up facts."}',
    );
    expect(docs.soul).toContain("## Persona");
    expect(docs.tagline).toBe("Digs up facts.");
  });

  test("tolerates a code fence and surrounding preamble", () => {
    const raw = 'Here you go:\n```json\n{ "soul": "# Bo", "tagline": "Pressure-tests." }\n```\n';
    const docs = parseGenesisOutput(raw);
    expect(docs.soul).toBe("# Bo");
    expect(docs.tagline).toBe("Pressure-tests.");
  });

  test("truncates an over-long tagline to <=120 chars", () => {
    const long = "x".repeat(200);
    const docs = parseGenesisOutput(JSON.stringify({ soul: "# X", tagline: long }));
    expect(docs.tagline.length).toBeLessThanOrEqual(120);
  });

  test("fails closed on non-JSON", () => {
    expect(() => parseGenesisOutput("the model refused")).toThrow();
  });

  test("fails closed on a missing or empty soul", () => {
    expect(() => parseGenesisOutput('{"tagline":"x"}')).toThrow();
    expect(() => parseGenesisOutput('{"soul":"  ","tagline":"x"}')).toThrow();
  });

  test("fails closed on a missing tagline", () => {
    expect(() => parseGenesisOutput('{"soul":"# X"}')).toThrow();
  });
});
