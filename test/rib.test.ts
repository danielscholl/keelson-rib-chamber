import { describe, expect, it } from "bun:test";
import type { RibContext } from "@keelson/shared";
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

  it("declares no static actions — every control is a workflow or a board action", () => {
    // A payload-less static actions[] button can't carry input, so genesis is the
    // chamber-genesis workflow and retire + the room controls are payload-carrying
    // board actions that reach onAction.
    expect(rib.actions ?? []).toEqual([]);
  });

  it("places the live room transcript in the surface row", () => {
    const row = rib.surfaces?.[0]?.layout.rows[0];
    expect(row?.columns[0]?.key).toBe("rib:chamber:room");
  });

  it("registers only the genesis write seam without the agent-turn + snapshot seams", () => {
    // A ctx missing getSnapshotManager + runAgentTurn must not build the room
    // driver — no room-control tools, no room wiring side effect — but the genesis
    // tool (driver-free, a workflow write seam) is always registered.
    const ctx = {
      getExec: () => ({
        runJSON: async () => ({ ok: true as const, data: undefined }),
        runText: async () => ({ ok: true as const, data: "" }),
      }),
    } as unknown as RibContext;
    expect((rib.registerTools?.(ctx) ?? []).map((t) => t.name)).toEqual(["chamber_emit_genesis"]);
  });
});
