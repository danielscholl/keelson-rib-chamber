import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RibContext } from "@keelson/shared";
import rib from "../src/index.ts";

// The probe only checks seam presence + data-home writability, so trivial stubs
// suffice. Omitting a key models a harness that didn't wire that seam.
function ctxWith(omit?: "snapshot" | "agentTurn" | "region"): RibContext {
  const ctx: Record<string, unknown> = {
    getExec: () => ({ runJSON: async () => ({}), runText: async () => ({}) }),
  };
  if (omit !== "snapshot") ctx.getSnapshotManager = () => ({});
  if (omit !== "agentTurn") ctx.runAgentTurn = () => ({});
  if (omit !== "region") ctx.registerRegion = () => () => {};
  return ctx as unknown as RibContext;
}

let workspace: string;
let prev: string | undefined;

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "chamber-auth-"));
  prev = process.env.KEELSON_WORKSPACE;
  process.env.KEELSON_WORKSPACE = workspace;
});

afterAll(async () => {
  if (prev === undefined) delete process.env.KEELSON_WORKSPACE;
  else process.env.KEELSON_WORKSPACE = prev;
  await rm(workspace, { recursive: true, force: true });
});

describe("authStatus", () => {
  it("reports ready when the data home is writable and all seams are wired", async () => {
    const status = await rib.authStatus?.(ctxWith());
    expect(status?.authenticated).toBe(true);
    expect(status?.statusMessage).toContain("rooms & lenses wired");
  });

  it("fails closed when the snapshot manager is absent", async () => {
    const status = await rib.authStatus?.(ctxWith("snapshot"));
    expect(status?.authenticated).toBe(false);
    expect(status?.statusMessage).toContain("snapshot manager");
  });

  it("fails closed when the agent-turn seam is absent", async () => {
    const status = await rib.authStatus?.(ctxWith("agentTurn"));
    expect(status?.authenticated).toBe(false);
    expect(status?.statusMessage).toContain("agent-turn");
  });

  it("fails closed when region registration is absent", async () => {
    const status = await rib.authStatus?.(ctxWith("region"));
    expect(status?.authenticated).toBe(false);
    expect(status?.statusMessage).toContain("region registration");
  });
});
