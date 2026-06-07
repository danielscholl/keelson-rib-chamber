import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CanvasView,
  RibAction,
  RibActionResult,
  RibContext,
  SnapshotManager,
} from "@keelson/shared";
import type { RunAgentTurn } from "../src/agent-turn.ts";
import rib from "../src/index.ts";
import { scaffoldMind } from "../src/minds-store.ts";
import { mindsDir, roomsDir } from "../src/paths.ts";
import { createFileRoomStore } from "../src/room-store.ts";
import type { Room } from "../src/types.ts";
import { scriptedRunAgentTurn } from "./helpers/fakes.ts";

const onAction = rib.onAction;
const registerTools = rib.registerTools;
if (!onAction || !registerTools) throw new Error("rib is missing onAction/registerTools");

// A SnapshotManager double that runs the registered composer on recompose and
// validates it exactly as the real one does, so a published board is proven
// renderable end-to-end. Records registrations/recomposes and keeps the last
// validated board for assertions.
function fakeSnapshotManager() {
  const composers = new Map<string, () => unknown>();
  const validators = new Map<string, (d: unknown) => unknown>();
  const registered: string[] = [];
  const recomposed: string[] = [];
  let lastBoard: CanvasView | undefined;
  const sm = {
    register(
      key: string,
      compose: () => unknown,
      opts?: { validate?: (d: unknown) => unknown },
    ): () => void {
      registered.push(key);
      composers.set(key, compose);
      if (opts?.validate) validators.set(key, opts.validate);
      return () => {
        composers.delete(key);
        validators.delete(key);
      };
    },
    async recompose(key: string) {
      recomposed.push(key);
      const compose = composers.get(key);
      if (!compose) return undefined;
      const raw = await compose();
      const data = (validators.get(key)?.(raw) ?? raw) as CanvasView;
      lastBoard = data;
      return {
        type: "snapshot_update" as const,
        key,
        version: recomposed.length,
        composedAt: "",
        data,
      };
    },
    latest: () => undefined,
    keys: () => [...composers.keys()],
    dispose: async () => {},
  } as unknown as SnapshotManager;
  return { sm, registered, recomposed, lastBoard: () => lastBoard };
}

function makeCtx(opts: { run?: RunAgentTurn; sm?: SnapshotManager } = {}): RibContext {
  return {
    getExec: () => ({
      runJSON: async <T>() => ({ ok: true as const, data: undefined as T }),
      runText: async () => ({ ok: true as const, data: "" }),
    }),
    ...(opts.sm ? { getSnapshotManager: () => opts.sm } : {}),
    ...(opts.run ? { runAgentTurn: opts.run } : {}),
  } as RibContext;
}

async function waitFor(pred: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitFor timed out");
}

const startPayload = (over: Record<string, unknown> = {}): RibAction => ({
  type: "room-start",
  payload: { participants: ["alice", "bob"], turnBudget: 2, ...over },
});

// room-start assigns a fresh slug server-side; read it back from the result.
function slugOf(res: RibActionResult): string {
  return res.ok ? ((res.data as { slug?: string })?.slug ?? "") : "";
}

let workspace: string;
let prevWorkspace: string | undefined;
beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "chamber-ws-"));
  prevWorkspace = process.env.KEELSON_WORKSPACE;
  process.env.KEELSON_WORKSPACE = workspace;
  const at = "2026-01-01T00:00:00.000Z";
  await scaffoldMind(
    mindsDir(),
    {
      slug: "alice",
      name: "Alice",
      role: "skeptic",
      voice: "terse",
      persona: "You are Alice.",
      createdAt: at,
    },
    "Alice's soul.",
  );
  await scaffoldMind(
    mindsDir(),
    {
      slug: "bob",
      name: "Bob",
      role: "builder",
      voice: "warm",
      persona: "You are Bob.",
      createdAt: at,
    },
    "Bob's soul.",
  );
});
afterAll(async () => {
  if (prevWorkspace === undefined) delete process.env.KEELSON_WORKSPACE;
  else process.env.KEELSON_WORKSPACE = prevWorkspace;
  await rm(workspace, { recursive: true, force: true });
});

