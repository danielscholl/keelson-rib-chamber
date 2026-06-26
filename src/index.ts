import { fileURLToPath } from "node:url";
import type {
  CanvasBoardView,
  CanvasView,
  CommandCompletion,
  CommandInvokeResult,
  Project,
  Rib,
  RibAction,
  RibActionResult,
  RibAuthStatus,
  RibCommandDescriptor,
  RibContext,
  SnapshotManager,
  ToolContext,
  ToolDefinition,
} from "@keelson/shared";
import {
  asNonEmptyString,
  asStringArray,
  canvasBoardViewSchema,
  errText,
  expectView,
  z,
} from "@keelson/shared";
import { listAgents, resolveAgent } from "./agents.ts";
import { buildRoomBoard } from "./boards/room.ts";
import {
  capabilityVocabulary,
  codingReviewCapabilityError,
  codingToolPool,
  KNOWN_CAPABILITY_SLUGS,
} from "./capabilities.ts";
import {
  buildChamberState,
  type ChamberDelta,
  chamberFingerprint,
  diffAgainstWatermark,
  readChamberRecords,
} from "./chamber-state.ts";
import { buildSeedFor, composeRoomSystemPrompt } from "./compose.ts";
import { writeDigest } from "./digest-store.ts";
import { assertSafeSlug, slugify } from "./genesis.ts";
import {
  CHAMBER_SURFACE_ID,
  canonicalLensId,
  createLensRegistry,
  LENS_TOOL_NAME,
  type LensRegistry,
  lensKey,
} from "./lens.ts";
import {
  createHtmlLensRegistry,
  HTML_LENS_KEY,
  HTML_LENS_TOOL_NAME,
  type HtmlLensRegistry,
} from "./lens-html.ts";
import { createFileLensStore, type LensStore, listLenses } from "./lens-store.ts";
import {
  appendLog,
  MEMORY_DOC_CAP,
  type MindRecord,
  readMindDoc,
  readMinds,
  readSoul,
  retireMind,
  scaffoldMind,
  setMindModel,
  writeMemory,
} from "./minds-store.ts";
import {
  chamberDataHome,
  isChamberDataHomeWritable,
  lensesDir,
  mindsDir,
  roomsDir,
  setChamberDataHome,
} from "./paths.ts";
import type { RoomStore } from "./ports.ts";
import { createRoomDriver, type RoomDriver } from "./room.ts";
import { type RoomConfigInput, roomConfigFromFlat } from "./room-config.ts";
import { clearDraft, readDraftExclusion, toggleDraftExclusion } from "./room-draft.ts";
import { createCoalescingPublisher } from "./room-publisher.ts";
import { createRoomRegionRegistry, type RoomRegionRegistry } from "./room-region-registry.ts";
import { createFileRoomStore, deriveRoomName, listRooms, sweepClosedRooms } from "./room-store.ts";
import { DEFAULT_END_VOTE_THRESHOLD } from "./routing.ts";
import { GENESIS_STARTERS } from "./starters.ts";
import { getStrategy } from "./strategies/index.ts";
import { renderTranscript } from "./transcript.ts";
import type { Mind, Room, RoomConfig, RoomStrategyName, TurnEntry } from "./types.ts";
import { readWatermark, writeWatermark } from "./watermark-store.ts";

const BRIEF_KEY = "rib:chamber:brief";
const ROSTER_KEY = "rib:chamber:roster";
const ROOMS_KEY = "rib:chamber:rooms";
const LENSES_KEY = "rib:chamber:lenses";
const ACTIVITY_KEY = "rib:chamber:activity";
const DIGEST_KEY = "rib:chamber:digest";
// The standing-digest write seam, referenced by both the tool registration and the
// chamber-digest workflow's author node (allowed_tools) — one source of truth.
const DIGEST_TOOL_NAME = "chamber_emit_digest";
// The snapshot-only key family the Rooms index `Open` focuses (see roomOpenAction).
// Per-slug so two clients opening two different closed rooms get independent boards
// in their drawers instead of colliding on one shared key (active rooms / lenses use
// the same per-id isolation).
function roomViewKey(slug: string): string {
  return `rib:chamber:room-view:${slug}`;
}

// Upper bound on a room's turn budget. Each turn is a (paid) agent call, so an
// accidental or malicious huge budget would launch a runaway sequence; reject it.
const MAX_ROOM_TURN_BUDGET = 50;
// Default room length when a chat tool omits turnBudget. Applied after parse (not
// z.default()) because z.toJSONSchema — which the Copilot provider feeds the model
// — lists defaulted fields as `required`, forcing the model to supply them.
const DEFAULT_ROOM_TURN_BUDGET = 8;

// The room driver is a boot-time singleton: it holds in-flight turn state across
// onAction calls, so it is built once in registerTools (the only hook that runs
// with the full ctx — runAgentTurn + snapshot manager) and reused thereafter. It
// stays undefined when either seam is absent, and room actions then fail closed.
let driver: RoomDriver | undefined;
// The lens registry is a boot-time singleton too: it owns the per-subject snapshot
// registrations and surface regions, created once in registerTools and disposed in
// dispose() so a re-register doesn't duplicate-register. lensSm tracks the manager it
// was built against, so a re-bootstrap with a different one rebinds it.
let lensRegistry: LensRegistry | undefined;
let lensSm: SnapshotManager | undefined;
let htmlLensRegistry: HtmlLensRegistry | undefined;
let htmlLensSm: SnapshotManager | undefined;
// Tracked alongside htmlLensSm because createHtmlLensRegistry captures registerRegion:
// a re-bootstrap that reuses the same manager but hands a fresh seam must rebuild, or
// the registry would publish/register through the stale registerRegion.
let htmlLensRegisterRegion: NonNullable<RibContext["registerRegion"]> | undefined;
// The room region registry is a boot-time singleton like the lens one: it owns the
// per-slug room snapshot keys + surface regions, built once in registerTools and
// disposed in dispose(). roomSm tracks the manager it was built against so a
// re-bootstrap with a different one rebinds it.
let roomRegistry: RoomRegionRegistry | undefined;
let roomSm: SnapshotManager | undefined;
// A closed room is released from the region registry (retainOnly keeps only active +
// the most-recent), so unlike a lens it has no standing key. room-open publishes each
// opened room's board to its own snapshot-only key (roomViewKey(slug)) the drawer
// subscribes to, registered lazily and torn down in dispose().
let roomViewSm: SnapshotManager | undefined;
const roomViewEntries = new Map<
  string,
  { publisher: { publish(view: CanvasView): Promise<void> }; unregister: () => void }
>();
// The refresh seam, captured in registerTools (the only hook with the full ctx) so
// onAction handlers can re-run a bound collector on demand instead of waiting on
// cadence — room-delete uses it to drop a deleted session's card. Optional and
// fail-soft: undefined on an older harness, where the index falls back to cadence.
let refreshWorkflow: RibContext["refreshWorkflow"];

// Fan a Chamber mutation out to the derived STANDING panels, which were otherwise
// cadence-only. Activity is deterministic + free, so every mutation refreshes it; a
// removal also re-runs the gated Digest so its board can't keep naming a gone entity
// (the gate no-ops when the fingerprint is unchanged). The Briefing delta is left to
// its own attention gate.
async function refreshStandingPanels(opts: { removed?: boolean } = {}): Promise<void> {
  await refreshWorkflow?.("chamber-activity")?.catch(() => {});
  if (opts.removed) await refreshWorkflow?.("chamber-digest")?.catch(() => {});
}
// The host projects lookup, captured in registerTools and cleared in dispose (like
// refreshWorkflow). Undefined on a harness that predates RibContext.getProjects,
// where a projectId is rejected at start (fail closed) rather than targeting nothing.
let getProjects: RibContext["getProjects"];

// The one place a projectId is matched against the host list, so start-time
// validation and the driver's per-turn cwd agree on what an id means.
function resolveProject(projectId: string): Project | undefined {
  return getProjects?.().find((p) => p.id === projectId);
}
function resolveProjectRoot(projectId: string): string | undefined {
  return resolveProject(projectId)?.rootPath;
}
// The briefing gate's seams + state, captured in registerTools (the only hook with
// the full ctx). The publisher routes the brief board to BRIEF_KEY; briefRunAgentTurn
// is the (paid) turn the gate fires ONLY when something new happened. Both undefined
// when a seam is absent — the gate then keeps a quiet board and runs no turn.
let briefPublisher: { publish(board: CanvasBoardView): Promise<void> } | undefined;
let briefUnregister: (() => void) | undefined;
let briefSm: SnapshotManager | undefined;
let briefRunAgentTurn: RibContext["runAgentTurn"];
// Serializes brief evaluations so concurrent triggers (a room ending as a lens lands)
// fire at most ONE agent turn: the second await-chains behind the first, then re-reads
// state — which the first turn's watermark advance has likely made quiet. The headline
// cost-safety invariant rides this plus the hasSubstance gate.
let briefInFlight: Promise<void> = Promise.resolve();
// Aborts the gate's in-flight (paid) turn on dispose, mirroring the room driver's
// per-room controllers. The gate captures this signal per turn and re-checks it
// before its publish/write, so a turn caught mid-shutdown drops its late result
// instead of writing post-teardown. registerTools installs a fresh controller each
// boot, so an orphaned pre-dispose turn stays aborted (gated out) even after re-boot.
let briefAbort = new AbortController();

// The reflection gate's seams + state, captured in registerTools alongside the brief
// gate's. reflectRunAgentTurn is the (paid) turn each participating Mind runs at a
// room's close to curate its own memory.md; undefined when the agent-turn seam is
// absent (older harness), where a room closes with no reflection. reflectAbort aborts
// in-flight reflection on dispose (mirrors briefAbort). reflectWrites serializes a
// Mind's memory writes so two rooms closing at once that share it can't lose-update.
let reflectRunAgentTurn: RibContext["runAgentTurn"];
let reflectAbort = new AbortController();
const reflectWrites = new Map<string, Promise<unknown>>();

// Slugs whose auto-advance loop is running, so a re-start doesn't double-drive.
const loops = new Set<string>();
// Monotonic suffix so each room-start gets a brand-new slug (see freshRoomSlug).
let roomSeq = 0;
// Rooms currently active. Multiple run concurrently — each on its own per-slug
// snapshot key + surface region — so a room is added when it opens and removed when
// it stops or its loop ends. Set iteration is insertion-ordered, so the last entry
// is the most-recently-started active room: the default target when a chat tool
// omits an explicit slug.
const activeRooms = new Set<string>();
// The most-recent room, active or finished. Unlike activeRooms it survives the room
// ending, so chamber_room_status (and the surface's retained panel) can still show a
// just-finished transcript. Cleared only on dispose.
let lastSlug: string | undefined;
// Cap on concurrently-active rooms. Each runs its own loop of paid agent turns, so an
// unbounded fan-out would burn cost without an operator noticing. A small soft cap
// keeps "multiple rooms" useful while bounding the spend; it also sits far under the
// harness per-surface region ceiling, so a start never fails for lack of a panel slot.
export const MAX_ACTIVE_ROOMS = 6;
let roomRetentionSweep = Promise.resolve();

// The roster the driver resolves a speaker's persona from each turn. Cached
// because it only changes when a Mind is created (the genesis tool) or retired
// (onAction); re-reading every mind dir per turn is avoidable disk I/O.
// invalidateRoster() clears it on any mutation and dispose() resets it, so a fresh
// boot re-reads. Assumes a fixed workspace per process — the cache is not keyed on
// KEELSON_WORKSPACE.
let roster: readonly Mind[] | undefined;
async function resolveMinds(): Promise<readonly Mind[]> {
  if (roster) return roster;
  const minds = await readMinds(mindsDir());
  // Only memoize a non-empty read: readMinds returns [] both for "no minds yet"
  // and for a transient readdir error, so caching [] would stick an empty roster
  // (every speaker -> "unknown mind", ending each room) until the next mutation.
  // Re-reading an empty dir each turn is cheap and self-heals once minds appear.
  if (minds.length > 0) roster = minds;
  return minds;
}
function invalidateRoster(): void {
  roster = undefined;
}

function queueRoomRetentionSweep(): void {
  const root = roomsDir();
  roomRetentionSweep = roomRetentionSweep.then(
    () => runRoomRetentionSweep(root),
    () => runRoomRetentionSweep(root),
  );
}

async function runRoomRetentionSweep(root: string): Promise<void> {
  try {
    const { removed } = await sweepClosedRooms(root);
    // A sweep that actually pruned rooms changed the store — refresh the index and the
    // standing panels (like the user-initiated room-delete) so an evicted room stops
    // showing instead of lingering until the 120s cadence.
    if (removed.length > 0) {
      await refreshWorkflow?.("chamber-rooms")?.catch(() => {});
      await refreshStandingPanels({ removed: true });
    }
  } catch (e) {
    console.error(`[rib-chamber] room retention sweep failed: ${errText(e)}`);
  }
}

// Re-publish every persisted lens on boot so its live panel + snapshot key come
// back after a restart (the registry is otherwise in-memory only). Fire-and-forget
// and fail-soft per entry — listLenses already skips a corrupt record, and one lens
// that fails to re-publish (e.g. the per-surface region ceiling) is logged and
// skipped so it can't block boot. Re-registers via reregister (the live half of
// publish) WITHOUT re-saving, so a lens's authored updatedAt is preserved — a
// restart must not reset every lens's freshness.
// In flight while boot re-registration runs. retire awaits it so a retire landing
// mid-reconcile can't race a reregister into resurrecting the just-deleted lens (a
// live key/panel with no on-disk record).
let lensReconcileInFlight: Promise<void> | undefined;

// Serializes lens write-backs (the lens-note action's load-append-publish) so two
// concurrent appends to the same board can't lose-update each other. Mirrors
// briefInFlight: a global chain, reset on dispose so a re-boot starts fresh.
let lensWriteInFlight: Promise<unknown> = Promise.resolve();

function reconcileLensPanels(registry: LensRegistry): void {
  lensReconcileInFlight = (async () => {
    let records: Awaited<ReturnType<typeof listLenses>>;
    try {
      records = await listLenses(lensesDir());
    } catch (e) {
      console.error(`[rib-chamber] lens re-registration failed: ${errText(e)}`);
      return;
    }
    for (const rec of records) {
      try {
        await registry.reregister(rec.id, rec.board);
      } catch (e) {
        console.error(`[rib-chamber] lens '${rec.id}' re-registration failed: ${errText(e)}`);
      }
    }
  })();
  void lensReconcileInFlight;
}

// The room surface shows a panel for every active room plus the most-recent room's,
// so a just-finished room's final board lingers until a newer room supersedes it.
// Recomputed after any room lifecycle change; retainOnly drops the panels of rooms
// that are neither active nor the most-recent.
function reconcileRoomPanels(): void {
  const keep = new Set(activeRooms);
  if (lastSlug) keep.add(lastSlug);
  roomRegistry?.retainOnly(keep);
}

// The attention gate. A room ending or a lens changing fires this; it is the SOLE
// path that may run the (paid) briefing turn, and it runs one ONLY when the live
// ChamberState shows substance the watermark hasn't seen. Every call chains onto
// briefInFlight, so concurrent triggers collapse: the second runs after the first
// has advanced the watermark and therefore re-reads as quiet (no second turn). The
// returned promise is for tests; hooks fire-and-forget it. Never throws — a failed
// turn keeps the prior board and leaves the watermark un-advanced. Exported so the
// brief-gate test can drive it directly (asserting the no-turn-when-quiet invariant).
export function evaluateBriefGate(): Promise<void> {
  const next = briefInFlight.then(runBriefGate, runBriefGate);
  // Keep the chain alive even if this run rejected, so a later trigger still serializes
  // behind it rather than racing a half-finished evaluation.
  briefInFlight = next.catch(() => {});
  return next;
}

async function runBriefGate(): Promise<void> {
  // Seam absent (older harness, or a ctx without the snapshot/turn seams): the footer
  // keeps whatever board it has (the boot-seeded quiet one) and no turn ever runs.
  if (!briefPublisher || !briefRunAgentTurn) return;
  const publisher = briefPublisher;
  const runTurn = briefRunAgentTurn;
  // Capture this boot's abort signal up front: a dispose during the turn aborts it,
  // and re-checking it (not the live briefAbort) before publish/write gates out a
  // turn whose rib was torn down — including one orphaned across a later re-boot.
  const { signal } = briefAbort;

  let state: Awaited<ReturnType<typeof buildChamberState>>;
  let watermark: Awaited<ReturnType<typeof readWatermark>>;
  try {
    state = await buildChamberState();
    watermark = await readWatermark();
  } catch (e) {
    console.error(`[rib-chamber] brief gate state read failed: ${errText(e)}`);
    return;
  }
  const delta = diffAgainstWatermark(state, watermark);

  // Quiet: nothing new since the watermark. If the footer was showing a promoted
  // brief, lapse it back to the calm board and clear the flag; otherwise this is an
  // idempotent no-op — no publish, no write, and (the headline invariant) NO turn.
  if (!delta.hasSubstance) {
    if (watermark.briefPromoted) {
      try {
        await publisher.publish(quietBriefBoard());
        await writeWatermark({
          ...watermark,
          briefPromoted: false,
          updatedAt: new Date().toISOString(),
        });
        // The just-cleared briefPromoted flips the roster pulse's "For you" back to
        // calm — refresh it so the footer and pulse agree without the 120s cadence.
        void refreshWorkflow?.("chamber-roster")?.catch(() => {});
      } catch (e) {
        console.error(`[rib-chamber] brief quiet republish failed: ${errText(e)}`);
      }
    }
    return;
  }

  // Promote: something new happened. Compose a delta-aware prompt (the brief core
  // plus a "what's new" block built from METADATA only — no transcript text) and run
  // ONE agent turn. On a clean board reply, publish it and advance the watermark to
  // the state we just read; on any failure keep the prior board and do not advance.
  let prompt: string;
  try {
    prompt = await composeBriefPrompt(delta);
  } catch (e) {
    console.error(`[rib-chamber] brief prompt compose failed: ${errText(e)}`);
    return;
  }
  let board: CanvasBoardView;
  try {
    const turn = runTurn({
      prompt,
      allowedTools: [],
      timeoutMs: BRIEF_TURN_TIMEOUT_MS,
      cwd: chamberDataHome(),
      abortSignal: signal,
    });
    try {
      for await (const _chunk of turn.stream) {
        // drained for progress; the result is the source of truth (mirrors room.ts)
      }
    } catch {
      // a stream error surfaces via result.status below
    }
    const result = await turn.result;
    if (result.status !== "ok") {
      console.error(`[rib-chamber] brief turn ${result.status}: ${result.error ?? ""}`);
      return;
    }
    board = expectView(BRIEF_KEY, "board")(parseBoard(result.text)) as CanvasBoardView;
  } catch (e) {
    // Parse/validate/turn failure — fail closed: keep the prior board, don't advance.
    console.error(`[rib-chamber] brief turn failed: ${errText(e)}`);
    return;
  }
  // Shutdown landed during the (paid) turn — drop the late result so nothing is
  // published or written after the rib is disposed (mirrors room.ts runOneTurn).
  if (signal.aborted) return;
  try {
    await publisher.publish(board);
    await writeWatermark({
      ackedEndedRooms: state.endedRoomSlugs,
      lensFingerprints: state.lensFingerprints,
      briefPromoted: true,
      updatedAt: new Date().toISOString(),
    });
    // The just-set briefPromoted flips the roster pulse's "For you" to the waiting
    // briefing — refresh it so the footer and pulse agree without the 120s cadence.
    void refreshWorkflow?.("chamber-roster")?.catch(() => {});
  } catch (e) {
    // Published the board but the watermark write failed: the board is live, but a
    // later trigger may re-promote. Logged; never thrown into a fire-and-forget hook.
    console.error(`[rib-chamber] brief watermark advance failed: ${errText(e)}`);
  }
}

