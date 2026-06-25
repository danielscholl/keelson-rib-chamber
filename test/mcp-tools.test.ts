import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  MessageChunk,
  RibContext,
  SnapshotManager,
  ToolContext,
  ToolDefinition,
} from "@keelson/shared";
import type { RunAgentTurn } from "../src/agent-turn.ts";
import rib from "../src/index.ts";
import { createFileLensStore } from "../src/lens-store.ts";
import { readMinds, scaffoldMind } from "../src/minds-store.ts";
import { lensesDir, mindsDir, roomsDir, setChamberDataHome } from "../src/paths.ts";
import { createFileRoomStore, listRooms } from "../src/room-store.ts";
import type { Room } from "../src/types.ts";
import { abortableRunAgentTurn } from "./helpers/fakes.ts";

// The list/cleanup tools are the always-on seams — they reach an MCP client over
// the rib's registered tool registry. These tests exercise them directly (the
// genesis -> convene -> read -> clean up lifecycle an external agent drives).

const registerTools = rib.registerTools;
if (!registerTools) throw new Error("rib is missing registerTools");

// A no-op SnapshotManager double — only the room-control path needs it; the list
// and cleanup tools touch disk only, so most tests pass none.
function fakeSnapshotManager(): SnapshotManager {
  const composers = new Map<string, () => unknown>();
  return {
    register(key: string, compose: () => unknown) {
      composers.set(key, compose);
      return () => composers.delete(key);
    },
    async recompose(key: string) {
      await composers.get(key)?.();
      return undefined;
    },
    latest: () => undefined,
    keys: () => [...composers.keys()],
    dispose: async () => {},
  } as unknown as SnapshotManager;
}

function makeCtx(
  opts: {
    run?: RunAgentTurn;
    sm?: SnapshotManager;
    refreshWorkflow?: RibContext["refreshWorkflow"];
  } = {},
): RibContext {
  return {
    getExec: () => ({
      runJSON: async <T>() => ({ ok: true as const, data: undefined as T }),
      runText: async () => ({ ok: true as const, data: "" }),
    }),
    ...(opts.sm ? { getSnapshotManager: () => opts.sm, registerRegion: () => () => {} } : {}),
    ...(opts.run ? { runAgentTurn: opts.run } : {}),
    ...(opts.refreshWorkflow ? { refreshWorkflow: opts.refreshWorkflow } : {}),
  } as RibContext;
}

function makeToolCtx() {
  const chunks: MessageChunk[] = [];
  const ctx: ToolContext = {
    cwd: ".",
    emit: (c) => chunks.push(c),
    abortSignal: new AbortController().signal,
  };
  return {
    ctx,
    out: () => chunks.map((c) => (c as { content?: string }).content ?? "").join(""),
    errored: () => chunks.some((c) => (c as { isError?: boolean }).isError === true),
  };
}

function room(over: Partial<Room> & Pick<Room, "slug" | "status" | "createdAt">): Room {
  return {
    name: over.name ?? over.slug,
    strategy: "sequential",
    participants: ["alice", "bob"],
    turnBudget: 8,
    turnIndex: 0,
    round: 0,
    ...over,
  };
}

let workspace: string;
let tools: readonly ToolDefinition[];
function tool(list: readonly ToolDefinition[], name: string): ToolDefinition {
  const t = list.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
}

const at = "2026-01-01T00:00:00.000Z";

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "chamber-mcp-tools-"));
  setChamberDataHome(join(workspace, "chamber"));
  await rib.dispose?.();
  const seeds: Array<[string, string, string]> = [
    ["alice", "Alice", "skeptic"],
    ["bob", "Bob", "builder"],
    ["doomed", "Doomed", "placeholder"],
  ];
  for (const [slug, name, role] of seeds) {
    await scaffoldMind(
      mindsDir(),
      { slug, name, role, voice: "plain", persona: `You are ${name}.`, createdAt: at },
      `${name}'s soul.`,
    );
  }
  const lensStore = createFileLensStore(lensesDir());
  await lensStore.saveLens({
    id: "release-risks",
    board: { view: "board", title: "Risks", sections: [] },
    scope: "checklist",
    maintainingMind: "alice",
    reason: "added a risk",
  });
  await lensStore.saveLens({
    id: "plain-lens",
    board: { view: "board", title: "Plain", sections: [] },
  });
  const roomStore = createFileRoomStore(roomsDir());
  // The active room is OLDER than the done room, so listRooms (newest-first) returns
  // [done, active] — the list tool must still surface the active one first.
  await roomStore.saveRoom(
    room({ slug: "room-live", status: "active", turnIndex: 2, createdAt: at }),
  );
  await roomStore.saveRoom(
    room({
      slug: "room-done",
      status: "done",
      turnIndex: 4,
      turnBudget: 4,
      createdAt: "2026-01-02T00:00:00.000Z",
    }),
  );
  tools = registerTools(makeCtx());
});

