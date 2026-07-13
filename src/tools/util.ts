import type { ToolContext } from "@keelson/shared";

// Tool results stream to chat as `tool_result` chunks; keep each well under the
// chat context budget. Truncation is signalled, never silent.
export const MAX_TOOL_RESULT_CHARS = 16_000;
export function boundedText(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  const omitted = text.length - MAX_TOOL_RESULT_CHARS;
  return `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n…(truncated — ${omitted} more chars)`;
}
export function emitResult(ctx: ToolContext, content: string, isError = false): void {
  ctx.emit({ type: "tool_result", toolUseId: "", content, ...(isError ? { isError: true } : {}) });
}

// Emit a list payload that stays valid JSON under the tool-result budget: keep rows
// until the next would push the serialized result over the cap, then report the
// omitted count. boundedText would instead truncate the serialized string —
// unparseable JSON exactly when the cap bites — so the list tools use this.
export function emitJsonList<T>(ctx: ToolContext, key: string, rows: readonly T[]): void {
  const build = (kept: readonly T[]): string =>
    JSON.stringify({
      count: rows.length,
      ...(kept.length < rows.length ? { omitted: rows.length - kept.length } : {}),
      [key]: kept,
    });
  let kept: T[] = [];
  for (const row of rows) {
    const next = [...kept, row];
    if (kept.length > 0 && build(next).length > MAX_TOOL_RESULT_CHARS) break;
    kept = next;
  }
  emitResult(ctx, build(kept));
}
