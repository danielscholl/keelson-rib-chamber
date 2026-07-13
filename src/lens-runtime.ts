import type { RibContext, SnapshotManager } from "@keelson/shared";
import { errText } from "@keelson/shared";
import { canonicalLensId, createLensRegistry, type LensRegistry, lensKey } from "./lens.ts";
import { createHtmlLensRegistry, type HtmlLensRegistry } from "./lens-html.ts";
import { createFileHtmlLensStore, listHtmlLenses } from "./lens-html-store.ts";
import { createFileLensStore, isExhibit, type LensKind, listLenses } from "./lens-store.ts";
import { htmlLensesDir, lensesDir } from "./paths.ts";
import { refreshStandingPanels, refreshWorkflow } from "./runtime.ts";
import type { Room } from "./types.ts";

// The lens registry is a boot-time singleton: it owns the per-subject snapshot
// registrations and surface regions, created once in registerTools and disposed in
// dispose() so a re-register doesn't duplicate-register. lensSm tracks the manager it
// was built against, so a re-bootstrap with a different one rebinds it.
let lensRegistry: LensRegistry | undefined;
let lensSm: SnapshotManager | undefined;
let htmlLensRegistry: HtmlLensRegistry | undefined;
let htmlLensSm: SnapshotManager | undefined;
// Tracked alongside htmlLensSm because createHtmlLensRegistry captures registerRegion:
// a re-bootstrap that reuses the same manager but hands a fresh seam must rebuild, or
// the registry would publish/register through the stale registerRegion.
let htmlLensRegisterRegion: NonNullable<RibContext["registerRegion"]> | undefined;

// In flight while boot re-registration runs. retire awaits it so a retire landing
// mid-reconcile can't race a reregister into resurrecting the just-deleted lens (a
// live key/panel with no on-disk record).
let lensReconcileInFlight: Promise<void> | undefined;

// Serializes lens write-backs (the lens-note action's load-append-publish) so two
// concurrent appends to the same board can't lose-update each other. Mirrors
// briefInFlight: a global chain, reset on dispose so a re-boot starts fresh.
let lensWriteInFlight: Promise<unknown> = Promise.resolve();

// The current lens registries, read by the tool factories, driver wiring, and the
// retire/refresh verbs still living in index.ts. Undefined until bindLensRuntime wires
// them (and while a seam is absent), so every caller guards on the return.
export function getLensRegistry(): LensRegistry | undefined {
  return lensRegistry;
}

export function getHtmlLensRegistry(): HtmlLensRegistry | undefined {
  return htmlLensRegistry;
}

// Await the boot re-registration if one is in flight, so a delete/retire lands only
// after reconcile settles (else a reregister could resurrect the just-deleted lens).
// Reads the module-current promise at call time; a no-op when none is running.
export function awaitLensReconcile(): Promise<void> {
  return lensReconcileInFlight?.catch(() => {}) ?? Promise.resolve();
}

export function awaitHtmlLensReconcile(): Promise<void> {
  return htmlLensReconcileInFlight?.catch(() => {}) ?? Promise.resolve();
}

// Enqueue one record-file mutation behind every prior one. Chains on settle
// (never letting a rejected tail poison the queue) and returns this mutation's
// own completion for callers that await it — the one idiom behind the emit,
// table, stamp, and note write paths.
export function enqueueLensWrite<T>(apply: () => Promise<T>): Promise<T> {
  const run = lensWriteInFlight.then(apply, apply);
  lensWriteInFlight = run.catch(() => {});
  return run;
}

function reconcileLensPanels(registry: LensRegistry): void {
  lensReconcileInFlight = (async () => {
    let records: Awaited<ReturnType<typeof listLenses>>;
    try {
      records = await listLenses(lensesDir());
    } catch (e) {
      console.error(`[rib-chamber] lens re-registration failed: ${errText(e)}`);
      return;
    }
    for (const rec of records) {
      try {
        // Kind and refresh ride through so an exhibit's panel comes back on its
        // own shelf and a living lens comes back with its re-compose wiring.
        await registry.reregister(
          rec.id,
          rec.board,
          isExhibit(rec) ? "exhibit" : "lens",
          rec.refresh,
        );
      } catch (e) {
        console.error(`[rib-chamber] lens '${rec.id}' re-registration failed: ${errText(e)}`);
      }
    }
  })();
  void lensReconcileInFlight;
}

