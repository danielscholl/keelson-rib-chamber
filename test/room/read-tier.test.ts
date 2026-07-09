import { describe, expect, test } from "bun:test";
import { codingToolPool, readToolPool } from "../../src/capabilities.ts";
import { EXHIBIT_TOOL_NAME } from "../../src/lens.ts";
import { createRoomDriver } from "../../src/room.ts";
import type { Mind } from "../../src/types.ts";
import {
  fixedClock,
  makeFakePublisher,
  makeFakeStore,
  scriptedRunAgentTurn,
  seqIds,
} from "../helpers/fakes.ts";

// A Mind that declares nothing (the common case — mycroft/moneypenny declare only
// `lens`), a lens-declaring Mind, and a full coder.
const TALKER: Mind = { slug: "talker", name: "Talker", role: "agent", persona: "You talk." };
const LENSER: Mind = {
  slug: "lenser",
  name: "Lenser",
  role: "agent",
  persona: "You draw.",
  tools: ["lens"],
};
const CODER: Mind = {
  slug: "coder",
  name: "Coder",
  role: "agent",
  persona: "You code.",
  tools: ["read", "code"],
};

function harness(opts: {
  minds: readonly Mind[];
  turnCwd?: string;
  resolveProjectRoot?: (id: string) => string | undefined;
  resolveProjectName?: (id: string) => string | undefined;
  withReadTools?: boolean;
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
    turnTools: [{ name: EXHIBIT_TOOL_NAME }],
    ...(opts.withReadTools === false ? {} : { readTools: readToolPool() }),
    ...(opts.withCodingTools ? { codingTools: codingToolPool() } : {}),
    ...(opts.turnCwd ? { turnCwd: opts.turnCwd } : {}),
    ...(opts.resolveProjectRoot ? { resolveProjectRoot: opts.resolveProjectRoot } : {}),
    ...(opts.resolveProjectName ? { resolveProjectName: opts.resolveProjectName } : {}),
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
  participants: ["talker", "lenser"],
  turnBudget: 1,
};

const names = (req: { tools?: readonly { name: string }[] } | undefined): string[] =>
  (req?.tools ?? []).map((t) => t.name).sort();

describe("room driver — read tier", () => {
  test("a project-targeted Discussion grants Read to a Mind that declares nothing, confined to the project root", async () => {
    const h = harness({
      minds: [TALKER, LENSER],
      turnCwd: "/neutral",
      resolveProjectRoot: () => "/repo",
    });
    await h.driver.start({ ...START, projectId: "proj" });
    expect(await h.driver.step("demo")).toBe("ended");

    const req = h.turns.requests[0];
    expect(req?.cwd).toBe("/repo");
    expect(req?.allowedDirectories).toEqual(["/repo"]);
    // Read is granted room-wide — no coding tier, no per-Mind `read` declaration.
    expect(names(req)).toEqual(["Read"]);
  });

  test("the read grant layers on a Mind's declared tools without dropping them", async () => {
    const h = harness({
      minds: [LENSER, TALKER],
      turnCwd: "/neutral",
      resolveProjectRoot: () => "/repo",
    });
    await h.driver.start({ ...START, participants: ["lenser", "talker"], projectId: "proj" });
    expect(await h.driver.step("demo")).toBe("ended");

    const req = h.turns.requests[0];
    expect(names(req)).toEqual([EXHIBIT_TOOL_NAME, "Read"].sort());
  });

  test("a room with no project grants nothing and stays unconfined, even with readTools available", async () => {
    const h = harness({ minds: [TALKER, LENSER], turnCwd: "/neutral" });
    await h.driver.start({ ...START });
    expect(await h.driver.step("demo")).toBe("ended");

    const req = h.turns.requests[0];
    expect(req?.cwd).toBe("/neutral");
    expect(req?.allowedDirectories).toBeUndefined();
    expect(req?.tools).toBeUndefined();
  });

  test("the read tier is unavailable when the host omits readTools (back-compat: cwd set, no tools, unconfined)", async () => {
    const h = harness({
      minds: [TALKER, LENSER],
      turnCwd: "/neutral",
      resolveProjectRoot: () => "/repo",
      withReadTools: false,
    });
    await h.driver.start({ ...START, projectId: "proj" });
    expect(await h.driver.step("demo")).toBe("ended");

    const req = h.turns.requests[0];
    // Project cwd is still path-as-context, but with no read pool there's no grant
    // and no confinement — exactly the pre-read-tier behavior.
    expect(req?.cwd).toBe("/repo");
    expect(req?.allowedDirectories).toBeUndefined();
    expect(req?.tools).toBeUndefined();
  });

  test("a whitespace/unresolved project root is treated as no project (no read grant, neutral cwd)", async () => {
    const h = harness({
      minds: [TALKER, LENSER],
      turnCwd: "/neutral",
      resolveProjectRoot: () => "  ",
    });
    await h.driver.start({ ...START, projectId: "proj" });
    expect(await h.driver.step("demo")).toBe("ended");

    const req = h.turns.requests[0];
    expect(req?.cwd).toBe("/neutral");
    expect(req?.allowedDirectories).toBeUndefined();
    expect(req?.tools).toBeUndefined();
  });

  test("in a coding room the read grant does not double-add Read", async () => {
    const h = harness({
      minds: [CODER, TALKER],
      turnCwd: "/neutral",
      resolveProjectRoot: () => "/repo",
      withCodingTools: true,
    });
    await h.driver.start({
      ...START,
      participants: ["coder", "talker"],
      projectId: "proj",
      coding: true,
    });
    expect(await h.driver.step("demo")).toBe("ended");

    const req = h.turns.requests[0];
    expect(req?.allowedDirectories).toEqual(["/repo"]);
    expect(names(req)).toEqual(["Bash", "Edit", "Read", "Write"]);
  });

  test("the speaker prompt names the project and tells read-capable speakers to read it", async () => {
    const h = harness({
      minds: [TALKER, LENSER],
      turnCwd: "/neutral",
      resolveProjectRoot: () => "/repo",
      resolveProjectName: () => "keelson-sample",
    });
    await h.driver.start({ ...START, topic: "How could this be better?", projectId: "proj" });
    expect(await h.driver.step("demo")).toBe("ended");

    const prompt = h.turns.requests[0]?.prompt ?? "";
    expect(prompt).toContain("keelson-sample");
    expect(prompt).toContain("/repo");
    expect(prompt).toContain("Read tool");
  });

  test("without a read pool the prompt still names the project but omits the Read-tool nudge", async () => {
    const h = harness({
      minds: [TALKER, LENSER],
      turnCwd: "/neutral",
      resolveProjectRoot: () => "/repo",
      resolveProjectName: () => "keelson-sample",
      withReadTools: false,
    });
    await h.driver.start({ ...START, projectId: "proj" });
    expect(await h.driver.step("demo")).toBe("ended");

    const prompt = h.turns.requests[0]?.prompt ?? "";
    expect(prompt).toContain("keelson-sample");
    expect(prompt).not.toContain("Read tool");
  });
});
