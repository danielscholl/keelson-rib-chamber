import type { MagenticPlan } from "./routing.ts";
import type { LedgerTask, MindSlug, TaskLedger, TaskStatus } from "./types.ts";

// Pure task-ledger transitions for the magentic strategy. The driver loads/saves the
// ledger (room-store.ts) and runs the agent turns; these are the pure state changes
// between turns — a manager's parsed plan applied, a worker's task settled — so they
// unit-test without the driver and the driver stays thin.

export interface LedgerClock {
  now: () => Date;
  newId: () => string;
}

// A normalized description, for the append-time dedup that stops a re-listed task
// from being executed twice.
function normalize(description: string): string {
  return description.trim().toLowerCase().replace(/\s+/g, " ");
}

export function freshLedger(
  roomSlug: MindSlug,
  goal: string,
  manager: MindSlug,
  now: () => Date,
): TaskLedger {
  return { roomSlug, goal, manager, status: "planning", tasks: [], updatedAt: now().toISOString() };
}

// After a (re)plan, derive the ledger status from its tasks: any open task (pending
// or in-progress) means executing; none left means the manager has nothing
// outstanding, so the room can close (done). This is what bounds the manage→assign→
// manage loop — a replan that adds no actionable task closes the room rather than
// looping the manager forever (turnBudget is the backstop either way).
function deriveStatus(tasks: readonly LedgerTask[]): TaskLedger["status"] {
  const open = tasks.some((t) => t.status === "pending" || t.status === "in-progress");
  return open ? "executing" : "done";
}

// Apply a manager's parsed directive to the ledger. `done` closes the plan. `plan`
// APPENDS its tasks (completed/failed history is preserved) — skipping any whose
// description duplicates an existing NON-failed task, so a manager re-listing
// finished work doesn't re-run it while a failed task can still be retried — then
// re-derives the status. A null plan (the manager emitted no parseable directive)
// adds nothing and re-derives: an exhausted ledger closes rather than hanging.
export function applyManagerPlan(
  ledger: TaskLedger,
  plan: MagenticPlan | null,
  participants: readonly MindSlug[],
  clock: LedgerClock,
): TaskLedger {
  const at = clock.now().toISOString();
  if (plan?.action === "done") return { ...ledger, status: "done", updatedAt: at };
  const seen = new Set(
    ledger.tasks.filter((t) => t.status !== "failed").map((t) => normalize(t.description)),
  );
  const additions: LedgerTask[] = [];
  for (const spec of plan?.tasks ?? []) {
    const key = normalize(spec.description);
    if (seen.has(key)) continue;
    seen.add(key);
    additions.push({
      id: clock.newId(),
      description: spec.description,
      // Keep only an assignee that names a real worker; an invalid/hallucinated one
      // is dropped so the assign step routes the task to the least-spoken worker.
      ...(spec.assignee && participants.includes(spec.assignee) ? { assignee: spec.assignee } : {}),
      status: "pending",
      createdAt: at,
      updatedAt: at,
    });
  }
  const tasks = additions.length > 0 ? [...ledger.tasks, ...additions] : ledger.tasks;
  return { ...ledger, tasks, status: deriveStatus(tasks), updatedAt: at };
}

// Settle (or advance) one task's status, stamping an optional outcome note. An
// unknown id is a no-op. Completing a task does NOT itself close the plan — only the
// manager's replan does (deriveStatus runs there) — so the ledger status is left
// untouched here, which is what hands control back to the manager once tasks settle.
export function setTaskStatus(
  ledger: TaskLedger,
  taskId: string,
  status: TaskStatus,
  clock: Pick<LedgerClock, "now">,
  result?: string,
): TaskLedger {
  const at = clock.now().toISOString();
  let changed = false;
  const tasks = ledger.tasks.map((t) => {
    if (t.id !== taskId) return t;
    changed = true;
    return { ...t, status, ...(result !== undefined ? { result } : {}), updatedAt: at };
  });
  if (!changed) return ledger;
  return { ...ledger, tasks, updatedAt: at };
}

// Mark any lingering in-progress task as failed before a manager replan. The driver's
// serial gate guarantees no worker turn is in flight during a manage turn, so an
// in-progress task at that point is an interrupted remnant (a crash/dispose landed
// mid-assign before the task settled), not live work — failing it lets the manager
// see it and retry rather than the room stalling on a task no one is running.
export function failStuckTasks(ledger: TaskLedger, clock: Pick<LedgerClock, "now">): TaskLedger {
  if (!ledger.tasks.some((t) => t.status === "in-progress")) return ledger;
  const at = clock.now().toISOString();
  const tasks = ledger.tasks.map((t) =>
    t.status === "in-progress"
      ? { ...t, status: "failed" as const, result: t.result ?? "interrupted", updatedAt: at }
      : t,
  );
  return { ...ledger, tasks, updatedAt: at };
}
