import { asNonEmptyString, type Brief } from "@keelson/shared";
import type { RoomConfig } from "./types.ts";

// The flat room-config contract, owned in ONE place so the chat tool, the board
// action, and the start path can never drift on key names or types. Coercion
// only — floors and range checks live in validateStart, the single gate.
export interface RoomConfigInput {
  moderator?: string;
  synthesizer?: string;
  manager?: string;
  minRounds?: number;
  maxSpeakerRepeats?: number;
  endVoteThreshold?: number;
}

// Raw payload (board `fields` merge in flat) -> typed config input.
export function roomConfigFromFlat(payload: Record<string, unknown>): RoomConfigInput {
  return {
    moderator: asNonEmptyString(payload.moderator) || undefined,
    synthesizer: asNonEmptyString(payload.synthesizer) || undefined,
    manager: asNonEmptyString(payload.manager) || undefined,
    minRounds: typeof payload.minRounds === "number" ? payload.minRounds : undefined,
    maxSpeakerRepeats:
      typeof payload.maxSpeakerRepeats === "number" ? payload.maxSpeakerRepeats : undefined,
    endVoteThreshold:
      typeof payload.endVoteThreshold === "number" ? payload.endVoteThreshold : undefined,
  };
}

// Stored config -> flat payload keys, so a board "Start again" / "Start <strategy>"
// action round-trips a room's routing config through start validation.
export function flatFromRoomConfig(
  config: RoomConfig | undefined,
): Record<string, string | number> {
  if (!config) return {};
  return {
    ...(config.moderator ? { moderator: config.moderator } : {}),
    ...(config.synthesizer ? { synthesizer: config.synthesizer } : {}),
    ...(config.manager ? { manager: config.manager } : {}),
    ...(typeof config.minRounds === "number" ? { minRounds: config.minRounds } : {}),
    ...(typeof config.maxSpeakerRepeats === "number"
      ? { maxSpeakerRepeats: config.maxSpeakerRepeats }
      : {}),
    ...(typeof config.endVoteThreshold === "number"
      ? { endVoteThreshold: config.endVoteThreshold }
      : {}),
  };
}

// The convene form's free-text criteria (one per line) split into a trimmed list.
export function parseCriteriaLines(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

// Cap on concurrently-active rooms. Each runs its own loop of paid agent turns, so an
// unbounded fan-out would burn cost without an operator noticing. A small soft cap
// keeps "multiple rooms" useful while bounding the spend; it also sits far under the
// harness per-surface region ceiling, so a start never fails for lack of a panel slot.
// Lives here, not in room-lifecycle, so the pure boards can read it without importing
// the fs-backed lifecycle (which would close a cycle back through runtime).
export const MAX_ACTIVE_ROOMS = 6;

// Bounds on a grounding brief. It is re-serialized into every turn, fidelity, and
// synthesis prompt, so an unbounded brief would multiply billed input and can exhaust
// context — cap the count and lengths at the normalization choke point (both entry
// points pass through here) rather than trust the caller.
export const MAX_GROUNDING_CRITERIA = 20;
export const MAX_CRITERION_LEN = 500;
export const MAX_GROUNDING_URL_LEN = 500;

// Normalize a room grounding brief from either entry point (the chamber_room_start
// tool's structured input or the convene form's parsed fields) into the shared Brief
// shape, or undefined when it carries neither a source nor any criterion — so a room
// convened without grounding is byte-for-byte unchanged.
export function normalizeGrounding(
  input: { sourceUrl?: string; criteria?: readonly string[] } | undefined,
): Brief | undefined {
  if (!input) return undefined;
  const sourceUrl = input.sourceUrl?.trim().slice(0, MAX_GROUNDING_URL_LEN) || undefined;
  // Collapse internal whitespace so each criterion is a single line: the convene form is
  // one-per-line and the restart payload rejoins with newlines, so an embedded newline
  // would otherwise split one criterion into two on the round trip.
  const criteria = (input.criteria ?? [])
    .map((c) => c.trim().replace(/\s+/g, " ").slice(0, MAX_CRITERION_LEN))
    .filter(Boolean)
    .slice(0, MAX_GROUNDING_CRITERIA);
  if (!sourceUrl && criteria.length === 0) return undefined;
  return { ...(sourceUrl ? { sourceUrl } : {}), criteria };
}
