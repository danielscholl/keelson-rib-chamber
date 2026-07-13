import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RibContext, ToolContext } from "@keelson/shared";
import rib from "../src/index.ts";
import { readMinds } from "../src/minds-store.ts";
import { mindsDir, setChamberDataHome } from "../src/paths.ts";
import { readPendingGeneses } from "../src/pending-genesis.ts";

const onAction = rib.onAction;
const registerTools = rib.registerTools;
if (!onAction || !registerTools) throw new Error("rib missing onAction/registerTools");

// The rib's onAction ignores its ctx (the refresh seam it uses is the module one
// captured in registerTools), so a shared throwaway ctx satisfies the 2-arg signature.
const actionCtx = {
  getExec: () => ({
    runJSON: async () => ({ ok: true as const, data: undefined }),
    runText: async () => ({ ok: true as const, data: "" }),
  }),
} as unknown as RibContext;
const dispatch = (a: Parameters<NonNullable<typeof onAction>>[0]) => onAction(a, actionCtx);

// A ctx with a recording refreshWorkflow, so the genesis tick's roster refreshes are
// captured (and inert) rather than spawning collectors during the test.
function makeCtx(refreshed: string[]): RibContext {
  return {
    getExec: () => ({
      runJSON: async <T>() => ({ ok: true as const, data: undefined as T }),
      runText: async () => ({ ok: true as const, data: "" }),
    }),
    refreshWorkflow: async (name: string) => {
      refreshed.push(name);
    },
  } as unknown as RibContext;
}

const toolCtx: ToolContext = {
  cwd: ".",
  emit: () => {},
  abortSignal: new AbortController().signal,
};

