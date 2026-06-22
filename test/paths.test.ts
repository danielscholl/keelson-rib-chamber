import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { resolveKeelsonHome } from "@keelson/shared/paths";
import { chamberDataHome, mindsDir, roomsDir, setChamberDataHome } from "../src/paths.ts";

describe("chamber data home", () => {
  afterEach(() => setChamberDataHome(undefined));

  test("a captured home wins; minds/ and rooms/ derive from it", () => {
    setChamberDataHome("/srv/.keelson/rib-chamber");
    expect(chamberDataHome()).toBe("/srv/.keelson/rib-chamber");
    expect(mindsDir()).toBe(join("/srv/.keelson/rib-chamber", "minds"));
    expect(roomsDir()).toBe(join("/srv/.keelson/rib-chamber", "rooms"));
  });

  test("falls back to <keelson-home>/rib-chamber when nothing is captured", () => {
    setChamberDataHome(undefined);
    expect(chamberDataHome()).toBe(join(resolveKeelsonHome(), "rib-chamber"));
  });
});
