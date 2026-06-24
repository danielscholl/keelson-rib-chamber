import { describe, expect, test } from "bun:test";
import { relativeAgo } from "../src/relative-time.ts";

const NOW = Date.parse("2026-06-24T12:00:00.000Z");
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

describe("relativeAgo", () => {
  test("a sub-minute span reads 'just now'", () => {
    expect(relativeAgo(ago(0), NOW)).toBe("just now");
    expect(relativeAgo(ago(59_000), NOW)).toBe("just now");
  });

  test("floors to the largest whole unit and pluralizes", () => {
    expect(relativeAgo(ago(MIN), NOW)).toBe("1 minute");
    expect(relativeAgo(ago(2 * MIN), NOW)).toBe("2 minutes");
    expect(relativeAgo(ago(HOUR), NOW)).toBe("1 hour");
    expect(relativeAgo(ago(5 * HOUR), NOW)).toBe("5 hours");
    expect(relativeAgo(ago(DAY), NOW)).toBe("1 day");
    expect(relativeAgo(ago(3 * DAY), NOW)).toBe("3 days");
  });

  test("an unparseable or future timestamp degrades to 'just now'", () => {
    expect(relativeAgo("not-a-date", NOW)).toBe("just now");
    expect(relativeAgo(new Date(NOW + HOUR).toISOString(), NOW)).toBe("just now");
  });
});
