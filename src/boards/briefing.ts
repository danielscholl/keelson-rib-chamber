import type { CanvasBoardView, CanvasPerson } from "@keelson/shared";
import { formatDuration, parseDecisionMarkers, readOutcome, turnsLabel } from "../room-text.ts";
import { speakerCounts, stripControlJson } from "../routing.ts";
import { identityToneForSlot, type Room, type TurnEntry } from "../types.ts";
import { facilitatorRoles } from "./room.ts";
import { shapeLabel } from "./rooms.ts";

type BoardSection = CanvasBoardView["sections"][number];
type StatsSection = Extract<BoardSection, { kind: "stats" }>;
type CardsSection = Extract<BoardSection, { kind: "cards" }>;
type RowsSection = Extract<BoardSection, { kind: "rows" }>;
type JourneySection = Extract<BoardSection, { kind: "journey" }>;

// The minimal seated-Mind shape the register renders from — structural, so the gate
// passes MindRecords and a test passes plain literals (mirrors activity.ts).
export interface BriefSeatedMind {
  slug: string;
  name: string;
  identitySlot?: number;
}

// One newly-ended room, reduced to what the delta register renders. Derived once at
// promote time (deriveEndedRoomBrief) so a banner re-publish never re-reads a
// transcript; `reading` is the paid turn's one editorial sentence, absent when the
// turn's copy didn't validate — the deterministic structure renders without it.
export interface EndedRoomBrief {
  room: Room;
  transcript: readonly TurnEntry[];
  // The room's own closing-document title (readOutcome) — the verdict the room
  // already paid for. Absent when the close authored no title.
  outcomeTitle?: string;
  // Distinct pinned-decision questions across the transcript (the room board's
  // decision-marker convention).
  decisionCount: number;
  reading?: string;
}

// One changed/new lens or tabled exhibit, reduced to what the register renders.
export interface ChangedLensBrief {
  id: string;
  title: string;
  kind: "lens" | "exhibit";
  scope?: string;
  reason?: string;
  sourceRoom?: string;
  maintainingMind?: string;
  reading?: string;
}

// Reduce an ended room + its transcript to the register's derived facts. The outcome
// title comes from the closing turn the same way the summary drawer reads it
// (actions/rooms.ts loadRoomOutcome), with an empty fallback title so a plain-prose
// close yields NO verdict claim rather than a generic one.
export function deriveEndedRoomBrief(room: Room, transcript: readonly TurnEntry[]): EndedRoomBrief {
  const last = [...transcript].reverse().find((e) => e.role === "agent");
  const text = last ? stripControlJson(last.parts.map((p) => p.text).join("\n")) : "";
  const { outcome } = readOutcome(text, {
    synthesized: Boolean(room.outcomeAt),
    fallbackTitle: "",
  });
  const title = outcome?.title.trim();
  const questions = new Set<number>();
  for (const entry of transcript) {
    if (entry.role !== "agent") continue;
    const body = stripControlJson(entry.parts.map((p) => p.text).join("\n"));
    for (const marker of parseDecisionMarkers(body)) questions.add(marker.question);
  }
  return {
    room,
    transcript,
    ...(title ? { outcomeTitle: title } : {}),
    decisionCount: questions.size,
  };
}

