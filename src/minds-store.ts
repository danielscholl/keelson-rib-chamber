import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

  const records: MindRecord[] = [];
  for (const slug of entries) {
    try {
      const raw = await readFile(join(mindsRoot, slug, "mind.json"), "utf8");
      records.push(JSON.parse(raw) as MindRecord);
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
    ...(r.tools && r.tools.length > 0 ? { tools: r.tools } : {}),
  }));
}

export async function retireMind(mindsRoot: string, slug: string): Promise<void> {
  assertSafeSlug(slug);
  const dir = join(mindsRoot, slug);
  if (!(await exists(dir))) throw new Error(`mind '${slug}' not found`);
  await rm(dir, { recursive: true, force: true });
}

async function exists(path: string): Promise<boolean> {
  try {
    await readdir(path);
    return true;
  } catch {
    return false;
  }
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}
