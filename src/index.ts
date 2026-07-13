import type {
  CanvasBoardView,
  Rib,
  RibAction,
  RibActionResult,
  RibAuthStatus,
  RibContext,
  RibViewDescriptor,
  ToolContext,
  ToolDefinition,
} from "@keelson/shared";
import {
  asNonEmptyString,
  asStringArray,
  CANVAS_PUBLISH_CONTRACT,
  canvasBoardViewSchema,
  errText,
  formatPaletteReport,
  validateCategoricalPalette,
  z,
} from "@keelson/shared";
import { listAgents, resolveAgent } from "./agents.ts";
import { buildRoomBoard } from "./boards/room.ts";
import {
  bindBriefGate,
  disposeBriefGate,
  evaluateBriefGate,
  publishBriefing,
} from "./brief-gate.ts";
import { KNOWN_CAPABILITY_SLUGS } from "./capabilities.ts";
import { chamberFingerprint, readChamberRecords } from "./chamber-state.ts";
import { CHAMBER_COMMANDS, completeChamberCommand, invokeChamberCommand } from "./commands.ts";
import { buildSeedFor } from "./compose.ts";
import { writeDigest } from "./digest-store.ts";
import { slugify } from "./genesis.ts";
import {
  BRIEF_KEY,
  CONVENE_KEY,
  DIGEST_KEY,
  EXHIBITS_KEY,
  LENSES_KEY,
  PRESENCE_KEY,
  ROOMS_KEY,
  ROSTER_KEY,
  roomViewKey,
} from "./keys.ts";
import {
  CHAMBER_SURFACE_ID,
  canonicalLensId,
  EXHIBIT_TOOL_NAME,
  LENS_TOOL_NAME,
  type LensRegistry,
  lensKey,
  lensRefreshInputs,
  MIN_REFRESH_CADENCE_MS,
} from "./lens.ts";
import {
  declaredHtmlPalettes,
  HTML_LENS_KEY,
  HTML_LENS_TOOL_NAME,
  type HtmlLensRegistry,
  htmlLensKey,
  htmlLensStructuralError,
} from "./lens-html.ts";
import { createFileHtmlLensStore } from "./lens-html-store.ts";
import {
  awaitHtmlLensReconcile,
  awaitLensReconcile,
  bindLensRuntime,
  deleteRecordOfKind,
  disposeLensRuntime,
  enqueueLensWrite,
  getHtmlLensRegistry,
  getLensRegistry,
  refreshExhibitIndexes,
} from "./lens-runtime.ts";
import {
  createFileLensStore,
  isExhibit,
  type LensRefresh,
  type LensStore,
  lensProvenance,
  listLenses,
} from "./lens-store.ts";
import {
  type MindRecord,
  readMinds,
  retireMind,
  scaffoldMind,
  setMindModel,
} from "./minds-store.ts";
import {
  chamberDataHome,
  htmlLensesDir,
  isChamberDataHomeWritable,
  lensesDir,
  mindsDir,
  roomsDir,
  setChamberDataHome,
} from "./paths.ts";
import { clearPendingGenesis, removePendingGenesisAt } from "./pending-genesis.ts";
import type { RoomStore } from "./ports.ts";
import {
  bindReflectionGate,
  disposeReflectionGate,
  resetReflectionAbort,
  runReflectionForRoom,
} from "./reflection-gate.ts";
import {
  MAX_CRITERION_LEN,
  MAX_GROUNDING_CRITERIA,
  MAX_GROUNDING_URL_LEN,
  normalizeGrounding,
  parseCriteriaLines,
  roomConfigFromFlat,
} from "./room-config.ts";
import { clearDraft, readDraftExclusion, toggleDraftExclusion } from "./room-draft.ts";
import {
  activeRoomCount,
  activeRoomSlugs,
  bindRoomLifecycle,
  clearRoomTracking,
  disposeRoomLifecycle,
  getDriver,
  getRoomManager,
  injectRoom,
  isRoomActive,
  isSafeSlug,
  isValidParticipant,
  lastRoomSlug,
  MAX_ACTIVE_ROOMS,
  MAX_ROOM_TURN_BUDGET,
  mostRecentActiveSlug,
  noteRoomDeleted,
  publishRoomView,
  ROOM_DISABLED,
  resolveSteerTarget,
  roomNote,
  startRoom,
  stopRoom,
  validateStart,
} from "./room-lifecycle.ts";
import { createFileRoomStore, deriveRoomName, listRooms } from "./room-store.ts";
import type { OutcomeSplit } from "./room-text.ts";
import { splitOutcome } from "./room-text.ts";
import { stripControlJson } from "./routing.ts";
import {
  beginGenesis,
  bindRuntime,
  disposeRuntime,
  getHostRefreshWorkflow,
  invalidateRoster,
  refreshConvene,
  refreshStandingPanels,
  refreshWorkflow,
  resolveMindByNameOrId,
  resolveMinds,
  resolveProject,
  resolveProjectInput,
  resolveProjectName,
  settleGenesis,
  stopGenesisTick,
} from "./runtime.ts";
import { GENESIS_STARTERS } from "./starters.ts";
import { renderTranscript } from "./transcript.ts";
import type { Mind, Room } from "./types.ts";
import { IDENTITY_SLOT_COUNT, nextFreeSlot } from "./types.ts";
import {
  contributeChamberWorkflows,
  DIGEST_TOOL_NAME,
  LENS_REFRESH_WORKFLOW,
} from "./workflows.ts";

export { normalizeGrounding } from "./room-config.ts";
export { MAX_ACTIVE_ROOMS } from "./room-lifecycle.ts";
// Re-exported for the gate tests, which drive each gate through the rib's registerTools
// seams and then call these directly.
export { evaluateBriefGate, runReflectionForRoom };

// Default room length when a chat tool omits turnBudget. Applied after parse (not
// z.default()) because z.toJSONSchema — which the Copilot provider feeds the model
// — lists defaulted fields as `required`, forcing the model to supply them.
const DEFAULT_ROOM_TURN_BUDGET = 8;

// Serialize genesis slot allocation + scaffold across parallel landings. nextFreeSlot
// reads the roster snapshot, so two emits that read the same free slot before either
// scaffolds would persist a duplicate hue. Each scaffold invalidates the roster, so
// the next serialized landing re-reads and takes the next free slot.
let genesisScaffoldInFlight: Promise<unknown> = Promise.resolve();

// The only chamber verbs an untrusted HTML-lens iframe may reach (origin
// "canvas-html"): a no-op ack (`lens-html`) and read-only navigation to a lens
// panel (`lens-open`). Everything destructive or paid stays off this list, so a
// prompt-injected lens can't drive retire / room-* / set-model / convene. See #124.
const FRAME_SAFE_ACTIONS: ReadonlySet<string> = new Set(["lens-html", "lens-open"]);