describe("genesis boot-card lifecycle", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "chamber-boot-"));
    setChamberDataHome(join(home, "chamber"));
  });
  afterEach(async () => {
    await rib.dispose?.(); // stops the tick + clears the marker
    setChamberDataHome(undefined);
    await rm(home, { recursive: true, force: true });
  });

  test("author-archetype writes a name/role marker and stays on the surface", async () => {
    registerTools(makeCtx([]));
    const res = await dispatch({ type: "author-archetype", payload: { slug: "moneypenny" } });
    expect(res.ok).toBe(true);
    // The effect launches the genesis workflow and keeps the operator on the surface.
    if (res.ok) {
      const data = res.data as { effect: string; workflow: string; stay?: boolean };
      expect(data.effect).toBe("run-workflow");
      expect(data.workflow).toBe("chamber-genesis");
      expect(data.stay).toBe(true);
    }
    // The pending marker knows the starter's identity up front (it was pinned).
    const markers = await readPendingGeneses();
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ name: "Moneypenny", role: "Chief of Staff" });
    expect(typeof markers[0]?.startedAt).toBe("string");
  });

  test("describe-own writes a marker with no name/role (the workflow authors them)", async () => {
    registerTools(makeCtx([]));
    const res = await dispatch({
      type: "describe-own",
      payload: { brief: "A skeptical staff engineer" },
    });
    expect(res.ok).toBe(true);
    const markers = await readPendingGeneses();
    expect(markers).toHaveLength(1);
    expect(markers[0]?.name).toBeUndefined();
    expect(markers[0]?.role).toBeUndefined();
    expect(typeof markers[0]?.startedAt).toBe("string");
  });

  test("a successful chamber_emit_genesis clears the boot-card marker", async () => {
    const tools = registerTools(makeCtx([]));
    await dispatch({ type: "author-archetype", payload: { slug: "mycroft" } });
    expect(await readPendingGeneses()).toHaveLength(1);

    const emit = tools.find((t) => t.name === "chamber_emit_genesis");
    if (!emit) throw new Error("genesis emit tool not found");
    await emit.execute(
      {
        name: "Mycroft",
        role: "Research Partner",
        voice: "sparing",
        soul: "# Mycroft\n## Persona\nA research partner.",
        tagline: "Synthesis and patterns.",
      },
      toolCtx,
    );
    // The seat filled — the marker is gone so the next roster frame shows the real card.
    expect(await readPendingGeneses()).toHaveLength(0);
    const minds = await readMinds(mindsDir());
    expect(minds.some((m) => m.slug === "mycroft")).toBe(true);
  });

  test("dismiss-genesis clears the marker and refreshes the roster", async () => {
    const refreshed: string[] = [];
    registerTools(makeCtx(refreshed));
    await dispatch({ type: "describe-own", payload: { brief: "someone" } });
    expect(await readPendingGeneses()).toHaveLength(1);

    refreshed.length = 0;
    const res = await dispatch({ type: "dismiss-genesis" });
    expect(res.ok).toBe(true);
    expect(await readPendingGeneses()).toHaveLength(0);
    expect(refreshed).toContain("chamber-roster");
  });

  test("dispose clears a stale marker (a genesis can't survive the process)", async () => {
    registerTools(makeCtx([]));
    await dispatch({ type: "author-archetype", payload: { slug: "jarvis" } });
    expect(await readPendingGeneses()).toHaveLength(1);
    await rib.dispose?.();
    expect(await readPendingGeneses()).toHaveLength(0);
  });

  test("parallel geneses hold one marker each; a landing settles only its own", async () => {
    const tools = registerTools(makeCtx([]));
    await dispatch({ type: "author-archetype", payload: { slug: "moneypenny" } });
    await dispatch({ type: "author-archetype", payload: { slug: "mycroft" } });
    expect((await readPendingGeneses()).map((m) => m.name)).toEqual(["Moneypenny", "Mycroft"]);

    const emit = tools.find((t) => t.name === "chamber_emit_genesis");
    if (!emit) throw new Error("genesis emit tool not found");
    await emit.execute(
      {
        name: "Moneypenny",
        role: "Chief of Staff",
        voice: "crisp",
        soul: "# Moneypenny\n## Persona\nChief of staff.",
        tagline: "Closes loops.",
      },
      toolCtx,
    );
    // Moneypenny's marker settled; Mycroft's boot card keeps running.
    expect((await readPendingGeneses()).map((m) => m.name)).toEqual(["Mycroft"]);
  });

  test("a freeform landing settles the oldest unnamed marker, not a starter's", async () => {
    const tools = registerTools(makeCtx([]));
    await dispatch({ type: "author-archetype", payload: { slug: "jarvis" } });
    await dispatch({ type: "describe-own", payload: { brief: "a skeptical architect" } });
    expect(await readPendingGeneses()).toHaveLength(2);

    const emit = tools.find((t) => t.name === "chamber_emit_genesis");
    if (!emit) throw new Error("genesis emit tool not found");
    await emit.execute(
      {
        name: "Athena",
        role: "Staff Engineer",
        voice: "wry",
        soul: "# Athena\n## Persona\nGuards the architecture.",
        tagline: "Asks what breaks at 10x.",
      },
      toolCtx,
    );
    // Athena matches no marker by name — the unnamed freeform marker settles;
    // Jarvis's pinned marker survives for his still-running genesis.
    expect((await readPendingGeneses()).map((m) => m.name)).toEqual(["Jarvis"]);
  });

  test("dismiss-genesis with a startedAt settles exactly that boot card", async () => {
    const refreshed: string[] = [];
    registerTools(makeCtx(refreshed));
    await dispatch({ type: "author-archetype", payload: { slug: "moneypenny" } });
    await dispatch({ type: "author-archetype", payload: { slug: "mycroft" } });
    const [first] = await readPendingGeneses();
    if (!first) throw new Error("no marker");

    const res = await dispatch({
      type: "dismiss-genesis",
      payload: { startedAt: first.startedAt },
    });
    expect(res.ok).toBe(true);
    expect((await readPendingGeneses()).map((m) => m.name)).toEqual(["Mycroft"]);
  });
});
