import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scaffoldMind } from "../src/minds-store.ts";
import { createFileRoomStore } from "../src/room-store.ts";
import type { Room } from "../src/types.ts";

// The out-of-process rooms-index collector the chamber-rooms workflow runs. It
// reads the data home baked into its argv (the keelson-home-rooted path the rib
// captured in-process) and derives the rooms + minds dirs from it, so the two
// processes agree without a shared env var.
const COLLECTOR = fileURLToPath(new URL("../bin/collect-rooms.ts", import.meta.url));

const room = (over: Partial<Room> = {}): Room => ({
  slug: "room-1",
  name: "Q3 priorities",
  strategy: "sequential",
  participants: ["ada", "bo"],
  status: "done",
  turnBudget: 6,
  turnIndex: 6,
  round: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

async function runCollector(home: string): Promise<{ out: string; code: number }> {
  const proc = Bun.spawn(["bun", COLLECTOR, home], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { out, code };
}

describe("collect-rooms", () => {
  test("reads the data home from argv[2] and emits a sessions index with active + closed rooms", async () => {
    const home = await mkdtemp(join(tmpdir(), "chamber-collect-rooms-"));
    try {
      const store = createFileRoomStore(join(home, "rooms"));
      await store.saveRoom(room({ slug: "room-ended", name: "Ended room", status: "done" }));
      await store.saveRoom(room({ slug: "room-live", name: "Live room", status: "active" }));
      const { out, code } = await runCollector(home);
      expect(code).toBe(0);
      const board = JSON.parse(out) as {
        view: string;
        sections: { kind: string; items: { title: string; pill?: { label: string } }[] }[];
      };
      expect(board.view).toBe("board");
      const items = board.sections.find((s) => s.kind === "cards")?.items ?? [];
      // Both sessions are indexed; the active one comes first with an "active" pill.
      expect(items.map((i) => i.title)).toEqual(["Live room", "Ended room"]);
      expect(items[0]?.pill?.label).toContain("active");
      // The ended room is actionable, so its slug rides its Open/Delete payloads.
      expect(out).toContain("room-ended");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("seated Minds tone the cast: a participant renders as a people entry in its seat hue", async () => {
    const home = await mkdtemp(join(tmpdir(), "chamber-collect-rooms-"));
    try {
      await scaffoldMind(
        join(home, "minds"),
        {
          slug: "ada",
          name: "Ada",
          role: "Chief of Staff",
          voice: "calm",
          persona: "You are Ada.",
          createdAt: "2026-01-01T00:00:00.000Z",
          identitySlot: 0,
        },
        "soul ada",
      );
      const store = createFileRoomStore(join(home, "rooms"));
      await store.saveRoom(room({ participants: ["ada", "ghost"] }));
      const { out, code } = await runCollector(home);
      expect(code).toBe(0);
      const board = JSON.parse(out) as {
        sections: {
          kind: string;
          items: { fields?: { label?: string; people?: { name: string; tone?: string }[] }[] }[];
        }[];
      };
      const withField = board.sections
        .find((s) => s.kind === "cards")
        ?.items[0]?.fields?.find((f) => f.label === "with");
      expect(withField?.people).toEqual([{ name: "Ada", tone: "id-blue" }, { name: "ghost" }]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("an empty / missing data home → a valid empty-state board (no throw)", async () => {
    const home = await mkdtemp(join(tmpdir(), "chamber-collect-rooms-"));
    try {
      const { out, code } = await runCollector(join(home, "missing"));
      expect(code).toBe(0);
      const board = JSON.parse(out) as { view: string };
      expect(board.view).toBe("board");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
