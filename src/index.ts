import { fileURLToPath } from "node:url";
import type { CanvasView, Rib, RibAction, RibActionResult, RibContext } from "@keelson/shared";
import { canvasViewSchema } from "@keelson/shared";
import {
  assertSafeSlug,
  buildGenesisPrompt,
  type GenesisAuthor,
  parseGenesisOutput,
  slugify,
} from "./genesis.ts";
import { type MindRecord, mindExists, readMinds, retireMind, scaffoldMind } from "./minds-store.ts";
import { mindsDir, roomsDir } from "./paths.ts";
import type { RoomPublisher, RoomStore } from "./ports.ts";
import { createRoomDriver, type RoomDriver } from "./room.ts";
import { createFileRoomStore } from "./room-store.ts";
import type { RoomStrategyName } from "./types.ts";

const BRIEF_KEY = "rib:chamber:brief";
const ROSTER_KEY = "rib:chamber:roster";
const ROOM_KEY = "rib:chamber:room";

// The room driver is a boot-time singleton: it holds in-flight turn state across
// onAction calls, so it is built once in registerTools (the only hook that runs
// with the full ctx — runAgentTurn + snapshot manager) and reused thereafter. It
// stays undefined when either seam is absent, and room actions then fail closed.
let driver: RoomDriver | undefined;
let store: RoomStore | undefined;
// Slugs whose auto-advance loop is running, so a re-start doesn't double-drive.
const loops = new Set<string>();
// Set by the rib's dispose() at shutdown so a running loop stops driving turns
// (and never shells a new CLI turn) while the driver aborts the in-flight one.
let disposed = false;

// Absolute path to the roster collector, resolved at module load so the workflow
// node runs the right file regardless of the run's (nominal) cwd. fileURLToPath
// (not URL.pathname) decodes %20 etc. so an install path with a space resolves;
// it is shell-quoted where interpolated into the bash node below.
const ROSTER_COLLECTOR = fileURLToPath(new URL("../bin/collect-roster.ts", import.meta.url));

// The coding-agent CLI genesis shells to author a soul. MVP only: it uses the
// CLI's ambient auth, so it ignores KEELSON_WORKFLOW_PROVIDER until C1's
// provider-routed runAgentTurn lands. Override the bin for non-claude setups.
const AGENT_BIN = process.env.CHAMBER_AGENT_BIN?.trim() || "claude";
const GENESIS_TIMEOUT_MS = 120_000;

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

