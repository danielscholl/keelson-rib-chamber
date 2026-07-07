import { describe, expect, test } from "bun:test";
import {
  CAPABILITIES,
  CODING_CAPABILITY_SLUGS,
  EXTERNAL_CAPABILITY_SLUGS,
  capabilityVocabulary,
  codingReviewCapabilityError,
  codingToolPool,
  externalToolPool,
  KNOWN_CAPABILITY_SLUGS,
  resolveMindTools,
} from "../src/capabilities.ts";
import { LENS_TOOL_NAME } from "../src/lens.ts";

const OSDU_TOOL_NAMES = [
  "osdu_quality",
  "osdu_security",
  "osdu_features",
  "osdu_release",
  "osdu_events",
  "osdu_waiting",
  "osdu_cluster",
  "osdu_topology",
];
const OSDU_WRITE_TOOL_NAMES = [
  "osdu_cluster_reconcile",
  "osdu_cluster_suspend",
  "osdu_cluster_resume",
];
const POOL = [{ name: LENS_TOOL_NAME }];
// The ceiling a coding room layers on: base (lens) + the coding built-ins.
const CODING_POOL = [{ name: LENS_TOOL_NAME }, ...codingToolPool()];
const OSDU_POOL = [{ name: LENS_TOOL_NAME }, ...externalToolPool()];

describe("resolveMindTools", () => {
  test("maps a declared slug to its tool name when the pool permits it", () => {
    expect(resolveMindTools({ tools: ["lens"] }, POOL)).toEqual([{ name: LENS_TOOL_NAME }]);
  });

  test("no declaration stays text-only", () => {
    expect(resolveMindTools({}, POOL)).toEqual([]);
    expect(resolveMindTools({ tools: [] }, POOL)).toEqual([]);
  });

  test("an unknown slug resolves to nothing", () => {
    expect(resolveMindTools({ tools: ["bogus"] }, POOL)).toEqual([]);
  });

  test("a raw tool name is not a slug — only the curated vocabulary maps", () => {
    expect(resolveMindTools({ tools: [LENS_TOOL_NAME] }, POOL)).toEqual([]);
  });

  test("a known slug absent from the room pool is dropped — the pool is the ceiling", () => {
    expect(resolveMindTools({ tools: ["lens"] }, [])).toEqual([]);
    expect(resolveMindTools({ tools: ["lens"] }, undefined)).toEqual([]);
  });

  test("repeated slugs dedupe to one entry", () => {
    expect(resolveMindTools({ tools: ["lens", "lens"] }, POOL)).toEqual([{ name: LENS_TOOL_NAME }]);
  });

  test("KNOWN_CAPABILITY_SLUGS mirrors the map keys", () => {
    expect([...KNOWN_CAPABILITY_SLUGS].sort()).toEqual(Object.keys(CAPABILITIES).sort());
    expect(KNOWN_CAPABILITY_SLUGS.has("lens")).toBe(true);
    expect(KNOWN_CAPABILITY_SLUGS.has("osdu")).toBe(true);
  });

  test("capabilityVocabulary lists every known slug with its gloss", () => {
    const doc = capabilityVocabulary();
    for (const slug of KNOWN_CAPABILITY_SLUGS) expect(doc).toContain(slug);
    expect(doc).toContain("lens (");
    expect(doc).toContain("osdu (");
  });
});

