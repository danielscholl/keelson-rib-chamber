import type { CanvasBoardView, RibAction, RibActionResult } from "@keelson/shared";
import { asNonEmptyString, errText } from "@keelson/shared";
import { canonicalLensId, lensKey, lensRefreshInputs } from "../lens.ts";
import { HTML_LENS_KEY, htmlLensKey } from "../lens-html.ts";
import { createFileHtmlLensStore } from "../lens-html-store.ts";
import {
  awaitHtmlLensReconcile,
  awaitLensReconcile,
  deleteHtmlLensRecord,
  deleteRecordOfKind,
  enqueueLensWrite,
  getHtmlLensRegistry,
  getLensRegistry,
  refreshExhibitIndex,
} from "../lens-runtime.ts";
import { createFileLensStore, isExhibit, type LensRecord, lensProvenance } from "../lens-store.ts";
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

// Which species a card's verb is aimed at. The two stores hold separate id spaces, so
// an unqualified id is ambiguous once HTML lenses share the index. Absent means canvas:
// every payload minted before the field, and every non-index caller, means the board
// store. Anything else is rejected rather than folded — lens-open is frame-safe, so a
// garbled kind must fail closed rather than resolve to some other lens's key.
type LensSpecies = "canvas" | "html";

function lensSpecies(action: RibAction): { species: LensSpecies } | { error: string } {
  const raw = ((action.payload ?? {}) as Record<string, unknown>).kind;
  if (raw === undefined) return { species: "canvas" };
  if (raw !== "canvas" && raw !== "html") {
    return { error: `unknown lens kind: ${JSON.stringify(raw)}` };
  }
  return { species: raw };
}

// Retire an HTML lens: the head ⋯ verb on its panel, and one of the two surfaces
// deleteHtmlLensRecord backs (chamber_retire_lens is the other).
export async function retireHtmlLensAction(action: RibAction): Promise<RibActionResult> {
  const got = lensActionId(action, "retire-lens-html");
  if ("error" in got) return { ok: false, error: got.error };
  const res = await deleteHtmlLensRecord(got.id);
  return res.ok ? { ok: true, data: { id: res.id, key: res.key } } : res;
}

