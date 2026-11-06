import { createHash } from "node:crypto";
import { pseudonymize } from "../core/privacy.js";
import { parseWeek, usDate } from "./campminderParse.js";

/**
 * Turns Campminder's "Financial" tab (one row per transaction) into stored
 * transactions, keeping only allow-listed fields: never names, card details,
 * check or deposit numbers, or the free-text descriptions (which often name
 * people). Person and household ids are stored as the same keyed hashes as
 * the camper data, so the two can be joined.
 */

/** Bump when parsing changes what's stored: the tab is re-read and every row rewritten. */
export const FINANCE_PARSER_VERSION = "1";

export interface CampminderTransaction {
  /** Campminder's transaction id; a reversal is the original's id + "R". */
  transactionId: string;
  season: number;
  /** "debit", "credit", "payment", "refund", "balance to/from", "credit to/from" (lower case). */
  type: string;
  /** Financial category ("Summer Camp", "CHAPS"…); null when blank. */
  category: string | null;
  postDate: string | null;
  effectiveDate: string | null;
  reversalDate: string | null;
  /** This transaction was later reversed. */
  isReversed: boolean;
  /** This row is the reversal of another (its id ends in "R"). */
  isReversal: boolean;
  quantity: number | null;
  unitAmount: number | null;
  /** As Campminder shows it (sign included). */
  amount: number | null;
  /** Credit Card, Check, ACH… (no card or check details). */
  method: string | null;
  serviceStart: string | null;
  serviceEnd: string | null;
  sessionName: string | null;
  /** Session name without its week, as for enrollments ("Farm Week 9" → "Farm"); what business lines are assigned by. */
  sessionGroup: string | null;
  /** Campminder's own session group name. */
  campminderSessionGroup: string | null;
  program: string | null;
  personHash: string | null;
  familyHash: string | null;
  /** Amount of the transaction this one applies to (a payment's charge, a refund's payment). */
  affectedAmount: number | null;
  rowHash: string;
}

const clean = (v: string | undefined) => {
  const t = (v ?? "").trim();
  return t && t !== "Undefined" ? t : null;
};

/** "7/4/2026" or "7/4/2026 3:15 PM" → "2026-07-04". */
export function finDate(v: string | undefined): string | null {
  return usDate((v ?? "").trim().split(/\s+/)[0]);
}

/** "$1,234.50", "-$50.00", "($50.00)", "1234.5" → number; anything else → null. */
export function money(v: string | undefined): number | null {
  const t = (v ?? "").trim();
  if (!t) return null;
  const negative = /^\(.*\)$/.test(t) || t.includes("-");
  const digits = t.replace(/[^0-9.]/g, "");
  if (!digits || !/^\d*\.?\d*$/.test(digits)) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? Math.round((negative ? -n : n) * 100) / 100 : null;
}

const yes = (v: string | undefined) => /^(true|yes|y|1)$/i.test((v ?? "").trim());

/** The Financial tab has the columns this parser reads. */
export function isFinancialTab(headers: string[]): boolean {
  const h = new Set(headers.map((x) => x.trim()));
  return h.has("ID") && h.has("Transaction Type") && h.has("Amount") && h.has("Season");
}

/** Convert Financial tab rows (header → value) into transactions. Only the fields on CampminderTransaction leave this function. */
export function toTransactions(rows: Array<Record<string, string>>, key: string): CampminderTransaction[] {
  const out = new Map<string, CampminderTransaction>();
  for (const r of rows) {
    const id = clean(r["ID"]);
    const season = Number(clean(r["Season"]));
    const type = clean(r["Transaction Type"])?.toLowerCase() ?? null;
    if (!id || !type || !Number.isInteger(season) || season < 2000) continue;
    const sessionName = clean(r["Session Name"]);
    const row = {
      transactionId: id,
      season,
      type,
      category: clean(r["Financial Category"]),
      postDate: finDate(r["Post Date"]),
      effectiveDate: finDate(r["Effective Date"]),
      reversalDate: finDate(r["Reversal Date"]),
      isReversed: yes(r["Is Reversed"]),
      isReversal: /R$/i.test(id),
      quantity: money(r["Quantity"]),
      unitAmount: money(r["Unit Amount"]),
      amount: money(r["Amount"]),
      method: clean(r["Payment/Refund Method"]),
      serviceStart: finDate(r["Service Start Date"]),
      serviceEnd: finDate(r["Service End Date"]),
      sessionName,
      sessionGroup: sessionName ? parseWeek(sessionName).group : null,
      campminderSessionGroup: clean(r["Session Group Name"]),
      program: clean(r["Program Name"]),
      personHash: pseudonymize(clean(r["Person ID"]), key),
      familyHash: pseudonymize(clean(r["Household ID"]), key),
      affectedAmount: money(r["Affected On Transaction Amount"]),
    };
    out.set(id, { ...row, rowHash: createHash("sha256").update(`${FINANCE_PARSER_VERSION}|${JSON.stringify(row)}`).digest("hex").slice(0, 16) });
  }
  return [...out.values()];
}

/** Counts and sums by transaction type, for the sync log (no per-family detail). */
export function transactionSummary(txs: CampminderTransaction[]) {
  const by: Record<string, { rows: number; positive: number; negative: number; withSession: number; reversed: number }> = {};
  for (const t of txs) {
    const s = (by[t.type] ??= { rows: 0, positive: 0, negative: 0, withSession: 0, reversed: 0 });
    s.rows++;
    if ((t.amount ?? 0) > 0) s.positive = Math.round((s.positive + t.amount!) * 100) / 100;
    if ((t.amount ?? 0) < 0) s.negative = Math.round((s.negative + t.amount!) * 100) / 100;
    if (t.sessionName) s.withSession++;
    if (t.isReversed || t.isReversal) s.reversed++;
  }
  return by;
}
