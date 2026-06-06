import { describe, expect, test } from "bun:test";
import { getStrategy, sequential } from "../../src/strategies/index.ts";

describe("strategy registry", () => {
  test("resolves sequential", () => {
    expect(getStrategy("sequential")).toBe(sequential);
  });

  test("concurrent aliases sequential (parallel execution deferred)", () => {
    expect(getStrategy("concurrent")).toBe(sequential);
  });

  test("group-chat and open-floor are not implemented yet", () => {
    expect(() => getStrategy("group-chat")).toThrow();
    expect(() => getStrategy("open-floor")).toThrow();
  });
});