afterAll(async () => {
  await rib.dispose?.();
  setChamberDataHome(undefined);
  await rm(workspace, { recursive: true, force: true });
});

describe("chamber list tools (read-only observability over MCP)", () => {
  it("advertises the list tools as read-only (reach the default MCP endpoint)", () => {
    expect(tool(tools, "chamber_list_minds").state_changing).toBe(false);
    expect(tool(tools, "chamber_list_rooms").state_changing).toBe(false);
    expect(tool(tools, "chamber_list_lenses").state_changing).toBe(false);
  });

  it("chamber_list_minds returns the roster with slug/name/role/tagline + pins", async () => {
    const t = makeToolCtx();
    await tool(tools, "chamber_list_minds").execute({}, t.ctx);
    expect(t.errored()).toBe(false);
    const out = JSON.parse(t.out()) as {
      count: number;
      minds: { slug: string; name: string; role: string; tagline: string }[];
    };
    expect(out.count).toBe(out.minds.length);
    const alice = out.minds.find((m) => m.slug === "alice");
    expect(alice).toMatchObject({ name: "Alice", role: "skeptic", tagline: "You are Alice." });
    expect(out.minds.some((m) => m.slug === "doomed")).toBe(true);
  });

  it("chamber_list_rooms surfaces active rooms first, then ended ones", async () => {
    const t = makeToolCtx();
    await tool(tools, "chamber_list_rooms").execute({}, t.ctx);
    expect(t.errored()).toBe(false);
    const out = JSON.parse(t.out()) as {
      count: number;
      rooms: { slug: string; status: string; strategy: string; participants: string[] }[];
    };
    expect(out.count).toBe(2);
    // The active room sorts ahead of the (newer) done room despite being older.
    expect(out.rooms[0]).toMatchObject({ slug: "room-live", status: "active" });
    expect(out.rooms[1]).toMatchObject({ slug: "room-done", status: "done" });
    expect(out.rooms[0]?.participants).toEqual(["alice", "bob"]);
  });

  it("chamber_list_lenses lists lenses newest-first with provenance", async () => {
    const t = makeToolCtx();
    await tool(tools, "chamber_list_lenses").execute({}, t.ctx);
    expect(t.errored()).toBe(false);
    const out = JSON.parse(t.out()) as {
      count: number;
      lenses: { id: string; scope?: string; maintainingMind?: string; reason?: string }[];
    };
    expect(out.count).toBe(2);
    const risks = out.lenses.find((l) => l.id === "release-risks");
    expect(risks).toMatchObject({
      scope: "checklist",
      maintainingMind: "alice",
      reason: "added a risk",
    });
    const plain = out.lenses.find((l) => l.id === "plain-lens");
    expect(plain?.scope).toBeUndefined();
  });
});

describe("chamber cleanup tools (drive cleanup over MCP)", () => {
  it("advertises retire-mind / delete-room as state-changing", () => {
    expect(tool(tools, "chamber_retire_mind").state_changing).toBe(true);
    expect(tool(tools, "chamber_room_delete").state_changing).toBe(true);
  });

  it("chamber_retire_mind removes a Mind, then refreshes the roster + standing panels", async () => {
    const refreshed: string[] = [];
    const refreshTools = registerTools(
      makeCtx({
        refreshWorkflow: async (name) => {
          refreshed.push(name);
        },
      }),
    );
    expect((await readMinds(mindsDir())).some((m) => m.slug === "doomed")).toBe(true);
    const t = makeToolCtx();
    await tool(refreshTools, "chamber_retire_mind").execute({ slug: "doomed" }, t.ctx);
    expect(t.errored()).toBe(false);
    expect(JSON.parse(t.out())).toMatchObject({ ok: true, slug: "doomed" });
    expect((await readMinds(mindsDir())).some((m) => m.slug === "doomed")).toBe(false);
    expect(refreshed).toEqual(["chamber-roster", "chamber-activity", "chamber-digest"]);
  });

  it("chamber_retire_mind fails closed on an unknown slug, refreshing nothing", async () => {
    const refreshed: string[] = [];
    const refreshTools = registerTools(
      makeCtx({
        refreshWorkflow: async (name) => {
          refreshed.push(name);
        },
      }),
    );
    const t = makeToolCtx();
    await tool(refreshTools, "chamber_retire_mind").execute({ slug: "ghost" }, t.ctx);
    expect(t.errored()).toBe(true);
    expect(t.out()).toContain("ghost");
    expect(refreshed).toEqual([]);
  });

  it("chamber_room_delete deletes an ended room and drops it from the index", async () => {
    const t = makeToolCtx();
    await tool(tools, "chamber_room_delete").execute({ room: "room-done" }, t.ctx);
    expect(t.errored()).toBe(false);
    expect(JSON.parse(t.out())).toMatchObject({ ok: true, slug: "room-done" });
    expect((await listRooms(roomsDir())).some((r) => r.slug === "room-done")).toBe(false);
  });

  it("chamber_room_delete fails closed on an unknown room", async () => {
    const t = makeToolCtx();
    await tool(tools, "chamber_room_delete").execute({ room: "room-ghost" }, t.ctx);
    expect(t.errored()).toBe(true);
  });
});

