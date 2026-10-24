import { describe, expect, it } from "vitest";
import { createFinancialReadModels, type FinancialStatementRequest, type PostgresQueryClient, type PostgresQueryResult } from "../src/index.js";

const scope = { tenantId: "t", companyId: "c", bookId: "b" };
const window: FinancialStatementRequest = { reportName: "profit_and_loss", periodStart: "2026-01-01", periodEnd: "2026-01-31" };
describe("financial statement snapshot public API", () => {
  it("captures every window before waiting for the database and preserves request order", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const queries = createFinancialReadModels({ ...scope, database: { transaction: async work => {
      await gate;
      const client: PostgresQueryClient = { query: <Row extends Record<string, unknown>>(_sql: string, params?: readonly unknown[]): Promise<PostgresQueryResult<Row>> => {
        calls++;
        expect(params?.slice(0, 3)).toEqual(["t", "c", "b"]);
        const requested = JSON.parse(String(params?.[3])) as Array<Record<string, unknown>>;
        expect(requested.map(item => item.period_start)).toEqual(["2026-01-01", "2026-02-01"]);
        return Promise.resolve({ rows: requested.map((_, ordinal) => ({ ordinal, base_currency_code: "USD", accounting_basis: "accrual", status: "active", statement_lines: [], defined_lines: [], earnings: null })) as unknown as Row[] });
      } };
      return work(client);
    } } });
    const first = { ...window }, second = { ...window, periodStart: "2026-02-01", periodEnd: "2026-02-28" };
    const statements = [first, second];
    const pending = queries.getFinancialStatements({ statements });
    first.periodStart = "2025-01-01"; statements.reverse(); statements.pop();
    release();
    const result = await pending;
    expect(calls).toBe(1);
    expect(result.map(item => [item.periodStart, item.asOfDate, item.totals.netIncome])).toEqual([["2026-01-01", "2026-01-31", "0.00"], ["2026-02-01", "2026-02-28", "0.00"]]);
  });
  it("rejects empty, oversized and malformed windows before database access", async () => {
    let calls = 0;
    const queries = createFinancialReadModels({ ...scope, database: { transaction: () => { calls++; return Promise.reject(Error("Must not query")); } } });
    for (const statements of [[], Array.from({length:37},()=>window), [{...window,periodStart:"2026-02-31"}], [{...window,periodEnd:"2025-12-31"}], [null]]) {
      await expect(queries.getFinancialStatements({statements:statements as readonly FinancialStatementRequest[]})).rejects.toMatchObject({code:"invalid_input"});
    }
    expect(calls).toBe(0);
  });
});

// The public dashboard captures request values before waiting for a connection.
it("dashboard freezes its window and basis before database acquisition", async () => {
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const input={periodStart:"2026-01-01",asOfDate:"2026-08-12",accountingMethod:"cash" as const};
  const queries=createFinancialReadModels({...scope,database:{transaction:async work=>{
    await gate;
    return work({query:<Row extends Record<string,unknown>>(_sql:string,parameters?:readonly unknown[]):Promise<PostgresQueryResult<Row>>=>{
      expect(parameters).toEqual(["t","c","b","2026-08-12","2026-01-01","cash"]);
      return Promise.resolve({rows:[{status:"active",base_currency_code:"USD",accounting_basis:"accrual",assets:"0",liabilities:"0",equity:"0",revenue:"0",expenses:"0",receivables:"0",payables:"0",overdue_receivables:"0",overdue_payables:"0"}] as unknown as Row[]});
    }});
  }}});
  const pending=queries.getDashboardSummary(input);input.asOfDate="2027-08-12";input.periodStart="2027-01-01";release();
  expect(await pending).toMatchObject({periodStart:"2026-01-01",asOfDate:"2026-08-12",accountingBasis:"cash"});
});
