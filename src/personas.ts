import { buildSeedFor } from "./compose.ts";
import { readMinds } from "./minds-store.ts";
import { mindsDir } from "./paths.ts";

// The rib's personas for the harness /mind command: each Mind, with its roster
// tagline as the description. Cheap — no soul composed here.
export async function listPersonas(): Promise<
  { slug: string; name: string; description: string }[]
> {
  // Clamp to the shared personaSummary caps (name 80, description 280): the host
  // DROPS a whole summary that fails validation, so an over-long persona would
  // silently vanish from /mind while still being enterable from the roster.
  return (await readMinds(mindsDir())).map((m) => ({
    slug: m.slug,
    name: m.name.slice(0, 80),
    description: m.persona.slice(0, 280),
  }));
}

// Resolve one Mind to a chat seed — the SAME seed the roster Enter action builds
// (buildSeedFor), so the two entry points can't drift. Null for an unknown slug.
export async function resolvePersona(
  slug: string,
): Promise<{ systemPrompt: string; name: string; openingPrompt: string } | null> {
  const mind = (await readMinds(mindsDir())).find((m) => m.slug === slug);
  if (!mind) return null;
  return buildSeedFor(mindsDir(), mind);
}
