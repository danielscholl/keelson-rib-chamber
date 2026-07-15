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

// A lens can only name a backing its emit schema accepts, so a name past that cap is
// one nothing can ever attach to. Exported so the schema's limit and this bound stay
// one value (the MIN_REFRESH_CADENCE_MS precedent).
export const MAX_REFRESH_WORKFLOW_NAME = 64;
const MAX_SLUG = MAX_REFRESH_WORKFLOW_NAME - LENS_WORKFLOW_PREFIX.length;

export function lensWorkflowName(slug: string): string {
  return `${LENS_WORKFLOW_PREFIX}${slug}`;
}

// Whether the file's shape is one the harness will actually keep. Chamber cannot run
// the host's full validator (no @keelson/workflows dependency — the reason
// RibWorkflowContribution.definition is `unknown`), so this is the cheap floor, not a
// mirror of it: it exists because a definition the catalog silently drops leaves the
// lens naming it with a backing that 409s, and a rejection here names the file where
// the host's warning would not.
function shapeError(def: Record<string, unknown>): string | undefined {
  if (typeof def.description !== "string" || def.description.length === 0) {
    return "needs a description";
  }
  if (!Array.isArray(def.nodes) || def.nodes.length === 0) return "needs a non-empty nodes list";
  // Neither true nor false is refused rather than guessed at: coercing a muddled
  // "true" to false would strip a mutation lock the operator asked for.
  if (def.mutates_checkout !== undefined && typeof def.mutates_checkout !== "boolean") {
    return "mutates_checkout must be true or false";
  }
  return undefined;
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
//
// `reserved` are the names the bundled contributions already hold. A collision is not
// a merge: the catalog keeps one definition per name, so the bundled one would win and
// the operator's file would vanish without a word — their lens then silently running
// chamber's re-author instead of the derivation they wrote.
export function discoverLensWorkflows(
  root: string,
  reserved: ReadonlySet<string> = new Set(),
): {
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
  const skip = (file: string, why: string): void => {
    console.error(`[rib-chamber] lens workflow '${file}' skipped: ${why}`);
  };
  for (const file of files.sort()) {
    const slug = file.replace(/\.ya?ml$/, "");
    if (slug === file) continue;
    if (!isSafeSlug(slug)) {
      skip(file, "name is not a kebab token");
      continue;
    }
    if (slug.length > MAX_SLUG) {
      skip(file, `name is over ${MAX_SLUG} characters, so no lens could name it`);
      continue;
    }
    const name = lensWorkflowName(slug);
    if (reserved.has(name)) {
      skip(file, `'${name}' is a bundled chamber workflow — rename the file`);
      continue;
    }
    try {
      const parsed: unknown = Bun.YAML.parse(readFileSync(join(root, file), "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("not a YAML mapping");
      }
      const bad = shapeError(parsed as Record<string, unknown>);
      if (bad) {
        skip(file, bad);
        continue;
      }
      // No bindSnapshotKey: these republish through chamber_emit_lens rather than to
      // a bound key, the unbound case the host's /refresh region leg covers. And no
      // mutates_checkout default: an omission means the host's own default applies.
      // The bundled workflows opt out because chamber knows they only touch its data
      // home; these are the operator's bash, and chamber has no such invariant to
      // claim on their behalf.
      contributions.push({ definition: { ...parsed, name } });
      names.add(name);
    } catch (e) {
      skip(file, errText(e));
    }
  }
  return { contributions, names };
}
