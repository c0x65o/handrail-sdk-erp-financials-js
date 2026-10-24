import { createHash } from "node:crypto";
import type { ErpFinancialsTransactionRunner } from "./erp-financials-service.js";
import { ErpFinancialsError } from "./sdk-errors.js";

export type ReportingCalendarRequest = { readonly sourceId: string; readonly year: number };
export type ReportingCalendarPeriod = {
  readonly fiscalPeriodId: string; readonly fiscalYear: number; readonly periodNumber: number;
  readonly periodStart: string; readonly periodEnd: string; readonly status: "open" | "closing" | "closed";
  readonly version: number; readonly canonicalCloseCertificateId?: string;
};
export type ReportingCalendarMonth = {
  readonly month: string; readonly periodStart: string; readonly periodEnd: string;
  /** A calendar month may intersect multiple fiscal periods. Mixed or incomplete
   * coverage is never represented as one open/closed accounting period. */
  readonly status: "open" | "closing" | "closed" | "mixed" | "unconfigured";
  readonly days: { readonly open: number; readonly closing: number; readonly closed: number; readonly unconfigured: number };
  readonly fiscalPeriodIds: readonly string[];
};
export type ReportingCalendar = {
  readonly tenantId: string; readonly companyId: string; readonly bookId: string; readonly sourceId: string;
  readonly year: number; readonly revision: string;
  readonly months: readonly ReportingCalendarMonth[]; readonly periods: readonly ReportingCalendarPeriod[];
};
type Scope = { readonly tenantId: string; readonly companyId: string; readonly bookId: string; readonly database: ErpFinancialsTransactionRunner };
const fail = (message: string): never => { throw new ErpFinancialsError("invalid_input", message); };
function iso(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return fail("Invalid stored calendar date");
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0,10)!==value) return fail("Invalid stored calendar date");
  return value;
}

/** Bounded, one-SQL-snapshot reporting metadata. Never authorizes a posting or
 * close/reopen command; those commands revalidate under their own locks. */
