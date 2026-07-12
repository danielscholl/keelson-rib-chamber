import { describe, expect, test } from "bun:test";
import { createRoomDriver } from "../../src/room.ts";
import type { Mind, RoomStrategyName } from "../../src/types.ts";
import {
  fixedClock,
  makeFakePublisher,
  makeFakeStore,
  scriptedRunAgentTurn,
  scriptedThenAbortable,
  seqIds,
} from "../helpers/fakes.ts";

// Two providers so the fidelity checker can be picked cross-vendor: `a`/`c` share one,
// `b` is the other. In a sequential budget-1 room only `a` speaks, so the synthesizer
// falls back to `a` — the checker must therefore skip same-vendor `c` and pick `b`.
const MINDS: Mind[] = [
  { slug: "a", name: "Ada", role: "agent", persona: "You are Ada.", provider: "px" },
  { slug: "b", name: "Bo", role: "agent", persona: "You are Bo.", provider: "py" },
  { slug: "c", name: "Cy", role: "agent", persona: "You are Cy.", provider: "px" },
  { slug: "mgr", name: "Mgr", role: "manager", persona: "You manage.", provider: "px" },
];

const GROUNDING = {
  sourceUrl: "https://example.test/issue/204",
  criteria: ["The design carries grounding", "The fidelity check runs before close"],
};

