import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  MessageChunk,
  Project,
  RibContext,
  SnapshotManager,
  ToolContext,
  ToolDefinition,
} from "@keelson/shared";
import type { RunAgentTurn } from "../src/agent-turn.ts";
import { readDigest } from "../src/digest-store.ts";
import rib, { MAX_ACTIVE_ROOMS } from "../src/index.ts";
import { listLenses } from "../src/lens-store.ts";
import { readMinds, scaffoldMind } from "../src/minds-store.ts";
import { lensesDir, mindsDir, roomsDir, setChamberDataHome } from "../src/paths.ts";
import { createFileRoomStore } from "../src/room-store.ts";
import type { Room, TurnEntry } from "../src/types.ts";
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

function makeCtx(
  run?: RunAgentTurn,
  sm?: SnapshotManager,
  refreshWorkflow?: RibContext["refreshWorkflow"],
  getProjects?: RibContext["getProjects"],
): RibContext {
  return {
    getExec: () => ({
      runJSON: async <T>() => ({ ok: true as const, data: undefined as T }),
      runText: async () => ({ ok: true as const, data: "" }),
    }),
    // Lenses need both the snapshot manager and the registerRegion seam; supply a
    // no-op region registrar alongside the manager so the lens tool wires up.
    ...(sm ? { getSnapshotManager: () => sm, registerRegion: () => () => {} } : {}),
    ...(run ? { runAgentTurn: run } : {}),
    ...(refreshWorkflow ? { refreshWorkflow } : {}),
    ...(getProjects ? { getProjects } : {}),
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
    chunkCount: () => chunks.length,
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
beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "chamber-tools-"));
  setChamberDataHome(join(workspace, "chamber"));
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
  // Provider-pinned Minds for the cross-vendor `review` strategy: scribe (claude)
  // and critic (codex) are a valid cross-vendor pair; twin (claude) makes a
  // same-vendor pair with scribe; alice/bob carry no provider pin.
  await scaffoldMind(
    mindsDir(),
    {
      slug: "scribe",
      name: "Scribe",
      role: "author",
      voice: "plain",
      persona: "You are Scribe.",
      provider: "claude",
      createdAt: at,
    },
    "Scribe's soul.",
  );
  await scaffoldMind(
    mindsDir(),
    {
      slug: "critic",
      name: "Critic",
      role: "reviewer",
      voice: "sharp",
      persona: "You are Critic.",
      provider: "codex",
      createdAt: at,
    },
    "Critic's soul.",
  );
  await scaffoldMind(
    mindsDir(),
    {
      slug: "twin",
      name: "Twin",
      role: "author",
      voice: "plain",
      persona: "You are Twin.",
      provider: "claude",
      createdAt: at,
    },
    "Twin's soul.",
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
  setChamberDataHome(undefined);
  await rm(workspace, { recursive: true, force: true });
});