// The HTML twin of reconcileLensPanels: re-publish every persisted HTML lens on
// boot so its key, region, and views entry come back after a restart, via
// reregister (no re-save, authored updatedAt preserved), fail-soft per entry.
// Tracked in flight for the same reason as lensReconcileInFlight: the retire
// verb awaits it so a retire landing mid-reconcile can't race a reregister into
// resurrecting the just-deleted lens.
let htmlLensReconcileInFlight: Promise<void> | undefined;

function reconcileHtmlLensPanels(registry: HtmlLensRegistry): void {
  htmlLensReconcileInFlight = (async () => {
    let records: Awaited<ReturnType<typeof listHtmlLenses>>;
    try {
      records = await listHtmlLenses(htmlLensesDir());
    } catch (e) {
      console.error(`[rib-chamber] html lens re-registration failed: ${errText(e)}`);
      return;
    }
    for (const rec of records) {
      try {
        await registry.reregister(rec.id, rec.html, rec.title);
      } catch (e) {
        console.error(`[rib-chamber] html lens '${rec.id}' re-registration failed: ${errText(e)}`);
      }
    }
  })();
}

// Both indexes that render an exhibit — its own shelf card and the producing
// room's tabled link — refreshed together (concurrently; the collectors are
// independent and each fail-soft) so neither goes stale after a mutation.
export async function refreshExhibitIndexes(): Promise<void> {
  await Promise.all([
    refreshWorkflow("chamber-exhibits").catch(() => {}),
    refreshWorkflow("chamber-rooms").catch(() => {}),
  ]);
}

// The witnessed-provenance stamp: the room driver saw the table-exhibit tool fire
// in a turn it ran, so record the room as each exhibit's source — serialized on
// lensWriteInFlight with the other record writers, fail-soft per id, and
// preserving updatedAt (a provenance stamp is not a re-tabling). The stamp is
// the room's SLUG (the stable identifier room cards and open links join on);
// display sites resolve it to the room's name, falling back to the raw value.
export function stampExhibitSources(rawIds: readonly string[], room: Room): void {
  const source = room.slug;
  const apply = async (): Promise<void> => {
    await lensReconcileInFlight?.catch(() => {});
    const store = createFileLensStore(lensesDir());
    let stamped = false;
    for (const rawId of rawIds) {
      const id = canonicalLensId(rawId);
      if (!id) continue;
      try {
        const record = await store.loadLens(id);
        if (!record || !isExhibit(record) || record.sourceRoom === source) continue;
        await store.saveLens({ ...record, sourceRoom: source });
        stamped = true;
      } catch (e) {
        console.error(`[rib-chamber] exhibit '${id}' source stamp failed: ${errText(e)}`);
      }
    }
    // One refresh per index for the batch — the exhibit card's "from" field and
    // the room card's "tabled" link both just appeared.
    if (stamped) await refreshExhibitIndexes();
  };
  void enqueueLensWrite(apply);
}

