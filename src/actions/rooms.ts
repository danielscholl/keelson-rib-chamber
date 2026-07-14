import type { RibAction, RibActionResult } from "@keelson/shared";
import { asNonEmptyString, asStringArray, errText } from "@keelson/shared";
import { buildRoomBoard } from "../boards/room.ts";
import { roomViewKey } from "../keys.ts";
import { tabledExhibitsFor } from "../lens-runtime.ts";
import { readMinds } from "../minds-store.ts";
import { mindsDir, roomsDir } from "../paths.ts";
import { readPendingGeneses } from "../pending-genesis.ts";
import { normalizeGrounding, parseCriteriaLines, roomConfigFromFlat } from "../room-config.ts";
import { clearDraft, readDraft, toggleSelected } from "../room-draft.ts";
import {
  DEFAULT_ROOM_TURN_BUDGET,
  getDriver,
  getRoomManager,
  injectRoom,
  isRoomActive,
  isSafeSlug,
  isValidParticipant,
  noteRoomDeleted,
  publishRoomView,
  ROOM_DISABLED,
  startRoom,
  stopRoom,
} from "../room-lifecycle.ts";
import { roomKey } from "../room-region-registry.ts";
import { createFileRoomStore, deriveRoomName } from "../room-store.ts";
import type { OutcomeSplit } from "../room-text.ts";
import { splitOutcome } from "../room-text.ts";
import { stripControlJson } from "../routing.ts";
import {
  refreshPresence,
  refreshStandingPanels,
  refreshWorkflow,
  resolveMindByNameOrId,
  resolveMinds,
  resolveProjectInput,
  resolveProjectName,
} from "../runtime.ts";
import type { Mind, Room } from "../types.ts";

export function roomStartAction(action: RibAction): Promise<RibActionResult> {
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  // Routing config arrives as flat payload keys — a board action's collected
  // `fields` (base #120) merge in flat, so `moderator`/`endVoteThreshold` etc. are
  // plain keys, not nested. roomConfigFromFlat owns that flat-key contract, and the
  // grounding brief follows the same flat shape (`groundingUrl` + one-per-line `criteria`).
  const grounding = normalizeGrounding({
    sourceUrl: asNonEmptyString(payload.groundingUrl),
    criteria: parseCriteriaLines(asNonEmptyString(payload.criteria)),
  });
  return startRoom({
    participants: asStringArray(payload.participants),
    turnBudget: typeof payload.turnBudget === "number" ? payload.turnBudget : 0,
    name: asNonEmptyString(payload.name) || undefined,
    strategy: asNonEmptyString(payload.strategy) || undefined,
    topic: asNonEmptyString(payload.topic) || undefined,
    ...(grounding ? { grounding } : {}),
    projectId: asNonEmptyString(payload.projectId) || undefined,
    coding: payload.coding === true,
    ...roomConfigFromFlat(payload),
  });
}

