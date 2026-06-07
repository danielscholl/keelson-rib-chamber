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
import { scaffoldMind } from "../src/minds-store.ts";
import { mindsDir, roomsDir } from "../src/paths.ts";
import { createFileRoomStore } from "../src/room-store.ts";
import { abortableRunAgentTurn } from "./helpers/fakes.ts";

const registerTools = rib.registerTools;
if (!registerTools) throw new Error("rib is missing registerTools");

// A minimal SnapshotManager double: registerTools registers the room key and
// primes it, and the driver's publisher recomposes on each turn. The tools test
// only needs those calls to not throw.
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

function makeCtx(run?: RunAgentTurn, sm?: SnapshotManager): RibContext {
  return {
    getExec: () => ({
      runJSON: async <T>() => ({ ok: true as const, data: undefined as T }),
      runText: async () => ({ ok: true as const, data: "" }),
    }),
    ...(sm ? { getSnapshotManager: () => sm } : {}),
    ...(run ? { runAgentTurn: run } : {}),
  } as RibContext;
}

// A ToolContext that records emitted chunks so a test can read the tool's output.
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

const sm = fakeSnapshotManager();
let abort: ReturnType<typeof abortableRunAgentTurn>;
let tools: readonly ToolDefinition[];
function tool(name: string): ToolDefinition {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
}

let workspace: string;
let prevWorkspace: string | undefined;
beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "chamber-tools-"));
  prevWorkspace = process.env.KEELSON_WORKSPACE;
  process.env.KEELSON_WORKSPACE = workspace;
  const at = "2026-01-01T00:00:00.000Z";
  await scaffoldMind(
    mindsDir(),
    {
      slug: "alice",
      name: "Alice",
      role: "skeptic",
      voice: "terse",
      persona: "You are Alice.",
      createdAt: at,
    },
    "Alice's soul.",
  );
  await scaffoldMind(
    mindsDir(),
    {
      slug: "bob",
      name: "Bob",
      role: "builder",
      voice: "warm",
      persona: "You are Bob.",
      createdAt: at,
    },
    "Bob's soul.",
  );
  // An abort-aware turn holds the first turn in flight (it resolves only on abort),
  // so a started room stays active for the status/say assertions until stop.
  abort = abortableRunAgentTurn();
  // Reset module-global room state (activeSlug / lastSlug / the driver singleton)
  // a prior test file may have left set, then build a fresh driver for this file.
  await rib.dispose?.();
  tools = registerTools(makeCtx(abort.run, sm));
});
afterAll(async () => {
  await rib.dispose?.();
  if (prevWorkspace === undefined) delete process.env.KEELSON_WORKSPACE;
  else process.env.KEELSON_WORKSPACE = prevWorkspace;
  await rm(workspace, { recursive: true, force: true });
});

