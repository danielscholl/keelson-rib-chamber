import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CanvasBoardView,
  CanvasView,
  RibContext,
  SnapshotManager,
  ToolContext,
} from "@keelson/shared";
import { canvasViewSchema, expectView } from "@keelson/shared";
import type { RunAgentTurn } from "../src/agent-turn.ts";
import { writeDigest } from "../src/digest-store.ts";
import rib, { evaluateBriefGate } from "../src/index.ts";
import { scaffoldMind } from "../src/minds-store.ts";
import { mindsDir, roomsDir, setChamberDataHome } from "../src/paths.ts";
import { noteRoomDeleted } from "../src/room-lifecycle.ts";
import { createFileRoomStore } from "../src/room-store.ts";
import type { Room } from "../src/types.ts";
import { readWatermark, writeWatermark } from "../src/watermark-store.ts";
import { gatedRunAgentTurn, scriptedRunAgentTurn } from "./helpers/fakes.ts";

const BRIEF_KEY = "rib:chamber:brief";

// registerTools seeds BRIEF_KEY + clears a stale briefPromoted via unawaited async
// work (an sm.recompose and a serialized watermark write). Poll a condition rather
// than a single macrotask so a slow fs write can't race a test's assertion under CI.
async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise<void>((r) => setTimeout(r, 10));
  }
  throw new Error("waitFor: condition not met within timeout");
}

// A valid briefing board an agent turn might author — the scripted reply text.
const briefBoard: CanvasBoardView = {
  view: "board",
  title: "Chamber Briefing",
  header: { status: { label: "Updated", tone: "brand" } },
  sections: [{ kind: "rows", items: [{ text: "A room just ended.", glyph: "ok" }] }],
};

// A SnapshotManager double that runs the registered composer + validator on
// recompose and records the validated frame for BRIEF_KEY — so a test reads exactly
// the board the gate published, and a published board is proven to pass the same
// fail-closed gate the real manager applies.
function fakeSnapshotManager() {
  const composers = new Map<string, () => unknown>();
  const validators = new Map<string, (d: unknown) => unknown>();
  const published: CanvasView[] = [];
  const sm = {
    register(key: string, compose: () => unknown, opts?: { validate?: (d: unknown) => unknown }) {
      composers.set(key, compose);
      if (opts?.validate) validators.set(key, opts.validate);
      return () => {
        composers.delete(key);
        validators.delete(key);
      };
    },
    async recompose(key: string) {
      const composed = await composers.get(key)?.();
      const view = validators.get(key)?.(composed) ?? composed;
      if (key === BRIEF_KEY) published.push(view as CanvasView);
      return undefined;
    },
    latest: () => undefined,
    keys: () => [...composers.keys()],
    dispose: async () => {},
  } as unknown as SnapshotManager;
  return { sm, published, lastBoard: () => published.at(-1) as CanvasBoardView | undefined };
}

function makeCtx(
  run: RunAgentTurn,
  sm: SnapshotManager,
  refreshWorkflow?: RibContext["refreshWorkflow"],
): RibContext {
  return {
    getExec: () => ({
      runJSON: async <T>() => ({ ok: true as const, data: undefined as T }),
      runText: async () => ({ ok: true as const, data: "" }),
    }),
    getSnapshotManager: () => sm,
    registerRegion: () => () => {},
    runAgentTurn: run,
    ...(refreshWorkflow ? { refreshWorkflow } : {}),
  } as RibContext;
}

