import { useSearchParams } from "react-router-dom";
import { encodeFilters } from "@dash/shared";
import type { z } from "zod";

export type DrillFilters<D extends string> = Partial<Record<D, string[]>>;

/**
 * Drill-down state kept in the URL (`filtersKey` = JSON filters, `dimKey` =
 * the breakdown shown), so a view can be shared and Back steps out of the
 * last drill. Clicking a value filters to it and moves to the next breakdown
 * in `order` that isn't filtered yet.
 */
export function useDrill<D extends string>(opts: {
  filtersKey: string;
  dimKey: string;
  dimensions: readonly D[];
  order: readonly D[];
  defaultDimension: D;
  schema: z.ZodType<DrillFilters<D>>;
}) {
  const [params, setParams] = useSearchParams();
  let filters: DrillFilters<D> = {};
  try {
    const parsed = opts.schema.safeParse(JSON.parse(params.get(opts.filtersKey) ?? "{}"));
    if (parsed.success) filters = parsed.data;
  } catch {
    // Bad link: show everything.
  }
  const raw = params.get(opts.dimKey) as D | null;
  const dimension: D = raw && opts.dimensions.includes(raw) ? raw : opts.defaultDimension;
  const set = (next: { filters?: DrillFilters<D>; dimension?: D }, push = false) => {
    const p = new URLSearchParams(params);
    if (next.filters) {
      const enc = encodeFilters(next.filters as Record<string, string[] | undefined>);
      if (enc) p.set(opts.filtersKey, enc);
      else p.delete(opts.filtersKey);
    }
    if (next.dimension) p.set(opts.dimKey, next.dimension);
    setParams(p, { replace: !push });
  };
  const drill = (d: D, value: string) => {
    const f = { ...filters, [d]: [value] } as DrillFilters<D>;
    const order = opts.order.filter((x) => opts.dimensions.includes(x));
    const nextDim = order.slice(order.indexOf(d) + 1).find((x) => !f[x]?.length) ?? d;
    set({ filters: f, dimension: nextDim }, true);
  };
  const active = (Object.entries(filters) as Array<[D, string[]]>).filter(([, v]) => v.length > 0);
  return { filters, dimension, set, drill, active };
}
