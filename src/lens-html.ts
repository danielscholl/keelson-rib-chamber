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
  unregisterRegion: () => void;
  undeclareView: () => void;
  // The wiring the live region and views entry were built from, so a re-emit that
  // changes either can swap them in place (mirrors LensEntry.refresh).
  title?: string;
  refresh?: LensRefresh;
}

export interface HtmlLensRegistry {
  // Publish per-subject when `id` is present (persisted, own key + region);
  // legacy single-canvas when absent (the fixed key, in-memory only). `refresh`
  // is the RESOLVED backing to persist and wire — the caller owns preserve-vs-clear
  // against the prior record — and `updatedAt` overrides the store's stamp so an
  // unchanged re-emit holds the freshness it already had (the LensRegistry rules).
  publish(
    html: string,
    opts?: { id?: string; title?: string; refresh?: LensRefresh; updatedAt?: string },
  ): Promise<{ key: string }>;
  // Re-establish a persisted lens's live key + region on boot WITHOUT re-saving,
  // so the authored updatedAt is preserved (mirrors LensRegistry.reregister).
  reregister(
    id: string,
    html: string,
    title?: string,
    refresh?: LensRefresh,
  ): Promise<{ key: string }>;
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
    entry.unregisterRegion();
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
      group: "lens",
      groupTitle: "Lenses",
      // Foldable like every other lens panel — a tall designed page shouldn't
      // monopolize the surface with no way to put it away.
      collapsible: true,
      // The head ⋯ verb is the ONLY delete path for an HTML lens: its
      // sandboxed iframe rightly can't reach destructive actions, and it has
      // no index card. The legacy fixed key is in-memory only — nothing
      // durable to retire — so it carries no verb.
      ...(id === undefined
        ? {}
        : { headActions: [destructiveHeadAction("retire-lens-html", "Retire", "lens", id)] }),
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
  ): HtmlLensEntry {
    const key = id === undefined ? HTML_LENS_KEY : htmlLensKey(id);
    const { publisher, latest, published } = createCoalescingPublisher(
      () => sm.recompose(key),
      emptyHtmlLens(),
    );
    const unregisterSnapshot = sm.register(key, latest, {
      validate: htmlStringValidator(key),
    });
    let unregisterRegion: () => void;
    try {
      unregisterRegion = registerRegion(CHAMBER_SURFACE_ID, regionFor(id, title, refresh));
    } catch (e) {
      // A failed region add (e.g. the harness per-surface ceiling) must not leak
      // the snapshot registration we already made.
      unregisterSnapshot();
      throw e;
    }
    const undeclareView = id === undefined ? () => undefined : declareView(id, title);
    const entry: HtmlLensEntry = {
      key,
      publisher,
      published,
      unregisterSnapshot,
      unregisterRegion,
      undeclareView,
      title,
      refresh,
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
  ): void {
    if (entry.title === title && sameRefresh(entry.refresh, refresh)) return;
    entry.unregisterRegion();
    let nextRegion: () => void;
    try {
      nextRegion = registerRegion(CHAMBER_SURFACE_ID, regionFor(id, title, refresh));
    } catch (e) {
      try {
        entry.unregisterRegion = registerRegion(
          CHAMBER_SURFACE_ID,
          regionFor(id, entry.title, entry.refresh),
        );
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
  ): Promise<{ key: string }> {
    const mapKey = id ?? HTML_LENS_KEY;
    htmlStringValidator(id === undefined ? HTML_LENS_KEY : htmlLensKey(id))(html);
    let entry = entries.get(mapKey);
    if (!entry) {
      entry = register(id, title, refresh);
      // Seed the cache so a client subscribing the instant the panel appears gets
      // the seed markup, not a 204 (the GET path doesn't lazy-compose).
      await sm.recompose(entry.key);
    } else if (id !== undefined) {
      rewire(id, entry, title, refresh);
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
      const result = await livePublish(html, opts?.id, opts?.title, opts?.refresh);
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
        });
      }
      return result;
    },
    // Boot goes through the live half only, so the on-disk updatedAt is never
    // re-stamped by a restart.
    reregister(id, html, title, refresh) {
      return livePublish(html, id, title, refresh);
    },
    remove(id) {
      return release(id);
    },
    dispose() {
      for (const mapKey of [...entries.keys()]) release(mapKey);
    },
  };
}
