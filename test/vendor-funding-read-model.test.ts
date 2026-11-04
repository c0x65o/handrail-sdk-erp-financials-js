import { expect, it } from "vitest";

import { createFinancialReadModels } from "../src/index.js";
import type { PostgresQueryClient, PostgresQueryResult } from "../src/index.js";

const statement = (client: PostgresQueryClient) => createFinancialReadModels({
  database: { transaction: async (work) => work(client) },
  tenantId: "tenant_1",
  companyId: "company_1",
  bookId: "book_1"
});

it("rejects malformed vendor funding pagination before reading accounting", async () => {
  const queries=statement({query:()=>Promise.reject(Error("No reads expected"))});
  for (const invalid of [{limit:0},{limit:201},{cursor:"not-json"},{vendorId:" "},{asOfDate:"2026-02-30"}]) {
    await expect(queries.getVendorFundingDocuments({vendorId:"customer",asOfDate:"2026-08-31",...invalid})).rejects.toBeDefined();
  }
});

it("retains source-qualified vendor funding rows and binds continuations to the entire selection", async () => {
  let available = "4.00", bookStatus = "active";
  const queries=statement({query: async <Row extends Record<string,unknown>>(sql:string):Promise<PostgresQueryResult<Row>> => {
    if(sql.includes('from "erp_financials"."reporting_books"')) return rows<Row>([{base_currency_code:"USD",accounting_basis:"accrual",status:"active"}]);
    return rows<Row>(["historical","native"].map(source_id=>({book_status:bookStatus,book_currency:"USD",book_basis:"accrual",source_id,subledger_document_id:"same-id",transaction_id:"tx",document_type:"bill_payment",document_date:"2026-08-01",original_amount:"10.00",historical_open_amount:available})));
  }});
  const input={vendorId:"customer",asOfDate:"2026-08-31",limit:1};
  const first=await queries.getVendorFundingDocuments(input);
  expect(first).toMatchObject({totalCount:2,items:[{sourceId:"historical",documentId:"same-id",availableAmount:"4.00"}]});
  if (!first.nextCursor) throw Error("Expected funding cursor");
  const second=await queries.getVendorFundingDocuments({...input,cursor:first.nextCursor});
  expect(second).toMatchObject({items:[{sourceId:"native",documentId:"same-id"}]});
  expect(second.nextCursor).toBeUndefined();
  await expect(queries.getVendorFundingDocuments({...input,vendorId:"different",cursor:first.nextCursor})).rejects.toMatchObject({code:"optimistic_concurrency_conflict"});
  bookStatus="inactive";
  await expect(queries.getVendorFundingDocuments(input)).rejects.toMatchObject({code:"optimistic_concurrency_conflict"});
  bookStatus="active";
  available="3.00";
  await expect(queries.getVendorFundingDocuments({...input,cursor:first.nextCursor})).rejects.toMatchObject({code:"optimistic_concurrency_conflict"});
});

function rows<Row extends Record<string, unknown>>(
  values: readonly Record<string, unknown>[]
): Promise<PostgresQueryResult<Row>> {
  return Promise.resolve({ rows: values as Row[] });
}


