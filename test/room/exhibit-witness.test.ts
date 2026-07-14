import { describe, expect, test } from "bun:test";
import type { CanvasView, MessageChunk } from "@keelson/shared";
import type { RibAgentTurnResult, RunAgentTurn } from "../../src/agent-turn.ts";
import type { LensRecord } from "../../src/lens-store.ts";
import { createRoomDriver, type RoomDriver } from "../../src/room.ts";
import type { Mind, Room } from "../../src/types.ts";
import { fixedClock, makeFakePublisher, makeFakeStore, seqIds } from "../helpers/fakes.ts";

const MINDS: Mind[] = [
  { slug: "a", name: "Ada", role: "agent", persona: "You are Ada." },
  { slug: "b", name: "Bo", role: "agent", persona: "You are Bo." },
];

const START = {
  slug: "demo",
  name: "Sample Review",
  strategy: "sequential" as const,
  participants: ["a", "b"],
  turnBudget: 2,
};

// A runAgentTurn whose stream carries scripted chunks (not just text), so the
// driver's tool_use witness is provable per turn.
function chunkedRunAgentTurn(perTurnChunks: MessageChunk[][]) {
  let i = 0;
  const run: RunAgentTurn = () => {
    const chunks = perTurnChunks[Math.min(i, perTurnChunks.length - 1)] ?? [];
    i += 1;
    return {
      stream: (async function* (): AsyncGenerator<MessageChunk> {
        for (const c of chunks) yield c;
        yield { type: "done" };
      })(),
      result: Promise.resolve({ status: "ok", text: "reply" } satisfies RibAgentTurnResult),
    };
  };
  return run;
}

function harness(perTurnChunks: MessageChunk[][]) {
  const { store } = makeFakeStore();
  const pub = makeFakePublisher();
  const witnessed: { ids: readonly string[]; room: Room }[] = [];
  const driver = createRoomDriver({
    store,
    publisher: pub.publisher,
    runAgentTurn: chunkedRunAgentTurn(perTurnChunks),
    minds: () => MINDS,
    onExhibitsTabled: (ids, room) => witnessed.push({ ids, room }),
    now: fixedClock(),
    newId: seqIds(),
  });
  return { driver, witnessed };
}

const EXHIBIT: LensRecord = {
  id: "verdict",
  board: { view: "board", title: "The Verdict", sections: [] },
  updatedAt: "2026-01-01T00:00:00.000Z",
  kind: "exhibit",
  sourceRoom: "demo",
};

// The rib's real wiring shape: the witness fires the provenance stamp, and the stamp
// republishes the room it stamped. Modelled here so the driver half is provable without
// the on-disk lens store.
function stampingHarness(perTurnChunks: MessageChunk[][], tabled: LensRecord[] = [EXHIBIT]) {
  const { store, rooms } = makeFakeStore();
  const pub = makeFakePublisher();
  const republishes: Promise<void>[] = [];
  let driver: RoomDriver | undefined;
  driver = createRoomDriver({
    store,
    publisher: pub.publisher,
    runAgentTurn: chunkedRunAgentTurn(perTurnChunks),
    minds: () => MINDS,
    exhibits: async (slug) => tabled.filter((e) => e.sourceRoom === slug),
    onExhibitsTabled: (_ids, room) => {
      republishes.push(driver?.republish(room.slug) ?? Promise.resolve());
    },
    now: fixedClock(),
    newId: seqIds(),
  });
  return { driver, pub, rooms, settle: () => Promise.all(republishes) };
}

const TABLE_CHUNK: MessageChunk = {
  type: "tool_use",
  id: "t1",
  toolName: "chamber_table_exhibit",
  toolInput: { id: "verdict", board: { view: "board", sections: [] } },
};

function tabledTitles(view: CanvasView): string[] {
  if (view.view !== "board") return [];
  const s = view.sections.find((x) => x.kind === "cards" && x.title === "Tabled");
  return s?.kind === "cards" ? s.items.map((i) => i.title) : [];
}

