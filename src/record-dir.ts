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

export function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
