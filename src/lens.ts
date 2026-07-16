import type { CanvasBoardView, RibSurfaceRegion, SnapshotManager } from "@keelson/shared";
import { expectView } from "@keelson/shared";
import type { LensKind, LensProvenance, LensRefresh, LensStore } from "./lens-store.ts";
import { createCoalescingPublisher } from "./room-publisher.ts";

// A Mind authors a lens by publishing a board under a per-subject key
// (rib:chamber:lens:<id>). The registry registers that snapshot key ALWAYS, and adds a
// surface region for it through the harness `registerRegion` seam only when the lens is
// PINNED — an operator's choice, so the Chamber surface holds what you put there rather
// than every subject anyone ever authored. An unpinned lens is a key plus an index card,
// read through the drawer; that is the shape an EXHIBIT has always had (it shares the key
// namespace, gets no panel, and is reached from the room that tabled it). The rib
// withholds the lens tool entirely when that seam is absent (see index.ts), so the
// registry requires it rather than publish invisible, unrendered keys.
//
// NB: the region carries the refresh wiring (see regionFor), so an unpinned lens has no
// cadence — it re-composes through the index card's Refresh verb. Pinning is what makes
// a lens live, and that is deliberate: a lens region is args-bearing, which the server
// heartbeat skips, so every pinned living lens bills a turn per tick while the surface is
// open. Bounding that to the pinned set is half the point of the pin.

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

// The refresh invocation contract: the record's own inputs plus the workflow input
// naming the lens. One builder so the region's cadence wiring and the on-demand
// Refresh verb can't drift from the $inputs.lens interpolation in the re-author
// prompt — and so they agree byte for byte, since the harness de-dupes concurrent
// runs on their inputs and two spellings would race instead of collapsing.
// `lens` is assigned last: it is the one input the contract guarantees, so a
// stored input of that name must not be able to shadow it.
export function lensRefreshInputs(
  id: string,
  inputs?: Record<string, string>,
): Record<string, string> {
  return { ...inputs, lens: id };
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

// The pinned panel's own way off the surface, in the region head's ⋯ menu — the
// mirror of destructiveHeadAction's reasoning (a record should be puttable away from
// the panel itself without hunting the index), minus the confirm: unpinning destroys
// nothing, and the lens keeps its key, its card, and its Open.
export function unpinHeadAction(id: string, kind: "canvas" | "html" = "canvas") {
  return {
    type: "pin-lens",
    label: "Unpin from Chamber",
    glyph: "⊙",
    payload: { id, kind, pinned: false },
  };
}

// Whether a re-author left the backing alone — rewireRegion's early-out, so an
// unwatched field here means a changed backing keeps the region's stale wiring
// until a restart. `inputs` compares structurally because it reaches the region
// as workflowArgs; resolveLensRefresh drops an empty one so absent and {} are
// the same backing, as they are to lensRefreshInputs. Shared with the HTML twin's
// rewire so the two species can't drift on what counts as a changed backing.
export function sameRefresh(a?: LensRefresh, b?: LensRefresh): boolean {
  return (
    a?.workflow === b?.workflow && a?.cadenceMs === b?.cadenceMs && jsonEqual(a?.inputs, b?.inputs)
  );
}

// Structural JSON-value equality: key order is insignificant and an explicit
// undefined reads as absent, since one side may have been through disk and the other
// not. Sound for boards because canvasBoardViewSchema has no defaults or transforms,
// so a parsed board is structurally its input.
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => jsonEqual(item, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao).filter((k) => ao[k] !== undefined);
  const bKeys = Object.keys(bo).filter((k) => bo[k] !== undefined);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => jsonEqual(ao[k], bo[k]));
}

// Whether a re-author actually changed the board. Drives both halves of lens
// freshness: the live skip below, and the emit holding the record's updatedAt.
export function boardsEqual(a: CanvasBoardView, b: CanvasBoardView): boolean {
  return jsonEqual(a, b);
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
  // `pinned` is REQUIRED and positioned ahead of the optionals on purpose. It is
  // durable state the store owns, and every publish REBUILDS the record (the emit
  // hand-builds its provenance, and saveLens writes only the keys it is handed), so a
  // caller that could omit it would silently unpin the lens — and a living lens
  // re-authors on its own cadence, so a pinned one would unpin itself within the hour.
  // Required means a forgotten thread is a typecheck failure instead. Resolve it from
  // the prior record, as with `refresh`.
  //
  // `provenance` (scope / maintaining-Mind / reason / source-room) is forwarded to
  // the store for the index card; the live key + region are board-only, so
  // reregister omits it. `refresh` is the RESOLVED backing to persist and wire —
  // the caller owns preserve-vs-clear semantics against the prior record.
  // `updatedAt` overrides the store's stamp: a re-author that left the board
  // untouched holds the record's prior freshness rather than earning a new one.
  publish(
    id: string,
    board: CanvasBoardView,
    pinned: boolean,
    provenance?: LensProvenance,
    kind?: LensKind,
    refresh?: LensRefresh,
    updatedAt?: string,
  ): Promise<{ key: string }>;
  // Re-establish a persisted lens's live key + region on boot WITHOUT re-saving, so
  // the authored updatedAt is preserved (a restart must not reset every lens's
  // freshness).
  reregister(
    id: string,
    board: CanvasBoardView,
    pinned: boolean,
    kind?: LensKind,
    refresh?: LensRefresh,
  ): Promise<{ key: string }>;
  // Add or drop a pinned lens's panel, leaving its key, publisher, and record alone.
  // The ONLY mutator of live pin state — publish never changes it, it only carries
  // what the caller read off disk. False on an unknown id (mirrors remove) or on an
  // exhibit, so a caller can tell "panel swapped" from "nothing live to swap".
  setPin(id: string, pinned: boolean): boolean;
  // True when a live entry was released; false on an unknown id, so a delete
  // path can tell "panel dropped" from "nothing was live".
  remove(id: string): boolean;
  dispose(): void;
}

