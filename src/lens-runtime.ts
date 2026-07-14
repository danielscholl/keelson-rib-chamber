import type { RibContext, SnapshotManager } from "@keelson/shared";
import { errText } from "@keelson/shared";
import { evaluateBriefGate } from "./brief-gate.ts";
import { canonicalLensId, createLensRegistry, type LensRegistry, lensKey } from "./lens.ts";
import { createHtmlLensRegistry, type HtmlLensRegistry } from "./lens-html.ts";
import { createFileHtmlLensStore, listHtmlLenses } from "./lens-html-store.ts";
import {
  createFileLensStore,
  isExhibit,
  type LensKind,
  type LensRecord,
  listLenses,
} from "./lens-store.ts";
import { htmlLensesDir, lensesDir } from "./paths.ts";
import { refreshStandingPanels, refreshWorkflow } from "./runtime.ts";
import type { Room } from "./types.ts";

// The lens registry is a boot-time singleton: it owns the per-subject snapshot
// registrations and surface regions, created once in registerTools and disposed in
// dispose() so a re-register doesn't duplicate-register. lensSm + lensRegisterRegion
// track the seams it was built against — createLensRegistry captures BOTH, so a
// re-bootstrap that swaps either must rebuild (or the registry would publish/register
// through a stale seam), mirroring the HTML registry below.
let lensRegistry: LensRegistry | undefined;
let lensSm: SnapshotManager | undefined;
let lensRegisterRegion: NonNullable<RibContext["registerRegion"]> | undefined;
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

// Re-publish a live room's board, injected by bindLensRuntime (the declareView pattern —
// the callback flows WITH the room-lifecycle -> lens-runtime edge, so neither module
// imports the other's owner). Every exhibit mutation a room owns goes through here: the
// room board's Tabled section is a cache the driver cannot invalidate on its own.
let republishRoom: ((slug: string) => Promise<void>) | undefined;

async function republishSourceRoom(slug: string | undefined): Promise<void> {
  if (!slug || !republishRoom) return;
  await republishRoom(slug).catch((e) => {
    console.error(`[rib-chamber] room '${slug}' republish failed: ${errText(e)}`);
  });
}

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

// The exhibits a room tabled, newest-first (listLenses already orders them). The
// join is the driver-witnessed sourceRoom stamp, so an exhibit only reaches a room
// board the driver actually saw produce it. Fail-soft: an unreadable lenses dir
// yields no exhibits rather than failing the board that asked.
export async function tabledExhibitsFor(slug: string): Promise<readonly LensRecord[]> {
  try {
    const records = await listLenses(lensesDir());
    return records.filter((r) => isExhibit(r) && r.sourceRoom === slug);
  } catch (e) {
    console.error(`[rib-chamber] tabled exhibits for '${slug}' failed: ${errText(e)}`);
    return [];
  }
}

// The witnessed-provenance stamp: the room driver saw the table-exhibit tool fire
// in a turn it ran, so record the room as each exhibit's source — serialized on
// lensWriteInFlight with the other record writers, fail-soft per id, and
// preserving updatedAt (a provenance stamp is not a re-tabling). The stamp is
// the room's SLUG (the stable identifier room cards and open links join on);
// display sites resolve it to the room's name, falling back to the raw value.
// The room's own board is republished too: it lands after the turn already published, so
// the Tabled section would otherwise first appear a turn late. Awaited (not voided) so it
// rides lensWriteInFlight, which disposeLensRuntime drains before the room subsystem
// tears down.
export function stampExhibitSources(rawIds: readonly string[], room: Room): void {
  const source = room.slug;
  const apply = async (): Promise<void> => {
    await lensReconcileInFlight?.catch(() => {});
    const store = createFileLensStore(lensesDir());
    let stamped = false;
    // Tracked apart from `stamped`: a RE-table of an id this room already owns writes
    // nothing here, but its content changed, so the room's board is stale either way.
    let owned = false;
    for (const rawId of rawIds) {
      const id = canonicalLensId(rawId);
      if (!id) continue;
      try {
        const record = await store.loadLens(id);
        if (!record || !isExhibit(record)) continue;
        owned = true;
        if (record.sourceRoom === source) continue;
        await store.saveLens({ ...record, sourceRoom: source });
        stamped = true;
      } catch (e) {
        console.error(`[rib-chamber] exhibit '${id}' source stamp failed: ${errText(e)}`);
      }
    }
    // One refresh per index for the batch — the exhibit card's "from" field and
    // the room card's "tabled" link both just appeared.
    if (stamped) await refreshExhibitIndexes();
    if (owned) await republishSourceRoom(source);
  };
  void enqueueLensWrite(apply);
}

