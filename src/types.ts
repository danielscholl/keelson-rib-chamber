// The Chamber room domain model (docs/design/A2A-communication.md "Data shapes").
// Rib-internal types — only canvas boards cross the wire, so these stay plain TS
// (no Zod). None exist in @keelson/shared; they are defined here.

export type MindSlug = string;

// The two non-Mind authorities that may author a transcript entry. The driver is
// the sole authority for `from`; an agent never self-asserts identity.
export type ReservedAuthority = "director" | "system";

export interface Mind {
  slug: MindSlug;
  name: string;
  persona: string;
  model?: string;
  fallbackModels?: readonly string[];
  // Capability slugs this Mind may invoke — NOT C1 tool descriptors. Omitting
  // tools yields a text-only turn (the room default).
  tools?: readonly string[];
}

export interface TurnEntry {
  messageId: string;
  roomSlug: MindSlug;
  turnIndex: number;
  round?: number;
  from: MindSlug | ReservedAuthority;
  role: "agent" | "director" | "system";
  parts: { text: string }[];
  aborted?: boolean;
  at: string;
}

export type RoomStrategyName = "sequential" | "concurrent" | "group-chat" | "open-floor";

export interface RoomConfig {
  moderator?: MindSlug;
  minRounds?: number;
  endVoteThreshold?: number;
  synthesizer?: MindSlug;
}

// One-shot director overrides, consumed and cleared before the next turn.
export interface RoomPending {
  nextSpeaker?: MindSlug;
  directionInjection?: string;
}

export interface Room {
  slug: MindSlug;
  name: string;
  strategy: RoomStrategyName;
  participants: readonly MindSlug[];
  status: "active" | "stopped" | "done";
  turnBudget: number;
  turnIndex: number;
  // Round cursor — the authoritative count for round-based strategies. Stored
  // (not derived from turnIndex % participants) so a director override or a
  // moderator's pick can perturb the rotation without losing the round. Defaulted
  // to 0 at the load boundary so a room.json persisted before it existed loads.
  round: number;
  // The opening prompt that frames the discussion, seeded into every turn's
  // prompt. Optional: a room without one still runs (the prompt builder supplies
  // a non-empty fallback), it just has no shared subject.
  topic?: string;
  config?: RoomConfig;
  pending?: RoomPending;
  createdAt: string;
}

export type StrategyStep =
  | { kind: "speak"; mind: MindSlug }
  | { kind: "speak-parallel"; minds: readonly MindSlug[] }
  | { kind: "moderate"; mind: MindSlug }
  | { kind: "synthesize"; mind: MindSlug }
  | { kind: "end" };

// What a strategy decides over. Richer than the room alone: group-chat's
// all-heard gate and open-floor's "did the last speaker nominate?" both read the
// transcript, and round-based strategies need the round cursor. A strategy stays
// pure — it never spawns or parses free text; the driver runs turns, parses any
// routing tail, and validates a pick against room.participants.
export interface StrategyInput {
  room: Room;
  transcript: readonly TurnEntry[];
  // Mirrors room.round (the authoritative cursor), surfaced so a strategy reads
  // it without reaching into room.
  round: number;
}

export type Strategy = (input: StrategyInput) => StrategyStep;