interface LensEntry {
  key: string;
  publisher: { publish(board: CanvasBoardView): Promise<void> };
  // What a compose actually put on the key — liveRegister's comparand for skipping an
  // identical republish. The publisher owns it because only its pump knows which board
  // a compose read; a board this side merely handed to publish() may have thrown, or
  // been coalesced into someone else's compose that landed a different one.
  published: () => CanvasBoardView | undefined;
  unregisterSnapshot: () => void;
  // Absent for an exhibit and for an unpinned lens: both hold a key but no panel
  // (see regionFor).
  unregisterRegion?: () => void;
  // The shelf wiring the live region was built from, so a re-publish that
  // changes the refresh backing can swap the region in place (and a failed
  // swap can restore this exact wiring).
  kind: LensKind;
  refresh?: LensRefresh;
  // Always a strict boolean, never undefined: rewireRegion compares it against a
  // publish's value, and an undefined here would never equal a passed `false`, so
  // every re-author of an unpinned lens would churn the region it doesn't have.
  pinned: boolean;
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

  // A PINNED lens's panel. Only a pinned lens gets one — an unpinned lens and an
  // exhibit both hold a key with no panel, so regionFor is never called for them. A
  // refresh-backed lens also carries the region's re-compose wiring: the named workflow
  // runs with input `lens` = this id, on the emit's cadence (clamped to the host floor).
  //
  // The three layout fields lean on shipping harness behavior rather than a region
  // field that does not exist (surfaceRegionSchema is strict — a speculative one throws
  // and register()'s catch would take the whole emit down):
  //   - a per-id `group` puts one region in each group, and the host chunks per group,
  //     so each pinned lens forms a one-column row — which the surface's flex rule
  //     renders full width.
  //   - one shared `groupTitle` across those groups makes the host's zone merge fold
  //     the consecutive rows under a single "Pinned" header (and stops colliding with
  //     the Lenses index panel's own title).
  //   - dynamic regions append after the static rows, so the zone lands under Rooms
  //     and Lenses on its own.
  function regionFor(id: string, refresh?: LensRefresh): RibSurfaceRegion {
    return {
      key: lensKey(id),
      title: id,
      collapsible: true,
      // Folded on arrival: a pinned lens earns a heartbeat strip — name, live dot,
      // freshness — for one row of height, and expands when you want to read it.
      collapsed: true,
      glyph: { char: "✦", tone: "accent" as const },
      group: `lens:${id}`,
      groupTitle: "Pinned",
      headActions: [
        unpinHeadAction(id),
        destructiveHeadAction("retire-lens", "Retire", "lens", id),
      ],
      ...(refresh
        ? {
            workflow: refresh.workflow,
            workflowArgs: lensRefreshInputs(id, refresh.inputs),
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
  function register(id: string, kind: LensKind, pinned: boolean, refresh?: LensRefresh): LensEntry {
    const key = lensKey(id);
    const { publisher, latest, published } = createCoalescingPublisher(
      () => sm.recompose(key),
      emptyLensBoard(),
    );
    const unregisterSnapshot = sm.register(key, latest, { validate: expectView(key, "board") });
    // An exhibit and an unpinned lens register their KEY only. The key is what lens-open
    // focuses, so it is what the index cards and the room board's Tabled cards read —
    // dropping it with the panel would leave every one of those cards opening a dead key.
    // Order matters: the exhibit term is first because it is a species fact (an exhibit
    // has no panel at any pin state), while pin is a preference layered on a lens.
    let unregisterRegion: (() => void) | undefined;
    if (kind !== "exhibit" && pinned) {
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
      published,
      unregisterSnapshot,
      ...(unregisterRegion ? { unregisterRegion } : {}),
      kind,
      refresh,
      pinned,
    };
    entries.set(id, entry);
    return entry;
  }

  // Swap an existing entry's region when a re-publish changes its shelf wiring
  // (a refresh backing added/changed/cleared, a kind crossing between lens and
  // exhibit, or a pin toggling). The snapshot key and publisher stay put — only the
  // layout re-registers, so the panel's frames are uninterrupted. A failed swap
  // restores the prior wiring; if even that fails, release the whole entry so no
  // orphaned key lingers behind a missing panel. An exhibit and an unpinned lens have
  // no region: crossing INTO either drops the panel, and crossing out builds the first.
  //
  // `entry.pinned === pinned` is compared HERE rather than inside sameRefresh: that
  // helper is shared with the HTML twin and answers "did the refresh backing change",
  // which a pin is not — so the species-specific terms stay at the call site, as
  // `entry.kind === kind` already does.
  function rewireRegion(
    id: string,
    entry: LensEntry,
    kind: LensKind,
    pinned: boolean,
    refresh?: LensRefresh,
  ): void {
    if (entry.kind === kind && entry.pinned === pinned && sameRefresh(entry.refresh, refresh)) {
      return;
    }
    entry.unregisterRegion?.();
    entry.unregisterRegion = undefined;
    if (kind === "exhibit" || !pinned) {
      entry.kind = kind;
      entry.refresh = refresh;
      entry.pinned = pinned;
      return;
    }
    try {
      entry.unregisterRegion = registerRegion(CHAMBER_SURFACE_ID, regionFor(id, refresh));
      entry.kind = kind;
      entry.refresh = refresh;
      entry.pinned = pinned;
    } catch (e) {
      try {
        if (entry.kind !== "exhibit" && entry.pinned) {
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
  // board unless it is already the live one. Shared by publish (which then persists)
  // and reregister (boot, which must NOT persist — see reregister).
  async function liveRegister(
    id: string,
    board: CanvasBoardView,
    kind: LensKind,
    pinned: boolean,
    refresh?: LensRefresh,
  ): Promise<{ key: string }> {
    // Validate the board BEFORE registering anything, so a board we can't render
    // fails closed loudly and never leaves a dangling key or empty panel behind.
    expectView(lensKey(id), "board")(board);
    let entry = entries.get(id);
    if (!entry) {
      entry = register(id, kind, pinned, refresh);
      // Seed the cache so a client subscribing the instant the panel appears gets
      // the seed board, not a 204 (the GET path doesn't lazy-compose). The entry is
      // already mapped, so this await can't reopen the duplicate-register race.
      await sm.recompose(entry.key);
    } else {
      rewireRegion(id, entry, kind, pinned, refresh);
    }
    // Re-broadcasting an identical board would restamp the frame's composedAt — the
    // "updated" a panel head reads — with freshness the content never earned. The
    // comparand is what reached the SURFACE, never the stored record: skipping on the
    // record would strand a panel whose save failed, with no later refresh able to
    // converge it.
    const onSurface = entry.published();
    if (!onSurface || !boardsEqual(onSurface, board)) await entry.publisher.publish(board);
    return { key: entry.key };
  }

  return {
    async publish(id, board, pinned, provenance, kind = "lens", refresh, updatedAt) {
      const result = await liveRegister(id, board, kind, pinned, refresh);
      // Persist only AFTER the live validate + publish succeed, so a board we
      // can't render never reaches disk (fail-closed); the store stamps updatedAt
      // unless the caller held the prior one, and carries the provenance through
      // (absent fields stay absent).
      await store.saveLens({
        id,
        board,
        kind,
        ...(pinned ? { pinned } : {}),
        ...(refresh ? { refresh } : {}),
        ...(updatedAt ? { updatedAt } : {}),
        ...provenance,
      });
      return result;
    },
    // Re-establish a persisted lens's live key + region on boot WITHOUT re-saving:
    // the record is already on disk with its authored updatedAt, and re-stamping it
    // would reset every lens's freshness on every restart. So boot goes through the
    // live half only.
    reregister(id, board, pinned, kind = "lens", refresh) {
      return liveRegister(id, board, kind, pinned, refresh);
    },
    // Live-only: the record is the caller's to write (it holds the write chain and the
    // updatedAt it must preserve). Refuses an exhibit outright — the region predicate is
    // the only thing standing between an exhibit and a panel, so a setPin that rewired
    // blindly would hand a room's deliverable permanent surface.
    setPin(id, pinned) {
      const entry = entries.get(id);
      if (!entry || entry.kind === "exhibit") return false;
      if (entry.pinned === pinned) return true;
      rewireRegion(id, entry, entry.kind, pinned, entry.refresh);
      return true;
    },
    remove(id) {
      return release(id);
    },
    dispose() {
      for (const id of [...entries.keys()]) release(id);
    },
  };
}
