import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
import type { LensRecord } from "../lens-store.ts";
import { relativeAgo } from "../relative-time.ts";
import type { Room } from "../types.ts";

// The minimal Mind shape the feed reads: listMindRecords supplies it (the
// room-facing Mind drops createdAt). Structural, so a test passes a plain literal.
export interface MindActivity {
  name: string;
  createdAt: string;
}

// One feed row reduced to what it renders. `atMs` is the sort key; `at` is the
// original ISO the trailing span is computed from.
interface ActivityEvent {
  atMs: number;
  at: string;
  icon: string;
  glyph: CanvasTone;
  text: string;
}

// A standing panel is a glance, not a log: cap the feed and name the remainder in an
// overflow row. The Rooms and Lenses indexes hold the full history.
const FEED_LIMIT = 10;

// The header pill tones brand while the freshest event is newer than this, then
// cools to neutral — a glance signal independent of the feed's relative spans.
const FRESH_WINDOW_MS = 60 * 60_000;

// Pure: the three Chamber stores -> a standing ACTIVITY board — a plain feed of
// recent genesis / room / lens events, reverse-chron. A prior version led with a
// cumulative-pulse stats section (Minds/Rooms/Lenses/Turns counts); those first
// three each already read once elsewhere (the roster header chip, the Rooms and
// Lenses region headers), so repeating them here was the "4 minds in six places"
// finding — the feed plus the header's freshness read carries this panel's whole
// job. `now` is injected so the relative spans + ordering test deterministically.
// Validated against canvasViewSchema in tests; the producer never parses
// (validation lives at the binding edge).
export function buildActivityBoard(
  minds: readonly MindActivity[],
  rooms: readonly Room[],
  lenses: readonly LensRecord[],
  now: number = Date.now(),
): CanvasBoardView {
  const events = collectEvents(minds, rooms, lenses);

  return {
    view: "board",
    title: "Activity",
    header: { status: freshnessStatus(events, now), chip: "activity" },
    sections: [events.length === 0 ? emptyFeed() : feedSection(events, now)],
  };
}

// The header pill reads the freshest event's recency, so a glance answers "is
// anything happening?": brand while fresh (< an hour), neutral as it cools, a calm
// "Quiet" with no events at all.
function freshnessStatus(
  events: readonly ActivityEvent[],
  now: number,
): { label: string; tone: CanvasTone } {
  const newest = events[0];
  if (!newest) return { label: "Quiet", tone: "neutral" };
  const span = relativeAgo(newest.at, now);
  const fresh = now - newest.atMs < FRESH_WINDOW_MS;
  return {
    label: span === "just now" ? "active now" : `active ${span} ago`,
    tone: fresh ? "brand" : "neutral",
  };
}

type FeedRow = { icon: string; glyph: CanvasTone; text: string; trailing?: string };

function feedSection(
  events: readonly ActivityEvent[],
  now: number,
): CanvasBoardView["sections"][number] {
  const shown = events.slice(0, FEED_LIMIT);
  const items: FeedRow[] = shown.map((e) => ({
    icon: e.icon,
    glyph: e.glyph,
    text: e.text,
    trailing: `${relativeAgo(e.at, now)} ago`,
  }));
  const overflow = events.length - shown.length;
  if (overflow > 0) items.push({ icon: "…", glyph: "neutral", text: `…${overflow} earlier` });
  return { kind: "rows", title: "Recent", items };
}

// The empty/cold state: a single rows hint, so the panel is a valid board even with
// nothing authored yet (a fresh Chamber, or everything retired).
function emptyFeed(): CanvasBoardView["sections"][number] {
  return {
    kind: "rows",
    title: "Recent",
    items: [
      {
        glyph: "neutral",
        text: "No activity yet — author a Mind, convene a Room, or keep a Lens.",
      },
    ],
  };
}

// Fold the three stores into one feed, newest first. An event with no parseable
// timestamp (a drifted record) is counted in the pulse but dropped from the feed
// rather than sorting as epoch-0 noise.
function collectEvents(
  minds: readonly MindActivity[],
  rooms: readonly Room[],
  lenses: readonly LensRecord[],
): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  for (const m of minds) {
    push(events, m.createdAt, { icon: "✦", glyph: "brand", text: `New Mind · ${m.name}` });
  }
  for (const r of rooms) {
    const title = r.name || r.slug;
    push(events, r.createdAt, {
      icon: "▦",
      glyph: roomGlyph(r.status),
      text: `Room "${title}" · ${roomVerb(r.status)}`,
    });
  }
  for (const l of lenses) {
    const title = l.board.title || l.id;
    push(events, l.updatedAt, {
      icon: "❖",
      glyph: "accent",
      text: l.scope ? `Lens "${title}" · ${l.scope}` : `Lens "${title}"`,
    });
  }
  events.sort((a, b) => b.atMs - a.atMs);
  return events;
}

function push(events: ActivityEvent[], at: string, base: Omit<ActivityEvent, "atMs" | "at">): void {
  const atMs = Date.parse(at);
  if (!Number.isFinite(atMs)) return;
  events.push({ ...base, at, atMs });
}

function roomGlyph(status: Room["status"]): CanvasTone {
  return status === "active" ? "ok" : status === "done" ? "info" : "neutral";
}

function roomVerb(status: Room["status"]): string {
  return status === "active" ? "active" : status === "done" ? "done" : "stopped";
}
