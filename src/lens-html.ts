import type { RibSurfaceRegion, SnapshotManager, SnapshotValidator } from "@keelson/shared";
import { CHAMBER_SURFACE_ID } from "./lens.ts";
import { createCoalescingPublisher } from "./room-publisher.ts";

export const HTML_LENS_KEY = "rib:chamber:lens:html";
export const HTML_LENS_TOOL_NAME = "chamber_emit_lens_html";

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

type RegisterRegion = (surfaceId: string, region: RibSurfaceRegion) => () => void;

interface HtmlLensEntry {
  key: string;
  publisher: { publish(html: string): Promise<void> };
  unregisterSnapshot: () => void;
  unregisterRegion: () => void;
}

export interface HtmlLensRegistry {
  publish(html: string): Promise<{ key: string }>;
  dispose(): void;
}

export function createHtmlLensRegistry(
  sm: SnapshotManager,
  registerRegion: RegisterRegion,
): HtmlLensRegistry {
  const entries = new Map<string, HtmlLensEntry>();

  function release(): void {
    const entry = entries.get(HTML_LENS_KEY);
    if (!entry) return;
    entry.unregisterRegion();
    entry.unregisterSnapshot();
    entries.delete(HTML_LENS_KEY);
  }

  function register(): HtmlLensEntry {
    const { publisher, latest } = createCoalescingPublisher(
      () => sm.recompose(HTML_LENS_KEY),
      emptyHtmlLens(),
    );
    const unregisterSnapshot = sm.register(HTML_LENS_KEY, latest, {
      validate: htmlStringValidator(HTML_LENS_KEY),
    });
    let unregisterRegion: () => void;
    try {
      unregisterRegion = registerRegion(CHAMBER_SURFACE_ID, {
        key: HTML_LENS_KEY,
        title: "HTML Lens",
        glyph: { char: "❖", tone: "accent" },
        group: "lens",
        groupTitle: "Lenses",
      });
    } catch (e) {
      unregisterSnapshot();
      throw e;
    }
    const entry: HtmlLensEntry = {
      key: HTML_LENS_KEY,
      publisher,
      unregisterSnapshot,
      unregisterRegion,
    };
    entries.set(HTML_LENS_KEY, entry);
    return entry;
  }

  async function livePublish(html: string): Promise<{ key: string }> {
    htmlStringValidator(HTML_LENS_KEY)(html);
    let entry = entries.get(HTML_LENS_KEY);
    if (!entry) {
      entry = register();
      await sm.recompose(entry.key);
    }
    await entry.publisher.publish(html);
    return { key: entry.key };
  }

  return {
    publish(html) {
      return livePublish(html);
    },
    dispose() {
      release();
    },
  };
}
