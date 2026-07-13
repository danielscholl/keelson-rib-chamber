import { describe, expect, test } from "bun:test";
import rib from "../src/index.ts";

// contributeWorkflows takes a ctx the digest workflow definition never reads, so an
// empty cast satisfies the type (mirrors genesis-workflow.test.ts). The cost-safety
// invariant — no paid turn on a quiet tick — is proven by composition here: the gate
// collector's dirty logic is unit-tested (collect-digest.test.ts), and keelson's
// executor skips a `when:`-false node (its own tested contract). These assertions pin
// the wiring that joins the two.
function contributions() {
  const ctx = {} as Parameters<NonNullable<typeof rib.contributeWorkflows>>[0];
  return rib.contributeWorkflows?.(ctx) ?? [];
}

function digest() {
  return contributions().find((c) => (c.definition as { name?: string }).name === "chamber-digest");
}

function nodes(): Array<Record<string, unknown>> {
  return (digest()?.definition as { nodes?: Array<Record<string, unknown>> })?.nodes ?? [];
}

function node(id: string): Record<string, unknown> | undefined {
  return nodes().find((n) => n.id === id);
}

describe("chamber-digest workflow", () => {
  test("is contributed and bound to the digest key with a fail-closed board validate", () => {
    const d = digest();
    expect(d).toBeDefined();
    expect(d?.bindSnapshotKey).toBe("rib:chamber:digest");
    // The publish node's board reaches a trusted renderer, so the binding validates it.
    expect(typeof d?.validate).toBe("function");
  });

  test("is a gate -> author -> publish chain", () => {
    expect(nodes().map((n) => n.id)).toEqual(["gate", "author", "publish"]);
  });

  test("the gate is a cheap bash read with NO output_schema (so it never republishes)", () => {
    const gate = node("gate");
    expect(typeof gate?.bash).toBe("string");
    // No output_schema -> kind text -> the gate's { dirty, summary } never drives the
    // key; it only feeds the author's when: and prompt.
    expect(gate?.output_schema).toBeUndefined();
    expect(gate?.when).toBeUndefined();
  });

  test("the author spends a turn ONLY when the gate reports dirty", () => {
    const author = node("author");
    expect(author?.depends_on).toEqual(["gate"]);
    // The cost guard: a quiet/failed gate (dirty != 'true', or absent) skips this node.
    expect(author?.when).toBe("$gate.output.dirty == 'true'");
    expect(typeof author?.prompt).toBe("string");
    expect(author?.bash).toBeUndefined();
    // Rib tools are default-off in prompt nodes; opt in to the one write seam by name.
    expect(author?.allowed_tools).toEqual(["chamber_emit_digest"]);
    // Fail loud if the persist errors rather than report SUCCEEDED with nothing written.
    expect(author?.fail_on_tool_error).toBe(true);
  });

  test("the author prompt reads the gate's summary and calls the write seam", () => {
    const prompt = node("author")?.prompt as string;
    expect(prompt).toContain("$gate.output.summary");
    expect(prompt).toContain("chamber_emit_digest");
    // A standing synthesis, explicitly NOT the delta Briefing footer.
    expect(prompt).toContain("DIGEST");
  });

  test("the publish node always runs (all_done) and emits a board to the bound key", () => {
    const publish = node("publish");
    expect(publish?.depends_on).toEqual(["author"]);
    // all_done, not the default all_success: publish runs whether author ran (dirty),
    // was skipped (quiet), or failed — so the key refreshes every tick and self-heals.
    expect(publish?.trigger_rule).toBe("all_done");
    expect(typeof publish?.bash).toBe("string");
    expect(publish?.output_schema).toEqual({ type: "object", required: ["view", "sections"] });
  });
});