// Re-compose a living lens on demand: the Refresh verb on a refresh-backed
// lens's index card. Fires the record's named workflow on the same inputs the
// panel's cadence fires it on — lensRefreshInputs is shared with regionFor so the
// two agree and the harness collapses them onto one run — and returns as soon as
// the run is started; the re-emit republishes the panel and its index card.
export async function refreshLensAction(action: RibAction): Promise<RibActionResult> {
  const got = lensActionId(action, "refresh-lens");
  if ("error" in got) return { ok: false, error: got.error };
  const { id } = got;
  const species = lensSpecies(action);
  if ("error" in species) return { ok: false, error: species.error };
  const hostRefreshWorkflow = getHostRefreshWorkflow();
  if (!hostRefreshWorkflow) {
    return { ok: false, error: "workflow refresh unavailable on this harness" };
  }
  try {
    // Each species keeps its own store, so the kind picks which one holds the backing.
    // The record is loaded (not just its refresh) so an absent lens and a lens with no
    // backing stay distinguishable — they want different things from the operator.
    const record =
      species.species === "html"
        ? await createFileHtmlLensStore(htmlLensesDir()).load(id)
        : await createFileLensStore(lensesDir()).loadLens(id);
    if (!record) return { ok: false, error: `lens '${id}' not found` };
    if (species.species === "canvas" && isExhibit(record as LensRecord)) {
      return { ok: false, error: `'${id}' is an exhibit — exhibits don't refresh` };
    }
    if (!record.refresh) {
      // Species-specific remediation: a page has no generic re-author, so `refresh: {}`
      // — which the canvas emit fills in with chamber-lens-refresh — is refused there.
      return {
        ok: false,
        error:
          species.species === "html"
            ? `lens '${id}' has no refresh backing — re-emit it with chamber_emit_lens_html refresh: { workflow: "chamber-lens-<name>" }`
            : `lens '${id}' has no refresh backing — re-author it with chamber_emit_lens refresh: {}`,
      };
    }
    await hostRefreshWorkflow(
      record.refresh.workflow,
      lensRefreshInputs(id, record.refresh.inputs),
    );
    return { ok: true, data: { id, workflow: record.refresh.workflow } };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

// Open a lens: return the host open-canvas effect focusing the lens's live board in
// the drawer. This is the ONLY way to read an unpinned lens, and the same verb an
// exhibit's card dispatches — one handler, one effect, one drawer. A lens is
// live-published the whole time it exists, pinned or not, so its snapshot key always
// resolves — no deferral (unlike a closed room). Non-destructive and side-effect-free;
// fails closed on a missing/unsafe id (canonicalLensId rejects garbage) so a
// stale/garbled payload can't open a bad key.
export function lensOpenAction(action: RibAction): RibActionResult {
  const got = lensActionId(action, "lens-open");
  if ("error" in got) return { ok: false, error: got.error };
  const species = lensSpecies(action);
  if ("error" in species) return { ok: false, error: species.error };
  const key = species.species === "html" ? htmlLensKey(got.id) : lensKey(got.id);
  return { ok: true, data: { effect: "open-canvas", key, title: got.id } };
}

// Pin or unpin a lens's Chamber panel: the index card's toggle and the panel head's
// Unpin verb both land here, carrying the target state so a stale card can't toggle
// against state it isn't showing. Operator-only — deliberately absent from
// chamber_emit_lens and from FRAME_SAFE_ACTIONS, since an authoring Mind claiming
// surface is the clutter this exists to remove.
export async function pinLensAction(action: RibAction): Promise<RibActionResult> {
  const got = lensActionId(action, "pin-lens");
  if ("error" in got) return { ok: false, error: got.error };
  const { id } = got;
  const species = lensSpecies(action);
  if ("error" in species) return { ok: false, error: species.error };
  const pinned = ((action.payload ?? {}) as Record<string, unknown>).pinned;
  if (typeof pinned !== "boolean") {
    return { ok: false, error: "pin-lens requires payload { id, pinned: boolean }" };
  }
  const html = species.species === "html";
  const registry = html ? getHtmlLensRegistry() : getLensRegistry();
  if (!registry) return { ok: false, error: "pin unavailable (region seam absent)" };
  // Read-modify-write, like the note write-back: serialize it so a pin can't lose-update
  // against a concurrent note or witness stamp.
  const apply = async (): Promise<RibActionResult> => {
    try {
      await (html ? awaitHtmlLensReconcile() : awaitLensReconcile());
      // Each write below spreads the loaded record so its updatedAt rides through
      // unchanged: a pin changes no content, and the brief and digest gates fingerprint
      // on `${id}=${updatedAt}`, so letting the store re-stamp would buy two paid turns
      // for a lens that says exactly what it said before (and jump it up a newest-first
      // index it didn't earn).
      //
      // The live half ALWAYS runs, even when the record already says what was asked. A
      // lens whose region registration failed has a record and no entry, so a durable
      // early-out would report success over a missing panel and leave every retry doing
      // the same — the one state that cannot heal itself before a restart. setPin
      // returning false is exactly that case (an exhibit is refused above), so re-register
      // from the record and converge now.
      if (html) {
        const store = createFileHtmlLensStore(htmlLensesDir());
        const record = await store.load(id);
        if (!record) return { ok: false, error: `lens '${id}' not found` };
        if ((record.pinned === true) !== pinned) await store.save({ ...record, pinned });
        if (!registry.setPin(id, pinned)) {
          await getHtmlLensRegistry()?.reregister(
            id,
            record.html,
            pinned,
            record.title,
            record.refresh,
          );
        }
      } else {
        const store = createFileLensStore(lensesDir());
        const record = await store.loadLens(id);
        if (!record) return { ok: false, error: `lens '${id}' not found` };
        if (isExhibit(record)) {
          return { ok: false, error: `'${id}' is an exhibit — exhibits have no panel` };
        }
        if ((record.pinned === true) !== pinned) await store.saveLens({ ...record, pinned });
        if (!registry.setPin(id, pinned)) {
          await getLensRegistry()?.reregister(id, record.board, pinned, "lens", record.refresh);
        }
      }
      // The card's label and pill changed, so its index is stale. NOT chamber-roster —
      // "Live views" counts standing lenses regardless of panel — and NOT the brief
      // gate: a free layout toggle must never promote a paid briefing turn.
      await refreshWorkflow("chamber-lenses").catch(() => {});
      await refreshStandingPanels();
      return { ok: true, data: { id, pinned } };
    } catch (e) {
      return { ok: false, error: errText(e) };
    }
  };
  return enqueueLensWrite(apply);
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
      // Round-trip the provenance, the kind, the pin, and the refresh backing
      // (lensProvenance picks every provenance field), so an annotated exhibit can't come
      // back as a lens with no source room, and an annotated lens keeps its wiring and
      // its panel — a note must never unpin what it annotates.
      const { key } = await registry.publish(
        id,
        appendLensNote(record.board, note),
        record.pinned === true,
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