// The pulse: since-you-looked delta readings, one tile per nonzero fact. Deltas ARE
// news, unlike the standing counts the digest is forbidden to restate — so the strip
// exists only inside a promoted register and skips every zero tile.
export function briefingPulseSection(
  rooms: readonly EndedRoomBrief[],
  lenses: readonly ChangedLensBrief[],
): StatsSection | undefined {
  const items: StatsSection["items"] = [];
  if (rooms.length > 0) {
    items.push({
      label: rooms.length === 1 ? "room concluded" : "rooms concluded",
      value: rooms.length,
      delta: { text: `+${rooms.length}`, direction: "up", tone: "info" },
      sub: rooms.map((r) => r.room.name || r.room.slug).join(", "),
    });
    const turns = rooms.reduce((sum, r) => sum + r.room.turnIndex, 0);
    if (turns > 0) {
      const synthesized = rooms.filter((r) => Boolean(r.room.outcomeAt)).length;
      items.push({
        label: "turns spent",
        value: turns,
        ...(synthesized > 0 ? { sub: "closing synthesis authored" } : {}),
      });
    }
    const decisions = rooms.reduce((sum, r) => sum + r.decisionCount, 0);
    if (decisions > 0) {
      items.push({ label: "decisions pinned", value: decisions, sub: "marked in-room" });
    }
  }
  if (lenses.length > 0) {
    const allExhibits = lenses.every((l) => l.kind === "exhibit");
    const one = lenses.length === 1;
    items.push({
      label: allExhibits
        ? one
          ? "exhibit tabled"
          : "exhibits tabled"
        : one
          ? "lens changed"
          : "lenses changed",
      value: lenses.length,
      delta: { text: `+${lenses.length}`, direction: "up", tone: "info" },
      sub: lenses.map((l) => l.title).join(", "),
    });
  }
  return items.length > 0 ? { kind: "stats", items } : undefined;
}

// The turn's editorial lead, as the register's one prose line.
export function briefingLeadSection(lead: string): RowsSection {
  return { kind: "rows", items: [{ glyph: "brand", text: lead }] };
}

// The room's seat order — facilitators then participants, deduped — resolved to
// names + identity tones (the id-* accompaniment rule: a hue never renders without
// its name). Shared by the verdict card's cast field and the banner head's people.
function castFor(room: Room, minds: readonly BriefSeatedMind[]): CanvasPerson[] {
  const bySlug = new Map(minds.map((m) => [m.slug, m]));
  const seen = new Set<string>();
  const cast: CanvasPerson[] = [];
  const add = (slug: string) => {
    if (seen.has(slug)) return;
    seen.add(slug);
    const mind = bySlug.get(slug);
    cast.push({ name: mind?.name ?? slug, tone: identityToneForSlot(mind?.identitySlot) });
  };
  for (const [slug] of facilitatorRoles(room)) add(slug);
  for (const slug of room.participants) add(slug);
  return cast;
}

// Who carried the room, as identity-toned share segments — speakerCounts over the
// transcript, labelled by name so the bar's hover always names its hue.
function shareSegments(
  transcript: readonly TurnEntry[],
  minds: readonly BriefSeatedMind[],
): { label: string; n: number; tone: ReturnType<typeof identityToneForSlot> }[] {
  const bySlug = new Map(minds.map((m) => [m.slug, m]));
  const counts = speakerCounts(transcript);
  const segments: { label: string; n: number; tone: ReturnType<typeof identityToneForSlot> }[] = [];
  for (const [slug, n] of counts) {
    const mind = bySlug.get(slug);
    segments.push({ label: mind?.name ?? slug, n, tone: identityToneForSlot(mind?.identitySlot) });
  }
  return segments;
}

// One verdict card per ended room (title = the room's own closing verdict when it
// authored one), then one card per changed lens. The `reading` footnotes are the only
// LLM-authored strings; everything else is the records' own facts.
export function briefingVerdictSection(
  rooms: readonly EndedRoomBrief[],
  lenses: readonly ChangedLensBrief[],
  minds: readonly BriefSeatedMind[],
): CardsSection | undefined {
  const items: CardsSection["items"] = [];
  for (const brief of rooms) {
    const { room } = brief;
    const cast = castFor(room, minds);
    const segments = shareSegments(brief.transcript, minds);
    const endIso =
      room.outcomeAt ?? brief.transcript[brief.transcript.length - 1]?.at ?? room.createdAt;
    const duration = formatDuration(room.createdAt, endIso);
    const meta = [
      room.name || room.slug,
      shapeLabel(room),
      `${turnsLabel(room.turnIndex, room.turnBudget)} turns`,
      ...(duration ? [duration] : []),
    ].join(" · ");
    items.push({
      title: brief.outcomeTitle ?? (room.name || room.slug),
      pill: brief.outcomeTitle
        ? { label: "verdict", tone: "brand" }
        : { label: room.status, tone: room.status === "done" ? "info" : "neutral" },
      fields: [{ value: meta }, ...(cast.length > 0 ? [{ label: "with", people: cast }] : [])],
      ...(segments.length > 0 ? { bar: { segments } } : {}),
      ...(brief.reading ? { footnote: brief.reading } : {}),
    });
  }
  for (const lens of lenses) {
    items.push({
      title: lens.title,
      pill: { label: lens.kind === "exhibit" ? "exhibit" : "lens", tone: "accent" },
      fields: [
        ...(lens.scope ? [{ label: "scope", value: lens.scope }] : []),
        ...(lens.reason ? [{ label: "changed", value: lens.reason }] : []),
        ...(lens.sourceRoom ? [{ label: "from room", value: lens.sourceRoom }] : []),
      ],
      ...(lens.reading ? { footnote: lens.reading } : {}),
    });
  }
  return items.length > 0 ? { kind: "cards", items } : undefined;
}

