import type {
  DesignThemeName,
  RibSurfaceRegion,
  SnapshotManager,
  SnapshotValidator,
} from "@keelson/shared";
import {
  CHAMBER_SURFACE_ID,
  DEFAULT_LENS_REFRESH_CADENCE_MS,
  destructiveHeadAction,
  lensRefreshInputs,
  MIN_REFRESH_CADENCE_MS,
  sameRefresh,
  unpinHeadAction,
} from "./lens.ts";
import type { HtmlLensStore } from "./lens-html-store.ts";
import type { LensRefresh } from "./lens-store.ts";
import { createCoalescingPublisher } from "./room-publisher.ts";

// The legacy/default single-canvas key: an emit with no `id` still lands here,
// in-memory only, exactly as the prototype behaved.
export const HTML_LENS_KEY = "rib:chamber:lens-html";
export const HTML_LENS_TOOL_NAME = "chamber_emit_lens_html";

// Per-subject HTML lens key (mirrors lensKey). `id` must already be canonical
// (canonicalLensId) — the tool canonicalizes before it reaches the registry.
export function htmlLensKey(id: string): string {
  return `${HTML_LENS_KEY}:${id}`;
}

export function emptyHtmlLens(): string {
  return "<p>No HTML lens yet.</p>";
}

export function htmlStringValidator(key: string): SnapshotValidator<string> {
  return (data: unknown): string => {
    if (typeof data !== "string") {
      throw new Error(`${key}: expected an HTML string`);
    }
    if (data.length === 0) {
      throw new Error(`${key}: HTML string must not be empty`);
    }
    return data;
  };
}

