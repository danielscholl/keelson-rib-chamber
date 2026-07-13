import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setChamberDataHome } from "../src/paths.ts";
import { bindRuntime, disposeRuntime, refreshWorkflow } from "../src/runtime.ts";

// The stable refreshWorkflow wrapper reads the host seam at call time, so its
// lifecycle guarantees — routes to the bound seam, no-ops after dispose, and a
// rebind targets ONLY the new seam — are what a post-dispose fire-and-forget
// (or a re-bootstrap) relies on. bindRuntime with no snapshot manager skips the
// panel/genesis wiring, isolating the seam behavior under test.
let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "chamber-runtime-"));
  setChamberDataHome(home);
});

afterEach(async () => {
  await disposeRuntime();
  // Reset the module-global data home so the temp path can't leak into a later
  // test file (mirrors test/paths.test.ts and test/rib.test.ts teardown).
  setChamberDataHome(undefined);
  await rm(home, { recursive: true, force: true });
});

describe("runtime refreshWorkflow lifecycle", () => {
  test("routes to the bound seam, no-ops after dispose, and rebinds to only the new seam", async () => {
    const seamA: string[] = [];
    bindRuntime({
      refreshWorkflow: (name) => {
        seamA.push(name);
        return Promise.resolve();
      },
    });
    await refreshWorkflow("chamber-roster");
    expect(seamA).toEqual(["chamber-roster"]);

    // Dispose drops the seam: a post-dispose refresh must resolve without calling it.
    await disposeRuntime();
    await expect(refreshWorkflow("chamber-roster")).resolves.toBeUndefined();
    expect(seamA).toEqual(["chamber-roster"]);

    // Rebind with a fresh seam: refreshWorkflow targets ONLY the new one.
    const seamB: string[] = [];
    bindRuntime({
      refreshWorkflow: (name) => {
        seamB.push(name);
        return Promise.resolve();
      },
    });
    await refreshWorkflow("chamber-rooms");
    expect(seamA).toEqual(["chamber-roster"]);
    expect(seamB).toEqual(["chamber-rooms"]);
  });
});
