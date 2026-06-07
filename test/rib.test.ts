import { describe, expect, it } from "bun:test";
import rib from "../src/index.ts";

describe("rib-chamber", () => {
  it("exposes a chamber rib identity", () => {
    expect(rib.id).toBe("chamber");
    expect(rib.displayName).toBe("Chamber");
  });

  it("declares the roster, room, and brief views", () => {
    const keys = (rib.views ?? []).map((v) => v.key);
    expect(keys).toContain("rib:chamber:roster");
    expect(keys).toContain("rib:chamber:room");
    expect(keys).toContain("rib:chamber:brief");
  });

  it("exposes the genesis/retire and room-* controls", () => {
    const types = (rib.actions ?? []).map((a) => a.type);
    expect(types).toEqual(
      expect.arrayContaining([
        "genesis",
        "retire",
        "room-start",
        "room-next",
        "room-inject",
        "room-stop",
      ]),
    );
  });

  it("places the live room transcript in the surface row", () => {
    const row = rib.surfaces?.[0]?.layout.rows[0];
    expect(row?.columns[0]?.key).toBe("rib:chamber:room");
  });
});
