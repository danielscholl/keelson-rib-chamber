import type { Brief, CanvasBoardView, CanvasJourneySection, CanvasTone } from "@keelson/shared";
import { inferToolFamily } from "@keelson/shared";
import type { LensRecord } from "../lens-store.ts";
import { agoLabel } from "../relative-time.ts";
import { flatFromRoomConfig } from "../room-config.ts";
import {
  clockTime,
  contextFillTone,
  countToolCalls,
  type DecisionMarker,
  flattenMarkdown,
  formatDuration,
  formatTokenCount,
  latestContextByMind,
  type OutcomeSplit,
  outcomeReceipt,
  parseDecisionMarkers,
  parseOutcomeQuestions,
  splitOutcome,
  sumTurnUsage,
  topicContractTail,
  topicGist,
  turnsLabel,
} from "../room-text.ts";
import { speakerCounts, stripControlJson } from "../routing.ts";
import {
  identityToneForSlot,
  type LedgerTask,
  type Mind,
  type MindSlug,
  type Room,
  type TaskLedger,
  type ToolCall,
  type TurnEntry,
} from "../types.ts";

// A `rows` section — the shape the Voices/Decisions rail and the debate column
// share, and the return type a `columns` slot's leaf sections need (not the
// full board-section union, which also includes `columns` itself).
type RowsSection = Extract<CanvasBoardView["sections"][number], { kind: "rows" }>;

// A `bars` section — the per-Mind context meter's shape (a leaf the rail column nests).
type BarsSection = Extract<CanvasBoardView["sections"][number], { kind: "bars" }>;

// One rows item — the debate feed, the Voices/Decisions rail, and the Topic row
// all share this shape.
type FeedItem = RowsSection["items"][number];

// A decision marker resolved to where it was authored — the round it landed in,
// the Mind who pinned it, and its position in the transcript (so a turn row can
// look up "did THIS turn decide anything" precisely).
interface RailEntry extends DecisionMarker {
  round?: number;
  authorSlug: MindSlug;
  turnIndex: number;
}

// Pure: a room + its transcript (+ a magentic task ledger, when one applies) -> a
// canvas `board`. `minds`, when supplied, resolves each speaker to its persisted
// display name and host identity-tone slot (keelson#390); omitted (the default)
// degrades every speaker to its slug and the pre-identity-tones role fallback, so
// older callers and a minimal test setup still render a valid board. `projectLabel`
// is the room's optional scope, already resolved to a display string by the
// caller — the board never resolves a project id itself, staying pure.
// `tabled` is the room's own exhibits (the caller filters by kind and sourceRoom);
// omitted means the board carries no Tabled section at all.
// Validated against canvasViewSchema in tests.
export function buildRoomBoard(
  room: Room,
  transcript: readonly TurnEntry[],
  ledger?: TaskLedger,
  minds: readonly Mind[] = [],
  projectLabel?: string,
  tabled: readonly LensRecord[] = [],
): CanvasBoardView {
  const mindBySlug = new Map(minds.map((m) => [m.slug, m]));
  const counts = speakerCounts(transcript);

  // The room's own convention for closing a debate: the LAST agent turn may carry
  // a synthesized outcome document, split at its own `---`/`##` boundary (see
  // room-text.ts). `textFor` is the one place that split is applied, so every
  // other reader (the debate feed, the decision scan) sees the same effective
  // text for that turn — its pre-boundary debate content, never the document.
  const lastAgentIndex = findLastAgentIndex(transcript);
  const lastRaw = lastAgentIndex >= 0 ? effectiveRawText(transcript[lastAgentIndex]!) : "";
  const { debate: lastDebateText, outcome } = splitOutcome(lastRaw);
  const textFor = (entry: TurnEntry, index: number): string =>
    index === lastAgentIndex && outcome ? lastDebateText : effectiveRawText(entry);

  const decisions = collectDecisions(transcript, textFor);
  const roundDecisions = groupByRound(decisions);

  // Distinct questions, not raw marker count — a re-pinned question must count
  // once here too, or the topic's "produces N decisions" tail disagrees with
  // the Decisions rail's own deduped "N decided" metric below it.
  const topicSection = buildTopicSection(room.topic, distinctQuestionCount(decisions));
  const groundingSection = buildGroundingSection(room.grounding);
  const vitalsSection = buildVitalsSection(transcript, projectLabel);
  const journeySection = buildJourneySection(room, transcript, decisions, outcome?.body, ledger);
  const planSection = buildPlanSection(ledger);

  const debateColumn = {
    kind: "rows" as const,
    title: debateColumnTitle(room, transcript),
    items: buildDebateItems(room, transcript, textFor, mindBySlug, roundDecisions, decisions),
  };
  const voicesSection = buildVoicesSection(room, mindBySlug, counts);
  const contextSection = buildContextSection(room, transcript, mindBySlug);
  const decisionsSection = buildDecisionsSection(decisions, mindBySlug, outcome);

  const columnsSection: CanvasBoardView["sections"][number] = {
    kind: "columns",
    columns: [
      { weight: 1.9, sections: [debateColumn] },
      {
        weight: 1,
        sections: [
          voicesSection,
          ...(contextSection ? [contextSection] : []),
          ...(decisionsSection ? [decisionsSection] : []),
        ],
      },
    ],
  };

  const outcomeSection: CanvasBoardView["sections"] =
    outcome && lastAgentIndex >= 0
      ? [
          buildOutcomeSection(
            room,
            outcome,
            transcript[lastAgentIndex]!.from,
            transcript[lastAgentIndex]!.at,
            mindBySlug,
          ),
        ]
      : [];

  return {
    view: "board",
    title: room.name,
    header: {
      status: { label: room.status, tone: statusTone(room.status) },
      chip: turnsLabel(room.turnIndex, room.turnBudget),
    },
    // Vitals, the room's backed journey, then the topic brief, the magentic plan
    // (when applicable), the debate+rail columns, the outcome document (when the
    // room produced one), what the room tabled, then board-baked controls. Each
    // control carries the room slug as payload (a static actions[] button can't),
    // so onAction routes to the right room.
    sections: [
      ...vitalsSection,
      ...journeySection,
      ...topicSection,
      ...groundingSection,
      ...planSection,
      columnsSection,
      ...outcomeSection,
      ...buildTabledSection(tabled),
      roomControls(room, mindBySlug),
    ],
  };
}

