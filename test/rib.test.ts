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

  it("lists genesis/retire as static actions; room controls are board-baked", () => {
    const types = (rib.actions ?? []).map((a) => a.type);
    expect(types).toEqual(expect.arrayContaining(["genesis", "retire"]));
    // Room controls need a payload, so they are baked into the boards, not the
    // payload-less static actions[] (which would always fail from the panel).
    expect(types).not.toContain("room-start");
    expect(types).not.toContain("room-inject");
  });

  it("places the live room transcript in the surface row", () => {
    const row = rib.surfaces?.[0]?.layout.rows[0];
    expect(row?.columns[0]?.key).toBe("rib:chamber:room");
  });
});
