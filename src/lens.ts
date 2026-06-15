import type { CanvasBoardView, RibSurfaceRegion, SnapshotManager } from "@keelson/shared";
import { expectView } from "@keelson/shared";
import { createCoalescingPublisher } from "./room-publisher.ts";

// A Mind authors a lens by publishing a board under a per-subject key
// (rib:chamber:lens:<id>). The registry registers that snapshot key AND adds a
// surface region for it through the harness `registerRegion` seam, so each new
// subject appears as its own panel — unbounded, no fixed pool, no eviction. The
// seam is optional: without it (an older harness) the board still publishes and is
// reachable by key, it just renders no panel.

// The id of the Chamber surface lens panels attach to. Shared with the surface
// declaration in index.ts so the registerRegion target can't drift from it.
export const CHAMBER_SURFACE_ID = "chamber";

// The lens write-seam tool name. One source of truth: the tool registration, the
// chamber-lens workflow's allowed_tools, and the room driver's turn-tools all
// reference this so a Mind can author a lens from the workflow OR from a room turn.
export const LENS_TOOL_NAME = "chamber_emit_lens";

export function lensKey(id: string): string {
  return `rib:chamber:lens:${id}`;
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

// Publishes a Mind-authored board to its per-subject lens key, registering the key
// and a matching surface region the first time an id is seen; re-authoring the same
// id updates the existing panel in place. Holds the snapshot + region handles per id
// so dispose() releases both (letting a re-bootstrap re-register cleanly).
export interface LensRegistry {
  publish(id: string, board: CanvasBoardView): Promise<{ key: string }>;
  dispose(): void;
}

interface LensEntry {
  key: string;
  publisher: { publish(board: CanvasBoardView): Promise<void> };
  unregisterSnapshot: () => void;
  unregisterRegion: () => void;
}

export function createLensRegistry(
  sm: SnapshotManager,
  registerRegion?: RegisterRegion,
): LensRegistry {
  const entries = new Map<string, LensEntry>();
  return {
    async publish(id, board) {
      // Validate the board BEFORE registering anything, so a board we can't render
      // fails closed loudly and never leaves a dangling key or empty panel behind.
      expectView(lensKey(id), "board")(board);
      let entry = entries.get(id);
      if (!entry) {
        const key = lensKey(id);
        const { publisher, latest } = createCoalescingPublisher(
          () => sm.recompose(key),
          emptyLensBoard(),
        );
        const unregisterSnapshot = sm.register(key, latest, {
          validate: expectView(key, "board"),
        });
        let unregisterRegion: () => void;
        try {
          // Seed the cache so a client subscribing the instant the panel appears gets
          // the seed board, not a 204 (the GET path doesn't lazy-compose).
          await sm.recompose(key);
          unregisterRegion =
            registerRegion?.(CHAMBER_SURFACE_ID, {
              key,
              title: id,
              glyph: { char: "✦", tone: "accent" },
              group: "lens",
            }) ?? (() => {});
        } catch (e) {
          // A failed region add (e.g. the harness per-surface ceiling) must not leak
          // the snapshot registration we already made.
          unregisterSnapshot();
          throw e;
        }
        entry = { key, publisher, unregisterSnapshot, unregisterRegion };
        entries.set(id, entry);
      }
      await entry.publisher.publish(board);
      return { key: entry.key };
    },
    dispose() {
      for (const entry of entries.values()) {
        entry.unregisterRegion();
        entry.unregisterSnapshot();
      }
      entries.clear();
    },
  };
}