// The room's deliverables, as cards below its outcome. Zero exhibits yields ZERO
// sections (the shelf only exists once the room has tabled something), mirroring
// the exhibits index. No provenance field: every card here is by definition from
// this room, so "from" would restate the board it sits on.
function buildTabledSection(tabled: readonly LensRecord[]): CanvasBoardView["sections"] {
  if (tabled.length === 0) return [];
  return [{ kind: "cards", title: "Tabled", items: tabled.map(tabledCard) }];
}

// One exhibit -> one card. Open rides lens-open because exhibits and lenses share
// the lens key namespace. The delete is confirm-gated and destructive: this card is
// the exhibit's entry point, so it carries the same verbs its index card does.
function tabledCard(exhibit: LensRecord) {
  const title = exhibit.board.title || exhibit.id;
  return {
    title,
    dot: "caution" as CanvasTone,
    fields: [{ label: "tabled", value: agoLabel(exhibit.updatedAt) }],
    ...(exhibit.reason ? { reason: { label: "gist", text: exhibit.reason } } : {}),
    actions: [
      { type: "lens-open", label: "Open", glyph: "↗", payload: { id: exhibit.id } },
      {
        type: "delete-exhibit",
        label: "Delete exhibit…",
        glyph: "✕",
        tone: "warn" as CanvasTone,
        destructive: true,
        payload: { id: exhibit.id },
        confirm: {
          title: "Delete exhibit",
          body: `Delete ${title}? This permanently removes the exhibit.`,
          confirmLabel: "Delete",
          cancelLabel: "Cancel",
        },
      },
    ],
  };
}

function effectiveRawText(entry: TurnEntry): string {
  return stripControlJson(entry.parts.map((p) => p.text).join("\n"));
}

// The last agent entry eligible to carry a synthesized outcome document.
// Excludes an aborted turn — its (partial) text is never trustworthy content:
// turnRow already masks an aborted turn's text behind a bare "(aborted)"
// placeholder, so treating its partial text as a completed, checkmarked
// Outcome document (or scanning it for decision markers) would contradict
// what the debate column itself shows for that very turn.
function findLastAgentIndex(transcript: readonly TurnEntry[]): number {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const entry = transcript[i];
    if (entry?.role === "agent" && !entry.aborted) return i;
  }
  return -1;
}

// The room's vitals as ONE compact status line — a single quiet `rows` item at
// the same register as the round dividers below it: the scope (when set) as a
// small leading chip, then duration + clock span, then the room's token/tool
// totals. A `stats` band of hero tiles for a handful of figures wasted a full row
// at the foot of the board; on one line they read as the secondary facts they are.
function buildVitalsSection(
  transcript: readonly TurnEntry[],
  projectLabel: string | undefined,
): CanvasBoardView["sections"] {
  const first = transcript[0];
  const last = transcript[transcript.length - 1];
  const parts: string[] = [];
  if (first && last) {
    const duration = formatDuration(first.at, last.at);
    if (duration) parts.push(`${duration} · ${clockTime(first.at)} → ${clockTime(last.at)}`);
  }
  const usage = sumTurnUsage(transcript);
  // Suppress the spend arrows on a context-only report (real window, zero in/out).
  if (usage && usage.inputTokens + usage.outputTokens > 0) {
    parts.push(
      `↑ ${formatTokenCount(usage.inputTokens)} in · ↓ ${formatTokenCount(usage.outputTokens)} out`,
    );
  }
  const tools = countToolCalls(transcript);
  if (tools.total > 0) {
    const label = `⚙ ${tools.total} tool${tools.total === 1 ? "" : "s"}`;
    parts.push(tools.failed > 0 ? `${label} · ${tools.failed} failed` : label);
  }
  if (parts.length === 0 && !projectLabel) return [];
  return [
    {
      kind: "rows",
      items: [
        {
          glyph: "neutral" as CanvasTone,
          ...(projectLabel
            ? { chip: { label: `⌂ ${projectLabel}`, tone: "neutral" as CanvasTone } }
            : {}),
          text: parts.length > 0 ? parts.join(" · ") : "No turns yet",
        },
      ],
    },
  ];
}