// One kind-checked delete backs all four delete verbs (two board actions, two
// tools): serialize behind boot re-registration (a delete must not race a
// reregister into resurrecting the record), verify the record's species, delete,
// release the live panel, then refresh that shelf's index. `crossKind` supplies
// the surface-appropriate steering message (board verbs name the sibling index,
// tools name the sibling tool).
export async function deleteRecordOfKind(
  rawId: string,
  expected: LensKind,
  crossKind: (id: string) => string,
): Promise<{ ok: true; id: string; key: string } | { ok: false; error: string }> {
  const noun = expected === "exhibit" ? "exhibit" : "lens";
  const id = canonicalLensId(rawId);
  if (!id) return { ok: false, error: `unsafe ${noun} id: ${JSON.stringify(rawId)}` };
  try {
    await lensReconcileInFlight?.catch(() => {});
    const store = createFileLensStore(lensesDir());
    const record = await store.loadLens(id);
    if (record && isExhibit(record) !== (expected === "exhibit")) {
      return { ok: false, error: crossKind(id) };
    }
    if (!record && expected === "exhibit") {
      return { ok: false, error: `exhibit '${id}' not found` };
    }
    try {
      await store.deleteLens(id);
    } catch (e) {
      // The store's not-found message says "lens"; keep the verb's noun honest
      // when a concurrent delete wins the race.
      if (expected === "exhibit" && /not found/.test(errText(e))) {
        return { ok: false, error: `exhibit '${id}' not found` };
      }
      throw e;
    }
    lensRegistry?.remove(id);
    if (expected === "exhibit") {
      // A room card listing this exhibit as tabled must drop the dead link.
      await refreshExhibitIndexes();
    } else {
      await refreshWorkflow("chamber-lenses").catch(() => {});
      // The retired lens drops from the roster pulse's "Live views" count too —
      // refresh it so the count matches the just-updated index.
      await refreshWorkflow("chamber-roster").catch(() => {});
    }
    await refreshStandingPanels();
    return { ok: true, id, key: lensKey(id) };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

// Wire the lens + HTML-lens registries against the current seams, mirroring the
// singleton discipline of the room driver: build once, reuse on a later registerTools,
// and rebuild against a new manager (or a fresh registerRegion) on a re-bootstrap
// without an intervening dispose. Each replacement is built BEFORE the old one is
// disposed so a failed rebuild leaves the existing registry + its sm marker consistent.
// declareView is injected (index passes declareHtmlLensView) so the module never
// touches the rib's view array. Returns the lens store for the tool factories.
export function bindLensRuntime(seams: {
  sm?: SnapshotManager;
  registerRegion?: RibContext["registerRegion"];
  declareView: (id: string, title?: string) => () => void;
}): { lensStore: ReturnType<typeof createFileLensStore> } {
  const { sm, registerRegion, declareView } = seams;
  const lensStore = createFileLensStore(lensesDir());
  if (!sm || !registerRegion) {
    htmlLensRegistry?.dispose();
    htmlLensRegistry = undefined;
    htmlLensSm = undefined;
    htmlLensRegisterRegion = undefined;
  } else if (!htmlLensRegistry || sm !== htmlLensSm || registerRegion !== htmlLensRegisterRegion) {
    const next = createHtmlLensRegistry(
      sm,
      registerRegion,
      createFileHtmlLensStore(htmlLensesDir()),
      declareView,
    );
    htmlLensRegistry?.dispose();
    htmlLensRegistry = next;
    htmlLensSm = sm;
    htmlLensRegisterRegion = registerRegion;
    // Re-register every persisted HTML lens so it survives a restart (key +
    // region + views entry back live). Fail-soft per entry, like board lenses.
    reconcileHtmlLensPanels(next);
  }
  if (sm && registerRegion && sm !== lensSm) {
    const next = createLensRegistry(sm, registerRegion, lensStore);
    lensRegistry?.dispose();
    lensRegistry = next;
    lensSm = sm;
    // Re-register every persisted lens so it survives a restart: each becomes a
    // live region again (its snapshot key present for the index/open path).
    // Fail-soft per entry — one bad lens can't break boot.
    reconcileLensPanels(next);
  }
  return { lensStore };
}

// Tear down the lens runtime: drain any in-flight lens write-back BEFORE tearing down
// the registries, so a late load-append-publish can't publish to a disposed registry
// or interleave with a re-boot's writes; then dispose both registries and drop their
// sm markers so a re-boot rebuilds cleanly.
export async function disposeLensRuntime(): Promise<void> {
  await lensWriteInFlight.catch(() => {});
  lensWriteInFlight = Promise.resolve();
  htmlLensRegistry?.dispose();
  htmlLensRegistry = undefined;
  htmlLensSm = undefined;
  htmlLensRegisterRegion = undefined;
  lensRegistry?.dispose();
  lensRegistry = undefined;
  lensSm = undefined;
}
