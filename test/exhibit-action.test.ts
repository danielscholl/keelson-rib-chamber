import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageChunk, RibContext, SnapshotManager, ToolContext } from "@keelson/shared";
import type { RibAgentTurnResult, RunAgentTurn } from "../src/agent-turn.ts";
import rib from "../src/index.ts";
import { createFileLensStore, listLenses } from "../src/lens-store.ts";
import { scaffoldMind } from "../src/minds-store.ts";
import { lensesDir, mindsDir, setChamberDataHome } from "../src/paths.ts";

const onAction = rib.onAction;
if (!onAction) throw new Error("rib is missing onAction");
const registerTools = rib.registerTools;
if (!registerTools) throw new Error("rib is missing registerTools");

const board = (title: string) => ({ view: "board" as const, title, sections: [] });

// Mirrors lens-action.test.ts: a SnapshotManager double sufficient for the lens
// registry, so registerTools wires the real registry the exhibit verbs drive.
function fakeSnapshotManager(): SnapshotManager {
  const composers = new Map<string, () => unknown>();
  return {
    register(key: string, compose: () => unknown) {
      composers.set(key, compose);
      return () => composers.delete(key);
    },
    async recompose(key: string) {
      await composers.get(key)?.();
      return undefined;
    },
    latest: () => undefined,
    keys: () => [...composers.keys()],
    dispose: async () => {},
  } as unknown as SnapshotManager;
}

function makeCtx(sm: SnapshotManager): RibContext {
  return {
    getExec: () => ({
      runJSON: async () => ({ ok: true as const, data: undefined }),
      runText: async () => ({ ok: true as const, data: "" }),
    }),
    getSnapshotManager: () => sm,
    registerRegion: () => () => {},
  } as unknown as RibContext;
}

const actionCtx = {
  getExec: () => ({
    runJSON: async () => ({ ok: true as const, data: undefined }),
    runText: async () => ({ ok: true as const, data: "" }),
  }),
} as unknown as RibContext;

function makeToolCtx(roomSlug?: string) {
  const chunks: MessageChunk[] = [];
  const ctx: ToolContext = {
    cwd: ".",
    emit: (c) => chunks.push(c),
    abortSignal: new AbortController().signal,
    ...(roomSlug ? { turnContext: { roomSlug } } : {}),
  };
  return {
    ctx,
    out: () => chunks.map((c) => (c as { content?: string }).content ?? "").join(""),
    errored: () => chunks.some((c) => (c as { isError?: boolean }).isError === true),
  };
}

let workspace: string;
let tools: ReturnType<NonNullable<typeof rib.registerTools>>;

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "chamber-exhibit-action-"));
  setChamberDataHome(join(workspace, "chamber"));
});
afterAll(async () => {
  await rib.dispose?.();
  setChamberDataHome(undefined);
  await rm(workspace, { recursive: true, force: true });
});
beforeEach(async () => {
  // Fresh registry per test on a clean on-disk slate (see lens-action.test.ts).
  await rib.dispose?.();
  await rm(lensesDir(), { recursive: true, force: true });
  tools = registerTools(makeCtx(fakeSnapshotManager()));
});

function tool(name: string) {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`${name} not registered`);
  return t;
}

async function seedLens(id: string) {
  await createFileLensStore(lensesDir()).saveLens({ id, board: board(id) });
}
async function seedExhibit(id: string, sourceRoom?: string) {
  await createFileLensStore(lensesDir()).saveLens({
    id,
    board: board(id),
    kind: "exhibit",
    ...(sourceRoom ? { sourceRoom } : {}),
  });
}

describe("delete-exhibit onAction", () => {
  it("deletes an exhibit: returns ok + { id, key } and removes it from disk", async () => {
    await seedExhibit("assessment");
    const res = await onAction(
      { type: "delete-exhibit", payload: { id: "assessment" } },
      actionCtx,
    );
    expect(res).toEqual({
      ok: true,
      data: { id: "assessment", key: "rib:chamber:lens:assessment" },
    });
    expect((await listLenses(lensesDir())).some((l) => l.id === "assessment")).toBe(false);
  });

  it("refuses to delete a lens, steering to the Lenses verb", async () => {
    await seedLens("morning-brief");
    const res = await onAction(
      { type: "delete-exhibit", payload: { id: "morning-brief" } },
      actionCtx,
    );
    expect(res.ok).toBe(false);
    expect("error" in res && res.error).toMatch(/is a lens/);
    expect((await listLenses(lensesDir())).map((l) => l.id)).toEqual(["morning-brief"]);
  });

  it("fails closed on an unknown id", async () => {
    const res = await onAction({ type: "delete-exhibit", payload: { id: "ghost" } }, actionCtx);
    expect(res.ok).toBe(false);
    expect("error" in res && res.error).toMatch(/exhibit 'ghost' not found/);
  });

  it("is NOT reachable from an HTML-lens iframe (destructive verbs stay board-only)", async () => {
    await seedExhibit("assessment");
    const res = await onAction(
      { type: "delete-exhibit", payload: { id: "assessment" }, origin: "canvas-html" },
      actionCtx,
    );
    expect(res.ok).toBe(false);
    expect("error" in res && res.error).toMatch(/not permitted/);
  });
});

