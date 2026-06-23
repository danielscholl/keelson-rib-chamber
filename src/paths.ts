import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ribDataDir } from "@keelson/shared/paths";

// The Chamber data home — the rib's data directory under the keelson home,
// captured once at activation from ctx.getDataDir() (setChamberDataHome) so every
// in-process reader (genesis write, room store, soul reads, auth probe) and the
// baked-in roster bash node resolve the identical path, cwd-independently. The
// fallback, ribDataDir("chamber"), is the same per-rib path the host's getDataDir
// seam returns, covering a harness predating the seam or an out-of-process caller
// with no captured value.
let dataHome: string | undefined;

export function setChamberDataHome(dir: string | undefined): void {
  dataHome = dir;
}

export function chamberDataHome(): string {
  return dataHome ?? ribDataDir("chamber");
}

export function mindsDir(): string {
  return join(chamberDataHome(), "minds");
}

export function roomsDir(): string {
  return join(chamberDataHome(), "rooms");
}

export function lensesDir(): string {
  return join(chamberDataHome(), "lenses");
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
