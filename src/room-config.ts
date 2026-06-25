import { asNonEmptyString } from "@keelson/shared";
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