describe("retire-lens kind check", () => {
  it("refuses to retire an exhibit, steering to the Exhibits verb", async () => {
    await seedExhibit("assessment");
    const res = await onAction({ type: "retire-lens", payload: { id: "assessment" } }, actionCtx);
    expect(res.ok).toBe(false);
    expect("error" in res && res.error).toMatch(/is an exhibit/);
    expect((await listLenses(lensesDir())).map((l) => l.id)).toEqual(["assessment"]);
  });
});

describe("chamber_table_exhibit tool", () => {
  it("tables an exhibit: persists the record with the exhibit kind", async () => {
    const t = makeToolCtx();
    await tool("chamber_table_exhibit").execute(
      { id: "Sample Assessment", board: board("Sample Assessment"), reason: "the gist" },
      t.ctx,
    );
    expect(t.errored()).toBe(false);
    expect(JSON.parse(t.out())).toEqual({ ok: true, key: "rib:chamber:lens:sample-assessment" });
    const [rec] = await listLenses(lensesDir());
    expect(rec?.id).toBe("sample-assessment");
    expect(rec?.kind).toBe("exhibit");
    expect(rec?.reason).toBe("the gist");
    // sourceRoom is driver-witnessed only — the tool itself never writes one.
    expect(rec?.sourceRoom).toBeUndefined();
  });

  it("rejects an id with no usable characters", async () => {
    const t = makeToolCtx();
    await tool("chamber_table_exhibit").execute({ id: "!!!", board: board("X") }, t.ctx);
    expect(t.errored()).toBe(true);
    expect(t.out()).toContain("no usable characters");
  });

  it("refuses to overwrite a standing lens (the two species share one id space)", async () => {
    await seedLens("morning-brief");
    const t = makeToolCtx();
    await tool("chamber_table_exhibit").execute(
      { id: "morning-brief", board: board("Hijack") },
      t.ctx,
    );
    expect(t.errored()).toBe(true);
    expect(t.out()).toContain("is a lens");
    const [rec] = await listLenses(lensesDir());
    expect(rec?.kind).toBeUndefined();
    expect(rec?.board.title).toBe("morning-brief");
  });

  it("a re-table by the owning room preserves the witnessed sourceRoom", async () => {
    await seedExhibit("assessment", "sample-review");
    const t = makeToolCtx("sample-review");
    await tool("chamber_table_exhibit").execute(
      { id: "assessment", board: board("Assessment v2") },
      t.ctx,
    );
    expect(t.errored()).toBe(false);
    const [rec] = await listLenses(lensesDir());
    expect(rec?.board.title).toBe("Assessment v2");
    expect(rec?.sourceRoom).toBe("sample-review");
  });

  it("refuses an exhibit another room owns, without touching its board", async () => {
    await seedExhibit("assessment", "sample-review");
    const t = makeToolCtx("other-room");
    await tool("chamber_table_exhibit").execute(
      { id: "assessment", board: board("Stolen") },
      t.ctx,
    );
    expect(t.errored()).toBe(true);
    expect(t.out()).toContain("owned by another room");
    const [rec] = await listLenses(lensesDir());
    expect(rec?.board.title).toBe("assessment");
    expect(rec?.sourceRoom).toBe("sample-review");
  });

  it("refuses an owned exhibit when the caller carries no room identity", async () => {
    // The seam is registered globally, so a caller outside any room reaches it too.
    // Without identity we cannot tell a same-room re-table from a collision.
    await seedExhibit("assessment", "sample-review");
    const t = makeToolCtx();
    await tool("chamber_table_exhibit").execute(
      { id: "assessment", board: board("Stolen") },
      t.ctx,
    );
    expect(t.errored()).toBe(true);
    const [rec] = await listLenses(lensesDir());
    expect(rec?.board.title).toBe("assessment");
    expect(rec?.sourceRoom).toBe("sample-review");
  });

  it("an unowned exhibit is still re-tabled by a caller with no room identity", async () => {
    await seedExhibit("assessment");
    const t = makeToolCtx();
    await tool("chamber_table_exhibit").execute(
      { id: "assessment", board: board("Assessment v2") },
      t.ctx,
    );
    expect(t.errored()).toBe(false);
    const [rec] = await listLenses(lensesDir());
    expect(rec?.board.title).toBe("Assessment v2");
  });
});