describe("chamber room-control chat tools", () => {
  let openedSlug = "";

  it("registers the four room-control tools, and none without the seams", () => {
    expect(tools.map((t) => t.name).sort()).toEqual([
      "chamber_room_say",
      "chamber_room_start",
      "chamber_room_status",
      "chamber_room_stop",
    ]);
    // No runAgentTurn -> no driver -> no tools (fails closed like the actions do).
    expect(registerTools(makeCtx(undefined, sm))).toEqual([]);
  });

  it("advertises start/say/stop as state-changing and start as requiring confirmation", () => {
    expect(tool("chamber_room_status").state_changing ?? false).toBe(false);
    expect(tool("chamber_room_start").state_changing).toBe(true);
    expect(tool("chamber_room_start").requires_confirmation).toBe(true);
    expect(tool("chamber_room_say").state_changing).toBe(true);
    expect(tool("chamber_room_stop").state_changing).toBe(true);
  });

  it("chamber_room_status reports no room before one is started", async () => {
    const t = makeToolCtx();
    await tool("chamber_room_status").execute({}, t.ctx);
    expect(t.out()).toContain("No Chamber room yet");
  });

  it("chamber_room_start dry-runs without confirm and opens nothing", async () => {
    const t = makeToolCtx();
    await tool("chamber_room_start").execute(
      { participants: ["alice", "bob"], turnBudget: 2 },
      t.ctx,
    );
    expect(t.errored()).toBe(false);
    expect(t.out()).toContain("Would open a room with alice, bob");
    expect(t.out()).toContain("confirm:true");
    // The dry run touched nothing — still no room.
    const s = makeToolCtx();
    await tool("chamber_room_status").execute({}, s.ctx);
    expect(s.out()).toContain("No Chamber room yet");
  });

  it("rejects a start with fewer than two participants", async () => {
    const t = makeToolCtx();
    await tool("chamber_room_start").execute({ participants: ["alice"], confirm: true }, t.ctx);
    expect(t.errored()).toBe(true);
  });

  it("rejects a start whose participants dedupe to fewer than two", async () => {
    // Schema .min(2) counts raw entries; validateStart de-dupes and re-checks.
    const t = makeToolCtx();
    await tool("chamber_room_start").execute(
      { participants: ["alice", "alice"], confirm: true },
      t.ctx,
    );
    expect(t.errored()).toBe(true);
    expect(t.out()).toContain("2 distinct");
  });

  it("rejects a start naming a Mind that does not exist", async () => {
    // The chat tool takes free-form slugs; a typo must fail before any paid turn.
    const t = makeToolCtx();
    await tool("chamber_room_start").execute(
      { participants: ["alice", "ghost"], confirm: true },
      t.ctx,
    );
    expect(t.errored()).toBe(true);
    expect(t.out()).toContain("unknown Mind");
  });

  it("chamber_room_start with confirm opens a room the status tool then reports", async () => {
    const t = makeToolCtx();
    await tool("chamber_room_start").execute(
      { participants: ["alice", "bob"], turnBudget: 4, confirm: true },
      t.ctx,
    );
    expect(t.errored()).toBe(false);
    expect(t.out()).toContain("Opened room");
    openedSlug = t.out().match(/Opened room "([^"]+)"/)?.[1] ?? "";
    expect(openedSlug).toMatch(/^room-/);

    await abort.started; // the first turn is in flight -> the room is active
    const s = makeToolCtx();
    await tool("chamber_room_status").execute({}, s.ctx);
    expect(s.out()).toContain("alice");
    expect(s.out()).toContain("bob");
    expect(s.out()).toContain("active");
  });

  it("refuses a second start while a room is active", async () => {
    const t = makeToolCtx();
    await tool("chamber_room_start").execute(
      { participants: ["alice", "bob"], confirm: true },
      t.ctx,
    );
    expect(t.errored()).toBe(true);
    expect(t.out()).toContain("already active");
  });

  it("chamber_room_say injects a director direction into the active room", async () => {
    const t = makeToolCtx();
    await tool("chamber_room_say").execute({ direction: "wrap up" }, t.ctx);
    expect(t.errored()).toBe(false);
    expect(t.out()).toContain("Sent to the room");
    // The direction reached the driver: it persisted as the room's pending override.
    const room = await createFileRoomStore(roomsDir()).loadRoom(openedSlug);
    expect(room?.pending?.directionInjection).toBe("wrap up");
  });

  it("rejects a say with no fields", async () => {
    const t = makeToolCtx();
    await tool("chamber_room_say").execute({}, t.ctx);
    expect(t.errored()).toBe(true);
  });

  it("chamber_room_stop stops the room; status still shows the finished room", async () => {
    const t = makeToolCtx();
    await tool("chamber_room_stop").execute({}, t.ctx);
    expect(t.errored()).toBe(false);
    expect(t.out()).toContain("Stopped the room");
    expect((await createFileRoomStore(roomsDir()).loadRoom(openedSlug))?.status).toBe("stopped");

    // activeSlug is cleared, but lastSlug keeps the finished room readable.
    const s = makeToolCtx();
    await tool("chamber_room_status").execute({}, s.ctx);
    expect(s.out()).toContain("stopped");
    expect(s.out()).toContain("alice");
  });
});
