// A coarse "<n> <unit>" relative span from an ISO timestamp to now — enough for a
// card field or feed-row trailing ("updated … ago", "started … ago"). Floors to
// the largest whole unit; an unparseable or future timestamp degrades to "just
// now" rather than a negative/NaN span. Callers append " ago" where they want it.
export function relativeAgo(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  const deltaMs = Number.isFinite(then) ? now - then : 0;
  if (deltaMs < 60_000) return "just now";
  const units: [number, string][] = [
    [86_400_000, "day"],
    [3_600_000, "hour"],
    [60_000, "minute"],
  ];
  for (const [ms, unit] of units) {
    const n = Math.floor(deltaMs / ms);
    if (n >= 1) return `${n} ${unit}${n === 1 ? "" : "s"}`;
  }
  return "just now";
}
