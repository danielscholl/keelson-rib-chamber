import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertSafeSlug } from "./genesis.ts";
import type { Mind } from "./types.ts";

// File-based Mind persistence (C3 MVP). One directory per Mind under the data
// home's minds/ root; `mind.json` is the structured record the roster reads and
// SOUL.md is the agent-authored founding doc. `mindsRoot` is injected so the
// store is testable against a temp dir and the env-based path resolution stays
// in paths.ts (the only thing the collector and the handler share).

// mind.json — a superset of the room-facing Mind: it also keeps the original
// brief (role/voice) and createdAt for future use and stable ordering.
export interface MindRecord {
  slug: string;
  name: string;
  role: string;
  voice: string;
  persona: string;
  model?: string;
  provider?: string;
  tools?: readonly string[];
  createdAt: string;
}

const SEED_DOCS: Record<string, (r: MindRecord) => string> = {
  "AGENT.md": (r) =>
    `# Operating doctrine — ${r.name}\n\nThis Mind takes one turn at a time inside a Chamber room. Stay in character (see SOUL.md), answer the room, and never assert another speaker's identity.\n`,
  "memory.md": () => "# Working memory\n\n_(empty)_\n",
  "rules.md": () => "# Rules\n\n_(none yet)_\n",
};

export async function scaffoldMind(
  mindsRoot: string,
  record: MindRecord,
  soul: string,
): Promise<void> {
  assertSafeSlug(record.slug);
  const dir = join(mindsRoot, record.slug);
  // Fail closed on collision: a re-genesis under an existing slug would clobber
  // a Mind's authored soul. Refuse and let the caller surface it.
  if (await exists(dir)) throw new Error(`mind '${record.slug}' already exists`);

  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "mind.json"), `${JSON.stringify(record, null, 2)}\n`);
  await writeFile(join(dir, "SOUL.md"), ensureTrailingNewline(soul));
  for (const [file, seed] of Object.entries(SEED_DOCS)) {
    await writeFile(join(dir, file), seed(record));
  }
  await writeFile(
    join(dir, "log.md"),
    `# Log\n\n- ${record.createdAt} — genesis: authored from brief (role: ${record.role}).\n`,
  );
}

// Read every Mind back as the room-facing shape, newest first. Degrades per
// entry: a directory without a parseable mind.json is skipped, not fatal, so one
// corrupt Mind can't blank the whole roster.
export async function readMinds(mindsRoot: string): Promise<Mind[]> {
  let entries: string[];
  try {
    entries = await readdir(mindsRoot);
  } catch {
    return []; // no minds/ yet — nothing has been genesis-ed
  }

  const records: (Mind & { createdAt: string })[] = [];
  for (const slug of entries) {
    try {
      const raw = await readFile(join(mindsRoot, slug, "mind.json"), "utf8");
      const rec = JSON.parse(raw) as Partial<MindRecord>;
      // A cast is compile-time only: validate the shape and take the *directory*
      // name as the authoritative slug. So a drifted/partial mind.json (missing
      // fields, non-string createdAt, slug diverging from the dir) is skipped or
      // corrected here rather than crashing the sort/map and blanking the roster.
      if (typeof rec !== "object" || rec === null) continue;
      if (typeof rec.name !== "string" || typeof rec.persona !== "string") continue;
      records.push({
        slug,
        name: rec.name,
        persona: rec.persona,
        createdAt: typeof rec.createdAt === "string" ? rec.createdAt : "",
        ...(typeof rec.model === "string" && rec.model ? { model: rec.model } : {}),
        ...(typeof rec.provider === "string" && rec.provider ? { provider: rec.provider } : {}),
        ...(Array.isArray(rec.tools) && rec.tools.length > 0
          ? { tools: rec.tools.filter((t): t is string => typeof t === "string") }
          : {}),
      });
    } catch {
      // skip non-Mind dirs / unreadable records
    }
  }

  records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return records.map((r) => ({
    slug: r.slug,
    name: r.name,
    persona: r.persona,
    ...(r.model ? { model: r.model } : {}),
    ...(r.provider ? { provider: r.provider } : {}),
    ...(r.tools && r.tools.length > 0 ? { tools: r.tools } : {}),
  }));
}

// Read a Mind's authored SOUL.md — the founding identity doc — for the room turn
// system prompt. Returns undefined on any miss (no such Mind, empty/unreadable
// file, or unsafe slug) and never throws, so the caller can fall back to the
// roster tagline rather than crash the turn. assertSafeSlug is inside the try so
// an unsafe slug returns undefined (no read) rather than rejecting the await.
export async function readSoul(mindsRoot: string, slug: string): Promise<string | undefined> {
  try {
    assertSafeSlug(slug);
    const text = await readFile(join(mindsRoot, slug, "SOUL.md"), "utf8");
    return text.trim().length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

// Read one of a Mind's authored docs (memory.md, rules.md, log.md) by name, with
// the same fail-soft contract as readSoul: undefined on any miss (no such Mind,
// empty/unreadable file, unsafe slug), never throws. composeMindSystemPrompt
// stacks these into the direct-chat soul prompt.
export async function readMindDoc(
  mindsRoot: string,
  slug: string,
  file: string,
): Promise<string | undefined> {
  try {
    assertSafeSlug(slug);
    const text = await readFile(join(mindsRoot, slug, file), "utf8");
    return text.trim().length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

export async function retireMind(mindsRoot: string, slug: string): Promise<void> {
  assertSafeSlug(slug);
  const dir = join(mindsRoot, slug);
  if (!(await exists(dir))) throw new Error(`mind '${slug}' not found`);
  await rm(dir, { recursive: true, force: true });
}

// stat, not readdir: readdir only succeeds on a directory, so a non-directory
// entry at the path would read as absent and silently bypass the collision /
// not-found guards.
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}
