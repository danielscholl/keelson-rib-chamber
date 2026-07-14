import type { CanvasBoardView, RibSurfaceRegion, SnapshotManager } from "@keelson/shared";
import { expectView } from "@keelson/shared";
import type { LensKind, LensProvenance, LensRefresh, LensStore } from "./lens-store.ts";
import { createCoalescingPublisher } from "./room-publisher.ts";

// A Mind authors a lens by publishing a board under a per-subject key
// (rib:chamber:lens:<id>). The registry registers that snapshot key AND — for a LENS —
// adds a surface region for it through the harness `registerRegion` seam, so each new
// subject appears as its own panel: unbounded, no fixed pool, no eviction. An EXHIBIT
// shares the key namespace but gets no panel; it is a room's deliverable, reached from
// the room that tabled it. The rib withholds the lens tool entirely when that seam is
// absent (see index.ts), so the registry requires it rather than publish invisible,
// unrendered keys.

// The id of the Chamber surface lens panels attach to. Shared with the surface
// declaration in index.ts so the registerRegion target can't drift from it.
export const CHAMBER_SURFACE_ID = "chamber";

// The lens write-seam tool name. One source of truth: the tool registration and the
// chamber-lens workflow's allowed_tools reference this so a Mind can author a lens
// from the workflow or from chat.
export const LENS_TOOL_NAME = "chamber_emit_lens";

// The exhibit write-seam tool name — the room driver's turn tool: a discussion
// tables its deliverable through this, and the driver witnesses the call to stamp
// sourceRoom (see room.ts runOneTurn).
export const EXHIBIT_TOOL_NAME = "chamber_table_exhibit";

export function lensKey(id: string): string {
  return `rib:chamber:lens:${id}`;
}

// How often a refresh-backed lens re-composes when its emit named a workflow but
// no cadence. Each refresh is a paid agent turn, so the default leans quiet; an
// emit that wants livelier re-composition says so explicitly.
export const DEFAULT_LENS_REFRESH_CADENCE_MS = 3_600_000;

// The host floors region cadence at 30s; clamp here so a hand-edited record
// can't make the region registration throw and take the whole panel with it.
// Exported so the emit schema's floor and this clamp share one value.
export const MIN_REFRESH_CADENCE_MS = 30_000;

// The refresh invocation contract: the workflow input naming the lens. One
// builder so the region's cadence wiring and the on-demand Refresh verb can't
// drift from the $inputs.lens interpolation in the re-author prompt.
export function lensRefreshInputs(id: string): Record<string, string> {
  return { lens: id };
}

// The seed a panel renders before its board publishes: a valid, titled board so a
// client subscribing the instant the region appears reads an empty panel rather
// than a loading skeleton. The authored board (its own title) replaces it on publish.
export function emptyLensBoard(): CanvasBoardView {
  return {
    view: "board",
    title: "Lens",
    sections: [
      {
        kind: "rows",
        items: [
          {
            text: "No lens yet — author one with /workflow run chamber-lens <subject>",
            glyph: "neutral",
          },
        ],
      },
    ],
  };
}