// The rib's view declarations, mutable at runtime: the host resolves a snapshot
// key's canvas kind by EXACT match against this list (per GET /api/ribs request),
// so each per-subject HTML lens must add its own `canvasKind: "html"` entry here
// or the drawer would render its string frame through the board pipeline. The
// registry's declareView seam pushes/removes entries; the statics stay fixed.
const RIB_VIEWS: RibViewDescriptor[] = [
  { key: PRESENCE_KEY, canvasKind: "view", title: "The Chamber" },
  { key: ROSTER_KEY, canvasKind: "view", title: "Roster" },
  { key: CONVENE_KEY, canvasKind: "view", title: "Convene" },
  { key: ROOMS_KEY, canvasKind: "view", title: "Rooms" },
  { key: LENSES_KEY, canvasKind: "view", title: "Lenses" },
  { key: EXHIBITS_KEY, canvasKind: "view", title: "Exhibits" },
  // DIGEST_KEY has no surface region of its own anymore — the standing digest folds
  // into the Briefing banner's Digest register — but the chamber-digest workflow
  // still binds it (its store is what the banner reads), so the view stays declared.
  { key: DIGEST_KEY, canvasKind: "view", title: "Digest" },
  { key: HTML_LENS_KEY, canvasKind: "html", title: "HTML Lens" },
  { key: BRIEF_KEY, canvasKind: "view", title: "Briefing" },
];

function declareHtmlLensView(id: string, title?: string): () => void {
  const view: RibViewDescriptor = {
    key: htmlLensKey(id),
    canvasKind: "html",
    title: title ?? id,
  };
  RIB_VIEWS.push(view);
  return () => {
    const at = RIB_VIEWS.indexOf(view);
    if (at >= 0) RIB_VIEWS.splice(at, 1);
  };
}

const rib: Rib = {
  id: "chamber",
  displayName: "Chamber",

  contributeDocs: () => [
    {
      title: "Chamber",
      summary:
        "The Chamber rib for Keelson: convene Minds in multi-agent rooms, table exhibits, and publish standing lenses. Covers genesis, room strategies, agent-authored lenses, when to convene, and the rib's design.",
      llmsFullUrl: "https://danielscholl.github.io/keelson-rib-chamber/llms-full.txt",
    },
  ],

  // Binds the agent-authored keys to the canvas renderer; data arrives when the
  // producers (the roster collector, the brief turn, the room driver) run.
  views: RIB_VIEWS,

  // No static actions[]: a payload-less button can't carry input, so every Chamber
  // control lives where its context is. Genesis is the chamber-genesis workflow (it
  // needs a freeform brief); retire and the room controls (start/inject/stop) are
  // payload-carrying board actions (the OSDU pattern) that reach onAction below.

  // The Chamber nav tab. The Chamber panel leads in the header (the bench itself:
  // seat cards, authoring, live pulse), the Briefing banner follows as the
  // always-on heartbeat (the one narrator, folding what were three what's-happening
  // panels — delta / digest / record — into one), and the
  // standing row pairs the sessions index (ended rooms) with the lenses index (the
  // living views) at half width each. The live room panels and
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
      subtitle: "Author Minds · convene Rooms · keep Lenses · table Exhibits · read the Briefing",
      // Chamber panels are an authoring console, not snapshot cards to lift into chat,
      // so drop the host's per-region explore/select/expand chrome. Board actions
      // (Enter a Mind, room controls) still flow — only the head-strip icons go.
      hideRegionActions: true,
      layout: {
        // The Chamber panel leads: the bench itself — seat cards, boot card,
        // authoring launchpad, live pulse.
        // Not collapsible — it is the focal panel every visit. In-process (no
        // workflow binding); the rib recomposes it on any roster/rooms mutation,
        // and the genesis ticker's frames pulse the head dot (keelson#353).
        header: {
          key: PRESENCE_KEY,
          title: "The Chamber",
          glyph: { char: "◈", tone: "brand" },
          live: true,
        },
        // Binds no `workflow`: the Briefing is rib-driven, composed and re-published
        // in-process, so a binding would make the SPA try to refresh a workflow that
        // does not exist.
        banner: {
          key: BRIEF_KEY,
          title: "Briefing",
          glyph: { char: "❖", tone: "brand" },
        },
        rows: [
          {
            columns: [
              {
                key: CONVENE_KEY,
                title: "Convene",
                // In-process board (no workflow binding): the rib recomposes it on a
                // roster/draft/convene mutation, not on cadence. Collapsible so it folds
                // to its head bar once rooms exist (the board's defaultCollapsed hint),
                // a one-click open when you want it — the empty-state cold.
                collapsible: true,
                glyph: { char: "＋", tone: "brand" },
              },
            ],
          },
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
            ],
          },
          {
            columns: [
              {
                key: EXHIBITS_KEY,
                workflow: "chamber-exhibits",
                title: "Exhibits",
                // The tabled-deliverables index, the lenses index's sibling: same
                // cheap collector + cadence, refreshed on table/delete. hideWhenEmpty
                // keeps the shelf invisible until a discussion has tabled something
                // (the builder emits zero sections when empty), so a fresh Chamber
                // doesn't advertise a concept it hasn't produced.
                cadenceMs: 120_000,
                collapsible: true,
                hideWhenEmpty: true,
                glyph: { char: "▣", tone: "caution" },
              },
            ],
          },
        ],
      },
    },
  ],

  contributeWorkflows: contributeChamberWorkflows,

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
    // Same for the reflection gate: a fresh controller so a re-boot's reflection
    // turns aren't pre-aborted, while any orphaned pre-dispose turn stays gated out.
    resetReflectionAbort();
    // The genesis write seam is always available: genesis is a workflow whose
    // prompt node calls chamber_emit_genesis, and the write needs no room driver.
    // The room-control tools (and the driver) require the C1 agent-turn + snapshot
    // seams, so they only appear when those are present. The tool re-runs the bound
    // chamber-roster collector via the module-level refreshWorkflow (fail-soft).
    const genesisTool = makeGenesisTool();
    // The digest write seam is always available, like genesis: it only writes the
    // digest store (no snapshot/turn seam needed), and the chamber-digest workflow's
    // author node opts in to it by name.
    const digestTool = makeDigestTool();
    // Like genesis and digest, the list and cleanup tools need only the disk paths
    // captured above, so they are always available — independent of the snapshot/turn seams.
    const readTools = [
      makeListMindsTool(),
      makeListRoomsTool(),
      makeListLensesTool(),
      makeListExhibitsTool(),
      makeRoomTranscriptTool(),
    ];
    const cleanupTools = [makeRetireMindTool(), makeRoomDeleteTool()];
    const sm = ctx.getSnapshotManager?.();
    const registerRegion = ctx.registerRegion;
    const run = ctx.runAgentTurn;
    // The Briefing banner is rib-driven (no workflow binding): its publisher +
    // paid-turn gate live in brief-gate.ts; bind installs a fresh abort controller
    // (unconditional) and, when the snapshot + agent-turn seams are present, wires the
    // coalescing BRIEF_KEY publisher and seeds the banner. See bindBriefGate.
    bindBriefGate({ sm, runAgentTurn: run });
    // The cross-cutting host seams (refresh fan-out + projects lookup) and the in-process
    // Convene + Chamber panels: bindRuntime captures the seams, registers the panels on
    // the snapshot manager, and reconciles a crashed genesis's boot card. See src/runtime.ts.
    bindRuntime({ refreshWorkflow: ctx.refreshWorkflow, getProjects: ctx.getProjects, sm });
    // Lenses render via the registerRegion seam, so the registry and its emit tool
    // wire up only when BOTH the snapshot manager and registerRegion are present —
    // independent of the room's C1 agent-turn seam (the room tools below additionally
    // require runAgentTurn). bindLensRuntime owns the singleton discipline (build once,
    // reuse, rebuild against a new manager) and reconciles persisted lenses; declareView
    // is injected so it never touches this rib's view array. See src/lens-runtime.ts.
    const { lensStore } = bindLensRuntime({ sm, registerRegion, declareView: declareHtmlLensView });
    const lensReg = getLensRegistry();
    const htmlLensReg = getHtmlLensRegistry();
    const lensTools =
      sm && registerRegion && lensReg
        ? [
            makeLensTool(lensStore, lensReg),
            makeRetireLensTool(),
            makeTableExhibitTool(lensStore, lensReg),
            makeDeleteExhibitTool(),
          ]
        : [];
    const htmlLensTools =
      sm && registerRegion && htmlLensReg ? [makeEmitLensHtmlTool(htmlLensReg)] : [];
    if (sm && registerRegion && run) {
      // Capture the agent-turn seam for the close-only reflection pass (onRoomClosed,
      // below) — the same run the room driver uses for room turns.
      bindReflectionGate({ runAgentTurn: run });
      // The room subsystem — driver, region registry, retention sweep, and the room
      // loop/start/stop/inject core — lives in src/room-lifecycle.ts; bindRoomLifecycle
      // owns the singleton discipline (build once, reuse, rebuild against a new manager)
      // and returns the room store the control tools share.
      const { roomStore } = bindRoomLifecycle({ sm, registerRegion, runAgentTurn: run });
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
      case "author-lens":
        return authorLensAction(action);
      case "describe-own":
        return describeOwnAction(action);
      case "dismiss-genesis":
        return dismissGenesisAction(action);
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
      case "outcome-copy":
        return outcomeCopyAction(action);
      case "outcome-explore":
        return outcomeExploreAction(action);
      case "retire-lens":
        return retireLensAction(action);
      case "retire-lens-html":
        return retireHtmlLensAction(action);
      case "delete-exhibit":
        return deleteExhibitAction(action);
      case "lens-open":
        return lensOpenAction(action);
      case "lens-note":
        return lensNoteAction(action);
      case "refresh-lens":
        return refreshLensAction(action);
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
    clearRoomTracking();
    // The runtime cluster (genesis tick + marker, host seams, Convene/Chamber panels,
    // roster cache): stop its tick, clear the marker, drop the seams so a post-dispose
    // refresh no-ops, unregister the panels, and reset the roster cache. See src/runtime.ts.
    await disposeRuntime();
    disposeBriefGate();
    // Abort in-flight reflection and drain its writes so a late memory write can't
    // land after teardown; reset the per-Mind write chains for the next boot.
    await disposeReflectionGate();
    // Drain any in-flight lens write-back before tearing down the registries, so a
    // late load-append-publish can't publish to a disposed registry or interleave
    // with a re-boot's writes. See src/lens-runtime.ts.
    await disposeLensRuntime();
    // Tear down the room subsystem last: dispose the region registry, release the
    // room-view keys, and dispose the driver (which aborts any in-flight turn). See
    // src/room-lifecycle.ts.
    await disposeRoomLifecycle();
  },
};

