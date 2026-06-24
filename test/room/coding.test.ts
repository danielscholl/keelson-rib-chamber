import { describe, expect, test } from "bun:test";
import { codingToolPool } from "../../src/capabilities.ts";
import { LENS_TOOL_NAME } from "../../src/lens.ts";
import { createRoomDriver } from "../../src/room.ts";
import type { Mind } from "../../src/types.ts";
import {
  fixedClock,
  makeFakePublisher,
  makeFakeStore,
  scriptedRunAgentTurn,
  seqIds,
} from "../helpers/fakes.ts";

// A Mind that declares the coding capabilities; another that declares nothing.
const CODER: Mind = {
  slug: "coder",
  name: "Coder",
  role: "agent",
  persona: "You write code.",
  tools: ["read", "code"],
};
const TALKER: Mind = { slug: "talker", name: "Talker", role: "agent", persona: "You talk." };

function harness(opts: {
  minds: readonly Mind[];
  turnCwd?: string;
  resolveProjectRoot?: (id: string) => string | undefined;
  withCodingTools?: boolean;
}) {
  const { store } = makeFakeStore();
  const pub = makeFakePublisher();
  const turns = scriptedRunAgentTurn([{ text: "ok" }]);
  const driver = createRoomDriver({
    store,
    publisher: pub.publisher,
    runAgentTurn: turns.run,
    minds: () => opts.minds,
    turnTools: [{ name: LENS_TOOL_NAME }],
    ...(opts.withCodingTools === false ? {} : { codingTools: codingToolPool() }),
    ...(opts.turnCwd ? { turnCwd: opts.turnCwd } : {}),
    ...(opts.resolveProjectRoot ? { resolveProjectRoot: opts.resolveProjectRoot } : {}),
    now: fixedClock(),
    newId: seqIds(),
  });
  return { driver, turns };
}

// participants[0] speaks first (sequential), turnBudget 1 → exactly one turn.
const START = {
  slug: "demo",
  name: "Demo",
  strategy: "sequential" as const,
  participants: ["coder", "talker"],
  turnBudget: 1,
};

describe("room driver — coding tier", () => {
  test("a coding room grants a code-declaring Mind the coding rail, confined to the project root", async () => {
    const h = harness({
      minds: [CODER, TALKER],
      turnCwd: "/neutral",
      resolveProjectRoot: () => "/repo",
    });
    await h.driver.start({ ...START, projectId: "proj", coding: true });
    expect(await h.driver.step("demo")).toBe("ended");

    const req = h.turns.requests[0];
    // The turn runs at the project root...
    expect(req?.cwd).toBe("/repo");
    // ...and is confined to it (the host enforces the boundary off allowedDirectories).
    expect(req?.allowedDirectories).toEqual(["/repo"]);
    // The coding tools ride the same `tools` rail keelson's seam projects + gates
    // (the operator KEELSON_WORKFLOW_TOOL_DENYLIST / path_confinement policy apply
    // there — see keelson apps/server/src/rib-agent-turn.test.ts).
    expect((req?.tools ?? []).map((t) => t.name).sort()).toEqual(["Bash", "Edit", "Read", "Write"]);
  });

  test("a normal room (coding off) leaves a code-declaring Mind text-only and unconfined", async () => {
    const h = harness({ minds: [CODER, TALKER], turnCwd: "/neutral" });
    await h.driver.start({ ...START });
    expect(await h.driver.step("demo")).toBe("ended");

    const req = h.turns.requests[0];
    expect(req?.cwd).toBe("/neutral");
    expect(req?.allowedDirectories).toBeUndefined();
    // The base pool is lens-only, so the code slug resolves to nothing — opt-in.
    expect(req?.tools).toBeUndefined();
  });

  test("every turn in a coding room is confined, even a Mind that declares no tools", async () => {
    const h = harness({
      minds: [TALKER, CODER],
      turnCwd: "/neutral",
      resolveProjectRoot: () => "/repo",
    });
    // TALKER (declares nothing) speaks first.
    await h.driver.start({
      ...START,
      participants: ["talker", "coder"],
      projectId: "proj",
      coding: true,
    });
    expect(await h.driver.step("demo")).toBe("ended");

    const req = h.turns.requests[0];
    // Confined unconditionally so the boundary doesn't depend on per-Mind tools; a
    // no-op for a text-only turn, but it can't escape if it later gains a tool.
    expect(req?.allowedDirectories).toEqual(["/repo"]);
    expect(req?.tools).toBeUndefined();
  });

  test("a coding room whose project vanished confines to the neutral home, never unconfined", async () => {
    // projectId is set but the host no longer resolves it (deleted mid-room): the
    // turn falls back to the neutral home AND is confined to it — a coding turn is
    // never granted Bash/Edit/Write against an unbounded cwd.
    const h = harness({
      minds: [CODER, TALKER],
      turnCwd: "/neutral",
      resolveProjectRoot: () => undefined,
    });
    await h.driver.start({ ...START, projectId: "gone", coding: true });
    expect(await h.driver.step("demo")).toBe("ended");

    const req = h.turns.requests[0];
    expect(req?.cwd).toBe("/neutral");
    expect(req?.allowedDirectories).toEqual(["/neutral"]);
    expect((req?.tools ?? []).map((t) => t.name).sort()).toEqual(["Bash", "Edit", "Read", "Write"]);
  });

  test("an empty/whitespace project root falls back to the neutral home, not the tmpdir", async () => {
    // Project.rootPath is `z.string()` with no min length, so a host could resolve a
    // project to "" / whitespace. turnCwdFor trims and treats that as unresolved, so
    // the turn runs at — and is confined to — the neutral home, exactly like a
    // vanished project, rather than dropping cwd to the seam's process tmpdir.
    const h = harness({
      minds: [CODER, TALKER],
      turnCwd: "/neutral",
      resolveProjectRoot: () => "  ",
    });
    await h.driver.start({ ...START, projectId: "proj", coding: true });
    expect(await h.driver.step("demo")).toBe("ended");

    const req = h.turns.requests[0];
    expect(req?.cwd).toBe("/neutral");
    expect(req?.allowedDirectories).toEqual(["/neutral"]);
    expect((req?.tools ?? []).map((t) => t.name).sort()).toEqual(["Bash", "Edit", "Read", "Write"]);
  });

  test("a coding room with no cwd to confine to grants no coding tools (fails closed)", async () => {
    // No turnCwd and no resolvable project → no confinement root → the coding tier
    // is withheld rather than running Bash/Edit/Write unconfined.
    const h = harness({ minds: [CODER, TALKER] });
    await h.driver.start({ ...START, projectId: "proj", coding: true });
    expect(await h.driver.step("demo")).toBe("ended");

    const req = h.turns.requests[0];
    expect(req?.cwd).toBeUndefined();
    expect(req?.allowedDirectories).toBeUndefined();
    expect(req?.tools).toBeUndefined();
  });
});
