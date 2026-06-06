import { describe, expect, it } from "bun:test";
import rib from "../src/index.ts";

describe("rib-chamber", () => {
  it("exposes a chamber rib identity", () => {
    expect(rib.id).toBe("chamber");
    expect(rib.displayName).toBe("Chamber");
  });
});
