import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageChunk } from "@keelson/shared";
import type { RibAgentTurnRequest, RunAgentTurn } from "../../src/agent-turn.ts";
import { codingToolPool } from "../../src/capabilities.ts";
import { EXHIBIT_TOOL_NAME } from "../../src/lens.ts";
import { createRoomDriver } from "../../src/room.ts";
import type { Mind } from "../../src/types.ts";
import { fixedClock, makeFakePublisher, makeFakeStore, seqIds } from "../helpers/fakes.ts";

// The coding review preset: an author that declares `code` (edit/run) and a
// reviewer that declares `read` (inspect), pinned cross-vendor as room-start
// requires. With the coding tier on and a project, the driver grants each turn the
// declared rail, confined to the repo.
const AUTHOR: Mind = {
  slug: "author",
  name: "Author",
  role: "author",
  persona: "You write code.",
  provider: "claude",
  tools: ["code"],
};
const REVIEWER: Mind = {
  slug: "reviewer",
  name: "Reviewer",
  role: "reviewer",
  persona: "You review code.",
  provider: "codex",
  tools: ["read"],
};

const AUTHORED = "hello from the author";

// A runAgentTurn that performs a real filesystem round-trip keyed on the turn's
// granted tools — not a scripted string. A turn holding Write (the author's `code`
// rail) edits a file in its cwd; a turn holding Read (the reviewer's `read` rail)
// reads it back and reports the contents as its verdict. So the test proves the
// author's edit actually reaches disk and the reviewer actually reads that change.
function fileRoundTripTurn(filename: string) {
  const requests: RibAgentTurnRequest[] = [];
  const run: RunAgentTurn = (req) => {
    requests.push(req);
    const toolNames = new Set((req.tools ?? []).map((t) => t.name));
    const cwd = req.cwd;
    const result = (async () => {
      if (cwd && toolNames.has("Write")) {
        await writeFile(join(cwd, filename), AUTHORED, "utf8");
        return { status: "ok" as const, text: `wrote ${filename}` };
      }
      if (cwd && toolNames.has("Read")) {
        const seen = await readFile(join(cwd, filename), "utf8");
        return { status: "ok" as const, text: `verdict: the file reads "${seen}" — approve` };
      }
      return { status: "ok" as const, text: "no file tools on this turn" };
    })();
    return {
      stream: (async function* (): AsyncGenerator<MessageChunk> {
        yield { type: "done" };
      })(),
      result,
    };
  };
  return { run, requests };
}

describe("room driver — coding review loop (real file round-trip)", () => {
  test("author writes a file, reviewer reads it back, room completes within budget", async () => {
    const repo = await mkdtemp(join(tmpdir(), "chamber-review-coding-"));
    try {
      const { store } = makeFakeStore();
      const pub = makeFakePublisher();
      const turns = fileRoundTripTurn("greeting.txt");
      const driver = createRoomDriver({
        store,
        publisher: pub.publisher,
        runAgentTurn: turns.run,
        minds: () => [AUTHOR, REVIEWER],
        turnTools: [{ name: EXHIBIT_TOOL_NAME }],
        codingTools: codingToolPool(),
        resolveProjectRoot: () => repo,
        turnCwd: "/neutral",
        now: fixedClock(),
        newId: seqIds(),
      });

      await driver.start({
        slug: "rev",
        name: "Rev",
        strategy: "review",
        participants: ["author", "reviewer"],
        turnBudget: 8,
        topic: "Add a greeting file to the repo",
        projectId: "proj",
        coding: true,
      });

      expect(await driver.step("rev")).toBe("advanced"); // author edits the repo
      expect(await driver.step("rev")).toBe("advanced"); // reviewer reads it back
      expect(await driver.step("rev")).toBe("ended"); // the review pass closes

      // The review pass closed cleanly within the turn budget.
      expect((await store.loadRoom("rev"))?.status).toBe("done");

      // The author's edit really landed on disk in the project repo.
      expect(await readFile(join(repo, "greeting.txt"), "utf8")).toBe(AUTHORED);

      // The reviewer's verdict carries what it read back from that file — the loop
      // is author-edits-then-reviewer-reads, not critique-of-prose.
      const transcript = await store.loadTranscript("rev");
      const verdict = transcript.find((e) => e.from === "reviewer");
      expect(verdict?.parts.map((p) => p.text).join("")).toContain(AUTHORED);

      const [authorReq, reviewerReq] = turns.requests;
      // Both turns ran at — and were confined to — the project repo.
      expect(authorReq?.cwd).toBe(repo);
      expect(authorReq?.allowedDirectories).toEqual([repo]);
      expect(reviewerReq?.cwd).toBe(repo);
      expect(reviewerReq?.allowedDirectories).toEqual([repo]);

      // The author got the edit/exec rail; the reviewer got read only.
      expect((authorReq?.tools ?? []).map((t) => t.name).sort()).toEqual(["Bash", "Edit", "Write"]);
      expect((reviewerReq?.tools ?? []).map((t) => t.name)).toEqual(["Read"]);

      // Each Mind stayed pinned to its own provider — the cross-vendor pairing.
      expect(authorReq?.provider).toBe("claude");
      expect(reviewerReq?.provider).toBe("codex");

      // The reviewer was sent to the files, not handed prose to grade.
      expect(reviewerReq?.prompt).toContain("read the files they changed");
      expect(reviewerReq?.prompt).not.toContain("Review ONLY the artifact above");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