function buildJourneySection(
  room: Room,
  transcript: readonly TurnEntry[],
  decisions: readonly RailEntry[],
  outcome: string | undefined,
  ledger: TaskLedger | undefined,
): CanvasBoardView["sections"] {
  const items: CanvasJourneySection["items"] = [];
  // Director/system records ride the transcript without advancing the room turn
  // (inject()), so phases count only agent turns — same rule as speakerCounts.
  const agentTurns = transcript.reduce((n, e) => n + (e.role === "agent" ? 1 : 0), 0);
  const hasFrame = agentTurns > 0;
  const hasExplore = hasFrame && (room.round >= 1 || agentTurns > 1);
  // A magentic manager's landed plan IS the room's decision; a planning ledger
  // (no tasks yet) hasn't decided anything.
  const ledgerDecided = !!ledger && ledger.status !== "planning";
  // The driver starts close synthesis once the budget is exhausted while the room
  // is still active (room.ts runBudgetSynthesisIfExhausted) — that window is the
  // honest "synthesis pending" signal. A persisted outcome is itself evidence
  // Decide completed, whatever the room's status.
  const synthesisPending =
    room.status === "active" && room.turnIndex >= room.turnBudget && !outcome;
  const hasDecide =
    hasFrame && (decisions.length > 0 || ledgerDecided || synthesisPending || !!outcome);
  const hasRecord = hasFrame && (!!outcome || room.status === "done");

  if (hasFrame) {
    // The framing moment is static — progression belongs to Explore's turn count.
    items.push({ title: "Frame", text: "Round 1 opened" });
  }
  if (hasExplore) {
    items.push({
      title: "Explore",
      text: `${agentTurns} turn${agentTurns === 1 ? "" : "s"} recorded`,
    });
  }
  if (hasDecide) {
    items.push({ title: "Decide", text: decideText(decisions, ledger, ledgerDecided, outcome) });
  }
  if (hasRecord) {
    items.push({ title: "Record", text: outcome ? "Outcome tabled" : "Room done" });
  }

  return items.length > 0 ? [{ kind: "journey", title: "Journey", items }] : [];
}

function decideText(
  decisions: readonly RailEntry[],
  ledger: TaskLedger | undefined,
  ledgerDecided: boolean,
  outcome: string | undefined,
): string {
  const count = distinctQuestionCount(decisions);
  if (count > 0) return `${count} decided`;
  if (ledgerDecided && ledger) {
    const verb = ledger.status === "done" ? "Plan complete" : "Plan executing";
    if (ledger.tasks.length === 0) return verb;
    const settled = ledger.tasks.filter(
      (t) => t.status === "completed" || t.status === "failed",
    ).length;
    return `${verb} · ${settled}/${ledger.tasks.length} tasks`;
  }
  return outcome ? "Synthesis complete" : "Synthesis pending";
}

// The topic as a brief: the gist collapsed with its contract tail (what the room
// owes, read off decisions actually found plus the topic's own vocabulary — see
// topicContractTail), the full text behind `detail`. Omitted when the room has no
// topic.
function buildTopicSection(
  topic: string | undefined,
  decisionCount: number,
): CanvasBoardView["sections"] {
  const trimmed = topic?.trim();
  if (!trimmed) return [];
  const tail = topicContractTail(trimmed, decisionCount);
  return [
    {
      kind: "rows",
      title: "Topic",
      items: [
        {
          glyph: "brand",
          text: topicGist(trimmed),
          ...(tail ? { trailing: tail } : {}),
          detail: flattenMarkdown(trimmed),
        },
      ],
    },
  ];
}

// The grounding brief as a board section — its source (when set) and each acceptance
// criterion. Empty when the brief carries neither.
function buildGroundingSection(grounding: Brief | undefined): CanvasBoardView["sections"] {
  if (!grounding) return [];
  const source = grounding.sourceUrl?.trim();
  const criteria = grounding.criteria.map((c) => c.trim()).filter(Boolean);
  if (!source && criteria.length === 0) return [];
  const items: FeedItem[] = [];
  if (source) items.push({ glyph: "neutral", text: source });
  for (const c of criteria) items.push({ glyph: "brand", text: c });
  return [{ kind: "rows", title: "Grounding", items }];
}