function makeRoom(over: Partial<Room>): Room {
  return {
    slug: "room",
    name: "Design Review",
    strategy: "sequential",
    participants: ["ada", "bo"],
    status: "active",
    turnBudget: 4,
    turnIndex: 3,
    round: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("brief gate (cost-safety + delta promotion)", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "chamber-gate-"));
    setChamberDataHome(home);
  });
  afterEach(async () => {
    await rib.dispose?.();
    setChamberDataHome(undefined);
    await rm(home, { recursive: true, force: true });
  });

  async function seedMinds(): Promise<void> {
    for (const slug of ["ada", "bo"]) {
      await scaffoldMind(
        mindsDir(),
        {
          slug,
          name: slug,
          role: "r",
          voice: "v",
          persona: `I am ${slug}.`,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        `soul ${slug}`,
      );
    }
  }

  test("the footer is seeded with a valid quiet board at boot", async () => {
    const { sm, lastBoard } = fakeSnapshotManager();
    const { run } = scriptedRunAgentTurn([{ text: JSON.stringify(briefBoard) }]);
    rib.registerTools?.(makeCtx(run, sm));
    await waitFor(() => lastBoard() !== undefined);
    // registerTools seeds BRIEF_KEY via sm.recompose — the cache holds the quiet board.
    const seeded = lastBoard();
    expect(seeded).toBeDefined();
    expect(canvasViewSchema.safeParse(seeded).success).toBe(true);
    expect(() => expectView(BRIEF_KEY, "board")(seeded)).not.toThrow();
  });

  test("boot clears a persisted briefPromoted (so the pulse matches the quiet seed), keeping acks", async () => {
    // A prior session left the watermark promoted with acks. The boot re-seeds the
    // footer quiet, so the pulse's "For you" must not still read "1 waiting".
    await writeWatermark(
      {
        ackedEndedRooms: ["r-old"],
        lensFingerprints: { keep: "t1" },
        briefPromoted: true,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      home,
    );
    const { sm } = fakeSnapshotManager();
    const { run } = scriptedRunAgentTurn([{ text: JSON.stringify(briefBoard) }]);
    rib.registerTools?.(makeCtx(run, sm));
    await waitFor(async () => (await readWatermark(home)).briefPromoted === false);

    const wm = await readWatermark(home);
    expect(wm.briefPromoted).toBe(false);
    // The acks/fingerprints are preserved — a real promote still needs fresh substance.
    expect(wm.ackedEndedRooms).toEqual(["r-old"]);
    expect(wm.lensFingerprints).toEqual({ keep: "t1" });
  });

  test("the standing-synthesis register embeds digest.json's sections with any stats dropped, labelled 'The read'", async () => {
    await seedMinds();
    // A produced artifact is what makes the chamber non-empty — Minds alone are
    // capacity, and the register's floor mirrors hasDigestContent.
    await createFileRoomStore(roomsDir()).saveRoom(makeRoom({ slug: "r-done", status: "done" }));
    await writeDigest(
      {
        board: {
          view: "board",
          title: "Digest",
          sections: [
            // A stats section a turn might author despite the prompt — it must be dropped
            // so an index count can't creep into the one narrator.
            { kind: "stats", items: [{ label: "Minds", value: 2 }] },
            { kind: "rows", items: [{ text: "The bench is naming a new rib." }] },
          ],
        },
        fingerprint: "fp",
      },
      home,
    );
    const { sm, lastBoard } = fakeSnapshotManager();
    const { run } = scriptedRunAgentTurn([{ text: JSON.stringify(briefBoard) }]);
    rib.registerTools?.(makeCtx(run, sm));
    // Boot composes the footer in-process; wait for the standing-synthesis register to appear.
    await waitFor(() => (lastBoard()?.sections ?? []).some((s) => s.title === "The read"));
    const footer = lastBoard();
    const digest = footer?.sections.find((s) => s.title === "The read");
    expect(digest?.kind).toBe("rows"); // the stats section was dropped; the rows section leads
    expect(JSON.stringify(digest)).toContain("The bench is naming a new rib.");
    // No stats section reached the footer from the digest.
    expect(footer?.sections.some((s) => s.kind === "stats")).toBe(false);
  });

  test("the standing-synthesis register is absent on a chamber with no content (sparse = absent, not narrated)", async () => {
    // A stored digest exists, but nothing is seated — hasContent is false, so the digest
    // register is withheld rather than naming gone entities.
    await writeDigest(
      {
        board: {
          view: "board",
          sections: [{ kind: "rows", items: [{ text: "a stale synthesis" }] }],
        },
        fingerprint: "fp",
      },
      home,
    );
    const { sm, lastBoard } = fakeSnapshotManager();
    const { run } = scriptedRunAgentTurn([{ text: JSON.stringify(briefBoard) }]);
    rib.registerTools?.(makeCtx(run, sm));
    // Wait for the composed footer (its record register shows the empty-chamber hint).
    await waitFor(() => JSON.stringify(lastBoard() ?? {}).includes("No activity yet"));
    expect(lastBoard()?.sections.some((s) => s.title === "The read")).toBe(false);
    expect(JSON.stringify(lastBoard())).not.toContain("a stale synthesis");
  });

  test("the composed Briefing caps the record register at the banner limit (4) with an overflow row", async () => {
    // Seed more activity than the banner cap so the PRODUCTION composer's limit is
    // exercised: a regression dropping the BANNER_RECORD_LIMIT argument would restore
    // eight rows here, where the recordSection unit test (a direct limit call) stays green.
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    for (let i = 0; i < 6; i++) {
      await scaffoldMind(
        mindsDir(),
        {
          slug: `m${i}`,
          name: `M${i}`,
          role: "r",
          voice: "v",
          persona: `I am m${i}.`,
          createdAt: new Date(base + i * 60_000).toISOString(),
        },
        `soul m${i}`,
      );
    }
    const { sm, lastBoard } = fakeSnapshotManager();
    const { run } = scriptedRunAgentTurn([{ text: JSON.stringify(briefBoard) }]);
    rib.registerTools?.(makeCtx(run, sm));
    // Wait for the composed board: the seed's record holds one "…" row, the composed
    // record overflows, so the overflow row proves we captured the real compose.
    await waitFor(() => JSON.stringify(lastBoard() ?? {}).includes("…2 earlier"));
    const record = lastBoard()?.sections.find((s) => s.title === "The record");
    expect(record?.kind).toBe("rows");
    if (record?.kind !== "rows") throw new Error("no record section");
    // 6 events, cap 4 -> 4 shown + one overflow row.
    expect(record.items).toHaveLength(5);
    expect(record.items[4]?.text).toBe("…2 earlier");
  });

  test("quiet (nothing new) runs ZERO agent turns and leaves the watermark unchanged", async () => {
    await seedMinds(); // minds alone are NOT substance
    const { sm } = fakeSnapshotManager();
    const { run, requests } = scriptedRunAgentTurn([{ text: JSON.stringify(briefBoard) }]);
    rib.registerTools?.(makeCtx(run, sm));

    await evaluateBriefGate();

    // The headline invariant: no substance => no paid turn.
    expect(requests).toHaveLength(0);
    // And an idempotent no-op leaves the (cold) watermark unwritten.
    const wm = await readWatermark(home);
    expect(wm.briefPromoted).toBe(false);
    expect(wm.updatedAt).toBe("");
  });

  test("an ended room promotes: exactly ONE turn, delta in the prompt, board published, watermark advanced", async () => {
    await seedMinds();
    const rooms = createFileRoomStore(roomsDir());
    await rooms.saveRoom(makeRoom({ slug: "r-done", name: "Design Review", status: "done" }));
    const { sm, lastBoard } = fakeSnapshotManager();
    const { run, requests } = scriptedRunAgentTurn([{ text: JSON.stringify(briefBoard) }]);
    rib.registerTools?.(makeCtx(run, sm));

    await evaluateBriefGate();

    expect(requests).toHaveLength(1);
    // The prompt carries the delta as metadata (name/status/turns), no transcript.
    const prompt = requests[0]?.prompt ?? "";
    expect(prompt).toContain("What's new since the last briefing");
    expect(prompt).toContain("Design Review");
    expect(prompt).toContain("done");
    // Tools are withheld for the compose turn (cost + no side effects).
    expect(requests[0]?.allowedTools).toEqual([]);
    // The turn's content became the footer's delta register, labelled and counted.
    const footer = lastBoard();
    expect(footer?.title).toBe("Briefing");
    expect(footer?.header?.status?.label).toBe("1 new");
    const delta = footer?.sections.find((s) => s.title === "Since you last looked");
    expect(delta?.kind).toBe("rows");
    expect(JSON.stringify(delta)).toContain("A room just ended.");
    // The delta register carries its deterministic jump chips — built from the
    // gate's structured slugs (never parsed from the turn's prose), reusing the
    // rooms index's own open verb.
    const chips = footer?.sections.find((s) => s.title === "Open what changed");
    expect(chips?.kind).toBe("actions");
    if (chips?.kind !== "actions") throw new Error("no jump-chip section");
    expect(chips.wrap).toBe(true);
    expect(chips.items).toEqual([
      { type: "room-open", label: "Design Review ↗", glyph: "▦", payload: { slug: "r-done" } },
    ]);
    // The watermark advanced: the ended room is acked and the brief is promoted.
    const wm = await readWatermark(home);
    expect(wm.ackedEndedRooms).toEqual(["r-done"]);
    expect(wm.briefPromoted).toBe(true);
  });

  test("deleting a promoted room drops its jump chip without a paid turn", async () => {
    await seedMinds();
    const rooms = createFileRoomStore(roomsDir());
    await rooms.saveRoom(makeRoom({ slug: "r-done", name: "Design Review", status: "done" }));
    const { sm, published, lastBoard } = fakeSnapshotManager();
    const { run, requests } = scriptedRunAgentTurn([{ text: JSON.stringify(briefBoard) }]);
    rib.registerTools?.(makeCtx(run, sm));
    await evaluateBriefGate();
    expect(requests).toHaveLength(1);
    const chips = lastBoard()?.sections.find((s) => s.title === "Open what changed");
    expect(chips?.kind).toBe("actions");
    if (chips?.kind !== "actions") throw new Error("no jump-chip section");
    expect(chips.items).toContainEqual({
      type: "room-open",
      label: "Design Review ↗",
      glyph: "▦",
      payload: { slug: "r-done" },
    });

    const publishCount = published.length;
    await rooms.deleteRoom("r-done");
    noteRoomDeleted("r-done");
    await waitFor(() => published.length > publishCount);

    expect(lastBoard()?.sections.some((s) => s.title === "Open what changed")).toBe(false);
    expect(requests).toHaveLength(1);
  });

  test("a delete landing mid-turn is not resurrected when the paid turn lands", async () => {
    // The promote rebuilds `sources` from a read taken before the turn ran, so without
    // the dropped-slug set the late assign clobbers the delete back in as a dead chip.
    await seedMinds();
    const rooms = createFileRoomStore(roomsDir());
    await rooms.saveRoom(makeRoom({ slug: "r-race", name: "Race Room", status: "done" }));
    const { sm, lastBoard } = fakeSnapshotManager();
    const { run, started, release } = gatedRunAgentTurn(JSON.stringify(briefBoard));
    rib.registerTools?.(makeCtx(run, sm));

    const gate = evaluateBriefGate();
    await started;
    await rooms.deleteRoom("r-race");
    noteRoomDeleted("r-race");
    release();
    await gate;

    expect(lastBoard()?.sections.some((s) => s.title === "Open what changed")).toBe(false);
  });

  test("a changed lens promotes via the chamber_emit_lens hook (exactly one turn)", async () => {
    await seedMinds();
    const { sm, published } = fakeSnapshotManager();
    // Only ONE scripted turn: the lens emit publishes (no turn of its own) and fires
    // the gate, which runs the single briefing turn.
    const { run, requests } = scriptedRunAgentTurn([{ text: JSON.stringify(briefBoard) }]);
    const tools = rib.registerTools?.(makeCtx(run, sm)) ?? [];
    const emit = tools.find((t) => t.name === "chamber_emit_lens");
    expect(emit).toBeDefined();

    const toolCtx: ToolContext = {
      cwd: ".",
      emit: () => {},
      abortSignal: new AbortController().signal,
    };
    await emit?.execute({ id: "findings", board: briefBoard }, toolCtx);
    // The emit fires the gate fire-and-forget; chain behind it and let it settle.
    await evaluateBriefGate();

    // The lens publish itself runs no turn; the gate runs exactly one brief turn.
    expect(requests).toHaveLength(1);
    // The promote published the delta register into the footer (the trailing chained
    // re-eval then lapses it — the promote itself is what we assert here).
    expect(
      published.some((b) =>
        (b as CanvasBoardView).sections?.some((s) => s.title === "Since you last looked"),
      ),
    ).toBe(true);
    // Its jump chip opens the changed lens by the id the gate diffed — labelled by
    // the lens board's own title, via the lenses index's open verb.
    const chipSections = published.flatMap(
      (b) => (b as CanvasBoardView).sections?.filter((s) => s.title === "Open what changed") ?? [],
    );
    expect(
      chipSections.some(
        (s) =>
          s.kind === "actions" &&
          s.items.some(
            (i) =>
              i.type === "lens-open" &&
              i.label === "Chamber Briefing ↗" &&
              JSON.stringify(i.payload) === JSON.stringify({ id: "findings" }),
          ),
      ),
    ).toBe(true);
    // The promote advanced the watermark to ack the lens fingerprint.
    const wm = await readWatermark(home);
    expect(Object.keys(wm.lensFingerprints)).toContain("findings");
  });

  test("an unchanged re-author is not substance — the cadence buys no second turn", async () => {
    await seedMinds();
    const { sm } = fakeSnapshotManager();
    const { run, requests } = scriptedRunAgentTurn([{ text: JSON.stringify(briefBoard) }]);
    const tools = rib.registerTools?.(makeCtx(run, sm)) ?? [];
    const emit = tools.find((t) => t.name === "chamber_emit_lens");
    const toolCtx: ToolContext = {
      cwd: ".",
      emit: () => {},
      abortSignal: new AbortController().signal,
    };
    await emit?.execute({ id: "findings", board: briefBoard }, toolCtx);
    await evaluateBriefGate();
    expect(requests).toHaveLength(1);
    const acked = (await readWatermark(home)).lensFingerprints;

    // A cadence tick on a living lens: the bundled refresh re-composes from the prior
    // board, so re-emitting it unchanged is the common case, not an edge. The gate
    // fingerprints on updatedAt, so a re-stamp here would read as fresh substance and
    // buy a briefing turn for a lens that says exactly what it said before.
    await emit?.execute({ id: "findings", board: briefBoard }, toolCtx);
    await evaluateBriefGate();
    expect(requests).toHaveLength(1);
    expect((await readWatermark(home)).lensFingerprints).toEqual(acked);
  });

  test("retiring a promoted lens lapses the delta — the delete fires the gate, no second paid turn", async () => {
    await seedMinds();
    const { sm, lastBoard } = fakeSnapshotManager();
    const { run, requests } = scriptedRunAgentTurn([{ text: JSON.stringify(briefBoard) }]);
    const tools = rib.registerTools?.(makeCtx(run, sm)) ?? [];
    const emit = tools.find((t) => t.name === "chamber_emit_lens");
    const toolCtx: ToolContext = {
      cwd: ".",
      emit: () => {},
      abortSignal: new AbortController().signal,
    };
    // The emit fires the gate fire-and-forget, which promotes the lens into the delta
    // register (one paid turn). Wait for that promote to land, and do NOT call the gate
    // again — a second eval would itself lapse it (that path is tested below).
    await emit?.execute({ id: "findings", board: briefBoard }, toolCtx);
    await waitFor(() => lastBoard()?.header?.status?.label === "1 new");
    expect(requests).toHaveLength(1);
    expect(lastBoard()?.sections.some((s) => s.title === "Since you last looked")).toBe(true);
    expect((await readWatermark(home)).briefPromoted).toBe(true);

    // Retire the lens through the real board verb. The delete alone must lapse the
    // stale delta (no explicit gate call from the test) — else the banner keeps a
    // "1 new" chip opening a now-dead key (the reported bug).
    const res = await rib.onAction?.(
      { type: "retire-lens", payload: { id: "findings" } },
      {} as unknown as RibContext,
    );
    expect(res?.ok).toBe(true);
    await waitFor(() => lastBoard()?.header?.status === undefined);
    expect(lastBoard()?.sections.some((s) => s.title === "Since you last looked")).toBe(false);
    expect(lastBoard()?.sections.some((s) => s.title === "Open what changed")).toBe(false);
    // The lapse is free: no second paid turn, and the watermark is un-promoted.
    expect(requests).toHaveLength(1);
    expect((await readWatermark(home)).briefPromoted).toBe(false);
  });

  test("re-evaluating after a promote with nothing new runs NO turn and flips briefPromoted false", async () => {
    await seedMinds();
    const rooms = createFileRoomStore(roomsDir());
    await rooms.saveRoom(makeRoom({ slug: "r-done", status: "done" }));
    const { sm, lastBoard } = fakeSnapshotManager();
    const { run, requests } = scriptedRunAgentTurn([{ text: JSON.stringify(briefBoard) }]);
    rib.registerTools?.(makeCtx(run, sm));

    await evaluateBriefGate(); // promote
    expect(requests).toHaveLength(1);
    expect((await readWatermark(home)).briefPromoted).toBe(true);

    await evaluateBriefGate(); // nothing new since
    // No second paid turn.
    expect(requests).toHaveLength(1);
    // The delta register lapses (the digest + record remain); the header is calm again
    // and the jump chips lapse with their register. Calm means NO pill: the pill is the
    // promoted signal, not a standing badge.
    expect(lastBoard()?.header?.status).toBeUndefined();
    expect(lastBoard()?.sections.some((s) => s.title === "Since you last looked")).toBe(false);
    expect(lastBoard()?.sections.some((s) => s.title === "Open what changed")).toBe(false);
    expect((await readWatermark(home)).briefPromoted).toBe(false);
  });

  test("concurrent triggers fire at most ONE turn (serialized via briefInFlight)", async () => {
    await seedMinds();
    const rooms = createFileRoomStore(roomsDir());
    await rooms.saveRoom(makeRoom({ slug: "r-done", status: "done" }));
    const { sm } = fakeSnapshotManager();
    const { run, requests } = scriptedRunAgentTurn([{ text: JSON.stringify(briefBoard) }]);
    rib.registerTools?.(makeCtx(run, sm));

    // Three triggers racing one ended room: the first promotes, the rest chain behind
    // it and re-read as quiet — so at most one paid turn fires.
    await Promise.all([evaluateBriefGate(), evaluateBriefGate(), evaluateBriefGate()]);

    expect(requests).toHaveLength(1);
  });

  test("fail-closed: a non-board turn result keeps the prior board, no advance, no throw", async () => {
    await seedMinds();
    const rooms = createFileRoomStore(roomsDir());
    await rooms.saveRoom(makeRoom({ slug: "r-done", status: "done" }));
    const { sm, lastBoard } = fakeSnapshotManager();
    // The turn returns a non-board JSON (a table view) — expectView rejects it.
    const { run, requests } = scriptedRunAgentTurn([
      { text: JSON.stringify({ view: "table", columns: [{ key: "a" }], rows: [] }) },
    ]);
    rib.registerTools?.(makeCtx(run, sm));
    await waitFor(() => lastBoard() !== undefined);

    await expect(evaluateBriefGate()).resolves.toBeUndefined(); // never throws

    expect(requests).toHaveLength(1); // the turn ran
    // …but its bad output was dropped: no delta register reached the footer, the header
    // stays calm, and the watermark did NOT advance (a later valid turn can promote).
    expect(lastBoard()?.sections.some((s) => s.title === "Since you last looked")).toBe(false);
    expect(lastBoard()?.header?.status).toBeUndefined();
    const wm = await readWatermark(home);
    expect(wm.briefPromoted).toBe(false);
    expect(wm.ackedEndedRooms).toEqual([]);
  });

  test("tolerates a ```json-fenced board reply: still promotes (parse hardening)", async () => {
    await seedMinds();
    const rooms = createFileRoomStore(roomsDir());
    await rooms.saveRoom(makeRoom({ slug: "r-done", name: "Design Review", status: "done" }));
    const { sm, lastBoard } = fakeSnapshotManager();
    // A live model commonly wraps the JSON board in a markdown fence.
    const fenced = ["```json", JSON.stringify(briefBoard), "```"].join("\n");
    const { run, requests } = scriptedRunAgentTurn([{ text: fenced }]);
    rib.registerTools?.(makeCtx(run, sm));

    await evaluateBriefGate();

    expect(requests).toHaveLength(1);
    expect(lastBoard()?.header?.status?.label).toBe("1 new");
    expect(JSON.stringify(lastBoard())).toContain("A room just ended.");
    const wm = await readWatermark(home);
    expect(wm.ackedEndedRooms).toEqual(["r-done"]);
    expect(wm.briefPromoted).toBe(true);
  });

  test("tolerates a board reply with leading prose: still promotes (parse hardening)", async () => {
    await seedMinds();
    const rooms = createFileRoomStore(roomsDir());
    await rooms.saveRoom(makeRoom({ slug: "r-done", status: "done" }));
    const { sm, lastBoard } = fakeSnapshotManager();
    const { run, requests } = scriptedRunAgentTurn([
      { text: `Here is the briefing:\n${JSON.stringify(briefBoard)}` },
    ]);
    rib.registerTools?.(makeCtx(run, sm));

    await evaluateBriefGate();

    expect(requests).toHaveLength(1);
    expect(JSON.stringify(lastBoard())).toContain("A room just ended.");
    expect((await readWatermark(home)).briefPromoted).toBe(true);
  });

  test("fail-closed: an unparseable (non-JSON) reply keeps the prior board, no advance, no throw", async () => {
    await seedMinds();
    const rooms = createFileRoomStore(roomsDir());
    await rooms.saveRoom(makeRoom({ slug: "r-done", status: "done" }));
    const { sm, lastBoard } = fakeSnapshotManager();
    // Prose with no JSON object at all — nothing to recover, so the gate fails closed.
    const { run, requests } = scriptedRunAgentTurn([{ text: "Bob replies." }]);
    rib.registerTools?.(makeCtx(run, sm));
    await waitFor(() => lastBoard() !== undefined);

    await expect(evaluateBriefGate()).resolves.toBeUndefined();

    expect(requests).toHaveLength(1);
    // No delta register reached the footer; the watermark stayed cold.
    expect(lastBoard()?.sections.some((s) => s.title === "Since you last looked")).toBe(false);
    const wm = await readWatermark(home);
    expect(wm.briefPromoted).toBe(false);
    expect(wm.ackedEndedRooms).toEqual([]);
  });

  test("seam absent (no runAgentTurn) keeps quiet only — no turn, no publish path", async () => {
    await seedMinds();
    const rooms = createFileRoomStore(roomsDir());
    await rooms.saveRoom(makeRoom({ slug: "r-done", status: "done" }));
    // A ctx WITHOUT runAgentTurn: the brief publisher is not wired, so the gate
    // returns early. No throw, no turn (there's no run to call).
    const ctxNoTurn = {
      getExec: () => ({
        runJSON: async () => ({ ok: true as const, data: undefined }),
        runText: async () => ({ ok: true as const, data: "" }),
      }),
      getSnapshotManager: () => fakeSnapshotManager().sm,
      registerRegion: () => () => {},
    } as unknown as RibContext;
    rib.registerTools?.(ctxNoTurn);

    await expect(evaluateBriefGate()).resolves.toBeUndefined();
    // The watermark stays cold — the gate never advanced it.
    expect((await readWatermark(home)).briefPromoted).toBe(false);
  });

  test("a promote runs no roster workflow — the banner itself is the on-surface signal", async () => {
    // The merged Chamber panel carries no "for you" pulse (the Briefing banner sits
    // directly beneath it), so a promote must not spend a collector subprocess on the
    // off-surface roster view.
    await seedMinds();
    const rooms = createFileRoomStore(roomsDir());
    await rooms.saveRoom(makeRoom({ slug: "r-done", name: "Design Review", status: "done" }));
    const { sm } = fakeSnapshotManager();
    const { run } = scriptedRunAgentTurn([{ text: JSON.stringify(briefBoard) }]);
    const refreshed: string[] = [];
    rib.registerTools?.(
      makeCtx(run, sm, async (name) => {
        refreshed.push(name);
      }),
    );

    await evaluateBriefGate();

    expect((await readWatermark(home)).briefPromoted).toBe(true);
    expect(refreshed).not.toContain("chamber-roster");
  });

  test("a gate turn that settles after dispose() does not publish or advance the watermark", async () => {
    await seedMinds();
    const rooms = createFileRoomStore(roomsDir());
    await rooms.saveRoom(makeRoom({ slug: "r-done", status: "done" }));
    const { sm, published } = fakeSnapshotManager();
    // A turn held in flight until release(): dispose lands while it is parked, then it
    // settles "ok" — only the disposed guard can stop the late publish/write.
    const { run, started, release } = gatedRunAgentTurn(JSON.stringify(briefBoard));
    rib.registerTools?.(makeCtx(run, sm));

    const gate = evaluateBriefGate();
    await started;
    await rib.dispose?.();
    release();
    await gate;

    // No delta register was ever published — the post-dispose turn result was dropped.
    expect(
      published.some((b) =>
        (b as CanvasBoardView).sections?.some((s) => s.title === "Since you last looked"),
      ),
    ).toBe(false);
    const wm = await readWatermark(home);
    expect(wm.briefPromoted).toBe(false);
    expect(wm.ackedEndedRooms).toEqual([]);
  });

  test("a parked gate turn across dispose does not wedge a later boot's gate (no leaked chain)", async () => {
    await seedMinds();
    const rooms = createFileRoomStore(roomsDir());
    await rooms.saveRoom(makeRoom({ slug: "r-done", status: "done" }));
    // First boot: a turn held in flight and NEVER released (and the gated fake ignores
    // the abort signal) — the worst case for the serialization chain.
    const parked = gatedRunAgentTurn(JSON.stringify(briefBoard));
    rib.registerTools?.(makeCtx(parked.run, fakeSnapshotManager().sm));
    void evaluateBriefGate().catch(() => {});
    await parked.started;
    // dispose must detach the parked turn from briefInFlight (resetting the chain), or
    // the next boot's gate would serialize behind a promise that never settles. The
    // held turn is deliberately left UNreleased here — mirroring the real leak where a
    // turn's resolver is lost — so only the dispose-time chain reset can unwedge boot 2.
    await rib.dispose?.();

    // Fresh boot with a settled turn: the gate must run promptly, proving the chain was
    // not left parked. A 1s budget — a leaked chain would never resolve.
    const { sm } = fakeSnapshotManager();
    const { run, requests } = scriptedRunAgentTurn([{ text: JSON.stringify(briefBoard) }]);
    rib.registerTools?.(makeCtx(run, sm));
    await Promise.race([
      evaluateBriefGate(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("gate wedged")), 1000)),
    ]);
    expect(requests).toHaveLength(1);
    expect((await readWatermark(home)).briefPromoted).toBe(true);
    // Release the still-parked first turn now (cleanup): its captured signal is aborted,
    // so its post-turn re-check drops the late write — nothing is left unsettled.
    parked.release();
  });
});
