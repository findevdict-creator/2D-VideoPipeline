/**
 * Rows come back from SQLite with snake_case columns and JSON as text. This turns
 * { target_duration_sec: 90, settings_json: "{...}" } into { targetDurationSec: 90, settings: {...} }.
 */
export function fromRow<T>(row: Record<string, unknown> | undefined): T | undefined {
  if (!row) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const isJson = key.endsWith("_json");
    const name = (isJson ? key.slice(0, -5) : key).replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    out[name] = isJson ? (value == null ? null : JSON.parse(value as string)) : value;
  }
  return out as T;
}

export function fromRows<T>(rows: Record<string, unknown>[]): T[] {
  return rows.map((r) => fromRow<T>(r)!);
}
