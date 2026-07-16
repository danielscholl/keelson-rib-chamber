import { join } from "node:path";
import type { ToolDefinition } from "@keelson/shared";
import {
  CANVAS_PUBLISH_CONTRACT,
  canvasBoardViewSchema,
  errText,
  formatPaletteReport,
  validateCategoricalPalette,
  z,
} from "@keelson/shared";
import { BOARD_COMPOSITION_CONTRACT } from "../board-guidance.ts";
import { evaluateBriefGate } from "../brief-gate.ts";
import {
  boardsEqual,
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
import type { HtmlLensStore } from "../lens-html-store.ts";
import {
  awaitHtmlLensReconcile,
  awaitLensReconcile,
  deleteHtmlLensRecord,
  deleteRecordOfKind,
  enqueueLensWrite,
  refreshExhibitIndex,
} from "../lens-runtime.ts";
import { isExhibit, type LensRefresh, type LensStore } from "../lens-store.ts";
import { MAX_REFRESH_WORKFLOW_NAME } from "../lens-workflows.ts";
import { htmlLensesDir, lensesDir } from "../paths.ts";
import { recordDirState } from "../record-dir.ts";
import { refreshStandingPanels, refreshWorkflow } from "../runtime.ts";
import { isChamberWorkflow, LENS_REFRESH_WORKFLOW } from "../workflows.ts";
import { emitResult } from "./util.ts";

// Lens publish seam: the chamber-lens workflow's prompt node composes a canvas
// board and calls this tool to publish it under a per-subject key. `id` routes
// re-authoring of the same subject back to the same panel; the board is validated
// fail-closed (the key's expectView guard) before it is broadcast. scope /
// maintainingMind / reason are the index card's optional PROVENANCE — the agent
// supplies what it can name (never fabricated); each is omitted when absent.
// scope and maintainingMind are durable identity, so they take the same
// absent-preserves / null-clears rule as refresh — a custom refresh workflow has no
// reason to know it must re-state them. reason describes ONE authoring, so omitting
// it clears: carrying it forward would caption the next revision with the last
// one's story.
const lensEmitSchema = z.object({
  id: z.string().min(1).max(64),
  board: canvasBoardViewSchema,
  scope: z.string().min(1).max(40).nullable().optional(),
  maintainingMind: z.string().min(1).max(40).nullable().optional(),
  reason: z.string().min(1).max(120).optional(),
  // The lens's re-compose backing. Absent PRESERVES an existing lens's config —
  // a refresh turn re-emitting the board must not strip its own backing — and
  // null clears it. An object PATCHES the prior backing: an omitted field keeps
  // its prior value, `workflow` bottoming out at the bundled chamber-lens-refresh
  // re-author; the floor/ceiling keep a typo'd cadence from thrashing turns.
  // `inputs` are the producer's own parameters, so a data lens's id need not double
  // as its workflow's argument.
  refresh: z
    .object({
      workflow: z.string().min(1).max(MAX_REFRESH_WORKFLOW_NAME).optional(),
      cadenceMs: z.number().int().min(MIN_REFRESH_CADENCE_MS).max(86_400_000).optional(),
      // Checked here as well as at the store fold: the fold is the degradation path
      // for a hand-edited record, and without a schema check a live emit would fail
      // closed against the region's workflowArgs — naming a field the author never
      // wrote — instead of against the one they did.
      inputs: z.record(z.string().min(1).max(64), z.string().max(512)).optional(),
    })
    .nullable()
    .optional(),
});

export function makeLensTool(store: LensStore, registry: LensRegistry): ToolDefinition {
  return {
    name: LENS_TOOL_NAME,
    description:
      "Author a lens: render a canvas `board` you compose, published with no hand-coded UI — a STANDING VIEW on a subject you maintain by re-authoring the same id. It lands in the Chamber Lenses index, where the operator reads it with Open (it renders in the drawer) and may PIN it to keep it on the Chamber surface as a panel; pinning is the operator's choice alone and is not yours to set. `id` is a short, stable kebab-case identifier for the subject (re-authoring the same id updates the same lens); `board` is the canvas board view. Optional provenance for the lenses index card — supply only what you can truthfully name, never invent: `scope` (the board's kind, e.g. \"status board\" / \"timeline\" / \"checklist\"), `maintainingMind` (YOUR own Mind name/slug, the lens's maintainer), `reason` (a short note on what changed in this authoring). On a re-author, omitting `scope` or `maintainingMind` KEEPS the lens's existing value (pass null to clear one) — you need not re-state them; omitting `reason` clears it, since it describes a single authoring. Optional `refresh` makes it a LIVING view: `{ workflow?, cadenceMs?, inputs? }` names a workflow that re-composes and re-emits the lens with input `lens` = this id, plus any `inputs` you give (default workflow chamber-lens-refresh, default cadence 1h). It runs on that cadence only while the lens is PINNED and the Chamber surface is open — the cadence is the panel's. An unpinned lens re-composes when the operator hits Refresh on its index card, so a refresh backing is still worth setting; it just will not tick on its own until someone pins it. Use `inputs` for the producer's own parameters rather than encoding them in the id. The harness runs only a RIB-CONTRIBUTED workflow on a panel's cadence: chamber contributes chamber-lens-refresh plus one `chamber-lens-<filename>` per workflow file the operator has placed in chamber's lens-workflows dir — a workflow in the general catalog is refused and the panel silently never re-composes. Omitting `refresh` on a re-author keeps the existing backing; an object PATCHES it (an omitted field keeps its prior value); `refresh: null` removes it. Call it once per lens. To let a viewer annotate the lens in place, include an `actions` section whose action has `type: \"lens-note\"`, `payload: { id: <this lens id> }`, and one multiline field named `note` — submitting it appends the note to the lens. The chamber-lens workflow (/workflow run chamber-lens <subject>) is the standalone entry point. NOT for a deliverable a discussion produced — table that with chamber_table_exhibit. " +
      BOARD_COMPOSITION_CONTRACT,
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
          const provenance = {
            scope: resolveProvenanceField(parsed.data.scope, existing?.scope),
            maintainingMind: resolveProvenanceField(
              parsed.data.maintainingMind,
              existing?.maintainingMind,
            ),
            reason: parsed.data.reason,
          };
          // Freshness is the board's. An unchanged board holds the prior stamp (the
          // brief and digest gates fingerprint on it, so re-stamping buys two paid
          // turns for a lens that says what it said before); a changed board must
          // outrun that stamp, since those gates compare it exactly and the store's
          // clock only has millisecond resolution. An unparseable prior gets neither:
          // listLenses skips such a record, and the store's fresh stamp is what heals
          // it.
          const prior =
            existing && Number.isFinite(Date.parse(existing.updatedAt)) ? existing : undefined;
          const updatedAt = !prior
            ? undefined
            : boardsEqual(prior.board, parsed.data.board)
              ? prior.updatedAt
              : new Date(Math.max(Date.now(), Date.parse(prior.updatedAt) + 1)).toISOString();
          // The host refreshes only a workflow with RIB provenance, and its refresh
          // seam is fail-soft, so a backing it won't run is otherwise a silent 409 on
          // every tick. Chamber can vouch for the workflows it contributed and no
          // more — another rib may legitimately own the named one — so this is a
          // caveat in the reply, the one place the author can hear it, not a reject.
          const unvouchedWorkflow =
            parsed.data.refresh?.workflow && !isChamberWorkflow(parsed.data.refresh.workflow)
              ? parsed.data.refresh.workflow
              : undefined;
          // Pin is the operator's, never the author's — it is not on this schema, so it
          // rides through from the prior record. Omitting it would drop it (saveLens
          // writes only what it is handed), and a living lens re-authors on its own
          // cadence, so a pinned one would unpin itself within the hour.
          const { key } = await registry.publish(
            id,
            parsed.data.board,
            existing?.pinned === true,
            provenance,
            "lens",
            refresh,
            updatedAt,
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
          // A refresh backing on an unpinned lens has no cadence to run on — the wiring
          // is the panel's. That is not a reject (the backing is still live behind the
          // card's Refresh, and pinning is the operator's call, not this author's), so
          // it is a caveat in the reply: the one place the author can hear it.
          const unpinnedBacking = refresh && existing?.pinned !== true;
          emitResult(
            ctx,
            JSON.stringify({
              ok: true,
              key,
              ...(unvouchedWorkflow
                ? {
                    note: `refresh names '${unvouchedWorkflow}', which chamber does not contribute — unless another rib does, the harness will refuse to run it and the panel will never re-compose. A workflow file in the chamber lens-workflows dir is contributed as 'chamber-lens-<filename>'.`,
                  }
                : {}),
              ...(unpinnedBacking
                ? {
                    pinNote: `'${id}' is not pinned, so its refresh backing will not tick on a cadence — it re-composes when the operator hits Refresh on its index card, or continuously once they pin it to the Chamber surface. Nothing to fix; pinning is the operator's call.`,
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

type RefreshInput = { workflow?: string; cadenceMs?: number; inputs?: Record<string, string> };

// Patch an emit's refresh fields over the prior backing — each omitted field keeps
// its prior value, so a cadence-only re-author can't silently swap a bespoke refresh
// workflow for something else. `workflow` is left absent when neither names one: the
// two species disagree about what that means, so each resolver below decides.
function patchLensRefresh(input: RefreshInput, prior: LensRefresh | undefined): RefreshInput {
  const workflow = input.workflow ?? prior?.workflow;
  const cadenceMs = input.cadenceMs ?? prior?.cadenceMs;
  // An empty inputs object is no inputs: it reaches the region as the same
  // workflowArgs an absent one does, so storing it would only make sameRefresh
  // read a backing change that isn't one.
  const inputs = input.inputs ?? prior?.inputs;
  return {
    ...(workflow !== undefined ? { workflow } : {}),
    ...(cadenceMs !== undefined ? { cadenceMs } : {}),
    ...(inputs && Object.keys(inputs).length > 0 ? { inputs } : {}),
  };
}

// Resolve an emit's refresh input against the prior record: absent preserves
// (a refresh turn re-emitting the board must not strip its own backing), null
// clears, and an object patches — bottoming out at the bundled generic re-author,
// which can re-compose any canvas lens from its stored board.
function resolveLensRefresh(
  input: RefreshInput | null | undefined,
  prior: LensRefresh | undefined,
): LensRefresh | undefined {
  if (input === undefined) return prior;
  if (input === null) return undefined;
  const patched = patchLensRefresh(input, prior);
  return { ...patched, workflow: patched.workflow ?? LENS_REFRESH_WORKFLOW };
}

// The HTML twin, differing in one way: there is no default workflow, so a backing
// that names none is refused rather than filled in. Nothing generic could re-compose
// an HTML lens — the canvas default works by re-reading the prior board through
// chamber_list_lenses, and a 262K page cannot come back through a 16K tool result;
// re-authoring one from the subject alone would instead redesign the page every tick,
// never landing on identical markup, so the freshness skip would never fire and each
// tick would buy a paid turn for a page that says what it said before. A living HTML
// lens is therefore one an operator's own producer keeps current.
function resolveHtmlLensRefresh(
  input: RefreshInput | null | undefined,
  prior: LensRefresh | undefined,
): { refresh?: LensRefresh } | { error: string } {
  if (input === undefined) return { refresh: prior };
  if (input === null) return {};
  const patched = patchLensRefresh(input, prior);
  if (patched.workflow === undefined) {
    return {
      error:
        "refresh must name a `workflow` — an HTML lens has no generic re-author to fall back on. Point it at a workflow that re-derives the page and emits it, which chamber contributes as 'chamber-lens-<filename>' for each workflow file in its lens-workflows dir.",
    };
  }
  return { refresh: { ...patched, workflow: patched.workflow } };
}

// The resolveLensRefresh twin, for the durable provenance fields: absent preserves
// the prior, null clears. saveLens drops an undefined, so a cleared field leaves no
// key on the record.
function resolveProvenanceField(
  input: string | null | undefined,
  prior: string | undefined,
): string | undefined {
  if (input === undefined) return prior;
  if (input === null) return undefined;
  return input;
}

const lensHtmlEmitSchema = z.object({
  html: z.string().min(1).max(262144),
  id: z.string().min(1).max(64).optional(),
  title: z.string().min(1).max(80).optional(),
  // The canvas seam's field, with the canvas seam's rules (absent preserves, null
  // clears, an object patches) — except `workflow` has no default here, and the
  // legacy id-less canvas cannot take one at all (see resolveHtmlLensRefresh).
  refresh: z
    .object({
      workflow: z.string().min(1).max(MAX_REFRESH_WORKFLOW_NAME).optional(),
      cadenceMs: z.number().int().min(MIN_REFRESH_CADENCE_MS).max(86_400_000).optional(),
      inputs: z.record(z.string().min(1).max(64), z.string().max(512)).optional(),
    })
    .nullable()
    .optional(),
});

export function makeEmitLensHtmlTool(
  registry: HtmlLensRegistry,
  store: HtmlLensStore,
): ToolDefinition {
  return {
    name: HTML_LENS_TOOL_NAME,
    // The shared canvas contract IS the description (one source of truth with the
    // host's canvas_publish); the chamber-specific routing rides ahead of it.
    description: [
      "Author an HTML lens: publish a designed, self-contained HTML page, rendered with no hand-coded UI.",
      "It lands in the Chamber Lenses index, where the operator reads it with Open (it renders in the drawer) and may PIN it to keep it on the Chamber surface as a panel; pinning is the operator's choice alone and is not yours to set.",
      "`id` is a short, stable kebab-case identifier for the subject (re-emitting the same id updates the same lens, and it persists across restarts);",
      "omit it to target the single shared legacy canvas instead. `title` (optional) names the panel head and the index card.",
      "`id` plays the role the contract below calls `name`.",
      "Optional `refresh` makes it a LIVING page: `{ workflow, cadenceMs?, inputs? }` names a workflow that re-derives it with input `lens` = this id, plus any `inputs` you give (default cadence 1h).",
      "It runs on that cadence only while the lens is PINNED and the Chamber surface is open — the cadence is the panel's. An unpinned page re-composes when the operator hits Refresh on its index card, so a backing is still worth setting; it just will not tick on its own until someone pins it.",
      "Unlike a canvas lens, `workflow` is REQUIRED — there is no generic re-author for a page, so a living HTML lens is one whose own producer re-derives it.",
      "The harness runs only a RIB-CONTRIBUTED workflow on a panel's cadence: chamber contributes one `chamber-lens-<filename>` per workflow file the operator has placed in chamber's lens-workflows dir — a workflow in the general catalog is refused and the panel silently never re-composes.",
      "Omitting `refresh` on a re-emit keeps the existing backing; an object PATCHES it; `refresh: null` removes it.",
      CANVAS_PUBLISH_CONTRACT,
    ].join(" "),
    inputSchema: lensHtmlEmitSchema,
    state_changing: true,
    execute(input, ctx) {
      // Serialized on the lens write chain (like the canvas emit): the refresh
      // preserve-vs-clear resolution is a read-modify-write of the record, so two
      // concurrent re-emits of one id could otherwise lose-update its backing.
      const apply = async (): Promise<void> => {
        await emitHtmlLens(input, ctx, registry, store);
      };
      return enqueueLensWrite(apply);
    },
  };
}

async function emitHtmlLens(
  input: unknown,
  ctx: Parameters<ToolDefinition["execute"]>[1],
  registry: HtmlLensRegistry,
  store: HtmlLensStore,
): Promise<void> {
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
  // A backing is wiring on a persisted lens's own region, and the legacy id-less
  // canvas is neither: it has no record to carry one and no id to name in the run.
  // Silently dropping it would read as a living page that never re-composes.
  if (parsed.data.refresh && id === undefined) {
    emitResult(
      ctx,
      "chamber_emit_lens_html: refresh needs an `id` — the shared legacy canvas has no persisted lens to refresh",
      true,
    );
    return;
  }
  try {
    await awaitHtmlLensReconcile();
    const existing = id !== undefined ? await store.load(id) : undefined;
    const resolved = resolveHtmlLensRefresh(parsed.data.refresh, existing?.refresh);
    if ("error" in resolved) {
      emitResult(ctx, `chamber_emit_lens_html: ${resolved.error}`, true);
      return;
    }
    // Freshness is the page's, the canvas emit's rule: a re-emit that left the markup
    // alone holds its prior stamp, so a producer re-deriving unchanged data on cadence
    // reports the freshness it earned rather than the tick it ran on. No strictly-ahead
    // stamp on a change (unlike the canvas twin) — no gate fingerprints this store.
    const prior =
      existing && Number.isFinite(Date.parse(existing.updatedAt)) ? existing : undefined;
    const updatedAt = prior?.html === html ? prior?.updatedAt : undefined;
    // The host refreshes only a workflow with RIB provenance, and its refresh seam is
    // fail-soft, so a backing it won't run is otherwise a silent 409 on every tick.
    // Chamber can vouch for the workflows it contributed and no more (see the canvas twin).
    const unvouched =
      resolved.refresh && !isChamberWorkflow(resolved.refresh.workflow)
        ? resolved.refresh.workflow
        : undefined;
    const { key } = await registry.publish(html, {
      ...(id !== undefined ? { id } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(resolved.refresh ? { refresh: resolved.refresh } : {}),
      ...(updatedAt ? { updatedAt } : {}),
      // The operator's pin, carried from the prior record — the emit schema has no such
      // field. Omitting it here would drop it, and a living page re-emits on its own
      // cadence, so a pinned one would unpin itself (the canvas twin's trap, verbatim).
      ...(existing?.pinned ? { pinned: true } : {}),
    });
    // The lenses index reads BOTH stores, so a newly authored page needs the same prompt
    // collector re-run its canvas twin does — otherwise its only card waits on cadence.
    // Fail-soft, like every collector refresh. Still no roster/brief: the pulse counts
    // board lenses, and a designed page is not briefing substance.
    await refreshWorkflow("chamber-lenses").catch(() => {});
    emitResult(
      ctx,
      JSON.stringify({
        ok: true,
        key,
        ...(unvouched
          ? {
              note: `refresh names '${unvouched}', which chamber does not contribute — unless another rib does, the harness will refuse to run it and the panel will never re-compose. A workflow file in the chamber lens-workflows dir is contributed as 'chamber-lens-<filename>'.`,
            }
          : {}),
      }),
    );
  } catch (e) {
    emitResult(ctx, `chamber_emit_lens_html failed: ${errText(e)}`, true);
  }
}

const lensRetireSchema = z.object({
  id: z.string().min(1).max(64),
  kind: z.enum(["canvas", "html"]).optional(),
});

// Lens retire seam: delete a lens's persisted record AND drop its live panel +
// snapshot key, so an agent can retire a lens it (or another Mind) authored.
// Mirrors the chamber-genesis refresh path: fail-closed on an unknown id
// (deleteLens throws), then refresh the lenses index AFTER success only.
//
// The two species are separate lenses in separate stores, so one id may name both.
// `kind` picks; without it the id resolves to whichever store holds it, and an id in
// BOTH is refused rather than guessed — this is a destructive, unrecoverable verb, so
// the one thing it must not do is delete the lens the caller didn't mean.
export function makeRetireLensTool(): ToolDefinition {
  return {
    name: "chamber_retire_lens",
    description:
      'Retire a lens: permanently remove a lens you (or another Mind) authored — its persisted record AND its live Chamber panel. `id` is the lens\'s stable kebab-case identifier (the same id chamber_emit_lens or chamber_emit_lens_html used). Optional `kind` names the species: "canvas" (an authored board) or "html" (a designed page). The two are separate lenses, so one id can name both; omit `kind` and the id resolves to whichever exists, but if both do you must say which. Fails closed if no such lens exists.',
    inputSchema: lensRetireSchema,
    state_changing: true,
    async execute(input, ctx) {
      const parsed = lensRetireSchema.safeParse(input);
      if (!parsed.success) {
        emitResult(ctx, `chamber_retire_lens: ${parsed.error.message}`, true);
        return;
      }
      const res = await retireLensOfKind(parsed.data.id, parsed.data.kind);
      if (!res.ok) {
        emitResult(ctx, `chamber_retire_lens: ${res.error}`, true);
        return;
      }
      emitResult(ctx, JSON.stringify({ ok: true, kind: res.kind, key: res.key }));
    },
  };
}

// Route a retire to the store that owns the id. An explicit kind goes straight there.
// Absent, the canvas store stays the default — so an id it holds behaves exactly as it
// did before this tool learned the other species, including the exhibit steer — and the
// html store answers only for an id the canvas store has no LENS for.
async function retireLensOfKind(
  rawId: string,
  kind: "canvas" | "html" | undefined,
): Promise<{ ok: true; kind: string; key: string } | { ok: false; error: string }> {
  const canvasRetire = async (): Promise<
    { ok: true; kind: string; key: string } | { ok: false; error: string }
  > => {
    const res = await deleteRecordOfKind(
      rawId,
      "lens",
      (id) => `'${id}' is an exhibit — use chamber_delete_exhibit`,
    );
    return res.ok ? { ok: true, kind: "canvas", key: res.key } : res;
  };
  if (kind === "canvas") return canvasRetire();
  const htmlRetire = async (): Promise<
    { ok: true; kind: string; key: string } | { ok: false; error: string }
  > => {
    const res = await deleteHtmlLensRecord(rawId);
    return res.ok ? { ok: true, kind: "html", key: res.key } : res;
  };
  if (kind === "html") return htmlRetire();
  const id = canonicalLensId(rawId);
  if (!id) return { ok: false, error: `unsafe lens id: ${JSON.stringify(rawId)}` };
  // Probe the record DIRECTORIES, not the loaders: both fold an unreadable record to
  // undefined, so a torn twin would read as absent and collapse the very ambiguity
  // this guard exists to catch — deleting the readable species on a guess.
  const [canvas, html] = await Promise.all([
    recordDirState(join(lensesDir(), id)),
    recordDirState(join(htmlLensesDir(), id)),
  ]);
  // No html twin can exist, so there is nothing to be ambiguous about: the canvas path
  // answers exactly as it did before this verb learned a second species — including
  // "not found" and the exhibit steer.
  if (html === "absent") return canvasRetire();
  if (canvas === "absent") return htmlRetire();
  return {
    ok: false,
    error:
      canvas === "present" && html === "present"
        ? `'${id}' names BOTH a canvas lens and an html lens — pass kind: "canvas" or kind: "html" to say which to retire`
        : `'${id}' cannot be resolved to one species (a record directory is unreadable) — pass kind: "canvas" or kind: "html" to say which to retire`,
  };
}

// Exhibit publish seam — the room driver's turn tool: a discussion tables its
// deliverable (an assessment, a plan, a findings board) as a point-in-time record.
// Deliberately NO sourceRoom input: the room is read from the turn's `turnContext`,
// which the DRIVER sets, so provenance is still observed rather than claimed — a Mind
// cannot name its own room. That read is the primary source and it lands in this same
// write, so an exhibit is owned the instant it exists; the driver's post-hoc witness
// (stampExhibitSources) is the fallback for a host predating the turnContext seam.
const exhibitEmitSchema = z.object({
  id: z.string().min(1).max(64),
  board: canvasBoardViewSchema,
  reason: z.string().min(1).max(120).optional(),
});

export function makeTableExhibitTool(store: LensStore, registry: LensRegistry): ToolDefinition {
  return {
    name: EXHIBIT_TOOL_NAME,
    description:
      "Table an exhibit: publish a canvas `board` DELIVERABLE your discussion produced, where it lands in the Tabled section of your room's own board — a point-in-time record (an assessment, a plan, a findings summary), kept until the exhibit or its room is deleted. `id` is a short, stable kebab-case identifier for the deliverable; `board` is the canvas board view; optional `reason` is a one-line gist of what the exhibit holds. Call it once when the discussion has converged on something worth keeping. NOT for a standing view you intend to keep updating — author that with chamber_emit_lens. " +
      BOARD_COMPOSITION_CONTRACT,
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
          // An exhibit another room already owns: refuse before the publish, which is
          // last-writer-wins. The driver's witness stamp runs after the write and can
          // only repair sourceRoom, never restore the board this would have replaced.
          // Absent room identity we cannot tell a legitimate same-room re-table from a
          // collision, so an unidentified caller may not touch an owned exhibit.
          const callerRoom =
            typeof ctx.turnContext?.roomSlug === "string" ? ctx.turnContext.roomSlug : undefined;
          if (existing?.sourceRoom && existing.sourceRoom !== callerRoom) {
            emitResult(
              ctx,
              `chamber_table_exhibit: '${id}' is owned by another room — pick another id`,
              true,
            );
            return;
          }
          const { key } = await registry.publish(
            id,
            parsed.data.board,
            // An exhibit is never pinned: it holds a key and no panel at any pin state,
            // and it is reached from the room that tabled it.
            false,
            // Claim the room in THIS load-check-publish, which is serialized on the lens
            // write chain. Leaving the first table unowned until the driver's stamp — which
            // waits for the whole turn stream to drain — opens a window where another room
            // publishes the same id over it and the late stamp then claims that room's
            // content. The slug is the DRIVER's, never the agent's, so provenance is still
            // observed rather than claimed. Falls back to the stamp when the host predates
            // the turnContext seam.
            { reason: parsed.data.reason, sourceRoom: existing?.sourceRoom ?? callerRoom },
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
