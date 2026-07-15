import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { errText, type RibWorkflowContribution } from "@keelson/shared";
import { isSafeSlug } from "./genesis.ts";

// The prefix every discovered workflow's contributed name carries. Not decoration:
// the harness DROPS a rib workflow shadowed by a global workflow file of the same
// name and keeps the file's non-rib provenance — which is precisely the state that
// makes a lens's cadence refresh 409. Namespacing puts the contributed name
// somewhere a stray global file won't land on.
const LENS_WORKFLOW_PREFIX = "chamber-lens-";

export function lensWorkflowName(slug: string): string {
  return `${LENS_WORKFLOW_PREFIX}${slug}`;
}

// Read the operator's lens workflows off disk and hand them to the harness as rib
// contributions, which is the whole point: the host auto-refreshes only a workflow
// carrying rib provenance, so a lens's `refresh.workflow` can name one of these (or
// another rib's) and nothing else. Synchronous because Rib.contributeWorkflows is —
// this runs once at activation over a small dir.
//
// The FILENAME is authoritative, overriding whatever `name:` the YAML carries — the
// same rule the lens store applies to its own record dirs. Fail-soft per file: one
// malformed workflow must not cost the operator the rest.
export function discoverLensWorkflows(root: string): {
  contributions: RibWorkflowContribution[];
  names: ReadonlySet<string>;
} {
  const contributions: RibWorkflowContribution[] = [];
  const names = new Set<string>();
  let files: string[];
  try {
    files = readdirSync(root);
  } catch {
    return { contributions, names };
  }
  for (const file of files.sort()) {
    const slug = file.replace(/\.ya?ml$/, "");
    if (slug === file) continue;
    if (!isSafeSlug(slug)) {
      console.error(`[rib-chamber] lens workflow '${file}' skipped: name is not a kebab token`);
      continue;
    }
    try {
      const parsed: unknown = Bun.YAML.parse(readFileSync(join(root, file), "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("not a YAML mapping");
      }
      const name = lensWorkflowName(slug);
      // Same default the bundled contributions declare outright: a lens producer
      // re-derives and re-emits, so it must not take a project's mutation lock and
      // serialize against real work. An operator who means the opposite says so.
      const mutates = (parsed as { mutates_checkout?: unknown }).mutates_checkout ?? false;
      // No bindSnapshotKey: these republish through chamber_emit_lens rather than to
      // a bound key, the unbound case the host's /refresh region leg covers.
      contributions.push({ definition: { ...parsed, name, mutates_checkout: mutates } });
      names.add(name);
    } catch (e) {
      console.error(`[rib-chamber] lens workflow '${file}' skipped: ${errText(e)}`);
    }
  }
  return { contributions, names };
}