const rib: Rib = {
  id: "chamber",
  displayName: "Chamber",

  // Binds the agent-authored keys to the canvas renderer; the buttons appear on
  // the Ribs page and data arrives when the producers run.
  views: [
    { key: ROSTER_KEY, canvasKind: "view", title: "Roster" },
    { key: ROOM_KEY, canvasKind: "view", title: "Room" },
    { key: BRIEF_KEY, canvasKind: "view", title: "Briefing" },
  ],

  // The "new agent" / "retire" affordances plus the Phase 2 room controls; all
  // dispatch to onAction. Room turns advance on their own once started (the
  // auto-advance loop), so room-next is a manual single-step for paused control.
  actions: [
    { type: "genesis", label: "New agent" },
    { type: "retire", label: "Retire agent" },
    { type: "room-start", label: "Start room" },
    { type: "room-next", label: "Next turn" },
    { type: "room-inject", label: "Inject" },
    { type: "room-stop", label: "Stop room" },
  ],

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
          'Use when: you want to see the agents (Minds) that have been created. Triggers: "show the roster", "list agents", "what minds exist". Does: reads the genesis-authored Minds from the Chamber data home and publishes a roster board (one card per Mind) to the Chamber Roster canvas. NOT for: creating or retiring agents (those are the New agent / Retire actions).',
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
  ],

  // Boot-time wiring of the room loop. Registers the push-fed room snapshot and
  // builds the driver against the real seams: runAgentTurn (C1) for the turns,
  // the snapshot manager as the publisher (publish caches the board and
  // recomposes ROOM_KEY — a live WS push, no collector), the FS data home as the
  // store, and the roster as the minds resolver. Both seams are optional, so the
  // driver stays undefined on a host without them and room actions fail closed.
  registerTools: (ctx: RibContext) => {
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
      store = createFileRoomStore(roomsDir());
      driver = createRoomDriver({
        store,
        publisher,
        runAgentTurn: run,
        minds: () => readMinds(mindsDir()),
      });
    }
    return { registered: [] };
  },

  // Genesis a Mind (one agent turn authors its soul, the rib persists it) and
  // retire one — both mutate the data home and return (the OSDU
  // mutate-then-refresh pattern). The room-* controls drive the room loop; the
  // transcript pushes to the canvas as turns land (no refresh needed).
  onAction: (action, ctx) => {
    switch (action.type) {
      case "genesis":
        return genesisAction(action, ctx);
      case "retire":
        return retireAction(action);
      case "room-start":
        return roomStartAction(action);
      case "room-next":
        return roomNextAction(action);
      case "room-inject":
        return roomInjectAction(action);
      case "room-stop":
        return roomStopAction(action);
      default:
        return { ok: false, error: `unknown action '${action.type}'` };
    }
  },

  // Shutdown: stop the auto-advance loops and abort any in-flight turn so a CLI
  // child can't keep running (or publish) after teardown. The aborted turn
  // finalizes the room to "stopped", so the loop's next check exits cleanly.
  dispose: async () => {
    disposed = true;
    loops.clear();
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
// stop aborts the in-flight turn so the next loadRoom sees a non-active room and
// the loop exits. Errors are logged, never thrown into the (already-returned)
// action.
function ensureLoop(slug: string): void {
  if (!driver || !store || disposed || loops.has(slug)) return;
  loops.add(slug);
  const activeDriver = driver;
  const activeStore = store;
  void (async () => {
    try {
      while (!disposed) {
        const room = await activeStore.loadRoom(slug);
        if (room?.status !== "active") break;
        await activeDriver.step(slug);
      }
    } catch (e) {
      console.error(`[rib-chamber] room loop '${slug}' failed: ${errText(e)}`);
    } finally {
      loops.delete(slug);
    }
  })();
}

async function roomStartAction(action: RibAction): Promise<RibActionResult> {
  if (!driver) return ROOM_DISABLED;
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  const participants = asStringArray(payload.participants);
  const turnBudget = typeof payload.turnBudget === "number" ? payload.turnBudget : 0;
  if (participants.length === 0) {
    return { ok: false, error: "room-start requires payload { participants: string[] }" };
  }
  if (!Number.isInteger(turnBudget) || turnBudget <= 0) {
    return { ok: false, error: "room-start requires a positive integer turnBudget" };
  }
  const slug = asNonEmptyString(payload.slug) || "room";
  const bad = badSlug(slug);
  if (bad) return bad;
  const name = asNonEmptyString(payload.name) || "Room";
  const strategy = (asNonEmptyString(payload.strategy) || "sequential") as RoomStrategyName;
  try {
    await driver.start({ slug, name, strategy, participants, turnBudget });
    ensureLoop(slug);
    return { ok: true, data: { slug } };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

function roomNextAction(action: RibAction): RibActionResult {
  if (!driver) return ROOM_DISABLED;
  const slug = roomSlugOf(action);
  const bad = badSlug(slug);
  if (bad) return bad;
  // Fire-and-return: one turn can outlast the action's socket budget, and the
  // driver publishes the result itself when it lands. A step while the loop is
  // mid-turn is a no-op (the serial gate), so a manual nudge can't double-drive.
  void driver
    .step(slug)
    .catch((e) => console.error(`[rib-chamber] room-next '${slug}': ${errText(e)}`));
  return { ok: true, data: { slug } };
}

async function roomInjectAction(action: RibAction): Promise<RibActionResult> {
  if (!driver) return ROOM_DISABLED;
  const slug = roomSlugOf(action);
  const bad = badSlug(slug);
  if (bad) return bad;
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  const directionInjection = asNonEmptyString(payload.directionInjection);
  const nextSpeaker = asNonEmptyString(payload.nextSpeaker);
  const text = asNonEmptyString(payload.text);
  try {
    await driver.inject(slug, {
      ...(directionInjection ? { directionInjection } : {}),
      ...(nextSpeaker ? { nextSpeaker } : {}),
      ...(text ? { text } : {}),
    });
    return { ok: true, data: { slug } };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

async function roomStopAction(action: RibAction): Promise<RibActionResult> {
  if (!driver) return ROOM_DISABLED;
  const slug = roomSlugOf(action);
  const bad = badSlug(slug);
  if (bad) return bad;
  try {
    await driver.stop(slug);
    return { ok: true, data: { slug } };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

function roomSlugOf(action: RibAction): string {
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  return asNonEmptyString(payload.slug) || "room";
}

// Reject a traversal slug at the action boundary so the caller gets a clean
// ok:false instead of a thrown error logged from a fire-and-return step. The
// store guards the FS boundary too (defense in depth).
function badSlug(slug: string): RibActionResult | undefined {
  try {
    assertSafeSlug(slug);
    return undefined;
  } catch {
    return { ok: false, error: `unsafe room slug: ${JSON.stringify(slug)}` };
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Shell the coding-agent CLI for one authoring turn. Isolated behind the
// GenesisAuthor seam so genesis.ts stays provider-free; collapses to
// ctx.runAgentTurn once C1 lands. `--output-format json` wraps the reply as
// `{ result }`; the inner text is the GenesisDocs JSON parseGenesisOutput reads.
function makeAuthor(ctx: RibContext): GenesisAuthor {
  return async (prompt) => {
    const res = await ctx
      .getExec()
      .runJSON<{ result?: string }>(AGENT_BIN, ["-p", prompt, "--output-format", "json"], {
        timeoutMs: GENESIS_TIMEOUT_MS,
      });
    if (!res.ok) throw new Error(res.error);
    const text = res.data?.result;
    if (typeof text !== "string" || text.trim().length === 0) {
      throw new Error(`${AGENT_BIN} returned no text`);
    }
    return text;
  };
}

async function genesisAction(action: RibAction, ctx: RibContext): Promise<RibActionResult> {
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  const name = asNonEmptyString(payload.name);
  const role = asNonEmptyString(payload.role);
  const voice = asNonEmptyString(payload.voice);
  if (!name || !role || !voice) {
    return { ok: false, error: "genesis requires payload { name, role, voice }" };
  }
  const slug = slugify(name); // always non-empty (falls back for non-Latin names)
  const model = asNonEmptyString(payload.model);
  const tools = asStringArray(payload.tools);
  try {
    // Fail a known collision before the ~120s (paid) authoring turn, not after.
    if (await mindExists(mindsDir(), slug)) {
      return { ok: false, error: `mind '${slug}' already exists` };
    }
    const raw = await makeAuthor(ctx)(buildGenesisPrompt({ name, role, voice }));
    const docs = parseGenesisOutput(raw);
    const record: MindRecord = {
      slug,
      name,
      role,
      voice,
      persona: docs.tagline,
      ...(model ? { model } : {}),
      ...(tools.length > 0 ? { tools } : {}),
      createdAt: new Date().toISOString(),
    };
    await scaffoldMind(mindsDir(), record, docs.soul);
    return { ok: true, data: { slug } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function retireAction(action: RibAction): Promise<RibActionResult> {
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  const slug = asNonEmptyString(payload.slug);
  if (!slug) return { ok: false, error: "retire requires payload { slug }" };
  try {
    await retireMind(mindsDir(), slug);
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

export default rib;