function harness(scripts: { text: string }[]) {
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

describe("room driver — grounding + pre-close fidelity check", () => {
  test("a grounded design-bearing room runs a cross-vendor fidelity turn before synthesis", async () => {
    const h = harness([{ text: "a-opens" }, { text: "fidelity-report" }, { text: "closing" }]);
    await h.driver.start({
      slug: "g",
      name: "g",
      strategy: "sequential" as RoomStrategyName,
      participants: ["a", "c", "b"],
      turnBudget: 1,
      topic: "Decide the thing",
      grounding: GROUNDING,
    });

    await drain(h.driver, "g");

    const transcript = await h.store.loadTranscript("g");
    // author (a) → fidelity (b, cross-vendor, NOT same-vendor c) → synthesis (a).
    expect(transcript.map((e) => e.from)).toEqual(["a", "b", "a"]);
    expect(transcript).toHaveLength(3); // budget (1) + fidelity + synthesis
    expect((await h.store.loadRoom("g"))?.status).toBe("done");

    const [, fidelityReq, synthReq] = h.turns.requests;
    // The fidelity turn ran on the cross-vendor Mind and was handed the criteria.
    expect(fidelityReq?.provider).toBe("py");
    expect(fidelityReq?.prompt).toContain("fidelity checker for this room");
    expect(fidelityReq?.prompt).toContain("different vendor");
    expect(fidelityReq?.prompt).toContain("The fidelity check runs before close");
    // The synthesis turn ran on the synthesizer and was told to fold the check in.
    expect(synthReq?.provider).toBe("px");
    expect(synthReq?.prompt).toContain("cross-vendor fidelity check");
    expect(synthReq?.prompt).toContain("### Acceptance criteria");
    // The grounding brief is visible in the turn prompts, not just the topic.
    expect(synthReq?.prompt).toContain("Grounding brief:");
  });

  test("an ungrounded room closes with synthesis alone — no fidelity turn", async () => {
    const h = harness([{ text: "a-opens" }, { text: "closing" }]);
    await h.driver.start({
      slug: "u",
      name: "u",
      strategy: "sequential" as RoomStrategyName,
      participants: ["a", "b"],
      turnBudget: 1,
      topic: "Decide the thing",
    });

    await drain(h.driver, "u");

    const transcript = await h.store.loadTranscript("u");
    expect(transcript.map((e) => e.from)).toEqual(["a", "a"]); // budget + synthesis only
    expect(transcript).toHaveLength(2);
    const synthReq = h.turns.requests.at(-1);
    expect(synthReq?.prompt).not.toContain("Grounding brief:");
    expect(synthReq?.prompt).not.toContain("fidelity check");
  });

  test("grounding with no criteria (source only) runs no fidelity turn", async () => {
    const h = harness([{ text: "a-opens" }, { text: "closing" }]);
    await h.driver.start({
      slug: "s",
      name: "s",
      strategy: "sequential" as RoomStrategyName,
      participants: ["a", "b"],
      turnBudget: 1,
      grounding: { sourceUrl: "https://example.test/spec", criteria: [] },
    });

    await drain(h.driver, "s");

    const transcript = await h.store.loadTranscript("s");
    expect(transcript.map((e) => e.from)).toEqual(["a", "a"]);
    // The source still surfaces in the prompt even without criteria to check.
    expect(h.turns.requests.at(-1)?.prompt).toContain("https://example.test/spec");
  });

  test("skips the fidelity turn when no participant is cross-vendor to the synthesizer", async () => {
    // `a` and `c` share provider px; the synthesizer falls back to `a`, and no
    // participant is on a different pinned provider — so an honest cross-vendor check
    // is impossible. The room closes with synthesis alone, and the synthesis prompt
    // does NOT claim a check ran.
    const h = harness([{ text: "a-opens" }, { text: "closing" }]);
    await h.driver.start({
      slug: "sv",
      name: "sv",
      strategy: "sequential" as RoomStrategyName,
      participants: ["a", "c"],
      turnBudget: 1,
      grounding: GROUNDING,
    });

    await drain(h.driver, "sv");

    const transcript = await h.store.loadTranscript("sv");
    expect(transcript.map((e) => e.from)).toEqual(["a", "a"]); // author + synthesis, no fidelity
    const synthReq = h.turns.requests.at(-1);
    expect(synthReq?.prompt).not.toContain("independent fidelity checker");
    expect(synthReq?.prompt).not.toContain("cross-vendor fidelity check");
    // Grounding criteria still surface, and the synthesizer still records their status.
    expect(synthReq?.prompt).toContain("Grounding brief:");
    expect(synthReq?.prompt).toContain("### Acceptance criteria");
  });

  test("a grounded room routes a natural (pre-budget) close through fidelity + synthesis", async () => {
    // A magentic manager that declares the plan done closes the room via `end` before
    // budget. Grounded, that natural close still runs the fidelity turn (b, cross-vendor
    // to the mgr synthesizer) and a closing synthesis — not a bare terminal commit.
    const h = harness([
      { text: 'Plan complete.\n{"action":"done","summary":"all done"}' },
      { text: "fidelity-report" },
      { text: "closing" },
    ]);
    await h.driver.start({
      slug: "mg",
      name: "mg",
      strategy: "magentic" as RoomStrategyName,
      participants: ["a", "b"],
      turnBudget: 4,
      config: { manager: "mgr" },
      grounding: GROUNDING,
    });

    await drain(h.driver, "mg");

    const transcript = await h.store.loadTranscript("mg");
    expect(transcript.map((e) => e.from)).toEqual(["mgr", "b", "mgr"]); // manage → fidelity → synthesis
    expect((await h.store.loadRoom("mg"))?.status).toBe("done");
    expect(h.turns.requests[1]?.prompt).toContain("fidelity checker for this room");
  });

  test("an operator stop during the fidelity check closes the room without a synthesis turn", async () => {
    const { store } = makeFakeStore();
    const pub = makeFakePublisher();
    // Call 0 (author) resolves; call 1 (the fidelity turn) stays in flight until abort.
    const turns = scriptedThenAbortable("a-opens");
    const driver = createRoomDriver({
      store,
      publisher: pub.publisher,
      runAgentTurn: turns.run,
      minds: () => MINDS,
      now: fixedClock(),
      newId: seqIds(),
    });
    await driver.start({
      slug: "stop",
      name: "stop",
      strategy: "sequential" as RoomStrategyName,
      participants: ["a", "b"],
      turnBudget: 1,
      grounding: GROUNDING,
    });

    const stepP = driver.step("stop");
    await turns.secondStarted; // the fidelity turn is in flight
    await driver.stop("stop");
    await stepP;

    const transcript = await store.loadTranscript("stop");
    // author + the aborted fidelity turn — the synthesis turn never ran.
    expect(transcript.map((e) => e.from)).toEqual(["a", "b"]);
    expect(transcript.at(-1)?.aborted).toBe(true);
    expect(turns.requests).toHaveLength(2); // no third (synthesis) request
    expect((await store.loadRoom("stop"))?.status).toBe("stopped");
  });
});
