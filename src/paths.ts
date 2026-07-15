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

export function htmlLensesDir(): string {
  return join(chamberDataHome(), "lenses-html");
}

// Operator-authored workflows the rib contributes to the catalog, so a lens can name
// one as its refresh backing: the harness auto-refreshes only a workflow with rib
// provenance, which a file in the global workflows dir can never have. Chamber
// vouches for whatever lands here — a human putting it here is the trust boundary,
// since the name itself arrives from agent-authored lens data.
export function lensWorkflowsDir(): string {
  return join(chamberDataHome(), "lens-workflows");
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