function roomStartAction(action: RibAction): Promise<RibActionResult> {
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

// Toggle one Mind's membership in the Convene draft (the deselected-slug set). The
// slug must name a real, current Mind (validated against the live roster, not just
// shape) so a stale/forged chip can't write an unknown slug into the draft. On success
// recompose the Convene board so the chips re-render with the new glyph and the shape
// gating re-evaluates against the new cast. Returns the new exclusion list.
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
    refreshConvene();
    return { ok: true, data: { excluded: [...excluded] } };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

// Convene a room from the current draft and the chosen shape: participants are the
// selected Minds (all current Minds minus the draft's excluded set) minus the named
// facilitator — a Debate chair / Delegate manager is one of the selected Minds, pulled
// out of the cast so it routes/plans rather than speaks/works. The room shape (a
// `strategy` in the
// action payload) and its per-shape fields (topic, project, moderator, manager, turns)
// come from the shape action the operator clicked. Reuses the room start path
// (startRoom → validateStart → driver), so the <2-participant / facilitator-rules /
// cross-vendor / seam-absent guards aren't duplicated here — a shape the draft can't
// satisfy (a Review that isn't a cross-vendor pair, a Debate whose moderator is also a
// participant) surfaces validateStart's error. On success clear the draft (back to
// all-selected) and recompose the Convene board so the chips reset and it folds to its
// bar (a room now exists). An empty draft with the Discussion shape yields every Mind
// in a sequential room — the historical Start.
async function conveneAction(action: RibAction): Promise<RibActionResult> {
  const driver = getDriver();
  if (!driver || driver.isDisposed()) return ROOM_DISABLED;
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  let allMinds: Mind[];
  let draftedMinds: Mind[];
  try {
    const excluded = await readDraftExclusion();
    allMinds = await readMinds(mindsDir());
    draftedMinds = allMinds.filter((m) => !excluded.has(m.slug));
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
    refreshConvene();
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

// Open a closed room from the sessions index: rebuild its board from the persisted
// transcript, publish it to the room's own room-view key, and return the host
// open-canvas effect. The board carries the room's Start-again / group-chat / open-floor
// controls, so a past session can be relaunched from the drawer. Fails closed on a
// missing/unsafe slug, an unknown room, or an absent room seam.
async function roomOpenAction(action: RibAction): Promise<RibActionResult> {
  const resolved = requireRoomSlug(action);
  if ("error" in resolved) return resolved.error;
  const sm = getRoomManager();
  if (!sm) return ROOM_DISABLED;
  try {
    const store = createFileRoomStore(roomsDir());
    const room = await store.loadRoom(resolved.slug);
    if (!room) return { ok: false, error: `room '${resolved.slug}' not found` };
    const transcript = await store.loadTranscript(resolved.slug);
    // A magentic room's plan lives in its ledger; load it so a reopened closed room
    // renders the Plan section, not just the transcript (the live board does the same).
    const ledger = room.strategy === "magentic" ? await store.loadLedger(resolved.slug) : undefined;
    const minds = await resolveMinds();
    const projectName = room.projectId ? resolveProjectName(room.projectId) : undefined;
    const board = buildRoomBoard(room, transcript, ledger, minds, projectName ?? room.projectId);
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
async function outcomeCopyAction(action: RibAction): Promise<RibActionResult> {
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
async function outcomeExploreAction(action: RibAction): Promise<RibActionResult> {
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

async function retireLensAction(action: RibAction): Promise<RibActionResult> {
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  const raw = asNonEmptyString(payload.id);
  if (!raw) return { ok: false, error: "retire-lens requires payload { id }" };
  const res = await deleteRecordOfKind(
    raw,
    "lens",
    (id) => `'${id}' is an exhibit — delete it from the Exhibits index`,
  );
  return res.ok ? { ok: true, data: { id: res.id, key: res.key } } : res;
}

async function deleteExhibitAction(action: RibAction): Promise<RibActionResult> {
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  const raw = asNonEmptyString(payload.id);
  if (!raw) return { ok: false, error: "delete-exhibit requires payload { id }" };
  const res = await deleteRecordOfKind(
    raw,
    "exhibit",
    (id) => `'${id}' is a lens — retire it from the Lenses index`,
  );
  return res.ok ? { ok: true, data: { id: res.id, key: res.key } } : res;
}

// Extract and canonicalize the { id } payload every lens verb carries, so the
// guard prologue (and its error wording) lives once rather than per handler.
function lensActionId(action: RibAction, verb: string): { id: string } | { error: string } {
  const raw = asNonEmptyString(((action.payload ?? {}) as Record<string, unknown>).id);
  if (!raw) return { error: `${verb} requires payload { id }` };
  const id = canonicalLensId(raw);
  if (!id) return { error: `unsafe lens id: ${JSON.stringify(raw)}` };
  return { id };
}

// Retire an HTML lens: the head ⋯ verb on its panel — the only delete path an
// HTML lens has (its sandboxed iframe can't reach destructive actions and it
// carries no index card). Deletes the persisted record, then releases the live
// key + region + views entry.
async function retireHtmlLensAction(action: RibAction): Promise<RibActionResult> {
  const got = lensActionId(action, "retire-lens-html");
  if ("error" in got) return { ok: false, error: got.error };
  const { id } = got;
  try {
    // Let any in-flight boot re-registration finish first (mirrors
    // deleteRecordOfKind awaiting the lens reconcile): a retire landing
    // mid-reconcile must not race a reregister into resurrecting the panel.
    await awaitHtmlLensReconcile();
    try {
      await createFileHtmlLensStore(htmlLensesDir()).delete(id);
    } catch (e) {
      // The record is already gone but a panel may still be live (external
      // tamper): releasing it lets the verb converge instead of stranding a
      // ghost panel no second retire could ever remove.
      if (/not found/.test(errText(e)) && getHtmlLensRegistry()?.remove(id)) {
        await refreshStandingPanels();
        return { ok: true, data: { id, key: htmlLensKey(id) } };
      }
      throw e;
    }
    getHtmlLensRegistry()?.remove(id);
    await refreshStandingPanels();
    return { ok: true, data: { id, key: htmlLensKey(id) } };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

// Re-compose a living lens on demand: the Refresh verb on a refresh-backed
// lens's index card. Fires the record's named workflow with input `lens` = the
// id — the same run the panel's cadence fires — and returns as soon as the run
// is started; the re-emit republishes the panel and its index card.
async function refreshLensAction(action: RibAction): Promise<RibActionResult> {
  const got = lensActionId(action, "refresh-lens");
  if ("error" in got) return { ok: false, error: got.error };
  const { id } = got;
  const hostRefreshWorkflow = getHostRefreshWorkflow();
  if (!hostRefreshWorkflow) {
    return { ok: false, error: "workflow refresh unavailable on this harness" };
  }
  try {
    const record = await createFileLensStore(lensesDir()).loadLens(id);
    if (!record) return { ok: false, error: `lens '${id}' not found` };
    if (isExhibit(record)) {
      return { ok: false, error: `'${id}' is an exhibit — exhibits don't refresh` };
    }
    if (!record.refresh) {
      return {
        ok: false,
        error: `lens '${id}' has no refresh backing — re-author it with chamber_emit_lens refresh: {}`,
      };
    }
    await hostRefreshWorkflow(record.refresh.workflow, lensRefreshInputs(id));
    return { ok: true, data: { id, workflow: record.refresh.workflow } };
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
  const got = lensActionId(action, "lens-open");
  if ("error" in got) return { ok: false, error: got.error };
  return { ok: true, data: { effect: "open-canvas", key: lensKey(got.id), title: got.id } };
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
  const got = lensActionId(action, "lens-note");
  if ("error" in got) return { ok: false, error: got.error };
  const { id } = got;
  const note = asNonEmptyString(((action.payload ?? {}) as Record<string, unknown>).note);
  if (!note) return { ok: false, error: "lens-note requires a non-empty note" };
  // Count code points, not UTF-16 code units, so the cap matches the "characters"
  // the message promises (an emoji is one character but two code units).
  if ([...note].length > LENS_NOTE_MAX) {
    return { ok: false, error: `note too long (max ${LENS_NOTE_MAX} characters)` };
  }
  // The write-back republishes through the registry to update the live panel, so the
  // region seam must be wired (it always is when a lens exists — fail closed if not).
  const registry = getLensRegistry();
  if (!registry) return { ok: false, error: "lens write-back unavailable (region seam absent)" };
  // Serialize the load-append-publish: it is a read-modify-write, so two concurrent
  // appends to the same board would lose-update (the store's atomic rename guards a
  // torn file, not a stale read). Note appends are rare operator actions, so one
  // global chain — not a per-id lock — suffices.
  const apply = async (): Promise<RibActionResult> => {
    try {
      // Let any in-flight boot re-registration finish first, so the write can't race a
      // reregister republishing the pre-edit board over the live key.
      await awaitLensReconcile();
      const record = await createFileLensStore(lensesDir()).loadLens(id);
      if (!record) return { ok: false, error: `lens '${id}' not found` };
      // Round-trip the provenance, the kind, and the refresh backing (lensProvenance
      // picks every provenance field), so an annotated exhibit can't come back as a
      // lens with no source room and an annotated living lens keeps its wiring.
      const { key } = await registry.publish(
        id,
        appendLensNote(record.board, note),
        lensProvenance(record),
        isExhibit(record) ? "exhibit" : "lens",
        record.refresh,
      );
      // The record's updatedAt advanced — refresh its own index card (and, for a
      // lens, the roster pulse; exhibits don't ride the "Live views" count), cheap
      // deterministic collectors, fail-soft like the emit/retire paths.
      if (isExhibit(record)) {
        await refreshWorkflow("chamber-exhibits").catch(() => {});
      } else {
        await refreshWorkflow("chamber-lenses").catch(() => {});
        await refreshWorkflow("chamber-roster").catch(() => {});
      }
      await refreshStandingPanels();
      return { ok: true, data: { id, key } };
    } catch (e) {
      return { ok: false, error: errText(e) };
    }
  };
  return enqueueLensWrite(apply);
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
  // A starter's name/role are known now (pinned as inputs), so the boot card can show
  // them; stay on the surface (stay: true) so the operator watches the seat fill.
  await beginGenesis({ name: starter.name, role: starter.role });
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
      },
    },
  };
}

async function authorLensAction(action: RibAction): Promise<RibActionResult> {
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  const subject = asNonEmptyString(payload.subject);
  if (!subject) return { ok: false, error: "author-lens requires payload { subject }" };
  return {
    ok: true,
    // ribClientEffectSchema wants args as a string map (the slash-command path
    // takes a bare string — different schema); ARGUMENTS is the $ARGUMENTS binding.
    data: {
      effect: "run-workflow",
      workflow: "chamber-lens",
      stay: true,
      args: { ARGUMENTS: subject },
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
  // A freeform brief has no name/role yet (the workflow authors them), so the boot card
  // holds "calibrating…"; stay on the surface so the operator watches the seat fill.
  await beginGenesis({});
  return {
    ok: true,
    data: {
      effect: "run-workflow",
      workflow: "chamber-genesis",
      stay: true,
      args: { ARGUMENTS: brief.slice(0, MAX_BRIEF_CHARS) },
    },
  };
}

// Dismiss a stalled (or unwanted) genesis boot card: settle the one marker the card's
// payload names (its startedAt stamp), falling back to clearing them all for a legacy
// dispatch without one; stop the tick when nothing is left in flight; refresh the
// roster so the seat frees back to the launchpad. Deterministic and free — not paid.
async function dismissGenesisAction(action?: RibAction): Promise<RibActionResult> {
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

async function retireAction(action: RibAction): Promise<RibActionResult> {
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

async function setModelAction(action: RibAction): Promise<RibActionResult> {
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
  // Optional grounding brief distinct from the free-text topic: a source URL and the
  // acceptance criteria the room must satisfy. Injected into turn prompts; when it
  // carries criteria, a design-bearing room runs a cross-vendor fidelity check against
  // them before the closing synthesis. Omit for a room with no grounding.
  grounding: z
    .object({
      sourceUrl: z.string().max(MAX_GROUNDING_URL_LEN).optional(),
      criteria: z.array(z.string().max(MAX_CRITERION_LEN)).max(MAX_GROUNDING_CRITERIA).optional(),
    })
    .optional(),
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
  const slug = explicit || mostRecentActiveSlug() || lastRoomSlug();
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
  const groundingSource = room.grounding?.sourceUrl?.trim();
  const criteria = room.grounding?.criteria.filter((c) => c.trim().length > 0) ?? [];
  const criteriaText =
    criteria.length > 0 ? `: ${criteria.map((c, i) => `${i + 1}. ${c}`).join("; ")}` : "";
  const grounding =
    groundingSource || criteria.length > 0
      ? `\nGrounding${groundingSource ? ` (${groundingSource})` : ""}${criteriaText}`
      : "";
  const body = transcript.length > 0 ? renderTranscript(transcript) : "(no turns yet)";
  let index = "";
  if (!explicit && activeRoomCount() > 1) {
    const others = activeRoomSlugs().filter((s) => s !== slug);
    const lines = await Promise.all(
      others.map(async (s) => {
        const r = await store.loadRoom(s);
        return r
          ? `  • ${r.name} (${s}) — ${r.status}, turn ${r.turnIndex}/${r.turnBudget}`
          : `  • ${s}`;
      }),
    );
    index = `\n\n${activeRoomCount()} rooms active — pass room:<slug> to read another:\n${lines.join("\n")}`;
  }
  return boundedText(`${head}${grounding}\n\n${body}${index}`);
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
  // Seat-card stanza (2-4 verb-led sentences). Lenient on purpose: blank is
  // omitted at persist and the card render truncates at 200, so an empty or
  // overlong stanza degrades rather than failing the one paid authoring turn.
  mission: z.string().max(500).optional(),
  tagline: z.string().min(1),
  model: z.string().optional(),
  provider: z.string().optional(),
  // Capability slugs the Mind may invoke in a room (see CAPABILITIES).
  // Unknown slugs are dropped at persist; omitted/empty keeps the Mind text-only.
  tools: z.array(z.string()).optional(),
});

function makeGenesisTool(): ToolDefinition {
  return {
    name: "chamber_emit_genesis",
    description:
      "Internal write-seam for the chamber-genesis workflow: persist an authored Mind (SOUL.md + record) under minds/<slug>. The workflow's prompt turn authors { soul, mission, tagline, optional model/provider pin, optional capability tools }; this tool only writes, failing closed on a slug collision. To create an agent, run the chamber-genesis workflow (e.g. /workflow run chamber-genesis <brief>) rather than calling this directly.",
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
        mission,
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
        const slug = slugify(name);
        // A Mind takes the lowest identity slot not already worn (keelson#390),
        // preferring its starter's own hue when that slug matches a starter and the
        // hue is free — so the cold-start card previews what actually gets seated,
        // and a churned roster never double-seats a hue (next-free, not count-based).
        // Slot pick + scaffold run behind genesisScaffoldInFlight so two parallel
        // landings can't read the same free slot and persist a duplicate hue.
        const buildAndScaffold = async (): Promise<MindRecord> => {
          const preferred = GENESIS_STARTERS.find((s) => s.slug === slug)?.seat;
          const slot = nextFreeSlot(await resolveMinds(), preferred);
          const built: MindRecord = {
            slug,
            name,
            role,
            voice,
            // The roster card truncates for display (with an ellipsis); store the
            // authored tagline trimmed, not hard-cut.
            persona: tagline.trim(),
            ...(mission?.trim() ? { mission: mission.trim() } : {}),
            createdAt: new Date().toISOString(),
            // Omit the slot past the ramp (a sixth Mind) so identityToneForSlot folds
            // it to neutral rather than persisting an out-of-range index.
            ...(slot < IDENTITY_SLOT_COUNT ? { identitySlot: slot } : {}),
            ...(model ? { model } : {}),
            ...(model && provider ? { provider } : {}),
            ...(knownTools.length > 0 ? { tools: knownTools } : {}),
          };
          await scaffoldMind(mindsDir(), built, soul);
          invalidateRoster();
          return built;
        };
        const scaffoldRun = genesisScaffoldInFlight.then(buildAndScaffold, buildAndScaffold);
        genesisScaffoldInFlight = scaffoldRun.catch(() => {});
        const record = await scaffoldRun;
        // The genesis landed — settle its own boot-card marker (siblings keep theirs)
        // so the next roster frame shows the real seat instead of the boot card.
        await settleGenesis(record.name);
        // Re-run the bound chamber-roster collector so the new Mind appears
        // promptly instead of waiting on the 120s cadence. Fail-soft — the Mind is
        // already scaffolded, so a host-refresh reject must not fail the emit.
        await refreshWorkflow("chamber-roster").catch(() => {});
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
  // The lens's re-compose backing. Absent PRESERVES an existing lens's config —
  // a refresh turn re-emitting the board must not strip its own backing — and
  // null clears it. An object PATCHES the prior backing: an omitted field keeps
  // its prior value, `workflow` bottoming out at the bundled chamber-lens-refresh
  // re-author; the floor/ceiling keep a typo'd cadence from thrashing turns.
  refresh: z
    .object({
      workflow: z.string().min(1).max(64).optional(),
      cadenceMs: z.number().int().min(MIN_REFRESH_CADENCE_MS).max(86_400_000).optional(),
    })
    .nullable()
    .optional(),
});

function makeLensTool(store: LensStore, registry: LensRegistry): ToolDefinition {
  return {
    name: LENS_TOOL_NAME,
    description:
      'Author a lens: render a canvas `board` you compose onto the Chamber surface, where it shows live as its own panel with no hand-coded UI — a STANDING VIEW on a subject you maintain by re-authoring the same id. `id` is a short, stable kebab-case identifier for the subject (re-authoring the same id updates the same panel); `board` is the canvas board view. Optional provenance for the lenses index card — supply only what you can truthfully name, never invent: `scope` (the board\'s kind, e.g. "status board" / "timeline" / "checklist"), `maintainingMind` (YOUR own Mind name/slug, the lens\'s maintainer), `reason` (a short note on what changed in this authoring). Optional `refresh` makes it a LIVING view: `{ workflow?, cadenceMs? }` names a catalog workflow the panel re-runs on cadence with input `lens` = this id (the workflow re-composes and re-emits the lens; default workflow chamber-lens-refresh, default cadence 1h). Omitting `refresh` on a re-author keeps the existing backing; an object PATCHES it (an omitted field keeps its prior value); `refresh: null` removes it. Call it once per lens. To let a viewer annotate the lens in place, include an `actions` section whose action has `type: "lens-note"`, `payload: { id: <this lens id> }`, and one multiline field named `note` — submitting it appends the note to the lens. The chamber-lens workflow (/workflow run chamber-lens <subject>) is the standalone entry point. NOT for a deliverable a discussion produced — table that with chamber_table_exhibit.',
    inputSchema: lensEmitSchema,
    state_changing: true,
    execute(input, ctx) {
      // Serialized on the lens write chain (enqueueLensWrite, like the exhibit
      // tool): the refresh preserve-vs-clear resolution is a read-modify-write of
      // the record, and an unserialized publish could land inside a note write-back or stamp.
      const apply = async (): Promise<void> => {
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
          await awaitLensReconcile();
          // The two species share one id space, so the LENS verb must not overwrite
          // an exhibit (it would flip the record's kind and drop its witnessed
          // sourceRoom). Best-effort guard — the publish itself stays last-writer-wins.
          const existing = await store.loadLens(id);
          if (existing && isExhibit(existing)) {
            emitResult(
              ctx,
              `chamber_emit_lens: '${id}' is an exhibit — update it with chamber_table_exhibit or pick another id`,
              true,
            );
            return;
          }
          const refresh = resolveLensRefresh(parsed.data.refresh, existing?.refresh);
          // The harness refresh seam is fail-soft (an unknown workflow warns
          // server-side and resolves), so an emit that names a custom workflow
          // gets a caveat in its reply — the one place the author can hear it.
          const customWorkflow =
            parsed.data.refresh?.workflow && parsed.data.refresh.workflow !== LENS_REFRESH_WORKFLOW
              ? parsed.data.refresh.workflow
              : undefined;
          const { key } = await registry.publish(
            id,
            parsed.data.board,
            { scope, maintainingMind, reason },
            "lens",
            refresh,
          );
          // Re-run the bound chamber-lenses collector so a newly-authored lens appears
          // in the index promptly instead of waiting on cadence (mirrors genesis
          // refreshing the roster). Fail-soft: the seam resolves on error / is absent
          // on an older harness — never throw past a successful publish.
          await refreshWorkflow("chamber-lenses").catch(() => {});
          // A changed/new lens is briefing substance: evaluate the gate (it runs a turn
          // only if the watermark hasn't seen this fingerprint) and refresh the roster
          // so its pulse updates. Both fire-and-forget — never thrown past the publish.
          void evaluateBriefGate().catch(() => {});
          void refreshWorkflow("chamber-roster").catch(() => {});
          await refreshStandingPanels();
          emitResult(
            ctx,
            JSON.stringify({
              ok: true,
              key,
              ...(customWorkflow
                ? {
                    note: `refresh runs workflow '${customWorkflow}' — if that workflow is not in the catalog, the panel silently never re-composes`,
                  }
                : {}),
            }),
          );
        } catch (e) {
          emitResult(ctx, `chamber_emit_lens failed: ${errText(e)}`, true);
        }
      };
      return enqueueLensWrite(apply);
    },
  };
}

// Resolve an emit's refresh input against the prior record: absent preserves
// (a refresh turn re-emitting the board must not strip its own backing), null
// clears, and an object PATCHES — each omitted field keeps its prior value, so
// a cadence-only re-author can't silently swap a bespoke refresh workflow for
// the bundled default.
function resolveLensRefresh(
  input: { workflow?: string; cadenceMs?: number } | null | undefined,
  prior: LensRefresh | undefined,
): LensRefresh | undefined {
  if (input === undefined) return prior;
  if (input === null) return undefined;
  const cadenceMs = input.cadenceMs ?? prior?.cadenceMs;
  return {
    workflow: input.workflow ?? prior?.workflow ?? LENS_REFRESH_WORKFLOW,
    ...(cadenceMs !== undefined ? { cadenceMs } : {}),
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
      "Internal write-seam for the chamber-digest workflow: persist the standing digest board the author turn composed. The workflow's gate-conditioned author node calls this once with { board } when the Chamber changed; this tool validates the board fail-closed, stamps it with the current chamber fingerprint, and writes it so the Briefing banner's Digest register refreshes. The chamber-digest workflow (nudged by the rib on each Chamber mutation) is the entry point — don't call this directly.",
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
        // The digest register reads digest.json — re-publish the banner so the new
        // synthesis lands without waiting on the next mutation.
        await publishBriefing();
        emitResult(ctx, JSON.stringify({ ok: true }));
      } catch (e) {
        emitResult(ctx, `chamber_emit_digest failed: ${errText(e)}`, true);
      }
    },
  };
}

const lensHtmlEmitSchema = z.object({
  html: z.string().min(1).max(262144),
  id: z.string().min(1).max(64).optional(),
  title: z.string().min(1).max(80).optional(),
});

function makeEmitLensHtmlTool(registry: HtmlLensRegistry): ToolDefinition {
  return {
    name: HTML_LENS_TOOL_NAME,
    // The shared canvas contract IS the description (one source of truth with the
    // host's canvas_publish); the chamber-specific routing rides ahead of it.
    description: [
      "Author an HTML lens: publish a designed, self-contained HTML page as its own live panel on the Chamber surface.",
      "`id` is a short, stable kebab-case identifier for the subject (re-emitting the same id updates the same panel, and the lens persists across restarts);",
      "omit it to target the single shared legacy canvas instead. `title` (optional) names the panel head.",
      "`id` plays the role the contract below calls `name`.",
      CANVAS_PUBLISH_CONTRACT,
    ].join(" "),
    inputSchema: lensHtmlEmitSchema,
    state_changing: true,
    async execute(input, ctx) {
      const parsed = lensHtmlEmitSchema.safeParse(input);
      if (!parsed.success) {
        emitResult(ctx, `chamber_emit_lens_html: ${parsed.error.message}`, true);
        return;
      }
      const { html, title } = parsed.data;
      const structural = htmlLensStructuralError(html);
      if (structural !== undefined) {
        emitResult(ctx, `chamber_emit_lens_html: ${structural}`, true);
        return;
      }
      // Fail-closed palette gate (the canvas_publish contract): a declared
      // categorical palette that hard-fails CVD/contrast rejects the emit with the
      // per-check report so the turn fixes the colors and retries.
      const palettes = declaredHtmlPalettes(html);
      for (const mode of ["dark", "light"] as const) {
        const palette = palettes[mode];
        if (!palette) continue;
        let report: ReturnType<typeof validateCategoricalPalette>;
        try {
          report = validateCategoricalPalette(palette, { mode });
        } catch (e) {
          emitResult(ctx, `chamber_emit_lens_html: data-palette-${mode}: ${errText(e)}`, true);
          return;
        }
        if (!report.ok) {
          emitResult(
            ctx,
            `chamber_emit_lens_html: the declared ${mode} palette fails validation — fix the colors (prefer the keelson series slots) and emit again:\n${formatPaletteReport(report)}`,
            true,
          );
          return;
        }
      }
      let id: string | undefined;
      if (parsed.data.id !== undefined) {
        id = canonicalLensId(parsed.data.id);
        if (!id) {
          emitResult(ctx, "chamber_emit_lens_html: id has no usable characters", true);
          return;
        }
      }
      try {
        const { key } = await registry.publish(html, {
          ...(id !== undefined ? { id } : {}),
          ...(title !== undefined ? { title } : {}),
        });
        // No chamber-lenses/roster/brief refresh here (unlike chamber_emit_lens):
        // HTML lenses persist in their own store, which those collectors don't
        // read, so refreshing them would be inert.
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
function makeRetireLensTool(): ToolDefinition {
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
      const res = await deleteRecordOfKind(
        parsed.data.id,
        "lens",
        (id) => `'${id}' is an exhibit — use chamber_delete_exhibit`,
      );
      if (!res.ok) {
        emitResult(ctx, `chamber_retire_lens: ${res.error}`, true);
        return;
      }
      emitResult(ctx, JSON.stringify({ ok: true, key: res.key }));
    },
  };
}

// Exhibit publish seam — the room driver's turn tool: a discussion tables its
// deliverable (an assessment, a plan, a findings board) as a point-in-time record
// on the Exhibits shelf. Deliberately NO sourceRoom input: the room driver stamps
// the producing room after WITNESSING this tool fire in a turn it ran (see
// stampExhibitSources), so provenance can't be claimed, only observed.
const exhibitEmitSchema = z.object({
  id: z.string().min(1).max(64),
  board: canvasBoardViewSchema,
  reason: z.string().min(1).max(120).optional(),
});

function makeTableExhibitTool(store: LensStore, registry: LensRegistry): ToolDefinition {
  return {
    name: EXHIBIT_TOOL_NAME,
    description:
      "Table an exhibit: publish a canvas `board` DELIVERABLE your discussion produced onto the Chamber surface, where it shows as its own panel on the Exhibits shelf — a point-in-time record (an assessment, a plan, a findings summary), kept until deleted. `id` is a short, stable kebab-case identifier for the deliverable; `board` is the canvas board view; optional `reason` is a one-line gist of what the exhibit holds. Call it once when the discussion has converged on something worth keeping. NOT for a standing view you intend to keep updating — author that with chamber_emit_lens.",
    inputSchema: exhibitEmitSchema,
    state_changing: true,
    execute(input, ctx) {
      // Serialized on the lens write chain (enqueueLensWrite): the tool's load-check-
      // publish, the witness stamp, and the note write-back all touch the same record
      // files, and an unserialized publish could land inside a stamp's read-modify-write.
      const apply = async (): Promise<void> => {
        const parsed = exhibitEmitSchema.safeParse(input);
        if (!parsed.success) {
          emitResult(ctx, `chamber_table_exhibit: ${parsed.error.message}`, true);
          return;
        }
        const id = canonicalLensId(parsed.data.id);
        if (!id) {
          emitResult(ctx, "chamber_table_exhibit: id has no usable characters", true);
          return;
        }
        try {
          await awaitLensReconcile();
          const existing = await store.loadLens(id);
          // The two species share one id space, so the EXHIBIT verb must not
          // overwrite a standing lens (it would flip the record's kind and drop
          // its maintainer provenance).
          if (existing && !isExhibit(existing)) {
            emitResult(
              ctx,
              `chamber_table_exhibit: '${id}' is a lens — update it with chamber_emit_lens or pick another id`,
              true,
            );
            return;
          }
          const { key } = await registry.publish(
            id,
            parsed.data.board,
            // A re-table keeps the witnessed source until the driver re-stamps it
            // (the record is rewritten whole, so an omitted field would clear it).
            { reason: parsed.data.reason, sourceRoom: existing?.sourceRoom },
            "exhibit",
          );
          // Mirror the lens emit's freshness path: the new exhibit appears in its
          // index promptly (a re-table with a changed title also updates the
          // producing room's tabled link), and a tabled deliverable is briefing
          // substance. No roster refresh — exhibits don't ride the pulse's "Live
          // views" count.
          await refreshExhibitIndexes();
          void evaluateBriefGate().catch(() => {});
          await refreshStandingPanels();
          emitResult(ctx, JSON.stringify({ ok: true, key }));
        } catch (e) {
          emitResult(ctx, `chamber_table_exhibit failed: ${errText(e)}`, true);
        }
      };
      return enqueueLensWrite(apply);
    },
  };
}

// Exhibit delete seam: the chamber_retire_lens sibling for the Exhibits shelf,
// kind-checked the other way (see deleteExhibitAction, the board-action twin).
const exhibitDeleteSchema = z.object({ id: z.string().min(1).max(64) });

function makeDeleteExhibitTool(): ToolDefinition {
  return {
    name: "chamber_delete_exhibit",
    description:
      "Delete an exhibit: permanently remove a tabled deliverable — its persisted record AND its live Chamber panel. `id` is the exhibit's stable kebab-case identifier (the same id chamber_table_exhibit used; see chamber_list_exhibits). Fails closed if no such exhibit exists. NOT for retiring a lens (chamber_retire_lens).",
    inputSchema: exhibitDeleteSchema,
    state_changing: true,
    async execute(input, ctx) {
      const parsed = exhibitDeleteSchema.safeParse(input);
      if (!parsed.success) {
        emitResult(ctx, `chamber_delete_exhibit: ${parsed.error.message}`, true);
        return;
      }
      const res = await deleteRecordOfKind(
        parsed.data.id,
        "exhibit",
        (id) => `'${id}' is a lens — use chamber_retire_lens`,
      );
      if (!res.ok) {
        emitResult(ctx, `chamber_delete_exhibit: ${res.error}`, true);
        return;
      }
      emitResult(ctx, JSON.stringify({ ok: true, key: res.key }));
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

const listLensesSchema = z.object({
  id: z.string().min(1).max(64).optional(),
});

function makeListLensesTool(): ToolDefinition {
  return {
    name: "chamber_list_lenses",
    description:
      "List the Chamber's living lenses (agent-authored canvas boards), newest first: each lens's id, when it was last updated, any refresh backing, and any provenance (scope, maintaining Mind, reason). Pass { id } to fetch ONE lens in full — the matching record then also carries its `board` (the current composition), which a refresh turn re-composes from. Read-only. NOT for authoring a lens (run the chamber-lens workflow), retiring one (chamber_retire_lens), or the tabled deliverables (chamber_list_exhibits).",
    inputSchema: listLensesSchema,
    state_changing: false,
    async execute(input, ctx) {
      const parsed = listLensesSchema.safeParse(input ?? {});
      if (!parsed.success) {
        emitResult(ctx, `chamber_list_lenses: ${parsed.error.message}`, true);
        return;
      }
      const wanted = parsed.data.id ? canonicalLensId(parsed.data.id) : undefined;
      // An id that canonicalizes to nothing fails closed (mirrors the emit and
      // action guards) — a silent empty list would read as "no such lens".
      if (parsed.data.id !== undefined && !wanted) {
        emitResult(
          ctx,
          `chamber_list_lenses: unsafe lens id: ${JSON.stringify(parsed.data.id)}`,
          true,
        );
        return;
      }
      try {
        const lenses = (await listLenses(lensesDir())).filter(
          (l) => !isExhibit(l) && (wanted === undefined || l.id === wanted),
        );
        const rows = lenses.map((l) => ({
          id: l.id,
          updatedAt: l.updatedAt,
          ...(l.refresh ? { refresh: l.refresh } : {}),
          ...(l.scope ? { scope: l.scope } : {}),
          ...(l.maintainingMind ? { maintainingMind: l.maintainingMind } : {}),
          ...(l.reason ? { reason: l.reason } : {}),
          // The board rides along only on a single-lens fetch: it is the bulky
          // field, and the list's readers (briefings, refresh turns) only need
          // one composition at a time.
          ...(wanted !== undefined ? { board: l.board } : {}),
        }));
        emitJsonList(ctx, "lenses", rows);
      } catch (e) {
        emitResult(ctx, `chamber_list_lenses failed: ${errText(e)}`, true);
      }
    },
  };
}

function makeListExhibitsTool(): ToolDefinition {
  return {
    name: "chamber_list_exhibits",
    description:
      "List the Chamber's exhibits (deliverables discussions tabled), newest first: each exhibit's id, when it was tabled, the producing room when witnessed, and any gist. Read-only. NOT for tabling one (chamber_table_exhibit), deleting one (chamber_delete_exhibit), or the living lenses (chamber_list_lenses).",
    inputSchema: noToolInputSchema,
    state_changing: false,
    async execute(_input, ctx) {
      try {
        const exhibits = (await listLenses(lensesDir())).filter(isExhibit);
        const rows = exhibits.map((l) => ({
          id: l.id,
          tabledAt: l.updatedAt,
          ...(l.sourceRoom ? { sourceRoom: l.sourceRoom } : {}),
          ...(l.reason ? { reason: l.reason } : {}),
        }));
        emitJsonList(ctx, "exhibits", rows);
      } catch (e) {
        emitResult(ctx, `chamber_list_exhibits failed: ${errText(e)}`, true);
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
        await refreshWorkflow("chamber-roster").catch(() => {});
        await refreshStandingPanels();
        emitResult(ctx, JSON.stringify({ ok: true, slug }));
      } catch (e) {
        emitResult(ctx, `chamber_retire_mind failed: ${errText(e)}`, true);
      }
    },
  };
}

const roomDeleteSchema = z.object({ room: z.string().min(1) });
const ROOM_TRANSCRIPT_DEFAULT_LIMIT = 50;
const ROOM_TRANSCRIPT_MAX_LIMIT = 500;
const roomTranscriptSchema = z.object({
  room: z.string().min(1),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(ROOM_TRANSCRIPT_MAX_LIMIT).optional(),
});

function makeRoomTranscriptTool(): ToolDefinition {
  return {
    name: "chamber_room_transcript",
    description:
      "Read a Chamber room's full persisted transcript in pages: returns exact transcript entries from rooms/<slug>/transcript.jsonl plus offset, limit, total, and nextCursor. Read-only. Use it to page through a long room transcript without chamber_room_status truncation. NOT for starting, steering, stopping, or deleting a room.",
    inputSchema: roomTranscriptSchema,
    state_changing: false,
    async execute(input, ctx) {
      const parsed = roomTranscriptSchema.safeParse(input);
      if (!parsed.success) {
        emitResult(ctx, `chamber_room_transcript: ${parsed.error.message}`, true);
        return;
      }
      const slug = parsed.data.room.trim();
      if (!slug) {
        emitResult(ctx, "chamber_room_transcript: room is required", true);
        return;
      }
      const offset = parsed.data.offset ?? 0;
      const limit = parsed.data.limit ?? ROOM_TRANSCRIPT_DEFAULT_LIMIT;
      try {
        const store = createFileRoomStore(roomsDir());
        const room = await store.loadRoom(slug);
        if (!room) throw new Error(`room '${slug}' not found`);
        const transcript = await store.loadTranscript(slug);
        const end = Math.min(offset + limit, transcript.length);
        emitResult(
          ctx,
          JSON.stringify({
            ok: true,
            room: slug,
            offset,
            limit,
            total: transcript.length,
            nextCursor: end < transcript.length ? end : null,
            entries: transcript.slice(offset, end),
          }),
        );
      } catch (e) {
        emitResult(ctx, `chamber_room_transcript failed: ${errText(e)}`, true);
      }
    },
  };
}

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
      if (isRoomActive(slug)) {
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
        noteRoomDeleted(slug);
        await refreshWorkflow("chamber-rooms").catch(() => {});
        await refreshStandingPanels();
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
        "Open a Chamber room where the named agent Minds converse turn-by-turn (turnBudget paid agent turns, default 8; at budget exhaustion every strategy except review appends one extra paid closing-synthesis turn, so a completed room runs up to turnBudget + 1 room turns — turnBudget + 2 when a design-bearing room is grounded with acceptance criteria (a cross-vendor fidelity turn before synthesis); every Mind that spoke then also runs one paid reflection turn at close, so the total paid calls exceed the room-turn count). Provide a `topic` to frame the discussion — strongly recommended, since it is what the first speaker responds to. Optionally provide `grounding` — a `{ sourceUrl?, criteria?: string[] }` brief distinct from the topic: it is injected into every turn prompt, and its acceptance criteria drive an independent cross-vendor fidelity check — when the room's Minds span two providers — that folds any divergences into the closing document before a design-bearing room (sequential/concurrent/group-chat/open-floor/magentic) synthesizes. Strategy role rules: sequential/concurrent need only at least two participant Mind slugs and no manager; group-chat requires a `moderator` Mind slug that is real, safe, and NOT among participants, with optional `synthesizer` that is also real/safe and neither a participant nor the moderator; open-floor has no moderator or synthesizer; review requires exactly two participants pinned to different providers — first author, second reviewer — with no moderator or synthesizer and turnBudget at least 2; magentic requires a real/safe `manager` Mind slug NOT among participants, no moderator or synthesizer, and at least two worker participants. State-changing: set confirm:true ONLY after the user has approved — without confirm the tool reports what it would start and runs nothing. participants are Mind slugs (see chamber_list_minds). Several rooms can run concurrently (up to a small cap) — stop one if the cap is reached. NOT for creating a Mind (that is the New agent / genesis action).",
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
        const grounding = normalizeGrounding(parsed.data.grounding);
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
        // Canonicalize before the dry-run's validateStart: it and driver.start match
        // projectId as an id only, so a name must resolve to its id up here or the
        // dry-run would reject a project the confirm path (and the board) accept.
        const projectInput = (parsed.data.projectId ?? "").trim() || undefined;
        let projectId: string | undefined;
        if (projectInput) {
          const resolved = resolveProjectInput(projectInput);
          if (!resolved.ok) {
            emitResult(ctx, `chamber_room_start: ${resolved.error}`, true);
            return;
          }
          projectId = resolved.project.id;
        }
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
        if (activeRoomCount() >= MAX_ACTIVE_ROOMS) {
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
        // Disclose the extra paid turns a grounded design-bearing room spends at close
        // (a cross-vendor fidelity turn plus the closing synthesis) so the approving
        // human sees the true ceiling, not just the base budget.
        const groundingNote =
          grounding && grounding.criteria.length > 0 && strategy !== "review"
            ? ` It carries a grounding brief: the closing synthesis, plus a cross-vendor fidelity turn when the Minds span two providers, add up to 2 more room turns (up to ${turnBudget + 2}), before the per-speaker reflection pass at close.`
            : "";
        if (!confirm) {
          emitResult(
            ctx,
            `Would open a room with ${who}${topicNote}${modeNote}${projectNote}${codingNote} for ${turnBudget} turns (each turn is a paid agent call).${groundingNote} Re-call chamber_room_start with confirm:true once the user approves.`,
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
          ...(grounding ? { grounding } : {}),
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
