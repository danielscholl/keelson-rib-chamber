import type {
  CanvasBoardView,
  Rib,
  RibAction,
  RibActionResult,
  RibAuthStatus,
  RibContext,
  RibViewDescriptor,
} from "@keelson/shared";
import { asNonEmptyString, asStringArray, errText } from "@keelson/shared";
import { listAgents, resolveAgent } from "./agents.ts";
import { buildRoomBoard } from "./boards/room.ts";
import { bindBriefGate, disposeBriefGate, evaluateBriefGate } from "./brief-gate.ts";
import { CHAMBER_COMMANDS, completeChamberCommand, invokeChamberCommand } from "./commands.ts";
import { buildSeedFor } from "./compose.ts";
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
import { CHAMBER_SURFACE_ID, canonicalLensId, lensKey, lensRefreshInputs } from "./lens.ts";
import { HTML_LENS_KEY, htmlLensKey } from "./lens-html.ts";
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
} from "./lens-runtime.ts";
import { createFileLensStore, isExhibit, lensProvenance } from "./lens-store.ts";
import { readMinds, retireMind, setMindModel } from "./minds-store.ts";
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
import {
  bindReflectionGate,
  disposeReflectionGate,
  resetReflectionAbort,
  runReflectionForRoom,
} from "./reflection-gate.ts";
import { normalizeGrounding, parseCriteriaLines, roomConfigFromFlat } from "./room-config.ts";
import { clearDraft, readDraftExclusion, toggleDraftExclusion } from "./room-draft.ts";
import {
  bindRoomLifecycle,
  clearRoomTracking,
  DEFAULT_ROOM_TURN_BUDGET,
  disposeRoomLifecycle,
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
} from "./room-lifecycle.ts";
import { createFileRoomStore, deriveRoomName } from "./room-store.ts";
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
  resolveProjectInput,
  resolveProjectName,
  stopGenesisTick,
} from "./runtime.ts";
import { GENESIS_STARTERS } from "./starters.ts";
import {
  makeDeleteExhibitTool,
  makeEmitLensHtmlTool,
  makeLensTool,
  makeRetireLensTool,
  makeTableExhibitTool,
} from "./tools/lens-emit.ts";
import {
  makeDigestTool,
  makeGenesisTool,
  makeListExhibitsTool,
  makeListLensesTool,
  makeListMindsTool,
  makeListRoomsTool,
  makeRetireMindTool,
  makeRoomDeleteTool,
  makeRoomTranscriptTool,
} from "./tools/management.ts";
import { roomControlTools } from "./tools/room-control.ts";
import type { Mind, Room } from "./types.ts";
import { contributeChamberWorkflows } from "./workflows.ts";

export { normalizeGrounding } from "./room-config.ts";
export { MAX_ACTIVE_ROOMS } from "./room-lifecycle.ts";
// Re-exported for the gate tests, which drive each gate through the rib's registerTools
// seams and then call these directly.
export { evaluateBriefGate, runReflectionForRoom };

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

export default rib;
