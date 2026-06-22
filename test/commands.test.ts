import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RibContext } from "@keelson/shared";
import rib from "../src/index.ts";
import { scaffoldMind } from "../src/minds-store.ts";
import { mindsDir, setChamberDataHome } from "../src/paths.ts";

// The command hooks ignore ctx (they read the captured chamber data home), so a
// bare cast is enough to exercise the rib wiring end to end.
const ctx = {} as RibContext;
let workspace: string;

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "chamber-commands-"));
  setChamberDataHome(join(workspace, "chamber"));
  await scaffoldMind(
    mindsDir(),
    {
      slug: "ada",
      name: "Ada",
      role: "researcher",
      voice: "terse",
      persona: "Digs up facts.",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    "I am Ada.",
  );
});

afterAll(async () => {
  setChamberDataHome(undefined);
  await rm(workspace, { recursive: true, force: true });
});

describe("listCommands", () => {
  it("declares /mind, /genesis, and /lens", async () => {
    const names = ((await rib.listCommands?.(ctx)) ?? []).map((c) => c.name);
    expect(names).toEqual(["mind", "genesis", "lens"]);
  });
});

describe("completeCommand", () => {
  it("type-aheads Mind slugs for /mind by prefix", async () => {
    expect(await rib.completeCommand?.("mind", "a", ctx)).toEqual([
      { value: "ada", description: "Digs up facts." },
    ]);
  });

  it("returns nothing for a non-mind command", async () => {
    expect(await rib.completeCommand?.("genesis", "", ctx)).toEqual([]);
  });
});

describe("invokeCommand", () => {
  it("/mind <slug> resolves to an open-agent effect", async () => {
    expect(await rib.invokeCommand?.("mind", "ada", ctx)).toEqual({
      ok: true,
      effect: { effect: "open-agent", ribId: "chamber", slug: "ada" },
    });
  });

  it("/mind with no slug lists the Minds inline as plain text", async () => {
    const res = await rib.invokeCommand?.("mind", "", ctx);
    expect(res?.ok).toBe(true);
    expect(res && "effect" in res && res.effect.effect).toBe("message");
    // The surfaces render the message verbatim, so it must be plain text — no
    // markdown bold/code that would show literal `**`/backticks to the user.
    const text = res && "effect" in res && res.effect.effect === "message" ? res.effect.text : "";
    expect(text).toContain("Minds:");
    expect(text).not.toContain("**");
    expect(text).not.toContain("`");
  });

  it("/mind no-arg list stays under the shared 8000-char message cap for a large roster", async () => {
    const ws = await mkdtemp(join(tmpdir(), "chamber-bigmind-"));
    setChamberDataHome(join(ws, "chamber"));
    try {
      for (let i = 0; i < 40; i++) {
        await scaffoldMind(
          mindsDir(),
          {
            slug: `m${i}`,
            name: `Mind ${i}`,
            role: "r",
            voice: "v",
            persona: "x".repeat(280),
            createdAt: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
          },
          "soul",
        );
      }
      const res = await rib.invokeCommand?.("mind", "", ctx);
      expect(res?.ok).toBe(true);
      const text = res && "effect" in res && res.effect.effect === "message" ? res.effect.text : "";
      expect(text.length).toBeLessThanOrEqual(8000);
      expect(text).toContain("more (type a slug to filter)");
    } finally {
      setChamberDataHome(join(workspace, "chamber"));
      await rm(ws, { recursive: true, force: true });
    }
  });

  it("/mind with an unknown slug fails", async () => {
    expect(await rib.invokeCommand?.("mind", "ghost", ctx)).toEqual({
      ok: false,
      error: 'No Mind "ghost".',
    });
  });

  it("/genesis <brief> resolves to a run-workflow effect", async () => {
    expect(await rib.invokeCommand?.("genesis", "a careful planner", ctx)).toEqual({
      ok: true,
      effect: { effect: "run-workflow", workflow: "chamber-genesis", args: "a careful planner" },
    });
  });

  it("/genesis with no brief fails", async () => {
    const res = await rib.invokeCommand?.("genesis", "  ", ctx);
    expect(res?.ok).toBe(false);
  });

  it("/lens <subject> resolves to a run-workflow effect", async () => {
    expect(await rib.invokeCommand?.("lens", "release risks", ctx)).toEqual({
      ok: true,
      effect: { effect: "run-workflow", workflow: "chamber-lens", args: "release risks" },
    });
  });

  it("/lens with no subject fails", async () => {
    const res = await rib.invokeCommand?.("lens", "  ", ctx);
    expect(res?.ok).toBe(false);
  });
});
