import { describe, expect, test } from "bun:test";
import { createRoomDriver } from "../../src/room.ts";
import type { Mind, RoomStrategyName } from "../../src/types.ts";
import {
  fixedClock,
  makeFakePublisher,
  makeFakeStore,
  scriptedRunAgentTurn,
  seqIds,
  type TurnScript,
} from "../helpers/fakes.ts";

const MINDS: Mind[] = [
  { slug: "a", name: "Ada", role: "agent", persona: "You are Ada." },
  { slug: "b", name: "Bo", role: "agent", persona: "You are Bo." },
  { slug: "m", name: "Mod", role: "moderator", persona: "You are Mod." },
  { slug: "mgr", name: "Manager", role: "manager", persona: "You manage." },
  { slug: "author", name: "Author", role: "agent", persona: "You are Author." },
  { slug: "reviewer", name: "Reviewer", role: "agent", persona: "You are Reviewer." },
];

function harness(scripts: TurnScript[]) {
  const { store } = makeFakeStore();
  const pub = makeFakePublisher();
  const turns = scriptedRunAgentTurn(scripts);
  const driver = createRoomDriver({
    store,
    publisher: pub.publisher,
    runAgentTurn: turns.run,
    minds: () => MINDS,
    now: fixedClock(),
    newId: seqIds(),
  });
  return { driver, store, turns };
}

async function drain(driver: ReturnType<typeof createRoomDriver>, slug: string): Promise<void> {
  for (let i = 0; i < 8; i++) {
    if ((await driver.step(slug)) === "ended") return;
  }
  throw new Error(`room ${slug} did not end`);
}

const direct = (slug: string) => `{"action":"direct","next_speaker":"${slug}"}`;
const planTail = (assignee: string) =>
  `Plan.\n${JSON.stringify({ action: "plan", tasks: [{ description: "do it", assignee }] })}`;

describe("room driver — budget exhaustion synthesis", () => {
  const cases = [
    {
      name: "sequential",
      strategy: "sequential" as RoomStrategyName,
      participants: ["a", "b"],
      turnBudget: 1,
      scripts: [{ text: "a1" }, { text: "summary" }],
      expectedFrom: ["a", "a"],
    },
    {
      name: "concurrent",
      strategy: "concurrent" as RoomStrategyName,
      participants: ["a", "b"],
      turnBudget: 1,
      scripts: [{ text: "a1" }, { text: "summary" }],
      expectedFrom: ["a", "a"],
    },
    {
      name: "open-floor",
      strategy: "open-floor" as RoomStrategyName,
      participants: ["a", "b"],
      turnBudget: 1,
      scripts: [{ text: "a1" }, { text: "summary" }],
      expectedFrom: ["a", "a"],
    },
    {
      name: "group-chat",
      strategy: "group-chat" as RoomStrategyName,
      participants: ["a", "b"],
      turnBudget: 1,
      config: { moderator: "m" },
      scripts: [{ text: direct("a") }, { text: "summary" }],
      expectedFrom: ["m", "m"],
    },
    {
      name: "magentic",
      strategy: "magentic" as RoomStrategyName,
      participants: ["a", "b"],
      turnBudget: 2,
      config: { manager: "mgr" },
      scripts: [{ text: planTail("a") }, { text: "done" }, { text: "summary" }],
      expectedFrom: ["mgr", "a", "mgr"],
    },
  ];

  test("review is exempt — the reviewer's critique closes the room with no synthesis turn", async () => {
    const h = harness([{ text: "artifact" }, { text: "review" }]);
    await h.driver.start({
      slug: "review",
      name: "review",
      strategy: "review" as RoomStrategyName,
      participants: ["author", "reviewer"],
      turnBudget: 2,
      topic: "Decide the thing",
    });

    await drain(h.driver, "review");

    const transcript = await h.store.loadTranscript("review");
    expect(transcript.map((e) => e.from)).toEqual(["author", "reviewer"]);
    expect(transcript).toHaveLength(2);
    expect(h.turns.requests.at(-1)?.prompt).not.toContain("Synthesize the discussion");
    expect((await h.store.loadRoom("review"))?.status).toBe("done");
  });

  for (const c of cases) {
    test(`${c.name} appends exactly one fallback synthesis turn after budget exhaustion`, async () => {
      const h = harness(c.scripts);
      await h.driver.start({
        slug: c.name,
        name: c.name,
        strategy: c.strategy,
        participants: c.participants,
        turnBudget: c.turnBudget,
        topic: "Decide the thing",
        ...(c.config ? { config: c.config } : {}),
      });

      await drain(h.driver, c.name);

      const transcript = await h.store.loadTranscript(c.name);
      expect(transcript.map((e) => e.from)).toEqual(c.expectedFrom);
      expect(transcript).toHaveLength(c.turnBudget + 1);
      expect(transcript.at(-1)?.parts[0]?.text).toBe("summary");
      expect(h.turns.requests.at(-1)?.prompt).toContain("Synthesize the discussion");
      expect((await h.store.loadRoom(c.name))?.status).toBe("done");
    });
  }
});
