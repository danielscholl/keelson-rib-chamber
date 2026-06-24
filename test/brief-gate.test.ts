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
import rib, { evaluateBriefGate } from "../src/index.ts";
import { scaffoldMind } from "../src/minds-store.ts";
import { mindsDir, roomsDir, setChamberDataHome } from "../src/paths.ts";
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
    // The authored board reached the footer.
    expect(lastBoard()?.title).toBe("Chamber Briefing");
    // The watermark advanced: the ended room is acked and the brief is promoted.
    const wm = await readWatermark(home);
    expect(wm.ackedEndedRooms).toEqual(["r-done"]);
    expect(wm.briefPromoted).toBe(true);
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
    // The promote published the authored briefing board (the trailing chained re-eval
    // then lapses to quiet — the promote itself is what we assert here).
    expect(published.some((b) => (b as CanvasBoardView).title === "Chamber Briefing")).toBe(true);
    // The promote advanced the watermark to ack the lens fingerprint.
    const wm = await readWatermark(home);
    expect(Object.keys(wm.lensFingerprints)).toContain("findings");
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
    // The promoted brief lapses back to quiet (republished, flag cleared).
    expect(lastBoard()?.header?.status?.label).toBe("Quiet");
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
    const seeded = lastBoard(); // the quiet seed
    expect(seeded?.header?.status?.label).toBe("Quiet");

    await expect(evaluateBriefGate()).resolves.toBeUndefined(); // never throws

    expect(requests).toHaveLength(1); // the turn ran
    // …but its bad output was dropped: the footer still shows the seeded quiet board.
    expect(lastBoard()).toEqual(seeded);
    // And the watermark did NOT advance, so a later valid turn can still promote.
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
    expect(lastBoard()?.title).toBe("Chamber Briefing");
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
    expect(lastBoard()?.title).toBe("Chamber Briefing");
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
    const seeded = lastBoard();
    expect(seeded?.header?.status?.label).toBe("Quiet");

    await expect(evaluateBriefGate()).resolves.toBeUndefined();

    expect(requests).toHaveLength(1);
    expect(lastBoard()).toEqual(seeded);
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

  test("a promote refreshes the roster pulse so its 'For you' tracks briefPromoted", async () => {
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
    // The just-set briefPromoted must reach the roster pulse without the 120s cadence.
    expect(refreshed).toContain("chamber-roster");
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

    // The only published board is the boot quiet seed — the post-dispose result was dropped.
    expect(published.some((b) => (b as CanvasBoardView).title === "Chamber Briefing")).toBe(false);
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
