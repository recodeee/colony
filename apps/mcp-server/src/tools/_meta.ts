/**
 * Shared metadata parsing helper for MCP tool handlers.
 *
 * Raw metadata columns come from SQLite as `string | null`. A corrupt or
 * non-object value must never break a handler — callers get `{}` instead.
 */
export function parseMeta(raw: string | null | undefined): Record<string, unknown> {
  if (typeof raw !== 'string' || raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
