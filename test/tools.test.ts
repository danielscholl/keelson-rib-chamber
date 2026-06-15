import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
import { readMinds, scaffoldMind } from "../src/minds-store.ts";
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
  await scaffoldMind(
    mindsDir(),
    {
      slug: "mod",
      name: "Mod",
      role: "moderator",
      voice: "neutral",
      persona: "You are Mod.",
      createdAt: at,
    },
    "Mod's soul.",
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

  it("registers the genesis + lens seams always, plus the room-control tools with the seams", () => {
    expect(tools.map((t) => t.name).sort()).toEqual([
      "chamber_emit_genesis",
      "chamber_emit_lens",
      "chamber_room_say",
      "chamber_room_start",
      "chamber_room_status",
      "chamber_room_stop",
    ]);
    // No runAgentTurn -> no driver -> no room tools, but the genesis write seam and
    // the lens publish seam (both need only the snapshot manager) are still there.
    expect(registerTools(makeCtx(undefined, sm)).map((t) => t.name)).toEqual([
      "chamber_emit_genesis",
      "chamber_emit_lens",
    ]);
  });

  it("chamber_emit_lens publishes a board and reports its slot", async () => {
    const t = makeToolCtx();
    await tool("chamber_emit_lens").execute(
      { id: "lens-demo", board: { view: "board", title: "Demo", sections: [] } },
      t.ctx,
    );
    expect(t.errored()).toBe(false);
    const out = JSON.parse(t.out()) as { ok: boolean; slot: number; key: string };
    expect(out.ok).toBe(true);
    expect(typeof out.slot).toBe("number");
    expect(out.key).toMatch(/^rib:chamber:lens:\d+$/);
  });

  it("chamber_emit_lens fails closed on a non-board payload", async () => {
    const t = makeToolCtx();
    await tool("chamber_emit_lens").execute({ id: "bad", board: { view: "board" } }, t.ctx);
    expect(t.errored()).toBe(true);
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

  it("a `moderator` with no explicit strategy is treated as group-chat", async () => {
    // The dry-run labels it group-chat AND validateStart enforces group-chat rules:
    // a valid (non-participant) moderator dry-runs as group-chat...
    const ok = makeToolCtx();
    await tool("chamber_room_start").execute(
      { participants: ["alice", "bob"], moderator: "mod" },
      ok.ctx,
    );
    expect(ok.errored()).toBe(false);
    expect(ok.out()).toContain("group-chat, moderated by mod");
    // ...and a moderator that is also a participant is rejected (it would have been
    // silently ignored if the request defaulted to sequential).
    const bad = makeToolCtx();
    await tool("chamber_room_start").execute(
      { participants: ["alice", "bob"], moderator: "alice" },
      bad.ctx,
    );
    expect(bad.errored()).toBe(true);
    expect(bad.out()).toContain("must not also be a participant");
  });

  it("dry-runs open-floor and validates its config (no moderator, in-range threshold)", async () => {
    // A valid two-Mind open-floor request dry-runs cleanly — it needs no extra fields.
    const ok = makeToolCtx();
    await tool("chamber_room_start").execute(
      { participants: ["alice", "bob"], strategy: "open-floor" },
      ok.ctx,
    );
    expect(ok.errored()).toBe(false);
    // An out-of-range end-vote threshold is rejected in the dry-run, not at start.
    const badThreshold = makeToolCtx();
    await tool("chamber_room_start").execute(
      { participants: ["alice", "bob"], strategy: "open-floor", endVoteThreshold: 1.5 },
      badThreshold.ctx,
    );
    expect(badThreshold.errored()).toBe(true);
    expect(badThreshold.out()).toContain("in (0,1)");
    // A moderator makes no sense for an unmoderated room.
    const withMod = makeToolCtx();
    await tool("chamber_room_start").execute(
      { participants: ["alice", "bob"], strategy: "open-floor", moderator: "mod" },
      withMod.ctx,
    );
    expect(withMod.errored()).toBe(true);
    expect(withMod.out()).toContain("no moderator");
    // A synthesizer is rejected too (not silently dropped) — open-floor has no close
    // synthesis, so reusing a group-chat payload surfaces why the field had no effect.
    const withSynth = makeToolCtx();
    await tool("chamber_room_start").execute(
      { participants: ["alice", "bob"], strategy: "open-floor", synthesizer: "mod" },
      withSynth.ctx,
    );
    expect(withSynth.errored()).toBe(true);
    expect(withSynth.out()).toContain("synthesizer");
  });

  it("rejects a prototype-chain string as a strategy", async () => {
    const t = makeToolCtx();
    await tool("chamber_room_start").execute(
      { participants: ["alice", "bob"], strategy: "constructor" },
      t.ctx,
    );
    expect(t.errored()).toBe(true);
    expect(t.out()).toContain("unknown strategy");
  });

  it("rejects a reserved-authority synthesizer", async () => {
    const t = makeToolCtx();
    await tool("chamber_room_start").execute(
      { participants: ["alice", "bob"], moderator: "mod", synthesizer: "system" },
      t.ctx,
    );
    expect(t.errored()).toBe(true);
    expect(t.out()).toContain("not director/system");
  });

  it("rejects a synthesizer that is also a participant (mirrors the moderator rule)", async () => {
    const t = makeToolCtx();
    await tool("chamber_room_start").execute(
      { participants: ["alice", "bob"], moderator: "mod", synthesizer: "bob" },
      t.ctx,
    );
    expect(t.errored()).toBe(true);
    expect(t.out()).toContain("must not also be a participant");
  });

  it("rejects a synthesizer that is also the moderator (distinct roles)", async () => {
    const t = makeToolCtx();
    await tool("chamber_room_start").execute(
      { participants: ["alice", "bob"], moderator: "mod", synthesizer: "mod" },
      t.ctx,
    );
    expect(t.errored()).toBe(true);
    expect(t.out()).toContain("must not also be the moderator");
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

  it("rejects a say that calls on a non-participant", async () => {
    const t = makeToolCtx();
    await tool("chamber_room_say").execute({ callOn: "ghost" }, t.ctx);
    expect(t.errored()).toBe(true);
    expect(t.out()).toContain("not a participant");
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

  it("does not start a room when the request is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const chunks: MessageChunk[] = [];
    const ctx: ToolContext = { cwd: ".", emit: (c) => chunks.push(c), abortSignal: ac.signal };
    await tool("chamber_room_start").execute(
      { participants: ["alice", "bob"], confirm: true },
      ctx,
    );
    // Aborted before the state-changing start — nothing opened, nothing emitted.
    expect(chunks.length).toBe(0);
  });
});

describe("chamber_emit_genesis (genesis write seam)", () => {
  it("is advertised as state-changing", () => {
    expect(tool("chamber_emit_genesis").state_changing).toBe(true);
  });

  it("persists a Mind (mind.json + SOUL.md) and reports its slug", async () => {
    const t = makeToolCtx();
    await tool("chamber_emit_genesis").execute(
      {
        name: "Ariadne",
        role: "security reviewer",
        voice: "terse",
        soul: "# Ariadne\n## Persona\nA meticulous reviewer.",
        tagline: "Meticulous security reviewer.",
      },
      t.ctx,
    );
    expect(t.errored()).toBe(false);
    expect(t.out()).toContain('"slug":"ariadne"');
    const ariadne = (await readMinds(mindsDir())).find((m) => m.slug === "ariadne");
    expect(ariadne?.persona).toBe("Meticulous security reviewer.");
    const soul = await readFile(join(mindsDir(), "ariadne", "SOUL.md"), "utf8");
    expect(soul).toContain("## Persona");
  });

  it("fails closed on a slug collision (alice was seeded)", async () => {
    const t = makeToolCtx();
    await tool("chamber_emit_genesis").execute(
      { name: "Alice", role: "skeptic", voice: "terse", soul: "# Alice", tagline: "dupe" },
      t.ctx,
    );
    expect(t.errored()).toBe(true);
    expect(t.out()).toContain("already exists");
  });

  it("fails closed on a missing soul, writing nothing", async () => {
    const t = makeToolCtx();
    await tool("chamber_emit_genesis").execute(
      { name: "Ghost", role: "x", voice: "y", tagline: "z" },
      t.ctx,
    );
    expect(t.errored()).toBe(true);
    expect((await readMinds(mindsDir())).some((m) => m.slug === "ghost")).toBe(false);
  });
});
