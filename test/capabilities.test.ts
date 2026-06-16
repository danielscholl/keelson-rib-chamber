import { describe, expect, test } from "bun:test";
import {
  CAPABILITIES,
  capabilityVocabulary,
  KNOWN_CAPABILITY_SLUGS,
  resolveMindTools,
} from "../src/capabilities.ts";
import { LENS_TOOL_NAME } from "../src/lens.ts";

const POOL = [{ name: LENS_TOOL_NAME }];

describe("resolveMindTools", () => {
  test("maps a declared slug to its tool name when the pool permits it", () => {
    expect(resolveMindTools({ tools: ["lens"] }, POOL)).toEqual([{ name: LENS_TOOL_NAME }]);
  });

  test("no declaration stays text-only", () => {
    expect(resolveMindTools({}, POOL)).toEqual([]);
    expect(resolveMindTools({ tools: [] }, POOL)).toEqual([]);
  });

  test("an unknown slug resolves to nothing", () => {
    expect(resolveMindTools({ tools: ["bogus"] }, POOL)).toEqual([]);
  });

  test("a raw tool name is not a slug — only the curated vocabulary maps", () => {
    expect(resolveMindTools({ tools: [LENS_TOOL_NAME] }, POOL)).toEqual([]);
  });

  test("a known slug absent from the room pool is dropped — the pool is the ceiling", () => {
    expect(resolveMindTools({ tools: ["lens"] }, [])).toEqual([]);
    expect(resolveMindTools({ tools: ["lens"] }, undefined)).toEqual([]);
  });

  test("repeated slugs dedupe to one entry", () => {
    expect(resolveMindTools({ tools: ["lens", "lens"] }, POOL)).toEqual([{ name: LENS_TOOL_NAME }]);
  });

  test("KNOWN_CAPABILITY_SLUGS mirrors the map keys", () => {
    expect([...KNOWN_CAPABILITY_SLUGS].sort()).toEqual(Object.keys(CAPABILITIES).sort());
    expect(KNOWN_CAPABILITY_SLUGS.has("lens")).toBe(true);
  });

  test("capabilityVocabulary lists every known slug with its gloss", () => {
    const doc = capabilityVocabulary();
    for (const slug of KNOWN_CAPABILITY_SLUGS) expect(doc).toContain(slug);
    expect(doc).toContain("lens (");
  });
});
