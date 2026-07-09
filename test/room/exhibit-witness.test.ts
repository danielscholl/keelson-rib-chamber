import { describe, expect, test } from "bun:test";
import type { MessageChunk } from "@keelson/shared";
import type { RibAgentTurnResult, RunAgentTurn } from "../../src/agent-turn.ts";
import { createRoomDriver } from "../../src/room.ts";
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