// The magentic task ledger as a board section: one row per task — the status as a
// tone glyph + a leading icon, the assignee as a chip, any outcome note in the
// trailing. Empty (no section) for a non-magentic room or a ledger with no tasks yet.
// The section title carries the plan's overall status so progress reads at a glance.
function buildPlanSection(ledger: TaskLedger | undefined): CanvasBoardView["sections"] {
  if (!ledger) return [];
  // A persisted-but-empty ledger (a fresh plan, or a manager that closed the goal with
  // no tasks) still shows its state — the reopen path loads ledger.json precisely to
  // surface that, so an empty plan must not render identically to a non-magentic room.
  const items: FeedItem[] =
    ledger.tasks.length > 0
      ? ledger.tasks.map(taskRow)
      : [{ glyph: "neutral", text: "No tasks yet" }];
  return [{ kind: "rows", title: `Plan · ${ledger.status}`, items }];
}

const TASK_ICON: Record<LedgerTask["status"], string> = {
  pending: "○",
  "in-progress": "◐",
  completed: "●",
  failed: "✗",
};

function taskRow(task: LedgerTask): FeedItem {
  const tone = taskTone(task.status);
  return {
    glyph: tone,
    icon: TASK_ICON[task.status],
    ...(task.assignee ? { chip: { label: task.assignee, tone } } : {}),
    text: task.description,
    trailing: task.result ? `${task.status} · ${task.result}` : task.status,
  };
}

function taskTone(status: LedgerTask["status"]): CanvasTone {
  switch (status) {
    case "completed":
      return "ok";
    case "failed":
      return "error";
    case "in-progress":
      return "info";
    default:
      return "neutral"; // pending
  }
}

// The controls section: while a room is active, a per-participant "Call on
// <slug>" (a one-shot nextSpeaker override) and Stop (turns advance on their
// own); once it ends, a single "Start again" that re-runs the same config under
// a fresh room. Each control carries the room slug so onAction targets it.
function roomControls(
  room: Room,
  mindBySlug: Map<string, Mind>,
): CanvasBoardView["sections"][number] {
  if (room.status !== "active") {
    // Carry the grounding brief (flat, the shape roomStartAction parses) so every
    // restart reruns with the same acceptance criteria rather than an ungrounded room.
    const groundingFlat: Record<string, string> = {};
    if (room.grounding?.sourceUrl) groundingFlat.groundingUrl = room.grounding.sourceUrl;
    if (room.grounding && room.grounding.criteria.length > 0) {
      groundingFlat.criteria = room.grounding.criteria.join("\n");
    }
    return {
      kind: "actions",
      title: "Controls",
      wrap: true,
      items: [
        {
          type: "room-start",
          label: "Start again",
          glyph: "▸",
          payload: {
            name: room.name,
            strategy: room.strategy,
            participants: room.participants,
            turnBudget: room.turnBudget,
            // Carry the topic so restarting a finished room keeps its subject, the
            // routing config (flat keys) so a finished group-chat/open-floor restarts
            // with the same config rather than failing start validation, and the
            // project target + coding tier so the restart runs against the same repo
            // with the same capabilities.
            ...(room.topic ? { topic: room.topic } : {}),
            ...(room.projectId ? { projectId: room.projectId } : {}),
            ...(room.coding ? { coding: room.coding } : {}),
            ...groundingFlat,
            ...flatFromRoomConfig(room.config),
          },
        },
        {
          // Re-open as a moderated group-chat: a `fields` form (base #120) collects
          // the moderator slug, merged flat into the dispatched payload. The
          // moderator must be a Mind NOT among participants — start validation
          // rejects otherwise.
          type: "room-start",
          label: `Start ${strategyShapeLabel("group-chat")}`,
          glyph: "◇",
          payload: {
            name: room.name,
            strategy: "group-chat",
            participants: room.participants,
            turnBudget: room.turnBudget,
            ...(room.topic ? { topic: room.topic } : {}),
            ...(room.projectId ? { projectId: room.projectId } : {}),
            ...(room.coding ? { coding: room.coding } : {}),
            ...groundingFlat,
          },
          fields: [
            {
              name: "moderator",
              label: "Moderator (a Mind not in the room)",
              placeholder: "mind-slug",
              required: true,
            },
          ],
        },
        {
          // Re-open as an unmoderated open-floor: speakers nominate the next and
          // vote to close. No fields — the end-vote threshold has a default.
          type: "room-start",
          label: `Start ${strategyShapeLabel("open-floor")}`,
          glyph: "◎",
          payload: {
            name: room.name,
            strategy: "open-floor",
            participants: room.participants,
            turnBudget: room.turnBudget,
            ...(room.topic ? { topic: room.topic } : {}),
            ...(room.projectId ? { projectId: room.projectId } : {}),
            ...(room.coding ? { coding: room.coding } : {}),
            ...groundingFlat,
          },
        },
        {
          // Re-open as a manager-led magentic room: a `fields` form collects the
          // manager slug (a Mind NOT among participants — it plans the task ledger
          // and delegates), merged flat into the payload. Start validation rejects a
          // manager that is also a participant.
          type: "room-start",
          label: `Start ${strategyShapeLabel("magentic")}`,
          glyph: "❖",
          payload: {
            name: room.name,
            strategy: "magentic",
            participants: room.participants,
            turnBudget: room.turnBudget,
            ...(room.topic ? { topic: room.topic } : {}),
            ...(room.projectId ? { projectId: room.projectId } : {}),
            ...(room.coding ? { coding: room.coding } : {}),
            ...groundingFlat,
          },
          fields: [
            {
              name: "manager",
              label: "Manager (a Mind not in the room)",
              placeholder: "mind-slug",
              required: true,
            },
          ],
        },
      ],
    };
  }
  return {
    kind: "actions",
    title: "Controls",
    wrap: true,
    items: [
      // "Call on <slug>" is a one-shot nextSpeaker override — meaningful for the
      // discussion strategies, but magentic routes by the manager's ledger, so a
      // manual call-on would run an off-plan turn that settles no task and burns a
      // budget tick. Offer only Stop there; steer the manager with a director note.
      ...(room.strategy === "magentic"
        ? []
        : room.participants.map((p) => ({
            type: "room-inject",
            label: `Call on ${mindBySlug.get(p)?.name ?? p}`,
            glyph: "↳",
            payload: { slug: room.slug, nextSpeaker: p },
          }))),
      {
        type: "room-stop",
        label: "Stop",
        glyph: "■",
        tone: "warn" as CanvasTone,
        destructive: true,
        payload: { slug: room.slug },
      },
    ],
  };
}

