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
    // An agent turn, not a deterministic collector (no bash) and not a structured
    // snapshot producer (no output_format) — it persists via the tool call.
    expect(node?.bash).toBeUndefined();
    expect(node?.output_format).toBeUndefined();
  });

  test("the genesis prompt drives the brief through the emit tool", () => {
    const node = ((genesis()?.definition as { nodes?: Array<Record<string, unknown>> }).nodes ??
      [])[0];
    const prompt = node?.prompt as string;
    expect(prompt).toContain("$ARGUMENTS");
    expect(prompt).toContain("chamber_emit_genesis");
  });
});