// Structural rejects that would otherwise fail silently at render (mirrors the
// keelson server's canvas_publish gate): the frame CSP blocks external
// scripts/stylesheets, so publishing them is always a bug.
export function htmlLensStructuralError(html: string): string | undefined {
  if (/<script\b[^>]*\bsrc\s*=/i.test(html)) {
    return "external <script src> is blocked by the frame CSP — inline all script.";
  }
  if (/<link\b[^>]*\brel\s*=\s*["']?stylesheet/i.test(html)) {
    return "external stylesheets are blocked by the frame CSP — inline all CSS in a <style> block.";
  }
  return undefined;
}

// Pull one data-palette-* attribute's hex list off the <body> tag (attribute
// order free; comma-separated hex in slot order — the canvas_publish contract).
function declaredPalette(html: string, attr: string): string[] | undefined {
  const body = /<body\b[^>]*>/i.exec(html)?.[0];
  if (!body) return undefined;
  const value = new RegExp(`${attr}\\s*=\\s*"([^"]*)"`, "i").exec(body)?.[1];
  if (value === undefined) return undefined;
  const list = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return list.length > 0 ? list : undefined;
}

// The palettes a page declares, per theme: data-palette-dark / data-palette-light,
// with a bare data-palette covering both modes.
export function declaredHtmlPalettes(html: string): Partial<Record<DesignThemeName, string[]>> {
  const both = declaredPalette(html, "data-palette");
  const dark = declaredPalette(html, "data-palette-dark") ?? both;
  const light = declaredPalette(html, "data-palette-light") ?? both;
  return {
    ...(dark ? { dark } : {}),
    ...(light ? { light } : {}),
  };
}

type RegisterRegion = (surfaceId: string, region: RibSurfaceRegion) => () => void;

// The rib.views declaration seam: the drawer resolves a key's canvas kind by
// exact match against the rib's views, so each per-subject key must also appear
// there as canvasKind "html" or the host would render its string frame as a
// board. Returns the undo (mirrors registerRegion).
export type DeclareHtmlView = (id: string, title?: string) => () => void;

interface HtmlLensEntry {
  key: string;
  publisher: { publish(html: string): Promise<void> };
  // What a compose actually put on the key — the comparand for skipping an identical
  // republish (see LensEntry.published for why the publisher owns it).
  published: () => string | undefined;
  unregisterSnapshot: () => void;
  // Absent for an unpinned lens — it holds a key and a views entry, but no panel.
  unregisterRegion?: () => void;
  undeclareView: () => void;
  // The wiring the live region and views entry were built from, so a re-emit that
  // changes either can swap them in place (mirrors LensEntry.refresh).
  title?: string;
  refresh?: LensRefresh;
  // Always a strict boolean (see LensEntry.pinned). The legacy id-less canvas is
  // always true: it has no record to hold a pin and no card to pin it back from.
  pinned: boolean;
}

export interface HtmlLensRegistry {
  // Publish per-subject when `id` is present (persisted, own key + region);
  // legacy single-canvas when absent (the fixed key, in-memory only). `refresh`
  // is the RESOLVED backing to persist and wire — the caller owns preserve-vs-clear
  // against the prior record — and `updatedAt` overrides the store's stamp so an
  // unchanged re-emit holds the freshness it already had (the LensRegistry rules).
  // `pinned` is resolved from the prior record by the caller, exactly as `refresh` is
  // and for the same reason: a publish rebuilds the record, so an omitted pin would be
  // dropped on the next re-emit (see LensRegistry.publish). The legacy id-less canvas
  // ignores it — it is always panelled.
  publish(
    html: string,
    opts?: {
      id?: string;
      title?: string;
      refresh?: LensRefresh;
      updatedAt?: string;
      pinned?: boolean;
    },
  ): Promise<{ key: string }>;
  // Re-establish a persisted lens's live key + region on boot WITHOUT re-saving,
  // so the authored updatedAt is preserved (mirrors LensRegistry.reregister).
  reregister(
    id: string,
    html: string,
    pinned: boolean,
    title?: string,
    refresh?: LensRefresh,
  ): Promise<{ key: string }>;
  // Add or drop a pinned lens's panel, leaving its key, its views entry, and its
  // record alone (mirrors LensRegistry.setPin). False on an unknown id.
  setPin(id: string, pinned: boolean): boolean;
  // Drop one subject's live key + region + views entry (mirrors
  // LensRegistry.remove; true when something live was released). Durable
  // deletion is the caller's.
  remove(id: string): boolean;
  dispose(): void;
}

export function createHtmlLensRegistry(
  sm: SnapshotManager,
  registerRegion: RegisterRegion,
  store: HtmlLensStore,
  declareView: DeclareHtmlView = () => () => undefined,
): HtmlLensRegistry {
  // Keyed by canonical id; the fixed key itself is the sentinel for the legacy
  // default entry (a canonical id can never contain ":", so no collision).
  const entries = new Map<string, HtmlLensEntry>();

  function release(mapKey: string): boolean {
    const entry = entries.get(mapKey);
    if (!entry) return false;
    // Optional-called: an unpinned lens has no region to release, and a retire of one
    // must not throw on its way to removing the record.
    entry.unregisterRegion?.();
    entry.unregisterSnapshot();
    entry.undeclareView();
    entries.delete(mapKey);
    return true;
  }

  // A subject's panel: the shelf, its retire verb, and — for a living lens — the
  // region's re-compose wiring, mirroring the canvas twin's regionFor. The named
  // workflow runs with input `lens` = this id plus the record's own inputs, on the
  // emit's cadence (clamped to the host floor, so a hand-edited record can't make
  // the registration throw and take the panel with it). The legacy fixed key takes
  // none of it: nothing durable to retire, and no id to name in the run.
  function regionFor(
    id: string | undefined,
    title: string | undefined,
    refresh: LensRefresh | undefined,
  ): RibSurfaceRegion {
    return {
      key: id === undefined ? HTML_LENS_KEY : htmlLensKey(id),
      title: id === undefined ? "HTML Lens" : (title ?? id),
      glyph: { char: "❖", tone: "accent" },
      // Per-id group + one shared zone title, as the canvas twin does: a pinned page is
      // a full-width row in the Pinned zone rather than a third of one. The legacy fixed
      // key keeps the old shared group — it is always panelled and never pinned.
      group: id === undefined ? "lens" : `lens:${id}`,
      groupTitle: id === undefined ? "Lenses" : "Pinned",
      // Foldable like every other lens panel — a tall designed page shouldn't
      // monopolize the surface with no way to put it away.
      collapsible: true,
      // Folded on arrival, like a pinned board lens: a designed page is the taller of
      // the two species, so it is the one that most needs to earn its height.
      ...(id === undefined ? {} : { collapsed: true }),
      // A pinned page's verbs. Its sandboxed iframe rightly can't reach destructive
      // actions, so the head is where they live; the index card is what carries them
      // once unpinned, and is the only way to pin it back. The legacy fixed key is
      // in-memory only — nothing durable to retire or pin — so it carries no verbs.
      ...(id === undefined
        ? {}
        : {
            headActions: [
              unpinHeadAction(id, "html"),
              destructiveHeadAction("retire-lens-html", "Retire", "lens", id),
            ],
          }),
      ...(id !== undefined && refresh
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

  // Register a subject's snapshot key, surface region, and (per-subject only)
  // views entry. Fully synchronous between the entries.get miss and entries.set,
  // so two concurrent publishes of the same new id can't double-register.
  function register(
    id: string | undefined,
    title: string | undefined,
    refresh: LensRefresh | undefined,
    pinned: boolean,
  ): HtmlLensEntry {
    const key = id === undefined ? HTML_LENS_KEY : htmlLensKey(id);
    const { publisher, latest, published } = createCoalescingPublisher(
      () => sm.recompose(key),
      emptyHtmlLens(),
    );
    const unregisterSnapshot = sm.register(key, latest, {
      validate: htmlStringValidator(key),
    });
    let unregisterRegion: (() => void) | undefined;
    if (pinned) {
      try {
        unregisterRegion = registerRegion(CHAMBER_SURFACE_ID, regionFor(id, title, refresh));
      } catch (e) {
        // A failed region add (e.g. the harness per-surface ceiling) must not leak
        // the snapshot registration we already made.
        unregisterSnapshot();
        throw e;
      }
    }
    // The views entry is declared whether or not there is a panel, and outlives an
    // unpin: the host resolves a key's canvas kind by EXACT match against the rib's
    // views, so an unpinned lens without one would have its markup rendered through
    // the board pipeline the moment Open focused it.
    const undeclareView = id === undefined ? () => undefined : declareView(id, title);
    const entry: HtmlLensEntry = {
      key,
      publisher,
      published,
      unregisterSnapshot,
      ...(unregisterRegion ? { unregisterRegion } : {}),
      undeclareView,
      title,
      refresh,
      pinned,
    };
    entries.set(id ?? HTML_LENS_KEY, entry);
    return entry;
  }

  // Swap an existing subject's region (and views entry) when a re-emit changed the
  // wiring either is built from — the canvas twin's rewireRegion. The snapshot key
  // and publisher stay put, so the panel's frames are uninterrupted. Title rides
  // along with refresh because BOTH are baked into the region and the view entry at
  // registration: without this, a re-emit's new title reaches the record and never
  // the panel head. A failed swap restores the prior wiring; if even that fails,
  // release the entry so no orphaned key lingers behind a missing panel.
  function rewire(
    id: string,
    entry: HtmlLensEntry,
    title: string | undefined,
    refresh: LensRefresh | undefined,
    pinned: boolean,
  ): void {
    if (entry.title === title && entry.pinned === pinned && sameRefresh(entry.refresh, refresh)) {
      return;
    }
    entry.unregisterRegion?.();
    entry.unregisterRegion = undefined;
    // Unpinning drops the region and nothing else. It deliberately does NOT go through
    // release(): that takes the key and the views entry with it, which would leave the
    // record unreachable — no panel, and no view entry to render it as HTML when Open
    // focuses its key. The title swap still runs, so an unpinned lens keeps a current
    // views entry for the day it is pinned back.
    if (!pinned) {
      entry.undeclareView();
      entry.undeclareView = declareView(id, title);
      entry.title = title;
      entry.refresh = refresh;
      entry.pinned = pinned;
      return;
    }
    let nextRegion: () => void;
    try {
      nextRegion = registerRegion(CHAMBER_SURFACE_ID, regionFor(id, title, refresh));
    } catch (e) {
      try {
        if (entry.pinned) {
          entry.unregisterRegion = registerRegion(
            CHAMBER_SURFACE_ID,
            regionFor(id, entry.title, entry.refresh),
          );
        }
      } catch {
        entry.unregisterSnapshot();
        entry.undeclareView();
        entries.delete(id);
      }
      throw e;
    }
    // Past the only step that can throw, so the views entry — which carries the title
    // too — swaps with no window where a failure could strand two live regions.
    entry.unregisterRegion = nextRegion;
    entry.pinned = pinned;
    entry.undeclareView();
    entry.undeclareView = declareView(id, title);
    entry.title = title;
    entry.refresh = refresh;
  }

  async function livePublish(
    html: string,
    id: string | undefined,
    title: string | undefined,
    refresh: LensRefresh | undefined,
    pinned: boolean,
  ): Promise<{ key: string }> {
    const mapKey = id ?? HTML_LENS_KEY;
    htmlStringValidator(id === undefined ? HTML_LENS_KEY : htmlLensKey(id))(html);
    // The legacy id-less canvas is always panelled: it has no record to hold a pin and
    // no index card to pin it back from, so defaulting it to unpinned would make it
    // permanently invisible with nothing able to recover it.
    const panelled = id === undefined || pinned;
    let entry = entries.get(mapKey);
    if (!entry) {
      entry = register(id, title, refresh, panelled);
      // Seed the cache so a client subscribing the instant the panel appears gets
      // the seed markup, not a 204 (the GET path doesn't lazy-compose).
      await sm.recompose(entry.key);
    } else if (id !== undefined) {
      rewire(id, entry, title, refresh, panelled);
    }
    // Re-broadcasting identical markup would restamp the frame's composedAt — the
    // "updated" a panel head reads — with freshness the page never earned, which is
    // the whole failure mode a living lens re-running on cadence would otherwise hit
    // every tick. The comparand is what reached the SURFACE, never the stored record
    // (see the canvas twin's liveRegister).
    const onSurface = entry.published();
    if (onSurface !== html) await entry.publisher.publish(html);
    return { key: entry.key };
  }

  return {
    async publish(html, opts) {
      const pinned = opts?.pinned === true;
      const result = await livePublish(html, opts?.id, opts?.title, opts?.refresh, pinned);
      // Persist only per-subject lenses, and only AFTER the live publish succeeds
      // (fail-closed, mirrors LensRegistry.publish); the legacy fixed key stays
      // in-memory only, exactly as before.
      if (opts?.id !== undefined) {
        await store.save({
          id: opts.id,
          html,
          ...(opts.title ? { title: opts.title } : {}),
          ...(opts.refresh ? { refresh: opts.refresh } : {}),
          ...(opts.updatedAt ? { updatedAt: opts.updatedAt } : {}),
          ...(pinned ? { pinned } : {}),
        });
      }
      return result;
    },
    // Boot goes through the live half only, so the on-disk updatedAt is never
    // re-stamped by a restart.
    reregister(id, html, pinned, title, refresh) {
      return livePublish(html, id, title, refresh, pinned);
    },
    setPin(id, pinned) {
      const entry = entries.get(id);
      if (!entry) return false;
      if (entry.pinned === pinned) return true;
      rewire(id, entry, entry.title, entry.refresh, pinned);
      return true;
    },
    remove(id) {
      return release(id);
    },
    dispose() {
      for (const mapKey of [...entries.keys()]) release(mapKey);
    },
  };
}
