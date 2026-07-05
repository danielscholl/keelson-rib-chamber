import type { TokenUsage } from "@keelson/shared";
import { stripControlJson } from "./routing.ts";
import type { MindSlug, TaskLedger, TurnEntry } from "./types.ts";

// Cap on history turns carried in a prompt (and the status-tool view): unbounded
// history grows prompt cost linearly per turn (worse under concurrent rounds, which
// fan one transcript into N prompts). Below MAX_ROOM_TURN_BUDGET (50) so it actually
// caps rooms that approach the budget, not just hypothetical larger ones.
export const TRANSCRIPT_WINDOW_TURNS = 40;

// Render a transcript as the prompt context fed to the next speaker — oldest to
// newest, one "from: text" block per turn, bounded to the last TRANSCRIPT_WINDOW_TURNS
// with a one-line elision marker when truncated. A trailing control directive (a
// moderator's routing JSON, a speaker's nomination tail) is stripped so it never
// leaks into the next speaker's context and gets mimicked; the on-disk entry is
// untouched (the driver re-parses the raw text for routing). Also backs the
// chamber_room_status tool's body. Pure.
export function renderTranscript(transcript: readonly TurnEntry[]): string {
  const omitted = Math.max(0, transcript.length - TRANSCRIPT_WINDOW_TURNS);
  const rendered = transcript
    .slice(-TRANSCRIPT_WINDOW_TURNS)
    .map((entry) => `${entry.from}: ${stripControlJson(entry.parts.map((p) => p.text).join("\n"))}`)
    .join("\n\n");
  if (omitted === 0) return rendered;
  const marker = `…(${omitted} earlier turn${omitted === 1 ? "" : "s"} omitted)`;
  return `${marker}\n\n${rendered}`;
}

// The shared head of every speaker/moderator/synthesis prompt: the room topic (if
// any), then the rendered (windowed) discussion so far, or `emptyContext` when there
// is no history yet — omit `emptyContext` (synthesis) to push nothing. Pure.
function promptPreamble(input: {
  topic?: string;
  transcript: readonly TurnEntry[];
  emptyContext?: string;
}): string[] {
  const parts: string[] = [];
  const topic = input.topic?.trim();
  if (topic) parts.push(`Room topic: ${topic}`);
  const context = renderTranscript(input.transcript);
  if (context.length > 0) parts.push(`Conversation so far:\n\n${context}`);
  else if (input.emptyContext) parts.push(input.emptyContext);
  return parts;
}

// The prompt fed to the next speaker: the room topic (if any), the conversation
// so far, an optional director steer, and a standing instruction to reply in
// character. Always non-empty — a first turn (empty transcript, no topic) still
// yields the instruction, so the agent is never invoked with an empty prompt (a
// CLI errors on that). Pure.
export function buildTurnPrompt(input: {
  topic?: string;
  transcript: readonly TurnEntry[];
  directionInjection?: string;
}): string {
  const parts = promptPreamble({
    topic: input.topic,
    transcript: input.transcript,
    emptyContext: "You are the first to speak — open the discussion.",
  });
  if (input.directionInjection) parts.push(`[director]: ${input.directionInjection}`);
  parts.push(
    "Respond with your next message in the conversation — in character, concise, no narration of others.",
  );
  return parts.join("\n\n");
}

// The moderator's prompt for a group-chat turn: the discussion so far plus an
// instruction to route or close by ending the reply with a single trailing JSON
// object. The control words are the SAME members of CONTROL_ACTIONS the parser
// reads and the stripper removes, so prompt, parser, and stripper never drift.
// Deliberation prose is encouraged and stays visible on the board; only the
// trailing JSON is stripped from the next speaker's context. Always non-empty.
export function buildModeratorPrompt(input: {
  topic?: string;
  transcript: readonly TurnEntry[];
  participants: readonly MindSlug[];
  directionInjection?: string;
}): string {
  const parts = promptPreamble({
    topic: input.topic,
    transcript: input.transcript,
    emptyContext: "The discussion has not started yet — open it by directing the first speaker.",
  });
  parts.push(`Participants you may direct: ${input.participants.join(", ")}.`);
  if (input.directionInjection) parts.push(`[director]: ${input.directionInjection}`);
  parts.push(
    "You are the moderator. Briefly weigh the discussion, then END your reply with ONE JSON object on its own line:\n" +
      '{"action":"direct","next_speaker":"<participant>","direction":"<what they should address>"} to hand off, ' +
      'or {"action":"close"} to end the room. Pick next_speaker from the participants above.',
  );
  return parts.join("\n\n");
}

