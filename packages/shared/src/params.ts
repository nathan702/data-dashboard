import { z } from "zod";

/**
 * Drill-down filters travel as one JSON query parameter, e.g.
 * ?filters={"category":["Produce"]}. Missing or empty means no filters.
 */
export function jsonQueryParam<T extends z.ZodType>(schema: T) {
  return z
    .preprocess((v) => {
      if (v === undefined || v === "") return {};
      if (typeof v !== "string") return v;
      try {
        return JSON.parse(v);
      } catch {
        return v;
      }
    }, schema)
    .default({} as never);
}

/** The JSON for a filter set, without empty lists; undefined when nothing is filtered. */
export function encodeFilters(f: Record<string, string[] | undefined>): string | undefined {
  const clean = Object.fromEntries(Object.entries(f).filter(([, v]) => v && v.length > 0));
  return Object.keys(clean).length ? JSON.stringify(clean) : undefined;
}
