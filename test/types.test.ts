import { describe, expect, test } from "bun:test";
import { IDENTITY_SLOT_COUNT, identityToneForSlot, nextFreeSlot } from "../src/types.ts";

describe("nextFreeSlot", () => {
  test("an empty roster takes slot 0", () => {
    expect(nextFreeSlot([])).toBe(0);
  });

  test("takes the lowest slot not already worn (next-free, not count-based)", () => {
    expect(nextFreeSlot([{ identitySlot: 0 }, { identitySlot: 1 }])).toBe(2);
  });

  test("fills a GAP a churned roster left — the collision fix", () => {
    // Slots 0 and 2 seated; a count-based allocator would pick 2 (the count) and
    // double-seat it. Next-free picks the gap at 1.
    expect(nextFreeSlot([{ identitySlot: 0 }, { identitySlot: 2 }])).toBe(1);
  });

  test("honors a free preferred slot (a starter's own hue)", () => {
    expect(nextFreeSlot([{ identitySlot: 0 }], 2)).toBe(2);
  });

  test("falls back to next-free when the preferred slot is taken", () => {
    expect(nextFreeSlot([{ identitySlot: 0 }, { identitySlot: 2 }], 0)).toBe(1);
  });

  test("a Mind with no valid slot occupies nothing", () => {
    expect(nextFreeSlot([{}, { identitySlot: 99 }, { identitySlot: -1 }])).toBe(0);
  });

  test("a full ramp overflows to IDENTITY_SLOT_COUNT (neutral, not an invented hue)", () => {
    const full = [0, 1, 2, 3, 4].map((identitySlot) => ({ identitySlot }));
    expect(nextFreeSlot(full)).toBe(IDENTITY_SLOT_COUNT);
    // The overflow index folds to neutral, never a status hue.
    expect(identityToneForSlot(nextFreeSlot(full))).toBe("neutral");
  });
});