// The prompt for an open-floor (unmoderated) speaker: the discussion so far plus
// the nominate/pass/end vocabulary, so each speaker hands off or votes to close by
// ending its reply with a single trailing JSON object. The control words are the
// SAME members of CONTROL_ACTIONS the parser reads and the stripper removes, so
// prompt, parser, and stripper never drift. Always non-empty.
export function buildOpenFloorPrompt(input: {
  topic?: string;
  transcript: readonly TurnEntry[];
  participants: readonly MindSlug[];
  directionInjection?: string;
}): string {
  const parts = promptPreamble({
    topic: input.topic,
    transcript: input.transcript,
    emptyContext: "You are the first to speak — open the discussion.",
  });
  parts.push(`Participants you may nominate: ${input.participants.join(", ")}.`);
  if (input.directionInjection) parts.push(`[director]: ${input.directionInjection}`);
  parts.push(
    "Speak in character, then END your reply with ONE JSON object on its own line:\n" +
      '{"action":"nominate","slug":"<participant>","reason":"<why>"} to hand off, ' +
      '{"action":"pass"} to defer, or {"action":"end"} to vote to close the room. ' +
      "Pick slug from the participants above (not yourself).",
  );
  return parts.join("\n\n");
}

// The closing synthesis prompt: the discussion so far plus an instruction to sum
// up. No routing JSON — synthesis is the room's last act. Always non-empty.
export function buildSynthesisPrompt(input: {
  topic?: string;
  transcript: readonly TurnEntry[];
}): string {
  const parts = promptPreamble({ topic: input.topic, transcript: input.transcript });
  parts.push(
    "Synthesize the discussion into a concise closing summary — areas of agreement, open disagreements, and the recommendation. Speak in your own voice. Do not emit any routing JSON.",
  );
  return parts.join("\n\n");
}

// The reviewer's prompt for a `review` turn: the contract (if any) and ONLY the
// author's artifact — deliberately NOT the windowed transcript, so the reviewer
// judges the deliverable on its own terms, cross-vendor, without the author's
// working context. Always non-empty.
//
// In a coding room (`coding`) the deliverable lives in the repo, not the author's
// reply, so the artifact is reframed as a SUMMARY and the reviewer is pointed at
// the files the author changed — read/run the real change, don't grade the prose.
export function buildReviewPrompt(input: {
  contract?: string;
  artifact: string;
  author?: MindSlug;
  directionInjection?: string;
  coding?: boolean;
}): string {
  const parts: string[] = [];
  const contract = input.contract?.trim();
  if (contract) parts.push(`Contract / acceptance criteria:\n\n${contract}`);
  const who = input.author ? ` from ${input.author}` : "";
  const artifact = input.artifact.trim();
  if (input.coding) {
    parts.push(
      artifact.length > 0
        ? `The author's summary of the change${who}:\n\n${artifact}`
        : `The author${who} left no summary — inspect the repository for the change.`,
    );
  } else {
    parts.push(
      artifact.length > 0
        ? `Artifact to review${who}:\n\n${artifact}`
        : `The author${who} produced no artifact to review.`,
    );
  }
  if (input.directionInjection) parts.push(`[director]: ${input.directionInjection}`);
  parts.push(
    input.coding
      ? "You are the reviewer, from a different vendor than the author. The author edited files in the repository at your working directory — read the files they changed (and run or build them, if your tools allow) to review the ACTUAL change against the contract, not the summary alone: correctness, gaps, and risks. Give a clear verdict (approve or request changes); report your findings concisely, in character. Do not rewrite the author's change yourself."
      : "You are the reviewer, from a different vendor than the author. Review ONLY the artifact above against the contract — correctness, gaps, and risks — and give a clear verdict (approve or request changes). Do not rewrite it; report your findings concisely, in character.",
  );
  return parts.join("\n\n");
}

