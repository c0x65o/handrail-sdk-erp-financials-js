import { describe, expect, it } from "vitest";
import { createFinancialReadModels } from "../src/sdk-read-models.js";
import { readReportingCalendar, type ReportingCalendarRequest } from "../src/reporting-calendar.js";

const period=(id:string,start:string,end:string,status="open")=>({fiscalPeriodId:id,fiscalYear:2026,periodNumber:1,periodStart:start,periodEnd:end,status,version:1,canonicalCloseCertificateId:null});
const row=(periods:unknown[]=[])=>({book_status:"active",source_id:"s",effective_from:null,effective_through:null,periods});
async function read(fixture:Record<string,unknown>|undefined,input:ReportingCalendarRequest={sourceId:"s",year:2026}){
  let calls=0;
  const result=await readReportingCalendar({tenantId:"t",companyId:"c",bookId:"b",database:{transaction:work=>work({
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
    query:<Row extends Record<string,unknown>>():Promise<{rows:Row[]}>=>{calls++;return Promise.resolve({rows:fixture?[fixture as Row]:[]});},
  })}},input);
  expect(calls).toBe(1);return result;
}

describe("SDK reporting calendar",()=>{
  it("distinguishes missing coverage, mixed fiscal states and a full closed month",async()=>{
    const result=await read(row([period("prior","2025-12-15","2026-01-15","closed"),period("jan","2026-01-16","2026-01-31"),period("feb","2026-02-01","2026-02-28","closed"),period("mar","2026-03-02","2026-03-31","closing")]));
    expect(result.months).toHaveLength(12);
    expect(result.months[0]).toMatchObject({month:"2026-01",status:"mixed",days:{closed:15,open:16,closing:0,unconfigured:0},fiscalPeriodIds:["prior","jan"]});
    expect(result.months[1]).toMatchObject({status:"closed",days:{closed:28,unconfigured:0}});
    expect(result.months[2]).toMatchObject({status:"unconfigured",days:{closing:30,unconfigured:1}});
    expect(result.months[3]).toMatchObject({status:"unconfigured",fiscalPeriodIds:[]});
  });
  it("respects leap days and effective source membership without inventing closure",async()=>{
    const result=await read({...row([period("feb","2028-02-01","2028-02-29","closed")]),effective_from:"2028-02-02",effective_through:"2028-02-28"},{sourceId:"s",year:2028});
    expect(result.months[1]).toMatchObject({periodEnd:"2028-02-29",status:"unconfigured",days:{closed:27,unconfigured:2}});
  });
  it("keeps revisions stable on reads and changes them for canonical version or membership changes",async()=>{
    const fixture=row([period("aug","2026-08-01","2026-08-31")]);
    const initial=await read(fixture);expect(await read(fixture)).toEqual(initial);
    const changed=await read(row([{...fixture.periods[0] as object,status:"closed",version:2,canonicalCloseCertificateId:"cert"}]));
    expect(changed.revision).not.toBe(initial.revision);expect(changed.periods[0]).toMatchObject({version:2,canonicalCloseCertificateId:"cert"});
    expect((await read({...fixture,effective_from:"2026-08-02"})).revision).not.toBe(initial.revision);
  });
  it.each([0,10000,2026.5,NaN])("rejects invalid year %s before database access",async year=>{
    const reads=createFinancialReadModels({tenantId:"t",companyId:"c",bookId:"b",database:{transaction:()=>{throw Error("Must not query");}}});
    await expect(reads.getReportingCalendar({sourceId:"s",year})).rejects.toMatchObject({code:"invalid_input"});
  });
  it.each([1,99,9999])("supports ISO year boundary %s",async year=>{
    const result=await read(row(),{sourceId:"s",year});expect(result.months[0]?.month).toBe(`${String(year).padStart(4,"0")}-01`);expect(result.months[11]?.periodEnd).toBe(`${String(year).padStart(4,"0")}-12-31`);
  });
  it("captures request primitives before waiting for a database connection",async()=>{
    const request={sourceId:"s",year:2026};
    const reads=createFinancialReadModels({tenantId:"t",companyId:"c",bookId:"b",database:{transaction:async work=>{
      request.sourceId="changed";request.year=2027;
      return work({
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
        query:<Row extends Record<string,unknown>>(_sql:string,values?:readonly unknown[]):Promise<{rows:Row[]}>=>{
          expect(values).toEqual(["t","c","b","s","2026-01-01","2026-12-31"]);return Promise.resolve({rows:[row() as unknown as Row]});
        },
      });
    }}});
    expect(await reads.getReportingCalendar(request)).toMatchObject({sourceId:"s",year:2026});
  });
  it("rejects overlap and overflow instead of returning a truncated calendar",async()=>{
    await expect(read(row([period("a","2026-01-01","2026-01-15"),period("b","2026-01-15","2026-01-31")]))).rejects.toMatchObject({code:"invalid_input"});
    await expect(read(row(Array.from({length:367},(_,i)=>period(String(i),"2026-01-01","2026-01-01"))))).rejects.toMatchObject({code:"invalid_input"});
  });
  it("fails explicitly on absent/inactive book or unbound source",async()=>{
    await expect(read(undefined)).rejects.toMatchObject({code:"missing_book"});
    await expect(read({...row(),book_status:"inactive"})).rejects.toMatchObject({code:"terminal_state_conflict"});
    await expect(read({...row(),source_id:null})).rejects.toMatchObject({code:"missing_document"});
  });
});
