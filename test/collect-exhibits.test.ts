import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFileLensStore } from "../src/lens-store.ts";

// The out-of-process exhibits-index collector the chamber-exhibits workflow runs,
// plus its lenses sibling — exercised against ONE home holding both species so the
// kind split is proven at the collector boundary, not just in the builders.
const EXHIBITS_COLLECTOR = fileURLToPath(new URL("../bin/collect-exhibits.ts", import.meta.url));
const LENSES_COLLECTOR = fileURLToPath(new URL("../bin/collect-lenses.ts", import.meta.url));

async function run(collector: string, home: string): Promise<{ out: string; code: number }> {
  const proc = Bun.spawn(["bun", collector, home], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { out, code };
}

describe("collect-exhibits", () => {
  test("the two collectors split one store by kind", async () => {
    const home = await mkdtemp(join(tmpdir(), "chamber-collect-exhibits-"));
    try {
      const store = createFileLensStore(join(home, "lenses"));
      await store.saveLens({
        id: "morning-brief",
        board: { view: "board", title: "Morning Brief", sections: [] },
      });
      await store.saveLens({
        id: "sample-assessment",
        board: { view: "board", title: "Sample Assessment", sections: [] },
        kind: "exhibit",
        sourceRoom: "sample-review",
      });

      const exhibits = await run(EXHIBITS_COLLECTOR, home);
      expect(exhibits.code).toBe(0);
      expect(exhibits.out).toContain("sample-assessment");
      expect(exhibits.out).toContain("sample-review");
      expect(exhibits.out).not.toContain("morning-brief");

      const lenses = await run(LENSES_COLLECTOR, home);
      expect(lenses.code).toBe(0);
      expect(lenses.out).toContain("morning-brief");
      expect(lenses.out).not.toContain("sample-assessment");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("a missing lenses dir degrades to the empty index (zero sections)", async () => {
    const home = await mkdtemp(join(tmpdir(), "chamber-collect-exhibits-"));
    try {
      const { out, code } = await run(EXHIBITS_COLLECTOR, home);
      expect(code).toBe(0);
      const board = JSON.parse(out) as { view: string; sections: unknown[] };
      expect(board.view).toBe("board");
      expect(board.sections).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
