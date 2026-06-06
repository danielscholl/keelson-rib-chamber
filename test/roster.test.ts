import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RibContext, RibExecResult } from "@keelson/shared";
import { ribSurfaceDescriptorSchema, ribViewDescriptorSchema } from "@keelson/shared";
import rib from "../src/index.ts";
import { readMinds } from "../src/minds-store.ts";

const ROSTER_KEY = "rib:chamber:roster";

function contributions() {
  const ctx = {} as Parameters<NonNullable<typeof rib.contributeWorkflows>>[0];
  return rib.contributeWorkflows?.(ctx) ?? [];
}

// A RibContext whose exec returns a scripted runJSON result — the genesis turn's
// only host dependency. runText is present (contract) but unused here.
function fakeCtx(runJSON: (cmd: string, args: string[]) => RibExecResult<unknown>): RibContext {
  return {
    getExec: () => ({
      runJSON: async (cmd: string, args: string[]) => runJSON(cmd, args) as never,
      runText: async () => ({ ok: false, error: "unused", code: null }),
    }),
  } as RibContext;
}

const authored = (soul: string, tagline: string): RibExecResult<{ result: string }> => ({
  ok: true,
  data: { result: JSON.stringify({ soul, tagline }) },
});

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

  test("declares genesis + retire actions", () => {
    const types = (rib.actions ?? []).map((a) => a.type);
    expect(types).toContain("genesis");
    expect(types).toContain("retire");
  });
});

describe("genesis / retire actions (Phase 1)", () => {
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

  test("genesis authors a Mind that the roster then reads back", async () => {
    const ctx = fakeCtx(() => authored("# Scout\n## Persona\nA researcher.", "Digs up facts."));
    const res = await rib.onAction?.(
      { type: "genesis", payload: { name: "Scout", role: "researcher", voice: "terse" } },
      ctx,
    );
    expect(res).toEqual({ ok: true, data: { slug: "scout" } });
    const minds = await readMinds(mindsRoot());
    expect(minds.map((m) => m.slug)).toEqual(["scout"]);
    expect(minds[0]?.persona).toBe("Digs up facts.");
  });

  test("a colliding genesis fails fast — before running the (paid) turn", async () => {
    await rib.onAction?.(
      { type: "genesis", payload: { name: "Scout", role: "r", voice: "v" } },
      fakeCtx(() => authored("# Scout", "facts")),
    );
    let ran = false;
    const res = await rib.onAction?.(
      { type: "genesis", payload: { name: "Scout", role: "r", voice: "v" } },
      fakeCtx(() => {
        ran = true;
        return authored("# Scout 2", "more");
      }),
    );
    expect(res?.ok).toBe(false);
    expect(ran).toBe(false);
  });

  test("genesis fails closed when the brief is incomplete (no turn run)", async () => {
    let ran = false;
    const ctx = fakeCtx(() => {
      ran = true;
      return authored("# X", "y");
    });
    const res = await rib.onAction?.({ type: "genesis", payload: { name: "Scout" } }, ctx);
    expect(res?.ok).toBe(false);
    expect(ran).toBe(false);
  });

  test("genesis surfaces a turn failure", async () => {
    const ctx = fakeCtx(() => ({ ok: false, error: "claude not found", code: null }));
    const res = await rib.onAction?.(
      { type: "genesis", payload: { name: "Scout", role: "r", voice: "v" } },
      ctx,
    );
    expect(res?.ok).toBe(false);
  });

  test("genesis fails closed on a malformed authoring turn", async () => {
    const ctx = fakeCtx(() => ({ ok: true, data: { result: "the model refused" } }));
    const res = await rib.onAction?.(
      { type: "genesis", payload: { name: "Scout", role: "r", voice: "v" } },
      ctx,
    );
    expect(res?.ok).toBe(false);
    expect(await readMinds(mindsRoot())).toEqual([]);
  });

  test("retire removes a Mind", async () => {
    const ctx = fakeCtx(() => authored("# Scout", "facts"));
    await rib.onAction?.(
      { type: "genesis", payload: { name: "Scout", role: "r", voice: "v" } },
      ctx,
    );
    const res = await rib.onAction?.({ type: "retire", payload: { slug: "scout" } }, ctx);
    expect(res?.ok).toBe(true);
    expect(await readMinds(mindsRoot())).toEqual([]);
  });

  test("an unknown action is rejected", async () => {
    const ctx = fakeCtx(() => authored("# X", "y"));
    const res = await rib.onAction?.({ type: "bogus" }, ctx);
    expect(res?.ok).toBe(false);
  });
});