// The magentic ledger rendered for the manager's prompt: a numbered list of tasks
// with their status, assignee, and any outcome note, so the manager plans against
// what is already done/failed/pending. Empty before the first plan. Pure.
function renderLedger(ledger: TaskLedger | undefined): string {
  if (!ledger || ledger.tasks.length === 0) return "No tasks planned yet.";
  return ledger.tasks
    .map((t, i) => {
      const who = t.assignee ? ` (${t.assignee})` : "";
      const note = t.result ? `: ${t.result}` : "";
      return `${i + 1}. [${t.status}] ${t.description}${who}${note}`;
    })
    .join("\n");
}

// The manager's prompt for a magentic `manage` turn: the goal, the plan so far (the
// ledger), the workers' progress, and the worker roster, then an instruction to
// (re)plan or close by ending with a single trailing JSON object — the SAME "plan"/
// "done" actions parseMagenticPlan reads and stripControlJson removes, so prompt,
// parser, and stripper never drift. Deliberation prose stays visible on the board;
// only the trailing JSON is stripped from the next prompt's context. Always non-empty.
export function buildManagerPrompt(input: {
  topic?: string;
  ledger?: TaskLedger;
  transcript: readonly TurnEntry[];
  workers: readonly MindSlug[];
  directionInjection?: string;
}): string {
  const parts: string[] = [];
  const topic = input.topic?.trim();
  if (topic) parts.push(`Goal: ${topic}`);
  parts.push(`Plan so far:\n\n${renderLedger(input.ledger)}`);
  const context = renderTranscript(input.transcript);
  if (context.length > 0) parts.push(`Workers' progress so far:\n\n${context}`);
  parts.push(`Workers you may assign: ${input.workers.join(", ")}.`);
  if (input.directionInjection) parts.push(`[director]: ${input.directionInjection}`);
  parts.push(
    "You are the manager. Break the goal into concrete, independently-assignable tasks and assign each to a worker — or, if work is underway, review the progress above and revise the plan. List only NEW tasks to add: a completed task shown above need not be repeated, and a failed one may be retried as a new task. END your reply with ONE JSON object on its own line:\n" +
      '{"action":"plan","tasks":[{"description":"<what to do>","assignee":"<worker>"}]} to (re)plan, ' +
      'or {"action":"done","summary":"<outcome>"} when the goal is met. Pick assignee from the workers above.',
  );
  return parts.join("\n\n");
}

// The worker's prompt for a magentic `assign` turn: the goal and the team's progress,
// then the single assigned task and an instruction to do it (in a coding room, to do
// the real work in the repo, not describe it). No routing JSON — the manager owns the
// plan. Always non-empty.
export function buildWorkerPrompt(input: {
  topic?: string;
  task: string;
  transcript: readonly TurnEntry[];
  directionInjection?: string;
  coding?: boolean;
}): string {
  const parts = promptPreamble({
    topic: input.topic,
    transcript: input.transcript,
    emptyContext: "No work has been done yet — you are starting.",
  });
  parts.push(`Your assigned task:\n\n${input.task}`);
  if (input.directionInjection) parts.push(`[director]: ${input.directionInjection}`);
  parts.push(
    input.coding
      ? "You are a worker on this team. Complete YOUR assigned task above by doing the real work in the repository at your working directory — edit and run the files, don't just describe the change. Report what you did and the outcome concisely, in character. Do not emit any routing JSON; the manager tracks the plan."
      : "You are a worker on this team. Complete YOUR assigned task above. Report what you did and the outcome concisely, in character. Do not emit any routing JSON; the manager tracks the plan.",
  );
  return parts.join("\n\n");
}

export interface BuildTurnEntryInput {
  roomSlug: MindSlug;
  turnIndex: number;
  from: TurnEntry["from"];
  role: TurnEntry["role"];
  text: string;
  messageId: string;
  at: string;
  aborted?: boolean;
  round?: number;
  usage?: TokenUsage;
}

// Build a transcript entry from driver-stamped fields. Centralised so the driver
// is the single author of `from` / `turnIndex` / `at` and the shape lives in one
// place.
export function buildTurnEntry(input: BuildTurnEntryInput): TurnEntry {
  return {
    messageId: input.messageId,
    roomSlug: input.roomSlug,
    turnIndex: input.turnIndex,
    ...(input.round !== undefined ? { round: input.round } : {}),
    from: input.from,
    role: input.role,
    parts: [{ text: input.text }],
    ...(input.aborted ? { aborted: true } : {}),
    at: input.at,
    ...(input.usage ? { usage: input.usage } : {}),
  };
}
