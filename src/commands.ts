import type { CommandCompletion, CommandInvokeResult, RibCommandDescriptor } from "@keelson/shared";
import { listAgents } from "./agents.ts";

// The rib's slash commands for the harness command registry (GET /api/commands).
// /mind opens a Mind as a seeded chat; /genesis authors a new Mind from a brief.
// All chamber vocabulary lives here — the harness knows only "a rib offered a
// command" and performs the closed effect the invoke returns.
export const CHAMBER_COMMANDS: readonly RibCommandDescriptor[] = [
  {
    name: "mind",
    description: "Open a Mind as a seeded chat",
    argument: { hint: "<slug>", completes: true },
  },
  {
    name: "genesis",
    description: "Author a new Mind from a freeform brief",
    argument: { hint: "<brief>" },
  },
  {
    name: "lens",
    description: "Author a lens — a canvas board on a subject",
    argument: { hint: "<subject>" },
  },
];

// Slug type-ahead for /mind — the Minds on the roster, filtered by prefix.
export async function completeChamberCommand(
  name: string,
  prefix: string,
): Promise<readonly CommandCompletion[]> {
  if (name !== "mind") return [];
  return (await listAgents())
    .filter((a) => a.slug.startsWith(prefix))
    .map((a) => ({ value: a.slug, description: a.description }));
}

// The message effect's text is capped by the shared commandEffectSchema (8000);
// keep the inline list under it so a large roster can't 500 the invoke route.
const MESSAGE_TEXT_BUDGET = 7000;
function boundedLines(header: string, rows: readonly string[]): string {
  const out = [header];
  let used = header.length;
  let shown = 0;
  for (const row of rows) {
    if (used + 1 + row.length > MESSAGE_TEXT_BUDGET) break;
    out.push(row);
    used += 1 + row.length;
    shown += 1;
  }
  if (shown < rows.length) out.push(`  …and ${rows.length - shown} more (type a slug to filter)`);
  return out.join("\n");
}

// Run a chamber command server-side and return the closed effect the surface
// performs. /mind resolves to an open-agent effect (the surface resolves the seed
// through the agents seam), or an inline list when called with no slug; /genesis
// to a run-workflow effect (chamber-genesis, brief as $ARGUMENTS).
export async function invokeChamberCommand(
  name: string,
  arg: string,
): Promise<CommandInvokeResult> {
  const value = arg.trim();
  if (name === "mind") {
    const agents = await listAgents();
    if (agents.length === 0) {
      return {
        ok: true,
        effect: {
          effect: "message",
          text: "No Minds yet — author one with /genesis <brief>.",
        },
      };
    }
    if (value.length === 0) {
      const rows = agents.map((a) =>
        a.description ? `  ${a.slug} — ${a.description}` : `  ${a.slug}`,
      );
      return {
        ok: true,
        effect: { effect: "message", text: boundedLines("Minds:", rows) },
      };
    }
    if (!agents.some((a) => a.slug === value)) {
      return { ok: false, error: `No Mind "${value}".` };
    }
    return { ok: true, effect: { effect: "open-agent", ribId: "chamber", slug: value } };
  }
  if (name === "genesis") {
    if (value.length === 0) {
      return { ok: false, error: "usage: /genesis <brief> — describe the agent to author" };
    }
    return {
      ok: true,
      effect: { effect: "run-workflow", workflow: "chamber-genesis", args: value },
    };
  }
  if (name === "lens") {
    if (value.length === 0) {
      return { ok: false, error: "usage: /lens <subject> — describe the lens to author" };
    }
    return {
      ok: true,
      effect: { effect: "run-workflow", workflow: "chamber-lens", args: value },
    };
  }
  return { ok: false, error: `unknown command: ${name}` };
}
