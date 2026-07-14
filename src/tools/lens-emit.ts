import type { ToolDefinition } from "@keelson/shared";
import {
  CANVAS_PUBLISH_CONTRACT,
  canvasBoardViewSchema,
  errText,
  formatPaletteReport,
  validateCategoricalPalette,
  z,
} from "@keelson/shared";
import { evaluateBriefGate } from "../brief-gate.ts";
import {
  canonicalLensId,
  EXHIBIT_TOOL_NAME,
  LENS_TOOL_NAME,
  type LensRegistry,
  MIN_REFRESH_CADENCE_MS,
} from "../lens.ts";
import {
  declaredHtmlPalettes,
  HTML_LENS_TOOL_NAME,
  type HtmlLensRegistry,
  htmlLensStructuralError,
} from "../lens-html.ts";
import {
  awaitLensReconcile,
  deleteRecordOfKind,
  enqueueLensWrite,
  refreshExhibitIndex,
} from "../lens-runtime.ts";
import { isExhibit, type LensRefresh, type LensStore } from "../lens-store.ts";
import { refreshStandingPanels, refreshWorkflow } from "../runtime.ts";
import { LENS_REFRESH_WORKFLOW } from "../workflows.ts";
import { emitResult } from "./util.ts";

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

export function makeLensTool(store: LensStore, registry: LensRegistry): ToolDefinition {
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

const lensHtmlEmitSchema = z.object({
  html: z.string().min(1).max(262144),
  id: z.string().min(1).max(64).optional(),
  title: z.string().min(1).max(80).optional(),
});

export function makeEmitLensHtmlTool(registry: HtmlLensRegistry): ToolDefinition {
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
export function makeRetireLensTool(): ToolDefinition {
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

export function makeTableExhibitTool(store: LensStore, registry: LensRegistry): ToolDefinition {
  return {
    name: EXHIBIT_TOOL_NAME,
    description:
      "Table an exhibit: publish a canvas `board` DELIVERABLE your discussion produced, where it lands in the Tabled section of your room's own board — a point-in-time record (an assessment, a plan, a findings summary), kept until the exhibit or its room is deleted. `id` is a short, stable kebab-case identifier for the deliverable; `board` is the canvas board view; optional `reason` is a one-line gist of what the exhibit holds. Call it once when the discussion has converged on something worth keeping. NOT for a standing view you intend to keep updating — author that with chamber_emit_lens.",
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
          await refreshExhibitIndex();
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

export function makeDeleteExhibitTool(): ToolDefinition {
  return {
    name: "chamber_delete_exhibit",
    description:
      "Delete an exhibit: permanently remove a tabled deliverable — its persisted record and its snapshot key, so it drops from the Tabled section of the room that tabled it. `id` is the exhibit's stable kebab-case identifier (the same id chamber_table_exhibit used; see chamber_list_exhibits). Fails closed if no such exhibit exists. NOT for retiring a lens (chamber_retire_lens).",
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
