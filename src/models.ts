// Curated model choices the roster's model dropdown offers. NOT a live catalog:
// the roster board is produced by an out-of-process collector (bin/collect-roster.ts)
// that can't reach the host provider registry, so this is a hand-maintained mirror
// of the claude provider's model catalog — extend it here as models ship. A model
// outside this set still round-trips: modelOptions() unions the Mind's current pin,
// and genesis / a hand-edited mind.json accept an arbitrary slug.
export interface ModelChoice {
  readonly value: string;
  readonly label: string;
}

export const MODEL_CHOICES: readonly ModelChoice[] = [
  { value: "claude-opus-4-7", label: "Claude Opus 4.7" },
  { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
];

// MODEL_CHOICES with `current` merged in when it's a non-empty slug the curated set
// doesn't already offer, so a genesis- or hand-pinned model stays selectable (and a
// select's defaultValue can match it) instead of silently clearing on next open.
// The current pin leads so an off-list model is visible; dedupe by value.
export function modelOptions(current?: string): ModelChoice[] {
  const base = MODEL_CHOICES.map((c) => ({ value: c.value, label: c.label }));
  const cur = current?.trim();
  if (!cur || base.some((c) => c.value === cur)) return base;
  return [{ value: cur, label: cur }, ...base];
}
