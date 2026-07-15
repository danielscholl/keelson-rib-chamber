import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import rib from "../src/index.ts";
import {
  discoverLensWorkflows,
  lensWorkflowName,
  MAX_REFRESH_WORKFLOW_NAME,
} from "../src/lens-workflows.ts";
import { lensWorkflowsDir, setChamberDataHome } from "../src/paths.ts";
import { isChamberWorkflow } from "../src/workflows.ts";

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

  // The bundled workflows opt out of the mutation lock because chamber knows they
  // only touch its own data home. An operator's file is arbitrary bash, so chamber
  // has no such invariant to claim for it: an omission stays an omission and the
  // host's own (locking) default applies.
  test("leaves an omitted mutates_checkout to the host's default", async () => {
    await writeFile(join(root, "facts.yaml"), WF);
    const def = discoverLensWorkflows(root).contributions[0]!.definition as Record<string, unknown>;
    expect("mutates_checkout" in def).toBe(false);
  });

  test("an operator who opts out of the lock keeps that", async () => {
    await writeFile(join(root, "facts.yaml"), `${WF}mutates_checkout: false\n`);
    const def = discoverLensWorkflows(root).contributions[0]!.definition as Record<string, unknown>;
    expect(def.mutates_checkout).toBe(false);
  });

  test("an operator who means to mutate a checkout keeps it", async () => {
    await writeFile(join(root, "facts.yaml"), `${WF}mutates_checkout: true\n`);
    const def = discoverLensWorkflows(root).contributions[0]!.definition as Record<string, unknown>;
    expect(def.mutates_checkout).toBe(true);
  });

  // Neither true nor false: defaulting it to false could strip a lock the operator
  // wanted, so the file is refused by name instead. The harness would reject the
  // definition anyway, but only with a warning that never names the file.
  test("refuses a mutates_checkout that is neither true nor false", async () => {
    await writeFile(join(root, "bad.yaml"), `${WF}mutates_checkout: "false"\n`);
    await writeFile(join(root, "good.yaml"), WF);
    const { names } = discoverLensWorkflows(root);
    expect(names).toEqual(new Set(["chamber-lens-good"]));
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

  // The catalog keeps one definition per name, so a collision drops the operator's
  // file with no signal — their lens would then run chamber's bundled re-author
  // instead of the derivation they wrote.
  test("refuses a filename that would collide with a bundled workflow", async () => {
    await writeFile(join(root, "refresh.yaml"), WF);
    await writeFile(join(root, "html.yaml"), WF);
    await writeFile(join(root, "good.yaml"), WF);
    const reserved = new Set(["chamber-lens-refresh", "chamber-lens-html"]);
    const { names } = discoverLensWorkflows(root, reserved);
    expect(names).toEqual(new Set(["chamber-lens-good"]));
  });

  // chamber_emit_lens caps refresh.workflow at MAX_REFRESH_WORKFLOW_NAME, so a longer
  // name is one no lens could ever attach to.
  test("refuses a stem too long for any lens to name", async () => {
    const tooLong = "a".repeat(MAX_REFRESH_WORKFLOW_NAME - "chamber-lens-".length + 1);
    await writeFile(join(root, `${tooLong}.yaml`), WF);
    await writeFile(join(root, "good.yaml"), WF);
    const { names } = discoverLensWorkflows(root);
    expect(names).toEqual(new Set(["chamber-lens-good"]));
    // The longest name that still fits is kept.
    const longest = "a".repeat(MAX_REFRESH_WORKFLOW_NAME - "chamber-lens-".length);
    await writeFile(join(root, `${longest}.yaml`), WF);
    expect(discoverLensWorkflows(root).names.has(`chamber-lens-${longest}`)).toBe(true);
  });

  // A file the host would drop must not be vouched for: suppressing the emit caveat
  // for a definition the catalog never accepted recreates the silent 409.
  test("refuses a definition the host would drop, so it is never vouched for", async () => {
    await writeFile(join(root, "nonodes.yaml"), "description: d\nnodes: []\n");
    await writeFile(join(root, "nodesc.yaml"), "nodes:\n  - id: n\n    bash: echo\n");
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

  // isChamberWorkflow drives the emit reply's caveat, so it must answer the host's
  // question — "does this name carry rib provenance?" — which EVERY contribution
  // satisfies, not just the lens-shaped ones. Vouching for too few cries wolf over a
  // backing that would have run fine.
  test("vouches for every workflow chamber contributes, not just the lens ones", () => {
    expect(isChamberWorkflow("chamber-lens-release-status")).toBe(true);
    expect(isChamberWorkflow("chamber-lens-refresh")).toBe(true);
    expect(isChamberWorkflow("chamber-lens-html")).toBe(true);
    expect(isChamberWorkflow("chamber-roster")).toBe(true);
    expect(isChamberWorkflow("chamber-digest")).toBe(true);
    expect(isChamberWorkflow("some-other-workflow")).toBe(false);
  });

  test("an empty dir leaves the bundled contributions alone", async () => {
    await rm(lensWorkflowsDir(), { recursive: true, force: true });
    const names = contributedNames();
    expect(names).toContain("chamber-lens-refresh");
    expect(names.filter((n) => n.startsWith("chamber-lens-release"))).toEqual([]);
    expect(isChamberWorkflow("chamber-lens-release-status")).toBe(false);
  });
});
