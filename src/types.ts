// The Chamber room domain model (docs/design/A2A-communication.md "Data shapes").
// Rib-internal types — only canvas boards cross the wire, so these stay plain TS
// (no Zod). None exist in @keelson/shared; they are defined here.

import type { Brief, CanvasTone, TokenUsage } from "@keelson/shared";

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

// The single slot-validity predicate — an in-range integer index into the ramp.
// Allocation (nextFreeSlot), tone rendering (identityToneForSlot), and the roster's
// free-slot scan (freeSlots, for launchpad starter toning) all read it, so a Mind's
// seated hue and its seat's availability can never disagree on what counts as a valid slot.
export function isValidSlot(slot: number | undefined): slot is number {
  return (
    typeof slot === "number" && Number.isInteger(slot) && slot >= 0 && slot < IDENTITY_SLOT_COUNT
  );
}

export function identityToneForSlot(slot: number | undefined): CanvasTone {
  return isValidSlot(slot) ? IDENTITY_SLOT_TONES[slot]! : "neutral";
}

// The lowest identity slot not already worn by a seated Mind, honoring `preferred`
// (a starter's own hue) when it is free. Allocation is next-FREE, never count-based:
// a count would double-seat a hue the moment the roster churns (retire a mid-roster
// Mind, author a new one, and the dropped count re-picks an occupied slot — the
// "fixed order, never cycled" break). A Mind with no valid slot (authored before the
// field, or the neutral overflow) occupies nothing, so it never blocks a hue. When
// all five are taken the result is IDENTITY_SLOT_COUNT, which identityToneForSlot
// folds to neutral — the sixth Mind wears its name, not an invented hue.
export function nextFreeSlot(
  minds: readonly { identitySlot?: number }[],
  preferred?: number,
): number {
  const taken = new Set<number>();
  for (const m of minds) {
    if (isValidSlot(m.identitySlot)) taken.add(m.identitySlot);
  }
  if (isValidSlot(preferred) && !taken.has(preferred)) return preferred;
  for (let slot = 0; slot < IDENTITY_SLOT_COUNT; slot++) {
    if (!taken.has(slot)) return slot;
  }
  return IDENTITY_SLOT_COUNT;
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
  // Short authored stanza for the seat card — verb-led behaviors, distinct from
  // the roster tagline (`persona`). Absent on Minds authored before the field
  // existed; the seat card falls back to `persona`.
  mission?: string;
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

// One tool a Mind invoked during a turn, harvested from the turn's `tool_use`
// stream chunks (the result object carries none). `name` is the display name
// with any `mcp__<server>__` prefix stripped; `primary` is a bounded arg preview
// (toolPresentation); `errored` is set only when a matching `tool_result` carried
// isError — absent means the host reported no failure (or emitted no result).
// The family and glyph are derived at render from `name`, not persisted.
export interface ToolCall {
  name: string;
  primary?: string;
  errored?: boolean;
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
  // The tools this turn invoked, in call order — absent on a text-only turn or an
  // entry recorded before this field existed. Additive, like `usage`.
  toolCalls?: readonly ToolCall[];
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
  // An optional brief (the shared Brief) distinct from the topic; its criteria drive a
  // cross-vendor fidelity check before a design-bearing room's closing synthesis.
  grounding?: Brief;
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
  outcomeAt?: string;
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
