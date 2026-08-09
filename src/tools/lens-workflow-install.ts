import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import type { RibContext, ToolDefinition, WorkflowDiscoveryNotice } from "@keelson/shared";
import { errText, z } from "@keelson/shared";
import { assertSafeSlug } from "../genesis.ts";
import { MAX_LENS_WORKFLOW_SLUG_LENGTH, parseLensWorkflow } from "../lens-workflows.ts";
import { lensWorkflowsDir } from "../paths.ts";
import { isReservedLensWorkflowName, lensWorkflowStatus } from "../workflows.ts";
import { emitResult } from "./util.ts";

const installSchema = z.object({
  source: z.string().min(1),
  slug: z.string().min(1).optional(),
});

let writeSequence = 0;

async function replaceFile(path: string, content: string): Promise<void> {
  await mkdir(lensWorkflowsDir(), { recursive: true });
  const temporary = `${path}.${process.pid}.${++writeSequence}.tmp`;
  try {
    await writeFile(temporary, content, "utf8");
    await rename(temporary, path);
  } catch (error) {
    try {
      await rm(temporary, { force: true });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `failed to replace ${path}`);
    }
    throw error;
  }
}

async function installedPathFor(slug: string): Promise<string> {
  const yml = join(lensWorkflowsDir(), `${slug}.yml`);
  const yaml = join(lensWorkflowsDir(), `${slug}.yaml`);
  const exists = async (path: string): Promise<boolean> => {
    try {
      await access(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  };
  const [hasYml, hasYaml] = await Promise.all([exists(yml), exists(yaml)]);
  if (hasYml && hasYaml) {
    throw new Error(`both '${slug}.yml' and '${slug}.yaml' are installed; remove the duplicate`);
  }
  return hasYaml ? yaml : yml;
}

function activationError(
  notices: readonly WorkflowDiscoveryNotice[],
  workflow: string,
): WorkflowDiscoveryNotice | undefined {
  return notices.find(
    (notice) =>
      notice.message.includes(`'${workflow}'`) ||
      (notice.level === "error" && notice.filename.includes("rib:chamber")),
  );
}

export function makeLensWorkflowInstallTool(
  reloadRibWorkflows: NonNullable<RibContext["reloadRibWorkflows"]>,
): ToolDefinition {
  return {
    name: "chamber_lens_workflow_install",
    description:
      "Install or update a trusted lens workflow from a local YAML file, then activate that exact definition in Keelson's workflow catalog as one operation. The source may be inside a project checkout; Chamber validates it and writes only to its private lens-workflows directory under a safe slug. Returns the SHA-256 definition version that is active. NOT for authoring a lens or installing arbitrary global workflows.",
    inputSchema: installSchema,
    state_changing: true,
    async execute(input, ctx) {
      const parsed = installSchema.safeParse(input);
      if (!parsed.success) {
        emitResult(ctx, `chamber_lens_workflow_install: ${parsed.error.message}`, true);
        return;
      }
      const source = resolve(ctx.cwd, parsed.data.source);
      const extension = extname(source).toLowerCase();
      if (extension !== ".yml" && extension !== ".yaml") {
        emitResult(ctx, "chamber_lens_workflow_install: source must be a .yml or .yaml file", true);
        return;
      }
      const slug = (parsed.data.slug ?? basename(source, extension)).trim();
      try {
        assertSafeSlug(slug);
        if (slug.length > MAX_LENS_WORKFLOW_SLUG_LENGTH) {
          throw new Error(`slug must be at most ${MAX_LENS_WORKFLOW_SLUG_LENGTH} characters`);
        }
        const content = await readFile(source, "utf8");
        const definition = parseLensWorkflow(content, slug);
        if (isReservedLensWorkflowName(definition.name)) {
          throw new Error(`'${definition.name}' is a bundled Chamber workflow`);
        }
        const installedPath = await installedPathFor(slug);
        let prior: string | undefined;
        try {
          prior = await readFile(installedPath, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }

        await replaceFile(installedPath, content);
        try {
          const activation = await reloadRibWorkflows();
          const rejected = activationError(activation.notices, definition.name);
          if (rejected) throw new Error(`${rejected.filename}: ${rejected.message}`);
          const status = lensWorkflowStatus(definition.name);
          if (status?.state !== "active" || status.activeVersion !== definition.hash) {
            throw new Error(`catalog did not activate '${definition.name}' at ${definition.hash}`);
          }
        } catch (activationFailure) {
          try {
            if (prior === undefined) {
              await rm(installedPath, { force: true });
            } else {
              await replaceFile(installedPath, prior);
            }
            await reloadRibWorkflows();
          } catch (rollbackFailure) {
            throw new AggregateError(
              [activationFailure, rollbackFailure],
              `activation failed and the prior definition could not be restored`,
            );
          }
          throw activationFailure;
        }

        emitResult(
          ctx,
          JSON.stringify({
            ok: true,
            slug,
            installedPath,
            workflow: definition.name,
            definitionVersion: definition.hash,
          }),
        );
      } catch (error) {
        emitResult(ctx, `chamber_lens_workflow_install failed: ${errText(error)}`, true);
      }
    },
  };
}
