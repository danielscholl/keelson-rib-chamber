import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
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
import { chamberDataHome, mindsDir, roomsDir, setChamberDataHome } from "../src/paths.ts";
import { clearDraft, readDraftExclusion } from "../src/room-draft.ts";
import { createFileRoomStore, DEFAULT_CLOSED_ROOM_RETENTION } from "../src/room-store.ts";
import type { Room } from "../src/types.ts";
import { gatedRunAgentTurn, scriptedRunAgentTurn } from "./helpers/fakes.ts";

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

function makeCtx(
  opts: { run?: RunAgentTurn; sm?: SnapshotManager; projects?: RibContext["getProjects"] } = {},
): RibContext {
  return {
    getExec: () => ({
      runJSON: async <T>() => ({ ok: true as const, data: undefined as T }),
      runText: async () => ({ ok: true as const, data: "" }),
    }),
    // Lenses need both the snapshot manager and registerRegion; supply a no-op
    // registrar with the manager so the lens tool wires up.
    ...(opts.sm ? { getSnapshotManager: () => opts.sm, registerRegion: () => () => {} } : {}),
    ...(opts.run ? { runAgentTurn: opts.run } : {}),
    ...(opts.projects ? { getProjects: opts.projects } : {}),
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
beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "chamber-ws-"));
  setChamberDataHome(join(workspace, "chamber"));
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
  // A moderator Mind for group-chat — a roster member that is never a participant.
  await scaffoldMind(
    mindsDir(),
    {
      slug: "mod",
      name: "Mod",
      role: "moderator",
      voice: "neutral",
      persona: "You are Mod.",
      createdAt: at,
    },
    "Mod's soul.",
  );
});
afterAll(async () => {
  setChamberDataHome(undefined);
  await rm(workspace, { recursive: true, force: true });
});

