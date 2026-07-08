import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanvasBoardView, RibContext, SnapshotManager } from "@keelson/shared";
import { canvasViewSchema } from "@keelson/shared";
import rib from "../src/index.ts";
import { scaffoldMind } from "../src/minds-store.ts";
import { mindsDir, setChamberDataHome } from "../src/paths.ts";

const registerTools = rib.registerTools;
if (!registerTools) throw new Error("rib is missing registerTools");

// A SnapshotManager double that keeps the registered composers so the test can call
// the CONVENE_KEY composer directly and inspect the composed frame.
function capturingSm(): { sm: SnapshotManager; composers: Map<string, () => unknown> } {
  const composers = new Map<string, () => unknown>();
  const sm = {
    register(key: string, compose: () => unknown) {
      composers.set(key, compose);
      return () => composers.delete(key);
    },
    async recompose(key: string) {
      await composers.get(key)?.();
      return undefined;
    },
    latest: () => undefined,
    keys: () => [...composers.keys()],
    dispose: async () => {},
  } as unknown as SnapshotManager;
  return { sm, composers };
}

function record(slug: string, name: string, provider: string, identitySlot: number) {
  return {
    slug,
    name,
    role: "Mind",
    voice: "",
    persona: "p",
    provider,
    identitySlot,
    createdAt: "2026-07-08T00:00:00.000Z",
  };
}

describe("Convene region (in-process compose path)", () => {
  let home: string;
  let composers: Map<string, () => unknown>;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "chamber-convene-"));
    setChamberDataHome(home);
    await scaffoldMind(mindsDir(), record("athena", "Athena", "anthropic", 0), "soul");
    await scaffoldMind(mindsDir(), record("moneypenny", "Moneypenny", "openai", 1), "soul");
    const cap = capturingSm();
    composers = cap.composers;
    const ctx = {
      getDataDir: () => home,
      getExec: () => ({
        runJSON: async () => ({ ok: true as const, data: undefined }),
        runText: async () => ({ ok: true as const, data: "" }),
      }),
      getSnapshotManager: () => cap.sm,
      getProjects: () => [{ id: "p1", name: "keelson", rootPath: "/tmp/keelson" }],
      registerRegion: () => () => {},
    } as unknown as RibContext;
    registerTools(ctx);
  });

  afterAll(async () => {
    await rib.dispose?.();
    await rm(home, { recursive: true, force: true });
  });

  it("registers rib:chamber:convene and composes a valid board from disk + host projects", async () => {
    const compose = composers.get("rib:chamber:convene");
    expect(compose).toBeDefined();
    // The real in-process path: readMinds(home) + readDraftExclusion + listRooms + getProjects.
    const board = (await compose?.()) as CanvasBoardView;
    expect(canvasViewSchema.safeParse(board).success).toBe(true);

    const titles = board.sections.map((s) => (s.kind === "actions" ? s.title : undefined));
    expect(titles).toContain("Who’s in");
    expect(titles).toContain("…and how");

    const how = board.sections.find((s) => s.kind === "actions" && s.title === "…and how");
    const items = how?.kind === "actions" ? how.items : [];
    const byStrategy = new Map(items.map((i) => [(i.payload as { strategy: string }).strategy, i]));
    // Athena (anthropic) + Moneypenny (openai) is a cross-vendor pair → Review enabled.
    expect(byStrategy.get("review")?.disabled ?? false).toBe(false);
    // Discussion's project field is a select over the host project list.
    const proj = byStrategy.get("sequential")?.fields?.find((f) => f.name === "project");
    expect(proj?.options).toEqual([{ value: "p1", label: "keelson" }]);
    // No rooms yet, so the composer opens expanded (its cold empty-state).
    expect(board.header?.defaultCollapsed).toBe(false);
  });
});
