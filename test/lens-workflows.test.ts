import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import rib from "../src/index.ts";
import { discoverLensWorkflows, lensWorkflowName } from "../src/lens-workflows.ts";
import { lensWorkflowsDir, setChamberDataHome } from "../src/paths.ts";
import { isChamberLensWorkflow } from "../src/workflows.ts";

let root: string;

// contributeWorkflows takes a ctx these definitions never read, so an empty cast
// satisfies the type (mirrors genesis-workflow.test.ts).
function contributedNames(): string[] {
  const ctx = {} as Parameters<NonNullable<typeof rib.contributeWorkflows>>[0];
  return (rib.contributeWorkflows?.(ctx) ?? []).map((c) => (c.definition as { name: string }).name);
}

const WF = `name: whatever-the-file-says
description: Re-derive the facts and re-emit the lens
nodes:
  - id: compose
    prompt: Re-author the lens.
    allowed_tools: [chamber_emit_lens]
`;

function nameOf(c: { definition: unknown }): unknown {
  return (c.definition as { name?: unknown }).name;
}

describe("lens workflow discovery", () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "chamber-lens-wf-"));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });
  });

  test("contributes a workflow file under a chamber-namespaced name", async () => {
    await writeFile(join(root, "release-status.yaml"), WF);
    const { contributions, names } = discoverLensWorkflows(root);
    expect(contributions).toHaveLength(1);
    expect(names).toEqual(new Set(["chamber-lens-release-status"]));
    expect(lensWorkflowName("release-status")).toBe("chamber-lens-release-status");
  });

  // The filename is authoritative, like the lens store's record dirs. It also has to
  // be: a file keeping its own name could be shadowed by a global workflow of that
  // name, which the harness resolves to non-rib provenance — the exact state that
  // makes a panel's cadence refresh 409.
  test("the filename wins over the name the file declares", async () => {
    await writeFile(join(root, "release-status.yaml"), WF);
    const { contributions } = discoverLensWorkflows(root);
    expect(nameOf(contributions[0]!)).toBe("chamber-lens-release-status");
  });

  test("carries the rest of the definition through untouched", async () => {
    await writeFile(join(root, "facts.yml"), WF);
    const { contributions } = discoverLensWorkflows(root);
    const def = contributions[0]!.definition as Record<string, unknown>;
    expect(def.description).toBe("Re-derive the facts and re-emit the lens");
    expect(def.nodes).toHaveLength(1);
  });

  // These republish through chamber_emit_lens, not to a bound key — the unbound case
  // the host's /refresh region leg covers.
  test("binds no snapshot key", async () => {
    await writeFile(join(root, "facts.yaml"), WF);
    const { contributions } = discoverLensWorkflows(root);
    expect(contributions[0]!.bindSnapshotKey).toBeUndefined();
  });

  // The host locks on `mutates_checkout !== false`, so an operator who omitted it
  // would have their lens producer serialize against real work in the project the
  // run resolves to. Every other chamber contribution declares it outright.
  test("defaults mutates_checkout to false, like the bundled contributions", async () => {
    await writeFile(join(root, "facts.yaml"), WF);
    const def = discoverLensWorkflows(root).contributions[0]!.definition as Record<string, unknown>;
    expect(def.mutates_checkout).toBe(false);
  });

  test("an operator who means to mutate a checkout keeps it", async () => {
    await writeFile(join(root, "facts.yaml"), `${WF}mutates_checkout: true\n`);
    const def = discoverLensWorkflows(root).contributions[0]!.definition as Record<string, unknown>;
    expect(def.mutates_checkout).toBe(true);
  });

  test("ignores a non-workflow file", async () => {
    await writeFile(join(root, "notes.md"), "not a workflow");
    await writeFile(join(root, "facts.yaml"), WF);
    const { names } = discoverLensWorkflows(root);
    expect(names).toEqual(new Set(["chamber-lens-facts"]));
  });

  // Fail-soft per file: one bad workflow must not cost the operator the rest.
  test("skips an unparseable file and keeps the others", async () => {
    await writeFile(join(root, "broken.yaml"), "nodes: [oops\n  - unclosed");
    await writeFile(join(root, "good.yaml"), WF);
    const { names } = discoverLensWorkflows(root);
    expect(names).toEqual(new Set(["chamber-lens-good"]));
  });

  test("skips a file whose YAML is not a mapping", async () => {
    await writeFile(join(root, "list.yaml"), "- one\n- two\n");
    expect(discoverLensWorkflows(root).names.size).toBe(0);
  });

  // The contributed name is built from the slug, so a filename that isn't a bare
  // kebab token would make one the catalog can't carry.
  test("skips a filename that is not a kebab token", async () => {
    await writeFile(join(root, "Not A Slug.yaml"), WF);
    await writeFile(join(root, "good.yaml"), WF);
    const { names } = discoverLensWorkflows(root);
    expect(names).toEqual(new Set(["chamber-lens-good"]));
  });

  test("an absent dir contributes nothing rather than throwing", () => {
    const { contributions, names } = discoverLensWorkflows(join(root, "nope"));
    expect(contributions).toEqual([]);
    expect(names.size).toBe(0);
  });
});

// The point of the whole seam: a lens's refresh backing is reachable only if the
// name it holds reaches the catalog with RIB provenance, which only the rib's own
// contribution can give it.
describe("the rib contributes the operator's lens workflows", () => {
  let home: string;
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "chamber-lens-wf-rib-"));
    setChamberDataHome(home);
  });
  afterAll(async () => {
    setChamberDataHome(undefined);
    await rm(home, { recursive: true, force: true });
  });

  test("a workflow file reaches the catalog beside the bundled ones", async () => {
    await mkdir(lensWorkflowsDir(), { recursive: true });
    await writeFile(join(lensWorkflowsDir(), "release-status.yaml"), WF);
    const names = contributedNames();
    expect(names).toContain("chamber-lens-release-status");
    expect(names).toContain("chamber-lens-refresh");
    expect(names).toContain("chamber-roster");
  });

  // isChamberLensWorkflow drives the emit reply's caveat, so it must reflect what was
  // actually discovered — an author hearing nothing reads as a backing that works.
  test("a discovered workflow is one chamber vouches for; an arbitrary name is not", () => {
    expect(isChamberLensWorkflow("chamber-lens-release-status")).toBe(true);
    expect(isChamberLensWorkflow("chamber-lens-refresh")).toBe(true);
    expect(isChamberLensWorkflow("some-other-workflow")).toBe(false);
  });

  test("an empty dir leaves the bundled contributions alone", async () => {
    await rm(lensWorkflowsDir(), { recursive: true, force: true });
    const names = contributedNames();
    expect(names).toContain("chamber-lens-refresh");
    expect(names.filter((n) => n.startsWith("chamber-lens-release"))).toEqual([]);
    expect(isChamberLensWorkflow("chamber-lens-release-status")).toBe(false);
  });
});