// Every decision marker in the transcript, resolved to where it landed — the
// round, the author, and its transcript position (so a turn row can look up
// exactly what IT decided, and a round divider can list what ITS round decided).
// Skips an aborted turn: its (partial) text is masked to "(aborted)" in the
// debate row itself, so it must not surface as a settled decision either.
function collectDecisions(
  transcript: readonly TurnEntry[],
  textFor: (entry: TurnEntry, index: number) => string,
): RailEntry[] {
  const out: RailEntry[] = [];
  transcript.forEach((entry, index) => {
    if (entry.role !== "agent" || entry.aborted) return;
    for (const marker of parseDecisionMarkers(textFor(entry, index))) {
      out.push({ ...marker, round: entry.round, authorSlug: entry.from, turnIndex: index });
    }
  });
  return out;
}

function distinctQuestionCount(decisions: readonly RailEntry[]): number {
  return new Set(decisions.map((d) => d.question)).size;
}

// One question per round, deduped — a question re-pinned twice within the
// same round (a correction) must still name it once in that round's divider.
function groupByRound(decisions: readonly RailEntry[]): Map<number, number[]> {
  const map = new Map<number, Set<number>>();
  for (const d of decisions) {
    if (d.round === undefined) continue;
    const set = map.get(d.round) ?? new Set<number>();
    set.add(d.question);
    map.set(d.round, set);
  }
  return new Map([...map].map(([round, set]) => [round, [...set]]));
}

function debateColumnTitle(room: Room, transcript: readonly TurnEntry[]): string {
  const rounds = transcript.map((e) => e.round).filter((r): r is number => r !== undefined);
  const shape = strategyShapeLabel(room.strategy);
  if (rounds.length === 0) return shape;
  const roundCount = Math.max(...rounds) + 1;
  return roundCount > 1 ? `${shape} · ${roundCount} rounds` : shape;
}

function strategyShapeLabel(strategy: string): string {
  switch (strategy) {
    case "sequential":
      return "Discussion";
    case "group-chat":
      return "Debate";
    case "open-floor":
      return "Open floor";
    case "review":
      return "Review";
    case "magentic":
      return "Delegate";
    default:
      return `${strategy.charAt(0).toUpperCase()}${strategy.slice(1)}`;
  }
}

// The debate feed: a row per turn, with a round-head divider wherever the round
// cursor changes (including the very first) and a single termination marker once
// the room closes. A round head names the questions decided within it, computed
// (never authored) from the transcript's own decision markers.
function buildDebateItems(
  room: Room,
  transcript: readonly TurnEntry[],
  textFor: (entry: TurnEntry, index: number) => string,
  mindBySlug: Map<string, Mind>,
  roundDecisions: Map<number, number[]>,
  decisions: readonly RailEntry[],
): FeedItem[] {
  const moderator = room.config?.moderator;
  const synthesizer = room.config?.synthesizer;
  const manager = room.config?.manager;
  const items: FeedItem[] = [];
  let lastRound: number | undefined;
  transcript.forEach((entry, index) => {
    if (entry.round !== undefined && entry.round !== lastRound) {
      items.push(roundDivider(entry.round, roundDecisions.get(entry.round)));
      lastRound = entry.round;
    }
    items.push(
      turnRow(entry, index, textFor, moderator, synthesizer, manager, mindBySlug, decisions),
    );
    items.push(...toolRows(entry));
  });
  const end = terminationMarker(room);
  if (end) items.push(end);
  return items;
}

