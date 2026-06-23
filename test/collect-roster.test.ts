import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scaffoldMind } from "../src/minds-store.ts";
import { writeWatermark } from "../src/watermark-store.ts";

// The out-of-process roster collector the chamber-roster workflow runs. It reads the
// data HOME baked into its argv (the keelson-home-rooted path the rib captured
// in-process) and derives the minds dir, the draft, and the pulse's state + watermark
// all from it — so the two processes agree without a shared env var.
const COLLECTOR = fileURLToPath(new URL("../bin/collect-roster.ts", import.meta.url));

function runCollector(home: string): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["bun", COLLECTOR, home], { stdout: "pipe", stderr: "ignore" });
  return (async () => {
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    return { code, out };
  })();
}

async function seedMind(home: string): Promise<void> {
  await scaffoldMind(
    join(home, "minds"),
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
}

describe("collect-roster", () => {
  test("reads the data home from argv[2] and emits a roster board of its Minds", async () => {
    const home = await mkdtemp(join(tmpdir(), "chamber-collect-"));
    try {
      await seedMind(home);
      const { code, out } = await runCollector(home);
      expect(code).toBe(0);
      const board = JSON.parse(out) as { view: string };
      expect(board.view).toBe("board");
      expect(out).toContain("ada");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("emits the pulse stats section, with for-you reflecting the watermark", async () => {
    const home = await mkdtemp(join(tmpdir(), "chamber-collect-"));
    try {
      await seedMind(home);
      // A promoted watermark → the pulse's "For you" reads as a waiting briefing.
      await writeWatermark(
        {
          ackedEndedRooms: [],
          lensFingerprints: {},
          briefPromoted: true,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        home,
      );
      const { code, out } = await runCollector(home);
      expect(code).toBe(0);
      const board = JSON.parse(out) as {
        sections: { kind: string; items?: { label: string; value: string | number }[] }[];
      };
      // The pulse leads the board.
      const stats = board.sections[0];
      expect(stats?.kind).toBe("stats");
      const byLabel = new Map((stats?.items ?? []).map((i) => [i.label, i.value]));
      expect(byLabel.get("For you")).toBe("1 waiting");
      expect(byLabel.get("Team")).toBe(1);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
