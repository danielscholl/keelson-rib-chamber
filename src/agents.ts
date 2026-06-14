import { buildSeedFor } from "./compose.ts";
import { readMinds } from "./minds-store.ts";
import { mindsDir } from "./paths.ts";

// The rib's agents for the harness GET /api/agents (the /mind command's source):
// each Mind, with its roster tagline as the description. Cheap — no soul composed
// here.
export async function listAgents(): Promise<{ slug: string; name: string; description: string }[]> {
  // Clamp to the shared agentSummary caps (name 80, description 280): the host
  // DROPS a whole summary that fails validation, so an over-long agent would
  // silently vanish from /mind while still being enterable from the roster.
  return (await readMinds(mindsDir())).map((m) => ({
    slug: m.slug,
    name: m.name.slice(0, 80),
    description: m.persona.slice(0, 280),
  }));
}

// Resolve one Mind to a chat seed — the SAME seed the roster Enter action builds
// (buildSeedFor), so the two entry points can't drift. Carries the Mind's model
// when set so entering it runs on that model. Null for an unknown slug.
export async function resolveAgent(
  slug: string,
): Promise<{ systemPrompt: string; name: string; openingPrompt: string; model?: string } | null> {
  const mind = (await readMinds(mindsDir())).find((m) => m.slug === slug);
  if (!mind) return null;
  return buildSeedFor(mindsDir(), mind);
}
