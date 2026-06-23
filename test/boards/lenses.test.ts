import { describe, expect, test } from "bun:test";
import { type CanvasTone, canvasViewSchema } from "@keelson/shared";
import { buildLensesIndexBoard } from "../../src/boards/lenses.ts";
import type { LensRecord } from "../../src/lens-store.ts";

const lens = (over: Partial<LensRecord> = {}): LensRecord => ({
  id: "release-risks",
  board: { view: "board", title: "Release Risks", sections: [] },
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const TONES: readonly CanvasTone[] = [
  "ok",
  "warn",
  "error",
  "neutral",
  "info",
  "caution",
  "brand",
  "accent",
];

function cards(board: ReturnType<typeof buildLensesIndexBoard>) {
  const section = board.sections.find((s) => s.kind === "cards");
  if (section?.kind !== "cards") throw new Error("no cards section");
  return section.items;
}

describe("buildLensesIndexBoard empty", () => {
  test("no lenses → a valid board with the library header and no cards section", () => {
    const board = buildLensesIndexBoard([]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.view).toBe("board");
    expect(board.title).toBe("Lenses");
    expect(board.header?.chip).toBe("library");
    expect(board.header?.status).toEqual({ label: "0 lenses", tone: "accent" });
    expect(board.sections.some((s) => s.kind === "cards")).toBe(false);
  });

  test("the empty state is a single rows hint pointing at the chamber-lens workflow", () => {
    const board = buildLensesIndexBoard([]);
    const first = board.sections[0];
    expect(first?.kind).toBe("rows");
    if (first?.kind === "rows") {
      expect(first.items).toHaveLength(1);
      expect(first.items[0]?.text).toContain("chamber-lens");
    }
  });
});

describe("buildLensesIndexBoard cards", () => {
  test("valid; header counts lenses singular/plural", () => {
    expect(buildLensesIndexBoard([lens()]).header?.status?.label).toBe("1 lens");
    const two = buildLensesIndexBoard([lens({ id: "a" }), lens({ id: "b" })]);
    expect(canvasViewSchema.safeParse(two).success).toBe(true);
    expect(two.header?.status?.label).toBe("2 lenses");
  });

  test("one card per lens, preserving the given (newest-first) order", () => {
    const board = buildLensesIndexBoard([
      lens({ id: "newer", board: { view: "board", title: "Newer", sections: [] } }),
      lens({ id: "older", board: { view: "board", title: "Older", sections: [] } }),
    ]);
    expect(cards(board).map((c) => c.title)).toEqual(["Newer", "Older"]);
  });

  test("card title is the authored board title, falling back to the id when untitled", () => {
    const titled = cards(buildLensesIndexBoard([lens()]))[0];
    expect(titled?.title).toBe("Release Risks");
    const untitled = cards(
      buildLensesIndexBoard([lens({ id: "bare", board: { view: "board", sections: [] } })]),
    )[0];
    expect(untitled?.title).toBe("bare");
  });

  test("each card dot is a valid tone, deterministic from the id (distinct ids → may differ)", () => {
    const board = buildLensesIndexBoard([lens({ id: "alpha" }), lens({ id: "beta" })]);
    for (const c of cards(board)) expect(TONES).toContain(c.dot as CanvasTone);
    // Deterministic: the same id always hashes to the same tone.
    const a1 = cards(buildLensesIndexBoard([lens({ id: "alpha" })]))[0]?.dot;
    const a2 = cards(buildLensesIndexBoard([lens({ id: "alpha" })]))[0]?.dot;
    expect(a1).toBe(a2 as CanvasTone);
  });

  test("with no provenance, the only field is an `updated … ago` freshness — no pill/by/reason", () => {
    const card = cards(buildLensesIndexBoard([lens()]))[0];
    expect(card?.fields).toHaveLength(1);
    expect(card?.fields?.[0]?.label).toBe("updated");
    expect(String(card?.fields?.[0]?.value)).toMatch(/ ago$/);
    // Fail-soft: an emit of just { id, board } leaves provenance absent.
    const labels = card?.fields?.map((f) => f.label) ?? [];
    expect(labels).not.toContain("by");
    expect(card?.pill).toBeUndefined();
    expect(card?.reason).toBeUndefined();
  });

  test("scope → an info pill; maintainingMind → a `by` field; reason → a `changed:` reason line", () => {
    const board = buildLensesIndexBoard([
      lens({ id: "loaded", scope: "checklist", maintainingMind: "ada", reason: "budget cut" }),
    ]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const card = cards(board)[0];
    expect(card?.pill).toEqual({ label: "checklist", tone: "info" });
    const by = card?.fields?.find((f) => f.label === "by");
    expect(by?.value).toBe("ada");
    // "by" leads, freshness follows.
    expect(card?.fields?.[0]?.label).toBe("by");
    expect(card?.fields?.at(-1)?.label).toBe("updated");
    expect(card?.reason).toEqual({ label: "changed", text: "budget cut" });
  });

  test("each provenance bit is independent — present ones render, absent ones omit", () => {
    // Only maintainingMind present: a `by` field, but no pill, no reason.
    const onlyBy = cards(
      buildLensesIndexBoard([lens({ id: "by-only", maintainingMind: "ada" })]),
    )[0];
    expect(onlyBy?.fields?.map((f) => f.label)).toEqual(["by", "updated"]);
    expect(onlyBy?.pill).toBeUndefined();
    expect(onlyBy?.reason).toBeUndefined();
    // Only scope present: a pill, but the lone field is still freshness.
    const onlyScope = cards(
      buildLensesIndexBoard([lens({ id: "scope-only", scope: "timeline" })]),
    )[0];
    expect(onlyScope?.pill).toEqual({ label: "timeline", tone: "info" });
    expect(onlyScope?.fields).toHaveLength(1);
    expect(onlyScope?.fields?.[0]?.label).toBe("updated");
    expect(onlyScope?.reason).toBeUndefined();
  });

  test("Open is the FIRST action — non-destructive, no confirm, payload { id }", () => {
    const actions = cards(buildLensesIndexBoard([lens({ id: "release-risks" })]))[0]?.actions ?? [];
    const open = actions[0];
    expect(open).toMatchObject({
      type: "lens-open",
      label: "Open",
      glyph: "↗",
      payload: { id: "release-risks" },
    });
    // Non-destructive: no destructive flag, no confirm gate.
    expect(open?.destructive).toBeUndefined();
    expect(open?.confirm).toBeUndefined();
  });

  test("Retire follows — a destructive overflow action with a typed irreversible confirm", () => {
    const actions = cards(buildLensesIndexBoard([lens({ id: "release-risks" })]))[0]?.actions ?? [];
    expect(actions).toHaveLength(2);
    const retire = actions.find((a) => a.type === "retire-lens");
    expect(retire).toMatchObject({
      type: "retire-lens",
      label: "Retire lens…",
      glyph: "✕",
      tone: "warn",
      destructive: true,
      payload: { id: "release-risks" },
    });
    expect(retire?.confirm?.irreversible).toBe(true);
    expect(retire?.confirm?.subject).toBe("release-risks");
    expect(retire?.confirm?.confirmLabel).toBe("Retire");
    expect(retire?.confirm?.cancelLabel).toBe("Cancel");
  });

  test("the id rides the serialized board on both action payloads (guards collect-lenses toContain)", () => {
    const board = buildLensesIndexBoard([lens({ id: "lens-xyz" })]);
    expect(JSON.stringify(board)).toContain("lens-xyz");
    const actions = cards(board)[0]?.actions ?? [];
    for (const a of actions) expect((a.payload as { id: string }).id).toBe("lens-xyz");
  });
});