// Runs first, before the driver is ever built — exercises the fail-closed path.
describe("room adapter — fails closed without the seams", () => {
  it("does not register the room snapshot or build the driver when runAgentTurn is absent", async () => {
    const { sm, registered } = fakeSnapshotManager();
    // The driver-free seams — genesis + digest (writes), the read-only list tools, the
    // retire-mind/delete-room cleanup tools, and lens (publish, given the snapshot +
    // registerRegion seams makeCtx supplies) — wire up without runAgentTurn; the
    // room-control tools additionally need it.
    expect(
      registerTools(makeCtx({ sm }))
        .map((t) => t.name)
        .sort(),
    ).toEqual(
      [
        "chamber_room_delete",
        "chamber_emit_digest",
        "chamber_emit_genesis",
        "chamber_emit_lens",
        "chamber_emit_lens_html",
        "chamber_list_lenses",
        "chamber_list_minds",
        "chamber_list_rooms",
        "chamber_retire_lens",
        "chamber_retire_mind",
      ].sort(),
    );
    expect(registered.some((k) => k.startsWith("rib:chamber:room"))).toBe(false);
    const res = await onAction(startPayload(), makeCtx({ sm }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("require the C1 agent-turn seam");
    // room-open caches into the snapshot manager captured on the room path, so it
    // fails closed identically before the driver is built.
    const open = await onAction(
      { type: "room-open", payload: { slug: "anything" } },
      makeCtx({ sm }),
    );
    expect(open.ok).toBe(false);
    if (!open.ok) expect(open.error).toContain("require the C1 agent-turn seam");
  });
});

describe("room adapter — room-delete", () => {
  // A gated driver so a started room stays "active" (its first turn never settles)
  // — the deterministic way to exercise the active-room delete guard.
  let snap: ReturnType<typeof fakeSnapshotManager>;
  let gate: ReturnType<typeof gatedRunAgentTurn>;
  beforeAll(() => {
    gate = gatedRunAgentTurn("held");
    snap = fakeSnapshotManager();
    registerTools(makeCtx({ run: gate.run, sm: snap.sm }));
  });
  afterAll(async () => {
    // Let any in-flight gated turn settle, then reset the shared module state the
    // later "live room" block relies on (it registers a fresh scripted driver).
    gate.release();
    await rib.dispose?.();
  });

  // Seed a closed room straight to disk: it is never in the active set, so it is a
  // valid delete target without driving a live room.
  async function seedClosed(slug: string, status: "done" | "stopped" = "done"): Promise<void> {
    const store = createFileRoomStore(roomsDir());
    await store.saveRoom({
      slug,
      name: "Closed",
      strategy: "sequential",
      participants: ["alice", "bob"],
      status,
      turnBudget: 4,
      turnIndex: 4,
      round: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
    } satisfies Room);
  }

  it("deletes a closed room and returns { ok, data:{ slug } }; it no longer loads", async () => {
    const store = createFileRoomStore(roomsDir());
    await seedClosed("del-me");
    expect(await store.loadRoom("del-me")).toBeDefined();
    const res = await onAction({ type: "room-delete", payload: { slug: "del-me" } }, makeCtx());
    expect(res).toEqual({ ok: true, data: { slug: "del-me" } });
    expect(await store.loadRoom("del-me")).toBeUndefined();
  });

  it("fails closed with no slug (requires payload { slug })", async () => {
    const res = await onAction({ type: "room-delete", payload: {} }, makeCtx());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("requires payload { slug }");
  });

  it("fails closed on an unsafe / traversal slug (before any FS touch)", async () => {
    const res = await onAction({ type: "room-delete", payload: { slug: "../../etc" } }, makeCtx());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("unsafe room slug");
  });

  it("fails closed on a missing / already-deleted room (surfaces not-found, not success)", async () => {
    const res = await onAction({ type: "room-delete", payload: { slug: "ghost-room" } }, makeCtx());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("not found");
  });

  it("rejects deleting an ACTIVE room and leaves it intact", async () => {
    const store = createFileRoomStore(roomsDir());
    // Start a real room; the gated turn keeps it "active" on disk.
    const res = await onAction(startPayload({ turnBudget: 4 }), makeCtx({ sm: snap.sm }));
    const slug = slugOf(res);
    expect(slug).toMatch(/^room-/);
    await waitFor(async () => (await store.loadRoom(slug))?.status === "active");

    const del = await onAction({ type: "room-delete", payload: { slug } }, makeCtx());
    expect(del.ok).toBe(false);
    if (!del.ok) expect(del.error).toBe("stop the room before deleting it");
    // The live room (and its dir) is untouched — never deleted from under the driver.
    expect((await store.loadRoom(slug))?.status).toBe("active");

    // Clean up: stop it so the active set drains before the next block.
    await onAction({ type: "room-stop", payload: { slug } }, makeCtx({ sm: snap.sm }));
  });
});

describe("room adapter — room-open", () => {
  let snap: ReturnType<typeof fakeSnapshotManager>;
  beforeAll(() => {
    const { run } = scriptedRunAgentTurn([{ text: "noop" }]);
    snap = fakeSnapshotManager();
    registerTools(makeCtx({ run, sm: snap.sm }));
  });
  afterAll(async () => {
    await rib.dispose?.();
  });

  // Seed a closed room AND a transcript turn straight to disk — a valid Open target
  // without driving a live room.
  async function seedClosedWithTurn(slug: string, name: string): Promise<void> {
    const store = createFileRoomStore(roomsDir());
    await store.saveRoom({
      slug,
      name,
      strategy: "sequential",
      participants: ["alice", "bob"],
      status: "done",
      turnBudget: 2,
      turnIndex: 2,
      round: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
    } satisfies Room);
    await store.appendTranscript(slug, {
      messageId: "m1",
      roomSlug: slug,
      turnIndex: 0,
      from: "alice",
      role: "agent",
      parts: [{ text: "Hello from the past." }],
      at: "2026-01-01T00:00:01.000Z",
    });
  }

  it("opens a closed room: returns open-canvas over the room's per-slug view key and seeds its board", async () => {
    await seedClosedWithTurn("open-me", "Q3 priorities");
    const res = await onAction({ type: "room-open", payload: { slug: "open-me" } }, makeCtx());
    expect(res).toEqual({
      ok: true,
      data: { effect: "open-canvas", key: "rib:chamber:room-view:open-me", title: "Q3 priorities" },
    });
    // The viewer key was registered (snapshot-only) and recomposed, and the cached
    // board is the room's transcript board — proven renderable by the fake's validate.
    expect(snap.registered).toContain("rib:chamber:room-view:open-me");
    expect(snap.recomposed).toContain("rib:chamber:room-view:open-me");
    const opened = snap.lastBoard();
    expect(opened?.view).toBe("board");
    if (opened?.view === "board") expect(opened.title).toBe("Q3 priorities");
    expect(JSON.stringify(opened)).toContain("Hello from the past.");
  });

  it("reuses a slug's view key across re-opens (registered once per slug, recomposed each time)", async () => {
    await seedClosedWithTurn("reopen-me", "Reopen");
    const key = "rib:chamber:room-view:reopen-me";
    await onAction({ type: "room-open", payload: { slug: "reopen-me" } }, makeCtx());
    const before = snap.recomposed.filter((k) => k === key).length;
    const res = await onAction({ type: "room-open", payload: { slug: "reopen-me" } }, makeCtx());
    expect(res.ok).toBe(true);
    // One registration total for that slug's key, a fresh recompose per open.
    expect(snap.registered.filter((k) => k === key)).toHaveLength(1);
    expect(snap.recomposed.filter((k) => k === key).length).toBe(before + 1);
  });

  it("opening two different closed rooms yields two independent keys/boards that don't clobber each other", async () => {
    await seedClosedWithTurn("room-a", "Alpha");
    await seedClosedWithTurn("room-b", "Beta");
    const keyA = "rib:chamber:room-view:room-a";
    const keyB = "rib:chamber:room-view:room-b";

    const resA = await onAction({ type: "room-open", payload: { slug: "room-a" } }, makeCtx());
    const resB = await onAction({ type: "room-open", payload: { slug: "room-b" } }, makeCtx());
    expect(resA.ok && (resA.data as { key: string }).key).toBe(keyA);
    expect(resB.ok && (resB.data as { key: string }).key).toBe(keyB);
    expect(keyA).not.toBe(keyB);
    expect(snap.registered).toContain(keyA);
    expect(snap.registered).toContain(keyB);

    // Recomposing A's key AFTER B was opened still yields A's board — the boards are
    // keyed per-room, so opening B can't clobber the board A's drawer subscribes to.
    const boardA = await snap.sm.recompose(keyA);
    const boardB = await snap.sm.recompose(keyB);
    const titleOf = (frame: unknown) => {
      const data = (frame as { data?: CanvasView } | undefined)?.data;
      return data?.view === "board" ? data.title : undefined;
    };
    expect(titleOf(boardA)).toBe("Alpha");
    expect(titleOf(boardB)).toBe("Beta");
  });

  it("fails closed on a missing slug, an unsafe slug, and an unknown room", async () => {
    const noSlug = await onAction({ type: "room-open", payload: {} }, makeCtx());
    expect(noSlug.ok).toBe(false);
    if (!noSlug.ok) expect(noSlug.error).toContain("requires payload { slug }");

    const unsafe = await onAction({ type: "room-open", payload: { slug: "../../etc" } }, makeCtx());
    expect(unsafe.ok).toBe(false);
    if (!unsafe.ok) expect(unsafe.error).toContain("unsafe room slug");

    const ghost = await onAction({ type: "room-open", payload: { slug: "ghost-room" } }, makeCtx());
    expect(ghost.ok).toBe(false);
    if (!ghost.ok) expect(ghost.error).toContain("not found");
  });
});

describe("room adapter — convene composer (draft-set + convene)", () => {
  let snap: ReturnType<typeof fakeSnapshotManager>;
  beforeAll(() => {
    const { run } = scriptedRunAgentTurn([{ text: "Alice speaks." }, { text: "Bob replies." }]);
    snap = fakeSnapshotManager();
    registerTools(makeCtx({ run, sm: snap.sm }));
  });
  beforeEach(async () => {
    await clearDraft(); // start each case from all-selected
  });
  afterAll(async () => {
    await clearDraft();
    await rib.dispose?.(); // reset module-global state for the live-room block
  });

  it("draft-set toggles a Mind into and out of the exclusion set", async () => {
    const off = await onAction({ type: "draft-set", payload: { slug: "alice" } }, makeCtx());
    expect(off.ok).toBe(true);
    if (off.ok) expect((off.data as { excluded: string[] }).excluded).toEqual(["alice"]);
    expect([...(await readDraftExclusion())]).toEqual(["alice"]);
    // Toggling the same slug again clears it (back to all-selected).
    const on = await onAction({ type: "draft-set", payload: { slug: "alice" } }, makeCtx());
    expect(on.ok).toBe(true);
    if (on.ok) expect((on.data as { excluded: string[] }).excluded).toEqual([]);
    expect([...(await readDraftExclusion())]).toEqual([]);
  });

  it("draft-set fails closed on a slug that is not a current Mind", async () => {
    const res = await onAction({ type: "draft-set", payload: { slug: "ghost" } }, makeCtx());
    expect(res.ok).toBe(false);
    // The unknown slug never lands in the draft.
    expect([...(await readDraftExclusion())]).toEqual([]);
  });

  it("draft-set fails closed on an unsafe/reserved slug and on a missing slug", async () => {
    expect((await onAction({ type: "draft-set", payload: { slug: "../x" } }, makeCtx())).ok).toBe(
      false,
    );
    expect(
      (await onAction({ type: "draft-set", payload: { slug: "director" } }, makeCtx())).ok,
    ).toBe(false);
    expect((await onAction({ type: "draft-set", payload: {} }, makeCtx())).ok).toBe(false);
    expect([...(await readDraftExclusion())]).toEqual([]);
  });

  it("convene with the default (empty) draft starts a room with all Minds", async () => {
    const store = createFileRoomStore(roomsDir());
    const res = await onAction({ type: "convene" }, makeCtx({ sm: snap.sm }));
    const slug = slugOf(res);
    expect(slug).toMatch(/^room-/);
    await waitFor(async () => (await store.loadRoom(slug))?.status === "done");
    // All current Minds (alice, bob, mod) minus an empty exclusion = every Mind.
    // readMinds orders by createdAt (equal here), so assert the set, not the order.
    expect([...((await store.loadRoom(slug))?.participants ?? [])].sort()).toEqual([
      "alice",
      "bob",
      "mod",
    ]);
  });

  it("convene resolves participants as all-minus-excluded and clears the draft on success", async () => {
    const store = createFileRoomStore(roomsDir());
    // Exclude mod; the convened room must be exactly alice + bob.
    await onAction({ type: "draft-set", payload: { slug: "mod" } }, makeCtx());
    expect([...(await readDraftExclusion())]).toEqual(["mod"]);

    const res = await onAction(
      { type: "convene", payload: { topic: "hello" } },
      makeCtx({ sm: snap.sm }),
    );
    const slug = slugOf(res);
    expect(slug).toMatch(/^room-/);
    await waitFor(async () => (await store.loadRoom(slug))?.status === "done");
    expect([...((await store.loadRoom(slug))?.participants ?? [])].sort()).toEqual([
      "alice",
      "bob",
    ]);
    // A successful convene resets the draft back to all-selected.
    expect([...(await readDraftExclusion())]).toEqual([]);
  });

  it("convene fails closed at < 2 selected and leaves the draft intact", async () => {
    // Exclude alice and bob, leaving only mod selected — below the 2-speaker floor.
    await onAction({ type: "draft-set", payload: { slug: "alice" } }, makeCtx());
    await onAction({ type: "draft-set", payload: { slug: "bob" } }, makeCtx());
    const res = await onAction({ type: "convene" }, makeCtx({ sm: snap.sm }));
    expect(res.ok).toBe(false);
    // The draft is NOT cleared on failure — the operator's selection survives.
    expect([...(await readDraftExclusion())].sort()).toEqual(["alice", "bob"]);
  });
});

describe("room adapter — live room", () => {
  let snap: ReturnType<typeof fakeSnapshotManager>;
  beforeAll(() => {
    const { run } = scriptedRunAgentTurn([{ text: "Alice speaks." }, { text: "Bob replies." }]);
    snap = fakeSnapshotManager();
    registerTools(makeCtx({ run, sm: snap.sm }));
  });

  it("registers no room snapshot at boot — keys are per-slug, registered on start", () => {
    // The room board moved from one fixed rib:chamber:room key to a per-slug key
    // (rib:chamber:room:<slug>) registered the first time a room publishes, so nothing
    // is registered until a room starts.
    expect(snap.registered.some((k) => k.startsWith("rib:chamber:room"))).toBe(false);
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
    // The room registered its per-slug key and published a valid board on start +
    // each turn (live WS push).
    const key = `rib:chamber:room:${slug}`;
    expect(snap.registered).toContain(key);
    expect(snap.recomposed.filter((k) => k === key).length).toBeGreaterThanOrEqual(3);
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
      round: 0,
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

  it("rejects a room-start with a blank/unsafe/reserved participant slug", async () => {
    expect(
      (await onAction(startPayload({ participants: [""] }), makeCtx({ sm: snap.sm }))).ok,
    ).toBe(false);
    expect(
      (await onAction(startPayload({ participants: ["../x"] }), makeCtx({ sm: snap.sm }))).ok,
    ).toBe(false);
    // "director"/"system" are reserved driver roles, never speakers.
    expect(
      (await onAction(startPayload({ participants: ["director"] }), makeCtx({ sm: snap.sm }))).ok,
    ).toBe(false);
  });

  it("de-dupes participants on start", async () => {
    const store = createFileRoomStore(roomsDir());
    const slug = slugOf(
      await onAction(
        startPayload({ participants: ["alice", "bob", "alice"] }),
        makeCtx({ sm: snap.sm }),
      ),
    );
    await waitFor(async () => (await store.loadRoom(slug))?.status === "done");
    expect((await store.loadRoom(slug))?.participants).toEqual(["alice", "bob"]);
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

  it("auto-advances a group-chat room: the moderator routes and it reaches done", async () => {
    const store = createFileRoomStore(roomsDir());
    // The shared scripts carry no routing JSON, so the moderator's reply parses to
    // no decision and the driver routes by nextUnheard — enough to prove the
    // moderate flow is wired end-to-end (moderator turn, then a participant turn).
    const res = await onAction(
      startPayload({ strategy: "group-chat", moderator: "mod", turnBudget: 2 }),
      makeCtx({ sm: snap.sm }),
    );
    const slug = slugOf(res);
    expect(slug).toMatch(/^room-/);
    await waitFor(async () => (await store.loadRoom(slug))?.status === "done");
    const transcript = await store.loadTranscript(slug);
    expect(transcript).toHaveLength(2);
    expect(transcript[0]?.from).toBe("mod"); // the moderator turn ran first
    expect(["alice", "bob"]).toContain(transcript[1]?.from ?? ""); // routed to a participant
  });

  it("rejects a group-chat start without a moderator", async () => {
    const res = await onAction(startPayload({ strategy: "group-chat" }), makeCtx({ sm: snap.sm }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("moderator");
  });

  it("rejects a group-chat moderator that is also a participant", async () => {
    const res = await onAction(
      startPayload({ strategy: "group-chat", moderator: "alice" }),
      makeCtx({ sm: snap.sm }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("must not also be a participant");
  });

  it("rejects a group-chat moderator that is not a known Mind", async () => {
    const res = await onAction(
      startPayload({ strategy: "group-chat", moderator: "ghost" }),
      makeCtx({ sm: snap.sm }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("unknown moderator");
  });

  it("auto-advances an open-floor room: speakers rotate via leastSpoken to done", async () => {
    const store = createFileRoomStore(roomsDir());
    // The shared scripts carry no nomination JSON, so each reply parses to no
    // nomination and the driver routes by leastSpoken — proving the open-floor flow
    // is wired end-to-end (seed, then rotate) with no moderator.
    const res = await onAction(
      startPayload({ strategy: "open-floor", turnBudget: 2 }),
      makeCtx({ sm: snap.sm }),
    );
    const slug = slugOf(res);
    expect(slug).toMatch(/^room-/);
    await waitFor(async () => (await store.loadRoom(slug))?.status === "done");
    const transcript = await store.loadTranscript(slug);
    expect(transcript.map((e) => e.from)).toEqual(["alice", "bob"]);
  });

  it("rejects an open-floor start with a moderator", async () => {
    const res = await onAction(
      startPayload({ strategy: "open-floor", moderator: "mod" }),
      makeCtx({ sm: snap.sm }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("no moderator");
  });

  it("auto-advances a concurrent room: all participants speak in one parallel round to done", async () => {
    const store = createFileRoomStore(roomsDir());
    // turnBudget 2 with two participants = exactly one parallel round (a, b), proving
    // concurrent is wired end-to-end through registerTools/onAction and the pump.
    const res = await onAction(
      startPayload({ strategy: "concurrent", turnBudget: 2 }),
      makeCtx({ sm: snap.sm }),
    );
    const slug = slugOf(res);
    expect(slug).toMatch(/^room-/);
    await waitFor(async () => (await store.loadRoom(slug))?.status === "done");
    const transcript = await store.loadTranscript(slug);
    expect(transcript).toHaveLength(2);
    expect(transcript.map((e) => e.from)).toEqual(["alice", "bob"]); // participant order
  });

  it("prunes old closed room dirs after a fresh room loop completes", async () => {
    const store = createFileRoomStore(roomsDir());
    const oldSlugs = Array.from(
      { length: DEFAULT_CLOSED_ROOM_RETENTION + 5 },
      (_, i) => `old-closed-${i.toString().padStart(2, "0")}`,
    );
    const oldest = oldSlugs[0];
    if (!oldest) throw new Error("expected seeded room slugs");
    for (const [i, slug] of oldSlugs.entries()) {
      await store.saveRoom({
        slug,
        name: `Old ${i}`,
        strategy: "sequential",
        participants: ["alice", "bob"],
        status: i % 2 === 0 ? "done" : "stopped",
        turnBudget: 1,
        turnIndex: 1,
        round: 0,
        createdAt: `2025-01-${(i + 1).toString().padStart(2, "0")}T00:00:00.000Z`,
      } satisfies Room);
    }

    const slug = slugOf(await onAction(startPayload({ turnBudget: 1 }), makeCtx({ sm: snap.sm })));
    expect(slug).toMatch(/^room-/);
    await waitFor(async () => (await store.loadRoom(slug))?.status === "done");
    await waitFor(async () => (await store.loadRoom(oldest)) === undefined);

    expect(await store.loadRoom(oldest)).toBeUndefined();
    expect((await store.loadRoom(slug))?.status).toBe("done");
    expect(await store.loadTranscript(slug)).toHaveLength(1);
  });

  // Must run last: dispose() flips module-global state so the loop stops driving.
  it("refuses a room-start after dispose (no phantom active room)", async () => {
    await rib.dispose?.();
    const res = await onAction(startPayload(), makeCtx({ sm: snap.sm }));
    // startRoom checks driver.isDisposed() — a start after dispose would otherwise
    // write an "active" room whose loop never runs and never clears.
    expect(res.ok).toBe(false);
  });
});

describe("room adapter — project targeting", () => {
  const PROJECT = {
    id: "p1",
    name: "Alpha",
    rootPath: "/repos/alpha",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const projects = () => [PROJECT];
  // The briefing gate fires its own agent turn (through the same scripted run) when a
  // room ends, so filter requests to the room's SPEAKER turns — the ones whose system
  // is a participant's scaffolded soul — before asserting their cwd.
  const SOULS = new Set(["Alice's soul.", "Bob's soul."]);
  const roomTurnsSince = (before: number) =>
    turns.requests
      .slice(before)
      // A room speaking turn's system is the COMPOSED identity (soul + memory + rules),
      // so it EMBEDS a known soul rather than equalling it. It is also NOT the close-only
      // reflection pass — which runs in-character too but withholds tools (allowedTools:
      // []) and runs at the neutral home, not the project root.
      .filter(
        (r) => [...SOULS].some((s) => (r.system ?? "").includes(s)) && r.allowedTools === undefined,
      );
  let snap: ReturnType<typeof fakeSnapshotManager>;
  let turns: ReturnType<typeof scriptedRunAgentTurn>;
  beforeAll(() => {
    turns = scriptedRunAgentTurn([{ text: "Alice speaks." }, { text: "Bob replies." }]);
    snap = fakeSnapshotManager();
    registerTools(makeCtx({ run: turns.run, sm: snap.sm, projects }));
  });
  afterAll(async () => {
    await rib.dispose?.();
  });

  it("targets a room at a project: persists projectId and runs every turn at the project root", async () => {
    const store = createFileRoomStore(roomsDir());
    const before = turns.requests.length;
    const slug = slugOf(
      await onAction(startPayload({ projectId: "p1" }), makeCtx({ sm: snap.sm, projects })),
    );
    expect(slug).toMatch(/^room-/);
    await waitFor(async () => (await store.loadRoom(slug))?.status === "done");
    expect((await store.loadRoom(slug))?.projectId).toBe("p1");
    const reqs = roomTurnsSince(before);
    expect(reqs.length).toBeGreaterThanOrEqual(1);
    expect(reqs.every((r) => r.cwd === "/repos/alpha")).toBe(true);
  });

  it("fails closed on an unknown projectId — validated at start, before any turn", async () => {
    const before = turns.requests.length;
    const res = await onAction(
      startPayload({ projectId: "ghost" }),
      makeCtx({ sm: snap.sm, projects }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('unknown project "ghost"');
    // No turn was ever invoked — the fail-closed gate is before driver.start.
    expect(turns.requests.length).toBe(before);
  });

  it("an untargeted room keeps the neutral data-home cwd", async () => {
    const store = createFileRoomStore(roomsDir());
    const before = turns.requests.length;
    const slug = slugOf(await onAction(startPayload(), makeCtx({ sm: snap.sm, projects })));
    await waitFor(async () => (await store.loadRoom(slug))?.status === "done");
    expect((await store.loadRoom(slug))?.projectId).toBeUndefined();
    const reqs = roomTurnsSince(before);
    expect(reqs.length).toBeGreaterThanOrEqual(1);
    expect(reqs.every((r) => r.cwd === chamberDataHome())).toBe(true);
  });
});

describe("room adapter — outcome-copy / outcome-explore", () => {
  // Neither action touches the driver or a snapshot manager — both read the
  // room straight off disk — so a bare makeCtx() with no run/sm is enough.
  const OUTCOME_TEXT = [
    "**Q1 — Ship it. Pinned.**",
    "",
    "Agreed by all.",
    "",
    "---",
    "",
    "## Pinned Design — the synthesis",
    "",
    "**Q1 — Ship it.** Full agreement.",
    "",
    "### Acceptance criteria",
    "- It ships.",
  ].join("\n");

  async function seedRoomWithOutcome(slug: string): Promise<void> {
    const store = createFileRoomStore(roomsDir());
    await store.saveRoom({
      slug,
      name: "Outcome room",
      strategy: "sequential",
      participants: ["alice", "bob"],
      status: "done",
      turnBudget: 1,
      turnIndex: 1,
      round: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
    } satisfies Room);
    await store.appendTranscript(slug, {
      messageId: "m1",
      roomSlug: slug,
      turnIndex: 0,
      from: "bob",
      role: "agent",
      parts: [{ text: OUTCOME_TEXT }],
      at: "2026-01-01T00:05:00.000Z",
    });
  }

  it("outcome-copy returns the reconstructed markdown document verbatim", async () => {
    await seedRoomWithOutcome("copy-me");
    const res = await onAction({ type: "outcome-copy", payload: { slug: "copy-me" } }, makeCtx());
    expect(res).toEqual({
      ok: true,
      data: "## Pinned Design — the synthesis\n\n**Q1 — Ship it.** Full agreement.\n\n### Acceptance criteria\n- It ships.",
    });
  });

  it("outcome-explore opens a chat seeded with the document, named from its title", async () => {
    await seedRoomWithOutcome("explore-me");
    const res = await onAction(
      { type: "outcome-explore", payload: { slug: "explore-me" } },
      makeCtx(),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const data = res.data as { effect: string; seed: { systemPrompt: string; name: string } };
    expect(data.effect).toBe("open-chat");
    expect(data.seed.name).toBe("Pinned Design — the synthesis");
    expect(data.seed.systemPrompt).toContain("Outcome room");
    expect(data.seed.systemPrompt).toContain("Full agreement.");
    expect(data.seed.systemPrompt.length).toBeLessThanOrEqual(8000);
  });

  for (const type of ["outcome-copy", "outcome-explore"]) {
    it(`${type} fails closed on an unknown room`, async () => {
      const res = await onAction({ type, payload: { slug: "ghost-room" } }, makeCtx());
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toContain("not found");
    });

    it(`${type} fails closed on a room with no synthesized outcome yet`, async () => {
      const store = createFileRoomStore(roomsDir());
      await store.saveRoom({
        slug: "no-outcome",
        name: "No outcome",
        strategy: "sequential",
        participants: ["alice", "bob"],
        status: "active",
        turnBudget: 4,
        turnIndex: 1,
        round: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
      } satisfies Room);
      await store.appendTranscript("no-outcome", {
        messageId: "m1",
        roomSlug: "no-outcome",
        turnIndex: 0,
        from: "alice",
        role: "agent",
        parts: [{ text: "just ordinary debate, no document yet" }],
        at: "2026-01-01T00:00:01.000Z",
      });
      const res = await onAction({ type, payload: { slug: "no-outcome" } }, makeCtx());
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toContain("no synthesized outcome document yet");
    });

    it(`${type} requires payload { slug }`, async () => {
      const res = await onAction({ type, payload: {} }, makeCtx());
      expect(res.ok).toBe(false);
    });
  }
});
