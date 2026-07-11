import { describe, expect, test } from "bun:test";
import { ribSurfaceDescriptorSchema, ribViewDescriptorSchema } from "@keelson/shared";
import rib from "../src/index.ts";

const BRIEF_KEY = "rib:chamber:brief";

// A fresh contribution list per call — contributeWorkflows takes a ctx, but the
// surviving collectors never touch it, so an empty cast satisfies the type.
function contributions() {
  const ctx = {} as Parameters<NonNullable<typeof rib.contributeWorkflows>>[0];
  return rib.contributeWorkflows?.(ctx) ?? [];
}

describe("Briefing view + gate wiring", () => {
  test("declares the Briefing view bound to the rib-namespaced key", () => {
    const view = rib.views?.find((v) => v.key === BRIEF_KEY);
    expect(view).toBeDefined();
    expect(view?.canvasKind).toBe("view");
    expect(ribViewDescriptorSchema.safeParse(view).success).toBe(true);
  });

  test("no chamber-brief workflow is contributed — the briefing is rib-driven", () => {
    // The briefing moved off a contributed workflow onto the rib-owned attention
    // gate (evaluateBriefGate), which refreshWorkflow can't drive (it can't pass the
    // delta), so the workflow must be gone from the catalog entirely.
    const names = contributions().map((c) => (c.definition as { name?: string }).name);
    expect(names).not.toContain("chamber-brief");
    // No contribution binds the brief key any more either (the rib publishes it).
    expect(contributions().some((c) => c.bindSnapshotKey === BRIEF_KEY)).toBe(false);
  });
});

describe("Chamber surface (attention chrome)", () => {
  test("the rib declares one valid Chamber surface with a subtitle", () => {
    expect(rib.surfaces).toHaveLength(1);
    const surface = rib.surfaces?.[0];
    expect(surface?.id).toBe("chamber");
    expect(surface?.title).toBe("Chamber");
    // #284-p2 chrome: a static subtitle under the surface title.
    expect(surface?.subtitle).toBe(
      "Author Minds · convene Rooms · keep Lenses · table Exhibits · read the Briefing",
    );
    expect(ribSurfaceDescriptorSchema.safeParse(surface).success).toBe(true);
  });

  test("the Briefing banner carries the key with NO workflow binding", () => {
    const banner = rib.surfaces?.[0]?.layout.banner;
    expect(banner?.key).toBe(BRIEF_KEY);
    expect(banner?.key.startsWith("rib:chamber:")).toBe(true);
    // Rib-driven, not refresh-fed: the banner must not bind a workflow (there is no
    // chamber-brief workflow), or the SPA would try to refresh a non-existent one.
    expect(banner?.workflow).toBeUndefined();
    // Promoted out of the footer — the surface leads with the heartbeat, no footer slot.
    expect(rib.surfaces?.[0]?.layout.footer).toBeUndefined();
  });

  test("the rooms and lenses index columns are collapsible", () => {
    const cols = (rib.surfaces?.[0]?.layout.rows ?? []).flatMap((r) => r.columns);
    const rooms = cols.find((c) => c.key === "rib:chamber:rooms");
    const lenses = cols.find((c) => c.key === "rib:chamber:lenses");
    expect(rooms?.collapsible).toBe(true);
    expect(lenses?.collapsible).toBe(true);
  });

  test("every surface region's refresh workflow is one the rib contributes", () => {
    const contributed = new Set(
      contributions().map((c) => (c.definition as { name: string }).name),
    );
    const layout = rib.surfaces?.[0]?.layout;
    const regions = [
      layout?.header,
      layout?.banner,
      ...(layout?.rows.flatMap((r) => r.columns) ?? []),
      layout?.footer,
    ];
    for (const region of regions) {
      if (region?.workflow) expect(contributed.has(region.workflow)).toBe(true);
    }
  });
});
