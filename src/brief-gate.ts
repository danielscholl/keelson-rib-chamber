import type { CanvasBoardView, RibContext, SnapshotManager } from "@keelson/shared";
import { errText, expectView } from "@keelson/shared";
import { recordSection } from "./boards/activity.ts";
import { buildChamberState, type ChamberDelta, diffAgainstWatermark } from "./chamber-state.ts";
import { readDigest } from "./digest-store.ts";
import { parseBoard } from "./json-recovery.ts";
import { BRIEF_KEY } from "./keys.ts";
import { isExhibit, listLenses } from "./lens-store.ts";
import { listMindRecords } from "./minds-store.ts";
import { chamberDataHome, lensesDir, mindsDir, roomsDir } from "./paths.ts";
import { BRIEF_PROMPT } from "./prompts.ts";
import { createCoalescingPublisher } from "./room-publisher.ts";
import { listRooms } from "./room-store.ts";
import { readWatermark, writeWatermark } from "./watermark-store.ts";

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
// The Briefing banner is the surface's one narrator: three registers composed
// in-process (the banner is rib-driven, not a collector) — the promoted delta (from
// the last paid brief turn, held here), the standing digest (read from digest.json),
// and the always-on record (the activity feed tail). `promotedDelta` holds the delta
// turn's sections so a record/digest refresh re-assembles the banner without re-running
// the paid turn; `promotedCount` is the "N new" the header shows.
let promotedDelta: CanvasBoardView["sections"] | undefined;
let promotedCount = 0;
// The structured origins of the promoted delta, resolved at promote time from the
// gate's own slugs/ids (never parsed from the agent-authored prose) and rendered as
// "Open what changed" jump chips beneath the delta register. Lives and lapses with
// promotedDelta.
interface PromotedSource {
  kind: "room" | "lens";
  label: string;
  ref: string;
}
let promotedSources: readonly PromotedSource[] = [];
// Serializes banner re-publishes so a mutation-driven refresh and a gate promote can't
// interleave two composes onto one publish; reset on dispose.
let briefingPublishInFlight: Promise<void> = Promise.resolve();

// The synchronous seed the banner holds for the instant between registration and the
// first async compose (createCoalescingPublisher needs a sync default). A valid, calm
// board; publishBriefing() replaces it with the composed three-register banner.
function seedBriefingBoard(): CanvasBoardView {
  return {
    view: "board",
    title: "Briefing",
    header: { status: { label: "Up to date", tone: "neutral" } },
    sections: [{ kind: "rows", title: "The record", items: [{ glyph: "neutral", text: "…" }] }],
  };
}

// The record register's cap in the always-on banner: fewer rows than the store-level
// default so the heartbeat stays a glance, not a scrollable log.
const BANNER_RECORD_LIMIT = 4;

// The one narrator, composed in-process from three producers and published to
// BRIEF_KEY. Attention-ordered top to bottom: the delta leads (what's new since you
// last looked), the digest interprets (the standing synthesis), the record grounds
// (recent events). Quiet is STRUCTURAL — a register renders only when it has something
// to say: the delta only when promoted, the digest only once the chamber has content
// (sparse = absent, never narrated), the record always (a single hint line on a fresh
// chamber). No paid turn runs here — the delta and digest are read from where their
// (separately gated) turns already wrote.
async function composeBriefingBoard(): Promise<CanvasBoardView> {
  const [mindRecords, rooms, lenses, digest] = await Promise.all([
    listMindRecords(mindsDir()).catch(() => []),
    listRooms(roomsDir()).catch(() => []),
    listLenses(lensesDir()).catch(() => []),
    readDigest().catch(() => null),
  ]);
  const sections: CanvasBoardView["sections"] = [];

  // 1. Delta — the promoted brief turn's content, labelled on its first section,
  //    followed by its deterministic jump chips (from the gate's structured delta,
  //    reusing the index cards' own open verbs — the prose stays the narrative,
  //    the chips are only the way there).
  if (promotedDelta && promotedDelta.length > 0) {
    const [first, ...rest] = promotedDelta;
    if (first) sections.push({ ...first, title: "Since you last looked" }, ...rest);
    if (promotedSources.length > 0) {
      sections.push({
        kind: "actions",
        title: "Open what changed",
        wrap: true,
        items: promotedSources.map((s) =>
          s.kind === "room"
            ? { type: "room-open", label: `${s.label} ↗`, glyph: "▦", payload: { slug: s.ref } }
            : { type: "lens-open", label: `${s.label} ↗`, glyph: "❖", payload: { id: s.ref } },
        ),
      });
    }
  }

  // 2. Digest — the standing synthesis, only once the chamber has content. Drop any
  //    stats section the turn may have authored so an index count can't creep back
  //    into the one narrator; label the register on its first surviving section.
  const hasContent = mindRecords.length > 0 || rooms.length > 0 || lenses.length > 0;
  if (hasContent && digest?.board) {
    // readDigest only checks `board` is an object; guard `sections` so a torn digest.json
    // can't throw here and drop the WHOLE banner publish (delta + record too).
    const digestSections = Array.isArray(digest.board.sections) ? digest.board.sections : [];
    const kept = digestSections.filter((s) => s.kind !== "stats");
    const [first, ...rest] = kept;
    if (first) sections.push({ ...first, title: "Digest" }, ...rest);
  }

  // 3. Record — always present.
  sections.push(recordSection(mindRecords, rooms, lenses, Date.now(), BANNER_RECORD_LIMIT));

  return {
    view: "board",
    title: "Briefing",
    header: {
      status:
        promotedCount > 0
          ? { label: `${promotedCount} new`, tone: "brand" }
          : { label: "Up to date", tone: "neutral" },
    },
    sections,
  };
}

