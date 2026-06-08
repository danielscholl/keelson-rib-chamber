import { fileURLToPath } from "node:url";
import type {
  CanvasView,
  Rib,
  RibAction,
  RibActionResult,
  RibContext,
  ToolContext,
  ToolDefinition,
} from "@keelson/shared";
import { canvasViewSchema, z } from "@keelson/shared";
import { assertSafeSlug, slugify } from "./genesis.ts";
import { type MindRecord, readMinds, readSoul, retireMind, scaffoldMind } from "./minds-store.ts";
import { chamberDataHome, mindsDir, roomsDir } from "./paths.ts";
import type { RoomPublisher, RoomStore } from "./ports.ts";
import { createRoomDriver, type RoomDriver } from "./room.ts";
import { createFileRoomStore } from "./room-store.ts";
import { renderTranscript } from "./transcript.ts";
import type { Mind, RoomStrategyName } from "./types.ts";

const BRIEF_KEY = "rib:chamber:brief";
const ROSTER_KEY = "rib:chamber:roster";
const ROOM_KEY = "rib:chamber:room";

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
// Slugs whose auto-advance loop is running, so a re-start doesn't double-drive.
const loops = new Set<string>();
// Monotonic suffix so each room-start gets a brand-new slug (see freshRoomSlug).
let roomSeq = 0;
// The slug of the currently-active room (at most one, per the single-active
// invariant). Set when a room opens, cleared when it stops or its loop ends — so
// the chat tools can target "the room" without the server-assigned slug.
let activeSlug: string | undefined;
// The most-recent room, active or finished. Unlike activeSlug it survives the
// room ending, so chamber_room_status can still show a just-finished transcript.
// Cleared only on dispose.
let lastSlug: string | undefined;

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

// Absolute path to the roster collector, resolved at module load so the workflow
// node runs the right file regardless of the run's (nominal) cwd. fileURLToPath
// (not URL.pathname) decodes %20 etc. so an install path with a space resolves;
// it is shell-quoted where interpolated into the bash node below.
const ROSTER_COLLECTOR = fileURLToPath(new URL("../bin/collect-roster.ts", import.meta.url));

// Validate through the canvas view union (not a bare member schema) so the
// producer-side guard enforces the same node-id / column-key uniqueness checks
// the SPA render gate runs — before a frame is ever broadcast. Mirrors the OSDU
// rib's expectView.
function expectView(key: string, kind: CanvasView["view"]) {
  return (data: unknown): CanvasView => {
    const view = canvasViewSchema.parse(data);
    if (view.view !== kind) throw new Error(`${key} expects a ${kind} view, got "${view.view}"`);
    return view;
  };
}

// The brief's JSON-Schema shape, used twice. As `output_format` it's the
// structured-output directive appended to the prompt (and flips the node to a
// structured producer so the bound-key publish bridge sees a value, not text).
// As `output_schema` it's the executor's fail-closed node guard: listing
// `properties` (not just `required`) makes a top-level type mismatch — e.g.
// `sections` returned as a string — fail the run loudly, instead of passing a
// keys-only check and then being silently dropped by the canvas `validate` on
// publish (a stale panel with no refresh error). The deep board check stays the
// canvas `validate` on the bound key below.
const BRIEF_SHAPE = {
  type: "object",
  // `title` is required here (the prompt contract asks for one and a titled
  // briefing reads better) even though the canvas board treats it as optional —
  // a stricter-than-canvas node guard, not a looser one. `view` stays a plain
  // string because the output_schema subset has no const/enum; the exact
  // "board" kind is enforced fail-closed by `validate` (expectView) on publish.
  required: ["view", "title", "sections"],
  properties: {
    view: { type: "string" },
    title: { type: "string" },
    sections: { type: "array" },
  },
} as const;

