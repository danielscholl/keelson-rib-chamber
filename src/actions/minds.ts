import type { RibAction, RibActionResult } from "@keelson/shared";
import { asNonEmptyString, errText } from "@keelson/shared";
import { buildSeedFor } from "../compose.ts";
import { retireMind, setMindModel } from "../minds-store.ts";
import { mindsDir } from "../paths.ts";
import { clearPendingGenesis, removePendingGenesisAt } from "../pending-genesis.ts";
import {
  beginGenesis,
  invalidateRoster,
  refreshStandingPanels,
  refreshWorkflow,
  resolveMinds,
  stopGenesisTick,
} from "../runtime.ts";
import { GENESIS_STARTERS } from "../starters.ts";

// Open a mind as a seeded chat: compose its soul into a system prompt and hand
// the harness an "open-chat" directive (the generic seam the SPA interprets to
// start a fresh seeded conversation). Read-only against minds/ — resolving via
// resolveMinds() returns the unknown-mind error on a retire-then-enter race.
export async function enterMindAction(action: RibAction): Promise<RibActionResult> {
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
export async function authorArchetypeAction(action: RibAction): Promise<RibActionResult> {
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  const slug = asNonEmptyString(payload.slug);
  const starter = GENESIS_STARTERS.find((s) => s.slug === slug);
  if (!starter) return { ok: false, error: `unknown archetype: ${slug || "(none)"}` };
  // A starter's name/role are known now (pinned as inputs), so the boot card can show
  // them; stay on the surface (stay: true) so the operator watches the seat fill.
  const genesisId = await beginGenesis({ name: starter.name, role: starter.role });
  return {
    ok: true,
    data: {
      effect: "run-workflow",
      workflow: "chamber-genesis",
      stay: true,
      args: {
        ARGUMENTS: starter.voiceDescription,
        name: starter.name,
        role: starter.role,
        voice: starter.voice,
        ...(genesisId ? { genesisId } : {}),
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
export async function describeOwnAction(action: RibAction): Promise<RibActionResult> {
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  const brief = asNonEmptyString(payload.brief);
  if (!brief) return { ok: false, error: "Describe the Mind first — who should it feel like?" };
  // A freeform brief has no name/role yet (the workflow authors them), so the boot card
  // holds "calibrating…"; stay on the surface so the operator watches the seat fill.
  // Its marker is unnamed, so the threaded id is the only thing that ties this landing
  // back to this card when freeform geneses run in parallel.
  const genesisId = await beginGenesis({});
  return {
    ok: true,
    data: {
      effect: "run-workflow",
      workflow: "chamber-genesis",
      stay: true,
      args: {
        ARGUMENTS: brief.slice(0, MAX_BRIEF_CHARS),
        ...(genesisId ? { genesisId } : {}),
      },
    },
  };
}

// Dismiss a stalled (or unwanted) genesis boot card: settle the one marker the card's
// payload names (its startedAt stamp), falling back to clearing them all for a legacy
// dispatch without one; stop the tick when nothing is left in flight; refresh the
// roster so the seat frees back to the launchpad. Deterministic and free — not paid.
export async function dismissGenesisAction(action?: RibAction): Promise<RibActionResult> {
  const payload = (action?.payload ?? {}) as Record<string, unknown>;
  const startedAt = asNonEmptyString(payload.startedAt);
  // Stop the tick only after a real removal reports nothing left. A failed remove
  // must not be read as "none remain" — that freezes still-pending sibling cards
  // before they reach the stalled/Dismiss state.
  try {
    if (startedAt) {
      const remaining = await removePendingGenesisAt(startedAt);
      if (remaining.length === 0) stopGenesisTick();
    } else {
      await clearPendingGenesis();
      stopGenesisTick();
    }
  } catch {
    // leave the ticker running; a still-present marker keeps ticking to Dismiss
  }
  await refreshWorkflow("chamber-roster").catch(() => {});
  return { ok: true };
}

export async function retireAction(action: RibAction): Promise<RibActionResult> {
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  const slug = asNonEmptyString(payload.slug);
  if (!slug) return { ok: false, error: "retire requires payload { slug }" };
  try {
    await retireMind(mindsDir(), slug);
    invalidateRoster(); // a Mind is gone — drop it from the cached roster
    await refreshWorkflow("chamber-roster").catch(() => {});
    await refreshStandingPanels();
    return { ok: true, data: { slug } };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

export async function setModelAction(action: RibAction): Promise<RibActionResult> {
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  const slug = asNonEmptyString(payload.slug);
  if (!slug) return { ok: false, error: "set-model requires payload { slug }" };
  const model = asNonEmptyString(payload.model);
  const provider = asNonEmptyString(payload.provider);
  try {
    await setMindModel(mindsDir(), slug, { model, provider });
    invalidateRoster();
    // The model is already persisted; a host refresh reject must not turn a
    // committed set-model into a false failure (mirrors retire/dismiss siblings).
    await refreshWorkflow("chamber-roster").catch(() => {});
    return { ok: true, data: { slug, ...(model ? { model } : {}) } };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}
