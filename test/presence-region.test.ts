import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanvasBoardView, RibContext, SnapshotManager } from "@keelson/shared";
import { canvasViewSchema } from "@keelson/shared";
import rib from "../src/index.ts";
import { scaffoldMind } from "../src/minds-store.ts";
import { mindsDir, setChamberDataHome } from "../src/paths.ts";
import { appendPendingGenesis } from "../src/pending-genesis.ts";

const PRESENCE_KEY = "rib:chamber:presence";

const registerTools = rib.registerTools;
if (!registerTools) throw new Error("rib is missing registerTools");

// A SnapshotManager double that keeps the registered composers AND counts recompose
// calls per key, so a test can prove Presence was recomposed by a mutation.
function capturingSm() {
  const composers = new Map<string, () => unknown>();
  const recomposeCounts = new Map<string, number>();
  const sm = {
    register(key: string, compose: () => unknown) {
      composers.set(key, compose);
      return () => composers.delete(key);
    },
    async recompose(key: string) {
      recomposeCounts.set(key, (recomposeCounts.get(key) ?? 0) + 1);
      await composers.get(key)?.();
      return undefined;
    },
    latest: () => undefined,
    keys: () => [...composers.keys()],
    dispose: async () => {},
  } as unknown as SnapshotManager;
  return { sm, composers, recomposeCounts };
}

function record(slug: string, name: string, identitySlot: number) {
  return {
    slug,
    name,
    role: "Mind",
    voice: "",
    persona: "p",
    identitySlot,
    createdAt: "2026-07-08T00:00:00.000Z",
  };
}

// Presence is an in-process board wired through the always-defined refresh fan-out. On a
// host with a snapshot manager but NO refreshWorkflow, that fan-out must still recompose
// Presence on a roster/rooms mutation, while a genuine host-capability check (lens
// Refresh) reports the seam is missing.
describe("Presence region — snapshot manager, no host refreshWorkflow", () => {
  let home: string;
  let composers: Map<string, () => unknown>;
  let recomposeCounts: Map<string, number>;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "chamber-presence-"));
    setChamberDataHome(home);
    await scaffoldMind(mindsDir(), record("jarvis", "Jarvis", 0), "soul");
    await scaffoldMind(mindsDir(), record("mycroft", "Mycroft", 1), "soul");
    const cap = capturingSm();
    composers = cap.composers;
    recomposeCounts = cap.recomposeCounts;
    // Deliberately omit refreshWorkflow — the older-host path the fan-out guards.
    const ctx = {
      getDataDir: () => home,
      getExec: () => ({
        runJSON: async () => ({ ok: true as const, data: undefined }),
        runText: async () => ({ ok: true as const, data: "" }),
      }),
      getSnapshotManager: () => cap.sm,
      registerRegion: () => () => {},
    } as unknown as RibContext;
    registerTools(ctx);
  });

  afterAll(async () => {
    await rib.dispose?.();
    setChamberDataHome(undefined);
    await rm(home, { recursive: true, force: true });
  });

  it("registers rib:chamber:presence and composes a valid board from disk", async () => {
    const compose = composers.get(PRESENCE_KEY);
    expect(compose).toBeDefined();
    const board = (await compose?.()) as CanvasBoardView;
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    // The merged Chamber panel renders the bench as seat cards (rib#214).
    const cardsSection = board.sections.find((s) => s.kind === "cards");
    // readMinds order is disk-dependent, so compare the bench as a set. The
    // pad ghost and the open seat ride the same grid after the Minds (the
    // bench law: minds → pads → open seat, padded to the four-seat capacity).
    const labels =
      cardsSection?.kind === "cards" ? cardsSection.items.map((i) => i.title).sort() : [];
    expect(labels).toEqual(["Empty seat", "Jarvis", "Mycroft", "Open seat"]);
  });

  it("a roster mutation locally recomposes Presence without a host refresh seam", async () => {
    const before = recomposeCounts.get(PRESENCE_KEY) ?? 0;
    const res = await rib.onAction?.(
      { type: "retire", payload: { slug: "mycroft" } },
      {} as RibContext,
    );
    expect(res?.ok).toBe(true);
    // The always-defined fan-out fired refreshPresence even though the ctx had no
    // refreshWorkflow — the ribbon tracks the bench without a host seam.
    expect(recomposeCounts.get(PRESENCE_KEY) ?? 0).toBeGreaterThan(before);
    const board = (await composers.get(PRESENCE_KEY)?.()) as CanvasBoardView;
    expect(board.header?.status?.label).toBe("1 mind convenes here");
  });

  it("lens Refresh still reports the missing host capability", async () => {
    const res = await rib.onAction?.(
      { type: "refresh-lens", payload: { id: "whatever" } },
      {} as RibContext,
    );
    expect(res?.ok).toBe(false);
    expect(res && !res.ok && res.error).toContain("unavailable on this harness");
  });
});

// A crash can leave a pending-genesis marker behind (only graceful dispose clears
// it). Boot must reconcile it: an already-stalled marker composes straight to the
// dismissable stalled card — never the frozen "authoring" card that wedged the
// panel with the launchpad withheld and no way out.
describe("boot reconcile — crash-orphaned pending-genesis marker", () => {
  let home: string;

  afterAll(async () => {
    await rib.dispose?.();
    setChamberDataHome(undefined);
    await rm(home, { recursive: true, force: true });
  });

  it("an already-stalled orphan composes the Dismiss card at boot, launchpad withheld", async () => {
    home = await mkdtemp(join(tmpdir(), "chamber-orphan-"));
    setChamberDataHome(home);
    await scaffoldMind(mindsDir(), record("jarvis", "Jarvis", 0), "soul");
    await appendPendingGenesis(
      { startedAt: new Date(Date.now() - 10 * 60_000).toISOString(), name: "Athena" },
      home,
    );
    const cap = capturingSm();
    registerTools({
      getDataDir: () => home,
      getExec: () => ({
        runJSON: async () => ({ ok: true as const, data: undefined }),
        runText: async () => ({ ok: true as const, data: "" }),
      }),
      getSnapshotManager: () => cap.sm,
      registerRegion: () => () => {},
    } as unknown as RibContext);
    // Let the reconcile's marker read settle; it fires one extra presence frame.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(cap.recomposeCounts.get(PRESENCE_KEY) ?? 0).toBeGreaterThanOrEqual(2);
    const board = (await cap.composers.get(PRESENCE_KEY)?.()) as CanvasBoardView;
    const cards = board.sections.find((s) => s.kind === "cards");
    const boot =
      cards?.kind === "cards" ? cards.items.find((c) => c.title === "Athena") : undefined;
    expect(boot?.pill).toEqual({ label: "stalled", tone: "warn" });
    expect(boot?.actions?.some((a) => a.type === "dismiss-genesis")).toBe(true);
    // While the orphan is pending the authoring launchpad stays withheld.
    expect(board.sections.some((s) => s.kind === "actions")).toBe(false);
  });
});