function roundDivider(round: number, questions: number[] | undefined): FeedItem {
  const label = `Round ${round + 1}`;
  if (!questions || questions.length === 0) return { icon: "—", glyph: "neutral", text: label };
  return {
    icon: "—",
    glyph: "neutral",
    text: `${label} — decides ${questions.map((q) => `Q${q}`).join(" · ")}`,
  };
}

// Facilitator turns (the moderator's routing, the synthesizer's closing summary,
// a magentic manager's plan) read distinctly from participant chatter — all three
// wear the host's brand tone (matching squad's coordinator convention), never a
// participant's identity hue. The brand tone is the sole facilitator marker: every
// speaker row leads with one toned bullet + its name chip so the feed aligns on a
// single left edge (a facilitator row carried an extra leading icon before, which
// pushed its chip right and read as an unintended indent beside flush participants).
// A participant wears its persisted identity-tone slot (keelson#390) when
// resolvable, else the pre-identity-tones role fallback.
function turnRow(
  entry: TurnEntry,
  index: number,
  textFor: (entry: TurnEntry, index: number) => string,
  moderator: MindSlug | undefined,
  synthesizer: MindSlug | undefined,
  manager: MindSlug | undefined,
  mindBySlug: Map<string, Mind>,
  decisions: readonly RailEntry[],
): FeedItem {
  const label = mindBySlug.get(entry.from)?.name ?? entry.from;
  const time = clockTime(entry.at);
  const observ = turnSpendTail(entry);

  if (entry.aborted) {
    return {
      glyph: "error",
      chip: { label, tone: roleTone(entry.role) },
      text: "(aborted)",
      trailing: `${time} · aborted${observ}`,
    };
  }

  const flattened = flattenMarkdown(textFor(entry, index));
  const summary = summaryLine(flattened);
  const text = summary || "(no text)";
  const detail =
    flattened.trim().length > 0 && flattened.trim() !== summary ? flattened : undefined;
  const decidedHere = decisions.filter((d) => d.turnIndex === index);
  const decidedSuffix = decidedHere.length
    ? ` · ${decidedHere.map((d) => `Q${d.question} decided`).join(", ")}`
    : "";
  const trailing = `${time}${decidedSuffix}${observ}`;

  if (entry.from === synthesizer || entry.from === manager || entry.from === moderator) {
    return {
      glyph: "brand",
      chip: { label, tone: "brand" },
      text,
      trailing,
      ...(detail ? { detail } : {}),
    };
  }

  const mind = entry.role === "agent" ? mindBySlug.get(entry.from) : undefined;
  const tone = mind ? identityToneForSlot(mind.identitySlot) : roleTone(entry.role);
  return { glyph: tone, chip: { label, tone }, text, trailing, ...(detail ? { detail } : {}) };
}

// The turn's own token spend, appended after its time — only when it actually spent,
// so a context-only usage report (real window, zero in/out) never reads as ↑0 ↓0.
function turnSpendTail(entry: TurnEntry): string {
  const u = entry.usage;
  if (u && u.inputTokens + u.outputTokens > 0) {
    return ` · ↑${formatTokenCount(u.inputTokens)} ↓${formatTokenCount(u.outputTokens)}`;
  }
  return "";
}

// A turn's tool calls fold into ONE collapsed `⚙ N tools` row so the discussion reads
// clean; the per-tool list and each input is disclosed under its single caret via
// `detail`. `rows` gives one disclosure level, so this is a group caret, not per-tool
// carets nested inside it (that two-level nest would need a new canvas kind).
// Only a KNOWN failure is surfaced (error tone + "N failed"): success is never asserted,
// since `errored` is absent for a confirmed-ok call and for one whose result never emitted.
function toolRows(entry: TurnEntry): FeedItem[] {
  const calls = entry.toolCalls;
  if (!calls?.length) return [];
  const failed = calls.filter((c) => c.errored).length;
  return [
    {
      icon: "⚙",
      text: `${calls.length} tool${calls.length === 1 ? "" : "s"}`,
      detail: toolGroupDetail(calls),
      ...(failed ? { glyph: "error" as CanvasTone, trailing: `${failed} failed` } : {}),
    },
  ];
}

