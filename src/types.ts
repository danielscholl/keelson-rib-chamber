// The Chamber room domain model (docs/design/A2A-communication.md "Data shapes").
// Rib-internal types — only canvas boards cross the wire, so these stay plain TS
// (no Zod). None exist in @keelson/shared; they are defined here.

import type { CanvasTone, TokenUsage } from "@keelson/shared";

export type MindSlug = string;

export const IDENTITY_SLOT_COUNT = 5;

// The host's reserved identity tones (keelson#390), in slot order. A Mind keeps
// one hue for life (assigned at genesis, persisted on the record); anything
// without a valid slot folds to neutral + name — never a hash, never a status
// hue. Mirrors squad's IDENTITY_SLOT_TONES so the two ribs agree on the ramp.
export const IDENTITY_SLOT_TONES: readonly CanvasTone[] = [
  "id-blue",
  "id-amber",
  "id-teal",
  "id-rose",
  "id-olive",
];

export function identityToneForSlot(slot: number | undefined): CanvasTone {
  return typeof slot === "number" &&
    Number.isInteger(slot) &&
    slot >= 0 &&
    slot < IDENTITY_SLOT_COUNT
    ? IDENTITY_SLOT_TONES[slot]!
    : "neutral";
}

export function identitySlotForIndex(index: number): number {
  const slot = Math.trunc(index);
  if (!Number.isFinite(slot)) return 0;
  return Math.min(Math.max(0, slot), IDENTITY_SLOT_COUNT - 1);
}

// The two non-Mind authorities that may author a transcript entry. The driver is
// the sole authority for `from`; an agent never self-asserts identity.
export type ReservedAuthority = "director" | "system";

export interface Mind {
  slug: MindSlug;
  name: string;
  // The Mind's role, carried into the roster card's pill. `readMinds` supplies an
  // empty fallback for a drifted record so the board can render a placeholder.
  role: string;
  persona: string;
  model?: string;
  // The provider that serves `model`. Pin it alongside `model` so entering the
  // Mind sends a coherent provider/model pair (a model from one provider can't
  // run on another); omitted keeps the surface's current provider.
  provider?: string;
  fallbackModels?: readonly string[];
  // Capability slugs this Mind may invoke — NOT C1 tool descriptors. Omitting
  // tools yields a text-only turn (the room default).
  tools?: readonly string[];
  // The Mind's host identity-tone slot (keelson#390), assigned once at genesis
  // in author order and persisted — never reassigned, never hashed per render.
  // Absent on a Mind authored before this field existed; identityToneForSlot
  // folds that to neutral rather than inventing a slot retroactively.
  identitySlot?: number;
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
  // The turn's token usage, straight from RibAgentTurnResult.usage — absent when
  // the provider reported none (a text-only stream, an aborted/pre-stream
  // failure) or on a turn recorded before this field existed. Additive: the
  // board sums whatever entries carry it rather than requiring a complete set.
  usage?: TokenUsage;
}

export type RoomStrategyName =
  | "sequential"
  | "concurrent"
  | "group-chat"
  | "open-floor"
  | "review"
  | "magentic";

export interface RoomConfig {
  moderator?: MindSlug;
  minRounds?: number;
  endVoteThreshold?: number;
  synthesizer?: MindSlug;
  // Anti-monopoly cap: a moderator pick at/over this many prior turns is
  // redirected to the least-spoken participant, so routing can't fixate.
  maxSpeakerRepeats?: number;
  // The magentic manager: a non-participant Mind that plans the task ledger and
  // delegates to the participant workers. Parallel to `moderator` — it drives the
  // room but is never counted as a speaker. Required for the "magentic" strategy.
  manager?: MindSlug;
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
  // The keelson project this room targets, if any. Stored as the id, not the
  // resolved path, so the host projects store stays the single source of truth —
  // the driver resolves it to a turn cwd per turn (see turnCwdFor in room.ts).
  projectId?: string;
  // The opt-in coding tier (off by default). When set, a Mind that declares a
  // coding capability (`code`/`read`) can run Bash/Edit/Write/Read, and every turn
  // is confined to its cwd (allowedDirectories). Requires `projectId` — the project
  // root is the confinement boundary — so a coding turn never runs unconfined.
  coding?: boolean;
  pending?: RoomPending;
  createdAt: string;
}

// The magentic task ledger — the manager's plan the room drives to completion.
// Persisted as ledger.json beside room.json / transcript.jsonl; the driver is its
// sole writer (a manager turn (re)plans it, a worker turn settles its one task).
export type TaskStatus = "pending" | "in-progress" | "completed" | "failed";

export interface LedgerTask {
  id: string;
  description: string;
  // The worker assigned to execute it. Validated against room.participants when the
  // manager's plan is parsed; an unassigned/invalid task routes to the least-spoken
  // worker at assign time.
  assignee?: MindSlug;
  status: TaskStatus;
  // A short outcome note stamped when the task settles (completed/failed).
  result?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskLedger {
  roomSlug: MindSlug;
  // The goal the manager decomposes — the room topic.
  goal: string;
  // The managing Mind (room.config.manager), so the ledger is self-describing.
  manager: MindSlug;
  // planning: no tasks yet; executing: open tasks remain; done: the manager closed
  // the plan (goal met, or nothing left to do).
  status: "planning" | "executing" | "done";
  tasks: LedgerTask[];
  updatedAt: string;
}

export type StrategyStep =
  | { kind: "speak"; mind: MindSlug }
  | { kind: "speak-parallel"; minds: readonly MindSlug[] }
  | { kind: "moderate"; mind: MindSlug }
  | { kind: "synthesize"; mind: MindSlug }
  // magentic: the manager (re)plans the ledger; a worker executes one assigned task.
  | { kind: "manage"; mind: MindSlug }
  | { kind: "assign"; mind: MindSlug; taskId: string }
  | { kind: "end" };

// What a strategy decides over. Richer than the room alone because group-chat's
// all-heard gate and open-floor's "did the last speaker nominate?" both read the
// transcript, which the room does not carry. The round cursor lives on
// `room.round` (the authoritative count) — a strategy reads it there. A strategy
// stays pure: it never spawns or parses free text; the driver runs turns, parses
// any routing tail, and validates a pick against room.participants.
export interface StrategyInput {
  room: Room;
  transcript: readonly TurnEntry[];
  // The magentic task ledger, when the room runs that strategy — the state the
  // manager plans over and the workers execute against. Absent for every other
  // strategy (they decide over room + transcript alone).
  ledger?: TaskLedger;
}

export type Strategy = (input: StrategyInput) => StrategyStep;