describe("chamber_room_delete refuses an active room (stop it first)", () => {
  let liveTools: readonly ToolDefinition[];
  let abort: ReturnType<typeof abortableRunAgentTurn>;
  let openedSlug = "";
  let liveHome: string;

  beforeAll(async () => {
    // Isolate this suite in its own home so a real driver-started active room never
    // shares state with the disk-seeded `room-live` the list-tool suite uses. The
    // abortable fake holds the first turn in flight so the room stays active across
    // the assertions.
    await rib.dispose?.();
    liveHome = await mkdtemp(join(tmpdir(), "chamber-mcp-live-"));
    setChamberDataHome(join(liveHome, "chamber"));
    for (const [slug, name] of [
      ["alice", "Alice"],
      ["bob", "Bob"],
    ] as [string, string][]) {
      await scaffoldMind(
        mindsDir(),
        { slug, name, role: "debater", voice: "plain", persona: `You are ${name}.`, createdAt: at },
        `${name}'s soul.`,
      );
    }
    abort = abortableRunAgentTurn();
    liveTools = registerTools(makeCtx({ run: abort.run, sm: fakeSnapshotManager() }));
    const start = makeToolCtx();
    await tool(liveTools, "chamber_room_start").execute(
      { participants: ["alice", "bob"], turnBudget: 4, confirm: true },
      start.ctx,
    );
    openedSlug = start.out().match(/Opened room "([^"]+)"/)?.[1] ?? "";
    await abort.started;
  });

  afterAll(async () => {
    await rib.dispose?.();
    // Restore the shared home so the file-level afterAll tears down the right tree.
    setChamberDataHome(join(workspace, "chamber"));
    await rm(liveHome, { recursive: true, force: true });
  });

  it("refuses while active, then deletes once stopped", async () => {
    expect(openedSlug).toMatch(/^room-/);
    const refused = makeToolCtx();
    await tool(liveTools, "chamber_room_delete").execute({ room: openedSlug }, refused.ctx);
    expect(refused.errored()).toBe(true);
    expect(refused.out()).toContain("stop the room");

    const stop = makeToolCtx();
    await tool(liveTools, "chamber_room_stop").execute({ room: openedSlug }, stop.ctx);
    expect(stop.errored()).toBe(false);

    const del = makeToolCtx();
    await tool(liveTools, "chamber_room_delete").execute({ room: openedSlug }, del.ctx);
    expect(del.errored()).toBe(false);
    expect((await listRooms(roomsDir())).some((r) => r.slug === openedSlug)).toBe(false);
  });
});

describe("list tools stay valid JSON when the result is capped", () => {
  let bigHome: string;

  beforeAll(async () => {
    await rib.dispose?.();
    bigHome = await mkdtemp(join(tmpdir(), "chamber-mcp-big-"));
    setChamberDataHome(join(bigHome, "chamber"));
    // Several Minds with very long taglines push the serialized list past the 16 KB
    // tool-result budget, so the tool must omit rows rather than truncate the JSON.
    const long = "x".repeat(7000);
    for (let i = 0; i < 5; i++) {
      await scaffoldMind(
        mindsDir(),
        {
          slug: `big-${i}`,
          name: `Big ${i}`,
          role: "filler",
          voice: "plain",
          persona: long,
          createdAt: at,
        },
        "soul",
      );
    }
  });

  afterAll(async () => {
    await rib.dispose?.();
    setChamberDataHome(join(workspace, "chamber"));
    await rm(bigHome, { recursive: true, force: true });
  });

  it("omits rows instead of emitting unparseable JSON", async () => {
    const listTools = registerTools(makeCtx());
    const t = makeToolCtx();
    await tool(listTools, "chamber_list_minds").execute({}, t.ctx);
    expect(t.errored()).toBe(false);
    // The result must parse — boundedText would have truncated this mid-string.
    const out = JSON.parse(t.out()) as { count: number; omitted?: number; minds: unknown[] };
    expect(out.count).toBe(5); // total still reported
    expect(out.minds.length).toBeLessThan(5); // some rows omitted to stay in budget
    expect(out.omitted).toBe(5 - out.minds.length);
    expect(t.out().length).toBeLessThanOrEqual(16_100);
  });
});