// The room's arc, rendered only when this promote covers exactly one room AND that
// room closed with an authored verdict — a journey needs an ending to be a story.
export function briefingJourneySection(brief: EndedRoomBrief): JourneySection | undefined {
  if (!brief.outcomeTitle) return undefined;
  const { room } = brief;
  const items: JourneySection["items"] = [
    {
      title: "Convened",
      text: `${room.participants.length} minds · ${shapeLabel(room)}`,
    },
    { title: "Debated", text: `${room.turnIndex} turns` },
  ];
  if (brief.decisionCount > 0) {
    items.push({
      title: "Pinned",
      text: `${brief.decisionCount} decision${brief.decisionCount === 1 ? "" : "s"} marked in-room`,
    });
  }
  if (room.outcomeAt) items.push({ title: "Synthesized", text: "closing document authored" });
  items.push({ title: "Verdict", text: brief.outcomeTitle });
  return { kind: "journey", title: "How it got there", items };
}

// The banner head's who-acted peek: the ended rooms' casts in seat order, then lens
// maintainers resolvable to a seated Mind — deduped by rendered name, capped to a
// glance. Names only ever pair with their own identity tone (castFor's rule).
export function briefingPeople(
  rooms: readonly EndedRoomBrief[],
  lenses: readonly ChangedLensBrief[],
  minds: readonly BriefSeatedMind[],
): CanvasPerson[] {
  const seen = new Set<string>();
  const people: CanvasPerson[] = [];
  const add = (person: CanvasPerson) => {
    if (seen.has(person.name)) return;
    seen.add(person.name);
    people.push(person);
  };
  for (const brief of rooms) for (const person of castFor(brief.room, minds)) add(person);
  for (const lens of lenses) {
    if (!lens.maintainingMind) continue;
    const mind = minds.find(
      (m) => m.slug === lens.maintainingMind || m.name === lens.maintainingMind,
    );
    if (mind) add({ name: mind.name, tone: identityToneForSlot(mind.identitySlot) });
  }
  return people.slice(0, 8);
}

// Assemble the promoted delta register: pulse, the turn's lead, the verdict/lens
// cards, and (for a single verdict-bearing room) the arc. The register label is
// stamped by the banner composer on the first section, matching the prior contract.
export function buildDeltaRegister(
  rooms: readonly EndedRoomBrief[],
  lenses: readonly ChangedLensBrief[],
  minds: readonly BriefSeatedMind[],
  lead?: string,
): BoardSection[] {
  const sections: BoardSection[] = [];
  const pulse = briefingPulseSection(rooms, lenses);
  if (pulse) sections.push(pulse);
  if (lead) sections.push(briefingLeadSection(lead));
  const cards = briefingVerdictSection(rooms, lenses, minds);
  if (cards) sections.push(cards);
  const only = rooms.length === 1 ? rooms[0] : undefined;
  const journey = only ? briefingJourneySection(only) : undefined;
  if (journey) sections.push(journey);
  return sections;
}