// Delete every exhibit a room tabled — the delete-time half of "an exhibit is reachable
// iff its room is". An exhibit is a child of its room, but it is STORED beside the lenses
// (a record under a deleted room's dir could not outlive it even to be swept), so the
// cascade is a join on sourceRoom rather than a directory removal.
//
// Enqueued on the lens write chain, unlike the per-id delete verb: stampExhibitSources
// does loadLens -> saveLens, and a delete landing between the two lets saveLens recreate
// the record it just removed (saveLens mkdirs its dir). Batched like the stamp — one
// index refresh for the whole room, not one per exhibit.
export async function deleteRoomExhibits(slug: string): Promise<string[]> {
  return enqueueLensWrite(async () => {
    await lensReconcileInFlight?.catch(() => {});
    const store = createFileLensStore(lensesDir());
    const records = await listLenses(lensesDir()).catch(() => []);
    const removed: string[] = [];
    for (const record of records) {
      if (!isExhibit(record) || record.sourceRoom !== slug) continue;
      try {
        await store.deleteLens(record.id);
        lensRegistry?.remove(record.id);
        removed.push(record.id);
      } catch (e) {
        // Already gone is the outcome we wanted: a manual delete racing the cascade is
        // not a failure. Anything else is logged and skipped — one bad record must not
        // strand the rest, and the room itself is already gone.
        if (!/not found/i.test(errText(e))) {
          console.error(
            `[rib-chamber] exhibit '${record.id}' cascade delete failed: ${errText(e)}`,
          );
        }
      }
    }
    if (removed.length > 0) {
      await refreshExhibitIndexes();
      await refreshStandingPanels();
      // One gate evaluation for the batch (see deleteRecordOfKind for why a deletion
      // takes the free lapse path).
      void evaluateBriefGate().catch(() => {});
    }
    return removed;
  });
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
      // So must the producing room's own board — its Tabled section is a driver cache
      // that no delete would otherwise invalidate, leaving a card whose Open is dead.
      await republishSourceRoom(record?.sourceRoom);
    } else {
      await refreshWorkflow("chamber-lenses").catch(() => {});
      // The retired lens drops from the roster pulse's "Live views" count too —
      // refresh it so the count matches the just-updated index.
      await refreshWorkflow("chamber-roster").catch(() => {});
    }
    await refreshStandingPanels();
    // A promoted Briefing delta may name this record ("Since you last looked… ↗");
    // deleting it must lapse that delta, or the banner keeps a "N new" chip that opens
    // a dead key. The gate re-diffs and — a deletion is never *new* substance — takes
    // the free lapse path (no paid turn). Fire-and-forget: a delete never waits on it.
    void evaluateBriefGate().catch(() => {});
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
  republishRoom?: (slug: string) => Promise<void>;
}): { lensStore: ReturnType<typeof createFileLensStore> } {
  const { sm, registerRegion, declareView } = seams;
  republishRoom = seams.republishRoom;
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
  if (!sm || !registerRegion) {
    lensRegistry?.dispose();
    lensRegistry = undefined;
    lensSm = undefined;
    lensRegisterRegion = undefined;
  } else if (!lensRegistry || sm !== lensSm || registerRegion !== lensRegisterRegion) {
    const next = createLensRegistry(sm, registerRegion, lensStore);
    lensRegistry?.dispose();
    lensRegistry = next;
    lensSm = sm;
    lensRegisterRegion = registerRegion;
    // Re-register every persisted lens so it survives a restart: each becomes a
    // live region again (its snapshot key present for the index/open path).
    // Fail-soft per entry — one bad lens can't break boot.
    reconcileLensPanels(next);
  }
  return { lensStore };
}

// Tear down the lens runtime: drain any in-flight lens write-back AND both boot
// reconcile loops BEFORE tearing down the registries, so neither a late load-append-
// publish nor a still-looping reregister can publish to a disposed registry (or
// interleave with a re-boot's writes); then dispose both registries and drop their
// seam markers so a re-boot rebuilds cleanly.
export async function disposeLensRuntime(): Promise<void> {
  await lensWriteInFlight.catch(() => {});
  lensWriteInFlight = Promise.resolve();
  await lensReconcileInFlight?.catch(() => {});
  await htmlLensReconcileInFlight?.catch(() => {});
  lensReconcileInFlight = undefined;
  htmlLensReconcileInFlight = undefined;
  htmlLensRegistry?.dispose();
  htmlLensRegistry = undefined;
  htmlLensSm = undefined;
  htmlLensRegisterRegion = undefined;
  lensRegistry?.dispose();
  lensRegistry = undefined;
  lensSm = undefined;
  lensRegisterRegion = undefined;
}
