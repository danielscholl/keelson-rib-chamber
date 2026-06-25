import { leastSpoken, speakerCounts } from "../routing.ts";
import type { LedgerTask, MindSlug, Strategy, TurnEntry } from "../types.ts";

// Resolve which worker executes a task: the manager's assignment if it still names a
// current participant (validated at plan time, re-checked here so a roster change
// can't route to a stale slug), else the least-spoken worker so load spreads. Pure —
// reads only room.participants and the transcript counts.
export function resolveAssignee(
  task: LedgerTask,
  participants: readonly MindSlug[],
  transcript: readonly TurnEntry[],
): MindSlug | undefined {
  if (task.assignee && participants.includes(task.assignee)) return task.assignee;
  return leastSpoken(participants, speakerCounts(transcript));
}

// The magentic strategy: a manager-led task ledger drives the room. Pure rhythm over
// room + ledger — it never parses the manager's text or spawns a turn (the driver's
// manage/assign branches do that):
//   - the manager closed the plan (done)      -> end
//   - no ledger / no tasks yet                -> the manager plans (manage)
//   - a pending task                          -> a worker executes it (assign)
//   - tasks remain but none pending (settled) -> the manager reviews / replans
// Ends on the structural cases (closed / no workers / budget reached). The manager
// lives in room.config.manager — a non-participant, like the moderator; the workers
// are room.participants.
export const magentic: Strategy = ({ room, transcript, ledger }) => {
  if (room.status !== "active") return { kind: "end" };
  if (room.participants.length === 0) return { kind: "end" };
  if (room.turnIndex >= room.turnBudget) return { kind: "end" };
  const manager = room.config?.manager;
  if (!manager) return { kind: "end" }; // validateStart guarantees one — defensive
  // A closed plan ends — checked BEFORE the empty-ledger guard, because a manager that
  // declared done (or planned nothing) on its first turn settles to status "done" with
  // an empty task list; the empty-guard would otherwise re-run a paid manage turn every
  // step until the budget drains rather than closing the room.
  if (ledger?.status === "done") return { kind: "end" };
  if (!ledger || ledger.tasks.length === 0) return { kind: "manage", mind: manager };
  const pending = ledger.tasks.find((t) => t.status === "pending");
  if (pending) {
    const assignee = resolveAssignee(pending, room.participants, transcript);
    return assignee ? { kind: "assign", mind: assignee, taskId: pending.id } : { kind: "end" };
  }
  // Tasks remain but none are pending (all settled, or a stuck in-progress remnant)
  // and the plan isn't closed — hand back to the manager to review and replan/close.
  return { kind: "manage", mind: manager };
};
