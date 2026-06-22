import { describe, expect, test } from "bun:test";
import { createRoomDriver } from "../../src/room.ts";
import type { Mind } from "../../src/types.ts";
import {
  fixedClock,
  makeFakePublisher,
  makeFakeStore,
  scriptedRunAgentTurn,
  seqIds,
  type TurnScript,
} from "../helpers/fakes.ts";

// participants[0] = author (claude), participants[1] = reviewer (codex): the
// cross-vendor pairing the rib's validateStart enforces. The driver honours the
// pins and builds the reviewer's artifact-only prompt.
const MINDS_REV: Mind[] = [
  { slug: "author", name: "Author", role: "agent", persona: "You are Author.", provider: "claude" },
  {
    slug: "reviewer",
    name: "Reviewer",
    role: "agent",
    persona: "You are Reviewer.",
    provider: "codex",
  },
];

const START_REV = {
  slug: "rev",
  name: "Rev",
  strategy: "review" as const,
  participants: ["author", "reviewer"],
  turnBudget: 8,
};

function revHarness(scripts: TurnScript[]) {
  const { store } = makeFakeStore();
  const pub = makeFakePublisher();
  const turns = scriptedRunAgentTurn(scripts);
  const driver = createRoomDriver({
    store,
    publisher: pub.publisher,
    runAgentTurn: turns.run,
    minds: () => MINDS_REV,
    now: fixedClock(),
    newId: seqIds(),
  });
  return { driver, store, pub, turns };
}

describe("room driver — review (cross-vendor, artifact-only)", () => {
  test("author speaks, reviewer reviews the artifact alone, then the room ends", async () => {
    const h = revHarness([{ text: "ARTIFACT-BODY" }, { text: "REVIEW-VERDICT" }]);
    await h.driver.start({ ...START_REV, topic: "The contract" });

    expect(await h.driver.step("rev")).toBe("advanced"); // author
    expect(await h.driver.step("rev")).toBe("advanced"); // reviewer

    const t = await h.store.loadTranscript("rev");
    expect(t.map((e) => e.from)).toEqual(["author", "reviewer"]);

    // The reviewer is handed the contract + the author's artifact ONLY — never the
    // windowed transcript framing — so the handoff stays artifact-only.
    const reviewerReq = h.turns.requests[1];
    if (!reviewerReq) throw new Error("expected a reviewer turn request");
    expect(reviewerReq.system).toBe("You are Reviewer.");
    expect(reviewerReq.prompt).toContain("ARTIFACT-BODY");
    expect(reviewerReq.prompt).toContain("Artifact to review from author");
    expect(reviewerReq.prompt).toContain("The contract");
    expect(reviewerReq.prompt).not.toContain("Conversation so far");

    // After the reviewer, the next step closes the room.
    expect(await h.driver.step("rev")).toBe("ended");
    expect((await h.store.loadRoom("rev"))?.status).toBe("done");
  });

  test("honours each Mind's provider pin (author and reviewer are different vendors)", async () => {
    const h = revHarness([{ text: "art" }, { text: "rev" }]);
    await h.driver.start(START_REV);
    await h.driver.step("rev");
    await h.driver.step("rev");
    expect(h.turns.requests[0]?.provider).toBe("claude");
    expect(h.turns.requests[1]?.provider).toBe("codex");
  });

  test("the author's turn is a plain framed prompt, not the review prompt", async () => {
    const h = revHarness([{ text: "art" }, { text: "rev" }]);
    await h.driver.start({ ...START_REV, topic: "Build X" });
    await h.driver.step("rev"); // author
    const authorReq = h.turns.requests[0];
    if (!authorReq) throw new Error("expected an author turn request");
    expect(authorReq.system).toBe("You are Author.");
    expect(authorReq.prompt).toContain("Build X");
    expect(authorReq.prompt).not.toContain("Artifact to review");
  });
});