describe("chamber room-control chat tools", () => {
  let openedSlug = "";

  it("registers the always-on seams (genesis/digest + list/cleanup), plus the lens and room tools with their seams", () => {
    expect(tools.map((t) => t.name).sort()).toEqual([
      "chamber_delete_exhibit",
      "chamber_emit_digest",
      "chamber_emit_genesis",
      "chamber_emit_lens",
      "chamber_emit_lens_html",
      "chamber_list_exhibits",
      "chamber_list_lenses",
      "chamber_list_minds",
      "chamber_list_rooms",
      "chamber_retire_lens",
      "chamber_retire_mind",
      "chamber_room_delete",
      "chamber_room_say",
      "chamber_room_start",
      "chamber_room_status",
      "chamber_room_stop",
      "chamber_room_transcript",
      "chamber_table_exhibit",
    ]);
    // No runAgentTurn -> no driver -> no room-control tools, but the always-on seams
    // (genesis + digest writes, the read-only list tools, and the retire-mind /
    // delete-room cleanup tools) plus the lens publish + retire seams (which need only
    // the snapshot manager + registerRegion) are still there.
    expect(
      registerTools(makeCtx(undefined, sm))
        .map((t) => t.name)
        .sort(),
    ).toEqual(
      [
        "chamber_delete_exhibit",
        "chamber_emit_digest",
        "chamber_emit_genesis",
        "chamber_emit_lens",
        "chamber_emit_lens_html",
        "chamber_list_exhibits",
        "chamber_list_lenses",
        "chamber_list_minds",
        "chamber_list_rooms",
        "chamber_retire_lens",
        "chamber_retire_mind",
        "chamber_room_delete",
        "chamber_room_transcript",
        "chamber_table_exhibit",
      ].sort(),
    );
    // Without the snapshot/registerRegion seams the lens tools are withheld fail-closed,
    // but the always-on seams (genesis/digest writes + the list and cleanup tools, which
    // only touch disk) remain.
    expect(
      registerTools(makeCtx(undefined, undefined))
        .map((t) => t.name)
        .sort(),
    ).toEqual([
      "chamber_emit_digest",
      "chamber_emit_genesis",
      "chamber_list_exhibits",
      "chamber_list_lenses",
      "chamber_list_minds",
      "chamber_list_rooms",
      "chamber_retire_mind",
      "chamber_room_delete",
      "chamber_room_transcript",
    ]);
  });

  it("chamber_emit_lens publishes a board and reports its key", async () => {
    const t = makeToolCtx();
    await tool("chamber_emit_lens").execute(
      { id: "lens-demo", board: { view: "board", title: "Demo", sections: [] } },
      t.ctx,
    );
    expect(t.errored()).toBe(false);
    const out = JSON.parse(t.out()) as { ok: boolean; key: string };
    expect(out.ok).toBe(true);
    expect(out.key).toBe("rib:chamber:lens:lens-demo");
  });

  it("chamber_emit_lens fails closed on a non-board payload", async () => {
    const t = makeToolCtx();
    await tool("chamber_emit_lens").execute({ id: "bad", board: { view: "board" } }, t.ctx);
    expect(t.errored()).toBe(true);
  });

  it("chamber_emit_lens fails closed on a board that fails the publish-time gate", async () => {
    // Duplicate table column keys pass the board member schema but fail the canvas
    // union's uniqueness refine — the tool must report the error, not a silent ok.
    const t = makeToolCtx();
    await tool("chamber_emit_lens").execute(
      {
        id: "dup",
        board: {
          view: "board",
          title: "Dup",
          sections: [{ kind: "table", columns: [{ key: "a" }, { key: "a" }], rows: [] }],
        },
      },
      t.ctx,
    );
    expect(t.errored()).toBe(true);
  });

  it("chamber_emit_lens canonicalizes the id so one subject maps to one key", async () => {
    const spaced = makeToolCtx();
    await tool("chamber_emit_lens").execute(
      { id: "Release Risks", board: { view: "board", title: "R1", sections: [] } },
      spaced.ctx,
    );
    const kebab = makeToolCtx();
    await tool("chamber_emit_lens").execute(
      { id: "release-risks", board: { view: "board", title: "R2", sections: [] } },
      kebab.ctx,
    );
    const keyA = (JSON.parse(spaced.out()) as { key: string }).key;
    const keyB = (JSON.parse(kebab.out()) as { key: string }).key;
    // "Release Risks" and "release-risks" canonicalize to one key, one panel.
    expect(keyA).toBe(keyB);
    expect(keyA).toBe("rib:chamber:lens:release-risks");
  });

  it("chamber_emit_lens rejects an id with no usable characters", async () => {
    const t = makeToolCtx();
    await tool("chamber_emit_lens").execute(
      { id: "!!!", board: { view: "board", title: "X", sections: [] } },
      t.ctx,
    );
    expect(t.errored()).toBe(true);
  });

  it("chamber_emit_lens accepts provenance and persists it on the record", async () => {
    const t = makeToolCtx();
    await tool("chamber_emit_lens").execute(
      {
        id: "with-prov",
        board: { view: "board", title: "Prov", sections: [] },
        scope: "checklist",
        maintainingMind: "alice",
        reason: "added a risk",
      },
      t.ctx,
    );
    expect(t.errored()).toBe(false);
    const rec = (await listLenses(lensesDir())).find((l) => l.id === "with-prov");
    expect(rec?.scope).toBe("checklist");
    expect(rec?.maintainingMind).toBe("alice");
    expect(rec?.reason).toBe("added a risk");
  });

  it("chamber_emit_lens still works with no provenance — record carries none", async () => {
    const t = makeToolCtx();
    await tool("chamber_emit_lens").execute(
      { id: "no-prov", board: { view: "board", title: "Plain", sections: [] } },
      t.ctx,
    );
    expect(t.errored()).toBe(false);
    const rec = (await listLenses(lensesDir())).find((l) => l.id === "no-prov");
    expect(rec).toBeDefined();
    expect(rec?.scope).toBeUndefined();
    expect(rec?.maintainingMind).toBeUndefined();
    expect(rec?.reason).toBeUndefined();
  });

  it("chamber_emit_lens_html advertises state_changing", () => {
    expect(tool("chamber_emit_lens_html").state_changing).toBe(true);
  });

  it("chamber_emit_lens_html publishes html and reports its key", async () => {
    const t = makeToolCtx();
    await tool("chamber_emit_lens_html").execute({ html: "<p>hello lens</p>" }, t.ctx);
    expect(t.errored()).toBe(false);
    const out = JSON.parse(t.out()) as { ok: boolean; key: string };
    expect(out.ok).toBe(true);
    expect(out.key).toBe("rib:chamber:lens-html");
  });

  it("chamber_emit_lens_html fails closed on empty html", async () => {
    const t = makeToolCtx();
    await tool("chamber_emit_lens_html").execute({ html: "" }, t.ctx);
    expect(t.errored()).toBe(true);
  });

  it("chamber_emit_lens_html fails closed on oversized html (> 256 KB)", async () => {
    const t = makeToolCtx();
    await tool("chamber_emit_lens_html").execute({ html: "x".repeat(262145) }, t.ctx);
    expect(t.errored()).toBe(true);
  });

  it("chamber_retire_lens advertises state_changing", () => {
    expect(tool("chamber_retire_lens").state_changing).toBe(true);
  });

  it("chamber_retire_lens retires a lens: deletes from disk AND drops the live panel", async () => {
    const emit = makeToolCtx();
    await tool("chamber_emit_lens").execute(
      { id: "to-retire", board: { view: "board", title: "Bye", sections: [] } },
      emit.ctx,
    );
    expect(emit.errored()).toBe(false);
    expect((await listLenses(lensesDir())).some((l) => l.id === "to-retire")).toBe(true);

    const t = makeToolCtx();
    await tool("chamber_retire_lens").execute({ id: "to-retire" }, t.ctx);
    expect(t.errored()).toBe(false);
    const out = JSON.parse(t.out()) as { ok: boolean; key: string };
    expect(out.ok).toBe(true);
    expect(out.key).toBe("rib:chamber:lens:to-retire");
    // The persisted record is gone, so a subsequent listing omits it.
    expect((await listLenses(lensesDir())).some((l) => l.id === "to-retire")).toBe(false);
  });

  it("chamber_retire_lens canonicalizes the id ('Release Risks' -> release-risks)", async () => {
    const emit = makeToolCtx();
    await tool("chamber_emit_lens").execute(
      { id: "release-risks", board: { view: "board", title: "R", sections: [] } },
      emit.ctx,
    );
    const t = makeToolCtx();
    await tool("chamber_retire_lens").execute({ id: "Release Risks" }, t.ctx);
    expect(t.errored()).toBe(false);
    expect((await listLenses(lensesDir())).some((l) => l.id === "release-risks")).toBe(false);
  });

  it("chamber_retire_lens fails closed on an unknown/already-retired id", async () => {
    const t = makeToolCtx();
    await tool("chamber_retire_lens").execute({ id: "ghost-lens" }, t.ctx);
    expect(t.errored()).toBe(true);
    expect(t.out()).toContain("ghost-lens");
  });

  it("chamber_retire_lens fails closed on an id with no usable characters", async () => {
    const t = makeToolCtx();
    await tool("chamber_retire_lens").execute({ id: "!!!" }, t.ctx);
    expect(t.errored()).toBe(true);
  });

  it("refreshes chamber-lenses, the roster pulse, and the standing panels after a successful retire, not when it fails", async () => {
    const refreshed: string[] = [];
    const refreshTools = registerTools(
      makeCtx(undefined, sm, async (name) => {
        refreshed.push(name);
      }),
    );
    const emit = refreshTools.find((x) => x.name === "chamber_emit_lens");
    const retire = refreshTools.find((x) => x.name === "chamber_retire_lens");
    if (!emit || !retire) throw new Error("lens tools not found");
    await emit.execute(
      { id: "refresh-lens", board: { view: "board", title: "R", sections: [] } },
      makeToolCtx().ctx,
    );
    refreshed.length = 0;
    // A successful retire refreshes the index AND the roster (its "Live views" count
    // drops with the lens), plus the one narrator: refreshStandingPanels nudges the
    // digest gate (which re-composes now the lens is gone) and re-publishes the footer.
    await retire.execute({ id: "refresh-lens" }, makeToolCtx().ctx);
    expect(refreshed).toEqual(["chamber-lenses", "chamber-roster", "chamber-digest"]);
    // ...a failed one (unknown id) does not.
    refreshed.length = 0;
    const failed = makeToolCtx();
    await retire.execute({ id: "still-gone" }, failed.ctx);
    expect(failed.errored()).toBe(true);
    expect(refreshed).toEqual([]);
  });

  it("advertises start/say/stop as state-changing and start as requiring confirmation", () => {
    expect(tool("chamber_room_status").state_changing ?? false).toBe(false);
    expect(tool("chamber_room_transcript").state_changing ?? false).toBe(false);
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

  it("chamber_room_status surfaces the grounding brief (criteria-bearing and source-only)", async () => {
    const store = createFileRoomStore(roomsDir());
    const base: Room = {
      slug: "room-grounded",
      name: "Grounded",
      strategy: "sequential",
      participants: ["alice", "bob"],
      status: "active",
      turnBudget: 8,
      turnIndex: 0,
      round: 0,
      grounding: { sourceUrl: "https://x/204", criteria: ["First", "Second"] },
      createdAt: "2026-01-02T00:00:00.000Z",
    };
    await store.saveRoom(base);
    const t1 = makeToolCtx();
    await tool("chamber_room_status").execute({ room: "room-grounded" }, t1.ctx);
    expect(t1.out()).toContain("Grounding");
    expect(t1.out()).toContain("https://x/204");
    expect(t1.out()).toContain("First");
    expect(t1.out()).toContain("Second");

    await store.saveRoom({
      ...base,
      slug: "room-source-only",
      grounding: { sourceUrl: "https://x/spec", criteria: [] },
    });
    const t2 = makeToolCtx();
    await tool("chamber_room_status").execute({ room: "room-source-only" }, t2.ctx);
    expect(t2.out()).toContain("Grounding");
    expect(t2.out()).toContain("https://x/spec");
  });

  it("chamber_room_transcript pages the full persisted transcript exactly", async () => {
    const store = createFileRoomStore(roomsDir());
    const room: Room = {
      slug: "room-transcript-long",
      name: "Long transcript",
      strategy: "sequential",
      participants: ["alice", "bob"],
      status: "done",
      turnBudget: 64,
      turnIndex: 37,
      round: 18,
      topic: "Long-form transcript pagination",
      createdAt: "2026-01-02T00:00:00.000Z",
    };
    await store.saveRoom(room);
    const transcript: TurnEntry[] = Array.from({ length: 37 }, (_, i) => ({
      messageId: `msg-${String(i).padStart(2, "0")}`,
      roomSlug: room.slug,
      turnIndex: i,
      round: Math.floor(i / 2),
      from: i % 2 === 0 ? "alice" : "bob",
      role: "agent",
      parts: [
        {
          text: `entry ${i}\n${"x".repeat(700)}\nkeeps exact text ${i}`,
        },
      ],
      at: `2026-01-02T00:${String(i).padStart(2, "0")}:00.000Z`,
      ...(i === 9 ? { usage: { inputTokens: 10, outputTokens: 20 } } : {}),
    }));
    for (const entry of transcript) await store.appendTranscript(room.slug, entry);

    const pages: TurnEntry[][] = [];
    let cursor: number | null = 0;
    while (cursor !== null) {
      const t = makeToolCtx();
      await tool("chamber_room_transcript").execute(
        { room: room.slug, offset: cursor, limit: 13 },
        t.ctx,
      );
      expect(t.errored()).toBe(false);
      const out = JSON.parse(t.out()) as {
        ok: true;
        room: string;
        offset: number;
        limit: number;
        total: number;
        nextCursor: number | null;
        entries: TurnEntry[];
      };
      expect(out.ok).toBe(true);
      expect(out.room).toBe(room.slug);
      expect(out.offset).toBe(cursor);
      expect(out.limit).toBe(13);
      expect(out.total).toBe(transcript.length);
      pages.push(out.entries);
      cursor = out.nextCursor;
    }

    expect(pages.map((p) => p.length)).toEqual([13, 13, 11]);
    expect(pages.flat()).toEqual(transcript);

    const unknown = makeToolCtx();
    await tool("chamber_room_transcript").execute({ room: "room-transcript-ghost" }, unknown.ctx);
    expect(unknown.errored()).toBe(true);
    expect(unknown.out()).toContain("room 'room-transcript-ghost' not found");
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

  it("accepts a grounding brief and discloses the extra paid turns in the dry-run", async () => {
    const t = makeToolCtx();
    await tool("chamber_room_start").execute(
      {
        participants: ["alice", "bob"],
        turnBudget: 2,
        grounding: { sourceUrl: "https://example.test/issue/204", criteria: ["A", "B"] },
      },
      t.ctx,
    );
    expect(t.errored()).toBe(false);
    expect(t.out()).toContain("Would open a room with alice, bob");
    // The confirm gate must disclose the cross-vendor fidelity + synthesis turns so the
    // approver sees the true ceiling, not just the base budget.
    expect(t.out()).toContain("cross-vendor fidelity turn");
    expect(t.out()).toContain("up to 4 total");
  });

  it("rejects an over-limit grounding brief instead of silently truncating it", async () => {
    const t = makeToolCtx();
    await tool("chamber_room_start").execute(
      {
        participants: ["alice", "bob"],
        grounding: { criteria: Array.from({ length: 25 }, (_, i) => `c${i}`) },
      },
      t.ctx,
    );
    expect(t.errored()).toBe(true);
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

  it("rejects a coding room with no project to confine it to", async () => {
    // Coding tools (Bash/Edit/Write) are confined to the project root, so a coding
    // room must target a project. The gate fires in the dry-run, before any paid turn.
    const t = makeToolCtx();
    await tool("chamber_room_start").execute(
      { participants: ["alice", "bob"], coding: true, confirm: true },
      t.ctx,
    );
    expect(t.errored()).toBe(true);
    expect(t.out()).toContain("must target a project");
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

  it("reports every unmet role/config rule for a room start in one error", async () => {
    const expected = [
      "open-floor has no manager — `manager` is only for the magentic strategy",
      "open-floor has no moderator — every speaker nominates the next",
      "open-floor has no closing synthesizer — drop `synthesizer`",
      "endVoteThreshold must be a number in (0,1)",
    ];
    for (const confirm of [false, true]) {
      const t = makeToolCtx();
      await tool("chamber_room_start").execute(
        {
          participants: ["alice", "bob"],
          strategy: "open-floor",
          manager: "mod",
          moderator: "mod",
          synthesizer: "mod",
          endVoteThreshold: 1.5,
          confirm,
        },
        t.ctx,
      );
      expect(t.errored()).toBe(true);
      expect(t.chunkCount()).toBe(1);
      for (const message of expected) {
        expect(t.out()).toContain(message);
      }
    }
  });

  it("review dry-runs a cross-vendor pair and labels the author/reviewer roles", async () => {
    const t = makeToolCtx();
    await tool("chamber_room_start").execute(
      { participants: ["scribe", "critic"], strategy: "review", topic: "Draft an API" },
      t.ctx,
    );
    expect(t.errored()).toBe(false);
    expect(t.out()).toContain("review: scribe reviewed by critic");
  });

  it("review rejects a same-vendor author/reviewer pair", async () => {
    const t = makeToolCtx();
    await tool("chamber_room_start").execute(
      { participants: ["scribe", "twin"], strategy: "review", confirm: true },
      t.ctx,
    );
    expect(t.errored()).toBe(true);
    expect(t.out()).toContain("cross-vendor");
  });

  it("review rejects a pair where a Mind has no provider pin", async () => {
    const t = makeToolCtx();
    await tool("chamber_room_start").execute(
      { participants: ["alice", "scribe"], strategy: "review", confirm: true },
      t.ctx,
    );
    expect(t.errored()).toBe(true);
    expect(t.out()).toContain("cross-vendor");
  });

  it("review rejects more than two participants", async () => {
    const t = makeToolCtx();
    await tool("chamber_room_start").execute(
      { participants: ["scribe", "critic", "twin"], strategy: "review", confirm: true },
      t.ctx,
    );
    expect(t.errored()).toBe(true);
    expect(t.out()).toContain("exactly 2");
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

  it("no longer refuses a second start while a room is active (single-active lifted)", async () => {
    // A second start is now allowed; the dry-run (no confirm) proves the guard is
    // gone without opening a second room, keeping this stateful suite single-room.
    const t = makeToolCtx();
    await tool("chamber_room_start").execute(
      { participants: ["alice", "bob"], turnBudget: 2 },
      t.ctx,
    );
    expect(t.errored()).toBe(false);
    expect(t.out()).toContain("Would open a room");
    expect(t.out()).not.toContain("already active");
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

  it("chamber_room_say targets an explicit room slug", async () => {
    const t = makeToolCtx();
    await tool("chamber_room_say").execute({ room: openedSlug, direction: "focus" }, t.ctx);
    expect(t.errored()).toBe(false);
    const room = await createFileRoomStore(roomsDir()).loadRoom(openedSlug);
    expect(room?.pending?.directionInjection).toBe("focus");
  });

  it("chamber_room_say rejects an inactive/unknown room slug", async () => {
    const t = makeToolCtx();
    await tool("chamber_room_say").execute({ room: "room-ghost", direction: "x" }, t.ctx);
    expect(t.errored()).toBe(true);
    expect(t.out()).toContain("not active");
  });

  it("chamber_room_status targets an explicit room slug", async () => {
    const t = makeToolCtx();
    await tool("chamber_room_status").execute({ room: openedSlug }, t.ctx);
    expect(t.errored()).toBe(false);
    expect(t.out()).toContain(openedSlug);
    expect(t.out()).toContain("alice");
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

  it("persists a Mind (mind.json + SOUL.md) and reports its slug and name", async () => {
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
    expect(t.out()).toContain('"name":"Ariadne"');
    const ariadne = (await readMinds(mindsDir())).find((m) => m.slug === "ariadne");
    expect(ariadne?.persona).toBe("Meticulous security reviewer.");
    const soul = await readFile(join(mindsDir(), "ariadne", "SOUL.md"), "utf8");
    expect(soul).toContain("## Persona");
  });

  it("persists declared capability slugs, dropping unknown ones", async () => {
    const t = makeToolCtx();
    await tool("chamber_emit_genesis").execute(
      {
        name: "Scout",
        role: "researcher",
        voice: "curious",
        soul: "# Scout\n## Persona\nA researcher.",
        tagline: "Finds things out.",
        tools: ["lens", "bogus"],
      },
      t.ctx,
    );
    expect(t.errored()).toBe(false);
    const scout = (await readMinds(mindsDir())).find((m) => m.slug === "scout");
    expect(scout?.tools).toEqual(["lens"]);
  });

  it("omits tools when none are declared", async () => {
    const t = makeToolCtx();
    await tool("chamber_emit_genesis").execute(
      {
        name: "Plain",
        role: "writer",
        voice: "plain",
        soul: "# Plain\n## Persona\nA writer.",
        tagline: "Writes plainly.",
      },
      t.ctx,
    );
    expect(t.errored()).toBe(false);
    const plain = (await readMinds(mindsDir())).find((m) => m.slug === "plain");
    expect(plain).toBeDefined();
    expect(plain?.tools).toBeUndefined();
  });

  it("persists model and provider when both are provided", async () => {
    const t = makeToolCtx();
    await tool("chamber_emit_genesis").execute(
      {
        name: "Pinned",
        role: "reviewer",
        voice: "precise",
        soul: "# Pinned\n## Persona\nA reviewer.",
        tagline: "Pinned to a specific model.",
        model: " claude-opus-4.8 ",
        provider: " anthropic ",
      },
      t.ctx,
    );
    expect(t.errored()).toBe(false);
    const pinned = (await readMinds(mindsDir())).find((m) => m.slug === "pinned");
    expect(pinned?.model).toBe("claude-opus-4.8");
    expect(pinned?.provider).toBe("anthropic");
  });

  it("persists model alone and drops an orphan provider", async () => {
    const t = makeToolCtx();
    await tool("chamber_emit_genesis").execute(
      {
        name: "ModelOnly",
        role: "reviewer",
        voice: "precise",
        soul: "# ModelOnly\n## Persona\nA reviewer.",
        tagline: "Model-only pin.",
        model: "gpt-5.3-codex",
      },
      t.ctx,
    );
    expect(t.errored()).toBe(false);
    const modelOnly = (await readMinds(mindsDir())).find((m) => m.slug === "modelonly");
    expect(modelOnly?.model).toBe("gpt-5.3-codex");
    expect(modelOnly?.provider).toBeUndefined();

    const orphan = makeToolCtx();
    await tool("chamber_emit_genesis").execute(
      {
        name: "OrphanProvider",
        role: "reviewer",
        voice: "precise",
        soul: "# OrphanProvider\n## Persona\nA reviewer.",
        tagline: "Provider without model.",
        provider: "anthropic",
      },
      orphan.ctx,
    );
    expect(orphan.errored()).toBe(false);
    const orphanProvider = (await readMinds(mindsDir())).find((m) => m.slug === "orphanprovider");
    expect(orphanProvider?.model).toBeUndefined();
    expect(orphanProvider?.provider).toBeUndefined();
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

  it("refreshes the chamber-roster and nudges the chamber-digest gate after a successful scaffold", async () => {
    // Wire a recording refreshWorkflow through registerTools, then drive the genesis
    // tool it returns: a successful write must re-run the bound roster collector and
    // nudge the digest gate (refreshStandingPanels) so the surface reflects the new
    // Mind promptly, not only on the 120s cadence.
    const refreshed: string[] = [];
    const refreshTools = registerTools(
      makeCtx(undefined, sm, async (name) => {
        refreshed.push(name);
      }),
    );
    const genesis = refreshTools.find((x) => x.name === "chamber_emit_genesis");
    if (!genesis) throw new Error("genesis tool not found");
    const t = makeToolCtx();
    await genesis.execute(
      {
        name: "Refresher",
        role: "writer",
        voice: "plain",
        soul: "# Refresher\n## Persona\nA writer.",
        tagline: "Triggers a refresh.",
      },
      t.ctx,
    );
    expect(t.errored()).toBe(false);
    expect(refreshed).toEqual(["chamber-roster", "chamber-digest"]);
  });

  it("does not refresh when the scaffold fails (slug collision)", async () => {
    // The refresh is gated on a successful write: a collision throws before it, so
    // the seam is never called for a no-op.
    const refreshed: string[] = [];
    const refreshTools = registerTools(
      makeCtx(undefined, sm, async (name) => {
        refreshed.push(name);
      }),
    );
    const genesis = refreshTools.find((x) => x.name === "chamber_emit_genesis");
    if (!genesis) throw new Error("genesis tool not found");
    const t = makeToolCtx();
    await genesis.execute(
      { name: "Alice", role: "skeptic", voice: "terse", soul: "# Alice", tagline: "dupe" },
      t.ctx,
    );
    expect(t.errored()).toBe(true);
    expect(refreshed).toEqual([]);
  });
});

describe("chamber_emit_digest (standing-digest write seam)", () => {
  it("is advertised as state-changing", () => {
    expect(tool("chamber_emit_digest").state_changing).toBe(true);
  });

  it("persists the board and stamps it with the current chamber fingerprint", async () => {
    const t = makeToolCtx();
    await tool("chamber_emit_digest").execute(
      { board: { view: "board", title: "Digest", sections: [] } },
      t.ctx,
    );
    expect(t.errored()).toBe(false);
    const rec = await readDigest();
    expect(rec?.board.title).toBe("Digest");
    // The suite seeded Minds, so the chamber is non-empty and the fingerprint non-trivial.
    expect(rec?.fingerprint).toBeTruthy();
  });

  it("fails closed on a non-board payload, leaving the prior board untouched", async () => {
    const good = makeToolCtx();
    await tool("chamber_emit_digest").execute(
      { board: { view: "board", title: "Keep", sections: [] } },
      good.ctx,
    );
    const t = makeToolCtx();
    await tool("chamber_emit_digest").execute({ board: { view: "board" } }, t.ctx);
    expect(t.errored()).toBe(true);
    expect((await readDigest())?.board.title).toBe("Keep");
  });
});

describe("chamber room concurrency cap", () => {
  beforeAll(async () => {
    // Fresh driver + abort so this block's rooms don't inherit prior state; the abort
    // fake holds each room's first turn in flight, keeping them active so the cap is hit.
    await rib.dispose?.();
    abort = abortableRunAgentTurn();
    tools = registerTools(makeCtx(abort.run, sm));
  });

  it("opens rooms up to the cap, then refuses the next", async () => {
    for (let i = 0; i < MAX_ACTIVE_ROOMS; i++) {
      const t = makeToolCtx();
      await tool("chamber_room_start").execute(
        { participants: ["alice", "bob"], turnBudget: 2, confirm: true },
        t.ctx,
      );
      expect(t.errored()).toBe(false);
      expect(t.out()).toContain("Opened room");
    }
    const over = makeToolCtx();
    await tool("chamber_room_start").execute(
      { participants: ["alice", "bob"], turnBudget: 2, confirm: true },
      over.ctx,
    );
    expect(over.errored()).toBe(true);
    expect(over.out()).toContain("concurrent cap");
  });
});

describe("chamber room cap is atomic under concurrent starts", () => {
  beforeAll(async () => {
    await rib.dispose?.();
    abort = abortableRunAgentTurn();
    tools = registerTools(makeCtx(abort.run, sm));
  });

  it("a concurrent burst of starts opens at most the cap", async () => {
    // Fire more starts than the cap at once. startRoom reserves its slot in the same
    // synchronous tick it checks the cap (no await between), so exactly MAX open —
    // the add-after-await ordering this guards against would let them all overshoot.
    const ctxs = Array.from({ length: MAX_ACTIVE_ROOMS + 3 }, () => makeToolCtx());
    await Promise.all(
      ctxs.map((t) =>
        tool("chamber_room_start").execute(
          { participants: ["alice", "bob"], turnBudget: 2, confirm: true },
          t.ctx,
        ),
      ),
    );
    const opened = ctxs.filter((t) => t.out().includes("Opened room")).length;
    expect(opened).toBe(MAX_ACTIVE_ROOMS);
  });
});

// Exercises validateStart's coding-review capability guard through the real tool
// dry-run (the pure helper is unit-tested in capabilities.test.ts; this proves the
// wiring fires). Reaching the guard needs a resolvable project, so the ctx wires a
// getProjects seam, and the participants must be cross-vendor to clear the prior
// gate. smith/wesson are equipped (code / read); scribe/critic carry no tools.
describe("chamber_room_start — coding review capability guard", () => {
  const PROJECTS: Project[] = [
    {
      id: "repo",
      name: "Repo",
      rootPath: join(tmpdir(), "chamber-guard-repo"),
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ];

  beforeAll(async () => {
    await scaffoldMind(
      mindsDir(),
      {
        slug: "smith",
        name: "Smith",
        role: "author",
        voice: "plain",
        persona: "You write code.",
        provider: "claude",
        tools: ["code"],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      "Smith's soul.",
    );
    await scaffoldMind(
      mindsDir(),
      {
        slug: "wesson",
        name: "Wesson",
        role: "reviewer",
        voice: "sharp",
        persona: "You review code.",
        provider: "codex",
        tools: ["read"],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      "Wesson's soul.",
    );
    await rib.dispose?.();
    abort = abortableRunAgentTurn();
    tools = registerTools(makeCtx(abort.run, sm, undefined, () => PROJECTS));
  });

  it("dry-runs an equipped cross-vendor coding pair (author codes, reviewer reads)", async () => {
    const t = makeToolCtx();
    await tool("chamber_room_start").execute(
      { participants: ["smith", "wesson"], strategy: "review", coding: true, projectId: "repo" },
      t.ctx,
    );
    expect(t.errored()).toBe(false);
    expect(t.out()).toContain("review: smith reviewed by wesson");
    expect(t.out()).toContain("coding tier ON");
  });

  it("resolves projectId by name, not just id — the Convene board's convention", async () => {
    // An agent driving the tool has the project name, not its UUID, and there is no
    // chamber project-list tool to look one up, so a valid name must not be rejected.
    const t = makeToolCtx();
    await tool("chamber_room_start").execute(
      { participants: ["smith", "wesson"], strategy: "review", coding: true, projectId: "Repo" },
      t.ctx,
    );
    expect(t.errored()).toBe(false);
    expect(t.out()).toContain('in project "Repo"');
  });

  it("errors with a where-to-find-an-id hint for an unknown project", async () => {
    const t = makeToolCtx();
    await tool("chamber_room_start").execute(
      { participants: ["smith", "wesson"], strategy: "review", projectId: "ghost" },
      t.ctx,
    );
    expect(t.errored()).toBe(true);
    expect(t.out()).toContain('unknown project "ghost"');
    expect(t.out()).toContain("keelson project list");
  });

  it("rejects a coding review whose author can't `code`", async () => {
    const t = makeToolCtx();
    await tool("chamber_room_start").execute(
      { participants: ["scribe", "wesson"], strategy: "review", coding: true, projectId: "repo" },
      t.ctx,
    );
    expect(t.errored()).toBe(true);
    expect(t.out()).toContain("scribe");
    expect(t.out()).toContain("`code`");
  });

  it("rejects a coding review whose reviewer can neither read nor code", async () => {
    const t = makeToolCtx();
    await tool("chamber_room_start").execute(
      { participants: ["smith", "critic"], strategy: "review", coding: true, projectId: "repo" },
      t.ctx,
    );
    expect(t.errored()).toBe(true);
    expect(t.out()).toContain("critic");
    expect(t.out()).toContain("`read`");
  });

  it("leaves a non-coding review of the same unequipped pair valid (guard is coding-only)", async () => {
    const t = makeToolCtx();
    await tool("chamber_room_start").execute(
      { participants: ["scribe", "critic"], strategy: "review" },
      t.ctx,
    );
    expect(t.errored()).toBe(false);
    expect(t.out()).toContain("review: scribe reviewed by critic");
  });
});

describe("chamber_room_start refreshes the sessions index", () => {
  const refreshed: string[] = [];
  beforeAll(async () => {
    // Fresh driver + a held first turn so the started room stays active (no end-of-room
    // refresh fires during the assertion), plus a recording refreshWorkflow capturing
    // which collectors the start path re-runs.
    await rib.dispose?.();
    refreshed.length = 0;
    abort = abortableRunAgentTurn();
    tools = registerTools(
      makeCtx(abort.run, sm, async (name) => {
        refreshed.push(name);
      }),
    );
  });

  it("re-runs the chamber-rooms collector on a successful start", async () => {
    // The room's own panel registers on start, but the sessions index is a separate
    // bound snapshot — startRoom must re-run its collector so a new active session
    // shows promptly, not only on the next cadence (mirrors the end-of-room refresh).
    const t = makeToolCtx();
    await tool("chamber_room_start").execute(
      { participants: ["alice", "bob"], turnBudget: 4, confirm: true },
      t.ctx,
    );
    expect(t.errored()).toBe(false);
    expect(refreshed).toContain("chamber-rooms");
  });
});
