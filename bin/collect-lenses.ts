#!/usr/bin/env bun
/**
 * Lenses-index collector — the producer behind the `chamber-lenses` workflow. Reads
 * the persisted lenses of BOTH species (board lenses and designed HTML pages) AND the
 * Minds under the data home, and prints a canvas board-view JSON object (the index of
 * LIVING views, one card per lens, each dotted in its maintaining Mind's identity
 * tone), and nothing else, to stdout. Degrades to a valid empty index: a missing
 * lenses/ dir (none authored yet) or any read error yields `[]`, never a thrown
 * collector; an unreadable minds dir just folds the dots to neutral.
 */
import { join } from "node:path";
import { buildLensesIndexBoard } from "../src/boards/lenses.ts";
import { listHtmlLenses } from "../src/lens-html-store.ts";
import { isExhibit, listLenses } from "../src/lens-store.ts";
import { discoverLensWorkflows } from "../src/lens-workflows.ts";
import { readMinds } from "../src/minds-store.ts";
import { chamberDataHome } from "../src/paths.ts";

async function main() {
  // The chamber-lenses bash node bakes the resolved data home in as argv[2] (the
  // keelson-home-rooted path the in-process rib captured), so this out-of-process
  // collector derives the lens, html-lens, and minds dirs from it. Fall back to
  // chamberDataHome() for a manual/standalone run.
  const home = process.argv[2]?.trim() || chamberDataHome();
  const activeWorkflowVersions = parseActiveWorkflowVersions(process.argv[3]);
  const [records, minds, htmlLenses] = await Promise.all([
    listLenses(join(home, "lenses")).catch(() => []),
    readMinds(join(home, "minds")).catch(() => []),
    // The second species lives in its own store. It is the ONLY index an HTML lens
    // has, so a read failure here costs those lenses their one reachable card.
    listHtmlLenses(join(home, "lenses-html")).catch(() => []),
  ]);
  // The board store holds both lenses and exhibits; this index is the LENSES shelf
  // only. An exhibit is reached from the room that tabled it, so it has no index of
  // its own.
  const lenses = records.filter((r) => !isExhibit(r));
  const installedWorkflows = new Map(
    discoverLensWorkflows(join(home, "lens-workflows")).workflows.map((workflow) => [
      workflow.name,
      workflow.hash,
    ]),
  );
  const workflowStates: Record<string, "active" | "stale"> = {};
  for (const [name, version] of Object.entries(activeWorkflowVersions)) {
    workflowStates[name] = installedWorkflows.get(name) === version ? "active" : "stale";
  }
  process.stdout.write(
    JSON.stringify(buildLensesIndexBoard(lenses, minds, htmlLenses, workflowStates)),
  );
}

function parseActiveWorkflowVersions(value: string | undefined): Record<string, string> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("expected an object");
    }
    const entries = Object.entries(parsed);
    if (entries.some(([, version]) => typeof version !== "string")) {
      throw new Error("expected string versions");
    }
    return Object.fromEntries(entries) as Record<string, string>;
  } catch (error) {
    console.error(
      `[rib-chamber] active lens workflow versions ignored: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {};
  }
}

await main();
