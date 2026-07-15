// The rib's static snapshot keys — one source of truth for the surface layout,
// the view declarations, the workflow bindings, and the gates.
export const BRIEF_KEY = "rib:chamber:brief";
export const ROSTER_KEY = "rib:chamber:roster";
export const PRESENCE_KEY = "rib:chamber:presence";
export const ROOMS_KEY = "rib:chamber:rooms";
export const LENSES_KEY = "rib:chamber:lenses";
export const DIGEST_KEY = "rib:chamber:digest";

// The snapshot-only key family the Rooms index `Open` focuses (see roomOpenAction).
// Per-slug so two clients opening two different closed rooms get independent boards
// in their drawers instead of colliding on one shared key (active rooms / lenses use
// the same per-id isolation).
export function roomViewKey(slug: string): string {
  return `rib:chamber:room-view:${slug}`;
}

export function roomSummaryKey(slug: string): string {
  return `rib:chamber:room-summary:${slug}`;
}
