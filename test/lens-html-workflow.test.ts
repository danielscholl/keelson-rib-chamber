import { describe, expect, test } from "bun:test";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import rib from "../src/index.ts";

// contributeWorkflows takes a ctx the html-lens workflow definition never reads,
// so an empty cast satisfies the type (mirrors genesis-workflow.test.ts).
function contributions() {
  const ctx = {} as Parameters<NonNullable<typeof rib.contributeWorkflows>>[0];
  return rib.contributeWorkflows?.(ctx) ?? [];
}

function htmlLens() {
  return contributions().find(
    (c) => (c.definition as { name?: string }).name === "chamber-lens-html",
  );
}

function node(): Record<string, unknown> | undefined {
  const nodes = (htmlLens()?.definition as { nodes?: Array<Record<string, unknown>> })?.nodes ?? [];
  return nodes[0];
}

describe("chamber-lens-html workflow", () => {
  test("is contributed with no snapshot binding (the tool routes the per-subject key)", () => {
    const wf = htmlLens();
    expect(wf).toBeDefined();
    expect(wf?.bindSnapshotKey).toBeUndefined();
    expect(wf?.validate).toBeUndefined();
  });

  test("is a single prompt node scoped to chamber_emit_lens_html", () => {
    const nodes =
      (htmlLens()?.definition as { nodes?: Array<Record<string, unknown>> })?.nodes ?? [];
    expect(nodes).toHaveLength(1);
    const n = node();
    expect(typeof n?.prompt).toBe("string");
    expect(n?.bash).toBeUndefined();
    expect(n?.allowed_tools).toEqual(["chamber_emit_lens_html"]);
  });

  test("does NOT set fail_on_tool_error — a rejected palette is the in-turn retry signal", () => {
    expect(node()?.fail_on_tool_error).toBeUndefined();
  });

  test("the prompt embeds the shared design guidance and drives the subject through the emit tool", () => {
    const prompt = node()?.prompt as string;
    expect(prompt).toContain("$ARGUMENTS");
    expect(prompt).toContain("chamber_emit_lens_html");
    // The shared buildCanvasArtifactGuidance() block: the frame contract, the
    // ready-to-paste token CSS, and the palette-declaration rule ride along.
    expect(prompt).toContain("## Canvas artifacts");
    expect(prompt).toContain(':root[data-theme="light"]');
    expect(prompt).toContain("--s1");
    expect(prompt).toContain("data-palette-dark");
    // One self-contained token-themed page, emitted with the tool, retried on reject.
    expect(prompt).toContain("self-contained");
    expect(prompt).toMatch(/fix the markup or colors/);
  });

  test("every contributed chamber workflow validates against the real keelson loader", async () => {
    // Resolve the loader through the @keelson/shared symlink's realpath: its
    // sibling packages/workflows is the exact schema + invariant gate
    // prepareRibWorkflows runs on a rib contribution at server boot.
    const sharedDir = await realpath(
      fileURLToPath(new URL("../node_modules/@keelson/shared", import.meta.url)),
    );
    const loader = (await import(join(sharedDir, "..", "workflows", "src", "index.ts"))) as {
      workflowDefinitionSchema: {
        safeParse(value: unknown): {
          success: boolean;
          data?: unknown;
          error?: { message: string };
        };
      };
      validateWorkflowInvariants(workflow: never): string | null;
    };
    const all = contributions();
    expect(all.map((c) => (c.definition as { name?: string }).name)).toContain("chamber-lens-html");
    for (const contribution of all) {
      const name = (contribution.definition as { name?: string }).name ?? "<unnamed>";
      const parsed = loader.workflowDefinitionSchema.safeParse(contribution.definition);
      expect(`${name}: ${parsed.success ? "ok" : parsed.error?.message}`).toBe(`${name}: ok`);
      const invariantError = loader.validateWorkflowInvariants(parsed.data as never);
      expect(`${name}: ${invariantError ?? "ok"}`).toBe(`${name}: ok`);
    }
  });
});