describe("chamber_emit_lens kind guard", () => {
  it("refuses to overwrite an exhibit (would flip its kind and drop sourceRoom)", async () => {
    await seedExhibit("assessment", "sample-review");
    const t = makeToolCtx();
    await tool("chamber_emit_lens").execute({ id: "assessment", board: board("Hijack") }, t.ctx);
    expect(t.errored()).toBe(true);
    expect(t.out()).toContain("is an exhibit");
    const [rec] = await listLenses(lensesDir());
    expect(rec?.kind).toBe("exhibit");
    expect(rec?.sourceRoom).toBe("sample-review");
  });
});

describe("chamber_delete_exhibit tool", () => {
  it("deletes an exhibit and reports its key", async () => {
    await seedExhibit("assessment");
    const t = makeToolCtx();
    await tool("chamber_delete_exhibit").execute({ id: "assessment" }, t.ctx);
    expect(t.errored()).toBe(false);
    expect(JSON.parse(t.out())).toEqual({ ok: true, key: "rib:chamber:lens:assessment" });
    expect(await listLenses(lensesDir())).toEqual([]);
  });

  it("refuses a lens id, steering to chamber_retire_lens", async () => {
    await seedLens("morning-brief");
    const t = makeToolCtx();
    await tool("chamber_delete_exhibit").execute({ id: "morning-brief" }, t.ctx);
    expect(t.errored()).toBe(true);
    expect(t.out()).toContain("chamber_retire_lens");
  });
});

describe("chamber_retire_lens kind check", () => {
  it("refuses an exhibit id, steering to chamber_delete_exhibit", async () => {
    await seedExhibit("assessment");
    const t = makeToolCtx();
    await tool("chamber_retire_lens").execute({ id: "assessment" }, t.ctx);
    expect(t.errored()).toBe(true);
    expect(t.out()).toContain("chamber_delete_exhibit");
    expect((await listLenses(lensesDir())).map((l) => l.id)).toEqual(["assessment"]);
  });
});

describe("the witnessed sourceRoom stamp (wiring)", () => {
  it("a room turn that tables an exhibit gets the room stamped as its source", async () => {
    // Rebuild the rib with a turn seam whose stream carries the tool_use chunk the
    // driver witnesses. The exhibit record is pre-seeded (standing in for the tool
    // having run server-side during the turn); the stamp must then find it and
    // record the producing room.
    await rib.dispose?.();
    const run: RunAgentTurn = () => ({
      stream: (async function* (): AsyncGenerator<MessageChunk> {
        yield {
          type: "tool_use",
          id: "t1",
          toolName: "chamber_table_exhibit",
          toolInput: { id: "Sample Assessment", board: board("Sample Assessment") },
        };
        yield { type: "done" };
      })(),
      result: Promise.resolve({ status: "ok", text: "tabled" } satisfies RibAgentTurnResult),
    });
    const ctx = {
      ...makeCtx(fakeSnapshotManager()),
      runAgentTurn: run,
    } as unknown as RibContext;
    tools = registerTools(ctx);
    const seat = (slug: string, name: string, slot: number) =>
      scaffoldMind(
        mindsDir(),
        {
          slug,
          name,
          role: "agent",
          voice: "calm",
          persona: `You are ${name}.`,
          createdAt: "2026-01-01T00:00:00.000Z",
          identitySlot: slot,
        },
        `# ${name}\n`,
      );
    await seat("alice", "Alice", 0);
    await seat("bob", "Bob", 1);
    await seedExhibit("sample-assessment");

    const t = makeToolCtx();
    await tool("chamber_room_start").execute(
      { participants: ["alice", "bob"], turnBudget: 2, confirm: true },
      t.ctx,
    );
    expect(t.errored()).toBe(false);

    const stamped = async () =>
      (await listLenses(lensesDir())).find((l) => l.id === "sample-assessment")?.sourceRoom;
    const deadline = Date.now() + 2000;
    while (!(await stamped()) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const sourceRoom = await stamped();
    // The stamp is the room's SLUG — the stable id room cards join their tabled
    // links on — never its display name.
    expect(sourceRoom ?? "").toMatch(/^room-/);
  });
});

describe("the list tools split one store by kind", () => {
  it("chamber_list_lenses excludes exhibits; chamber_list_exhibits carries sourceRoom", async () => {
    await seedLens("morning-brief");
    await seedExhibit("assessment", "sample-review");

    const lenses = makeToolCtx();
    await tool("chamber_list_lenses").execute({}, lenses.ctx);
    const lensRows = JSON.parse(lenses.out()) as { count: number; lenses: { id: string }[] };
    expect(lensRows.count).toBe(1);
    expect(lensRows.lenses[0]?.id).toBe("morning-brief");

    const exhibits = makeToolCtx();
    await tool("chamber_list_exhibits").execute({}, exhibits.ctx);
    const exhibitRows = JSON.parse(exhibits.out()) as {
      count: number;
      exhibits: { id: string; sourceRoom?: string }[];
    };
    expect(exhibitRows.count).toBe(1);
    expect(exhibitRows.exhibits[0]).toMatchObject({
      id: "assessment",
      sourceRoom: "sample-review",
    });
  });
});
