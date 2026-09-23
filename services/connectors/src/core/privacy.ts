import { createHmac } from "node:crypto";

/**
 * Personal details are removed before anything is written to BigQuery. Where
 * we still need to count distinct people (returning campers, repeat
 * customers), the identifier is replaced with a keyed hash. The key lives in
 * Secret Manager, so hashes can't be reversed by guessing known emails.
 */
export function pseudonymize(value: string | null | undefined, key: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (!key || key.length < 32) throw new Error("PSEUDONYMIZATION_KEY must be at least 32 characters");
  return createHmac("sha256", key).update(value.trim().toLowerCase()).digest("hex");
}

/**
 * Keep only allow-listed fields. Allow-listing (rather than deleting known PII
 * fields) means a new column added to a source report is dropped by default
 * until someone decides it is safe.
 */
export function pickAllowed<T extends Record<string, unknown>>(row: T, allowed: readonly string[]): Partial<T> {
  const out: Partial<T> = {};
  for (const key of allowed) {
    if (key in row) (out as Record<string, unknown>)[key] = row[key];
  }
  return out;
}
