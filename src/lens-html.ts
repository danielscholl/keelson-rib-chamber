import type {
  DesignThemeName,
  RibSurfaceRegion,
  SnapshotManager,
  SnapshotValidator,
} from "@keelson/shared";
import { CHAMBER_SURFACE_ID } from "./lens.ts";
import type { HtmlLensStore } from "./lens-html-store.ts";
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
  unregisterSnapshot: () => void;
  unregisterRegion: () => void;
  undeclareView: () => void;
}

export interface HtmlLensRegistry {
  // Publish per-subject when `id` is present (persisted, own key + region);
  // legacy single-canvas when absent (the fixed key, in-memory only).
  publish(html: string, opts?: { id?: string; title?: string }): Promise<{ key: string }>;
  // Re-establish a persisted lens's live key + region on boot WITHOUT re-saving,
  // so the authored updatedAt is preserved (mirrors LensRegistry.reregister).
  reregister(id: string, html: string, title?: string): Promise<{ key: string }>;
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

  function release(mapKey: string): void {
    const entry = entries.get(mapKey);
    if (!entry) return;
    entry.unregisterRegion();
    entry.unregisterSnapshot();
    entry.undeclareView();
    entries.delete(mapKey);
  }

  // Register a subject's snapshot key, surface region, and (per-subject only)
  // views entry. Fully synchronous between the entries.get miss and entries.set,
  // so two concurrent publishes of the same new id can't double-register.
  function register(id: string | undefined, title: string | undefined): HtmlLensEntry {
    const key = id === undefined ? HTML_LENS_KEY : htmlLensKey(id);
    const { publisher, latest } = createCoalescingPublisher(
      () => sm.recompose(key),
      emptyHtmlLens(),
    );
    const unregisterSnapshot = sm.register(key, latest, {
      validate: htmlStringValidator(key),
    });
    let unregisterRegion: () => void;
    try {
      unregisterRegion = registerRegion(CHAMBER_SURFACE_ID, {
        key,
        title: id === undefined ? "HTML Lens" : (title ?? id),
        glyph: { char: "❖", tone: "accent" },
        group: "lens",
        groupTitle: "Lenses",
      });
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
      unregisterSnapshot,
      unregisterRegion,
      undeclareView,
    };
    entries.set(id ?? HTML_LENS_KEY, entry);
    return entry;
  }

  async function livePublish(
    html: string,
    id: string | undefined,
    title: string | undefined,
  ): Promise<{ key: string }> {
    const mapKey = id ?? HTML_LENS_KEY;
    htmlStringValidator(id === undefined ? HTML_LENS_KEY : htmlLensKey(id))(html);
    let entry = entries.get(mapKey);
    if (!entry) {
      entry = register(id, title);
      // Seed the cache so a client subscribing the instant the panel appears gets
      // the seed markup, not a 204 (the GET path doesn't lazy-compose).
      await sm.recompose(entry.key);
    }
    await entry.publisher.publish(html);
    return { key: entry.key };
  }

  return {
    async publish(html, opts) {
      const result = await livePublish(html, opts?.id, opts?.title);
      // Persist only per-subject lenses, and only AFTER the live publish succeeds
      // (fail-closed, mirrors LensRegistry.publish); the legacy fixed key stays
      // in-memory only, exactly as before.
      if (opts?.id !== undefined) {
        await store.save({
          id: opts.id,
          html,
          ...(opts.title ? { title: opts.title } : {}),
        });
      }
      return result;
    },
    // Boot goes through the live half only, so the on-disk updatedAt is never
    // re-stamped by a restart.
    reregister(id, html, title) {
      return livePublish(html, id, title);
    },
    dispose() {
      for (const mapKey of [...entries.keys()]) release(mapKey);
    },
  };
}
