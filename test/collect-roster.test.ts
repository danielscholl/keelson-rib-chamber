import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scaffoldMind } from "../src/minds-store.ts";

// The out-of-process roster collector the chamber-roster workflow runs. It must
// read the minds dir baked into its argv (the keelson-home-rooted path the rib
// captured in-process), so the two processes agree without a shared env var.
const COLLECTOR = fileURLToPath(new URL("../bin/collect-roster.ts", import.meta.url));

describe("collect-roster", () => {
  test("reads the minds dir from argv[2] and emits a roster board of that dir's Minds", async () => {
    const home = await mkdtemp(join(tmpdir(), "chamber-collect-"));
    const minds = join(home, "chamber", "minds");
    try {
      await scaffoldMind(
        minds,
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
      const proc = Bun.spawn(["bun", COLLECTOR, minds], { stdout: "pipe", stderr: "ignore" });
      const out = await new Response(proc.stdout).text();
      const code = await proc.exited;
      expect(code).toBe(0);
      const board = JSON.parse(out) as { view: string };
      expect(board.view).toBe("board");
      expect(out).toContain("ada");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
