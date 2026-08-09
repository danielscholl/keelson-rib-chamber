import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFileLensStore } from "../src/lens-store.ts";
import { scaffoldMind } from "../src/minds-store.ts";

// The out-of-process lenses-index collector the chamber-lenses workflow runs. It
// reads the data HOME baked into its argv (the keelson-home-rooted path the rib
// captured in-process) and derives both the lenses and minds dirs from it, so the
// two processes agree without a shared env var.
const COLLECTOR = fileURLToPath(new URL("../bin/collect-lenses.ts", import.meta.url));

async function runCollector(
  home: string,
  activeWorkflowVersions: Readonly<Record<string, string>> = {},
): Promise<{ out: string; code: number }> {
  const proc = Bun.spawn(["bun", COLLECTOR, home, JSON.stringify(activeWorkflowVersions)], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { out, code };
}

describe("collect-lenses", () => {
  test("reads the data home from argv[2] and dots each lens by its maintaining Mind's tone", async () => {
    const home = await mkdtemp(join(tmpdir(), "chamber-collect-lenses-"));
    try {
      const store = createFileLensStore(join(home, "lenses"));
      await store.saveLens({
        id: "release-risks",
        board: { view: "board", title: "Release Risks", sections: [] },
        maintainingMind: "Ada",
      });
      // The Mind that maintains the lens, seated on identity slot 0 (id-blue).
      await scaffoldMind(
        join(home, "minds"),
        {
          slug: "ada",
          name: "Ada",
          role: "Chief of Staff",
          voice: "crisp",
          persona: "You are Ada.",
          createdAt: "2026-01-01T00:00:00.000Z",
          identitySlot: 0,
        },
        "# Ada\n",
      );
      const { out, code } = await runCollector(home);
      expect(code).toBe(0);
      const board = JSON.parse(out) as {
        view: string;
        sections: { kind: string; items?: { dot?: string }[] }[];
      };
      expect(board.view).toBe("board");
      expect(out).toContain("release-risks");
      const card = board.sections.find((s) => s.kind === "cards")?.items?.[0];
      expect(card?.dot).toBe("id-blue");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("an unknown maintainer (or none) folds the dot to neutral", async () => {
    const home = await mkdtemp(join(tmpdir(), "chamber-collect-lenses-"));
    try {
      const store = createFileLensStore(join(home, "lenses"));
      await store.saveLens({
        id: "orphan",
        board: { view: "board", title: "Orphan", sections: [] },
        maintainingMind: "Nobody",
      });
      const { out, code } = await runCollector(home);
      expect(code).toBe(0);
      const board = JSON.parse(out) as {
        sections: { kind: string; items?: { dot?: string }[] }[];
      };
      const card = board.sections.find((s) => s.kind === "cards")?.items?.[0];
      expect(card?.dot).toBe("neutral");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("an empty / missing lenses dir → a valid empty-state board (no throw)", async () => {
    const home = await mkdtemp(join(tmpdir(), "chamber-collect-lenses-"));
    try {
      const { out, code } = await runCollector(join(home, "missing"));
      expect(code).toBe(0);
      const board = JSON.parse(out) as { view: string };
      expect(board.view).toBe("board");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("an exhibit never reaches the lenses index — one store, split by kind", async () => {
    // Lenses and exhibits share the lens store, so this collector's kind filter is the
    // only thing keeping a room's deliverable off the standing-views shelf.
    const home = await mkdtemp(join(tmpdir(), "chamber-collect-lenses-"));
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

      const { out, code } = await runCollector(home);
      expect(code).toBe(0);
      expect(out).toContain("morning-brief");
      expect(out).not.toContain("sample-assessment");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("compares installed workflow files with the captured active version", async () => {
    const home = await mkdtemp(join(tmpdir(), "chamber-collect-lenses-"));
    const workflow = `description: Produce release status
nodes:
  - id: compose
    prompt: Compose release status.
`;
    try {
      const store = createFileLensStore(join(home, "lenses"));
      await store.saveLens({
        id: "release-status",
        board: { view: "board", title: "Release Status", sections: [] },
        refresh: { workflow: "chamber-lens-release-status" },
      });
      const workflowDir = join(home, "lens-workflows");
      await mkdir(workflowDir, { recursive: true });
      const file = join(workflowDir, "release-status.yml");
      await writeFile(file, workflow);
      const activeVersion = createHash("sha256").update(workflow).digest("hex");

      const active = await runCollector(home, {
        "chamber-lens-release-status": activeVersion,
      });
      expect(active.code).toBe(0);
      expect(active.out).not.toContain("stale definition");

      await writeFile(file, workflow.replace("Compose release status.", "Compose current status."));
      const stale = await runCollector(home, {
        "chamber-lens-release-status": activeVersion,
      });
      expect(stale.code).toBe(0);
      expect(stale.out).toContain("stale definition");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
