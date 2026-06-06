import { describe, expect, test } from "bun:test";
import { ribSurfaceDescriptorSchema, ribViewDescriptorSchema } from "@keelson/shared";
import rib from "../src/index.ts";

const BRIEF_KEY = "rib:chamber:brief";

// A fresh contribution list per call — contributeWorkflows takes a ctx, but the
// Phase 0 brief never touches it, so an empty cast satisfies the type.
function contributions() {
  const ctx = {} as Parameters<NonNullable<typeof rib.contributeWorkflows>>[0];
  return rib.contributeWorkflows?.(ctx) ?? [];
}

describe("chamber-brief lens (Phase 0)", () => {
  test("declares the Briefing view bound to the rib-namespaced key", () => {
    const view = rib.views?.find((v) => v.key === BRIEF_KEY);
    expect(view).toBeDefined();
    expect(view?.canvasKind).toBe("view");
    expect(ribViewDescriptorSchema.safeParse(view).success).toBe(true);
  });

  test("contributes a chamber-brief workflow bound to rib:chamber:brief", () => {
    const brief = contributions().find(
      (c) => (c.definition as { name?: string }).name === "chamber-brief",
    );
    expect(brief).toBeDefined();
    expect(brief?.bindSnapshotKey).toBe(BRIEF_KEY);
  });

  test("the producer is an agent turn (a prompt node), not a deterministic collector", () => {
    const brief = contributions().find(
      (c) => (c.definition as { name?: string }).name === "chamber-brief",
    );
    const nodes = (brief?.definition as { nodes?: Array<Record<string, unknown>> }).nodes ?? [];
    expect(nodes).toHaveLength(1);
    const node = nodes[0];
    expect(typeof node?.prompt).toBe("string");
    expect((node?.prompt as string).length).toBeGreaterThan(0);
    expect(node?.bash).toBeUndefined();
    // structured-output trigger + fail-closed node guard. The guard validates
    // top-level field *types* (not just key presence) so a malformed agent reply
    // — e.g. `sections` as a string — fails the run instead of being silently
    // dropped by the canvas validate on publish.
    expect(node?.output_format).toEqual({
      type: "object",
      required: ["view", "sections"],
      properties: {
        view: { type: "string" },
        title: { type: "string" },
        sections: { type: "array" },
      },
    });
    expect(node?.output_schema).toEqual(node?.output_format);
  });

  test("validate accepts a board payload and returns the parsed view", () => {
    const brief = contributions().find((c) => c.bindSnapshotKey === BRIEF_KEY);
    const board = {
      view: "board",
      title: "Chamber Briefing",
      header: { status: { label: "Phase 0", tone: "brand" } },
      sections: [{ kind: "stats", items: [{ label: "Lenses", value: 1, tone: "ok" }] }],
    };
    const parsed = brief?.validate?.(board) as { view?: string } | undefined;
    expect(parsed?.view).toBe("board");
  });

  test("validate rejects a non-board view (wrong kind) fail-closed", () => {
    const brief = contributions().find((c) => c.bindSnapshotKey === BRIEF_KEY);
    const table = { view: "table", columns: [{ key: "a" }], rows: [] };
    expect(() => brief?.validate?.(table)).toThrow();
  });

  test("validate rejects a payload that is not a canvas view at all", () => {
    const brief = contributions().find((c) => c.bindSnapshotKey === BRIEF_KEY);
    expect(() => brief?.validate?.({ not: "a view" })).toThrow();
  });
});

describe("Chamber surface (Phase 0)", () => {
  test("the rib declares one valid Chamber surface", () => {
    expect(rib.surfaces).toHaveLength(1);
    const surface = rib.surfaces?.[0];
    expect(surface?.id).toBe("chamber");
    expect(surface?.title).toBe("Chamber");
    expect(ribSurfaceDescriptorSchema.safeParse(surface).success).toBe(true);
  });

  test("the Briefing is the surface's region, in the rib namespace", () => {
    const column = rib.surfaces?.[0]?.layout.rows[0]?.columns[0];
    expect(column?.key).toBe(BRIEF_KEY);
    expect(column?.workflow).toBe("chamber-brief");
    expect(column?.key.startsWith("rib:chamber:")).toBe(true);
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
