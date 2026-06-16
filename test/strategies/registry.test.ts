import { describe, expect, test } from "bun:test";
import {
  concurrent,
  getStrategy,
  groupChat,
  openFloor,
  review,
  sequential,
} from "../../src/strategies/index.ts";

describe("strategy registry", () => {
  test("resolves sequential", () => {
    expect(getStrategy("sequential")).toBe(sequential);
  });

  test("resolves concurrent (its own parallel strategy, no longer a sequential alias)", () => {
    expect(getStrategy("concurrent")).toBe(concurrent);
    expect(getStrategy("concurrent")).not.toBe(sequential);
  });

  test("resolves group-chat", () => {
    expect(getStrategy("group-chat")).toBe(groupChat);
  });

  test("resolves open-floor", () => {
    expect(getStrategy("open-floor")).toBe(openFloor);
  });

  test("resolves review", () => {
    expect(getStrategy("review")).toBe(review);
  });

  test("does not resolve inherited Object members as strategies", () => {
    // A bare index would return Object.prototype members for these names; the
    // lookup must be own-property only so a crafted strategy string is rejected.
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(() => getStrategy(name as Parameters<typeof getStrategy>[0])).toThrow();
    }
  });
});
