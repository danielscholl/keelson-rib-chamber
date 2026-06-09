import { describe, expect, test } from "bun:test";
import { getStrategy, groupChat, openFloor, sequential } from "../../src/strategies/index.ts";

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

  test("resolves open-floor", () => {
    expect(getStrategy("open-floor")).toBe(openFloor);
  });

  test("does not resolve inherited Object members as strategies", () => {
    // A bare index would return Object.prototype members for these names; the
    // lookup must be own-property only so a crafted strategy string is rejected.
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(() => getStrategy(name as Parameters<typeof getStrategy>[0])).toThrow();
    }
  });
});
