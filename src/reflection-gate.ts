import type { RibContext } from "@keelson/shared";
import { errText, z } from "@keelson/shared";
import { parseBoard } from "./json-recovery.ts";
import { appendLog, MEMORY_DOC_CAP, readMindDoc, readSoul, writeMemory } from "./minds-store.ts";
import { chamberDataHome, mindsDir } from "./paths.ts";
import { resolveMinds } from "./runtime.ts";
import { renderTranscript } from "./transcript.ts";
import type { Mind, Room, TurnEntry } from "./types.ts";

// The reflection gate's seams + state, captured in registerTools alongside the brief
// gate's. reflectRunAgentTurn is the (paid) turn each participating Mind runs at a
// room's close to curate its own memory.md; undefined when the agent-turn seam is
// absent (older harness), where a room closes with no reflection. reflectAbort aborts
// in-flight reflection on dispose (mirrors briefAbort). reflectWrites serializes a
// Mind's memory writes so two rooms closing at once that share it can't lose-update.
let reflectRunAgentTurn: RibContext["runAgentTurn"];
let reflectAbort = new AbortController();
const reflectWrites = new Map<string, Promise<unknown>>();

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
export function onRoomClosed(room: Room, transcript: readonly TurnEntry[]): void {
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

// Install a fresh abort controller for this boot — called unconditionally on every
// registerTools (before the seam guard) so a re-boot's reflection turns aren't
// pre-aborted, while any orphaned pre-dispose turn stays bound to the prior, aborted
// controller and gated out. Mirrors bindBriefGate's per-boot briefAbort reset.
export function resetReflectionAbort(): void {
  reflectAbort = new AbortController();
}

// Capture the agent-turn seam for the close-only reflection pass — the same run the
// room driver uses for its turns. Called ONLY inside the full room guard (sm +
// registerRegion + run), so a host missing those closes rooms without reflection.
export function bindReflectionGate(seams: { runAgentTurn: RibContext["runAgentTurn"] }): void {
  reflectRunAgentTurn = seams.runAgentTurn;
}

// Tear down the reflection gate: drop the seam, abort in-flight reflection and drain
// its writes so a late memory write can't land after teardown, then reset the per-Mind
// write chains for the next boot.
export async function disposeReflectionGate(): Promise<void> {
  reflectRunAgentTurn = undefined;
  reflectAbort.abort();
  await Promise.allSettled([...reflectWrites.values()]);
  reflectWrites.clear();
}
