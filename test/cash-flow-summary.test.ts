import { describe, expect, it } from "vitest";
import { createFinancialReadModels } from "../src/sdk-read-models.js";
import { readCashFlowSummary, type CashFlowSummaryRequest } from "../src/cash-flow-summary.js";

describe("cash-flow summary input boundary", () => {
  const valid:CashFlowSummaryRequest={periodStart:"2026-08-01",periodEnd:"2026-08-31",accountRoles:[{bookAccountKey:"cash",role:"cash"}]};
  it.each([
    {periodStart:"2026-02-30"},{periodEnd:"2026-07-31"},{accountingMethod:"unsupported"},
    {accountRoles:[]},{accountRoles:[{bookAccountKey:"cash",role:"cash"},{bookAccountKey:"cash",role:"operating"}]},
    {accountRoles:[{bookAccountKey:"cash",role:"unknown"}]},{accountRoles:[{bookAccountKey:"   ",role:"cash"}]},
    {accountRoles:[{bookAccountKey:"income",role:"operating"}]},
    {accountRoles:Array.from({length:2001},(_,i)=>({bookAccountKey:`cash-${String(i)}`,role:"cash"}))},
  ])("rejects invalid policy/window before database work", async patch=>{
    let calls=0;
    const reads=createFinancialReadModels({tenantId:"t",companyId:"c",bookId:"b",database:{transaction:()=>{calls++;throw Error("Must not query");}}});
    await expect(reads.getCashFlowSummary({...valid,...patch} as CashFlowSummaryRequest)).rejects.toMatchObject({code:"invalid_input"});
    expect(calls).toBe(0);
  });
});


describe("cash-flow exact numeric representation", () => {
  it.each(["90071992547409.910000000000000000", "-90071992547409.910000", "0.00000000"])("normalizes zero-only PostgreSQL scale without floating point: %s", async amount => {
    const result=await readFixture(amount);
    const expected=(amount.split(".")[0]??"")+"."+(amount.split(".")[1]??"").slice(0,2);
    expect(result).toMatchObject({beginningCash:"0.00",endingCash:expected,netCashFlow:expected,operating:expected,supportStatus:"supported"});
  });
  it.each(["0.001", "-1.0001", "90071992547409.910001", "1e2", "NaN"])("rejects non-cent or non-decimal query output: %s", async amount => {
    await expect(readFixture(amount)).rejects.toThrow("Invalid cash-flow amount");
  });
  async function readFixture(amount:string){
    const row={book_status:"active",basis:"accrual",currency_code:"USD",missing_policy:false,invalid_cash:false,invalid_hierarchy:false,ambiguous_cash_document:false,invalid_precision:false,
      beginning:"0.00000",ending:amount,net_cash_flow:amount,operating:amount,investing:"0.0000",financing:"0.00",unclassified:"0.0000",
      unclassified_count:"0",unbalanced_count:"0",transaction_count:"1",posting_count:"1",transfer_count:"0",allocated_count:"0"};
    // Generic row signature implements the SDK database boundary for a single fixture row.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
    return readCashFlowSummary({tenantId:"t",companyId:"c",bookId:"b",database:{transaction:work=>work({query:<Row extends Record<string,unknown>>():Promise<{rows:Row[]}>=>Promise.resolve({rows:[row as unknown as Row]})})}},
      {periodStart:"2026-08-01",periodEnd:"2026-08-31",accountRoles:[{bookAccountKey:"cash",role:"cash"}]},"fixture");
  }
});