// Parse an agent's reply text into a candidate board object. The turn is JSON-only
// (the prompt asks for one object), but a live model commonly wraps it in a ```json
// fence or prefixes a sentence of prose — so strip a surrounding fence, then fall
// back to the first balanced {…}, before giving up. A throw still means no JSON
// object was recoverable; the caller treats that as fail-closed (prior board kept).
function parseBoard(text: string): unknown {
  const unfenced = stripCodeFence(text.trim());
  try {
    return JSON.parse(unfenced);
  } catch (err) {
    const candidate = firstJsonObject(unfenced);
    if (candidate !== null && candidate !== unfenced) return JSON.parse(candidate);
    throw err;
  }
}

// Strip a single surrounding markdown code fence (```json … ``` or ``` … ```);
// returns the inner content, or the input unchanged when it isn't fenced.
function stripCodeFence(s: string): string {
  const m = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(s);
  return m?.[1]?.trim() ?? s;
}

// Recover the first complete JSON object embedded in `text` (e.g. after a leading
// sentence of prose). Tracks string/escape state so a brace inside a string value
// can't close the object early. Returns the substring, or null when none balances.
function firstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
    } else if (ch === "\\") {
      escaped = true;
    } else if (ch === '"') {
      inString = !inString;
    } else if (!inString) {
      if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

// The promote prompt: the standing brief core plus a delta block naming what changed
// since the last briefing — ended rooms by name/status/turns and changed/new lenses
// by id + scope/reason. METADATA ONLY (no transcript text) so a briefing never reads
// a room's content. Reads the rooms/lenses once on the promote path (rare, and a paid
// turn is about to run anyway) to resolve the slugs/ids the delta carries to metadata.
async function composeBriefPrompt(delta: ChamberDelta): Promise<string> {
  const lines: string[] = [];
  if (delta.newlyEndedRooms.length > 0) {
    const rooms = await listRooms(roomsDir());
    const bySlug = new Map(rooms.map((r) => [r.slug, r]));
    lines.push("Rooms that ended since the last briefing:");
    for (const slug of delta.newlyEndedRooms) {
      const room = bySlug.get(slug);
      if (!room) continue;
      lines.push(`  - ${room.name} (${room.status}, ${room.turnIndex} turns)`);
    }
  }
  if (delta.changedOrNewLenses.length > 0) {
    const lenses = await listLenses(lensesDir());
    const byId = new Map(lenses.map((l) => [l.id, l]));
    lines.push("Lenses authored or updated since the last briefing:");
    for (const id of delta.changedOrNewLenses) {
      const lens = byId.get(id);
      const detail = lens
        ? [lens.scope, lens.reason].filter((s): s is string => Boolean(s)).join(" — ")
        : "";
      lines.push(`  - ${id}${detail ? ` (${detail})` : ""}`);
    }
  }
  if (lines.length === 0) return BRIEF_PROMPT;
  return `${BRIEF_PROMPT}

What's new since the last briefing — lead the briefing with these, honestly (do NOT invent detail beyond what is listed):
${lines.join("\n")}`;
}

// Boot reconciliation: the footer is re-seeded with the quiet board on every
// registerTools, so a persisted briefPromoted:true must be cleared or the roster
// pulse ("For you") would advertise a waiting briefing the quiet footer doesn't have.
// Preserves the acks (a real promote still needs fresh substance to fire). Fail-soft:
// a missing/unpromoted watermark is a no-op, and any error is swallowed at boot.
async function clearPersistedBriefPromoted(): Promise<void> {
  try {
    const wm = await readWatermark();
    if (!wm.briefPromoted) return;
    await writeWatermark({ ...wm, briefPromoted: false, updatedAt: new Date().toISOString() });
  } catch (e) {
    console.error(`[rib-chamber] brief watermark boot reset failed: ${errText(e)}`);
  }
}

// The reflection turn's budget. One composing turn (no tools), so a modest ceiling
// bounds a wedged provider without starving a normal reflection.
const REFLECTION_TURN_TIMEOUT_MS = 60_000;
// The cap on a reflection's log line, mirrored from the prompt — a journal entry is
// one short line, not a paragraph.
const REFLECTION_LOG_CAP = 200;

const reflectionReplySchema = z.object({
  memory: z.string(),
  log: z.string(),
});

// The reflection doctrine. A Mind, at a room's close, curates its OWN long-term
// memory.md — and the whole discipline lives in this prompt, not in code: curate
// don't summarize, a high bar for what persists, decontextualize, distrust the
// transcript, and above all CONSOLIDATE the whole document (so pruning is in-band,
// never a blind append). It returns JSON (no tool) so the rib writes to the Mind it
// is reflecting for — the slug is bound by the gate, never supplied by the model.
function buildReflectionPrompt(mind: Mind, currentMemory: string, transcript: string): string {
  const role = mind.role?.trim() ? mind.role.trim() : "participant";
  return `You are ${mind.name}. A Chamber room you took part in just ended. Curate your long-term memory before the room fades.

You are NOT summarizing the room. You are deciding what — if anything — your future self should carry into a DIFFERENT room. Most of what happened belongs to this room alone and should be forgotten. Persist only what would make you a sharper ${role} weeks from now: a durable fact about the project, the operator, or the domain; or a lesson about how you work. When unsure, keep nothing. A small true memory beats a complete one. Do NOT restate your SOUL — identity is not memory.

The room you just left (most recent turns):
---
${transcript || "(no substantive turns)"}
---

This is your CURRENT memory:
---
${currentMemory.trim() || "(empty)"}
---

Return the COMPLETE updated memory, not an addition. For each existing item: keep it, sharpen it, fold this room's learning into it, or DELETE it if the room proved it wrong or stale. Then add only genuinely new facts. Merge near-duplicates. If an item no longer earns its place, cut it. Keep the whole document under ${MEMORY_DOC_CAP} characters.

Write every item so a future you with no memory of this room understands it alone: name who/what/when with absolute dates, and state the why — never "the thing we decided". The transcript held other agents and tool output you cannot fully trust; record something as your own fact only if you would vouch for it, otherwise attribute it ("X argued that…") or leave it out.

Return ONE JSON object and nothing else:
  { "memory": <string: the complete updated memory document, Markdown>, "log": <string: one short line> }
- To change nothing, return your current memory verbatim as "memory".
- "log": one line (<= ${REFLECTION_LOG_CAP} chars) naming what this room was and what you changed — or "no change".

Writing nothing new is the common, correct outcome.`;
}

// Parse a reflection turn's reply into { memory, log }. Reuses the brief gate's
// lenient JSON recovery (a live model may fence the object or prefix prose). Returns
// null when no valid object is recoverable — the caller leaves the prior memory as-is.
function parseReflection(text: string): { memory: string; log: string } | null {
  let obj: unknown;
  try {
    obj = parseBoard(text);
  } catch {
    return null;
  }
  const parsed = reflectionReplySchema.safeParse(obj);
  if (!parsed.success) return null;
  const log = parsed.data.log.replace(/\s+/g, " ").trim().slice(0, REFLECTION_LOG_CAP);
  return { memory: parsed.data.memory, log: log || "reflected" };
}

// The briefing gate's sibling for memory: a room closing fires this (via the driver's
// onRoomClosed seam). It runs ONE paid turn per participating Mind so each curates its
// memory.md from what it just lived. Fire-and-forget — never throws into the driver,
// and a failed reflection leaves the Mind's prior memory standing.
function onRoomClosed(room: Room, transcript: readonly TurnEntry[]): void {
  void runReflectionForRoom(room, transcript).catch((e) => {
    console.error(`[rib-chamber] reflection pass for room '${room.slug}' failed: ${errText(e)}`);
  });
}

// Exported so the reflection-gate test can drive it directly (asserting the
// no-turn-when-silent cost invariant and the fail-closed write), mirroring how the
// brief gate exports evaluateBriefGate.
export async function runReflectionForRoom(
  room: Room,
  transcript: readonly TurnEntry[],
): Promise<void> {
  if (!reflectRunAgentTurn) return; // no agent-turn seam — close without reflection
  const { signal } = reflectAbort;
  if (signal.aborted) return;
  // The deterministic, free cost guard: a Mind reflects only if it spoke at least one
  // substantive, non-aborted turn. A silent participant (and a room nobody spoke in)
  // learned nothing, so it spends no turn — the headline cost invariant.
  //
  // Reflect for every agent-speaker the room KNOWS, not just its participants: a
  // facilitator Mind (a group-chat moderator/synthesizer or a magentic manager) lives
  // in room.config, not room.participants, yet authors `role: "agent"` turns — so it
  // must reflect on a room it actually shaped. Bound to the room's configured Minds so
  // a stray entry can't summon a reflection; the roster lookup below skips a since-
  // retired one. Only buildAgentEntry emits `role: "agent"`, always keyed by a Mind
  // slug, so `spoke` holds Mind slugs alone (never a director/system authority).
  const known = new Set(
    [
      ...room.participants,
      room.config?.moderator,
      room.config?.synthesizer,
      room.config?.manager,
    ].filter((slug): slug is string => Boolean(slug)),
  );
  const spoke = new Set(
    transcript
      .filter(
        (e) => e.role === "agent" && !e.aborted && e.parts.some((p) => p.text.trim().length > 0),
      )
      .map((e) => e.from),
  );
  const reflectors = [...spoke].filter((slug) => known.has(slug));
  if (reflectors.length === 0) return;
  const roster = await resolveMinds();
  // renderTranscript windows to the last N turns, strips routing/control JSON, and
  // marks omissions — the same clean view a Mind sees while speaking in the room.
  const transcriptText = renderTranscript(transcript);
  // Sequential, not parallel: at most one reflection turn in flight per closing room,
  // so a wide room doesn't fan out a burst of paid turns.
  for (const slug of reflectors) {
    if (signal.aborted) return;
    const mind = roster.find((m) => m.slug === slug);
    if (!mind) continue; // retired between speaking and the close
    await reflectOneMind(mind, transcriptText, signal);
  }
}

async function reflectOneMind(
  mind: Mind,
  transcriptText: string,
  signal: AbortSignal,
): Promise<void> {
  if (!reflectRunAgentTurn || signal.aborted) return;
  // Serialize the WHOLE read -> turn -> write per Mind so two concurrent room closes
  // that share it consolidate on each other's result instead of lose-updating: the
  // second reflection reads memory.md only AFTER the first has written it. Chained on
  // reflectWrites (reset on dispose); the chain swallows errors so one failed
  // reflection can't wedge the Mind's next one, and the room's loop keeps going.
  const prev = reflectWrites.get(mind.slug) ?? Promise.resolve();
  const next = prev.then(() => reflectAndPersist(mind, transcriptText, signal));
  reflectWrites.set(
    mind.slug,
    next.catch((e) => {
      console.error(`[rib-chamber] reflection for '${mind.slug}' failed: ${errText(e)}`);
    }),
  );
  await reflectWrites.get(mind.slug);
}

// Read the Mind's current memory, run its (paid) reflection turn, and persist the
// consolidated result — the body the per-Mind chain serializes. The memory.md read
// is HERE, inside the chain, so the consolidation is over the latest memory rather
// than a snapshot taken before an earlier reflection's write landed.
async function reflectAndPersist(
  mind: Mind,
  transcriptText: string,
  signal: AbortSignal,
): Promise<void> {
  const run = reflectRunAgentTurn;
  if (!run || signal.aborted) return;
  const currentMemory = (await readMindDoc(mindsDir(), mind.slug, "memory.md")) ?? "";
  const prompt = buildReflectionPrompt(mind, currentMemory, transcriptText);
  const system = (await readSoul(mindsDir(), mind.slug))?.trim() || mind.persona;

  let replyText: string;
  try {
    const turn = run({
      system,
      prompt,
      allowedTools: [],
      timeoutMs: REFLECTION_TURN_TIMEOUT_MS,
      cwd: chamberDataHome(),
      abortSignal: signal,
      ...(mind.model ? { model: mind.model } : {}),
      ...(mind.provider ? { provider: mind.provider } : {}),
    });
    try {
      for await (const _chunk of turn.stream) {
        // drained for progress; the result is the source of truth (mirrors room.ts)
      }
    } catch {
      // a stream error surfaces via result.status below
    }
    const result = await turn.result;
    if (result.status !== "ok") {
      console.error(
        `[rib-chamber] reflection turn for '${mind.slug}' ${result.status}: ${result.error ?? ""}`,
      );
      return;
    }
    replyText = result.text;
  } catch (e) {
    console.error(`[rib-chamber] reflection turn for '${mind.slug}' failed: ${errText(e)}`);
    return;
  }
  // Shutdown landed during the (paid) turn — drop the late write (mirrors the brief gate).
  if (signal.aborted) return;
  const parsed = parseReflection(replyText);
  if (!parsed) {
    console.error(
      `[rib-chamber] reflection for '${mind.slug}': unparseable reply, memory unchanged`,
    );
    return;
  }
  // An empty memory would WIPE the Mind's accumulated memory. A model that means "no
  // change" is told to echo its current memory back, so treat an empty document as a
  // keep-prior no-op rather than persisting the blank — a bad turn must not erase a
  // Mind's hard-won memory.
  if (!parsed.memory.trim()) {
    console.error(
      `[rib-chamber] reflection for '${mind.slug}': empty memory returned, keeping prior`,
    );
    return;
  }
  await writeMemory(mindsDir(), mind.slug, parsed.memory);
  await appendLog(mindsDir(), mind.slug, parsed.log, new Date().toISOString());
}

// The most-recently-started active room, or undefined when none is active. Set
// iteration is insertion-ordered, so the last entry is the newest active room.
function mostRecentActiveSlug(): string | undefined {
  return [...activeRooms].at(-1);
}

// Resolve the room a say/stop targets: an explicit (active) slug, else the most-
// recent active room. Returns an error when the named room isn't active or none is —
// so a steer never silently targets a finished or wrong room.
function resolveSteerTarget(roomArg?: string): { slug: string } | { error: string } {
  const explicit = (roomArg ?? "").trim();
  if (explicit) {
    if (!isSafeSlug(explicit)) return { error: `unsafe room slug: ${JSON.stringify(explicit)}` };
    if (!activeRooms.has(explicit)) {
      return { error: `Chamber room "${explicit}" is not active — check chamber_room_status.` };
    }
    return { slug: explicit };
  }
  const slug = mostRecentActiveSlug();
  if (!slug) return { error: "No active Chamber room. Start one with chamber_room_start." };
  return { slug };
}

// A say/stop reply names which room it hit when several are active (the default
// target is otherwise implicit); with one room the slug is just noise. One helper so
// say and stop can't drift on the threshold or the format.
function roomNote(slug: string): string {
  return activeRooms.size > 1 ? ` (${slug})` : "";
}

// Absolute path to the roster collector, resolved at module load so the workflow
// node runs the right file regardless of the run's (nominal) cwd. fileURLToPath
// (not URL.pathname) decodes %20 etc. so an install path with a space resolves;
// it is shell-quoted where interpolated into the bash node below.
const ROSTER_COLLECTOR = fileURLToPath(new URL("../bin/collect-roster.ts", import.meta.url));
// The rooms-index collector, resolved the same way (see ROSTER_COLLECTOR).
const ROOMS_COLLECTOR = fileURLToPath(new URL("../bin/collect-rooms.ts", import.meta.url));
// The lenses-index collector, resolved the same way (see ROSTER_COLLECTOR).
const LENSES_COLLECTOR = fileURLToPath(new URL("../bin/collect-lenses.ts", import.meta.url));
// The activity collector, resolved the same way (see ROSTER_COLLECTOR). It reads
// all three stores, so the bash node bakes in the data home (not a single store dir).
const ACTIVITY_COLLECTOR = fileURLToPath(new URL("../bin/collect-activity.ts", import.meta.url));
// The standing-digest collectors, resolved the same way (see ROSTER_COLLECTOR). The
// gate reads all three stores + the digest, so it bakes in the data home (not a single
// store dir); the publish collector reads the digest store from the same home.
const DIGEST_GATE_COLLECTOR = fileURLToPath(
  new URL("../bin/collect-digest-gate.ts", import.meta.url),
);
const DIGEST_PUBLISH_COLLECTOR = fileURLToPath(
  new URL("../bin/collect-digest-publish.ts", import.meta.url),
);

// POSIX single-quote: wrap a value and escape any embedded quote so a path
// (spaces, `$`, backticks, backslashes) reaches `bash -c` literally — never
// word-split or expanded.
function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// The quiet board the footer holds whenever nothing new has happened since the last
// briefing — seeded at boot (so the footer never shows the idle "Load" state) and
// republished when a promoted brief lapses back to quiet. A valid, calm board, not a
// paid turn: the cost-safety invariant is that the quiet path authors nothing.
function quietBriefBoard(): CanvasBoardView {
  return {
    view: "board",
    title: "Briefing",
    header: { status: { label: "Quiet", tone: "neutral" } },
    sections: [
      {
        kind: "rows",
        items: [
          {
            text: "Nothing to brief yet — the briefing fills in when a room ends or a lens changes.",
            glyph: "neutral",
          },
        ],
      },
    ],
  };
}

// The brief turn's budget. A briefing is a single composing turn (no tools), so a
// modest ceiling bounds a wedged provider without starving a normal compose.
const BRIEF_TURN_TIMEOUT_MS = 60_000;

// The briefing turn's prompt: an agent authors a canvas `board` rendered on the
// Chamber surface with no hand-coded UI. The gate appends a delta block (the rooms
// that ended / lenses that changed since the last briefing) so the briefing reports
// what is NEW, not just what Chamber is. Tools are withheld so it composes from this.
const BRIEF_PROMPT = `You are the editor of "Chamber" — Keelson's multi-agent operating layer (genesis agents, agent-to-agent rooms, agent-authored lenses). Compose a one-screen operator BRIEFING and return it as a single canvas \`board\` view.

This is a live demonstration that an agent can author its own lens: your JSON is validated fail-closed and rendered directly on the Chamber surface, with no hand-coded UI. Do NOT invent clusters, users, or external metrics you cannot see — write an honest briefing about Chamber: what it is, what is live, and what is next.

Return ONE JSON object of this shape:
  { "view": "board", "title": string, "header"?: { "status"?: { "label": string, "tone"?: Tone } }, "sections": Section[] }
Tone is one of: ok, warn, error, neutral, info, caution, brand, accent.
Use 3-4 Section kinds, in a sensible order:
  - stats:    { "kind": "stats", "title"?: string, "items": [{ "label": string, "value": string|number, "sub"?: string, "tone"?: Tone }] }
  - segments: { "kind": "segments", "title"?: string, "items": [{ "label": string, "n": number, "tone"?: Tone }] }
  - rows:     { "kind": "rows", "title"?: string, "items": [{ "text": string, "glyph"?: Tone, "trailing"?: string }] }
  - cards:    { "kind": "cards", "title"?: string, "items": [{ "title": string, "pill"?: { "label": string, "tone"?: Tone }, "fields"?: [{ "label"?: string, "value": string|number }], "footnote"?: string }] }

Keep it tight: a status pill, ~3 KPI stats, a 3-5 item "rows" list (what's live / what's next), and 2-3 explanatory cards. Concise, editorial copy.

Example — copy this structure exactly, replace the content:
{ "view":"board","title":"Chamber Briefing","header":{"status":{"label":"Phase 0 · lens proof","tone":"brand"}},"sections":[{"kind":"stats","title":"Pulse","items":[{"label":"Minds","value":0,"sub":"genesis lands Phase 1","tone":"neutral"},{"label":"Rooms","value":0,"sub":"Phase 2","tone":"neutral"},{"label":"Lenses","value":1,"sub":"this briefing","tone":"ok"}]},{"kind":"rows","title":"Status","items":[{"text":"Agent-authored briefing lens","glyph":"ok","trailing":"live"},{"text":"Genesis + roster","glyph":"info","trailing":"next"},{"text":"Two-agent room","glyph":"neutral","trailing":"Phase 2"}]},{"kind":"cards","title":"What this proves","items":[{"title":"An agent authored this view","pill":{"label":"lens","tone":"brand"},"fields":[{"label":"key","value":"rib:chamber:brief"}],"footnote":"No hand-coded UI — the board came from an agent turn through Keelson's canvas."}]}] }`;

// Genesis as a workflow: one agent turn reads a freeform brief, authors the SOUL.md
// body + a roster tagline, and persists the Mind by calling the chamber_emit_genesis
// tool (the deterministic write seam). It publishes no snapshot — its product is files
// on disk, which the chamber-roster collector then reflects. $ARGUMENTS carries the
// brief (chat `/workflow run chamber-genesis <brief>`); explicit $inputs.* are honored
// when a caller supplies them (CLI --inputs). The model is scoped to the one emit tool.
const GENESIS_WF_PROMPT = `You are authoring the founding identity of a new persistent agent — a "Mind" — for Keelson's Chamber, a multi-agent operating layer.

Brief: $ARGUMENTS

(If these explicit fields are non-empty, prefer them over the brief — name: "$inputs.name", role: "$inputs.role", voice: "$inputs.voice", model: "$inputs.model", provider: "$inputs.provider". When model/provider are non-empty, pass them through verbatim — do not author or guess them.)

From the brief, decide the Mind's name, a short role title (1-4 words — e.g. "Chief of Staff", "Research Partner" — a label for a roster pill, NOT a sentence or description), and voice (how it speaks). Then write an honest founding document — do NOT invent tools, credentials, or capabilities it does not have; describe who it is, what it is for, and how it speaks.

Compose:
- soul: Markdown for the Mind's SOUL.md, with these sections in order:
    # <name>
    ## Persona  — who this Mind is, grounded in the role
    ## Mission  — what it exists to do
    ## Voice    — how it speaks (tone, length, habits)
- tagline: one line, at most 120 characters, summarizing the Mind for a roster card (no Markdown).
- tools: an OPTIONAL array of capability slugs the Mind may use inside a room — choose ONLY from this set: ${capabilityVocabulary()}. Include a slug only when the role genuinely calls for it; omit it (or use []) for a conversation-only Mind, and never invent a slug outside this set.

Then call the chamber_emit_genesis tool EXACTLY ONCE with { name, role, voice, soul, tagline, tools, model?, provider? } to persist the Mind (include model/provider only when provided) — do NOT print the JSON as your reply. After the tool returns, reply with EXACTLY one line: "Authored <name> (<slug>)", using the name you authored and the tool-returned slug verbatim.`;

// The lens authoring prompt: one agent turn composes a canvas board on a subject and
// calls chamber_emit_lens to publish it. It is not pinned to one key — the tool routes
// by `id` to a per-subject key, so distinct subjects land in distinct panels and
// re-authoring a subject updates it.
const LENS_WF_PROMPT = `You are authoring a LENS for Keelson's Chamber — a one-screen canvas \`board\` view on a subject, rendered live on the Chamber surface with no hand-coded UI.

Subject: $ARGUMENTS

Compose ONE canvas board about the subject. Be honest — do NOT invent data you cannot see; if the subject is abstract, lay out its structure, parts, or status rather than fabricating metrics.

The board shape:
  { "view": "board", "title": string, "header"?: { "status"?: { "label": string, "tone"?: Tone } }, "sections": Section[] }
Tone is one of: ok, warn, error, neutral, info, caution, brand, accent.
Use 2-4 Section kinds, in a sensible order:
  - stats: { "kind":"stats", "title"?:string, "items":[{ "label":string, "value":string|number, "sub"?:string, "tone"?:Tone }] }
  - rows:  { "kind":"rows", "title"?:string, "items":[{ "text":string, "glyph"?:Tone, "trailing"?:string }] }
  - cards: { "kind":"cards", "title"?:string, "items":[{ "title":string, "pill"?:{ "label":string, "tone"?:Tone }, "fields"?:[{ "label"?:string, "value":string|number }], "footnote"?:string }] }

Then call the chamber_emit_lens tool EXACTLY ONCE with { id, board, scope?, reason? }:
  - id: a short, stable, kebab-case identifier for this subject (e.g. "release-risks") — re-authoring the same subject reuses its panel.
  - board: the canvas board object above.
  - scope (optional): the board's kind in a word or two — e.g. "status board", "timeline", "checklist".
  - reason (optional): a short note on what this authoring changed (e.g. "added two new risks") — omit it on a first author.
Supply scope/reason only when you can name them truthfully; never invent provenance. Do NOT print the JSON as your reply. After the tool returns, reply with one short line naming the lens you authored.`;

// The standing-digest authoring prompt: one agent turn synthesizes the Chamber's
// current shape into a canvas board and calls chamber_emit_digest to persist it. No
// $ARGUMENTS — the digest is scheduler-driven, so the gate hands it the live state via
// $gate.output.summary. Distinct from the Briefing (the delta footer): this is a
// standing synthesis of what IS, not what just changed.
const DIGEST_WF_PROMPT = `You are authoring the standing DIGEST for Keelson's Chamber — a multi-agent operating layer (genesis agents, agent-to-agent rooms, agent-authored lenses). The digest is a one-screen canvas \`board\` view that gives an operator the current shape of the Chamber at a glance, rendered live on the Chamber surface with no hand-coded UI. It re-composes only when the Chamber changes, so write an honest synthesis of the state below — NOT a changelog of what just happened (the Briefing footer covers deltas).

Current Chamber state:
$gate.output.summary

Compose ONE canvas board synthesizing this state — what exists, what is active, what it adds up to. Be honest: name only what is in the state above; do NOT invent Minds, rooms, lenses, users, or metrics you cannot see. If the Chamber is sparse, say so plainly rather than padding.

The board shape:
  { "view": "board", "title": string, "header"?: { "status"?: { "label": string, "tone"?: Tone } }, "sections": Section[] }
Tone is one of: ok, warn, error, neutral, info, caution, brand, accent.
Use 2-4 Section kinds, in a sensible order:
  - stats: { "kind":"stats", "title"?:string, "items":[{ "label":string, "value":string|number, "sub"?:string, "tone"?:Tone }] }
  - rows:  { "kind":"rows", "title"?:string, "items":[{ "text":string, "glyph"?:Tone, "trailing"?:string }] }
  - cards: { "kind":"cards", "title"?:string, "items":[{ "title":string, "pill"?:{ "label":string, "tone"?:Tone }, "fields"?:[{ "label"?:string, "value":string|number }], "footnote"?:string }] }

Then call the chamber_emit_digest tool EXACTLY ONCE with { board }: the canvas board object above. Do NOT print the JSON as your reply. After the tool returns, reply with one short line naming the digest you authored.`;

// The rib's slash commands for the harness command registry (GET /api/commands).
// /mind opens a Mind as a seeded chat; /genesis authors a new Mind from a brief.
// All chamber vocabulary lives here — the harness knows only "a rib offered a
// command" and performs the closed effect the invoke returns.
const CHAMBER_COMMANDS: readonly RibCommandDescriptor[] = [
  {
    name: "mind",
    description: "Open a Mind as a seeded chat",
    argument: { hint: "<slug>", completes: true },
  },
  {
    name: "genesis",
    description: "Author a new Mind from a freeform brief",
    argument: { hint: "<brief>" },
  },
  {
    name: "lens",
    description: "Author a lens — a canvas board on a subject",
    argument: { hint: "<subject>" },
  },
];

// Slug type-ahead for /mind — the Minds on the roster, filtered by prefix.
async function completeChamberCommand(
  name: string,
  prefix: string,
): Promise<readonly CommandCompletion[]> {
  if (name !== "mind") return [];
  return (await listAgents())
    .filter((a) => a.slug.startsWith(prefix))
    .map((a) => ({ value: a.slug, description: a.description }));
}

// The message effect's text is capped by the shared commandEffectSchema (8000);
// keep the inline list under it so a large roster can't 500 the invoke route.
const MESSAGE_TEXT_BUDGET = 7000;
function boundedLines(header: string, rows: readonly string[]): string {
  const out = [header];
  let used = header.length;
  let shown = 0;
  for (const row of rows) {
    if (used + 1 + row.length > MESSAGE_TEXT_BUDGET) break;
    out.push(row);
    used += 1 + row.length;
    shown += 1;
  }
  if (shown < rows.length) out.push(`  …and ${rows.length - shown} more (type a slug to filter)`);
  return out.join("\n");
}

// Run a chamber command server-side and return the closed effect the surface
// performs. /mind resolves to an open-agent effect (the surface resolves the seed
// through the agents seam), or an inline list when called with no slug; /genesis
// to a run-workflow effect (chamber-genesis, brief as $ARGUMENTS).
async function invokeChamberCommand(name: string, arg: string): Promise<CommandInvokeResult> {
  const value = arg.trim();
  if (name === "mind") {
    const agents = await listAgents();
    if (agents.length === 0) {
      return {
        ok: true,
        effect: {
          effect: "message",
          text: "No Minds yet — author one with /genesis <brief>.",
        },
      };
    }
    if (value.length === 0) {
      const rows = agents.map((a) =>
        a.description ? `  ${a.slug} — ${a.description}` : `  ${a.slug}`,
      );
      return {
        ok: true,
        effect: { effect: "message", text: boundedLines("Minds:", rows) },
      };
    }
    if (!agents.some((a) => a.slug === value)) {
      return { ok: false, error: `No Mind "${value}".` };
    }
    return { ok: true, effect: { effect: "open-agent", ribId: "chamber", slug: value } };
  }
  if (name === "genesis") {
    if (value.length === 0) {
      return { ok: false, error: "usage: /genesis <brief> — describe the agent to author" };
    }
    return {
      ok: true,
      effect: { effect: "run-workflow", workflow: "chamber-genesis", args: value },
    };
  }
  if (name === "lens") {
    if (value.length === 0) {
      return { ok: false, error: "usage: /lens <subject> — describe the lens to author" };
    }
    return {
      ok: true,
      effect: { effect: "run-workflow", workflow: "chamber-lens", args: value },
    };
  }
  return { ok: false, error: `unknown command: ${name}` };
}

// The only chamber verbs an untrusted HTML-lens iframe may reach (origin
// "canvas-html"): a no-op ack (`lens-html`) and read-only navigation to a lens
// panel (`lens-open`). Everything destructive or paid stays off this list, so a
// prompt-injected lens can't drive retire / room-* / set-model / convene. See #124.
const FRAME_SAFE_ACTIONS: ReadonlySet<string> = new Set(["lens-html", "lens-open"]);

const rib: Rib = {
  id: "chamber",
  displayName: "Chamber",

  // Binds the agent-authored keys to the canvas renderer; data arrives when the
  // producers (the roster collector, the brief turn, the room driver) run.
  views: [
    { key: ROSTER_KEY, canvasKind: "view", title: "Roster" },
    { key: ROOMS_KEY, canvasKind: "view", title: "Rooms" },
    { key: LENSES_KEY, canvasKind: "view", title: "Lenses" },
    { key: ACTIVITY_KEY, canvasKind: "view", title: "Activity" },
    { key: DIGEST_KEY, canvasKind: "view", title: "Digest" },
    { key: HTML_LENS_KEY, canvasKind: "html", title: "HTML Lens" },
    { key: BRIEF_KEY, canvasKind: "view", title: "Briefing" },
  ],

  // No static actions[]: a payload-less button can't carry input, so every Chamber
  // control lives where its context is. Genesis is the chamber-genesis workflow (it
  // needs a freeform brief); retire and the room controls (start/inject/stop) are
  // payload-carrying board actions (the OSDU pattern) that reach onAction below.

  // The Chamber nav tab. The roster sits in the header (the Minds you genesis), the
  // standing row pairs the sessions index (ended rooms) with the lenses index (the
  // living views), and the brief settles into the footer. The live room panels and
  // lens panels are push-fed dynamic regions a producer registers at runtime — each
  // ACTIVE room registers its own per-slug region (group "rooms") on start via
  // room-region-registry, and a Mind authors lenses (chamber_emit_lens, group "lens"),
  // all through registerRegion. The rooms index is the history of CLOSED rooms (an
  // active room shows as its live inline panel); the lenses index sits alongside each
  // lens's own live panel, with Open focusing it.
  surfaces: [
    {
      id: CHAMBER_SURFACE_ID,
      title: "Chamber",
      subtitle: "Author Minds · convene Rooms · keep Lenses · read the Briefing",
      layout: {
        header: {
          key: ROSTER_KEY,
          workflow: "chamber-roster",
          title: "Roster",
          // The roster is a cheap deterministic collector that only changes on
          // genesis/retire; a modest cadence keeps it self-populating on open and
          // fresh after a new Mind without hammering. The Briefing footer is left
          // cadence-free on purpose — it is a paid agent turn, refreshed on demand.
          cadenceMs: 120_000,
          glyph: { char: "◇", tone: "brand" },
        },
        rows: [
          {
            columns: [
              {
                key: ROOMS_KEY,
                workflow: "chamber-rooms",
                title: "Rooms",
                // Like the roster: a cheap deterministic disk read that changes only
                // when a room ends or is deleted; the same modest cadence keeps it
                // self-populating on open, with room-delete refreshing it on demand.
                cadenceMs: 120_000,
                // A long ended-sessions index can collapse to its head strip.
                collapsible: true,
                glyph: { char: "▦", tone: "brand" },
              },
              {
                key: LENSES_KEY,
                workflow: "chamber-lenses",
                title: "Lenses",
                // The living-views index: a cheap deterministic disk read that
                // changes only on author/retire; the same modest cadence self-
                // populates it on open, with author + retire refreshing it on demand.
                cadenceMs: 120_000,
                // A long living-views index can collapse to its head strip.
                collapsible: true,
                glyph: { char: "✦", tone: "accent" },
              },
              {
                key: ACTIVITY_KEY,
                workflow: "chamber-activity",
                title: "Activity",
                // The DETERMINISTIC arm of the standing-lens cost guard: a cheap
                // collector that recomputes the pulse + recent-events feed from disk, so
                // the host scheduler refreshes it on cadence with NO tab open — a disk
                // read, never a paid turn. Its agent-turn counterpart is Digest below.
                cadenceMs: 120_000,
                collapsible: true,
                glyph: { char: "↻", tone: "info" },
              },
              {
                key: DIGEST_KEY,
                workflow: "chamber-digest",
                title: "Digest",
                // The AGENT-TURN arm of the standing-lens cost guard: an agent
                // re-authors this standing board, but only when the Chamber's structural
                // fingerprint advances. The scheduler refreshes it on cadence (a cheap
                // gate + re-publish disk read), yet it spends a turn ONLY on a real
                // change — the Briefing's watermark gate, generalized onto the scheduler.
                cadenceMs: 120_000,
                collapsible: true,
                glyph: { char: "✶", tone: "brand" },
              },
            ],
          },
        ],
        // The Briefing footer has NO `workflow` binding: it is rib-driven, not a
        // cadence/refresh-fed collector. The rib seeds a quiet board at boot and the
        // attention gate (evaluateBriefGate) republishes it — promoting to a paid
        // agent turn only when a room ended or a lens changed since the watermark.
        footer: {
          key: BRIEF_KEY,
          title: "Briefing",
          collapsible: true,
          glyph: { char: "❖", tone: "brand" },
        },
      },
    },
  ],

  // The producer: an agent turn (not a deterministic collector) emits the board,
  // which the executor promotes to structured output and the rib binding
  // publishes fail-closed via `validate`. This is the "an agent authors a lens"
  // proof — zero React, no hand-coded route.
  contributeWorkflows: () => [
    {
      // The roster producer: a deterministic collector that reads the
      // genesis-authored Minds from the data home and emits a board of cards.
      // Genesis mutates the data home via onAction; this refresh reflects it.
      definition: {
        name: "chamber-roster",
        description:
          'Use when: you want to see the agents (Minds) that have been created. Triggers: "show the roster", "list agents", "what minds exist". Does: reads the genesis-authored Minds from the Chamber data home and publishes a roster board (one card per Mind) to the Chamber Roster canvas. NOT for: creating or retiring agents (genesis is the chamber-genesis workflow; retire is a roster board action).',
        nodes: [
          {
            id: "collect",
            // The collector runs out-of-process (a bash node) and can't call
            // ctx.getDataDir, so bake the resolved data home in — captured in
            // registerTools, which runs before this. The collector derives the minds
            // dir, the draft, and the pulse's state dirs + watermark all from it, so
            // both sides read one path (buildChamberState backs the pulse here too).
            bash: `bun ${shQuote(ROSTER_COLLECTOR)} ${shQuote(chamberDataHome())}`,
            output_schema: { type: "object", required: ["view", "sections"] },
          },
        ],
      },
      bindSnapshotKey: ROSTER_KEY,
      validate: expectView(ROSTER_KEY, "board"),
    },
    {
      // The rooms-index producer (the chamber-roster sibling): a deterministic
      // collector that reads the persisted rooms from the data home and emits the
      // sessions index — active rooms first (status-only cards), then ended sessions
      // (each with Open + Delete). A room starting/ending or a room-delete refreshes
      // it; an active room ALSO renders as its own live per-slug panel.
      definition: {
        name: "chamber-rooms",
        description:
          'Use when: you want to see Chamber sessions — active rooms and ended history. Triggers: "show rooms", "list sessions", "room history". Does: reads the persisted rooms from the Chamber data home and publishes a sessions index (active rooms first as status-only cards, then ended rooms each with Open + a Delete control) to the Chamber Rooms canvas. NOT for: starting a room (the Roster\'s Convene) or stopping a live room (its inline controls).',
        nodes: [
          {
            id: "collect",
            // Out-of-process (a bash node), so bake the resolved rooms dir in —
            // captured in registerTools, which runs before this — so both sides
            // read one path (see the roster collector).
            bash: `bun ${shQuote(ROOMS_COLLECTOR)} ${shQuote(roomsDir())}`,
            output_schema: { type: "object", required: ["view", "sections"] },
          },
        ],
      },
      bindSnapshotKey: ROOMS_KEY,
      validate: expectView(ROOMS_KEY, "board"),
    },
    {
      // The lenses-index producer (the chamber-rooms sibling): a deterministic
      // collector that reads the persisted lenses from the data home and emits the
      // living-views index (one card per lens, each with Open + Retire). An author
      // or a retire refreshes it; each lens also renders as its own live per-id
      // panel, so this index sits alongside those, not in place of them.
      definition: {
        name: "chamber-lenses",
        description:
          'Use when: you want a single index of the living lenses Minds have authored. Triggers: "show the lenses", "list lenses", "what lenses exist". Does: reads the persisted lenses from the Chamber data home and publishes a living-views index (one card per lens, each with Open and a Retire control) to the Chamber Lenses canvas. NOT for: authoring a lens (the chamber-lens workflow) or viewing one (each lens has its own live panel; Open focuses it).',
        nodes: [
          {
            id: "collect",
            // Out-of-process (a bash node), so bake the resolved lenses dir in —
            // captured in registerTools, which runs before this — so both sides
            // read one path (see the rooms collector).
            bash: `bun ${shQuote(LENSES_COLLECTOR)} ${shQuote(lensesDir())}`,
            output_schema: { type: "object", required: ["view", "sections"] },
          },
        ],
      },
      bindSnapshotKey: LENSES_KEY,
      validate: expectView(LENSES_KEY, "board"),
    },
    {
      // The activity producer (the chamber-lenses sibling): a deterministic collector
      // that reads ALL THREE Chamber stores from the data home and emits the standing
      // activity board — a cumulative pulse plus a reverse-chron feed of recent
      // genesis / room / lens events. The host scheduler refreshes it on cadence with
      // no tab open (the standing lens); because it is a cheap disk read — never an
      // agent turn — every tick is cost-safe.
      definition: {
        name: "chamber-activity",
        description:
          'Use when: you want a single standing panel of what is happening across the Chamber. Triggers: "show activity", "what is happening", "recent events". Does: reads the Minds, rooms, and lenses from the Chamber data home and publishes a standing activity board (cumulative pulse stats + a recent-events feed) to the Chamber Activity canvas, auto-refreshed on cadence. NOT for: authoring a Mind/room/lens, or the editorial Briefing (the rib-driven footer).',
        nodes: [
          {
            id: "collect",
            // Out-of-process (a bash node), so bake the resolved data home in —
            // captured in registerTools, which runs before this — so both sides read
            // one path (see the roster collector, which also reads all three stores).
            bash: `bun ${shQuote(ACTIVITY_COLLECTOR)} ${shQuote(chamberDataHome())}`,
            output_schema: { type: "object", required: ["view", "sections"] },
          },
        ],
      },
      bindSnapshotKey: ACTIVITY_KEY,
      validate: expectView(ACTIVITY_KEY, "board"),
    },
    {
      // The digest producer (the chamber-activity sibling, agent-turn arm): a
      // SELF-GATING bound workflow that re-authors a standing digest board with an
      // agent turn, but spends that turn only when the Chamber changed. `gate` (a cheap
      // bash read) emits { dirty, summary }; `author` runs ONLY when dirty (its `when:`),
      // composing the board from the gate's summary and persisting it via
      // chamber_emit_digest (which advances the fingerprint); `publish` always runs
      // (trigger_rule all_done) and re-reads the store to drive the key — so the key
      // refreshes every tick (composedAt stays live) while a paid turn fires only on a
      // real change. The host scheduler runs the whole workflow on cadence, no tab open.
      definition: {
        name: "chamber-digest",
        description:
          'Use when: you want a standing, agent-authored synthesis of the Chamber\'s current shape. Triggers: "show the digest", "what is the chamber like now". Does: a gate detects whether the Chamber changed; on a change, one agent turn composes a digest board and persists it; the panel re-publishes from disk each tick. Auto-refreshed on cadence, but spends a turn only when the Chamber changed. NOT for: the deterministic Activity feed, the delta Briefing footer, or authoring a Mind/room/lens.',
        nodes: [
          {
            id: "gate",
            // Out-of-process (a bash node), so bake the resolved data home in —
            // captured in registerTools, which runs before this (see the roster
            // collector). Emits { dirty, summary }; NO output_schema, so it stays text
            // output and never republishes to the key — it only drives `when:` and feeds
            // the author its source via $gate.output.summary.
            bash: `bun ${shQuote(DIGEST_GATE_COLLECTOR)} ${shQuote(chamberDataHome())}`,
          },
          {
            id: "author",
            depends_on: ["gate"],
            // The cost guard: the paid turn runs ONLY when the gate saw a change. A
            // false/absent dirty (a quiet tick, or a failed gate) skips this node — no
            // turn — so a quiet Chamber never spends one.
            when: "$gate.output.dirty == 'true'",
            prompt: DIGEST_WF_PROMPT,
            // chamber_emit_digest validates the board fail-closed; fail_on_tool_error
            // surfaces a bad authoring as a FAILED author node (visible in the run's
            // node rows) rather than a SUCCEEDED turn that wrote nothing. The run itself
            // is not failed — the always-on publish below rescues it (trigger_rule
            // all_done), so a transient bad turn never errors the scheduled run, and the
            // un-advanced fingerprint drives a re-author on the next tick.
            fail_on_tool_error: true,
            // Rib tools are default-off in workflow prompt nodes; opt in to the single
            // write seam by name (and nothing else).
            allowed_tools: [DIGEST_TOOL_NAME],
          },
          {
            id: "publish",
            depends_on: ["author"],
            // all_done, not the default all_success: publish must run whether author ran
            // (dirty), was skipped (quiet), or failed — so the key re-publishes the
            // cached board every tick and self-heals a failed authoring (the fingerprint
            // stays un-advanced, so the next tick re-authors).
            trigger_rule: "all_done",
            bash: `bun ${shQuote(DIGEST_PUBLISH_COLLECTOR)} ${shQuote(chamberDataHome())}`,
            output_schema: { type: "object", required: ["view", "sections"] },
          },
        ],
      },
      bindSnapshotKey: DIGEST_KEY,
      validate: expectView(DIGEST_KEY, "board"),
    },
    {
      // Genesis as a workflow: one prompt turn authors the soul and calls
      // chamber_emit_genesis to persist it. No bindSnapshotKey/validate — genesis
      // writes files (the roster collector reflects them), it does not publish a
      // board. allowed_tools scopes the turn to the single write seam: rib tools are
      // default-off in workflow prompt nodes, so it must opt in by name.
      definition: {
        name: "chamber-genesis",
        description:
          'Use when: create a new agent (Mind). Triggers: "create an agent", "new mind", "/workflow run chamber-genesis <brief>". Does: one agent turn reads a brief, authors a SOUL.md + roster tagline, and persists the Mind via chamber_emit_genesis. NOT for: retiring a Mind or running a room.',
        nodes: [
          {
            id: "genesis",
            prompt: GENESIS_WF_PROMPT,
            // Fail closed: chamber_emit_genesis writes the Mind and fails closed
            // on a slug collision; fail_on_tool_error makes that tool error fail
            // the run instead of reporting SUCCEEDED with no Mind written (#18).
            fail_on_tool_error: true,
            allowed_tools: ["chamber_emit_genesis"],
          },
        ],
      },
    },
    {
      // The lens producer: one agent turn composes a board for the subject and calls
      // chamber_emit_lens to publish it. No bindSnapshotKey — the per-subject key is
      // chosen at run time by the tool, not pinned to one static key.
      definition: {
        name: "chamber-lens",
        description:
          'Use when: have an agent author a one-screen LENS — a custom canvas board on a subject — onto the Chamber surface. Triggers: "author a lens", "show a board on X", "/workflow run chamber-lens <subject>". Does: one agent turn composes a canvas board for the subject and publishes it as its own Chamber lens panel (no hand-coded UI). NOT for: the standing Chamber Briefing (the rib-driven footer), genesis-ing agents, or running a room.',
        nodes: [
          {
            id: "compose",
            prompt: LENS_WF_PROMPT,
            // Fail closed: chamber_emit_lens validates the board and the workflow
            // should fail loudly if the publish errors, not report SUCCEEDED with
            // no lens rendered.
            fail_on_tool_error: true,
            allowed_tools: [LENS_TOOL_NAME],
          },
        ],
      },
    },
  ],

  // Boot-time wiring of the room loop. Builds the driver against the real seams:
  // runAgentTurn (C1) for the turns, the per-slug room region registry as the
  // publisher (each room's board is cached and recomposed under its own
  // rib:chamber:room:<slug> key — a live WS push, no collector), the FS data home as
  // the store, and the roster as the minds resolver. The seams are optional, so the
  // driver stays undefined on a host without them and room actions fail closed.
  registerTools: (ctx: RibContext) => {
    // Capture the data home from the blessed ctx.getDataDir seam once, before any
    // store/driver/region is built from it — and before contributeWorkflows bakes
    // the path into the roster bash node. When the seam is absent (older harness),
    // leave it uncaptured: chamberDataHome() lazily resolves ribDataDir("chamber").
    const dataDir = ctx.getDataDir?.();
    if (dataDir) setChamberDataHome(dataDir);
    // Capture the refresh seam for onAction handlers (room-delete refreshes the
    // sessions index). dispose() clears it so a re-boot recaptures the new ctx's.
    refreshWorkflow = ctx.refreshWorkflow;
    // Capture the host projects lookup so a room can be targeted at a project
    // (per-room turn cwd = project.rootPath). dispose() clears it like the above.
    getProjects = ctx.getProjects;
    // A (re-)boot reopens the gate after any prior dispose: hand the gate a fresh
    // controller so its turns aren't pre-aborted (the prior, aborted one stays bound
    // to any orphaned in-flight turn, keeping that turn gated out).
    briefAbort = new AbortController();
    // Same for the reflection gate: a fresh controller so a re-boot's reflection
    // turns aren't pre-aborted, while any orphaned pre-dispose turn stays gated out.
    reflectAbort = new AbortController();
    // The genesis write seam is always available: genesis is a workflow whose
    // prompt node calls chamber_emit_genesis, and the write needs no room driver.
    // The room-control tools (and the driver) require the C1 agent-turn + snapshot
    // seams, so they only appear when those are present.
    // Pass the refresh seam so a genesis write re-runs the bound chamber-roster
    // collector (republishing the roster), not just the 120s cadence. Optional and
    // fail-soft: undefined on an older harness, where genesis falls back to cadence.
    const genesisTool = makeGenesisTool(ctx.refreshWorkflow);
    // The digest write seam is always available, like genesis: it only writes the
    // digest store (no snapshot/turn seam needed), and the chamber-digest workflow's
    // author node opts in to it by name.
    const digestTool = makeDigestTool();
    // Like genesis and digest, the list and cleanup tools need only the disk paths
    // captured above, so they are always available — independent of the snapshot/turn seams.
    const readTools = [makeListMindsTool(), makeListRoomsTool(), makeListLensesTool()];
    const cleanupTools = [makeRetireMindTool(), makeRoomDeleteTool()];
    const sm = ctx.getSnapshotManager?.();
    const registerRegion = ctx.registerRegion;
    const run = ctx.runAgentTurn;
    // The Briefing footer is rib-driven (no workflow binding): wire its publisher
    // here, gated on the snapshot + agent-turn seams the gate needs to run a turn.
    // Mirrors ensureRoomViewPublisher — a coalescing publisher on BRIEF_KEY, rebound
    // onto a new manager on a re-bootstrap. Seed the cache with the quiet board so the
    // footer renders calm copy immediately (not the idle "Load" state), and capture
    // runAgentTurn so the gate can promote to a paid turn when substance appears.
    if (sm && run && (sm !== briefSm || !briefPublisher)) {
      briefUnregister?.();
      const { publisher, latest } = createCoalescingPublisher(
        () => sm.recompose(BRIEF_KEY),
        quietBriefBoard(),
      );
      briefUnregister = sm.register(BRIEF_KEY, latest, {
        validate: expectView(BRIEF_KEY, "board"),
      });
      briefPublisher = publisher;
      briefSm = sm;
      briefRunAgentTurn = run;
      // Prime BRIEF_KEY so a client subscribing the instant the footer appears reads
      // the seeded quiet board, not a 204 (the GET path doesn't lazy-compose).
      void sm.recompose(BRIEF_KEY);
      // The footer was just re-seeded quiet, but a persisted briefPromoted:true would
      // make the pulse ("For you") read "1 waiting" against this quiet footer until the
      // next event. Clear the flag (preserving the acks) so the two agree from boot.
      // Serialized through briefInFlight so it can't lose-update a concurrent gate
      // promotion's watermark write — both are read-modify-writes of the same file.
      briefInFlight = briefInFlight.then(clearPersistedBriefPromoted, clearPersistedBriefPromoted);
    }
    // Lenses render via the registerRegion seam, so the registry and its emit tool
    // wire up only when BOTH the snapshot manager and registerRegion are present —
    // independent of the room's C1 agent-turn seam (the room tools below additionally
    // require runAgentTurn). Without registerRegion the tool is withheld (fail closed)
    // rather than publishing invisible, unbounded keys that never render. Created once
    // (a module singleton, like the room driver) and reused on a later registerTools so
    // its keys aren't registered twice. If a different manager arrives (a re-bootstrap
    // without an intervening dispose), rebuild against it rather than publishing through
    // the stale manager. Build the replacement BEFORE disposing the old one, so a failed
    // rebuild leaves the existing registry and lensSm consistent.
    const lensStore = createFileLensStore(lensesDir());
    if (!sm || !registerRegion) {
      htmlLensRegistry?.dispose();
      htmlLensRegistry = undefined;
      htmlLensSm = undefined;
      htmlLensRegisterRegion = undefined;
    } else if (
      !htmlLensRegistry ||
      sm !== htmlLensSm ||
      registerRegion !== htmlLensRegisterRegion
    ) {
      const next = createHtmlLensRegistry(sm, registerRegion);
      htmlLensRegistry?.dispose();
      htmlLensRegistry = next;
      htmlLensSm = sm;
      htmlLensRegisterRegion = registerRegion;
    }
    if (sm && registerRegion && sm !== lensSm) {
      const next = createLensRegistry(sm, registerRegion, lensStore);
      lensRegistry?.dispose();
      lensRegistry = next;
      lensSm = sm;
      // Re-register every persisted lens so it survives a restart: each becomes a
      // live region again (its snapshot key present for the index/open path).
      // Fail-soft per entry — one bad lens can't break boot.
      reconcileLensPanels(next);
    }
    const lensTools =
      sm && registerRegion && lensRegistry
        ? [makeLensTool(lensRegistry), makeRetireLensTool(lensStore, lensRegistry)]
        : [];
    const htmlLensTools =
      sm && registerRegion && htmlLensRegistry ? [makeEmitLensHtmlTool(htmlLensRegistry)] : [];
    // The room publisher routes each room's board to a per-slug key + dynamic surface
    // region, so it requires registerRegion. Rebuilt against a new manager on a
    // re-bootstrap, reused otherwise; built before the old one is disposed so a failed
    // rebuild leaves the existing registry and roomSm consistent.
    if (sm && registerRegion && run) {
      let registry = roomRegistry;
      if (!registry || sm !== roomSm) {
        registry = createRoomRegionRegistry(sm, registerRegion);
        roomRegistry?.dispose();
        roomRegistry = registry;
        roomSm = sm;
      }
      const roomStore = createFileRoomStore(roomsDir());
      // Capture the agent-turn seam for the close-only reflection pass (onRoomClosed,
      // below) — the same run this driver uses for room turns.
      reflectRunAgentTurn = run;
      driver = createRoomDriver({
        store: roomStore,
        publisher: registry,
        runAgentTurn: run,
        minds: resolveMinds,
        // Compose each turn's system prompt from the Mind's soul PLUS its durable
        // memory + rules, so a speaker carries what it has learned into the room.
        composeTurnSystem: (mind) => composeRoomSystemPrompt(mindsDir(), mind),
        // Fire the reflection gate when a room closes (gated, fire-and-forget).
        onRoomClosed,
        turnCwd: chamberDataHome(),
        resolveProjectRoot,
        // When the lens seam is wired, let a Mind author a lens mid-room: the C1
        // turn seam resolves this name to the rib's registered chamber_emit_lens
        // def and projects it to the provider. Without it, room turns stay text-only.
        ...(lensRegistry ? { turnTools: [{ name: LENS_TOOL_NAME }] } : {}),
        // The coding pool (host built-ins), always handed over but inert until a
        // room opts in (room.coding) and is confined — the tier is gated per-room.
        codingTools: codingToolPool(),
      });
      queueRoomRetentionSweep();
      // Expose the room controls as chat tools (start / say / stop / status),
      // sharing the same driver + store this hook just built. Returned only when
      // the seams are present (no driver -> no tools), mirroring how the actions
      // fail closed.
      return [
        genesisTool,
        digestTool,
        ...readTools,
        ...cleanupTools,
        ...lensTools,
        ...htmlLensTools,
        ...roomControlTools(roomStore),
      ];
    }
    return [genesisTool, digestTool, ...readTools, ...cleanupTools, ...lensTools, ...htmlLensTools];
  },

  // Retire a Mind (removes it, then refreshes the roster — the OSDU
  // mutate-then-refresh pattern). The room-* controls drive the room loop; the
  // transcript pushes to the canvas as turns land (no refresh needed). Turns
  // advance on their own (the auto-advance loop), so there is no manual step.
  onAction: (action) => {
    // Actions relayed from the sandboxed HTML-lens iframe arrive with origin
    // "canvas-html" (the host stamps it; the frame can't forge it — see #124). That
    // markup is LLM-authored and can auto-fire on load, so gate it to a non-paid,
    // non-destructive subset — never retire / room-* / set-model / convene. Trusted
    // board actions (origin absent) keep the full verb surface below.
    if (action.origin === "canvas-html" && !FRAME_SAFE_ACTIONS.has(action.type)) {
      return { ok: false, error: `'${action.type}' is not permitted from an HTML lens` };
    }
    switch (action.type) {
      case "enter-mind":
        return enterMindAction(action);
      case "author-archetype":
        return authorArchetypeAction(action);
      case "describe-own":
        return describeOwnAction(action);
      case "retire":
        return retireAction(action);
      case "set-model":
        return setModelAction(action);
      case "lens-html":
        return lensHtmlAction(action);
      case "room-start":
        return roomStartAction(action);
      case "draft-set":
        return draftSetAction(action);
      case "convene":
        return conveneAction(action);
      case "room-inject":
        return roomInjectAction(action);
      case "room-stop":
        return roomStopAction(action);
      case "room-delete":
        return roomDeleteAction(action);
      case "room-open":
        return roomOpenAction(action);
      case "retire-lens":
        return retireLensAction(action);
      case "lens-open":
        return lensOpenAction(action);
      case "lens-note":
        return lensNoteAction(action);
      default:
        return { ok: false, error: `unknown action '${action.type}'` };
    }
  },

  // Agents: every Mind is enterable as a keelson agent (GET /api/agents, the /mind
  // command's source). resolveAgent builds the same seed the roster Enter action
  // does (buildSeedFor), so the two entry points can't drift.
  listAgents: () => listAgents(),
  resolveAgent: (slug: string) => resolveAgent(slug),

  // Slash commands: /mind opens a Mind as a seeded chat (resolved through the
  // agents seam via the open-agent effect); /genesis authors a new Mind by running
  // the chamber-genesis workflow with the brief as $ARGUMENTS.
  listCommands: () => CHAMBER_COMMANDS,
  completeCommand: (name, prefix) => completeChamberCommand(name, prefix),
  invokeCommand: (name, arg) => invokeChamberCommand(name, arg),

  // A rib can't introspect provider availability (runAgentTurn resolves one at
  // turn time), so this asserts only the seams + data home; a missing provider
  // surfaces at the first room turn, not here.
  authStatus: async (ctx: RibContext): Promise<RibAuthStatus> => {
    if (!(await isChamberDataHomeWritable())) {
      return {
        authenticated: false,
        statusMessage: `data home not writable: ${chamberDataHome()}`,
      };
    }
    if (!ctx.getSnapshotManager) {
      return { authenticated: false, statusMessage: "snapshot manager not available" };
    }
    if (!ctx.runAgentTurn) {
      return {
        authenticated: false,
        statusMessage: "agent-turn seam not wired (rooms unavailable)",
      };
    }
    if (!ctx.registerRegion) {
      return {
        authenticated: false,
        statusMessage: "region registration not available (rooms & lenses unavailable)",
      };
    }
    return {
      authenticated: true,
      statusMessage: "rooms & lenses wired; provider resolved at turn time",
    };
  },

  // Shutdown: stop the auto-advance loops and abort any in-flight turn so a CLI
  // child can't keep running (or publish) after teardown. driver.dispose() sets
  // the disposal flag the loop observes (so it stops between turns), and the
  // in-flight turn drops its late append/commit instead of writing post-teardown
  // — so a room caught mid-turn is left as-is on disk (status stays "active"; a
  // fresh process re-reads it), not finalized to "stopped". Resets the roster
  // cache too, so a re-boot re-reads minds.
  dispose: async () => {
    loops.clear();
    activeRooms.clear();
    lastSlug = undefined;
    refreshWorkflow = undefined;
    getProjects = undefined;
    briefUnregister?.();
    briefUnregister = undefined;
    briefPublisher = undefined;
    briefSm = undefined;
    briefRunAgentTurn = undefined;
    // Abort the gate's in-flight (paid) turn; its post-turn signal re-check then drops
    // any late publish/write. Reset the serialization chain so a re-bootstrap (or the
    // next test) starts fresh — an aborted turn that ignores the signal must not leave
    // briefInFlight parked on a never-settling promise (that would wedge a later boot).
    briefAbort.abort();
    briefInFlight = Promise.resolve();
    // Abort in-flight reflection and drain its writes so a late memory write can't
    // land after teardown; reset the per-Mind write chains for the next boot.
    reflectRunAgentTurn = undefined;
    reflectAbort.abort();
    await Promise.allSettled([...reflectWrites.values()]);
    reflectWrites.clear();
    invalidateRoster();
    // Drain any in-flight lens write-back before tearing down the registry, so a
    // late load-append-publish can't publish to a disposed registry or interleave
    // with a re-boot's writes.
    await lensWriteInFlight.catch(() => {});
    lensWriteInFlight = Promise.resolve();
    htmlLensRegistry?.dispose();
    htmlLensRegistry = undefined;
    htmlLensSm = undefined;
    htmlLensRegisterRegion = undefined;
    lensRegistry?.dispose();
    lensRegistry = undefined;
    lensSm = undefined;
    roomRegistry?.dispose();
    roomRegistry = undefined;
    roomSm = undefined;
    releaseRoomViews();
    roomViewSm = undefined;
    await driver?.dispose();
  },
};

const ROOM_DISABLED: RibActionResult = {
  ok: false,
  error: "room controls require the C1 agent-turn seam and a snapshot manager",
};

// Drive turns on their own until the room leaves "active" (budget reached, or a
// stop/inject ended it). Detached and idempotent per slug: room-start kicks it,
// the driver's serial gate + generation gating keep one turn at a time, and a
// stop aborts the in-flight turn so step() reports the room is no longer active
// and the loop exits. step() is the sole room.json reader for the drive decision
// (it returns a StepOutcome), so the loop no longer re-reads it. Errors are
// logged, never thrown into the (already-returned) action.
function ensureLoop(slug: string): void {
  if (!driver || driver.isDisposed() || loops.has(slug)) return;
  loops.add(slug);
  const activeDriver = driver;
  void (async () => {
    try {
      while (!activeDriver.isDisposed()) {
        // Stop only when the room left "active" (budget reached, stopped, or
        // superseded). "busy" can't occur here — this loop is the sole stepper
        // and awaits each step fully — so anything but "ended" means keep going.
        if ((await activeDriver.step(slug)) === "ended") break;
      }
    } catch (e) {
      console.error(`[rib-chamber] room loop '${slug}' failed: ${errText(e)}`);
      // The loop died mid-room: the driver still holds this slug as an active
      // room and room.json is still "active". Force-stop so the driver and disk
      // agree with the active-set cleanup below — otherwise the room lingers as a
      // wedged active room nothing ever clears.
      try {
        await activeDriver.stop(slug);
      } catch (stopErr) {
        console.error(`[rib-chamber] failed to stop wedged room '${slug}': ${errText(stopErr)}`);
      }
    } finally {
      loops.delete(slug);
      // The room left "active" — drop it from the active set and reconcile the
      // surface so its panel is released unless it is still the most-recent room.
      activeRooms.delete(slug);
      reconcileRoomPanels();
      queueRoomRetentionSweep();
      // The room just became a closed session — refresh the index so its card
      // appears promptly instead of on the next cadence. Fail-soft, never thrown
      // into the detached loop.
      void refreshWorkflow?.("chamber-rooms")?.catch(() => {});
      // A newly-ended room is briefing substance: evaluate the gate (it runs a turn
      // only if the watermark hasn't seen this room) and refresh the roster so its
      // pulse counts/for-you update promptly. Both fire-and-forget — never thrown.
      void evaluateBriefGate().catch(() => {});
      void refreshWorkflow?.("chamber-roster")?.catch(() => {});
      void refreshStandingPanels();
    }
  })();
}

// Validate + canonicalize room-start inputs, shared by startRoom and the
// chamber_room_start dry-run so the dry-run never advertises a start the real
// path would reject. De-dupes participants and requires at least two DISTINCT
// valid speakers — the tool schema's min(2) counts RAW entries, so ["a","a"]
// would otherwise collapse to a one-Mind room — and that each names a real Mind,
// since the chat tool takes free-form slugs (a typo would otherwise open a room
// that dies on "unknown mind" mid-rotation after burning paid turns).
type StartConfigInput = RoomConfigInput;

// The positive-integer floor for the routing knobs both group-chat and open-floor
// accept. Floored at the shared boundary so every entry point (chat tool, board
// action, a direct API payload) is protected — a 0 minRounds would open the close
// gate immediately, a 0 maxSpeakerRepeats would redirect every pick. Returns an
// error message, or null when the knobs are valid/absent.
function routingKnobError(config: StartConfigInput): string | null {
  if (
    config.minRounds !== undefined &&
    (!Number.isInteger(config.minRounds) || config.minRounds < 1)
  ) {
    return "minRounds must be a positive integer";
  }
  if (
    config.maxSpeakerRepeats !== undefined &&
    (!Number.isInteger(config.maxSpeakerRepeats) || config.maxSpeakerRepeats < 1)
  ) {
    return "maxSpeakerRepeats must be a positive integer";
  }
  return null;
}

async function validateStart(
  participants: readonly string[],
  turnBudget: number,
  strategy: string,
  config: StartConfigInput = {},
  projectId?: string,
  coding?: boolean,
): Promise<
  { ok: true; participants: string[]; config?: RoomConfig } | { ok: false; error: string }
> {
  const deduped = [...new Set(participants)];
  if (deduped.length < 2 || !deduped.every(isValidParticipant)) {
    return {
      ok: false,
      error: "a room needs at least 2 distinct participants (safe Mind slugs, not director/system)",
    };
  }
  if (!Number.isInteger(turnBudget) || turnBudget <= 0 || turnBudget > MAX_ROOM_TURN_BUDGET) {
    return { ok: false, error: `turnBudget must be an integer in 1..${MAX_ROOM_TURN_BUDGET}` };
  }
  // Reject an unknown/unregistered strategy here (the dry-run calls validateStart but
  // not driver.start), so a typo or an unimplemented strategy can't be advertised as
  // startable and then fail in driver.start's getStrategy on the confirmed path.
  try {
    getStrategy(strategy as RoomStrategyName);
  } catch {
    return { ok: false, error: `unknown strategy "${strategy}"` };
  }
  // Fail closed on an unknown projectId (or an absent getProjects seam). Checked
  // here, not in driver.start, so the dry-run — which calls validateStart but not
  // startRoom — never advertises a target the confirm path would reject.
  if (projectId !== undefined && !resolveProjectRoot(projectId)) {
    return {
      ok: false,
      error: `unknown project "${projectId}" — pick a project from the host's project list`,
    };
  }
  // The coding tier is unconfined without a repo to bound it to: a coding room's
  // turns run Bash/Edit/Write confined to the project root (allowedDirectories), so
  // require a project. Checked here, not in the driver, so the dry-run rejects an
  // unbounded coding room before advertising a start the confirm path can't honor.
  if (coding && projectId === undefined) {
    return {
      ok: false,
      error:
        "a coding room must target a project (set `projectId`) — coding tools are confined to the project's repo",
    };
  }
  const minds = await resolveMinds();
  const known = new Set(minds.map((m) => m.slug));
  const missing = deduped.filter((s) => !known.has(s));
  if (missing.length > 0) {
    return {
      ok: false,
      error: `unknown Mind(s): ${missing.join(", ")} — genesis them first or check the roster`,
    };
  }
  // `manager` is a magentic-only role; reject it for any other strategy rather than
  // silently dropping a dead field (the same guard moderator/synthesizer get).
  if (strategy !== "magentic" && config.manager) {
    return {
      ok: false,
      error: `${strategy} has no manager — \`manager\` is only for the magentic strategy`,
    };
  }
  // group-chat needs a moderator Mind that routes but never speaks: it must be a
  // real Mind and NOT in the speaker pool (so isValidNominee rejects nominating it
  // and the board never counts it as a speaker — see docs/design/phase3-rooms.md §1).
  if (strategy === "group-chat") {
    const moderator = config.moderator;
    if (!moderator) {
      return { ok: false, error: "group-chat needs a moderator Mind — set `moderator`" };
    }
    if (!isValidParticipant(moderator)) {
      return { ok: false, error: "moderator must be a safe Mind slug (not director/system)" };
    }
    if (!known.has(moderator)) {
      return {
        ok: false,
        error: `unknown moderator Mind: ${moderator} — genesis it first or check the roster`,
      };
    }
    if (deduped.includes(moderator)) {
      return {
        ok: false,
        error: "the moderator must not also be a participant — it routes, it does not speak",
      };
    }
    if (config.synthesizer) {
      // Same safe/reserved-slug guard as the moderator: a synthesizer authors a
      // role:"agent" turn, so it must never be a reserved authority (director/system).
      if (!isValidParticipant(config.synthesizer)) {
        return { ok: false, error: "synthesizer must be a safe Mind slug (not director/system)" };
      }
      if (!known.has(config.synthesizer)) {
        return { ok: false, error: `unknown synthesizer Mind: ${config.synthesizer}` };
      }
      if (deduped.includes(config.synthesizer)) {
        return {
          ok: false,
          error:
            "the synthesizer must not also be a participant — it writes the closing summary, it does not debate",
        };
      }
      if (config.synthesizer === moderator) {
        return {
          ok: false,
          error: "the synthesizer must not also be the moderator — they are distinct roles",
        };
      }
    }
    const knobError = routingKnobError(config);
    if (knobError) return { ok: false, error: knobError };
    const roomConfig: RoomConfig = {
      moderator,
      ...(config.synthesizer ? { synthesizer: config.synthesizer } : {}),
      ...(typeof config.minRounds === "number" ? { minRounds: config.minRounds } : {}),
      ...(typeof config.maxSpeakerRepeats === "number"
        ? { maxSpeakerRepeats: config.maxSpeakerRepeats }
        : {}),
    };
    return { ok: true, participants: deduped, config: roomConfig };
  }
  // open-floor is unmoderated: every speaker nominates the next and the room closes
  // by an end-vote. Same routing-knob floors as group-chat, plus the end-vote
  // threshold (a (0,1) fraction; the close gate is a strict `>` against it).
  if (strategy === "open-floor") {
    // open-floor has no routing Mind: speakers nominate each other and vote to
    // close. Reject a moderator/synthesizer rather than silently dropping it, so an
    // operator who reused a group-chat payload sees why the field had no effect.
    if (config.moderator) {
      return {
        ok: false,
        error: "open-floor has no moderator — every speaker nominates the next",
      };
    }
    if (config.synthesizer) {
      return { ok: false, error: "open-floor has no closing synthesizer — drop `synthesizer`" };
    }
    const knobError = routingKnobError(config);
    if (knobError) return { ok: false, error: knobError };
    if (
      config.endVoteThreshold !== undefined &&
      (!Number.isFinite(config.endVoteThreshold) ||
        config.endVoteThreshold <= 0 ||
        config.endVoteThreshold >= 1)
    ) {
      return { ok: false, error: "endVoteThreshold must be a number in (0,1)" };
    }
    const roomConfig: RoomConfig = {
      ...(typeof config.minRounds === "number" ? { minRounds: config.minRounds } : {}),
      ...(typeof config.maxSpeakerRepeats === "number"
        ? { maxSpeakerRepeats: config.maxSpeakerRepeats }
        : {}),
      endVoteThreshold: config.endVoteThreshold ?? DEFAULT_END_VOTE_THRESHOLD,
    };
    return { ok: true, participants: deduped, config: roomConfig };
  }
  // review is a two-Mind, single-pass cross-vendor critique: participants[0]
  // authors the artifact, participants[1] reviews it. Roles are positional, so it
  // needs no routing Mind and no config — but it DOES require the two Minds to run
  // on different providers (the whole point), so a same-vendor or unpinned pair is
  // rejected here rather than running a pointless same-model review.
  if (strategy === "review") {
    if (deduped.length !== 2) {
      return {
        ok: false,
        error: "review needs exactly 2 participants: the author, then the reviewer",
      };
    }
    if (turnBudget < 2) {
      return {
        ok: false,
        error: "review needs a turnBudget of at least 2 (one author turn, one review turn)",
      };
    }
    if (config.moderator) {
      return {
        ok: false,
        error: "review has no moderator — the reviewer critiques the author's artifact directly",
      };
    }
    if (config.synthesizer) {
      return { ok: false, error: "review has no synthesizer — the reviewer's turn is the close" };
    }
    const authorSlug = deduped[0];
    const reviewerSlug = deduped[1];
    if (authorSlug === undefined || reviewerSlug === undefined) {
      return {
        ok: false,
        error: "review needs exactly 2 participants: the author, then the reviewer",
      };
    }
    const bySlug = new Map(minds.map((m) => [m.slug, m]));
    const authorProvider = bySlug.get(authorSlug)?.provider;
    const reviewerProvider = bySlug.get(reviewerSlug)?.provider;
    if (!authorProvider || !reviewerProvider) {
      return {
        ok: false,
        error:
          "review must be cross-vendor: pin a provider on both the author and the reviewer Mind, set to different providers",
      };
    }
    if (authorProvider === reviewerProvider) {
      return {
        ok: false,
        error: `review must be cross-vendor: ${authorSlug} and ${reviewerSlug} both use "${authorProvider}" — pin them to different providers`,
      };
    }
    // A coding review is only a real code→review loop if the author can edit and
    // the reviewer can read the change; otherwise it's a same-as-non-coding prose
    // pass with a confined cwd nobody uses. Reject the under-equipped pair here, on
    // the dry-run path, so the operator fixes the Minds before confirming.
    const author = bySlug.get(authorSlug);
    const reviewer = bySlug.get(reviewerSlug);
    if (coding && author && reviewer) {
      const capError = codingReviewCapabilityError(author, reviewer);
      if (capError) return { ok: false, error: capError };
    }
    return { ok: true, participants: deduped };
  }
  // magentic is manager-led: a non-participant manager Mind plans a task ledger and
  // delegates to the participant workers (parallel to group-chat's moderator). It
  // needs a manager Mind that is real and NOT among the ≥2 workers, and — like the
  // other facilitated modes — rejects a stray moderator/synthesizer rather than
  // silently dropping it, so a reused payload's dead field is explained.
  if (strategy === "magentic") {
    const manager = config.manager;
    if (!manager) {
      return { ok: false, error: "magentic needs a manager Mind — set `manager`" };
    }
    if (!isValidParticipant(manager)) {
      return { ok: false, error: "manager must be a safe Mind slug (not director/system)" };
    }
    if (!known.has(manager)) {
      return {
        ok: false,
        error: `unknown manager Mind: ${manager} — genesis it first or check the roster`,
      };
    }
    if (deduped.includes(manager)) {
      return {
        ok: false,
        error:
          "the manager must not also be a worker — it plans and delegates, it does not execute tasks",
      };
    }
    if (config.moderator) {
      return { ok: false, error: "magentic has no moderator — the manager routes the work" };
    }
    if (config.synthesizer) {
      return { ok: false, error: "magentic has no synthesizer — the manager closes the plan" };
    }
    return { ok: true, participants: deduped, config: { manager } };
  }
  return { ok: true, participants: deduped };
}

// Open a fresh-slug room and kick its auto-advance loop. The shared core behind
// both the board's room-start action and the chamber_room_start chat tool, so
// validation, the concurrency cap, and the fresh-slug discipline live in one
// place. Each start opens a brand-new room under a unique slug: the CLI
// MVP can't cancel an in-flight turn, so a turn still draining from a stopped
// room must land in its own old dir, never a reused one. Past closed rooms remain
// as bounded history under rooms/ via the retention sweep.
async function startRoom(
  input: {
    participants: readonly string[];
    turnBudget: number;
    name?: string;
    strategy?: string;
    topic?: string;
    projectId?: string;
    coding?: boolean;
  } & RoomConfigInput,
): Promise<RibActionResult> {
  // Refuse once disposed: driver.start() doesn't check, so without this a start
  // after dispose() would write an "active" room whose loop never runs (ensureLoop
  // bails on isDisposed) — a phantom room nothing ever clears.
  if (!driver || driver.isDisposed()) return ROOM_DISABLED;
  const strategy = ((input.strategy ?? "").trim() || "sequential") as RoomStrategyName;
  const valid = await validateStart(
    input.participants,
    input.turnBudget,
    strategy,
    {
      moderator: input.moderator,
      minRounds: input.minRounds,
      synthesizer: input.synthesizer,
      maxSpeakerRepeats: input.maxSpeakerRepeats,
      endVoteThreshold: input.endVoteThreshold,
      manager: input.manager,
    },
    input.projectId,
    input.coding,
  );
  if (!valid.ok) return { ok: false, error: valid.error };
  const name = (input.name ?? "").trim() || deriveRoomName(input.topic, input.participants);
  // Normalize here so both entry points (the chat tool and the board action)
  // store a trimmed topic or none — a whitespace-only topic becomes no topic.
  const topic = (input.topic ?? "").trim();
  const slug = freshRoomSlug();
  // Concurrency cap + reservation in one synchronous tick (no await between the size
  // check and the add): two concurrent starts can neither overshoot MAX_ACTIVE_ROOMS
  // nor have a racing reconcileRoomPanels (a finishing room's loop) drop this room's
  // panel mid-driver.start — the slug is in activeRooms before that await, so it is
  // always in the keep-set. Both entry points (chat tool, board action) route here.
  if (activeRooms.size >= MAX_ACTIVE_ROOMS) {
    return {
      ok: false,
      error: `${MAX_ACTIVE_ROOMS} Chamber rooms are already active (the concurrent cap) — stop one before starting another.`,
    };
  }
  activeRooms.add(slug);
  const activeDriver = driver;
  try {
    await activeDriver.start({
      slug,
      name,
      strategy,
      participants: valid.participants,
      turnBudget: input.turnBudget,
      ...(topic ? { topic } : {}),
      ...(valid.config ? { config: valid.config } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.coding ? { coding: input.coding } : {}),
    });
    lastSlug = slug;
    // driver.start published this room's first board (registering its per-slug
    // region); reconcile so the surface keeps every active room plus the most-recent.
    reconcileRoomPanels();
    ensureLoop(slug);
    // The sessions index is a separate snapshot from the room's own panel — refresh
    // it so the new active session appears promptly instead of on the next cadence
    // (mirrors the end-of-room refresh). Fail-soft, never thrown.
    void refreshWorkflow?.("chamber-rooms")?.catch(() => {});
    void refreshStandingPanels();
    return { ok: true, data: { slug } };
  } catch (e) {
    // The reserved slot never opened — release it and drop any partial panel.
    activeRooms.delete(slug);
    reconcileRoomPanels();
    return { ok: false, error: errText(e) };
  }
}

// Inject director overrides into a room: a direction for the next speaker, a
// nominated next speaker, and/or a director message. Shared by the board's
// room-inject action and the chamber_room_say chat tool.
async function injectRoom(
  slug: string,
  input: { directionInjection?: string; nextSpeaker?: string; text?: string },
): Promise<RibActionResult> {
  if (!driver) return ROOM_DISABLED;
  if (!isSafeSlug(slug)) return { ok: false, error: `unsafe room slug: ${JSON.stringify(slug)}` };
  try {
    const applied = await driver.inject(slug, {
      ...(input.directionInjection ? { directionInjection: input.directionInjection } : {}),
      ...(input.nextSpeaker ? { nextSpeaker: input.nextSpeaker } : {}),
      ...(input.text ? { text: input.text } : {}),
    });
    // driver.inject silently no-ops on a room that is no longer active; surface
    // that as a failure so a chat tool can't claim a dropped steer landed.
    if (!applied) return { ok: false, error: "the room is no longer active" };
    return { ok: true, data: { slug } };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

// Stop a room and drop it as the active target. Shared by the board's room-stop
// action and the chamber_room_stop chat tool.
async function stopRoom(slug: string): Promise<RibActionResult> {
  if (!driver) return ROOM_DISABLED;
  if (!isSafeSlug(slug)) return { ok: false, error: `unsafe room slug: ${JSON.stringify(slug)}` };
  try {
    await driver.stop(slug);
    activeRooms.delete(slug);
    reconcileRoomPanels();
    // The room is now a closed session — refresh the index so it appears as a card
    // (fail-soft; cadence covers an older harness without the seam).
    await refreshWorkflow?.("chamber-rooms")?.catch(() => {});
    await refreshStandingPanels();
    return { ok: true, data: { slug } };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

function roomStartAction(action: RibAction): Promise<RibActionResult> {
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  // Routing config arrives as flat payload keys — a board action's collected
  // `fields` (base #120) merge in flat, so `moderator`/`endVoteThreshold` etc. are
  // plain keys, not nested. roomConfigFromFlat owns that flat-key contract.
  return startRoom({
    participants: asStringArray(payload.participants),
    turnBudget: typeof payload.turnBudget === "number" ? payload.turnBudget : 0,
    name: asNonEmptyString(payload.name) || undefined,
    strategy: asNonEmptyString(payload.strategy) || undefined,
    topic: asNonEmptyString(payload.topic) || undefined,
    projectId: asNonEmptyString(payload.projectId) || undefined,
    coding: payload.coding === true,
    ...roomConfigFromFlat(payload),
  });
}

// Toggle one Mind's membership in the Convene draft (the deselected-slug set). The
// slug must name a real, current Mind (validated against the live roster, not just
// shape) so a stale/forged chip can't write an unknown slug into the draft. On
// success refresh the roster so the chips re-render with the new glyph; the refresh
// is fail-soft (cadence covers an older harness). Returns the new exclusion list.
async function draftSetAction(action: RibAction): Promise<RibActionResult> {
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  const slug = asNonEmptyString(payload.slug);
  if (!slug || !isValidParticipant(slug)) {
    return { ok: false, error: "draft-set requires payload { slug } naming a current Mind" };
  }
  try {
    const minds = await readMinds(mindsDir());
    if (!minds.some((m) => m.slug === slug)) {
      return { ok: false, error: `unknown Mind: ${slug}` };
    }
    const excluded = await toggleDraftExclusion(slug);
    await refreshWorkflow?.("chamber-roster")?.catch(() => {});
    return { ok: true, data: { excluded: [...excluded] } };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

// Convene a room from the current draft: resolve participants as all current Minds
// minus the draft's excluded set, then reuse the room start path (startRoom →
// validateStart → driver), so the <2-participant / unknown-strategy / seam-absent
// guards aren't duplicated here. On success clear the draft (back to all-selected)
// and refresh the roster so the chips reset. The default empty draft yields every
// Mind, preserving the historical all-Minds Start.
async function conveneAction(action: RibAction): Promise<RibActionResult> {
  if (!driver || driver.isDisposed()) return ROOM_DISABLED;
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  let participants: string[];
  let displayNames: string[];
  try {
    const excluded = await readDraftExclusion();
    const minds = await readMinds(mindsDir());
    const drafted = minds.filter((m) => !excluded.has(m.slug));
    participants = drafted.map((m) => m.slug);
    displayNames = drafted.map((m) => m.name);
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
  const topic = asNonEmptyString(payload.topic) || undefined;
  const res = await startRoom({
    name: deriveRoomName(topic, displayNames),
    strategy: "sequential",
    participants,
    turnBudget: DEFAULT_ROOM_TURN_BUDGET,
    topic,
  });
  if (res.ok) {
    await clearDraft().catch(() => {});
    await refreshWorkflow?.("chamber-roster")?.catch(() => {});
  }
  return res;
}

async function roomInjectAction(action: RibAction): Promise<RibActionResult> {
  const resolved = requireRoomSlug(action);
  if ("error" in resolved) return resolved.error;
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  return injectRoom(resolved.slug, {
    directionInjection: asNonEmptyString(payload.directionInjection) || undefined,
    nextSpeaker: asNonEmptyString(payload.nextSpeaker) || undefined,
    text: asNonEmptyString(payload.text) || undefined,
  });
}

async function roomStopAction(action: RibAction): Promise<RibActionResult> {
  const resolved = requireRoomSlug(action);
  if ("error" in resolved) return resolved.error;
  return stopRoom(resolved.slug);
}

// Delete a closed room: remove its rooms/<slug>/ dir, then refresh the sessions
// index so the card drops (the mutate-then-refresh pattern). Fail-closed on a
// missing/unsafe slug (requireRoomSlug) before any FS touch. The in-memory
// activeRooms check is a fast-path with a clear message; deleteRoom is the
// authoritative guard — it re-reads the on-disk room.json status and refuses a
// LIVE room (whose dir the driver rewrites each turn), so a stale in-memory set
// (a restart or a second process) can't race a delete into a live room. deleteRoom
// throws on an already-gone room (surfaced here, not as success); the try/catch
// fails soft like retireAction.
async function roomDeleteAction(action: RibAction): Promise<RibActionResult> {
  const resolved = requireRoomSlug(action);
  if ("error" in resolved) return resolved.error;
  const slug = resolved.slug;
  if (activeRooms.has(slug)) {
    return { ok: false, error: "stop the room before deleting it" };
  }
  try {
    await createFileRoomStore(roomsDir()).deleteRoom(slug);
    // Drop any lingering panel/most-recent pin for the deleted room, then refresh
    // the index card away (fail-soft — the seam resolves on error / is absent on an
    // older harness, where the 120s cadence drops the card).
    if (lastSlug === slug) lastSlug = undefined;
    reconcileRoomPanels();
    await refreshWorkflow?.("chamber-rooms")?.catch(() => {});
    await refreshStandingPanels({ removed: true });
    return { ok: true, data: { slug } };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

// Unregister every per-slug room-view snapshot key so dispose() (and a rebind onto a
// new manager) releases them rather than leaking registrations across boots/tests.
function releaseRoomViews(): void {
  for (const entry of roomViewEntries.values()) entry.unregister();
  roomViewEntries.clear();
}

// Return the per-slug room-view publisher for the active manager, registering its key
// lazily on first open via the same coalescing publisher the lens/room registries use.
// A re-bootstrap onto a different manager releases the stale keys first so we don't leak
// them or publish through a dead manager. The get-miss → register → set is synchronous,
// so a second open of the same slug finds the entry rather than tripping sm.register's
// duplicate-key guard.
function ensureRoomViewPublisher(
  sm: SnapshotManager,
  slug: string,
): { publish(view: CanvasView): Promise<void> } {
  if (roomViewSm !== sm) {
    releaseRoomViews();
    roomViewSm = sm;
  }
  const existing = roomViewEntries.get(slug);
  if (existing) return existing.publisher;
  const key = roomViewKey(slug);
  const { publisher, latest } = createCoalescingPublisher(() => sm.recompose(key));
  const unregister = sm.register(key, latest, { validate: expectView(key, "board") });
  roomViewEntries.set(slug, { publisher, unregister });
  return publisher;
}

// Open a closed room from the sessions index: rebuild its board from the persisted
// transcript, publish it to the room's own room-view key, and return the host
// open-canvas effect. The board carries the room's Start-again / group-chat / open-floor
// controls, so a past session can be relaunched from the drawer. Fails closed on a
// missing/unsafe slug, an unknown room, or an absent room seam.
async function roomOpenAction(action: RibAction): Promise<RibActionResult> {
  const resolved = requireRoomSlug(action);
  if ("error" in resolved) return resolved.error;
  const sm = roomSm;
  if (!sm) return ROOM_DISABLED;
  try {
    const store = createFileRoomStore(roomsDir());
    const room = await store.loadRoom(resolved.slug);
    if (!room) return { ok: false, error: `room '${resolved.slug}' not found` };
    const transcript = await store.loadTranscript(resolved.slug);
    // A magentic room's plan lives in its ledger; load it so a reopened closed room
    // renders the Plan section, not just the transcript (the live board does the same).
    const ledger = room.strategy === "magentic" ? await store.loadLedger(resolved.slug) : undefined;
    const board = buildRoomBoard(room, transcript, ledger);
    await ensureRoomViewPublisher(sm, resolved.slug).publish(board);
    return {
      ok: true,
      data: { effect: "open-canvas", key: roomViewKey(resolved.slug), title: room.name },
    };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

// Retire a lens: delete its lenses/<id>/ record AND drop its live panel + snapshot
// key, then refresh the lenses index so the card drops. Fail-closed on a
// missing/unsafe id (canonicalLensId rejects garbage) before any FS touch;
// deleteLens throws on an already-gone lens (surfaced here, not as success).
// registry.remove is a safe no-op if the id isn't live. The refresh is fail-soft
// (the seam resolves on error / is absent on an older harness).
async function retireLensAction(action: RibAction): Promise<RibActionResult> {
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  const raw = asNonEmptyString(payload.id);
  if (!raw) return { ok: false, error: "retire-lens requires payload { id }" };
  const id = canonicalLensId(raw);
  if (!id) return { ok: false, error: `unsafe lens id: ${JSON.stringify(raw)}` };
  try {
    // Let any in-flight boot re-registration finish first, so a retire can't race a
    // reregister into resurrecting this lens.
    await lensReconcileInFlight?.catch(() => {});
    await createFileLensStore(lensesDir()).deleteLens(id);
    lensRegistry?.remove(id);
    await refreshWorkflow?.("chamber-lenses")?.catch(() => {});
    // The retired lens drops from the roster pulse's "Live views" count too — refresh
    // it so the count matches the just-updated index (mirrors the emit path).
    await refreshWorkflow?.("chamber-roster")?.catch(() => {});
    await refreshStandingPanels({ removed: true });
    return { ok: true, data: { id, key: lensKey(id) } };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

// Open a lens: return the host open-canvas effect focusing the lens's live board in
// the drawer. A lens is live-published the whole time it exists, so its snapshot key
// always resolves — no deferral (unlike a closed room). Non-destructive and
// side-effect-free; fails closed on a missing/unsafe id (canonicalLensId rejects
// garbage) so a stale/garbled payload can't open a bad key.
function lensOpenAction(action: RibAction): RibActionResult {
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  const raw = asNonEmptyString(payload.id);
  if (!raw) return { ok: false, error: "lens-open requires payload { id }" };
  const id = canonicalLensId(raw);
  if (!id) return { ok: false, error: `unsafe lens id: ${JSON.stringify(raw)}` };
  return { ok: true, data: { effect: "open-canvas", key: lensKey(id), title: id } };
}

function lensHtmlAction(action: RibAction): RibActionResult {
  const payload = action.payload;
  if (
    typeof payload !== "undefined" &&
    (typeof payload !== "object" || payload === null || Array.isArray(payload))
  ) {
    return { ok: false, error: "lens-html requires an object payload" };
  }
  return { ok: true, data: { key: HTML_LENS_KEY } };
}

// The rows section a lens write-back appends annotation notes to. The verb owns
// this section title so repeated notes accumulate in one place regardless of how
// the maintaining Mind laid out the rest of the board.
const LENS_NOTES_SECTION_TITLE = "Notes";
const LENS_NOTE_MAX = 500;

// Append a note as a row to a lens board's "Notes" section, creating that section
// if the board has none. Pure (no I/O): the caller persists + republishes the
// returned board. New rows go to the end so the section reads oldest-first.
function appendLensNote(board: CanvasBoardView, note: string): CanvasBoardView {
  const row = { text: note };
  let appended = false;
  const sections: CanvasBoardView["sections"] = board.sections.map((s) => {
    if (!appended && s.kind === "rows" && s.title === LENS_NOTES_SECTION_TITLE) {
      appended = true;
      return { ...s, items: [...s.items, row] };
    }
    return s;
  });
  if (!appended) {
    sections.push({ kind: "rows", title: LENS_NOTES_SECTION_TITLE, items: [row] });
  }
  return { ...board, sections };
}

// Lens write-back: append an operator-supplied note from the lens's own panel (a
// board `actions` section dispatches `{ id, note }` here). A deterministic edit,
// NOT a re-prompt of the maintaining Mind, so it costs nothing. The brief gate is
// deliberately NOT fired — a free in-view annotation must not promote a paid
// briefing turn (that path is reserved for Mind-authored substance).
async function lensNoteAction(action: RibAction): Promise<RibActionResult> {
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  const raw = asNonEmptyString(payload.id);
  if (!raw) return { ok: false, error: "lens-note requires payload { id, note }" };
  const id = canonicalLensId(raw);
  if (!id) return { ok: false, error: `unsafe lens id: ${JSON.stringify(raw)}` };
  const note = asNonEmptyString(payload.note);
  if (!note) return { ok: false, error: "lens-note requires a non-empty note" };
  // Count code points, not UTF-16 code units, so the cap matches the "characters"
  // the message promises (an emoji is one character but two code units).
  if ([...note].length > LENS_NOTE_MAX) {
    return { ok: false, error: `note too long (max ${LENS_NOTE_MAX} characters)` };
  }
  // The write-back republishes through the registry to update the live panel, so the
  // region seam must be wired (it always is when a lens exists — fail closed if not).
  if (!lensRegistry)
    return { ok: false, error: "lens write-back unavailable (region seam absent)" };
  const registry = lensRegistry;
  // Serialize the load-append-publish: it is a read-modify-write, so two concurrent
  // appends to the same board would lose-update (the store's atomic rename guards a
  // torn file, not a stale read). Note appends are rare operator actions, so one
  // global chain — not a per-id lock — suffices.
  const apply = async (): Promise<RibActionResult> => {
    try {
      // Let any in-flight boot re-registration finish first, so the write can't race a
      // reregister republishing the pre-edit board over the live key.
      await lensReconcileInFlight?.catch(() => {});
      const record = await createFileLensStore(lensesDir()).loadLens(id);
      if (!record) return { ok: false, error: `lens '${id}' not found` };
      const { key } = await registry.publish(id, appendLensNote(record.board, note), {
        scope: record.scope,
        maintainingMind: record.maintainingMind,
        reason: record.reason,
      });
      // The lens's updatedAt advanced — refresh the index card and roster pulse (cheap
      // deterministic collectors), fail-soft like the emit/retire paths.
      await refreshWorkflow?.("chamber-lenses")?.catch(() => {});
      await refreshWorkflow?.("chamber-roster")?.catch(() => {});
      await refreshStandingPanels();
      return { ok: true, data: { id, key } };
    } catch (e) {
      return { ok: false, error: errText(e) };
    }
  };
  const run = lensWriteInFlight.then(apply, apply);
  lensWriteInFlight = run.catch(() => {});
  return run;
}

// Resolve the target room slug for a control. With server-assigned slugs there
// is no default: a payload-less call (a stale/static button or an API client
// that forgot the slug) must fail closed rather than hit a legacy `room` dir.
function requireRoomSlug(action: RibAction): { slug: string } | { error: RibActionResult } {
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  const slug = asNonEmptyString(payload.slug);
  if (!slug) return { error: { ok: false, error: "this room control requires payload { slug }" } };
  if (!isSafeSlug(slug)) {
    return { error: { ok: false, error: `unsafe room slug: ${JSON.stringify(slug)}` } };
  }
  return { slug };
}

// A unique, path-safe room slug per start (timestamp + counter), so every room
// gets its own rooms/<slug>/ dir and a late turn from a prior room can't bleed
// into a new one. Matches SAFE_SLUG (lowercase alnum + hyphens).
function freshRoomSlug(): string {
  return `room-${Date.now().toString(36)}-${(roomSeq++).toString(36)}`;
}

// A room participant must be a safe slug and not a reserved authority: "director"
// and "system" are driver-stamped roles, never speakers (a room with one would
// just end on its turn — an unknown mind).
function isValidParticipant(slug: string): boolean {
  return slug !== "director" && slug !== "system" && isSafeSlug(slug);
}

// True if the slug is a bare kebab token (no traversal, non-empty). assertSafeSlug
// throws on a bad slug; this is its non-throwing predicate form.
function isSafeSlug(slug: string): boolean {
  try {
    assertSafeSlug(slug);
    return true;
  } catch {
    return false;
  }
}

// Open a mind as a seeded chat: compose its soul into a system prompt and hand
// the harness an "open-chat" directive (the generic seam the SPA interprets to
// start a fresh seeded conversation). Read-only against minds/ — resolving via
// resolveMinds() returns the unknown-mind error on a retire-then-enter race.
async function enterMindAction(action: RibAction): Promise<RibActionResult> {
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  const slug = asNonEmptyString(payload.slug);
  if (!slug) return { ok: false, error: "enter-mind requires payload { slug }" };
  try {
    const mind = (await resolveMinds()).find((m) => m.slug === slug);
    if (!mind) return { ok: false, error: `unknown Mind: ${slug}` };
    const seed = await buildSeedFor(mindsDir(), mind);
    return { ok: true, data: { effect: "open-chat", seed } };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

// The cold-start "Author a Mind" board actions launch the chamber-genesis workflow
// (the canonical genesis path: one prompt turn authors the SOUL.md + tagline and
// persists via chamber_emit_genesis), rather than opening a freeform author chat.
// Routing through the workflow lets an archetype pin its short role/name/voice as
// $inputs, so the roster card carries a crisp role pill instead of a model-
// improvised sentence.

// Author one of the starter archetypes: launch chamber-genesis with the starter's
// brief as $ARGUMENTS and its name/role/voice pinned as explicit inputs.
async function authorArchetypeAction(action: RibAction): Promise<RibActionResult> {
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  const slug = asNonEmptyString(payload.slug);
  const starter = GENESIS_STARTERS.find((s) => s.slug === slug);
  if (!starter) return { ok: false, error: `unknown archetype: ${slug || "(none)"}` };
  return {
    ok: true,
    data: {
      effect: "run-workflow",
      workflow: "chamber-genesis",
      args: {
        ARGUMENTS: starter.voiceDescription,
        name: starter.name,
        role: starter.role,
        voice: starter.voice,
      },
    },
  };
}

// The operator-typed brief is the only unbounded, user-controlled input here;
// clamp it before it rides into a billed genesis run.
const MAX_BRIEF_CHARS = 2000;

// Author from a freeform brief: launch chamber-genesis with the brief as $ARGUMENTS
// (the same path /genesis takes). The workflow authors the name, a short role
// title, and the voice from the brief.
async function describeOwnAction(action: RibAction): Promise<RibActionResult> {
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  const brief = asNonEmptyString(payload.brief);
  if (!brief) return { ok: false, error: "Describe the Mind first — who should it feel like?" };
  return {
    ok: true,
    data: {
      effect: "run-workflow",
      workflow: "chamber-genesis",
      args: { ARGUMENTS: brief.slice(0, MAX_BRIEF_CHARS) },
    },
  };
}

async function retireAction(action: RibAction): Promise<RibActionResult> {
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  const slug = asNonEmptyString(payload.slug);
  if (!slug) return { ok: false, error: "retire requires payload { slug }" };
  try {
    await retireMind(mindsDir(), slug);
    invalidateRoster(); // a Mind is gone — drop it from the cached roster
    await refreshWorkflow?.("chamber-roster")?.catch(() => {});
    await refreshStandingPanels({ removed: true });
    return { ok: true, data: { slug } };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

async function setModelAction(action: RibAction): Promise<RibActionResult> {
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  const slug = asNonEmptyString(payload.slug);
  if (!slug) return { ok: false, error: "set-model requires payload { slug }" };
  const model = asNonEmptyString(payload.model);
  const provider = asNonEmptyString(payload.provider);
  try {
    await setMindModel(mindsDir(), slug, { model, provider });
    invalidateRoster();
    await refreshWorkflow?.("chamber-roster");
    return { ok: true, data: { slug, ...(model ? { model } : {}) } };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

// Tool results stream to chat as `tool_result` chunks; keep each well under the
// chat context budget. Truncation is signalled, never silent.
const MAX_TOOL_RESULT_CHARS = 16_000;
function boundedText(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  const omitted = text.length - MAX_TOOL_RESULT_CHARS;
  return `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n…(truncated — ${omitted} more chars)`;
}
function emitResult(ctx: ToolContext, content: string, isError = false): void {
  ctx.emit({ type: "tool_result", toolUseId: "", content, ...(isError ? { isError: true } : {}) });
}

// turnBudget/confirm are .optional() (not .default()) on purpose: z.toJSONSchema
// — which the Copilot provider feeds the model — lists defaulted fields as
// `required`, which would force the model to send `confirm` (defeating the
// dry-run/omit path) and `turnBudget`. Defaults are applied after parse instead.
const roomStartSchema = z.object({
  participants: z.array(z.string()).min(2),
  turnBudget: z.number().int().min(1).max(MAX_ROOM_TURN_BUDGET).optional(),
  name: z.string().optional(),
  topic: z.string().optional(),
  // Optional: target the room at a keelson project (turns run at its rootPath).
  projectId: z.string().optional(),
  // Opt into the coding tier (default off): a Mind that declares `code`/`read` can
  // run Bash/Edit/Write/Read, confined to the project root. Requires `projectId`.
  coding: z.boolean().optional(),
  // Routing config. `strategy` defaults to sequential; `moderator` is required
  // (and validated) only for "group-chat"; `manager` for "magentic"; `endVoteThreshold`
  // tunes "open-floor"'s close. All optional so a plain two-Mind room needs none of them.
  strategy: z.string().optional(),
  moderator: z.string().optional(),
  manager: z.string().optional(),
  synthesizer: z.string().optional(),
  minRounds: z.number().int().min(1).optional(),
  maxSpeakerRepeats: z.number().int().min(1).optional(),
  endVoteThreshold: z.number().optional(),
  confirm: z.boolean().optional(),
});
const roomSaySchema = z
  .object({
    // Target a specific room; omit to steer the most-recent active room.
    room: z.string().optional(),
    direction: z.string().optional(),
    callOn: z.string().optional(),
    text: z.string().optional(),
  })
  .refine((v) => Boolean(v.direction || v.callOn || v.text), {
    message: "provide at least one of: direction, callOn, text",
  });
// status/stop take an optional room slug (default: the most-recent room).
const roomTargetSchema = z.object({ room: z.string().optional() });

// Render a room + its transcript as chat-legible text. Targets an explicit slug, or
// the most-recent active room — falling back to the most-recent finished room only
// when none is active, so a bare call headlines a live room when one exists. Reads
// through the same store the driver writes, so it reflects the latest committed turn.
// When several rooms are active and no slug was named, appends a one-line index of
// the others so multiple concurrent rooms are discoverable from a bare status call.
async function renderRoomStatus(store: RoomStore, target?: string): Promise<string> {
  const explicit = (target ?? "").trim();
  const slug = explicit || mostRecentActiveSlug() || lastSlug;
  if (!slug) return "No Chamber room yet. Start one with chamber_room_start.";
  const room = await store.loadRoom(slug);
  if (!room) {
    return explicit
      ? `No Chamber room "${slug}".`
      : "No Chamber room yet. Start one with chamber_room_start.";
  }
  const transcript = await store.loadTranscript(slug);
  const head =
    `Room "${room.name}" (${slug}) — ${room.status}, turn ${room.turnIndex}/${room.turnBudget}; ` +
    `participants: ${room.participants.join(", ")}.`;
  const body = transcript.length > 0 ? renderTranscript(transcript) : "(no turns yet)";
  let index = "";
  if (!explicit && activeRooms.size > 1) {
    const others = [...activeRooms].filter((s) => s !== slug);
    const lines = await Promise.all(
      others.map(async (s) => {
        const r = await store.loadRoom(s);
        return r
          ? `  • ${r.name} (${s}) — ${r.status}, turn ${r.turnIndex}/${r.turnBudget}`
          : `  • ${s}`;
      }),
    );
    index = `\n\n${activeRooms.size} rooms active — pass room:<slug> to read another:\n${lines.join("\n")}`;
  }
  return boundedText(`${head}\n\n${body}${index}`);
}

// Genesis write seam: the chamber-genesis workflow's prompt node authors the soul
// + tagline and calls this tool to persist the Mind. Deterministic and in-process
// (it reuses scaffoldMind), so the generative half stays in the prompt and the
// write half stays testable.
const genesisEmitSchema = z.object({
  name: z.string().min(1),
  role: z.string().min(1),
  voice: z.string().min(1),
  soul: z.string().min(1),
  tagline: z.string().min(1),
  model: z.string().optional(),
  provider: z.string().optional(),
  // Capability slugs the Mind may invoke in a room (see CAPABILITIES).
  // Unknown slugs are dropped at persist; omitted/empty keeps the Mind text-only.
  tools: z.array(z.string()).optional(),
});

function makeGenesisTool(refreshWorkflow?: RibContext["refreshWorkflow"]): ToolDefinition {
  return {
    name: "chamber_emit_genesis",
    description:
      "Internal write-seam for the chamber-genesis workflow: persist an authored Mind (SOUL.md + record) under minds/<slug>. The workflow's prompt turn authors { soul, tagline, optional model/provider pin, optional capability tools }; this tool only writes, failing closed on a slug collision. To create an agent, run the chamber-genesis workflow (e.g. /workflow run chamber-genesis <brief>) rather than calling this directly.",
    inputSchema: genesisEmitSchema,
    state_changing: true,
    async execute(input, ctx) {
      const parsed = genesisEmitSchema.safeParse(input);
      if (!parsed.success) {
        emitResult(ctx, `chamber_emit_genesis: ${parsed.error.message}`, true);
        return;
      }
      const {
        name,
        role,
        voice,
        soul,
        tagline,
        tools,
        model: rawModel,
        provider: rawProvider,
      } = parsed.data;
      try {
        const knownTools = tools
          ? [...new Set(tools.filter((s) => KNOWN_CAPABILITY_SLUGS.has(s)))]
          : [];
        const model = rawModel?.trim();
        const provider = rawProvider?.trim();
        const record: MindRecord = {
          slug: slugify(name),
          name,
          role,
          voice,
          // The roster card truncates for display (with an ellipsis); store the
          // authored tagline trimmed, not hard-cut.
          persona: tagline.trim(),
          createdAt: new Date().toISOString(),
          ...(model ? { model } : {}),
          ...(model && provider ? { provider } : {}),
          ...(knownTools.length > 0 ? { tools: knownTools } : {}),
        };
        await scaffoldMind(mindsDir(), record, soul);
        invalidateRoster();
        // Re-run the bound chamber-roster collector so the new Mind appears
        // promptly instead of waiting on the 120s cadence. Fail-soft (the seam
        // resolves on error and is absent on an older harness) — never throw.
        await refreshWorkflow?.("chamber-roster");
        // A new Mind is additive — route Activity through the seam (no digest turn).
        await refreshStandingPanels();
        emitResult(ctx, JSON.stringify({ ok: true, slug: record.slug, name: record.name }));
      } catch (e) {
        emitResult(ctx, `chamber_emit_genesis failed: ${errText(e)}`, true);
      }
    },
  };
}

// Lens publish seam: the chamber-lens workflow's prompt node composes a canvas
// board and calls this tool to publish it under a per-subject key. `id` routes
// re-authoring of the same subject back to the same panel; the board is validated
// fail-closed (the key's expectView guard) before it is broadcast. scope /
// maintainingMind / reason are the index card's optional PROVENANCE — the agent
// supplies what it can name (never fabricated); each is omitted when absent.
const lensEmitSchema = z.object({
  id: z.string().min(1).max(64),
  board: canvasBoardViewSchema,
  scope: z.string().min(1).max(40).optional(),
  maintainingMind: z.string().min(1).max(40).optional(),
  reason: z.string().min(1).max(120).optional(),
});

function makeLensTool(registry: LensRegistry): ToolDefinition {
  return {
    name: LENS_TOOL_NAME,
    description:
      'Author a lens: render a canvas `board` you compose onto the Chamber surface, where it shows live as its own panel with no hand-coded UI — a Mind surfacing what it sees (e.g. a findings summary after a room discussion). `id` is a short, stable kebab-case identifier for the subject (re-authoring the same id updates the same panel); `board` is the canvas board view. Optional provenance for the lenses index card — supply only what you can truthfully name, never invent: `scope` (the board\'s kind, e.g. "status board" / "timeline" / "checklist"), `maintainingMind` (YOUR own Mind name/slug, the lens\'s maintainer), `reason` (a short note on what changed in this authoring). Call it once per lens. To let a viewer annotate the lens in place, include an `actions` section whose action has `type: "lens-note"`, `payload: { id: <this lens id> }`, and one multiline field named `note` — submitting it appends the note to the lens. The chamber-lens workflow (/workflow run chamber-lens <subject>) is the standalone entry point.',
    inputSchema: lensEmitSchema,
    state_changing: true,
    async execute(input, ctx) {
      const parsed = lensEmitSchema.safeParse(input);
      if (!parsed.success) {
        emitResult(ctx, `chamber_emit_lens: ${parsed.error.message}`, true);
        return;
      }
      // Canonicalize the id into a stable routing key (the prompt asks for kebab-case,
      // but a model may send "Release Risks"). A lens-specific normalizer, NOT the
      // Mind slugifier: no 48-char cap (which would collide distinct long subjects)
      // and no synthetic fallback — an id with no usable characters is rejected.
      const id = canonicalLensId(parsed.data.id);
      if (!id) {
        emitResult(ctx, "chamber_emit_lens: id has no usable characters", true);
        return;
      }
      const { scope, maintainingMind, reason } = parsed.data;
      try {
        const { key } = await registry.publish(id, parsed.data.board, {
          scope,
          maintainingMind,
          reason,
        });
        // Re-run the bound chamber-lenses collector so a newly-authored lens appears
        // in the index promptly instead of waiting on cadence (mirrors genesis
        // refreshing the roster). Fail-soft: the seam resolves on error / is absent
        // on an older harness — never throw past a successful publish.
        await refreshWorkflow?.("chamber-lenses")?.catch(() => {});
        // A changed/new lens is briefing substance: evaluate the gate (it runs a turn
        // only if the watermark hasn't seen this fingerprint) and refresh the roster
        // so its pulse updates. Both fire-and-forget — never thrown past the publish.
        void evaluateBriefGate().catch(() => {});
        void refreshWorkflow?.("chamber-roster")?.catch(() => {});
        await refreshStandingPanels();
        emitResult(ctx, JSON.stringify({ ok: true, key }));
      } catch (e) {
        emitResult(ctx, `chamber_emit_lens failed: ${errText(e)}`, true);
      }
    },
  };
}

const digestEmitSchema = z.object({
  board: canvasBoardViewSchema,
});

// Standing-digest write seam: the chamber-digest workflow's author node composes a
// canvas board synthesizing the Chamber's current state and calls this tool to persist
// it. The tool validates the board fail-closed (the schema), stamps it with the current
// chamber fingerprint (so the gate reads the digest as current and runs no further turn
// until the next change), and writes it atomically. The publish node then re-reads the
// store to drive the bound key.
function makeDigestTool(): ToolDefinition {
  return {
    name: DIGEST_TOOL_NAME,
    description:
      "Internal write-seam for the chamber-digest workflow: persist the standing digest board the author turn composed. The workflow's gate-conditioned author node calls this once with { board } when the Chamber changed; this tool validates the board fail-closed, stamps it with the current chamber fingerprint, and writes it so the digest panel refreshes. The chamber-digest workflow (run on cadence by the host scheduler) is the entry point — don't call this directly.",
    inputSchema: digestEmitSchema,
    state_changing: true,
    async execute(input, ctx) {
      const parsed = digestEmitSchema.safeParse(input);
      if (!parsed.success) {
        emitResult(ctx, `chamber_emit_digest: ${parsed.error.message}`, true);
        return;
      }
      try {
        // Stamp the fingerprint from a fresh read at persist time (the same reduction
        // the gate uses) so the gate goes quiet after this authoring. The read is taken
        // at turn END: a structural change landing DURING the (short) author turn is
        // captured by the fingerprint but not by this board, so it surfaces on the next
        // structural change rather than immediately — acceptable eventual consistency
        // for a standing panel, and the common no-mid-turn-change case is exact. (The
        // out-of-process gate/turn split is why we don't cheaply stamp the gate's
        // pre-turn fingerprint here, the way the in-process Briefing gate does.)
        const { minds, rooms, lenses } = await readChamberRecords();
        await writeDigest({
          board: parsed.data.board,
          fingerprint: chamberFingerprint(minds, rooms, lenses),
        });
        emitResult(ctx, JSON.stringify({ ok: true }));
      } catch (e) {
        emitResult(ctx, `chamber_emit_digest failed: ${errText(e)}`, true);
      }
    },
  };
}

const lensHtmlEmitSchema = z.object({
  html: z.string().min(1).max(262144),
});

function makeEmitLensHtmlTool(registry: HtmlLensRegistry): ToolDefinition {
  return {
    name: HTML_LENS_TOOL_NAME,
    description:
      "Author an HTML lens: publish a literal HTML string to the Chamber HTML canvas, rendered in the host's sandboxed iframe. `html` is the exact markup to render; non-string or oversized payloads fail closed.",
    inputSchema: lensHtmlEmitSchema,
    state_changing: true,
    async execute(input, ctx) {
      const parsed = lensHtmlEmitSchema.safeParse(input);
      if (!parsed.success) {
        emitResult(ctx, `chamber_emit_lens_html: ${parsed.error.message}`, true);
        return;
      }
      try {
        const { key } = await registry.publish(parsed.data.html);
        // No chamber-lenses/roster/brief refresh here (unlike chamber_emit_lens): the
        // HTML lens is published in-memory only and isn't part of the persisted lens
        // store those collectors read, so refreshing them would be inert.
        emitResult(ctx, JSON.stringify({ ok: true, key }));
      } catch (e) {
        emitResult(ctx, `chamber_emit_lens_html failed: ${errText(e)}`, true);
      }
    },
  };
}

const lensRetireSchema = z.object({ id: z.string().min(1).max(64) });

// Lens retire seam: delete a lens's persisted record AND drop its live panel +
// snapshot key, so an agent can retire a lens it (or another Mind) authored.
// Mirrors the chamber-genesis refresh path: fail-closed on an unknown id
// (deleteLens throws), then refresh the lenses index AFTER success only.
function makeRetireLensTool(store: LensStore, registry: LensRegistry): ToolDefinition {
  return {
    name: "chamber_retire_lens",
    description:
      "Retire a lens: permanently remove a lens you (or another Mind) authored — its persisted record AND its live Chamber panel. `id` is the lens's stable kebab-case identifier (the same id chamber_emit_lens used). Fails closed if no such lens exists.",
    inputSchema: lensRetireSchema,
    state_changing: true,
    async execute(input, ctx) {
      const parsed = lensRetireSchema.safeParse(input);
      if (!parsed.success) {
        emitResult(ctx, `chamber_retire_lens: ${parsed.error.message}`, true);
        return;
      }
      const id = canonicalLensId(parsed.data.id);
      if (!id) {
        emitResult(ctx, "chamber_retire_lens: id has no usable characters", true);
        return;
      }
      try {
        // Durable delete first (throws fail-closed on an unknown id), then the
        // in-memory release, then refresh the index — all gated on the delete.
        // Serialize with boot re-registration (see retireLensAction) so a retire
        // can't race a reregister into resurrecting the lens.
        await lensReconcileInFlight?.catch(() => {});
        await store.deleteLens(id);
        registry.remove(id);
        await refreshWorkflow?.("chamber-lenses")?.catch(() => {});
        // The retired lens drops from the roster pulse's "Live views" count too —
        // refresh it so the count matches the just-updated index (mirrors emit).
        await refreshWorkflow?.("chamber-roster")?.catch(() => {});
        await refreshStandingPanels({ removed: true });
        emitResult(ctx, JSON.stringify({ ok: true, key: lensKey(id) }));
      } catch (e) {
        emitResult(ctx, `chamber_retire_lens failed: ${errText(e)}`, true);
      }
    },
  };
}

// Tools are the only chamber surface an MCP client reaches — a board action is not —
// so the read-only list tools and the cleanup verbs (retire a Mind, delete an ended
// room, otherwise board-action-only) are registered here, making the genesis ->
// convene -> read transcript -> clean up lifecycle drivable over MCP, not only the SPA.

// No input — the list tools take none. A bare object schema keeps the params the
// provider advertises empty rather than absent (z.toJSONSchema needs an object).
const noToolInputSchema = z.object({});

// Emit a list payload that stays valid JSON under the tool-result budget: keep rows
// until the next would push the serialized result over the cap, then report the
// omitted count. boundedText would instead truncate the serialized string —
// unparseable JSON exactly when the cap bites — so the list tools use this.
function emitJsonList<T>(ctx: ToolContext, key: string, rows: readonly T[]): void {
  const build = (kept: readonly T[]): string =>
    JSON.stringify({
      count: rows.length,
      ...(kept.length < rows.length ? { omitted: rows.length - kept.length } : {}),
      [key]: kept,
    });
  let kept: T[] = [];
  for (const row of rows) {
    const next = [...kept, row];
    if (kept.length > 0 && build(next).length > MAX_TOOL_RESULT_CHARS) break;
    kept = next;
  }
  emitResult(ctx, build(kept));
}

function makeListMindsTool(): ToolDefinition {
  return {
    name: "chamber_list_minds",
    description:
      "List the Chamber's Minds (the agent roster): each Mind's slug, name, role, tagline, and any pinned model/provider and capability tools. Read-only. Use it to see which agents exist before convening a room. NOT for creating a Mind (run the chamber-genesis workflow) or retiring one (chamber_retire_mind).",
    inputSchema: noToolInputSchema,
    state_changing: false,
    async execute(_input, ctx) {
      try {
        const minds = await readMinds(mindsDir());
        const rows = minds.map((m) => ({
          slug: m.slug,
          name: m.name,
          role: m.role,
          tagline: m.persona,
          ...(m.model ? { model: m.model } : {}),
          ...(m.provider ? { provider: m.provider } : {}),
          ...(m.tools && m.tools.length > 0 ? { tools: m.tools } : {}),
        }));
        emitJsonList(ctx, "minds", rows);
      } catch (e) {
        emitResult(ctx, `chamber_list_minds failed: ${errText(e)}`, true);
      }
    },
  };
}

function makeListRoomsTool(): ToolDefinition {
  return {
    name: "chamber_list_rooms",
    description:
      "List the Chamber's rooms — active sessions first, then ended ones — with each room's slug, name, status, strategy, participants, and turn progress. Read-only. Use it to find a room to read in detail with chamber_room_status, or to delete with chamber_room_delete. NOT for starting, steering, or stopping a room (chamber_room_start / _say / _stop).",
    inputSchema: noToolInputSchema,
    state_changing: false,
    async execute(_input, ctx) {
      try {
        const rooms = await listRooms(roomsDir());
        // listRooms is newest-first; surface active rooms ahead of finished ones
        // (the sessions-index convention), preserving the createdAt order within each.
        const ordered = [
          ...rooms.filter((r) => r.status === "active"),
          ...rooms.filter((r) => r.status !== "active"),
        ];
        const rows = ordered.map((r) => ({
          slug: r.slug,
          name: r.name,
          status: r.status,
          strategy: r.strategy,
          participants: r.participants,
          turn: r.turnIndex,
          turnBudget: r.turnBudget,
          ...(r.topic ? { topic: r.topic } : {}),
          ...(r.projectId ? { projectId: r.projectId } : {}),
          ...(r.coding ? { coding: true } : {}),
        }));
        emitJsonList(ctx, "rooms", rows);
      } catch (e) {
        emitResult(ctx, `chamber_list_rooms failed: ${errText(e)}`, true);
      }
    },
  };
}

function makeListLensesTool(): ToolDefinition {
  return {
    name: "chamber_list_lenses",
    description:
      "List the Chamber's living lenses (agent-authored canvas boards), newest first: each lens's id, when it was last updated, and any provenance (scope, maintaining Mind, reason). Read-only. NOT for authoring a lens (run the chamber-lens workflow) or retiring one (chamber_retire_lens).",
    inputSchema: noToolInputSchema,
    state_changing: false,
    async execute(_input, ctx) {
      try {
        const lenses = await listLenses(lensesDir());
        const rows = lenses.map((l) => ({
          id: l.id,
          updatedAt: l.updatedAt,
          ...(l.scope ? { scope: l.scope } : {}),
          ...(l.maintainingMind ? { maintainingMind: l.maintainingMind } : {}),
          ...(l.reason ? { reason: l.reason } : {}),
        }));
        emitJsonList(ctx, "lenses", rows);
      } catch (e) {
        emitResult(ctx, `chamber_list_lenses failed: ${errText(e)}`, true);
      }
    },
  };
}

const mindRetireSchema = z.object({ slug: z.string().min(1).max(64) });

// Mind retire seam: delete a Mind's record + SOUL.md, then refresh the roster and
// standing panels — the same mutate-then-refresh path the `retire` board action
// takes, exposed as a tool so an MCP client can retire a Mind (the minds noun
// otherwise has no management tool). retireMind asserts a safe slug and throws when
// the Mind is absent, so the refresh runs only after a real delete.
function makeRetireMindTool(): ToolDefinition {
  return {
    name: "chamber_retire_mind",
    description:
      "Retire a Mind: permanently remove an agent's record and SOUL.md from the roster. `slug` is the Mind's identifier (see chamber_list_minds). Fails closed if no such Mind exists. NOT for retiring a lens (chamber_retire_lens).",
    inputSchema: mindRetireSchema,
    state_changing: true,
    async execute(input, ctx) {
      const parsed = mindRetireSchema.safeParse(input);
      if (!parsed.success) {
        emitResult(ctx, `chamber_retire_mind: ${parsed.error.message}`, true);
        return;
      }
      const slug = parsed.data.slug.trim();
      try {
        await retireMind(mindsDir(), slug);
        invalidateRoster();
        await refreshWorkflow?.("chamber-roster")?.catch(() => {});
        await refreshStandingPanels({ removed: true });
        emitResult(ctx, JSON.stringify({ ok: true, slug }));
      } catch (e) {
        emitResult(ctx, `chamber_retire_mind failed: ${errText(e)}`, true);
      }
    },
  };
}

const roomDeleteSchema = z.object({ room: z.string().min(1) });

// Room delete seam: remove an ended room's directory (room.json + transcript +
// ledger), drop its panel, and refresh the sessions index — the same path the
// room-delete board action takes, exposed as a tool so an MCP client can clean up a
// finished room. Refuses an active room (stop it first); deleteRoom asserts a safe
// slug and throws when the room is absent, so this fails closed.
function makeRoomDeleteTool(): ToolDefinition {
  return {
    name: "chamber_room_delete",
    description:
      "Delete an ended Chamber room: permanently remove its record, transcript, and ledger. `room` is the room slug (see chamber_list_rooms). Stop an active room with chamber_room_stop before deleting it; fails closed if no such room exists. NOT for stopping a running room.",
    inputSchema: roomDeleteSchema,
    state_changing: true,
    async execute(input, ctx) {
      const parsed = roomDeleteSchema.safeParse(input);
      if (!parsed.success) {
        emitResult(ctx, `chamber_room_delete: ${parsed.error.message}`, true);
        return;
      }
      const slug = parsed.data.room.trim();
      if (activeRooms.has(slug)) {
        emitResult(
          ctx,
          "chamber_room_delete: stop the room before deleting it (chamber_room_stop).",
          true,
        );
        return;
      }
      try {
        await createFileRoomStore(roomsDir()).deleteRoom(slug);
        // Drop any lingering most-recent pin/panel for the deleted room (mirrors the
        // board action), then refresh the index card away — fail-soft on the seam.
        if (lastSlug === slug) lastSlug = undefined;
        reconcileRoomPanels();
        await refreshWorkflow?.("chamber-rooms")?.catch(() => {});
        await refreshStandingPanels({ removed: true });
        emitResult(ctx, JSON.stringify({ ok: true, slug }));
      } catch (e) {
        emitResult(ctx, `chamber_room_delete failed: ${errText(e)}`, true);
      }
    },
  };
}

// The room controls as chat tools — the second `step()` consumer the StepOutcome
// soundness (#10/#13) was built for. Fire-and-return: start kicks the existing
// auto-advance loop; status reads progress; say/stop steer a room — an explicit
// `room` slug, or by default the most-recent active one (the server assigns slugs).
// start self-gates on an in-tool `confirm` flag because each turn is a paid agent
// call (keelson chat has no pause-and-confirm gate yet — the OSDU lifecycle pattern).
function roomControlTools(store: RoomStore): ToolDefinition[] {
  return [
    {
      name: "chamber_room_status",
      description:
        'Use when the user asks what is happening in a Chamber room — "what are they saying", "show the room", "room status". Returns a room\'s participants, status, turn count, and the conversation so far. Defaults to the most-recent room; pass `room` (a slug) to read a specific one — a bare call also indexes the other active rooms when several run at once. Read-only. NOT for starting or stopping a room.',
      inputSchema: roomTargetSchema,
      state_changing: false,
      async execute(input, ctx) {
        try {
          const parsed = roomTargetSchema.safeParse(input);
          const target = parsed.success ? parsed.data.room : undefined;
          emitResult(ctx, await renderRoomStatus(store, target));
        } catch (e) {
          emitResult(ctx, `chamber_room_status failed: ${errText(e)}`, true);
        }
      },
    },
    {
      name: "chamber_room_start",
      description:
        'Open a Chamber room where the named agent Minds converse turn-by-turn (turnBudget paid agent turns total, default 8). Provide a `topic` to frame the discussion — strongly recommended, since it is what the first speaker responds to. For a moderated discussion set strategy:"group-chat" and a `moderator` Mind slug (a Mind NOT among participants — it routes who speaks and decides when to close); optional `synthesizer` authors a closing summary. For a cross-vendor review set strategy:"review" with exactly two participants pinned to different providers — the first authors an artifact, the second (a different vendor) reviews it. For a manager-led project set strategy:"magentic" and a `manager` Mind slug (a Mind NOT among participants — it plans a task ledger, delegates each task to a worker, and replans until the goal is met); the participants are the workers (at least two). State-changing: set confirm:true ONLY after the user has approved — without confirm the tool reports what it would start and runs nothing. participants are Mind slugs (see the Roster); needs at least two. Several rooms can run concurrently (up to a small cap) — stop one if the cap is reached. NOT for creating a Mind (that is the New agent / genesis action).',
      inputSchema: roomStartSchema,
      state_changing: true,
      requires_confirmation: true,
      async execute(input, ctx) {
        const parsed = roomStartSchema.safeParse(input);
        if (!parsed.success) {
          emitResult(ctx, `chamber_room_start: ${parsed.error.message}`, true);
          return;
        }
        const { participants, name } = parsed.data;
        const topic = (parsed.data.topic ?? "").trim() || undefined;
        const turnBudget = parsed.data.turnBudget ?? DEFAULT_ROOM_TURN_BUDGET;
        const confirm = parsed.data.confirm ?? false;
        const moderator = (parsed.data.moderator ?? "").trim() || undefined;
        const manager = (parsed.data.manager ?? "").trim() || undefined;
        // A `moderator` — or a `manager` — with no explicit strategy infers the
        // matching facilitated mode (group-chat / magentic) so validateStart enforces
        // its rules and the dry-run label below matches what actually starts (an
        // explicit strategy still wins; moderator takes precedence if both are set).
        const strategy =
          (parsed.data.strategy ?? "").trim() ||
          (moderator ? "group-chat" : manager ? "magentic" : "sequential");
        const synthesizer = (parsed.data.synthesizer ?? "").trim() || undefined;
        const minRounds = parsed.data.minRounds;
        const maxSpeakerRepeats = parsed.data.maxSpeakerRepeats;
        const endVoteThreshold = parsed.data.endVoteThreshold;
        const projectId = (parsed.data.projectId ?? "").trim() || undefined;
        const coding = parsed.data.coding ?? false;
        // Validate up front (including roster membership + group-chat moderator
        // rules + project resolution + the coding-tier project requirement) so the
        // dry-run never advertises a start the confirm path rejects.
        const valid = await validateStart(
          participants,
          turnBudget,
          strategy,
          {
            moderator,
            manager,
            synthesizer,
            minRounds,
            maxSpeakerRepeats,
            endVoteThreshold,
          },
          projectId,
          coding,
        );
        if (!valid.ok) {
          emitResult(ctx, `chamber_room_start: ${valid.error}`, true);
          return;
        }
        // Concurrency cap: refuse before the dry-run prompt so the tool never
        // advertises a start the confirm path would reject (startRoom enforces the
        // same cap authoritatively).
        if (activeRooms.size >= MAX_ACTIVE_ROOMS) {
          emitResult(
            ctx,
            `chamber_room_start: ${MAX_ACTIVE_ROOMS} rooms are already active (the concurrent cap) — stop one with chamber_room_stop first.`,
            true,
          );
          return;
        }
        const who = valid.participants.join(", ");
        const topicNote = topic ? ` on "${topic}"` : " (no topic set)";
        const modeNote =
          strategy === "group-chat" && moderator
            ? ` (group-chat, moderated by ${moderator})`
            : strategy === "magentic" && manager
              ? ` (magentic: ${manager} manages ${valid.participants.length} worker${valid.participants.length === 1 ? "" : "s"})`
              : strategy === "review"
                ? ` (review: ${valid.participants[0]} reviewed by ${valid.participants[1]})`
                : "";
        // validateStart confirmed the project resolves; name it so the operator sees
        // the repo the turns will run against.
        const projectNote = projectId
          ? ` in project "${resolveProject(projectId)?.name ?? projectId}"`
          : "";
        // Name the elevated capability at the confirm step so the human approving
        // the (paid) room knows a coding Mind can run Bash/Edit/Write.
        const codingNote = coding
          ? " with the coding tier ON (Minds that declare `code`/`read` can run Bash/Edit/Write/Read, confined to the project repo)"
          : "";
        if (!confirm) {
          emitResult(
            ctx,
            `Would open a room with ${who}${topicNote}${modeNote}${projectNote}${codingNote} for ${turnBudget} turns (each turn is a paid agent call). Re-call chamber_room_start with confirm:true once the user approves.`,
          );
          return;
        }
        // A user abort during the awaits above must not still open a paid room.
        if (ctx.abortSignal.aborted) return;
        const res = await startRoom({
          participants,
          turnBudget,
          name,
          topic,
          strategy,
          projectId,
          coding,
          moderator,
          manager,
          synthesizer,
          minRounds,
          maxSpeakerRepeats,
          endVoteThreshold,
        });
        if (res.ok) {
          const slug = (res.data as { slug?: string } | undefined)?.slug ?? "";
          emitResult(
            ctx,
            `Opened room "${slug}" with ${who}. It auto-advances — watch the Chamber surface or call chamber_room_status to read progress.`,
          );
        } else {
          emitResult(ctx, `chamber_room_start failed: ${res.error}`, true);
        }
      },
    },
    {
      name: "chamber_room_say",
      description:
        'Steer a Chamber room: `direction` sets guidance for the next speaker, `callOn` nominates a specific Mind to go next, `text` drops a director message into the transcript. Defaults to the most-recent active room; pass `room` (a slug) to steer a specific one when several run at once. Use when the user wants to nudge the conversation ("tell them to wrap up", "let Alice answer"). At least one of direction/callOn/text required. NOT for starting or stopping the room.',
      inputSchema: roomSaySchema,
      state_changing: true,
      async execute(input, ctx) {
        const parsed = roomSaySchema.safeParse(input);
        if (!parsed.success) {
          emitResult(ctx, `chamber_room_say: ${parsed.error.message}`, true);
          return;
        }
        const target = resolveSteerTarget(parsed.data.room);
        if ("error" in target) {
          emitResult(ctx, target.error, true);
          return;
        }
        const slug = target.slug;
        const { direction, callOn, text } = parsed.data;
        // The driver only honors nextSpeaker when it exactly matches an active
        // participant slug — otherwise step() silently drops it and falls back to
        // the strategy. Reject up front so the tool can't report a dropped
        // nomination ("Alice" vs "alice", a typo, a non-participant) as sent.
        if (callOn) {
          const room = await store.loadRoom(slug);
          // magentic routes turns by the manager's ledger, so a forced speaker would run
          // an off-plan turn that settles no task (step() also ignores the override for
          // magentic) — reject it here and point the operator at `direction`, which steers
          // the manager, instead of reporting a dropped nomination as sent.
          if (room?.strategy === "magentic") {
            emitResult(
              ctx,
              "chamber_room_say: a magentic room routes turns by its manager — use `direction` to steer the plan, not `callOn`.",
              true,
            );
            return;
          }
          if (!room?.participants.includes(callOn)) {
            emitResult(
              ctx,
              `chamber_room_say: "${callOn}" is not a participant — call on one of the room's Minds.`,
              true,
            );
            return;
          }
        }
        // injectRoom does the truthiness filtering; pass the fields straight through.
        const res = await injectRoom(slug, {
          directionInjection: direction,
          nextSpeaker: callOn,
          text,
        });
        const note = roomNote(slug);
        emitResult(
          ctx,
          res.ok ? `Sent to the room${note}.` : `chamber_room_say failed: ${res.error}`,
          !res.ok,
        );
      },
    },
    {
      name: "chamber_room_stop",
      description:
        'Stop a Chamber room (halts its turns). Defaults to the most-recent active room; pass `room` (a slug) to stop a specific one when several run at once. Use when the user says "stop the room", "end it". Reversible — a new room can be started afterward. NOT for retiring a Mind.',
      inputSchema: roomTargetSchema,
      state_changing: true,
      async execute(input, ctx) {
        const parsed = roomTargetSchema.safeParse(input);
        const target = resolveSteerTarget(parsed.success ? parsed.data.room : undefined);
        if ("error" in target) {
          emitResult(ctx, target.error, true);
          return;
        }
        // Compute the note before stopRoom drops the slug from the active set.
        const note = roomNote(target.slug);
        const res = await stopRoom(target.slug);
        emitResult(
          ctx,
          res.ok ? `Stopped the room${note}.` : `chamber_room_stop failed: ${res.error}`,
          !res.ok,
        );
      },
    },
  ];
}

export default rib;