// Canonicalize a lens id into a stable routing key: lowercase, runs of non-alphanumeric
// collapse to a single hyphen, ends trimmed. Distinct from the Mind slugifier — no
// length cap below the id's own 64 (so two long subjects can't collide on a shared
// prefix) and no synthetic fallback (an id with no usable characters returns "", which
// the caller rejects).
export function canonicalLensId(raw: string): string {
  return raw
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

type RegisterRegion = (surfaceId: string, region: RibSurfaceRegion) => () => void;

// The panel's own destructive verb, in the region head's ⋯ menu — the same
// confirm-gated action the index card carries, so a record can be put away from
// the panel itself without hunting the index. One builder for all three verbs
// (retire-lens, delete-exhibit, and the HTML twin's retire-lens-html) so the
// confirm contract can't drift between shelves.
export function destructiveHeadAction(type: string, verb: string, noun: string, id: string) {
  return {
    type,
    label: `${verb} ${noun}…`,
    glyph: "✕",
    tone: "warn" as const,
    destructive: true,
    payload: { id },
    confirm: {
      title: `${verb} ${noun}`,
      body: `${verb} ${id}? This permanently removes the ${noun}.`,
      confirmLabel: verb,
      cancelLabel: "Cancel",
    },
  };
}

function sameRefresh(a?: LensRefresh, b?: LensRefresh): boolean {
  return a?.workflow === b?.workflow && a?.cadenceMs === b?.cadenceMs;
}

// Publishes a Mind-authored board to its per-subject lens key, registering the key
// and a matching surface region the first time an id is seen; re-authoring the same
// id updates the existing panel in place. Holds the snapshot + region handles per id
// so dispose() releases both (letting a re-bootstrap re-register cleanly).
//
// Kind decides whether there is a panel at all (a lens has one, an exhibit does not):
// the two share the store, the id space, and the lensKey namespace, so the open path
// and the briefing's jump chips resolve either kind through one key shape.
export interface LensRegistry {
  // `provenance` (scope / maintaining-Mind / reason / source-room) is forwarded to
  // the store for the index card; the live key + region are board-only, so
  // reregister omits it. `refresh` is the RESOLVED backing to persist and wire —
  // the caller owns preserve-vs-clear semantics against the prior record.
  publish(
    id: string,
    board: CanvasBoardView,
    provenance?: LensProvenance,
    kind?: LensKind,
    refresh?: LensRefresh,
  ): Promise<{ key: string }>;
  // Re-establish a persisted lens's live key + region on boot WITHOUT re-saving, so
  // the authored updatedAt is preserved (a restart must not reset every lens's
  // freshness).
  reregister(
    id: string,
    board: CanvasBoardView,
    kind?: LensKind,
    refresh?: LensRefresh,
  ): Promise<{ key: string }>;
  // True when a live entry was released; false on an unknown id, so a delete
  // path can tell "panel dropped" from "nothing was live".
  remove(id: string): boolean;
  dispose(): void;
}

interface LensEntry {
  key: string;
  publisher: { publish(board: CanvasBoardView): Promise<void> };
  unregisterSnapshot: () => void;
  // Absent for an exhibit: it holds a key but no panel (see regionFor).
  unregisterRegion?: () => void;
  // The shelf wiring the live region was built from, so a re-publish that
  // changes the refresh backing can swap the region in place (and a failed
  // swap can restore this exact wiring).
  kind: LensKind;
  refresh?: LensRefresh;
}

export function createLensRegistry(
  sm: SnapshotManager,
  registerRegion: RegisterRegion,
  store: LensStore,
): LensRegistry {
  const entries = new Map<string, LensEntry>();

  // Drop a single subject's snapshot key and its panel, if it had one, a sync in-memory
  // mirror of the per-entry handles dispose() invokes in bulk. No-op on an unknown id
  // (matches RoomKeyRegistry.release). Durable deletion (store.deleteLens) is
  // the caller's, so this stays a pure in-memory release.
  function release(id: string): boolean {
    const entry = entries.get(id);
    if (!entry) return false;
    entry.unregisterRegion?.();
    entry.unregisterSnapshot();
    entries.delete(id);
    return true;
  }

  // A LENS's panel. Only a lens gets one: it is a standing view, continuously true, so
  // it earns permanent surface. An exhibit is a room's deliverable — reached from the
  // room that tabled it — so it holds a key with no panel, and regionFor is never
  // called for one. A refresh-backed lens also carries the region's re-compose wiring:
  // the named workflow runs with input `lens` = this id, on the emit's cadence (clamped
  // to the host floor).
  function regionFor(id: string, refresh?: LensRefresh): RibSurfaceRegion {
    return {
      key: lensKey(id),
      title: id,
      collapsible: true,
      glyph: { char: "✦", tone: "accent" as const },
      group: "lens",
      groupTitle: "Lenses",
      headActions: [destructiveHeadAction("retire-lens", "Retire", "lens", id)],
      ...(refresh
        ? {
            workflow: refresh.workflow,
            workflowArgs: lensRefreshInputs(id),
            cadenceMs: Math.max(
              MIN_REFRESH_CADENCE_MS,
              Math.round(refresh.cadenceMs ?? DEFAULT_LENS_REFRESH_CADENCE_MS),
            ),
          }
        : {}),
    };
  }

  // Register a new subject's snapshot key and surface region. Fully synchronous
  // (no await between the entries.get miss in publish and this entries.set), so
  // two concurrent publishes of the same new id — the tool is both a workflow seam
  // and a room turn-tool — can't both reach sm.register and trip its duplicate-key
  // guard; the second finds the entry and just republishes.
  function register(id: string, kind: LensKind, refresh?: LensRefresh): LensEntry {
    const key = lensKey(id);
    const { publisher, latest } = createCoalescingPublisher(
      () => sm.recompose(key),
      emptyLensBoard(),
    );
    const unregisterSnapshot = sm.register(key, latest, { validate: expectView(key, "board") });
    // An exhibit registers its KEY only. The key is what lens-open focuses, so it is what
    // the room board's Tabled cards read — dropping it with the panel would leave every
    // one of those cards opening a dead key.
    let unregisterRegion: (() => void) | undefined;
    if (kind !== "exhibit") {
      try {
        unregisterRegion = registerRegion(CHAMBER_SURFACE_ID, regionFor(id, refresh));
      } catch (e) {
        // A failed region add (e.g. the harness per-surface ceiling) must not leak
        // the snapshot registration we already made.
        unregisterSnapshot();
        throw e;
      }
    }
    const entry: LensEntry = {
      key,
      publisher,
      unregisterSnapshot,
      ...(unregisterRegion ? { unregisterRegion } : {}),
      kind,
      refresh,
    };
    entries.set(id, entry);
    return entry;
  }

  // Swap an existing entry's region when a re-publish changes its shelf wiring
  // (a refresh backing added/changed/cleared, or a kind crossing between lens and
  // exhibit). The snapshot key and publisher stay put — only the layout re-registers,
  // so the panel's frames are uninterrupted. A failed swap restores the prior wiring;
  // if even that fails, release the whole entry so no orphaned key lingers behind a
  // missing panel. An exhibit has no region: crossing INTO one drops the panel, and
  // crossing out of one builds the first.
  function rewireRegion(id: string, entry: LensEntry, kind: LensKind, refresh?: LensRefresh): void {
    if (entry.kind === kind && sameRefresh(entry.refresh, refresh)) return;
    entry.unregisterRegion?.();
    entry.unregisterRegion = undefined;
    if (kind === "exhibit") {
      entry.kind = kind;
      entry.refresh = refresh;
      return;
    }
    try {
      entry.unregisterRegion = registerRegion(CHAMBER_SURFACE_ID, regionFor(id, refresh));
      entry.kind = kind;
      entry.refresh = refresh;
    } catch (e) {
      try {
        if (entry.kind !== "exhibit") {
          entry.unregisterRegion = registerRegion(CHAMBER_SURFACE_ID, regionFor(id, entry.refresh));
        }
      } catch {
        entry.unregisterSnapshot();
        entries.delete(id);
      }
      throw e;
    }
  }

  // The live half of publish: validate the board, register the key + region if new
  // (re-wiring the region if the shelf config changed), seed the cache, and push the
  // board. Shared by publish (which then persists) and reregister (boot, which must
  // NOT persist — see reregister).
  async function liveRegister(
    id: string,
    board: CanvasBoardView,
    kind: LensKind,
    refresh?: LensRefresh,
  ): Promise<{ key: string }> {
    // Validate the board BEFORE registering anything, so a board we can't render
    // fails closed loudly and never leaves a dangling key or empty panel behind.
    expectView(lensKey(id), "board")(board);
    let entry = entries.get(id);
    if (!entry) {
      entry = register(id, kind, refresh);
      // Seed the cache so a client subscribing the instant the panel appears gets
      // the seed board, not a 204 (the GET path doesn't lazy-compose). The entry is
      // already mapped, so this await can't reopen the duplicate-register race.
      await sm.recompose(entry.key);
    } else {
      rewireRegion(id, entry, kind, refresh);
    }
    await entry.publisher.publish(board);
    return { key: entry.key };
  }

  return {
    async publish(id, board, provenance, kind = "lens", refresh) {
      const result = await liveRegister(id, board, kind, refresh);
      // Persist only AFTER the live validate + publish succeed, so a board we
      // can't render never reaches disk (fail-closed); the store stamps updatedAt
      // and carries the provenance through (absent fields stay absent).
      await store.saveLens({ id, board, kind, ...(refresh ? { refresh } : {}), ...provenance });
      return result;
    },
    // Re-establish a persisted lens's live key + region on boot WITHOUT re-saving:
    // the record is already on disk with its authored updatedAt, and re-stamping it
    // would reset every lens's freshness on every restart. So boot goes through the
    // live half only.
    reregister(id, board, kind = "lens", refresh) {
      return liveRegister(id, board, kind, refresh);
    },
    remove(id) {
      return release(id);
    },
    dispose() {
      for (const id of [...entries.keys()]) release(id);
    },
  };
}
