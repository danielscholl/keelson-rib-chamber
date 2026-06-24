#!/usr/bin/env node
// Guards the docs against the two drift classes a build alone does not catch:
// LLM-output corruption (angle-bracket placeholders the generator strips, leaving
// blank commands) and stale claims that fall out of sync with the rib source
// (renamed strategies/workflows/keys, retired terms). Run after `astro build`,
// against docs/dist/llms-full.txt and the rib's src/.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const docsDir = join(scriptDir, "..");
const repoRoot = join(docsDir, "..");
const distLlms = join(docsDir, "dist", "llms-full.txt");
const contentDir = join(docsDir, "src", "content", "docs");
const archFile = join(docsDir, "ARCHITECTURE.md");
const strategiesDir = join(repoRoot, "src", "strategies");

const failures = [];
const fail = (msg) => failures.push(msg);

// --- gather inputs -----------------------------------------------------------

if (!existsSync(distLlms)) {
  console.error(`check-docs-drift: ${relative(repoRoot, distLlms)} missing — run \`bun run build\` first.`);
  process.exit(1);
}
const llms = readFileSync(distLlms, "utf8");

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.mdx?$/.test(entry.name)) out.push(full);
  }
  return out;
}
const sourceDocs = [...walk(contentDir), archFile].filter(existsSync);

// --- 1. obsolete terms (source pages + generated output) ---------------------

const FORBIDDEN = [
  [/\broom-next\b/, 'obsolete term "room-next"'],
  [/\bStart room\b/, 'obsolete control name "Start room" (use "Convene")'],
  [/rib:chamber:room(?![:\w-])/, 'singular "rib:chamber:room" key — rooms are per-slug ("rib:chamber:room:{slug}")'],
];

function scanLines(label, text) {
  const lines = text.split("\n");
  for (const [re, msg] of FORBIDDEN) {
    lines.forEach((line, i) => {
      if (re.test(line)) fail(`${label}:${i + 1}: ${msg} — ${line.trim()}`);
    });
  }
}
for (const file of sourceDocs) scanLines(relative(repoRoot, file), readFileSync(file, "utf8"));
scanLines("dist/llms-full.txt", llms);

// --- 2. angle-bracket placeholders left in source ----------------------------

const ANGLE = /<(id|slug|brief|keelson-home|name|subject|who|topic|turnBudget)>/;
for (const file of sourceDocs) {
  readFileSync(file, "utf8").split("\n").forEach((line, i) => {
    if (ANGLE.test(line)) {
      fail(`${relative(repoRoot, file)}:${i + 1}: angle-bracket placeholder (use curly form, e.g. {slug}) — ${line.trim()}`);
    }
  });
}

// --- 3. stripped-placeholder symptoms in the generated output ----------------

if (/rib:chamber:(room|lens|room-view):(?![\w{])/.test(llms)) {
  fail('dist/llms-full.txt: a per-instance key lost its placeholder (e.g. "rib:chamber:lens:" with nothing after) — the generator stripped an angle-bracket placeholder.');
}
if (/chamber-(lens|genesis)\s+""/.test(llms)) {
  fail('dist/llms-full.txt: an empty command argument (e.g. chamber-lens "") — a placeholder was stripped from a code sample.');
}

// --- 4. documented sets match the source ------------------------------------

if (existsSync(strategiesDir)) {
  const strategies = readdirSync(strategiesDir)
    .filter((f) => f.endsWith(".ts") && f !== "index.ts")
    .map((f) => f.replace(/\.ts$/, ""));
  for (const name of strategies) {
    if (!llms.includes(name)) fail(`strategy "${name}" exists in src/strategies/ but is not documented in llms-full.txt.`);
  }
} else {
  console.warn(`check-docs-drift: ${relative(repoRoot, strategiesDir)} not found — skipping strategy cross-check.`);
}

const WORKFLOWS = ["chamber-roster", "chamber-rooms", "chamber-lenses", "chamber-genesis", "chamber-lens"];
for (const wf of WORKFLOWS) {
  if (!llms.includes(wf)) fail(`workflow "${wf}" is not documented in llms-full.txt.`);
}

const KEYS = [
  "rib:chamber:roster",
  "rib:chamber:rooms",
  "rib:chamber:lenses",
  "rib:chamber:brief",
  "rib:chamber:room:{slug}",
  "rib:chamber:lens:{id}",
  "rib:chamber:room-view:{slug}",
];
for (const key of KEYS) {
  if (!llms.includes(key)) fail(`snapshot key "${key}" is not documented in llms-full.txt.`);
}

// --- report ------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`\ncheck-docs-drift: ${failures.length} issue(s) found:\n`);
  for (const f of failures) console.error(`  - ${f}`);
  console.error("");
  process.exit(1);
}

console.log(
  `check-docs-drift: ok (${sourceDocs.length} source pages, ${WORKFLOWS.length} workflows, ${KEYS.length} keys checked; no stripped placeholders or obsolete terms).`,
);
