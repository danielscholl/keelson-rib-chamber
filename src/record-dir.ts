import { rm, stat } from "node:fs/promises";

// Fail-closed removal of a record's directory, shared by the lens and HTML-lens
// stores so the delete contract can't drift: only ENOENT/ENOTDIR mean not-found
// (a permission/I/O error must surface, not masquerade as "gone"), and the path
// must be a directory (never rm a stray file at the id).
export async function deleteRecordDir(dir: string, notFound: () => Error): Promise<void> {
  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(dir);
  } catch (e) {
    if (isNodeError(e) && (e.code === "ENOENT" || e.code === "ENOTDIR")) throw notFound();
    throw e;
  }
  if (!st.isDirectory()) throw notFound();
  await rm(dir, { recursive: true, force: true });
}

// Whether a store holds a record at this id, answered by the DIRECTORY rather than by
// a parse. Every loader here folds an unreadable or torn record to `undefined`, which
// is right for a boot reconcile and wrong for anything that must know an id is FREE:
// probing with a loader lets a damaged record read as absent. "unknown" is the third
// answer that distinction needs — the deleteRecordDir rule, in question form, so a
// permission/I/O error can't masquerade as "gone".
export async function recordDirState(dir: string): Promise<"present" | "absent" | "unknown"> {
  try {
    return (await stat(dir)).isDirectory() ? "present" : "absent";
  } catch (e) {
    if (isNodeError(e) && (e.code === "ENOENT" || e.code === "ENOTDIR")) return "absent";
    return "unknown";
  }
}

export function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