// Phase 0 is a seam proof: an agent turn authors a canvas `board` that renders
// on the Chamber surface with no hand-coded UI. No data source is wired yet, so
// the brief is an honest, self-describing operator briefing about Chamber
// itself — not invented external metrics. Tools are withheld (allowed_tools: [])
// so the turn composes purely from this prompt.
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

// Genesis as a workflow (the chamber-brief sibling): one agent turn reads a
// freeform brief, authors the SOUL.md body + a roster tagline, and persists the
// Mind by calling the chamber_emit_genesis tool (the deterministic write seam).
// Unlike brief it publishes no snapshot — its product is files on disk, which the
// chamber-roster collector then reflects. $ARGUMENTS carries the brief (chat
// `/workflow run chamber-genesis <brief>`); explicit $inputs.* are honored when a
// caller supplies them (CLI --inputs). The model is scoped to the one emit tool.
const GENESIS_WF_PROMPT = `You are authoring the founding identity of a new persistent agent — a "Mind" — for Keelson's Chamber, a multi-agent operating layer.

Brief: $ARGUMENTS

(If these explicit fields are non-empty, prefer them over the brief — name: "$inputs.name", role: "$inputs.role", voice: "$inputs.voice".)

From the brief, decide the Mind's name, role, and voice (how it speaks). Then write an honest founding document — do NOT invent tools, credentials, or capabilities it does not have; describe who it is, what it is for, and how it speaks.

Compose:
- soul: Markdown for the Mind's SOUL.md, with these sections in order:
    # <name>
    ## Persona  — who this Mind is, grounded in the role
    ## Mission  — what it exists to do
    ## Voice    — how it speaks (tone, length, habits)
- tagline: one line, at most 120 characters, summarizing the Mind for a roster card (no Markdown).

Then call the chamber_emit_genesis tool EXACTLY ONCE with { name, role, voice, soul, tagline } to persist the Mind — do NOT print the JSON as your reply. After the tool returns, reply with a single short line naming the Mind you created.`;

