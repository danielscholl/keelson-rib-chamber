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
//
// The republish is QUEUED, not run inline, because that is what production does — the
// stamp rides enqueueLensWrite and lands well after the turn's own publish. Running it
// inline would let the turn's publish read the freshly-set cache, hiding whether
// republish publishes at all.
function stampingHarness(perTurnChunks: MessageChunk[][], tabled: LensRecord[] = [EXHIBIT]) {
  const { store, rooms } = makeFakeStore();
  const pub = makeFakePublisher();
  const queued: string[] = [];
  let driver: RoomDriver | undefined;
  driver = createRoomDriver({
    store,
    publisher: pub.publisher,
    runAgentTurn: chunkedRunAgentTurn(perTurnChunks),
    minds: () => MINDS,
    exhibits: async (slug) => tabled.filter((e) => e.sourceRoom === slug),
    onExhibitsTabled: (_ids, room) => queued.push(room.slug),
    now: fixedClock(),
    newId: seqIds(),
  });
  return {
    driver,
    pub,
    rooms,
    // Drain the deferred stamps, as the lens write queue eventually does.
    settle: async () => {
      for (const slug of queued.splice(0)) await driver?.republish(slug);
    },
  };
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
  test("the republish is what surfaces a tabled exhibit — the turn's own publish cannot", async () => {
    const h = stampingHarness([[{ type: "text", content: "converged —" }, TABLE_CHUNK]]);
    await h.driver?.start(START);
    expect(tabledTitles(h.pub.last()!)).toEqual([]);
    await h.driver?.step("demo");
    // The stamp has not landed, so the turn's own board cannot carry the exhibit yet —
    // asserting this is what stops the test passing on the turn's publish instead.
    expect(tabledTitles(h.pub.last()!)).toEqual([]);
    await h.settle();
    expect(tabledTitles(h.pub.last()!)).toEqual(["The Verdict"]);
  });

  test("republish renders the exhibits without writing room state", async () => {
    const h = stampingHarness([[{ type: "text", content: "quiet" }]]);
    await h.driver?.start(START);
    const before = structuredClone(h.rooms.get("demo"));
    await h.driver?.republish("demo");
    // An exhibit change is not room state: generation gating owns every room write.
    expect(h.rooms.get("demo")).toEqual(before!);
    expect(tabledTitles(h.pub.last()!)).toEqual(["The Verdict"]);
  });

  test("a room that has ended never republishes — that would resurrect its panel", async () => {
    // The publisher lazily registers an unknown slug, and the surface releases a closed
    // room's key and region. A late stamp (the closing turn is exactly where a room tables
    // its deliverable) would otherwise re-register both and float a dead room's panel.
    const h = stampingHarness([[{ type: "text", content: "quiet" }]]);
    await h.driver?.start(START);
    await h.driver?.stop("demo");
    const published = h.pub.published.length;
    await h.driver?.republish("demo");
    expect(h.pub.published.length).toBe(published);
  });

  test("a room that ends while its exhibits resolve still never republishes", async () => {
    // The window the entry check cannot close: the room was live when republish began and
    // died during the (disk-backed) exhibit read, so liveness is re-checked under the lock.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { store } = makeFakeStore();
    const pub = makeFakePublisher();
    const driver = createRoomDriver({
      store,
      publisher: pub.publisher,
      runAgentTurn: chunkedRunAgentTurn([[{ type: "text", content: "quiet" }]]),
      minds: () => MINDS,
      exhibits: async () => {
        await gate;
        return [EXHIBIT];
      },
      now: fixedClock(),
      newId: seqIds(),
    });
    await driver.start(START);
    const inFlight = driver.republish("demo");
    await driver.stop("demo");
    const published = pub.published.length;
    release();
    await inFlight;
    expect(pub.published.length).toBe(published);
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

  test("republish is a no-op for a room this driver never started", async () => {
    const h = stampingHarness([[{ type: "text", content: "quiet" }]]);
    await h.driver?.start(START);
    const published = h.pub.published.length;
    await h.driver?.republish("never-existed");
    expect(h.pub.published.length).toBe(published);
  });

  test("without the exhibits seam a republish publishes nothing", async () => {
    // The seam ladder: a host without the lens seams leaves `exhibits` unwired, and the
    // board simply has no Tabled section rather than half-rendering one.
    const { store } = makeFakeStore();
    const pub = makeFakePublisher();
    const driver = createRoomDriver({
      store,
      publisher: pub.publisher,
      runAgentTurn: chunkedRunAgentTurn([[{ type: "text", content: "quiet" }]]),
      minds: () => MINDS,
      now: fixedClock(),
      newId: seqIds(),
    });
    await driver.start(START);
    const published = pub.published.length;
    await driver.republish("demo");
    expect(pub.published.length).toBe(published);
  });
});