describe("coding capability tier", () => {
  test("the `code` slug maps to the write/exec built-ins when the pool permits", () => {
    expect(
      resolveMindTools({ tools: ["code"] }, CODING_POOL)
        .map((t) => t.name)
        .sort(),
    ).toEqual(["Bash", "Edit", "Write"]);
  });

  test("the `read` slug maps to Read", () => {
    expect(resolveMindTools({ tools: ["read"] }, CODING_POOL)).toEqual([{ name: "Read" }]);
  });

  test("read + code together resolve to the full coding rail", () => {
    expect(
      resolveMindTools({ tools: ["read", "code"] }, CODING_POOL)
        .map((t) => t.name)
        .sort(),
    ).toEqual(["Bash", "Edit", "Read", "Write"]);
  });

  test("a coding slug is dropped when the pool is the base (non-coding) pool — the ceiling holds", () => {
    // The room-pool intersection is chamber's allowlist ceiling: a code-declaring
    // Mind in a non-coding room reaches nothing, so the tier is genuinely opt-in.
    expect(resolveMindTools({ tools: ["code"] }, POOL)).toEqual([]);
    expect(resolveMindTools({ tools: ["read", "code"] }, POOL)).toEqual([]);
  });

  test("CODING_CAPABILITY_SLUGS names exactly the filesystem/exec slugs", () => {
    expect([...CODING_CAPABILITY_SLUGS].sort()).toEqual(["code", "read"]);
    // Every coding slug is also a known slug (genesis can declare it).
    for (const slug of CODING_CAPABILITY_SLUGS) expect(KNOWN_CAPABILITY_SLUGS.has(slug)).toBe(true);
  });

  test("codingToolPool is the deduped union of every coding slug's tools, derived from CAPABILITIES", () => {
    expect(
      codingToolPool()
        .map((t) => t.name)
        .sort(),
    ).toEqual(["Bash", "Edit", "Read", "Write"]);
    // Derived, not hand-listed: it can't drift from what the slugs resolve to.
    const fromMap = new Set(
      [...CODING_CAPABILITY_SLUGS].flatMap((s) => [...(CAPABILITIES[s]?.tools ?? [])]),
    );
    expect(new Set(codingToolPool().map((t) => t.name))).toEqual(fromMap);
  });
});

describe("external capability tier", () => {
  test("the `osdu` slug maps to the read-only osdu tools when the pool permits", () => {
    expect(resolveMindTools({ tools: ["osdu"] }, OSDU_POOL)).toEqual(
      OSDU_TOOL_NAMES.map((name) => ({ name })),
    );
  });

  test("the `osdu` slug is dropped when the pool omits osdu tools", () => {
    expect(resolveMindTools({ tools: ["osdu"] }, POOL)).toEqual([]);
  });

  test("a non-osdu Mind cannot reach osdu tools from the external pool", () => {
    expect(resolveMindTools({ tools: ["lens"] }, OSDU_POOL)).toEqual([{ name: LENS_TOOL_NAME }]);
  });

  test("CAPABILITIES.osdu is pinned to the read-only osdu tool names", () => {
    expect(CAPABILITIES.osdu.tools).toEqual(OSDU_TOOL_NAMES);
    for (const name of OSDU_WRITE_TOOL_NAMES) {
      expect(CAPABILITIES.osdu.tools).not.toContain(name);
    }
    for (const name of CAPABILITIES.osdu.tools) expect(name.startsWith("osdu_")).toBe(true);
  });

  test("EXTERNAL_CAPABILITY_SLUGS drives externalToolPool from CAPABILITIES", () => {
    expect([...EXTERNAL_CAPABILITY_SLUGS].sort()).toEqual(["osdu"]);
    for (const slug of EXTERNAL_CAPABILITY_SLUGS) {
      expect(KNOWN_CAPABILITY_SLUGS.has(slug)).toBe(true);
    }
    const fromMap = new Set(
      [...EXTERNAL_CAPABILITY_SLUGS].flatMap((s) => [...(CAPABILITIES[s]?.tools ?? [])]),
    );
    expect(new Set(externalToolPool().map((t) => t.name))).toEqual(fromMap);
  });
});

describe("codingReviewCapabilityError", () => {
  const author = { slug: "author", tools: ["code"] };
  const reviewerRead = { slug: "reviewer", tools: ["read"] };

  test("passes when the author has `code` and the reviewer has `read`", () => {
    expect(codingReviewCapabilityError(author, reviewerRead)).toBeNull();
  });

  test("passes when the reviewer has `code` (which can read and run)", () => {
    expect(codingReviewCapabilityError(author, { slug: "reviewer", tools: ["code"] })).toBeNull();
  });

  test("rejects an author that can't edit, naming the author", () => {
    const err = codingReviewCapabilityError({ slug: "scribe", tools: ["read"] }, reviewerRead);
    expect(err).toContain("scribe");
    expect(err).toContain("`code`");
  });

  test("rejects an author with no declared tools at all", () => {
    expect(codingReviewCapabilityError({ slug: "scribe" }, reviewerRead)).toContain("scribe");
  });

  test("rejects a reviewer that can neither read nor code, naming the reviewer", () => {
    const err = codingReviewCapabilityError(author, { slug: "critic", tools: ["lens"] });
    expect(err).toContain("critic");
    expect(err).toContain("`read`");
  });
});