describe("room driver — the exhibit witness", () => {
  test("a tool_use chunk naming chamber_table_exhibit fires onExhibitsTabled with its ids", async () => {
    const h = harness([
      [
        { type: "text", content: "converged —" },
        {
          type: "tool_use",
          id: "t1",
          toolName: "chamber_table_exhibit",
          toolInput: { id: "Sample Assessment", board: { view: "board", sections: [] } },
        },
      ],
      [{ type: "text", content: "plain reply" }],
    ]);
    await h.driver.start(START);
    // The bare driver advances only on step() — auto-advance is the rib's loop.
    await h.driver.step("demo");
    expect(h.witnessed).toHaveLength(1);
    expect(h.witnessed[0]?.ids).toEqual(["Sample Assessment"]);
    expect(h.witnessed[0]?.room.slug).toBe("demo");
    expect(h.witnessed[0]?.room.name).toBe("Sample Review");
    // The second (plain-text) turn adds nothing.
    await h.driver.step("demo");
    expect(h.witnessed).toHaveLength(1);
  });

  test("other tools and plain turns never fire the witness", async () => {
    const h = harness([
      [
        { type: "text", content: "just talk" },
        {
          type: "tool_use",
          id: "t1",
          toolName: "chamber_emit_digest",
          toolInput: { id: "not-an-exhibit" },
        },
      ],
    ]);
    const room = await h.driver.start(START);
    await h.driver.step("demo");
    expect(room.slug).toBe("demo");
    expect(h.witnessed).toEqual([]);
  });

  test("a tool_use without a usable string id is ignored", async () => {
    const h = harness([
      [
        {
          type: "tool_use",
          id: "t1",
          toolName: "chamber_table_exhibit",
          toolInput: { board: { view: "board", sections: [] } },
        },
      ],
    ]);
    await h.driver.start(START);
    await h.driver.step("demo");
    expect(h.witnessed).toEqual([]);
  });
});

describe("room driver — republish", () => {
  test("a turn that tables an exhibit republishes the board with it, not a turn later", async () => {
    const h = stampingHarness([[{ type: "text", content: "converged —" }, TABLE_CHUNK]]);
    await h.driver?.start(START);
    // Before any table, the room's own board carries no Tabled section.
    expect(tabledTitles(h.pub.last()!)).toEqual([]);
    await h.driver?.step("demo");
    await h.settle();
    // The exhibit reaches the board of the very turn that tabled it.
    expect(tabledTitles(h.pub.last()!)).toEqual(["The Verdict"]);
  });

  test("republish renders the exhibits without writing room state", async () => {
    const h = stampingHarness([[{ type: "text", content: "quiet" }]]);
    await h.driver?.start(START);
    const before = structuredClone(h.rooms.get("demo"));
    await h.driver?.republish("demo");
    // A provenance stamp is not room state: generation gating owns every room write.
    expect(h.rooms.get("demo")).toEqual(before!);
    expect(tabledTitles(h.pub.last()!)).toEqual(["The Verdict"]);
  });

  test("only the room's own exhibits ride its board — sourceRoom is the join", async () => {
    const h = stampingHarness(
      [[{ type: "text", content: "quiet" }]],
      [EXHIBIT, { ...EXHIBIT, id: "other", sourceRoom: "some-other-room" }],
    );
    await h.driver?.start(START);
    await h.driver?.republish("demo");
    expect(tabledTitles(h.pub.last()!)).toEqual(["The Verdict"]);
  });

  test("republish is a no-op for an unknown room", async () => {
    const h = stampingHarness([[{ type: "text", content: "quiet" }]]);
    await h.driver?.start(START);
    const published = h.pub.published.length;
    await h.driver?.republish("never-existed");
    expect(h.pub.published.length).toBe(published);
  });

  test("without the exhibits seam a republish publishes nothing", async () => {
    // The seam ladder: a host without the lens seams leaves `exhibits` unwired, and the
    // board simply has no Tabled section rather than half-rendering one.
    const h = harness([[{ type: "text", content: "quiet" }]]);
    await h.driver.start(START);
    await h.driver.republish("demo");
    expect(h.witnessed).toEqual([]);
  });
});