export async function readReportingCalendar(scope: Scope, input: ReportingCalendarRequest): Promise<ReportingCalendar> {
  const { sourceId, year } = input;
  if (!Number.isSafeInteger(year) || year < 1 || year > 9999 || typeof sourceId !== "string" || !sourceId.trim() || sourceId.length > 500) fail("Invalid reporting calendar scope");
  const prefix=String(year).padStart(4,"0"),start=`${prefix}-01-01`,end=`${prefix}-12-31`;
  return scope.database.transaction(async client => {
    const {rows:[row]}=await client.query(`select book.status book_status,source.source_id,
      source.effective_from::text effective_from,source.effective_through::text effective_through,
      coalesce((select jsonb_agg(item order by item->>'periodStart',item->>'fiscalPeriodId') from (
        select jsonb_build_object('fiscalPeriodId',p.fiscal_period_id,'fiscalYear',p.fiscal_year,'periodNumber',p.period_number,
          'periodStart',p.period_start::text,'periodEnd',p.period_end::text,'status',p.status,'version',p.version,
          'canonicalCloseCertificateId',event.payload->>'canonicalCloseCertificateId') item
        from erp_financials.fiscal_periods p left join erp_financials.financial_lifecycle_events event
          on event.tenant_id=p.tenant_id and event.company_id=p.company_id and event.source_id=p.source_id and event.event_id=p.close_event_id
        where p.tenant_id=$1 and p.company_id=$2 and p.source_id=source.source_id
          and p.period_start<=$6::date and p.period_end>=$5::date
        order by p.period_start,p.fiscal_period_id limit 367
      ) bounded),'[]'::jsonb) periods
      from erp_financials.reporting_books book left join erp_financials.reporting_book_sources source
        on source.tenant_id=book.tenant_id and source.company_id=book.company_id and source.book_id=book.book_id and source.source_id=$4
      where book.tenant_id=$1 and book.company_id=$2 and book.book_id=$3`,
    [scope.tenantId,scope.companyId,scope.bookId,sourceId,start,end]);
    if (!row) throw new ErpFinancialsError("missing_book","Reporting calendar book is unavailable");
    if (row.book_status!=="active") throw new ErpFinancialsError("terminal_state_conflict","Reporting calendar book is not active");
    if (row.source_id!==sourceId) throw new ErpFinancialsError("missing_document","Reporting calendar source is not in this book");
    const effectiveFrom=row.effective_from===null?null:iso(row.effective_from),effectiveThrough=row.effective_through===null?null:iso(row.effective_through);
    if (!Array.isArray(row.periods) || row.periods.length>366) return fail("Reporting calendar contains too many overlapping periods");
    const periods:ReportingCalendarPeriod[]=row.periods.map((value:unknown)=>{
      if (!value || typeof value!=="object") return fail("Invalid reporting calendar period");
      const p=value as Record<string,unknown>,periodStart=iso(p.periodStart),periodEnd=iso(p.periodEnd);
      if (typeof p.fiscalPeriodId!=="string" || !p.fiscalPeriodId || !Number.isSafeInteger(p.fiscalYear) || !Number.isSafeInteger(p.periodNumber)
        || Number(p.fiscalYear)<1 || Number(p.periodNumber)<1 || Number(p.periodNumber)>366
        || !Number.isSafeInteger(p.version) || Number(p.version)<1 || !["open","closing","closed"].includes(String(p.status)) || periodStart>periodEnd
        || p.canonicalCloseCertificateId!==null && typeof p.canonicalCloseCertificateId!=="string") return fail("Invalid reporting calendar period");
      return {fiscalPeriodId:p.fiscalPeriodId,fiscalYear:Number(p.fiscalYear),periodNumber:Number(p.periodNumber),periodStart,periodEnd,
        status:p.status as ReportingCalendarPeriod["status"],version:Number(p.version),
        ...(typeof p.canonicalCloseCertificateId==="string"?{canonicalCloseCertificateId:p.canonicalCloseCertificateId}:{})};
    });
    // Each nonempty, nonoverlapping period consumes at least one day in the
    // selected year, so 366 is a proven bound, not a growing-ledger truncation.
    let previous:ReportingCalendarPeriod|undefined;
    for(const period of periods){
      if(previous && previous.periodEnd>=period.periodStart) fail("Reporting calendar fiscal periods overlap");
      previous=period;
    }
    const months:ReportingCalendarMonth[]=[];
    for(let month=1;month<=12;month++){
      const id=`${prefix}-${String(month).padStart(2,"0")}`,first=`${id}-01`,cursor=new Date(`${first}T00:00:00Z`);
      const days={open:0,closing:0,closed:0,unconfigured:0},ids=new Set<string>();let last=first;
      while(cursor.toISOString().startsWith(id)){
        const day=cursor.toISOString().slice(0,10);last=day;
        const period=periods.find(p=>p.periodStart<=day&&p.periodEnd>=day);
        if (!period || effectiveFrom!==null&&day<effectiveFrom || effectiveThrough!==null&&day>effectiveThrough) days.unconfigured++;
        else { days[period.status]++;ids.add(period.fiscalPeriodId); }
        cursor.setUTCDate(cursor.getUTCDate()+1);
      }
      const statuses=(["open","closing","closed"] as const).filter(status=>days[status]>0);
      const only=statuses[0];
      const status=days.unconfigured>0?"unconfigured":statuses.length===1 && only?only:"mixed";
      months.push({month:id,periodStart:first,periodEnd:last,status,days,fiscalPeriodIds:[...ids]});
    }
    const revision=createHash("sha256").update(JSON.stringify([scope.tenantId,scope.companyId,scope.bookId,sourceId,year,effectiveFrom,effectiveThrough,periods])).digest("hex");
    return {tenantId:scope.tenantId,companyId:scope.companyId,bookId:scope.bookId,sourceId:sourceId,year:year,revision,months,periods};
  });
}
