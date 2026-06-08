import { describe, expect, test } from "bun:test";
import { getStrategy, groupChat, sequential } from "../../src/strategies/index.ts";

describe("strategy registry", () => {
  test("resolves sequential", () => {
    expect(getStrategy("sequential")).toBe(sequential);
  });

  test("concurrent aliases sequential (parallel execution deferred)", () => {
    expect(getStrategy("concurrent")).toBe(sequential);
  });

  test("resolves group-chat", () => {
    expect(getStrategy("group-chat")).toBe(groupChat);
  });

  test("open-floor is not implemented yet", () => {
    expect(() => getStrategy("open-floor")).toThrow();
  });
});
