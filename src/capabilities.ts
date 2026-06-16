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
};

export const KNOWN_CAPABILITY_SLUGS: ReadonlySet<string> = new Set(Object.keys(CAPABILITIES));

// "slug (what it does)" list for the genesis prompt, derived from CAPABILITIES
// so the advertised vocabulary can't drift from what actually resolves.
export function capabilityVocabulary(): string {
  return Object.entries(CAPABILITIES)
    .map(([slug, c]) => `${slug} (${c.summary})`)
    .join(", ");
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
