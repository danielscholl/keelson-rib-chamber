import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFileLensStore } from "../src/lens-store.ts";
import { scaffoldMind } from "../src/minds-store.ts";
import { createFileRoomStore } from "../src/room-store.ts";
import type { Room } from "../src/types.ts";

// The out-of-process activity collector the chamber-activity workflow runs. It reads
// the data HOME baked into its argv (the keelson-home-rooted path the rib captured
// in-process) and derives the three store dirs from it.
const COLLECTOR = fileURLToPath(new URL("../bin/collect-activity.ts", import.meta.url));

async function runCollector(home: string): Promise<{ out: string; code: number }> {
  const proc = Bun.spawn(["bun", COLLECTOR, home], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { out, code };
}

const room = (over: Partial<Room> = {}): Room => ({
  slug: "room-1",
  name: "Standup",
  strategy: "sequential",
  participants: ["ada", "bo"],
  status: "done",
  turnBudget: 8,
  turnIndex: 5,
  round: 0,
  createdAt: new Date().toISOString(),
  ...over,
});

describe("collect-activity", () => {
  test("reads the data home from argv[2] and emits a standing activity board", async () => {
    const home = await mkdtemp(join(tmpdir(), "chamber-collect-activity-"));
    try {
      await scaffoldMind(
        join(home, "minds"),
        {
          slug: "ada",
          name: "Ada",
          role: "Chief",
          voice: "warm",
          persona: "You are Ada.",
          createdAt: new Date().toISOString(),
        },
        "# Ada\n",
      );
      await createFileRoomStore(join(home, "rooms")).saveRoom(room());
      await createFileLensStore(join(home, "lenses")).saveLens({
        id: "release-risks",
        board: { view: "board", title: "Release Risks", sections: [] },
      });
      const { out, code } = await runCollector(home);
      expect(code).toBe(0);
      const board = JSON.parse(out) as { view: string };
      expect(board.view).toBe("board");
      // Each store contributes a feed row.
      expect(out).toContain("Ada");
      expect(out).toContain("Standup");
      expect(out).toContain("Release Risks");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("a missing data home → a valid empty-state board (no throw)", async () => {
    const home = await mkdtemp(join(tmpdir(), "chamber-collect-activity-"));
    try {
      const { out, code } = await runCollector(join(home, "missing"));
      expect(code).toBe(0);
      const board = JSON.parse(out) as { view: string };
      expect(board.view).toBe("board");
      expect(out).toContain("No activity yet");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
