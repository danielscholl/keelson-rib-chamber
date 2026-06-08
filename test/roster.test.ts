import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type RibContext,
  ribSurfaceDescriptorSchema,
  ribViewDescriptorSchema,
} from "@keelson/shared";
import rib from "../src/index.ts";
import { readMinds, scaffoldMind } from "../src/minds-store.ts";

// onAction's contract passes a RibContext, but the chamber rib ignores it for
// retire/unknown (only OSDU-style actions read it). A getExec-only stub satisfies
// the type at the call sites below.
const stubCtx = {
  getExec: () => ({
    runJSON: async () => ({ ok: false as const, error: "unused", code: null }),
    runText: async () => ({ ok: false as const, error: "unused", code: null }),
  }),
} as RibContext;

const ROSTER_KEY = "rib:chamber:roster";

function contributions() {
  const ctx = {} as Parameters<NonNullable<typeof rib.contributeWorkflows>>[0];
  return rib.contributeWorkflows?.(ctx) ?? [];
}

describe("chamber-roster producer (Phase 1)", () => {
  test("declares the Roster view bound to the rib-namespaced key", () => {
    const view = rib.views?.find((v) => v.key === ROSTER_KEY);
    expect(view?.canvasKind).toBe("view");
    expect(ribViewDescriptorSchema.safeParse(view).success).toBe(true);
  });

  test("contributes a chamber-roster collector (a bash node, not a prompt)", () => {
    const roster = contributions().find(
      (c) => (c.definition as { name?: string }).name === "chamber-roster",
    );
    expect(roster?.bindSnapshotKey).toBe(ROSTER_KEY);
    const node = (roster?.definition as { nodes?: Array<Record<string, unknown>> }).nodes?.[0];
    expect(typeof node?.bash).toBe("string");
    expect(node?.prompt).toBeUndefined();
    expect(node?.output_schema).toEqual({ type: "object", required: ["view", "sections"] });
  });

  test("validate accepts a board and rejects a non-board fail-closed", () => {
    const roster = contributions().find((c) => c.bindSnapshotKey === ROSTER_KEY);
    const board = { view: "board", title: "Roster", sections: [{ kind: "cards", items: [] }] };
    expect((roster?.validate?.(board) as { view?: string }).view).toBe("board");
    expect(() =>
      roster?.validate?.({ view: "table", columns: [{ key: "a" }], rows: [] }),
    ).toThrow();
  });
});

describe("Chamber surface (Phase 1)", () => {
  test("the roster is the header region in the rib namespace", () => {
    const header = rib.surfaces?.[0]?.layout.header;
    expect(header?.key).toBe(ROSTER_KEY);
    expect(header?.workflow).toBe("chamber-roster");
    expect(ribSurfaceDescriptorSchema.safeParse(rib.surfaces?.[0]).success).toBe(true);
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

describe("retire action", () => {
  let workspace: string;
  let priorWorkspace: string | undefined;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "chamber-ws-"));
    priorWorkspace = process.env.KEELSON_WORKSPACE;
    process.env.KEELSON_WORKSPACE = workspace;
  });

  afterEach(async () => {
    if (priorWorkspace === undefined) delete process.env.KEELSON_WORKSPACE;
    else process.env.KEELSON_WORKSPACE = priorWorkspace;
    await rm(workspace, { recursive: true, force: true });
  });

  const mindsRoot = () => join(workspace, ".keelson", "chamber", "minds");

  async function seedScout(): Promise<void> {
    await scaffoldMind(
      mindsRoot(),
      {
        slug: "scout",
        name: "Scout",
        role: "researcher",
        voice: "terse",
        persona: "Digs up facts.",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      "# Scout\n## Persona\nA researcher.",
    );
  }

  test("retire removes a Mind from the data home", async () => {
    await seedScout();
    const res = await rib.onAction?.({ type: "retire", payload: { slug: "scout" } }, stubCtx);
    expect(res?.ok).toBe(true);
    expect(await readMinds(mindsRoot())).toEqual([]);
  });

  test("retire fails closed without a slug", async () => {
    const res = await rib.onAction?.({ type: "retire", payload: {} }, stubCtx);
    expect(res?.ok).toBe(false);
  });

  test("retire surfaces a missing Mind", async () => {
    const res = await rib.onAction?.({ type: "retire", payload: { slug: "ghost" } }, stubCtx);
    expect(res?.ok).toBe(false);
  });

  test("an unknown action is rejected", async () => {
    const res = await rib.onAction?.({ type: "bogus" }, stubCtx);
    expect(res?.ok).toBe(false);
  });
});
