import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CanvasBoardView } from "@keelson/shared";
import { chamberDataHome } from "./paths.ts";

// The standing digest's persisted state: the last agent-authored board and the chamber
// fingerprint it was authored against. The gate diffs a fresh fingerprint against this
// to decide whether the subject changed since the last (paid) authoring; the publish
// collector reads the board back to refresh the bound key every tick. A missing/torn
// file degrades to null (cold start — the gate sees a changed subject, the publish
// collector falls back to the cold board), the same fail-soft contract readWatermark
// keeps.
export interface DigestRecord {
  board: CanvasBoardView;
  fingerprint: string;
}

// Lives next to brief-watermark.json under the data home (rib-owned state, not a
// paths.ts dir), so the filename stays here like watermark-store / room-draft.
const DIGEST_FILE = "digest.json";

export function digestFile(dataHome: string = chamberDataHome()): string {
  return join(dataHome, DIGEST_FILE);
}

// The valid board the digest panel shows before its first authoring (or when the store
// is missing/torn): a titled, calm board so a client subscribing the instant the panel
// appears reads warming-up copy, not a loading skeleton. The authored board replaces it
// on the first publish.
export function coldStartDigestBoard(): CanvasBoardView {
  return {
    view: "board",
    title: "Digest",
    header: { status: { label: "Warming up", tone: "neutral" } },
    sections: [
      {
        kind: "rows",
        items: [
          {
            text: "The digest composes when the chamber next changes — author a Mind, convene a Room, or keep a Lens.",
            glyph: "neutral",
          },
        ],
      },
    ],
  };
}

// Which board the publish tick emits. The persisted board is the last agent-authored
// synthesis, but the gate withholds a re-author once the chamber empties (hasDigestContent
// false → no paid turn), so a stored board would otherwise keep naming Minds/rooms/lenses
// that are gone. When the live chamber has no content, fall back to the cold board so the
// panel can't assert a stale population; a populated chamber keeps its authored board.
export function resolveDigestPublishBoard(
  record: DigestRecord | null,
  hasContent: boolean,
): CanvasBoardView {
  if (!hasContent) return coldStartDigestBoard();
  return record?.board ?? coldStartDigestBoard();
}

// Tolerant read: a missing/corrupt/torn file — or one missing the board or fingerprint —
// degrades to null (cold start) rather than throwing, the same fail-soft contract
// readWatermark / readMinds keep. The board is only structurally checked here (an
// object); the publish edge's expectView guard is the fail-closed board validator.
export async function readDigest(
  dataHome: string = chamberDataHome(),
): Promise<DigestRecord | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(digestFile(dataHome), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const p = parsed as Record<string, unknown>;
    if (typeof p.board !== "object" || p.board === null) return null;
    if (typeof p.fingerprint !== "string") return null;
    return {
      board: p.board as CanvasBoardView,
      fingerprint: p.fingerprint,
    };
  } catch {
    return null;
  }
}

// Monotonic per-write suffix so two overlapping writes never share a temp path
// (watermark-store / room-store do the same) — the rename stays atomic under a race.
let writeSeq = 0;

// Atomic write (temp + rename, like writeWatermark) so a crash mid-write can't leave a
// torn digest the next read would discard.
export async function writeDigest(
  record: DigestRecord,
  dataHome: string = chamberDataHome(),
): Promise<void> {
  await mkdir(dataHome, { recursive: true });
  const file = digestFile(dataHome);
  const tmp = `${file}.${process.pid}.${writeSeq++}.tmp`;
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`);
  await rename(tmp, file);
}
