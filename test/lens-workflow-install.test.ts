import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageChunk, RibContext, ToolContext } from "@keelson/shared";
import rib from "../src/index.ts";
import { lensWorkflowsDir, setChamberDataHome } from "../src/paths.ts";
import {
  makeLensWorkflowInstallTool,
  type ReloadRibWorkflows,
} from "../src/tools/lens-workflow-install.ts";
import { contributeChamberWorkflows, lensWorkflowStatus } from "../src/workflows.ts";

const ORIGINAL = `name: ignored
description: Produce release status
nodes:
  - id: compose
    prompt: Compose release status.
`;
const UPDATED = ORIGINAL.replace("Produce release status", "Produce current release status");

let root: string;
let sourceDir: string;

function activate() {
  contributeChamberWorkflows();
  return Promise.resolve({ count: 1, notices: [] });
}

function toolContext(cwd = root) {
  const chunks: MessageChunk[] = [];
  const ctx: ToolContext = {
    cwd,
    emit: (chunk) => chunks.push(chunk),
    abortSignal: new AbortController().signal,
  };
  return {
    ctx,
    output: () => chunks.map((chunk) => ("content" in chunk ? chunk.content : "")).join(""),
    errored: () => chunks.some((chunk) => "isError" in chunk && chunk.isError === true),
  };
}

