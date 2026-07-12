import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
import { isExhibit, type LensRecord } from "../lens-store.ts";
import { agoLabel } from "../relative-time.ts";
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

// The Briefing's always-on RECORD register is a glance, not a log: cap the feed and
// name the remainder in an overflow row. The Rooms and Lenses indexes hold the full
// history. The default cap; a caller (the banner heartbeat) may pass a tighter one.
const FEED_LIMIT = 8;

type RowsSection = Extract<CanvasBoardView["sections"][number], { kind: "rows" }>;

// Pure: the three Chamber stores -> the Briefing's RECORD section — a reverse-chron
// rows feed of recent genesis / room / lens events (what used to be the standalone
// Activity panel, now a register of the one narrator). An empty chamber yields a
// single hint line so the footer stays a valid board with nothing else to say. `now`
// is injected so the relative spans + ordering test deterministically.
export function recordSection(
  minds: readonly MindActivity[],
  rooms: readonly Room[],
  lenses: readonly LensRecord[],
  now: number = Date.now(),
  limit: number = FEED_LIMIT,
): RowsSection {
  const events = collectEvents(minds, rooms, lenses);
  if (events.length === 0) {
    return {
      kind: "rows",
      title: "The record",
      items: [
        {
          glyph: "neutral",
          text: "No activity yet — author a Mind, convene a Room, or keep a Lens.",
        },
      ],
    };
  }
  const shown = events.slice(0, limit);
  const items: RowsSection["items"] = shown.map((e) => {
    return {
      icon: e.icon,
      glyph: e.glyph,
      text: e.text,
      trailing: agoLabel(e.at, now),
    };
  });
  const overflow = events.length - shown.length;
  if (overflow > 0) items.push({ icon: "…", glyph: "neutral", text: `…${overflow} earlier` });
  return { kind: "rows", title: "The record", items };
}

// Fold the three stores into one feed, newest first. An event with no parseable
// timestamp (a drifted record) is dropped from the feed rather than sorting as
// epoch-0 noise.
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
    if (isExhibit(l)) {
      push(events, l.updatedAt, {
        icon: "▣",
        glyph: "accent",
        text: `Exhibit "${title}" · tabled`,
      });
      continue;
    }
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
