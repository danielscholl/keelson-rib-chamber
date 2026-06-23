import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFileLensStore } from "../src/lens-store.ts";

// The out-of-process lenses-index collector the chamber-lenses workflow runs. It
// reads the lenses dir baked into its argv (the keelson-home-rooted path the rib
// captured in-process), so the two processes agree without a shared env var.
const COLLECTOR = fileURLToPath(new URL("../bin/collect-lenses.ts", import.meta.url));

async function runCollector(lensesRoot: string): Promise<{ out: string; code: number }> {
  const proc = Bun.spawn(["bun", COLLECTOR, lensesRoot], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { out, code };
}

describe("collect-lenses", () => {
  test("reads the lenses dir from argv[2] and emits a living-views index of lenses", async () => {
    const root = await mkdtemp(join(tmpdir(), "chamber-collect-lenses-"));
    try {
      const store = createFileLensStore(root);
      await store.saveLens({
        id: "release-risks",
        board: { view: "board", title: "Release Risks", sections: [] },
      });
      const { out, code } = await runCollector(root);
      expect(code).toBe(0);
      const board = JSON.parse(out) as { view: string };
      expect(board.view).toBe("board");
      expect(out).toContain("release-risks");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an empty / missing lenses dir → a valid empty-state board (no throw)", async () => {
    const root = await mkdtemp(join(tmpdir(), "chamber-collect-lenses-"));
    try {
      const { out, code } = await runCollector(join(root, "missing"));
      expect(code).toBe(0);
      const board = JSON.parse(out) as { view: string };
      expect(board.view).toBe("board");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