// Seat or unseat one Mind at the table (toggle its membership in the inclusion draft).
// The slug must name a real, current Mind (validated against the live roster, not just
// shape) so a stale/forged seat toggle can't write an unknown slug into the draft. On
// success recompose the Chamber panel so the seat re-renders with the new glyph and the
// shape gating re-evaluates against the new cast. Returns the new selection.
export async function draftSetAction(action: RibAction): Promise<RibActionResult> {
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
    const draft = await toggleSelected(slug);
    refreshPresence();
    return { ok: true, data: { selected: [...draft.selected] } };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

// Convene a room from the current draft and the chosen shape: participants are the Minds
// seated at the table (the inclusion draft) minus the named facilitator — a Debate chair
// / Delegate manager is one of the seated Minds, pulled out of the cast so it routes/plans
// rather than speaks/works. The room shape (a `strategy` in the action payload) and its
// per-shape fields (topic, project, moderator, manager, turns) come from the shape action
// the operator clicked. Reuses the room start path (startRoom → validateStart → driver),
// so the <2-participant / facilitator-rules / cross-vendor / seam-absent guards aren't
// duplicated here — a shape the cast can't satisfy (nobody seated, a Review that isn't a
// cross-vendor pair, a Debate whose moderator is also a participant) surfaces
// validateStart's error. On success clear the draft (leave assembly, empty the cast) and
// recompose the Chamber panel so the composer folds away (a room now exists).
export async function conveneAction(action: RibAction): Promise<RibActionResult> {
  const driver = getDriver();
  if (!driver || driver.isDisposed()) return ROOM_DISABLED;
  // Can't convene while a Mind is being authored: the Chamber panel ticks during a
  // genesis (aging the boot card), so the composer is suppressed on-screen while one is
  // pending — this is the server-side backstop for a stale Convene click racing a genesis.
  const pending = await readPendingGeneses().catch(() => []);
  if (pending.length > 0) {
    return {
      ok: false,
      error: "can't convene while a Mind is being authored — wait for genesis to finish",
    };
  }
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  let allMinds: Mind[];
  let draftedMinds: Mind[];
  try {
    const draft = await readDraft();
    allMinds = await readMinds(mindsDir());
    draftedMinds = allMinds.filter((m) => draft.selected.has(m.slug));
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
  const strategy = asNonEmptyString(payload.strategy) || "sequential";
  const topic = asNonEmptyString(payload.topic) || undefined;
  // Grounding is a source URL plus one criterion per line of the criteria field; an
  // empty/whitespace pair normalizes to no grounding (the convene default is ungrounded).
  const grounding = normalizeGrounding({
    sourceUrl: asNonEmptyString(payload.groundingUrl),
    criteria: parseCriteriaLines(asNonEmptyString(payload.criteria)),
  });

  const projectInput = asNonEmptyString(payload.project);
  let projectId: string | undefined;
  if (projectInput) {
    const resolved = resolveProjectInput(projectInput);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    projectId = resolved.project.id;
  }

  // Moderator (Debate) and manager (Build) are Mind name-or-slug free text; resolve
  // each to a slug so validateStart's facilitator rules apply. An unresolvable
  // non-empty value is surfaced, not silently dropped.
  const resolveFacilitator = (
    input: string | undefined,
    role: string,
  ): { slug?: string } | { error: string } => {
    if (!input) return {};
    const slug = resolveMindByNameOrId(allMinds, input);
    return slug ? { slug } : { error: `unknown ${role} "${input}" — name a Mind from the roster` };
  };
  const mod = resolveFacilitator(asNonEmptyString(payload.moderator), "moderator");
  if ("error" in mod) return { ok: false, error: mod.error };
  const mgr = resolveFacilitator(asNonEmptyString(payload.manager), "manager");
  if ("error" in mgr) return { ok: false, error: mgr.error };

  // The facilitator (Debate chair / Delegate manager) is one of the selected Minds;
  // pull it out of the participant set so validateStart's "the facilitator must not
  // also be a participant" rule holds — it routes/plans, it does not speak/work.
  const facilitator = mod.slug ?? mgr.slug;
  const roomMinds = facilitator ? draftedMinds.filter((m) => m.slug !== facilitator) : draftedMinds;
  const participants = roomMinds.map((m) => m.slug);
  const displayNames = roomMinds.map((m) => m.name);

  // Turns: free text -> a positive integer, else the default; validateStart caps it.
  const turnsRaw = asNonEmptyString(payload.turns);
  const parsedTurns = turnsRaw ? Number.parseInt(turnsRaw, 10) : Number.NaN;
  const turnBudget =
    Number.isInteger(parsedTurns) && parsedTurns > 0 ? parsedTurns : DEFAULT_ROOM_TURN_BUDGET;

  const res = await startRoom({
    name: deriveRoomName(topic, displayNames),
    strategy,
    participants,
    turnBudget,
    topic,
    ...(grounding ? { grounding } : {}),
    ...(projectId ? { projectId } : {}),
    ...(mod.slug ? { moderator: mod.slug } : {}),
    ...(mgr.slug ? { manager: mgr.slug } : {}),
  });
  if (res.ok) {
    await clearDraft().catch(() => {});
    refreshPresence();
  }
  return res;
}

export async function roomInjectAction(action: RibAction): Promise<RibActionResult> {
  const resolved = requireRoomSlug(action);
  if ("error" in resolved) return resolved.error;
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  return injectRoom(resolved.slug, {
    directionInjection: asNonEmptyString(payload.directionInjection) || undefined,
    nextSpeaker: asNonEmptyString(payload.nextSpeaker) || undefined,
    text: asNonEmptyString(payload.text) || undefined,
  });
}

export async function roomStopAction(action: RibAction): Promise<RibActionResult> {
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
export async function roomDeleteAction(action: RibAction): Promise<RibActionResult> {
  const resolved = requireRoomSlug(action);
  if ("error" in resolved) return resolved.error;
  const slug = resolved.slug;
  if (isRoomActive(slug)) {
    return { ok: false, error: "stop the room before deleting it" };
  }
  try {
    await createFileRoomStore(roomsDir()).deleteRoom(slug);
    // Drop any lingering panel/most-recent pin for the deleted room, then refresh
    // the index card away (fail-soft — the seam resolves on error / is absent on an
    // older harness, where the 120s cadence drops the card).
    noteRoomDeleted(slug);
    await refreshWorkflow("chamber-rooms").catch(() => {});
    await refreshStandingPanels();
    return { ok: true, data: { slug } };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

// Open a room from the index. A LIVE room focuses the key its driver already publishes
// to, so the drawer streams turns as they land; rebuilding a frozen copy would race the
// driver for the same board. A CLOSED room has no such key, so its board is rebuilt from
// the persisted transcript and published to its own room-view key. Either way the board
// carries the room's Start-again / group-chat / open-floor controls, so a past session can
// be relaunched from the drawer. Fails closed on a missing/unsafe slug, an unknown room,
// or an absent room seam.
export async function roomOpenAction(action: RibAction): Promise<RibActionResult> {
  const resolved = requireRoomSlug(action);
  if ("error" in resolved) return resolved.error;
  const sm = getRoomManager();
  if (!sm) return ROOM_DISABLED;
  try {
    const store = createFileRoomStore(roomsDir());
    const room = await store.loadRoom(resolved.slug);
    if (!room) return { ok: false, error: `room '${resolved.slug}' not found` };
    // Liveness is the driver's in-memory set, never room.status: a crash leaves a room
    // "active" on disk with no key ever registered for it, and keys register lazily on
    // publish with nothing replaying them at boot. A stale-active room must take the
    // frozen path or Open would hand back a key that does not exist.
    if (isRoomActive(resolved.slug)) {
      return {
        ok: true,
        data: { effect: "open-canvas", key: roomKey(resolved.slug), title: room.name },
      };
    }
    const transcript = await store.loadTranscript(resolved.slug);
    // A magentic room's plan lives in its ledger; load it so a reopened closed room
    // renders the Plan section, not just the transcript (the live board does the same).
    const ledger = room.strategy === "magentic" ? await store.loadLedger(resolved.slug) : undefined;
    const minds = await resolveMinds();
    const projectName = room.projectId ? resolveProjectName(room.projectId) : undefined;
    const tabled = await tabledExhibitsFor(resolved.slug);
    const board = buildRoomBoard(
      room,
      transcript,
      ledger,
      minds,
      projectName ?? room.projectId,
      tabled,
    );
    await publishRoomView(resolved.slug, board);
    return {
      ok: true,
      data: { effect: "open-canvas", key: roomViewKey(resolved.slug), title: room.name },
    };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

// Load a room's synthesized outcome document (the last agent turn, split at its
// own `---`/`##` boundary — see room-text.ts). An error names why there isn't
// one yet (no such room, or a room that hasn't produced a document) rather than
// silently degrading, since both outcome actions are refused without one.
async function loadRoomOutcome(
  slug: string,
): Promise<{ room: Room; outcome: OutcomeSplit } | { error: string }> {
  const store = createFileRoomStore(roomsDir());
  const room = await store.loadRoom(slug);
  if (!room) return { error: `room '${slug}' not found` };
  const transcript = await store.loadTranscript(slug);
  const last = [...transcript].reverse().find((e) => e.role === "agent");
  const text = last ? stripControlJson(last.parts.map((p) => p.text).join("\n")) : "";
  const { outcome } = splitOutcome(text);
  if (!outcome) return { error: `room '${slug}' has no synthesized outcome document yet` };
  return { room, outcome };
}

// Copy the room's outcome document as markdown. The outcome card's field sets
// this as its `copyAction` (canvas.ts): the host fetches it on click and writes
// the returned string straight to the clipboard, so the full document never
// rides the board payload — the same seam osdu's credential reveal uses.
export async function outcomeCopyAction(action: RibAction): Promise<RibActionResult> {
  const resolved = requireRoomSlug(action);
  if ("error" in resolved) return resolved.error;
  try {
    const found = await loadRoomOutcome(resolved.slug);
    if ("error" in found) return { ok: false, error: found.error };
    return { ok: true, data: `## ${found.outcome.title}\n\n${found.outcome.body}` };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

// openChatSeedSchema's systemPrompt cap (@keelson/shared). OUTCOME_SEED_BUDGET
// is headroom reserved for the framing preamble so the document body is
// truncated by US in the common case; MAX_SEED_PROMPT is a hard backstop on
// the FINAL assembled string (mirrors compose.ts's stackMindPrompt, which
// every other seed-builder goes through) — a room with an unusually long
// explicit name (roomStartSchema.name carries no length cap) must not blow
// past the schema's own max and turn Explore-in-chat into a raw validation
// error.
const MAX_SEED_PROMPT = 8000;
const OUTCOME_SEED_BUDGET = 7500;

// Explore the outcome in a fresh chat — the same surface→chat handoff every ✦
// "Explore in chat" verb uses (mirrors enterMindAction): seed a new
// conversation with the document so the operator can interrogate it or draft
// the next artifact from it.
export async function outcomeExploreAction(action: RibAction): Promise<RibActionResult> {
  const resolved = requireRoomSlug(action);
  if ("error" in resolved) return resolved.error;
  try {
    const found = await loadRoomOutcome(resolved.slug);
    if ("error" in found) return { ok: false, error: found.error };
    const { room, outcome } = found;
    const preamble = `The room "${room.name}" produced this outcome document. Help the operator explore it, answer questions about it, or draft the next artifact from it.\n\n## ${outcome.title}\n\n`;
    const body = outcome.body.slice(0, Math.max(0, OUTCOME_SEED_BUDGET - preamble.length));
    const systemPrompt = `${preamble}${body}`.slice(0, MAX_SEED_PROMPT);
    return {
      ok: true,
      data: { effect: "open-chat", seed: { systemPrompt, name: outcome.title.slice(0, 80) } },
    };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
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
