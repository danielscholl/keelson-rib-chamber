import { describe, expect, test } from "bun:test";
import rib from "../src/index.ts";

// contributeWorkflows takes a ctx the genesis workflow never reads, so an empty
// cast satisfies the type (mirrors brief.test.ts).
function contributions() {
  const ctx = {} as Parameters<NonNullable<typeof rib.contributeWorkflows>>[0];
  return rib.contributeWorkflows?.(ctx) ?? [];
}

function genesis() {
  return contributions().find(
    (c) => (c.definition as { name?: string }).name === "chamber-genesis",
  );
}

describe("chamber-genesis workflow", () => {
  test("is contributed and persists to disk (no snapshot binding)", () => {
    const g = genesis();
    expect(g).toBeDefined();
    // Genesis persists a Mind to disk via its tool; it publishes no canvas
    // snapshot, so unlike chamber-brief it binds no key and runs no validate.
    expect(g?.bindSnapshotKey).toBeUndefined();
    expect(g?.validate).toBeUndefined();
  });

  test("is a single prompt node scoped to the chamber_emit_genesis tool", () => {
    const nodes = (genesis()?.definition as { nodes?: Array<Record<string, unknown>> }).nodes ?? [];
    expect(nodes).toHaveLength(1);
    const node = nodes[0];
    expect(typeof node?.prompt).toBe("string");
    expect((node?.prompt as string).length).toBeGreaterThan(0);
    // Rib tools are default-off in workflow prompt nodes; the node opts in to the
    // single write seam by name (and nothing else).
    expect(node?.allowed_tools).toEqual(["chamber_emit_genesis"]);
    // An agent turn, not a deterministic collector (no bash).
    expect(node?.bash).toBeUndefined();
  });

  test("fails closed on a tool error so a collision can't report SUCCEEDED (#18)", () => {
    const node = ((genesis()?.definition as { nodes?: Array<Record<string, unknown>> }).nodes ??
      [])[0];
    // The Mind is written inside chamber_emit_genesis, which fails closed on a
    // slug collision; fail_on_tool_error makes the keelson executor fail the run
    // on that tool error rather than reporting SUCCEEDED with no Mind written.
    expect(node?.fail_on_tool_error).toBe(true);
  });

  test("the genesis prompt drives the brief through the emit tool", () => {
    const node = ((genesis()?.definition as { nodes?: Array<Record<string, unknown>> }).nodes ??
      [])[0];
    const prompt = node?.prompt as string;
    expect(prompt).toContain("$ARGUMENTS");
    expect(prompt).toContain("chamber_emit_genesis");
  });
});
