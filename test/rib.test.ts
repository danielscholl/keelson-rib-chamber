import { afterAll, describe, expect, it } from "bun:test";
import type { RibContext, SnapshotManager } from "@keelson/shared";
import rib from "../src/index.ts";
import { HTML_LENS_KEY } from "../src/lens-html.ts";
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

  it("declares the roster, rooms-index, lenses-index and brief views; the room is a runtime per-slug region", () => {
    const keys = (rib.views ?? []).map((v) => v.key);
    expect(keys).toContain("rib:chamber:roster");
    expect(keys).toContain("rib:chamber:rooms");
    expect(keys).toContain("rib:chamber:lenses");
    expect(keys).toContain("rib:chamber:brief");
    // No static room view: each room registers its own per-slug key + region at start.
    expect(keys).not.toContain("rib:chamber:room");
  });

  it("declares the surface subtitle and collapsible index columns (#284-p2 chrome)", () => {
    const surface = rib.surfaces?.[0];
    expect(surface?.subtitle).toBe(
      "Author Minds · convene Rooms · keep Lenses · read the Briefing",
    );
    const cols = (surface?.layout.rows ?? []).flatMap((r) => r.columns);
    expect(cols.find((c) => c.key === "rib:chamber:rooms")?.collapsible).toBe(true);
    expect(cols.find((c) => c.key === "rib:chamber:lenses")?.collapsible).toBe(true);
    // The roster header collapses too, so a seated bench can fold to its head strip.
    expect(surface?.layout.header?.collapsible).toBe(true);
  });

  it("the Briefing footer is rib-driven — keyed but with no workflow binding", () => {
    // The brief moved off a contributed workflow onto the rib-owned attention gate,
    // so the footer keeps the key but binds no workflow (none exists to refresh).
    const footer = rib.surfaces?.[0]?.layout.footer;
    expect(footer?.key).toBe("rib:chamber:brief");
    expect(footer?.workflow).toBeUndefined();
    const names = (rib.contributeWorkflows?.({} as RibContext) ?? []).map(
      (w) => (w.definition as { name?: string }).name,
    );
    expect(names).not.toContain("chamber-brief");
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

  it("registers the always-on seams without the agent-turn + snapshot seams", () => {
    // A ctx missing getSnapshotManager + runAgentTurn must not build the room driver
    // — no room-control tools, no room wiring side effect — but the always-on tools
    // (the genesis/digest workflow write seams, the read-only list tools, and the
    // retire-mind/delete-room cleanup tools, all driver-free disk ops) are registered.
    const ctx = {
      getExec: () => ({
        runJSON: async () => ({ ok: true as const, data: undefined }),
        runText: async () => ({ ok: true as const, data: "" }),
      }),
    } as unknown as RibContext;
    expect((rib.registerTools?.(ctx) ?? []).map((t) => t.name).sort()).toEqual([
      "chamber_emit_digest",
      "chamber_emit_genesis",
      "chamber_list_lenses",
      "chamber_list_minds",
      "chamber_list_rooms",
      "chamber_retire_mind",
      "chamber_room_delete",
      "chamber_room_transcript",
    ]);
  });

  it("declares the static html lens view while board lens views stay runtime", () => {
    const keys = (rib.views ?? []).map((v) => v.key);
    expect(keys).toContain(HTML_LENS_KEY);
    expect(keys.filter((k) => k.startsWith("rib:chamber:lens:"))).toEqual([]);
  });

  it("ships the sessions-index and lenses-index rows; room + lens panels stay runtime", () => {
    const rows = rib.surfaces?.[0]?.layout.rows ?? [];
    const cols = rows.flatMap((r) => r.columns);
    // The standing row pairs the ended-sessions index with the lenses index (both
    // workflow-backed collector regions); the live room and lens panels remain
    // runtime per-slug regions.
    const roomsIndex = cols.find((c) => c.key === "rib:chamber:rooms");
    expect(roomsIndex?.workflow).toBe("chamber-rooms");
    // The lenses index is a static column bound to chamber-lenses; the per-id LENS
    // panels (rib:chamber:lens:<id>) are the runtime regions and never static columns.
    const lensesIndex = cols.find((c) => c.key === "rib:chamber:lenses");
    expect(lensesIndex?.workflow).toBe("chamber-lenses");
    expect(cols.some((c) => c.key.startsWith("rib:chamber:lens:"))).toBe(false);
    // The live per-slug room panels stay runtime regions — never a static column.
    expect(cols.some((c) => c.key.startsWith("rib:chamber:room:"))).toBe(false);
  });

  it("contributes the chamber-rooms collector workflow bound to the rooms-index key", () => {
    const wfs = rib.contributeWorkflows?.({} as RibContext) ?? [];
    const rooms = wfs.find((w) => (w.definition as { name?: string }).name === "chamber-rooms");
    expect(rooms?.bindSnapshotKey).toBe("rib:chamber:rooms");
  });

  it("contributes the chamber-lenses collector workflow bound to the lenses-index key", () => {
    const wfs = rib.contributeWorkflows?.({} as RibContext) ?? [];
    const lenses = wfs.find((w) => (w.definition as { name?: string }).name === "chamber-lenses");
    expect(lenses?.bindSnapshotKey).toBe("rib:chamber:lenses");
    // A deterministic bash collector (not an agent turn), guarded by an output_schema
    // requiring a view + sections — the same shape as the rooms collector.
    const node = (lenses?.definition as { nodes?: { bash?: string }[] }).nodes?.[0];
    expect(node?.bash).toContain("collect-lenses.ts");
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

  it("declares the Digest standing-lens view (its store feeds the Briefing's Digest register)", () => {
    const keys = (rib.views ?? []).map((v) => v.key);
    expect(keys).toContain("rib:chamber:digest");
    // The Activity view retired with its region — the record folds into the footer.
    expect(keys).not.toContain("rib:chamber:activity");
  });

  it("Convene leads in its own collapsible row above the Rooms + Lenses row", () => {
    const rows = rib.surfaces?.[0]?.layout.rows ?? [];
    expect(rows.map((r) => r.columns.map((c) => c.key))).toEqual([
      ["rib:chamber:convene"],
      ["rib:chamber:rooms", "rib:chamber:lenses"],
    ]);
    // Convene is in-process (no workflow binding) and folds to its head bar.
    const convene = rows[0]?.columns[0];
    expect(convene?.workflow).toBeUndefined();
    expect(convene?.collapsible).toBe(true);
    const cols = rows.flatMap((r) => r.columns);
    // Neither what's-happening narrator has a standing column anymore.
    expect(cols.some((c) => c.key === "rib:chamber:activity")).toBe(false);
    expect(cols.some((c) => c.key === "rib:chamber:digest")).toBe(false);
    // The Briefing is the one narrator, in the footer.
    expect(rib.surfaces?.[0]?.layout.footer?.key).toBe("rib:chamber:brief");
  });

  it("no longer contributes a chamber-activity workflow (the record is composed in-process)", () => {
    const wfs = rib.contributeWorkflows?.({} as RibContext) ?? [];
    expect(wfs.some((w) => (w.definition as { name?: string }).name === "chamber-activity")).toBe(
      false,
    );
    // The chamber-digest workflow survives — its paid synthesis still feeds the footer.
    expect(wfs.some((w) => (w.definition as { name?: string }).name === "chamber-digest")).toBe(
      true,
    );
  });
});
