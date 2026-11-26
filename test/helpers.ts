// A failed tool call is a result with isError (MCP security audit 2026-11-25), not a rejection.
// toolError turns that result back into a rejection carrying its text, so a test can keep
// `await expect(toolError(client.callTool(...))).rejects.toThrow(/reason/)`. A promise that
// rejects on its own (a direct scryfallRequest, an unknown tool) passes through unchanged.
export async function toolError<T>(p: Promise<T>): Promise<T> {
  const r = (await p) as { isError?: boolean; content?: { text?: string }[] };
  if (r && r.isError) throw new Error((r.content ?? []).map((c) => c.text ?? "").join("\n"));
  return r as T;
}
