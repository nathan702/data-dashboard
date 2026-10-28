import type {
  AssignmentRow,
  AssignmentUpdate,
  BusinessLineOrUnassigned,
  EnrollmentBreakdownQuery,
  EnrollmentMapQuery,
  EnrollmentMapResponse,
  EnrollmentBreakdownResponse,
  EnrollmentSeason,
  EnrollmentSummaryQuery,
  EnrollmentSummaryResponse,
  InventoryResponse,
  IsoDate,
  RetailBreakdownQuery,
  RetailBreakdownResponse,
  RetailKpiQuery,
  RetailKpiResponse,
  RetailSource,
  ProgramFamilySettings,
  SchoolSpelling,
  ReportResult,
  ReportSpec,
  RevenueQuery,
  RevenueSummaryResponse,
  SeasonCalendar,
  Source,
  SourceFreshness,
} from "@dash/shared";
import type { SchoolMap } from "./reportSql.js";
import type { ReferenceTotals } from "../selfCheck.js";

export interface Warehouse {
  /** `seasons` decides "By season" buckets. */
  revenueSummary(q: RevenueQuery, seasons: SeasonCalendar): Promise<RevenueSummaryResponse>;
  retailKpis(source: RetailSource, q: RetailKpiQuery): Promise<RetailKpiResponse>;
  retailBreakdown(source: RetailSource, q: RetailBreakdownQuery): Promise<RetailBreakdownResponse>;
  shopifyInventory(): Promise<InventoryResponse>;
  /** Every assignable value with its effective business line; saved-but-not-yet-applied choices included. */
  assignments(): Promise<{ rows: AssignmentRow[]; pendingRefresh: boolean }>;
  saveAssignments(changes: AssignmentUpdate["changes"], by: string): Promise<void>;
  enrollmentSeasons(businessLine: BusinessLineOrUnassigned | undefined): Promise<EnrollmentSeason[]>;
  /** `seasons` is Campminder's calendar (where each season starts, for pace and comparisons). */
  enrollmentSummary(q: EnrollmentSummaryQuery, seasons: SeasonCalendar): Promise<EnrollmentSummaryResponse>;
  enrollmentMap(q: EnrollmentMapQuery): Promise<EnrollmentMapResponse>;
  enrollmentBreakdown(q: EnrollmentBreakdownQuery): Promise<EnrollmentBreakdownResponse>;
  /** Report builder: run one report (program families decide the family fields). */
  runReport(spec: ReportSpec, families: ProgramFamilySettings, schools?: SchoolMap): Promise<ReportResult>;
  /** Every Campminder program with its enrolled sessions, for Settings → Program families. */
  programList(): Promise<Array<{ program: string; enrollments: number }>>;
  /** Every school spelling with its enrolled campers (all seasons), for Settings → Schools and report grouping. */
  schoolList(): Promise<SchoolSpelling[]>;
  /** Plain totals straight from the tables, for the deploy self-check. */
  referenceTotals(start: string, end: string): Promise<ReferenceTotals>;
}

export interface FreshnessSource {
  freshness(): Promise<SourceFreshness[]>;
}

/** One row of marts.fct_revenue_daily for a single date basis. */
export interface DailyRevenueRow {
  businessLine: BusinessLineOrUnassigned;
  source: Source;
  date: IsoDate;
  gross: number;
  discounts: number;
  refunds: number;
  fees: number;
  transactions: number;
}
