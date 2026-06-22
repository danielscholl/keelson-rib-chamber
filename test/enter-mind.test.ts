import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RibContext } from "@keelson/shared";
import rib from "../src/index.ts";
import { scaffoldMind } from "../src/minds-store.ts";
import { mindsDir, setChamberDataHome } from "../src/paths.ts";

const onAction = rib.onAction;
if (!onAction) throw new Error("rib is missing onAction");

const ctx = {
  getExec: () => ({
    runJSON: async () => ({ ok: true as const, data: undefined }),
    runText: async () => ({ ok: true as const, data: "" }),
  }),
} as unknown as RibContext;

let workspace: string;

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "chamber-enter-"));
  setChamberDataHome(join(workspace, "chamber"));
  // Reset the module-global roster cache so resolveMinds() reads this data home.
  await rib.dispose?.();
  await scaffoldMind(
    mindsDir(),
    {
      slug: "ada",
      name: "Ada",
      role: "researcher",
      voice: "terse",
      persona: "You are Ada.",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    "I am Ada, a relentless researcher.",
  );
});

afterAll(async () => {
  await rib.dispose?.();
  setChamberDataHome(undefined);
  await rm(workspace, { recursive: true, force: true });
});

describe("enter-mind action", () => {
  it("returns an open-chat directive seeded with the mind's soul", async () => {
    const res = await onAction({ type: "enter-mind", payload: { slug: "ada" } }, ctx);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const data = res.data as {
      effect: string;
      seed: { systemPrompt: string; name: string; openingPrompt: string };
    };
    expect(data.effect).toBe("open-chat");
    expect(data.seed.name).toBe("Ada");
    expect(data.seed.systemPrompt).toContain("relentless researcher");
    expect(data.seed.systemPrompt.length).toBeLessThanOrEqual(8000);
    expect(data.seed.openingPrompt.length).toBeGreaterThan(0);
  });

  it("errors on an unknown slug (covers the retire-then-enter race)", async () => {
    expect((await onAction({ type: "enter-mind", payload: { slug: "ghost" } }, ctx)).ok).toBe(
      false,
    );
  });

  it("errors when the slug is missing", async () => {
    expect((await onAction({ type: "enter-mind", payload: {} }, ctx)).ok).toBe(false);
  });
});