// The disclosed body: each call as `name · FAMILY` (+ `· failed`), its input JSON below.
// EVERY head line is kept — which tool ran and which failed must survive — so only the
// input bodies share the remaining budget; a burst of large inputs drops its own bodies
// (noted in a footer), never the tail of the list. Bounded to the row-detail cap.
const MAX_TOOL_GROUP_DETAIL = 4000;
const OMIT_FOOTER_MAX = 60;
function toolGroupDetail(calls: readonly ToolCall[]): string {
  const heads = calls.map((c) => {
    // Prefer the family captured from the raw wire name; fall back for older entries.
    const family = c.family ?? inferToolFamily(c.name);
    const label = (family === "other" ? "built-in" : family).toUpperCase();
    return `${c.name} · ${label}${c.errored ? " · failed" : ""}`;
  });
  const separators = Math.max(0, calls.length - 1) * 2; // "\n\n" between blocks
  const headsTotal = heads.reduce((n, h) => n + h.length, 0) + separators;
  let bodyBudget = MAX_TOOL_GROUP_DETAIL - headsTotal - OMIT_FOOTER_MAX;
  let omitted = 0;
  const blocks = calls.map((c, i) => {
    const head = heads[i]!;
    if (!c.input) return head;
    const cost = c.input.length + 1; // the "\n" before the body
    if (cost <= bodyBudget) {
      bodyBudget -= cost;
      return `${head}\n${c.input}`;
    }
    omitted++;
    return head;
  });
  let joined = blocks.join("\n\n");
  if (omitted > 0) joined += `\n\n… ${omitted} input${omitted === 1 ? "" : "s"} omitted (budget)`;
  // Backstop: pathologically long head lines alone could still overrun the cap.
  return joined.length > MAX_TOOL_GROUP_DETAIL
    ? `${joined.slice(0, MAX_TOOL_GROUP_DETAIL - 2)}\n…`
    : joined;
}

function summaryLine(flatText: string, max = 140): string {
  const oneline = flatText.replace(/\s+/g, " ").trim();
  return oneline.length > max ? `${oneline.slice(0, max - 1).trim()}…` : oneline;
}

// The Voices panel: the room's facilitator(s) (moderator/synthesizer/manager —
// brand-toned, matching squad's coordinator), then its participants in seat
// order, each with its role, its host identity tone, and its spelled-out turn
// count ("6 turns", not a ×N code).
function buildVoicesSection(
  room: Room,
  mindBySlug: Map<string, Mind>,
  counts: Map<string, number>,
): RowsSection {
  const seen = new Set<string>();
  const rows: FeedItem[] = [];
  for (const [slug, role] of facilitatorRoles(room)) {
    if (seen.has(slug)) continue;
    seen.add(slug);
    rows.push(voiceRow(slug, mindBySlug, "brand", role, counts.get(slug) ?? 0));
  }
  for (const slug of room.participants) {
    if (seen.has(slug)) continue;
    seen.add(slug);
    const mind = mindBySlug.get(slug);
    const tone = mind ? identityToneForSlot(mind.identitySlot) : "info";
    rows.push(voiceRow(slug, mindBySlug, tone, mind?.role, counts.get(slug) ?? 0));
  }
  return { kind: "rows", title: "Voices", items: rows };
}

function facilitatorRoles(room: Room): [MindSlug, string][] {
  const out: [MindSlug, string][] = [];
  if (room.config?.moderator) out.push([room.config.moderator, "moderator"]);
  if (room.config?.synthesizer) out.push([room.config.synthesizer, "synthesizer"]);
  if (room.config?.manager) out.push([room.config.manager, "manager"]);
  return out;
}

function voiceRow(
  slug: MindSlug,
  mindBySlug: Map<string, Mind>,
  tone: CanvasTone,
  role: string | undefined,
  turns: number,
): FeedItem {
  return {
    glyph: tone,
    chip: { label: mindBySlug.get(slug)?.name ?? slug, tone },
    text: role?.trim() || "Mind",
    trailing: `${turns} turn${turns === 1 ? "" : "s"}`,
  };
}

// The Context meter: one `bars` fill per speaker whose latest turn reported a context
// window, in the same facilitator-then-participant order as Voices, toned green→amber→
// red by fill. A provider that reports no window contributes no bar; when none do, the
// whole section is omitted rather than rendering an empty meter.
function buildContextSection(
  room: Room,
  transcript: readonly TurnEntry[],
  mindBySlug: Map<string, Mind>,
): BarsSection | undefined {
  const latest = latestContextByMind(transcript);
  const order: MindSlug[] = [];
  const seen = new Set<string>();
  for (const [slug] of facilitatorRoles(room)) {
    if (!seen.has(slug)) {
      seen.add(slug);
      order.push(slug);
    }
  }
  for (const slug of room.participants) {
    if (!seen.has(slug)) {
      seen.add(slug);
      order.push(slug);
    }
  }
  const items: BarsSection["items"] = [];
  for (const slug of order) {
    const ctx = latest.get(slug);
    if (!ctx) continue;
    // Tone off the raw ratio so the 70%/85% cutoffs are exact; round only the
    // displayed figure (else 69.5% would already read as warn).
    const rawPct = (ctx.contextTokens / ctx.contextWindow) * 100;
    const shownPct = Math.min(100, Math.round(rawPct));
    items.push({
      label: mindBySlug.get(slug)?.name ?? slug,
      value: ctx.contextTokens,
      total: ctx.contextWindow,
      tone: contextFillTone(rawPct),
      trailing: `${formatTokenCount(ctx.contextTokens)} / ${formatTokenCount(ctx.contextWindow)} · ${shownPct}%`,
    });
  }
  return items.length > 0 ? { kind: "bars", title: "Context · window fill", items } : undefined;
}

