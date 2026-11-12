import { z } from "zod";
import { BUSINESS_LINES, type BusinessLine } from "./businessLines.js";

/** HubSpot deals for one business line: the open pipeline by stage, and won deals by month. */
export const hubspotDealsQuerySchema = z.object({ businessLine: z.enum(BUSINESS_LINES) });
export type HubspotDealsQuery = z.infer<typeof hubspotDealsQuerySchema>;

export interface HubspotStageRow {
  pipeline: string;
  stage: string;
  stageOrder: number | null;
  deals: number;
  amount: number;
}

export interface HubspotMonthRow {
  /** First day of the month the deals closed (won). */
  month: string;
  deals: number;
  amount: number;
}

export interface HubspotDealsResponse {
  businessLine: BusinessLine;
  /** Open deals (not closed), by pipeline and stage. */
  open: HubspotStageRow[];
  /** Won deals by close month, the last 24 months. */
  won: HubspotMonthRow[];
}