// Runs first, before the driver is ever built — exercises the fail-closed path.
describe("room adapter — fails closed without the seams", () => {
  it("does not register the room snapshot or build the driver when runAgentTurn is absent", async () => {
    const { sm, registered } = fakeSnapshotManager();
    expect(registerTools(makeCtx({ sm }))).toEqual([]); // no chat tools
    expect(registered).not.toContain("rib:chamber:room");
    const res = await onAction(startPayload(), makeCtx({ sm }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("require the C1 agent-turn seam");
  });
});

describe("room adapter — live room", () => {
  let snap: ReturnType<typeof fakeSnapshotManager>;
  beforeAll(() => {
    const { run } = scriptedRunAgentTurn([{ text: "Alice speaks." }, { text: "Bob replies." }]);
    snap = fakeSnapshotManager();
    registerTools(makeCtx({ run, sm: snap.sm }));
  });

  it("registers and primes the push-fed room snapshot at boot", () => {
    expect(snap.registered).toContain("rib:chamber:room");
    // Primed once at registration so a subscriber gets the seed, not a skeleton.
    expect(snap.recomposed).toContain("rib:chamber:room");
  });

  it("auto-advances the room to done, streaming each turn to the canvas", async () => {
    const store = createFileRoomStore(roomsDir());
    const res = await onAction(startPayload(), makeCtx({ sm: snap.sm }));
    const slug = slugOf(res);
    expect(slug).toMatch(/^room-/); // server-assigned fresh slug

    await waitFor(async () => (await store.loadRoom(slug))?.status === "done");

    const transcript = await store.loadTranscript(slug);
    expect(transcript).toHaveLength(2);
    expect(transcript.map((e) => e.from)).toEqual(["alice", "bob"]);
    // The loop published a valid board on start + each turn (live WS push).
    expect(snap.recomposed.filter((k) => k === "rib:chamber:room").length).toBeGreaterThanOrEqual(
      3,
    );
    expect(snap.lastBoard()?.view).toBe("board");
  });

  it("a second start opens a fresh room under a new slug", async () => {
    const store = createFileRoomStore(roomsDir());
    const first = slugOf(await onAction(startPayload(), makeCtx({ sm: snap.sm })));
    await waitFor(async () => (await store.loadRoom(first))?.status === "done");
    const second = slugOf(await onAction(startPayload(), makeCtx({ sm: snap.sm })));
    expect(second).not.toBe(first); // never reuses the slug
    await waitFor(async () => (await store.loadRoom(second))?.status === "done");
    // Each run is its own fresh 2-turn room — the new one isn't contaminated.
    expect(await store.loadTranscript(second)).toHaveLength(2);
  });

  it("room-stop halts an active room", async () => {
    const store = createFileRoomStore(roomsDir());
    await store.saveRoom({
      slug: "stoptest",
      name: "Stop",
      strategy: "sequential",
      participants: ["alice", "bob"],
      status: "active",
      turnBudget: 99,
      turnIndex: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
    } satisfies Room);
    const res = await onAction(
      { type: "room-stop", payload: { slug: "stoptest" } },
      makeCtx({ sm: snap.sm }),
    );
    expect(res).toEqual({ ok: true, data: { slug: "stoptest" } });
    expect((await store.loadRoom("stoptest"))?.status).toBe("stopped");
  });

  it("rejects a room-start with no participants", async () => {
    const res = await onAction(startPayload({ participants: [] }), makeCtx({ sm: snap.sm }));
    expect(res.ok).toBe(false);
  });

  it("rejects a room-start with a blank/unsafe participant slug", async () => {
    expect(
      (await onAction(startPayload({ participants: [""] }), makeCtx({ sm: snap.sm }))).ok,
    ).toBe(false);
    expect(
      (await onAction(startPayload({ participants: ["../x"] }), makeCtx({ sm: snap.sm }))).ok,
    ).toBe(false);
  });

  it("rejects a room-start with an out-of-range turnBudget", async () => {
    expect(
      (await onAction(startPayload({ turnBudget: 10_000 }), makeCtx({ sm: snap.sm }))).ok,
    ).toBe(false);
    expect((await onAction(startPayload({ turnBudget: 0 }), makeCtx({ sm: snap.sm }))).ok).toBe(
      false,
    );
  });

  it("rejects a path-traversal slug on a room control", async () => {
    // room-start assigns its own slug; the slug-bearing controls are the ones to
    // guard at the action boundary.
    const res = await onAction(
      { type: "room-stop", payload: { slug: "../../etc" } },
      makeCtx({ sm: snap.sm }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("unsafe room slug");
  });

  it("rejects a slug-less room control (fails closed under fresh slugs)", async () => {
    for (const type of ["room-stop", "room-inject"]) {
      const res = await onAction({ type, payload: {} }, makeCtx({ sm: snap.sm }));
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toContain("requires payload { slug }");
    }
  });

  // Must run last: dispose() flips module-global state so the loop stops driving.
  it("dispose halts the loop so a later start does not advance", async () => {
    await rib.dispose?.();
    const store = createFileRoomStore(roomsDir());
    const res = await onAction(startPayload(), makeCtx({ sm: snap.sm }));
    const slug = slugOf(res);
    expect(slug).toMatch(/^room-/);
    await new Promise((r) => setTimeout(r, 30));
    // The room was opened but the disposed loop never stepped it.
    expect((await store.loadRoom(slug))?.turnIndex).toBe(0);
  });
});
