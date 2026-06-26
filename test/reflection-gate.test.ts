import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RibContext, SnapshotManager } from "@keelson/shared";
import type { RunAgentTurn } from "../src/agent-turn.ts";
import rib, { runReflectionForRoom } from "../src/index.ts";
import { readMindDoc, scaffoldMind, writeMemory } from "../src/minds-store.ts";
import { chamberDataHome, mindsDir, setChamberDataHome } from "../src/paths.ts";
import type { Room, TurnEntry } from "../src/types.ts";
import { scriptedRunAgentTurn } from "./helpers/fakes.ts";

// A minimal SnapshotManager double — the reflection gate writes files, not snapshots,
// but registerTools needs an sm (+ registerRegion + runAgentTurn) present to build the
// room driver and capture the agent-turn seam the gate runs on.
function fakeSm(): SnapshotManager {
  return {
    register: () => () => {},
    recompose: async () => undefined,
    latest: () => undefined,
    keys: () => [],
    dispose: async () => {},
  } as unknown as SnapshotManager;
}

function makeCtx(run?: RunAgentTurn): RibContext {
  return {
    getExec: () => ({
      runJSON: async <T>() => ({ ok: true as const, data: undefined as T }),
      runText: async () => ({ ok: true as const, data: "" }),
    }),
    getSnapshotManager: () => fakeSm(),
    registerRegion: () => () => {},
    ...(run ? { runAgentTurn: run } : {}),
  } as RibContext;
}

function makeRoom(over: Partial<Room> = {}): Room {
  return {
    slug: "room-1",
    name: "Design Review",
    strategy: "sequential",
    participants: ["ada", "bo"],
    status: "done",
    turnBudget: 4,
    turnIndex: 2,
    round: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function agentEntry(from: string, text: string, over: Partial<TurnEntry> = {}): TurnEntry {
  return {
    messageId: `m-${from}-${text.slice(0, 6)}`,
    roomSlug: "room-1",
    turnIndex: 0,
    from,
    role: "agent",
    parts: [{ text }],
    at: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

const reply = (memory: string, log = "noted") => JSON.stringify({ memory, log });

describe("reflection gate (close-only memory curation)", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "chamber-reflect-"));
    setChamberDataHome(home);
  });
  afterEach(async () => {
    await rib.dispose?.();
    setChamberDataHome(undefined);
    await rm(home, { recursive: true, force: true });
  });

  async function seedMinds(): Promise<void> {
    for (const slug of ["ada", "bo"]) {
      await scaffoldMind(
        mindsDir(),
        {
          slug,
          name: slug,
          role: "r",
          voice: "v",
          persona: `I am ${slug}.`,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        `soul ${slug}`,
      );
    }
  }

  test("a room nobody spoke in runs ZERO reflection turns (cost invariant)", async () => {
    await seedMinds();
    const { run, requests } = scriptedRunAgentTurn([{ text: reply("# m\n\n- x") }]);
    rib.registerTools?.(makeCtx(run));
    await runReflectionForRoom(makeRoom(), []); // empty transcript — no speaker
    expect(requests).toHaveLength(0);
  });

  test("only Minds that spoke a substantive, non-aborted turn reflect", async () => {
    await seedMinds();
    const { run, requests } = scriptedRunAgentTurn([{ text: reply("# m\n\n- ada learned") }]);
    rib.registerTools?.(makeCtx(run));
    // ada spoke; bo's only turn was aborted (no substance) — so only ada reflects.
    await runReflectionForRoom(makeRoom(), [
      agentEntry("ada", "Ada makes a substantive point."),
      agentEntry("bo", "", { aborted: true }),
    ]);
    expect(requests).toHaveLength(1);
    // The reflection turn withholds tools and runs at the neutral home (never a project).
    expect(requests[0]?.allowedTools).toEqual([]);
    expect(requests[0]?.cwd).toBe(chamberDataHome());
    // The prompt carries the room transcript and the curation doctrine.
    expect(requests[0]?.prompt).toContain("Ada makes a substantive point.");
    expect(requests[0]?.prompt).toContain("Curate your long-term memory");
  });

  test("a valid reply consolidates memory.md and appends a log line", async () => {
    await seedMinds();
    const { run } = scriptedRunAgentTurn([
      {
        text: reply(
          "# Working memory\n\n- The deploy gates on green CI.",
          "Reviewed deploy gating",
        ),
      },
    ]);
    rib.registerTools?.(makeCtx(run));
    await runReflectionForRoom(makeRoom({ participants: ["ada"] }), [
      agentEntry("ada", "We confirmed the deploy gates on green CI."),
    ]);
    const memory = await readMindDoc(mindsDir(), "ada", "memory.md");
    expect(memory).toContain("The deploy gates on green CI.");
    expect(memory).not.toContain("_(empty)_"); // the seed placeholder was replaced
    const log = await readMindDoc(mindsDir(), "ada", "log.md");
    expect(log).toContain("Reviewed deploy gating");
  });

  test("fail-closed: a non-JSON reply leaves memory.md unchanged, no throw", async () => {
    await seedMinds();
    const { run, requests } = scriptedRunAgentTurn([{ text: "I have nothing to add." }]);
    rib.registerTools?.(makeCtx(run));
    const before = await readMindDoc(mindsDir(), "ada", "memory.md");
    await expect(
      runReflectionForRoom(makeRoom({ participants: ["ada"] }), [agentEntry("ada", "A point.")]),
    ).resolves.toBeUndefined();
    expect(requests).toHaveLength(1); // the turn ran…
    expect(await readMindDoc(mindsDir(), "ada", "memory.md")).toBe(before); // …but wrote nothing
  });

  test("an empty memory reply is a no-op — the Mind's prior memory is not wiped", async () => {
    await seedMinds();
    await writeMemory(mindsDir(), "ada", "# Working memory\n\n- Hard-won fact.");
    // The model returns a blank memory (the failure mode the keep-prior guard catches).
    const { run } = scriptedRunAgentTurn([{ text: reply("   ", "no change") }]);
    rib.registerTools?.(makeCtx(run));
    await runReflectionForRoom(makeRoom({ participants: ["ada"] }), [
      agentEntry("ada", "A point."),
    ]);
    expect(await readMindDoc(mindsDir(), "ada", "memory.md")).toContain("Hard-won fact.");
  });

  test("seam absent (no runAgentTurn) runs no reflection and never throws", async () => {
    await seedMinds();
    rib.registerTools?.(makeCtx()); // no run
    await expect(
      runReflectionForRoom(makeRoom({ participants: ["ada"] }), [agentEntry("ada", "A point.")]),
    ).resolves.toBeUndefined();
    expect(await readMindDoc(mindsDir(), "ada", "memory.md")).toContain("_(empty)_");
  });

  test("a Mind that spoke but is no longer on the roster is skipped without throwing", async () => {
    await seedMinds();
    const { run, requests } = scriptedRunAgentTurn([{ text: reply("# m\n\n- x") }]);
    rib.registerTools?.(makeCtx(run));
    await runReflectionForRoom(makeRoom({ participants: ["ghost"] }), [agentEntry("ghost", "boo")]);
    expect(requests).toHaveLength(0);
  });
});
