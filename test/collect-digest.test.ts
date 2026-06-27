import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CanvasBoardView } from "@keelson/shared";
import { chamberFingerprint, readChamberRecords } from "../src/chamber-state.ts";
import { writeDigest } from "../src/digest-store.ts";
import { scaffoldMind } from "../src/minds-store.ts";

// The out-of-process collectors the chamber-digest workflow runs. Each reads the data
// HOME baked into its argv (the keelson-home-rooted path the rib captured in-process)
// and derives the store dirs from it (see collect-activity).
const GATE = fileURLToPath(new URL("../bin/collect-digest-gate.ts", import.meta.url));
const PUBLISH = fileURLToPath(new URL("../bin/collect-digest-publish.ts", import.meta.url));

async function run(script: string, home: string): Promise<{ out: string; code: number }> {
  const proc = Bun.spawn(["bun", script, home], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { out, code };
}

async function seedMind(home: string, slug: string, name: string): Promise<void> {
  await scaffoldMind(
    join(home, "minds"),
    {
      slug,
      name,
      role: "r",
      voice: "v",
      persona: `I am ${name}.`,
      createdAt: new Date().toISOString(),
    },
    `# ${name}\n`,
  );
}

function dirsOf(home: string) {
  return {
    mindsDir: join(home, "minds"),
    roomsDir: join(home, "rooms"),
    lensesDir: join(home, "lenses"),
  };
}

describe("collect-digest-gate", () => {
  test("a cold store with content → dirty:true and a summary naming the content", async () => {
    const home = await mkdtemp(join(tmpdir(), "chamber-digest-gate-"));
    try {
      await seedMind(home, "ada", "Ada");
      const { out, code } = await run(GATE, home);
      expect(code).toBe(0);
      const { dirty, summary } = JSON.parse(out) as { dirty: boolean; summary: string };
      expect(dirty).toBe(true);
      expect(summary).toContain("Ada");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("an empty chamber → dirty:false (no content is not worth a paid turn)", async () => {
    const home = await mkdtemp(join(tmpdir(), "chamber-digest-gate-"));
    try {
      const { out, code } = await run(GATE, home);
      expect(code).toBe(0);
      expect((JSON.parse(out) as { dirty: boolean }).dirty).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("a stored fingerprint matching the live state → dirty:false (quiet)", async () => {
    const home = await mkdtemp(join(tmpdir(), "chamber-digest-gate-"));
    try {
      await seedMind(home, "ada", "Ada");
      const { minds, rooms, lenses } = await readChamberRecords(dirsOf(home));
      const fingerprint = chamberFingerprint(minds, rooms, lenses);
      const board: CanvasBoardView = { view: "board", title: "Digest", sections: [] };
      await writeDigest({ board, fingerprint }, home);
      const { out, code } = await run(GATE, home);
      expect(code).toBe(0);
      expect((JSON.parse(out) as { dirty: boolean }).dirty).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("a stored fingerprint that no longer matches → dirty:true (re-author)", async () => {
    const home = await mkdtemp(join(tmpdir(), "chamber-digest-gate-"));
    try {
      await seedMind(home, "ada", "Ada");
      const board: CanvasBoardView = { view: "board", title: "Digest", sections: [] };
      await writeDigest({ board, fingerprint: "stale" }, home);
      const { out, code } = await run(GATE, home);
      expect(code).toBe(0);
      expect((JSON.parse(out) as { dirty: boolean }).dirty).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("collect-digest-publish", () => {
  test("emits the stored board while the chamber has content", async () => {
    const home = await mkdtemp(join(tmpdir(), "chamber-digest-publish-"));
    try {
      await seedMind(home, "ada", "Ada");
      const board: CanvasBoardView = { view: "board", title: "Authored", sections: [] };
      await writeDigest({ board, fingerprint: "fp" }, home);
      const { out, code } = await run(PUBLISH, home);
      expect(code).toBe(0);
      const published = JSON.parse(out) as CanvasBoardView;
      expect(published.title).toBe("Authored");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("falls back to the cold board once the chamber empties (no stale population)", async () => {
    const home = await mkdtemp(join(tmpdir(), "chamber-digest-publish-"));
    try {
      // A board authored when Minds existed, persisted; the Minds are then gone (empty
      // store). The gate won't re-author an empty chamber, so the publish tick must not
      // keep showing the stale board that still names them.
      const board: CanvasBoardView = { view: "board", title: "Authored", sections: [] };
      await writeDigest({ board, fingerprint: "stale" }, home);
      const { out, code } = await run(PUBLISH, home);
      expect(code).toBe(0);
      const published = JSON.parse(out) as CanvasBoardView;
      expect(published.title).not.toBe("Authored");
      expect(out).toContain("Warming up");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("emits the cold-start board when no digest exists yet", async () => {
    const home = await mkdtemp(join(tmpdir(), "chamber-digest-publish-"));
    try {
      const { out, code } = await run(PUBLISH, home);
      expect(code).toBe(0);
      const published = JSON.parse(out) as CanvasBoardView;
      expect(published.view).toBe("board");
      expect(out).toContain("Warming up");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