// The Decisions rail: one row per pinned question, in debate order — the tone
// and name of who decided it, which round, and its gist. The title folds in the
// scoreboard metric: "N of M decided" once the room's outcome document restates
// the full set, else a plain running "N decided" while the room is still live.
function buildDecisionsSection(
  decisions: readonly RailEntry[],
  mindBySlug: Map<string, Mind>,
  outcome: OutcomeSplit | undefined,
): RowsSection | undefined {
  if (decisions.length === 0) return undefined;
  // A question re-pinned more than once (a correction) keeps only its LATEST
  // pin in the rail — one row per question, in first-decided order — so the
  // rail's row count always agrees with the "N decided" metric above it.
  const latestByQuestion = new Map<number, RailEntry>();
  for (const d of decisions) latestByQuestion.set(d.question, d); // last write wins
  const order: number[] = [];
  const seenQuestions = new Set<number>();
  for (const d of decisions) {
    if (seenQuestions.has(d.question)) continue;
    seenQuestions.add(d.question);
    order.push(d.question);
  }
  const deduped = order.map((q) => latestByQuestion.get(q)!);
  const decidedCount = deduped.length;
  const totalCount = outcome ? parseOutcomeQuestions(outcome.body).length : 0;
  const metric =
    totalCount > 0 ? `${decidedCount} of ${totalCount} decided` : `${decidedCount} decided`;
  const items: FeedItem[] = deduped.map((d) => {
    const mind = mindBySlug.get(d.authorSlug);
    const tone = mind ? identityToneForSlot(mind.identitySlot) : "info";
    return {
      glyph: tone,
      chip: { label: `Q${d.question}`, tone },
      text: d.gist ? `${d.title} — ${d.gist}` : d.title,
      trailing: `${mind?.name ?? d.authorSlug}${d.round !== undefined ? ` · round ${d.round + 1}` : ""}`,
    };
  });
  return { kind: "rows", title: `Decisions · ${metric}`, items };
}

// The Outcome card: the document's authored title, a receipt (who synthesized
// it, when, and a mechanical contract check against its own section headings —
// never an authored claim), a short preview, and the two concrete verbs: Copy
// (the field's copyAction seam fetches the full markdown on click and writes it
// to the clipboard — see index.ts's outcomeCopyAction) and Explore in chat (the
// surface→chat handoff every ✦ verb uses — see outcomeExploreAction).
function buildOutcomeSection(
  room: Room,
  outcome: OutcomeSplit,
  authorSlug: MindSlug,
  at: string,
  mindBySlug: Map<string, Mind>,
): CanvasBoardView["sections"][number] {
  const receipt = outcomeReceipt(outcome.body);
  const authorName = mindBySlug.get(authorSlug)?.name ?? authorSlug;
  const parts = [`${receipt.decisions} decision${receipt.decisions === 1 ? "" : "s"}`];
  if (receipt.criteria !== undefined) parts.push(`${receipt.criteria} criteria`);
  if (receipt.hasTestPlan) parts.push("test plan");
  if (receipt.hasOutOfScope) parts.push("out-of-scope");
  const flattenedBody = flattenMarkdown(outcome.body);
  const preview =
    flattenedBody.length > 220 ? `${flattenedBody.slice(0, 219).trim()}…` : flattenedBody;
  return {
    kind: "cards",
    title: "Outcome",
    items: [
      {
        title: outcome.title,
        dot: "ok" as CanvasTone,
        reason: {
          text: `synthesized by ${authorName} · ${clockTime(at)} — ✓ delivers ${parts.join(" · ")}`,
        },
        footnote: `${preview}\n\nFull document via Copy markdown or ✦ Explore in chat.`,
        fields: [
          {
            label: "Copy",
            value: "Outcome as markdown",
            copyAction: { type: "outcome-copy", payload: { slug: room.slug } },
          },
        ],
        actions: [
          {
            type: "outcome-explore",
            label: "✦ Explore in chat",
            glyph: "✦",
            payload: { slug: room.slug },
          },
        ],
      },
    ],
  };
}

// A closed room ends with one thin marker: "Stopped" (interrupted) vs "Closed"
// (ran to a natural end). The room records no close reason, and the turn count
// can't tell a budget-gate close from a moderator close that lands on budget, so
// the marker stays coarse — the header's turnIndex/turnBudget chip already shows
// whether the budget was reached.
function terminationMarker(room: Room): FeedItem | undefined {
  if (room.status === "active") return undefined;
  if (room.status === "stopped") return { icon: "—", glyph: "warn", text: "Stopped" };
  return { icon: "—", glyph: "neutral", text: "Closed" };
}

function roleTone(role: TurnEntry["role"]): CanvasTone {
  switch (role) {
    case "director":
      return "accent";
    case "system":
      return "neutral";
    default:
      return "info";
  }
}

function statusTone(status: Room["status"]): CanvasTone {
  switch (status) {
    case "active":
      return "info";
    case "stopped":
      return "warn";
    default:
      return "ok";
  }
}
