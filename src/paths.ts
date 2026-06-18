import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Resolve the Chamber data home cwd-independently. The in-process genesis
// handler (server cwd) and the out-of-process roster collector (a workflow bash
// node whose refresh cwd is nominal) must agree on this path; both read the
// same inherited KEELSON_WORKSPACE, so both compute the same home. Mirrors the
// base server's workspace root (apps/server/src/index.ts). This is the C3 MVP —
// it collapses to a blessed ctx.getDataDir() once that base seam lands.
export function chamberDataHome(): string {
  const workspace = resolve(process.env.KEELSON_WORKSPACE?.trim() || join(homedir(), "keelson"));
  return join(workspace, ".keelson", "chamber");
}

export function mindsDir(): string {
  return join(chamberDataHome(), "minds");
}

export function roomsDir(): string {
  return join(chamberDataHome(), "rooms");
}

// Recursive mkdir doubles as a writability probe — idempotent if the dir exists
// (genesis creates it anyway), and fails only when the path isn't writable.
export async function isChamberDataHomeWritable(): Promise<boolean> {
  try {
    await mkdir(chamberDataHome(), { recursive: true });
    return true;
  } catch {
    return false;
  }
}
