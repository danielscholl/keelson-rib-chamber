import { describe, expect, test } from "bun:test";
import { canvasBoardViewSchema } from "@keelson/shared";
import {
  BOARD_COMPOSITION_CONTRACT,
  BOARD_FORM_KINDS,
  BOARD_NON_FORM_KINDS,
  buildBoardCompositionGuidance,
} from "../src/board-guidance.ts";
import { LENS_WF_PROMPT } from "../src/prompts.ts";

// The board section kinds the host actually accepts, read off the shared schema
// rather than restated — the whole point of the drift test below.
function schemaSectionKinds(): string[] {
  const schema = canvasBoardViewSchema as unknown as {
    shape: { sections: { element: { options: { shape: { kind: { value: string } } }[] } } };
  };
  return schema.shape.sections.element.options.map((o) => o.shape.kind.value);
}

describe("board composition guidance", () => {
  // The guard that earns this file: Chamber teaches board authoring by naming the
  // forms, so a section kind keelson adds is invisible to every Mind until it is
  // named here. Failing loudly beats silently under-teaching the schema.
  test("every board section kind is either taught as a form or consciously skipped", () => {
    const kinds = schemaSectionKinds();
    expect(kinds.length).toBeGreaterThan(0);
    expect([...BOARD_FORM_KINDS, ...BOARD_NON_FORM_KINDS].sort()).toEqual([...kinds].sort());
  });

  test("form and non-form kinds do not overlap", () => {
    const overlap = BOARD_FORM_KINDS.filter((k) => BOARD_NON_FORM_KINDS.includes(k));
    expect(overlap).toEqual([]);
  });

  test("the contract names every taught form", () => {
    for (const kind of BOARD_FORM_KINDS) {
      expect(BOARD_COMPOSITION_CONTRACT).toContain(`\`${kind}\``);
    }
  });

  // The contract joins the forms into one comma-separated prose list, so a comma inside
  // a form's job silently reads as a list break ("`stats` for the figures, before any
  // detail, `bars` for …" parses as three entries, not two).
  test("no form's job carries a comma the contract's list would break on", () => {
    const after = BOARD_COMPOSITION_CONTRACT.split("matches the data: ")[1] ?? "";
    const list = after.split(". ")[0] ?? "";
    expect(list.split(", ")).toHaveLength(BOARD_FORM_KINDS.length);
  });

  test("the guidance block names every taught form", () => {
    const guidance = buildBoardCompositionGuidance();
    for (const kind of BOARD_FORM_KINDS) {
      expect(guidance).toContain(`\`${kind}\``);
    }
  });

  // The composition rules are the half the renderer cannot enforce: it owns layout and
  // palette, but nothing stops a Mind putting a clause in a pill or dumping records.
  test("both tiers carry the composition rules the renderer cannot enforce", () => {
    const guidance = buildBoardCompositionGuidance();
    for (const text of [BOARD_COMPOSITION_CONTRACT, guidance]) {
      expect(text).toContain("finding");
      expect(text).toContain("state chip");
      expect(text).toContain("label plus a value");
      expect(text).toContain("count");
    }
  });

  test("the lens workflow prompt embeds the guidance block", () => {
    expect(LENS_WF_PROMPT).toContain("## Composing the board");
    expect(LENS_WF_PROMPT).toContain("`bars`");
    expect(LENS_WF_PROMPT).toContain("chamber_emit_lens");
  });
});
