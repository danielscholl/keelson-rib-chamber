import type { Rib, RibAuthStatus, RibContext, RibViewDescriptor } from "@keelson/shared";
import { dispatchChamberAction } from "./actions/index.ts";
import { listAgents, resolveAgent } from "./agents.ts";
import { bindBriefGate, disposeBriefGate, evaluateBriefGate } from "./brief-gate.ts";
import { CHAMBER_COMMANDS, completeChamberCommand, invokeChamberCommand } from "./commands.ts";
import {
  BRIEF_KEY,
  DIGEST_KEY,
  EXHIBITS_KEY,
  LENSES_KEY,
  PRESENCE_KEY,
  ROOMS_KEY,
  ROSTER_KEY,
} from "./keys.ts";
import { CHAMBER_SURFACE_ID } from "./lens.ts";
import { HTML_LENS_KEY, htmlLensKey } from "./lens-html.ts";
import {
  bindLensRuntime,
  disposeLensRuntime,
  getHtmlLensRegistry,
  getLensRegistry,
} from "./lens-runtime.ts";
import { chamberDataHome, isChamberDataHomeWritable, setChamberDataHome } from "./paths.ts";
import {
  bindReflectionGate,
  disposeReflectionGate,
  resetReflectionAbort,
  runReflectionForRoom,
} from "./reflection-gate.ts";
import {
  bindRoomLifecycle,
  clearRoomTracking,
  disposeRoomLifecycle,
  getDriver,
} from "./room-lifecycle.ts";
import { bindRuntime, disposeRuntime } from "./runtime.ts";
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
import { contributeChamberWorkflows } from "./workflows.ts";

export { normalizeGrounding } from "./room-config.ts";
export { MAX_ACTIVE_ROOMS } from "./room-lifecycle.ts";
// Re-exported for the gate tests, which drive each gate through the rib's registerTools
// seams and then call these directly.
export { evaluateBriefGate, runReflectionForRoom };

// The rib's view declarations, mutable at runtime: the host resolves a snapshot
// key's canvas kind by EXACT match against this list (per GET /api/ribs request),
// so each per-subject HTML lens must add its own `canvasKind: "html"` entry here
// or the drawer would render its string frame through the board pipeline. The
// registry's declareView seam pushes/removes entries; the statics stay fixed.
const RIB_VIEWS: RibViewDescriptor[] = [
  { key: PRESENCE_KEY, canvasKind: "view", title: "The Chamber" },
  { key: ROSTER_KEY, canvasKind: "view", title: "Roster" },
  { key: ROOMS_KEY, canvasKind: "view", title: "Rooms" },
  { key: LENSES_KEY, canvasKind: "view", title: "Lenses" },
  { key: EXHIBITS_KEY, canvasKind: "view", title: "Exhibits" },
  // DIGEST_KEY has no surface region of its own anymore — the standing digest folds
  // into the Briefing banner's "The read" register — but the chamber-digest workflow
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
    const { lensStore } = bindLensRuntime({
      sm,
      registerRegion,
      declareView: declareHtmlLensView,
      // Resolved per call, not captured: the driver is built below (and rebuilt on a
      // re-bootstrap), so binding it here by value would pin a stale one.
      republishRoom: (slug) => getDriver()?.republish(slug) ?? Promise.resolve(),
    });
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
  onAction: (action) => dispatchChamberAction(action),

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

export default rib;
