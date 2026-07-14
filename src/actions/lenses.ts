import type { CanvasBoardView, RibAction, RibActionResult } from "@keelson/shared";
import { asNonEmptyString, errText } from "@keelson/shared";
import { canonicalLensId, lensKey, lensRefreshInputs } from "../lens.ts";
import { HTML_LENS_KEY, htmlLensKey } from "../lens-html.ts";
import { createFileHtmlLensStore } from "../lens-html-store.ts";
import {
  awaitHtmlLensReconcile,
  awaitLensReconcile,
  deleteRecordOfKind,
  enqueueLensWrite,
  getHtmlLensRegistry,
  getLensRegistry,
  refreshExhibitIndex,
} from "../lens-runtime.ts";
import { createFileLensStore, isExhibit, lensProvenance } from "../lens-store.ts";
import { htmlLensesDir, lensesDir } from "../paths.ts";
import { getHostRefreshWorkflow, refreshStandingPanels, refreshWorkflow } from "../runtime.ts";

export async function retireLensAction(action: RibAction): Promise<RibActionResult> {
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

export async function deleteExhibitAction(action: RibAction): Promise<RibActionResult> {
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
export async function retireHtmlLensAction(action: RibAction): Promise<RibActionResult> {
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
export async function refreshLensAction(action: RibAction): Promise<RibActionResult> {
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
export function lensOpenAction(action: RibAction): RibActionResult {
  const got = lensActionId(action, "lens-open");
  if ("error" in got) return { ok: false, error: got.error };
  return { ok: true, data: { effect: "open-canvas", key: lensKey(got.id), title: got.id } };
}

export function lensHtmlAction(action: RibAction): RibActionResult {
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
export async function lensNoteAction(action: RibAction): Promise<RibActionResult> {
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
        await refreshExhibitIndex();
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
