// Per-Mind tool resolution: map a speaker's declared capability slugs onto the
// turn's tool rail. Slugs are a friendly, curated vocabulary — NOT raw tool
// names. The room-safe pool (RoomDriverDeps.turnTools) is the allowlist ceiling:
// the result is intersected with it, so a Mind can never reach a tool the room
// doesn't already permit (e.g. room-control or another rib's tools) even via a
// hand-edited mind.json — the core turn seam does not scope a turn to its rib.

import { LENS_TOOL_NAME } from "./lens.ts";
import type { Mind } from "./types.ts";

// Capability slug -> the rib tool name(s) it authorizes, plus a one-line gloss
// for the genesis authoring prompt. The single source of truth for the room
// vocabulary; extend here as more room-safe tools are added.
export const CAPABILITIES: Readonly<
  Record<string, { readonly tools: readonly string[]; readonly summary: string }>
> = {
  lens: { tools: [LENS_TOOL_NAME], summary: "author a live canvas board mid-room" },
  read: { tools: ["Read"], summary: "read files in the room's project (coding rooms only)" },
  code: {
    tools: ["Bash", "Edit", "Write"],
    summary: "edit files and run commands in the room's project (coding rooms only)",
  },
  osdu: {
    tools: [
      "osdu_quality",
      "osdu_security",
      "osdu_features",
      "osdu_release",
      "osdu_events",
      "osdu_waiting",
      "osdu_cluster",
      "osdu_topology",
    ],
    summary: "consult read-only OSDU platform status — requires the osdu rib co-installed",
  },
};

export const KNOWN_CAPABILITY_SLUGS: ReadonlySet<string> = new Set(Object.keys(CAPABILITIES));

// The slugs whose tools are filesystem/exec built-ins (Read/Bash/Edit/Write) — the
// host provider's own tools, not chamber-registered ones. They resolve to nothing
// in a normal room and only enter the pool when a room opts into the coding tier
// (`room.coding`), where every turn is confined to its cwd. Held as data so
// `codingToolPool` and the genesis gloss can't drift from the map above.
export const CODING_CAPABILITY_SLUGS: ReadonlySet<string> = new Set(["read", "code"]);

// The pool a coding room layers on top of the base (lens) pool: every tool a coding
// slug authorizes, deduped, in the driver's `turnTools` shape. Derived from
// CAPABILITIES so the coding ceiling stays the same set the slugs resolve to.
export function codingToolPool(): { name: string }[] {
  const names = new Set<string>();
  for (const slug of CODING_CAPABILITY_SLUGS) {
    for (const name of CAPABILITIES[slug]?.tools ?? []) names.add(name);
  }
  return [...names].map((name) => ({ name }));
}

export const EXTERNAL_CAPABILITY_SLUGS: ReadonlySet<string> = new Set(["osdu"]);

// Other ribs register these names; co-install the owning rib or the turn seam
// rejects them, and do not treat them as host-confined coding built-ins.
export function externalToolPool(): { name: string }[] {
  const names = new Set<string>();
  for (const slug of EXTERNAL_CAPABILITY_SLUGS) {
    for (const name of CAPABILITIES[slug]?.tools ?? []) names.add(name);
  }
  return [...names].map((name) => ({ name }));
}

// "slug (what it does)" list for the genesis prompt, derived from CAPABILITIES
// so the advertised vocabulary can't drift from what actually resolves.
export function capabilityVocabulary(): string {
  return Object.entries(CAPABILITIES)
    .map(([slug, c]) => `${slug} (${c.summary})`)
    .join(", ");
}

// Fail-closed guard for the coding review preset. A code→review room only works
// when the author can edit and the reviewer can inspect: an author with no `code`
// has nothing to review, a reviewer with no `read`/`code` can't see the change —
// either way the room silently degenerates to a prose pass. Require the author to
// declare `code` and the reviewer `read` or `code`; return a helpful message, or
// null when the pair is equipped. Pure — validateStart calls it once the
// cross-vendor provider pins check out.
export function codingReviewCapabilityError(
  author: Pick<Mind, "slug" | "tools">,
  reviewer: Pick<Mind, "slug" | "tools">,
): string | null {
  const declares = (m: Pick<Mind, "tools">, slug: string): boolean =>
    Boolean(m.tools?.includes(slug));
  if (!declares(author, "code")) {
    return `a coding review room needs the author (${author.slug}) to declare the \`code\` capability so it can edit files — add \`code\` to its tools`;
  }
  if (!declares(reviewer, "read") && !declares(reviewer, "code")) {
    return `a coding review room needs the reviewer (${reviewer.slug}) to declare \`read\` or \`code\` so it can inspect the author's change — add \`read\` to its tools`;
  }
  return null;
}

// Resolve a Mind's declared slugs to the turn's `tools` rail, intersected with
// the room-safe pool. No declaration (or no pool) yields text-only — the room
// default — never "all tools". Unknown slugs resolve to nothing.
export function resolveMindTools(
  mind: Pick<Mind, "tools">,
  pool: readonly { name: string }[] | undefined,
): { name: string }[] {
  if (!mind.tools?.length || !pool?.length) return [];
  const poolNames = new Set(pool.map((t) => t.name));
  const names = new Set<string>();
  for (const slug of mind.tools) {
    for (const name of CAPABILITIES[slug]?.tools ?? []) {
      if (poolNames.has(name)) names.add(name);
    }
  }
  return [...names].map((name) => ({ name }));
}