describe("chamber_lens_workflow_install", () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "chamber-lens-workflow-install-"));
    sourceDir = join(root, "project");
    setChamberDataHome(join(root, "home"));
  });

  beforeEach(async () => {
    await rm(sourceDir, { recursive: true, force: true });
    await rm(lensWorkflowsDir(), { recursive: true, force: true });
    await mkdir(sourceDir, { recursive: true });
    contributeChamberWorkflows();
  });

  afterAll(async () => {
    setChamberDataHome(undefined);
    await rm(root, { recursive: true, force: true });
  });

  test("installs and activates a valid workflow in one operation", async () => {
    const source = join(sourceDir, "release-status.yaml");
    await writeFile(source, ORIGINAL);
    const t = toolContext(sourceDir);

    await makeLensWorkflowInstallTool(activate).execute({ source: "release-status.yaml" }, t.ctx);

    expect(t.errored()).toBe(false);
    const result = JSON.parse(t.output()) as {
      installedPath: string;
      workflow: string;
      definitionVersion: string;
    };
    expect(result.installedPath).toBe(join(lensWorkflowsDir(), "release-status.yml"));
    expect(result.workflow).toBe("chamber-lens-release-status");
    expect(await readFile(result.installedPath, "utf8")).toBe(ORIGINAL);
    expect(lensWorkflowStatus(result.workflow)).toMatchObject({
      state: "active",
      activeVersion: result.definitionVersion,
    });
  });

  test("updates an installed workflow and activates the new hash", async () => {
    const source = join(sourceDir, "release-status.yml");
    const tool = makeLensWorkflowInstallTool(activate);
    await writeFile(source, ORIGINAL);
    const first = toolContext();
    await tool.execute({ source }, first.ctx);
    const firstVersion = JSON.parse(first.output()).definitionVersion as string;

    await writeFile(source, UPDATED);
    const second = toolContext();
    await tool.execute({ source }, second.ctx);
    const secondVersion = JSON.parse(second.output()).definitionVersion as string;

    expect(second.errored()).toBe(false);
    expect(secondVersion).not.toBe(firstVersion);
    expect(lensWorkflowStatus("chamber-lens-release-status")?.activeVersion).toBe(secondVersion);
  });

  test("serializes concurrent installs of the same slug", async () => {
    const originalSource = join(sourceDir, "original.yml");
    const updatedSource = join(sourceDir, "updated.yml");
    await writeFile(originalSource, ORIGINAL);
    await writeFile(updatedSource, UPDATED);
    let releaseFirstReload: () => void = () => {};
    const firstReloadBlocked = new Promise<void>((resolve) => {
      releaseFirstReload = resolve;
    });
    let noteFirstReload: () => void = () => {};
    const firstReloadStarted = new Promise<void>((resolve) => {
      noteFirstReload = resolve;
    });
    let calls = 0;
    const reload: ReloadRibWorkflows = async () => {
      calls += 1;
      contributeChamberWorkflows();
      if (calls === 1) {
        noteFirstReload();
        await firstReloadBlocked;
      }
      return { count: 1, notices: [] };
    };
    const tool = makeLensWorkflowInstallTool(reload);
    const first = toolContext();
    const second = toolContext();

    const firstInstall = tool.execute(
      { source: originalSource, slug: "release-status" },
      first.ctx,
    );
    await firstReloadStarted;
    const secondInstall = tool.execute(
      { source: updatedSource, slug: "release-status" },
      second.ctx,
    );
    await Bun.sleep(10);
    expect(calls).toBe(1);
    releaseFirstReload();
    await Promise.all([firstInstall, secondInstall]);

    expect(first.errored()).toBe(false);
    expect(second.errored()).toBe(false);
    expect(calls).toBe(2);
    expect(await readFile(join(lensWorkflowsDir(), "release-status.yml"), "utf8")).toBe(UPDATED);
    expect(lensWorkflowStatus("chamber-lens-release-status")?.activeVersion).toBe(
      JSON.parse(second.output()).definitionVersion,
    );
  });

  test("rejects unsafe, invalid, and bundled workflow slugs", async () => {
    const valid = join(sourceDir, "valid.yml");
    const invalid = join(sourceDir, "invalid.yml");
    const undescribed = join(sourceDir, "undescribed.yml");
    await writeFile(valid, ORIGINAL);
    await writeFile(invalid, "description: Invalid\nnodes: []\n");
    await writeFile(undescribed, "nodes:\n  - id: compose\n    prompt: Compose.\n");
    const tool = makeLensWorkflowInstallTool(activate);

    const unsafe = toolContext();
    await tool.execute({ source: valid, slug: "../escape" }, unsafe.ctx);
    expect(unsafe.errored()).toBe(true);

    const malformed = toolContext();
    await tool.execute({ source: invalid }, malformed.ctx);
    expect(malformed.errored()).toBe(true);

    const missingDescription = toolContext();
    await tool.execute({ source: undescribed }, missingDescription.ctx);
    expect(missingDescription.errored()).toBe(true);

    const reserved = toolContext();
    await tool.execute({ source: valid, slug: "refresh" }, reserved.ctx);
    expect(reserved.errored()).toBe(true);
    expect(reserved.output()).toContain("bundled Chamber workflow");
  });

  test("restores the prior file and catalog when activation fails", async () => {
    await mkdir(lensWorkflowsDir(), { recursive: true });
    const installed = join(lensWorkflowsDir(), "release-status.yml");
    const source = join(sourceDir, "release-status.yml");
    await writeFile(installed, ORIGINAL);
    contributeChamberWorkflows();
    const originalVersion = lensWorkflowStatus("chamber-lens-release-status")?.activeVersion;
    await writeFile(source, UPDATED);
    let calls = 0;
    const reload: ReloadRibWorkflows = async () => {
      calls += 1;
      contributeChamberWorkflows();
      if (calls === 1) {
        return {
          count: 1,
          notices: [
            {
              level: "error",
              filename: "<rib:chamber>",
              message: "invalid workflow: rejected update",
            },
          ],
        };
      }
      return { count: 1, notices: [] };
    };
    const t = toolContext();

    await makeLensWorkflowInstallTool(reload).execute({ source }, t.ctx);

    expect(t.errored()).toBe(true);
    expect(await readFile(installed, "utf8")).toBe(ORIGINAL);
    expect(lensWorkflowStatus("chamber-lens-release-status")).toMatchObject({
      state: "active",
      activeVersion: originalVersion,
    });
    expect(calls).toBe(2);
  });

  test("is registered only when the host can activate definitions", async () => {
    const register = rib.registerTools;
    if (!register) throw new Error("rib is missing registerTools");
    const base: RibContext = {
      getExec: () => ({
        runJSON: async <T>() => ({ ok: true as const, data: undefined as T }),
        runText: async () => ({ ok: true as const, data: "" }),
      }),
      getDataDir: () => join(root, "home"),
    };

    expect(register(base).some((tool) => tool.name === "chamber_lens_workflow_install")).toBe(
      false,
    );
    const contextWithReload = { ...base, reloadRibWorkflows: activate };
    expect(
      register(contextWithReload).some((tool) => tool.name === "chamber_lens_workflow_install"),
    ).toBe(true);
    await rib.dispose?.();
  });
});