// Re-compose and publish the banner. Serialized so a mutation-driven refresh and a gate
// promote can't race two composes onto one publish; never throws into a fire-and-forget
// caller. A no-op when the publisher seam is absent (older harness).
export function publishBriefing(): Promise<void> {
  const run = async (): Promise<void> => {
    if (!briefPublisher) return;
    try {
      await briefPublisher.publish(await composeBriefingBoard());
    } catch (e) {
      console.error(`[rib-chamber] briefing publish failed: ${errText(e)}`);
    }
  };
  const next = briefingPublishInFlight.then(run, run);
  briefingPublishInFlight = next.catch(() => {});
  return next;
}

// The brief turn's budget. A briefing is a single composing turn (no tools), so a
// modest ceiling bounds a wedged provider without starving a normal compose.
const BRIEF_TURN_TIMEOUT_MS = 60_000;

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
  // Seam absent (older harness, or a ctx without the snapshot/turn seams): the banner
  // keeps whatever board it has (the boot-seeded quiet one) and no turn ever runs.
  if (!briefPublisher || !briefRunAgentTurn) return;
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

  // Quiet: nothing new since the watermark. If the delta register was promoted, lapse
  // it (the digest + record stay) and clear the flag; otherwise this is an idempotent
  // no-op — no write, and (the headline invariant) NO turn.
  if (!delta.hasSubstance) {
    if (watermark.briefPromoted) {
      try {
        promotedDelta = undefined;
        promotedCount = 0;
        promotedSources = [];
        await writeWatermark({
          ...watermark,
          briefPromoted: false,
          updatedAt: new Date().toISOString(),
        });
        await publishBriefing();
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
  let sources: PromotedSource[];
  try {
    ({ prompt, sources } = await composeBriefPrompt(delta));
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
    // The turn authored a board; its sections become the delta register, labelled and
    // wrapped with the digest + record by composeBriefingBoard. Store the count so the
    // header reads "N new", and the resolved sources so the register carries its
    // deterministic jump chips.
    promotedDelta = board.sections;
    promotedCount = delta.newlyEndedRooms.length + delta.changedOrNewLenses.length;
    promotedSources = sources;
    await writeWatermark({
      ackedEndedRooms: state.endedRoomSlugs,
      lensFingerprints: state.lensFingerprints,
      briefPromoted: true,
      updatedAt: new Date().toISOString(),
    });
    await publishBriefing();
  } catch (e) {
    // Stored the delta but the watermark write failed: the banner is live, but a later
    // trigger may re-promote. Logged; never thrown into a fire-and-forget hook.
    console.error(`[rib-chamber] brief watermark advance failed: ${errText(e)}`);
  }
}

// The promote prompt: the standing brief core plus a delta block naming what changed
// since the last briefing — ended rooms by name/status/turns and changed/new lenses
// by id + scope/reason. METADATA ONLY (no transcript text) so a briefing never reads
// a room's content. Reads the rooms/lenses once on the promote path (rare, and a paid
// turn is about to run anyway) to resolve the slugs/ids the delta carries to metadata
// — the same read also yields the structured `sources` the banner renders as jump
// chips, so the chips can never name anything the prompt didn't.
async function composeBriefPrompt(
  delta: ChamberDelta,
): Promise<{ prompt: string; sources: PromotedSource[] }> {
  const lines: string[] = [];
  const sources: PromotedSource[] = [];
  if (delta.newlyEndedRooms.length > 0) {
    const rooms = await listRooms(roomsDir());
    const bySlug = new Map(rooms.map((r) => [r.slug, r]));
    lines.push("Rooms that ended since the last briefing:");
    for (const slug of delta.newlyEndedRooms) {
      const room = bySlug.get(slug);
      if (!room) continue;
      lines.push(`  - ${room.name} (${room.status}, ${room.turnIndex} turns)`);
      sources.push({ kind: "room", label: room.name || room.slug, ref: slug });
    }
  }
  if (delta.changedOrNewLenses.length > 0) {
    const lenses = await listLenses(lensesDir());
    const byId = new Map(lenses.map((l) => [l.id, l]));
    lines.push("Lenses authored or exhibits tabled since the last briefing:");
    for (const id of delta.changedOrNewLenses) {
      const lens = byId.get(id);
      const detail = lens
        ? [
            isExhibit(lens)
              ? `exhibit${lens.sourceRoom ? ` from room ${lens.sourceRoom}` : ""}`
              : undefined,
            lens.scope,
            lens.reason,
          ]
            .filter((s): s is string => Boolean(s))
            .join(" — ")
        : "";
      lines.push(`  - ${id}${detail ? ` (${detail})` : ""}`);
      // A lens retired between the diff and this read has no live key left to open.
      if (lens) sources.push({ kind: "lens", label: lens.board.title || id, ref: id });
    }
  }
  if (lines.length === 0) return { prompt: BRIEF_PROMPT, sources };
  return {
    prompt: `${BRIEF_PROMPT}

What's new since the last briefing — lead the briefing with these, honestly (do NOT invent detail beyond what is listed):
${lines.join("\n")}`,
    sources,
  };
}

// Boot reconciliation: the banner is re-seeded with the quiet board on every
// registerTools, so a persisted briefPromoted:true must be cleared or the roster
// pulse ("For you") would advertise a waiting briefing the quiet banner doesn't have.
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

// Bind the briefing gate's seams — called unconditionally on every registerTools so a
// (re-)boot reopens the gate with a fresh abort controller (the prior, aborted one stays
// bound to any orphaned in-flight turn, keeping it gated out). When the snapshot + agent-
// turn seams are present, (re)wire the coalescing BRIEF_KEY publisher: seed the banner with
// the quiet board, prime the key, publish the composed banner, and clear a persisted
// briefPromoted so the roster pulse and the empty delta agree from boot.
export function bindBriefGate(seams: {
  sm?: SnapshotManager;
  runAgentTurn?: RibContext["runAgentTurn"];
}): void {
  briefAbort = new AbortController();
  const { sm, runAgentTurn: run } = seams;
  if (sm && run && (sm !== briefSm || !briefPublisher)) {
    briefUnregister?.();
    const { publisher, latest } = createCoalescingPublisher(
      () => sm.recompose(BRIEF_KEY),
      seedBriefingBoard(),
    );
    briefUnregister = sm.register(BRIEF_KEY, latest, {
      validate: expectView(BRIEF_KEY, "board"),
    });
    briefPublisher = publisher;
    briefSm = sm;
    briefRunAgentTurn = run;
    promotedDelta = undefined;
    promotedCount = 0;
    promotedSources = [];
    void sm.recompose(BRIEF_KEY);
    void publishBriefing();
    briefInFlight = briefInFlight.then(clearPersistedBriefPromoted, clearPersistedBriefPromoted);
  }
}

// Tear down the briefing gate: drop the publisher registration, abort the in-flight (paid)
// turn (its post-turn signal re-check then drops any late publish/write), and reset the
// serialization chains + in-memory registers so a re-boot starts fresh.
export function disposeBriefGate(): void {
  briefUnregister?.();
  briefUnregister = undefined;
  briefPublisher = undefined;
  briefSm = undefined;
  briefRunAgentTurn = undefined;
  briefAbort.abort();
  briefInFlight = Promise.resolve();
  promotedDelta = undefined;
  promotedCount = 0;
  promotedSources = [];
  briefingPublishInFlight = Promise.resolve();
}
