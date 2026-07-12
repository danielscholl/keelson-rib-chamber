import { describe, expect, test } from "bun:test";
import { normalizeGrounding } from "../src/index.ts";

describe("normalizeGrounding", () => {
  test("trims, drops empties, and returns the shared Brief shape", () => {
    expect(
      normalizeGrounding({ sourceUrl: "  https://x  ", criteria: [" a ", "", "  ", "b"] }),
    ).toEqual({ sourceUrl: "https://x", criteria: ["a", "b"] });
  });

  test("returns undefined for an all-empty brief (a room without grounding is unchanged)", () => {
    expect(normalizeGrounding(undefined)).toBeUndefined();
    expect(normalizeGrounding({ criteria: ["", "   "] })).toBeUndefined();
    expect(normalizeGrounding({ sourceUrl: "   " })).toBeUndefined();
  });

  test("collapses internal whitespace so a criterion stays single-line (lossless restart join)", () => {
    const g = normalizeGrounding({ criteria: ["first line\ncontinuation", "  a\t b "] });
    expect(g?.criteria).toEqual(["first line continuation", "a b"]);
  });

  test("bounds an oversized brief: caps the criteria count and each length", () => {
    // The brief is re-serialized into every prompt, so an unbounded one would multiply
    // billed input — normalization is the choke point that caps it.
    const g = normalizeGrounding({
      sourceUrl: "u".repeat(2000),
      criteria: Array.from({ length: 50 }, () => "x".repeat(2000)),
    });
    expect(g?.criteria).toHaveLength(20);
    expect(g?.criteria.every((c) => c.length <= 500)).toBe(true);
    expect((g?.sourceUrl ?? "").length).toBeLessThanOrEqual(500);
  });
});
