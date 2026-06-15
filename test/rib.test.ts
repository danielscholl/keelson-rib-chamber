import { describe, expect, it } from "bun:test";
import type { RibContext, SnapshotManager } from "@keelson/shared";
import rib from "../src/index.ts";

// A minimal SnapshotManager double — the lens registry and room wiring only need
// register/recompose not to throw.
function fakeSnapshotManager(): SnapshotManager {
  const composers = new Map<string, () => unknown>();
  return {
    register: (k: string, c: () => unknown) => {
      composers.set(k, c);
      return () => composers.delete(k);
    },
    recompose: async (k: string) => {
      await composers.get(k)?.();
      return undefined;
    },
    latest: () => undefined,
    keys: () => [...composers.keys()],
    dispose: async () => {},
  } as unknown as SnapshotManager;
}

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
    // board actions that reach onAction. Probe via Object.hasOwn (not `rib.actions`)
    // so the assertion typechecks against the actions-less Rib contract.
    expect(Object.hasOwn(rib, "actions")).toBe(false);
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

  it("declares no static lens views — a lens registers its own at author time", () => {
    const keys = (rib.views ?? []).map((v) => v.key);
    expect(keys.some((k) => k.startsWith("rib:chamber:lens:"))).toBe(false);
  });

  it("declares no static lens row — the surface ships with just the room row", () => {
    const rows = rib.surfaces?.[0]?.layout.rows ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.columns.map((c) => c.key)).toEqual(["rib:chamber:room"]);
  });

  it("contributes the chamber-lens workflow", () => {
    const names = (rib.contributeWorkflows?.({} as RibContext) ?? []).map(
      (w) => (w.definition as { name?: string }).name,
    );
    expect(names).toContain("chamber-lens");
  });

  it("registers chamber_emit_lens with a snapshot manager but no agent-turn or registerRegion seam", () => {
    // No registerRegion on the ctx: registerTools must still wire the lens tool
    // (the registry degrades to publishing without a panel), not throw.
    const ctx = {
      getExec: () => ({
        runJSON: async () => ({ ok: true as const, data: undefined }),
        runText: async () => ({ ok: true as const, data: "" }),
      }),
      getSnapshotManager: () => fakeSnapshotManager(),
    } as unknown as RibContext;
    const names = (rib.registerTools?.(ctx) ?? []).map((t) => t.name);
    expect(names).toContain("chamber_emit_lens");
    expect(names).not.toContain("chamber_room_start");
  });
});
