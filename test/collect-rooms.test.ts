import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFileLensStore } from "../src/lens-store.ts";
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

async function runCollector(
  home: string,
  projectNames?: string,
): Promise<{ out: string; code: number }> {
  const argv = projectNames === undefined ? [home] : [home, projectNames];
  const proc = Bun.spawn(["bun", COLLECTOR, ...argv], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { out, code };
}

describe("collect-rooms scope", () => {
  const readsOf = (out: string) => {
    const board = JSON.parse(out) as {
      sections: { kind: string; items: { fields?: { label: string; value?: string }[] }[] }[];
    };
    const items = board.sections.find((s) => s.kind === "cards")?.items ?? [];
    return items[0]?.fields?.find((f) => f.label === "reads")?.value;
  };

  test("argv[3] resolves a scoped room's project to its name", async () => {
    const home = await mkdtemp(join(tmpdir(), "chamber-collect-rooms-"));
    try {
      const store = createFileRoomStore(join(home, "rooms"));
      await store.saveRoom(room({ slug: "room-scoped", projectId: "p1" }));
      const { out, code } = await runCollector(home, JSON.stringify({ p1: "subgroup-ci" }));
      expect(code).toBe(0);
      expect(readsOf(out)).toBe("subgroup-ci");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("an unscoped room reads nothing, and a malformed map never throws the collector", async () => {
    // Every other read here degrades rather than throwing; the baked map is no different,
    // and a room falling back to its raw id beats an index that fails to publish at all.
    const home = await mkdtemp(join(tmpdir(), "chamber-collect-rooms-"));
    try {
      const store = createFileRoomStore(join(home, "rooms"));
      await store.saveRoom(room({ slug: "room-plain" }));
      for (const bad of ["", "not json", "[1,2]", "null"]) {
        const { out, code } = await runCollector(home, bad);
        expect(code).toBe(0);
        expect(readsOf(out)).toBe("nothing");
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("a project absent from the map degrades to its id, never to nothing", async () => {
    const home = await mkdtemp(join(tmpdir(), "chamber-collect-rooms-"));
    try {
      const store = createFileRoomStore(join(home, "rooms"));
      await store.saveRoom(room({ slug: "room-newer", projectId: "added-later" }));
      const { out, code } = await runCollector(home, JSON.stringify({ p1: "subgroup-ci" }));
      expect(code).toBe(0);
      expect(readsOf(out)).toBe("added-later");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

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

  test("gates Summary from the room marker without reading a transcript", async () => {
    const home = await mkdtemp(join(tmpdir(), "chamber-collect-rooms-"));
    try {
      const store = createFileRoomStore(join(home, "rooms"));
      await store.saveRoom(
        room({
          slug: "marked",
          name: "Marked",
          outcomeAt: "2026-01-01T00:05:00.000Z",
        }),
      );
      await store.saveRoom(room({ slug: "legacy", name: "Legacy" }));

      const { out, code } = await runCollector(home);

      expect(code).toBe(0);
      const board = JSON.parse(out) as {
        sections: {
          kind: string;
          items: { title: string; actions?: { type: string }[] }[];
        }[];
      };
      const items = board.sections.find((section) => section.kind === "cards")?.items ?? [];
      const actionsFor = (title: string) =>
        items.find((item) => item.title === title)?.actions?.map((action) => action.type);
      expect(actionsFor("Marked")).toEqual(["room-open", "room-summary", "room-delete"]);
      expect(actionsFor("Legacy")).toEqual(["room-open", "room-delete"]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("a magentic room's ledger backs its composition bar; a torn ledger keeps the turn fill", async () => {
    const home = await mkdtemp(join(tmpdir(), "chamber-collect-rooms-"));
    try {
      const store = createFileRoomStore(join(home, "rooms"));
      await store.saveRoom(
        room({
          slug: "planned",
          name: "Planned",
          strategy: "magentic",
          status: "active",
          turnIndex: 2,
        }),
      );
      await store.saveLedger("planned", {
        roomSlug: "planned",
        goal: "g",
        manager: "mgr",
        status: "executing",
        updatedAt: "t",
        tasks: [
          {
            id: "t1",
            description: "build it",
            status: "completed",
            createdAt: "t",
            updatedAt: "t",
          },
          { id: "t2", description: "test it", status: "pending", createdAt: "t", updatedAt: "t" },
        ],
      });
      await store.saveRoom(
        room({ slug: "torn", name: "Torn", strategy: "magentic", status: "active", turnIndex: 3 }),
      );
      await writeFile(join(home, "rooms", "torn", "ledger.json"), "{not json");

      const { out, code } = await runCollector(home);

      expect(code).toBe(0);
      const board = JSON.parse(out) as {
        sections: { kind: string; items: { title: string; bar?: unknown }[] }[];
      };
      const items = board.sections.find((s) => s.kind === "cards")?.items ?? [];
      const barFor = (title: string) => items.find((i) => i.title === title)?.bar;
      expect(barFor("Planned")).toEqual({
        segments: [
          { label: "completed", n: 1, tone: "ok" },
          { label: "in-progress", n: 0, tone: "info" },
          { label: "pending", n: 1, tone: "neutral" },
          { label: "failed", n: 0, tone: "error" },
        ],
      });
      expect(barFor("Torn")).toEqual({ value: 3, total: 6 });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("a room's tabled exhibits ride its card; sibling lenses stay off it", async () => {
    const home = await mkdtemp(join(tmpdir(), "chamber-collect-rooms-"));
    try {
      await createFileRoomStore(join(home, "rooms")).saveRoom(
        room({ slug: "review", name: "Sample Review", status: "done" }),
      );
      const lensStore = createFileLensStore(join(home, "lenses"));
      await lensStore.saveLens({
        id: "assessment",
        board: { view: "board", title: "Sample Assessment", sections: [] },
        kind: "exhibit",
        sourceRoom: "review",
      });
      await lensStore.saveLens({
        id: "morning-brief",
        board: { view: "board", title: "Morning Brief", sections: [] },
      });
      const { out, code } = await runCollector(home);
      expect(code).toBe(0);
      expect(out).toContain("Sample Assessment");
      expect(out).not.toContain("Morning Brief");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
