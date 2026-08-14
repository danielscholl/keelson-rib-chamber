import type { CanvasPerson } from "@keelson/shared";
import { identityToneForSlot, type Mind } from "../types.ts";

// One participant slug -> a people entry: the Mind's display name wearing its
// identity tone while the slug still resolves against the roster; a retired or
// unknown slug stays as the slug with no tone (the muted dot).
export function personFor(slug: string, bySlug: ReadonlyMap<string, Mind>): CanvasPerson {
  const mind = bySlug.get(slug);
  if (!mind) return { name: slug };
  return { name: mind.name, tone: identityToneForSlot(mind.identitySlot) };
}
