import { describe, expect, test } from "bun:test";
import { assertSafeSlug } from "../src/genesis.ts";
import { GENESIS_STARTERS } from "../src/starters.ts";

describe("genesis starters", () => {
  test("ships the three archetypes with safe slugs", () => {
    expect(GENESIS_STARTERS.map((s) => s.slug)).toEqual(["moneypenny", "mycroft", "jarvis"]);
    for (const s of GENESIS_STARTERS) {
      expect(() => assertSafeSlug(s.slug)).not.toThrow();
      expect(s.name.length).toBeGreaterThan(0);
      expect(s.tagline.length).toBeGreaterThan(0);
    }
  });

  test("each starter is generative — the brief tells the agent to author fresh", () => {
    for (const s of GENESIS_STARTERS) {
      expect(s.voiceDescription).toMatch(/do not copy a prebaked template/i);
      expect(s.voiceDescription).toMatch(/model-local knowledge/i);
    }
  });
});
