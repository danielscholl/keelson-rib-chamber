import { afterAll, describe, expect, it } from "bun:test";
import type { RibContext, SnapshotManager } from "@keelson/shared";
import rib from "../src/index.ts";
import { setChamberDataHome } from "../src/paths.ts";

// registerTools (exercised below) captures the data home into a module global;
// clear it after this file so the bootstrap doesn't leak a home into the next.
afterAll(() => setChamberDataHome(undefined));

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

  it("declares the roster, rooms-index and brief views; the room is a runtime per-slug region", () => {
    const keys = (rib.views ?? []).map((v) => v.key);
    expect(keys).toContain("rib:chamber:roster");
    expect(keys).toContain("rib:chamber:rooms");
    expect(keys).toContain("rib:chamber:brief");
    // No static room view: each room registers its own per-slug key + region at start.
    expect(keys).not.toContain("rib:chamber:room");
  });

  it("declares no static actions — every control is a workflow or a board action", () => {
    // A payload-less static actions[] button can't carry input, so genesis is the
    // chamber-genesis workflow and retire + the room controls are payload-carrying
    // board actions that reach onAction. Probe via Object.hasOwn (not `rib.actions`)
    // so the assertion typechecks against the actions-less Rib contract.
    expect(Object.hasOwn(rib, "actions")).toBe(false);
  });

  it("ships no static room column — room panels are registered per slug at start", () => {
    const rows = rib.surfaces?.[0]?.layout.rows ?? [];
    const cols = rows.flatMap((r) => r.columns.map((c) => c.key));
    expect(cols).not.toContain("rib:chamber:room");
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

  it("ships the sessions-index row bound to chamber-rooms; room + lens panels stay runtime", () => {
    const rows = rib.surfaces?.[0]?.layout.rows ?? [];
    const cols = rows.flatMap((r) => r.columns);
    // The one standing row is the ended-sessions index (a workflow-backed collector
    // region); the live room and lens panels remain runtime per-slug regions.
    const index = cols.find((c) => c.key === "rib:chamber:rooms");
    expect(index?.workflow).toBe("chamber-rooms");
    expect(cols.some((c) => c.key.startsWith("rib:chamber:lens:"))).toBe(false);
    // The live per-slug room panels stay runtime regions — never a static column.
    expect(cols.some((c) => c.key.startsWith("rib:chamber:room:"))).toBe(false);
  });

  it("contributes the chamber-rooms collector workflow bound to the rooms-index key", () => {
    const wfs = rib.contributeWorkflows?.({} as RibContext) ?? [];
    const rooms = wfs.find((w) => (w.definition as { name?: string }).name === "chamber-rooms");
    expect(rooms?.bindSnapshotKey).toBe("rib:chamber:rooms");
  });

  it("contributes the chamber-lens workflow", () => {
    const names = (rib.contributeWorkflows?.({} as RibContext) ?? []).map(
      (w) => (w.definition as { name?: string }).name,
    );
    expect(names).toContain("chamber-lens");
  });

  it("withholds chamber_emit_lens when the registerRegion seam is absent (fail closed)", () => {
    // Lenses render via registerRegion; without it the tool is withheld rather than
    // publishing invisible, unbounded keys. The genesis write seam is unaffected.
    const ctx = {
      getExec: () => ({
        runJSON: async () => ({ ok: true as const, data: undefined }),
        runText: async () => ({ ok: true as const, data: "" }),
      }),
      getSnapshotManager: () => fakeSnapshotManager(),
    } as unknown as RibContext;
    const names = (rib.registerTools?.(ctx) ?? []).map((t) => t.name);
    expect(names).not.toContain("chamber_emit_lens");
    expect(names).toContain("chamber_emit_genesis");
  });

  it("registers chamber_emit_lens with the snapshot + registerRegion seams but no agent-turn seam", () => {
    const ctx = {
      getExec: () => ({
        runJSON: async () => ({ ok: true as const, data: undefined }),
        runText: async () => ({ ok: true as const, data: "" }),
      }),
      getSnapshotManager: () => fakeSnapshotManager(),
      registerRegion: () => () => {},
    } as unknown as RibContext;
    const names = (rib.registerTools?.(ctx) ?? []).map((t) => t.name);
    expect(names).toContain("chamber_emit_lens");
    expect(names).not.toContain("chamber_room_start");
  });
});