const rib: Rib = {
  id: "chamber",
  displayName: "Chamber",

  // Binds the agent-authored keys to the canvas renderer; data arrives when the
  // producers (the roster collector, the brief turn, the room driver) run.
  views: [
    { key: ROSTER_KEY, canvasKind: "view", title: "Roster" },
    { key: ROOM_KEY, canvasKind: "view", title: "Room" },
    { key: BRIEF_KEY, canvasKind: "view", title: "Briefing" },
  ],

  // No static actions[]: a payload-less button can't carry input, so every Chamber
  // control lives where its context is. Genesis is the chamber-genesis workflow (it
  // needs a freeform brief); retire and the room controls (start/inject/stop) are
  // payload-carrying board actions (the OSDU pattern) that reach onAction below.

  // The Chamber nav tab. The roster sits in the header (the Minds you genesis),
  // the live room transcript fills the row, and the brief settles into the
  // footer. The room region carries no workflow: it is push-fed — the driver
  // recomposes ROOM_KEY on every turn (no collector, no cadence poll).
  surfaces: [
    {
      id: "chamber",
      title: "Chamber",
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
          { columns: [{ key: ROOM_KEY, title: "Room", glyph: { char: "▦", tone: "brand" } }] },
        ],
        footer: {
          key: BRIEF_KEY,
          workflow: "chamber-brief",
          title: "Briefing",
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
            bash: `bun ${JSON.stringify(ROSTER_COLLECTOR)}`,
            output_schema: { type: "object", required: ["view", "sections"] },
          },
        ],
      },
      bindSnapshotKey: ROSTER_KEY,
      validate: expectView(ROSTER_KEY, "board"),
    },
    {
      definition: {
        name: "chamber-brief",
        description:
          'Use when: you want a one-screen briefing of the Chamber multi-agent layer. Triggers: "chamber briefing", "what is chamber doing", "show the chamber brief". Does: runs one agent turn that authors a canvas board (an operator briefing — status pulse, KPI stats, what\'s live / next, explanatory cards) and publishes it to the Chamber Briefing canvas. NOT for: genesis-ing agents or running a room.',
        nodes: [
          {
            id: "compose",
            prompt: BRIEF_PROMPT,
            output_format: BRIEF_SHAPE,
            output_schema: BRIEF_SHAPE,
            allowed_tools: [],
          },
        ],
      },
      bindSnapshotKey: BRIEF_KEY,
      validate: expectView(BRIEF_KEY, "board"),
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
  ],

  // Boot-time wiring of the room loop. Registers the push-fed room snapshot and
  // builds the driver against the real seams: runAgentTurn (C1) for the turns,
  // the snapshot manager as the publisher (publish caches the board and
  // recomposes ROOM_KEY — a live WS push, no collector), the FS data home as the
  // store, and the roster as the minds resolver. Both seams are optional, so the
  // driver stays undefined on a host without them and room actions fail closed.
  registerTools: (ctx: RibContext) => {
    // The genesis write seam is always available: genesis is a workflow whose
    // prompt node calls chamber_emit_genesis, and the write needs no room driver.
    // The room-control tools (and the driver) require the C1 agent-turn + snapshot
    // seams, so they only appear when those are present.
    const genesisTool = makeGenesisTool();
    const sm = ctx.getSnapshotManager?.();
    const run = ctx.runAgentTurn;
    if (sm && run) {
      // Seed a valid empty board so a client subscribing before the first turn
      // gets a well-formed view; every publish replaces it with the live board.
      let latest: CanvasView = { view: "board", title: "Room", sections: [] };
      sm.register(ROOM_KEY, () => latest, { validate: expectView(ROOM_KEY, "board") });
      // Dirty-flag pump (mirrors the base's bound-workflow publish): recompose
      // coalesces concurrent calls onto one in-flight compose, so a publish that
      // lands while another is composing would otherwise never broadcast its
      // board (e.g. a director inject racing a turn's terminal commit). Re-run
      // once more whenever a publish arrived mid-compose, so the latest board
      // always reaches the canvas.
      let composing = false;
      let dirty = false;
      const publisher: RoomPublisher = {
        async publish(view) {
          latest = view;
          if (composing) {
            dirty = true;
            return;
          }
          composing = true;
          try {
            do {
              dirty = false;
              await sm.recompose(ROOM_KEY);
            } while (dirty);
          } finally {
            composing = false;
          }
        },
      };
      const roomStore = createFileRoomStore(roomsDir());
      driver = createRoomDriver({
        store: roomStore,
        publisher,
        runAgentTurn: run,
        minds: resolveMinds,
        readSoul: (slug) => readSoul(mindsDir(), slug),
        turnCwd: chamberDataHome(),
      });
      // Prime the cache so a client subscribing before the first turn gets the
      // seeded board, not a 204 / loading skeleton (the GET path doesn't
      // lazy-compose).
      void sm.recompose(ROOM_KEY);
      // Expose the room controls as chat tools (start / say / stop / status),
      // sharing the same driver + store this hook just built. Returned only when
      // the seams are present (no driver -> no tools), mirroring how the actions
      // fail closed.
      return [genesisTool, ...roomControlTools(roomStore)];
    }
    return [genesisTool];
  },

  // Retire a Mind (removes it, then refreshes the roster — the OSDU
  // mutate-then-refresh pattern). The room-* controls drive the room loop; the
  // transcript pushes to the canvas as turns land (no refresh needed). Turns
  // advance on their own (the auto-advance loop), so there is no manual step.
  onAction: (action) => {
    switch (action.type) {
      case "retire":
        return retireAction(action);
      case "room-start":
        return roomStartAction(action);
      case "room-inject":
        return roomInjectAction(action);
      case "room-stop":
        return roomStopAction(action);
      default:
        return { ok: false, error: `unknown action '${action.type}'` };
    }
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
    activeSlug = undefined;
    lastSlug = undefined;
    invalidateRoster();
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
      // The loop died mid-room: the driver still holds this slug as its active
      // room and room.json is still "active". Force-stop so the driver and disk
      // agree with the cleared module activeSlug below — otherwise the room is
      // invisible to the tools yet blocks every restart ("a room is already active").
      try {
        await activeDriver.stop(slug);
      } catch (stopErr) {
        console.error(`[rib-chamber] failed to stop wedged room '${slug}': ${errText(stopErr)}`);
      }
    } finally {
      loops.delete(slug);
      // The room left "active" — drop it as the chat tools' target.
      if (activeSlug === slug) activeSlug = undefined;
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
async function validateStart(
  participants: readonly string[],
  turnBudget: number,
): Promise<{ ok: true; participants: string[] } | { ok: false; error: string }> {
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
  const known = new Set((await resolveMinds()).map((m) => m.slug));
  const missing = deduped.filter((s) => !known.has(s));
  if (missing.length > 0) {
    return {
      ok: false,
      error: `unknown Mind(s): ${missing.join(", ")} — genesis them first or check the roster`,
    };
  }
  return { ok: true, participants: deduped };
}

// Open a fresh-slug room and kick its auto-advance loop. The shared core behind
// both the board's room-start action and the chamber_room_start chat tool, so
// validation, the single-active reservation, and the fresh-slug discipline live
// in one place. Each start opens a brand-new room under a unique slug: the CLI
// MVP can't cancel an in-flight turn, so a turn still draining from a stopped
// room must land in its own old dir, never a reused one. Past rooms remain under
// rooms/ as history (a retention sweep is a follow-up).
async function startRoom(input: {
  participants: readonly string[];
  turnBudget: number;
  name?: string;
  strategy?: string;
  topic?: string;
}): Promise<RibActionResult> {
  // Refuse once disposed: driver.start() doesn't check, so without this a start
  // after dispose() would write an "active" room whose loop never runs (ensureLoop
  // bails on isDisposed) — a phantom room nothing ever clears.
  if (!driver || driver.isDisposed()) return ROOM_DISABLED;
  const valid = await validateStart(input.participants, input.turnBudget);
  if (!valid.ok) return { ok: false, error: valid.error };
  const name = (input.name ?? "").trim() || "Room";
  const strategy = ((input.strategy ?? "").trim() || "sequential") as RoomStrategyName;
  // Normalize here so both entry points (the chat tool and the board action)
  // store a trimmed topic or none — a whitespace-only topic becomes no topic.
  const topic = (input.topic ?? "").trim();
  const slug = freshRoomSlug();
  const activeDriver = driver;
  try {
    // driver.start reserves the single active slot synchronously (before any
    // await), so concurrent starts can't both pass — the second rejects here.
    await activeDriver.start({
      slug,
      name,
      strategy,
      participants: valid.participants,
      turnBudget: input.turnBudget,
      ...(topic ? { topic } : {}),
    });
    activeSlug = slug;
    lastSlug = slug;
    ensureLoop(slug);
    return { ok: true, data: { slug } };
  } catch (e) {
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
    if (activeSlug === slug) activeSlug = undefined;
    return { ok: true, data: { slug } };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

function roomStartAction(action: RibAction): Promise<RibActionResult> {
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  return startRoom({
    participants: asStringArray(payload.participants),
    turnBudget: typeof payload.turnBudget === "number" ? payload.turnBudget : 0,
    name: asNonEmptyString(payload.name) || undefined,
    strategy: asNonEmptyString(payload.strategy) || undefined,
    topic: asNonEmptyString(payload.topic) || undefined,
  });
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

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function retireAction(action: RibAction): Promise<RibActionResult> {
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  const slug = asNonEmptyString(payload.slug);
  if (!slug) return { ok: false, error: "retire requires payload { slug }" };
  try {
    await retireMind(mindsDir(), slug);
    invalidateRoster(); // a Mind is gone — drop it from the cached roster
    return { ok: true, data: { slug } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function asNonEmptyString(v: unknown): string {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : "";
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
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
  confirm: z.boolean().optional(),
});
const roomSaySchema = z
  .object({
    direction: z.string().optional(),
    callOn: z.string().optional(),
    text: z.string().optional(),
  })
  .refine((v) => Boolean(v.direction || v.callOn || v.text), {
    message: "provide at least one of: direction, callOn, text",
  });
const emptyToolSchema = z.object({});

// Render the active room + its transcript as chat-legible text. Reads through the
// same store the driver writes, so it reflects the latest committed turn.
async function renderRoomStatus(store: RoomStore): Promise<string> {
  // Capture once: the auto-advance loop can clear activeSlug between awaits. Fall
  // back to lastSlug so a just-finished/stopped room is still readable (its
  // room.json + transcript persist); the header reports the status either way.
  const slug = activeSlug ?? lastSlug;
  if (!slug) return "No Chamber room yet. Start one with chamber_room_start.";
  const room = await store.loadRoom(slug);
  if (!room) return "No Chamber room yet. Start one with chamber_room_start.";
  const transcript = await store.loadTranscript(slug);
  const head =
    `Room "${room.name}" (${slug}) — ${room.status}, turn ${room.turnIndex}/${room.turnBudget}; ` +
    `participants: ${room.participants.join(", ")}.`;
  const body = transcript.length > 0 ? renderTranscript(transcript) : "(no turns yet)";
  return boundedText(`${head}\n\n${body}`);
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
});

function makeGenesisTool(): ToolDefinition {
  return {
    name: "chamber_emit_genesis",
    description:
      "Internal write-seam for the chamber-genesis workflow: persist an authored Mind (SOUL.md + record) under minds/<slug>. The workflow's prompt turn authors { soul, tagline }; this tool only writes, failing closed on a slug collision. To create an agent, run the chamber-genesis workflow (e.g. /workflow run chamber-genesis <brief>) rather than calling this directly.",
    inputSchema: genesisEmitSchema,
    state_changing: true,
    async execute(input, ctx) {
      const parsed = genesisEmitSchema.safeParse(input);
      if (!parsed.success) {
        emitResult(ctx, `chamber_emit_genesis: ${parsed.error.message}`, true);
        return;
      }
      const { name, role, voice, soul, tagline } = parsed.data;
      try {
        const record: MindRecord = {
          slug: slugify(name),
          name,
          role,
          voice,
          // The roster card truncates for display (with an ellipsis); store the
          // authored tagline trimmed, not hard-cut.
          persona: tagline.trim(),
          createdAt: new Date().toISOString(),
        };
        await scaffoldMind(mindsDir(), record, soul);
        invalidateRoster();
        emitResult(ctx, JSON.stringify({ ok: true, slug: record.slug }));
      } catch (e) {
        emitResult(ctx, `chamber_emit_genesis failed: ${errText(e)}`, true);
      }
    },
  };
}

// The room controls as chat tools — the second `step()` consumer the StepOutcome
// soundness (#10/#13) was built for. Fire-and-return: start kicks the existing
// auto-advance loop; status reads progress; say/stop steer the single active room
// (its slug resolved from module state, since the server assigns it). start
// self-gates on an in-tool `confirm` flag because each turn is a paid agent call
// (keelson chat has no pause-and-confirm gate yet — the OSDU lifecycle pattern).
function roomControlTools(store: RoomStore): ToolDefinition[] {
  return [
    {
      name: "chamber_room_status",
      description:
        'Use when the user asks what is happening in the Chamber room — "what are they saying", "show the room", "room status". Returns the active room\'s participants, status, turn count, and the conversation so far. Read-only. NOT for starting or stopping a room.',
      inputSchema: emptyToolSchema,
      state_changing: false,
      async execute(_input, ctx) {
        try {
          emitResult(ctx, await renderRoomStatus(store));
        } catch (e) {
          emitResult(ctx, `chamber_room_status failed: ${errText(e)}`, true);
        }
      },
    },
    {
      name: "chamber_room_start",
      description:
        "Open a Chamber room where the named agent Minds converse turn-by-turn (turnBudget paid agent turns total, default 8). Provide a `topic` to frame the discussion — strongly recommended, since it is what the first speaker responds to. State-changing: set confirm:true ONLY after the user has approved — without confirm the tool reports what it would start and runs nothing. participants are Mind slugs (see the Roster); needs at least two. Rejected if a room is already active — stop it first. NOT for creating a Mind (that is the New agent / genesis action).",
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
        // Validate up front (including roster membership) so the dry-run never
        // advertises a start the confirm path would reject.
        const valid = await validateStart(participants, turnBudget);
        if (!valid.ok) {
          emitResult(ctx, `chamber_room_start: ${valid.error}`, true);
          return;
        }
        // A room is already active: both the dry-run and the confirmed start would
        // fail driver.start's single-active reservation, so reject before prompting.
        if (activeSlug) {
          emitResult(
            ctx,
            "chamber_room_start: a room is already active — stop it first with chamber_room_stop.",
            true,
          );
          return;
        }
        const who = valid.participants.join(", ");
        const topicNote = topic ? ` on "${topic}"` : " (no topic set)";
        if (!confirm) {
          emitResult(
            ctx,
            `Would open a room with ${who}${topicNote} for ${turnBudget} turns (each turn is a paid agent call). Re-call chamber_room_start with confirm:true once the user approves.`,
          );
          return;
        }
        // A user abort during the awaits above must not still open a paid room.
        if (ctx.abortSignal.aborted) return;
        const res = await startRoom({ participants, turnBudget, name, topic });
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
        'Steer the active Chamber room: `direction` sets guidance for the next speaker, `callOn` nominates a specific Mind to go next, `text` drops a director message into the transcript. Use when the user wants to nudge the conversation ("tell them to wrap up", "let Alice answer"). At least one field required. NOT for starting or stopping the room.',
      inputSchema: roomSaySchema,
      state_changing: true,
      async execute(input, ctx) {
        const parsed = roomSaySchema.safeParse(input);
        if (!parsed.success) {
          emitResult(ctx, `chamber_room_say: ${parsed.error.message}`, true);
          return;
        }
        const slug = activeSlug;
        if (!slug) {
          emitResult(
            ctx,
            "No active Chamber room to steer. Start one with chamber_room_start.",
            true,
          );
          return;
        }
        const { direction, callOn, text } = parsed.data;
        // The driver only honors nextSpeaker when it exactly matches an active
        // participant slug — otherwise step() silently drops it and falls back to
        // the strategy. Reject up front so the tool can't report a dropped
        // nomination ("Alice" vs "alice", a typo, a non-participant) as sent.
        if (callOn) {
          const room = await store.loadRoom(slug);
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
        emitResult(
          ctx,
          res.ok ? "Sent to the room." : `chamber_room_say failed: ${res.error}`,
          !res.ok,
        );
      },
    },
    {
      name: "chamber_room_stop",
      description:
        'Stop the active Chamber room (halts its turns). Use when the user says "stop the room", "end it". Reversible — a new room can be started afterward. NOT for retiring a Mind.',
      inputSchema: emptyToolSchema,
      state_changing: true,
      async execute(_input, ctx) {
        const slug = activeSlug;
        if (!slug) {
          emitResult(ctx, "No active Chamber room to stop.", true);
          return;
        }
        const res = await stopRoom(slug);
        emitResult(
          ctx,
          res.ok ? "Stopped the room." : `chamber_room_stop failed: ${res.error}`,
          !res.ok,
        );
      },
    },
  ];
}

export default rib;
