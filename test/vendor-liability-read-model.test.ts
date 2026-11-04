import { expect, it } from "vitest";
import { createFinancialReadModels } from "../src/index.js";
import type { PostgresQueryResult } from "../src/index.js";
function required<T>(value: T | undefined): T { if (value === undefined) throw Error("Missing fixture value"); return value; }
const input = { vendorId: "vendor", sourceId: "native", asOfDate: "2026-09-30", limit: 1 };
const row = (posting_id: string) => ({ posting_id, source_id: "native", party_id: "vendor", transaction_id: posting_id, posting_date: "2026-09-01", source_transaction_type: "JournalEntry", transaction_number: "Refund", account_id: "ap", account_name: "Payables", account_type: "AccountsPayable", currency_code: "USD", debit_amount: "0.00", credit_amount: "1.00", liability_effect: "1.00" });
function fixture() {
  const state = { rows: [row("a"), row("b")], control: { book_status: "active", source_known: true, base_currency_code: "USD", party_type: "vendor", posting_count: 2, net_liability: "2.00", currency_count: 1, posting_currency: "USD" } };
  const queries = createFinancialReadModels({ tenantId: "tenant", companyId: "company", bookId: "book", database: { transaction: work => work({ query: <Row extends Record<string, unknown>>(): Promise<PostgresQueryResult<Row>> => Promise.resolve({ rows: state.rows.map(row => ({ ...state.control, ...row })) as unknown as Row[] }) }) } });
  return { state, queries };
}
it("retains refunds and source coordinates with complete liability controls across pages", async () => {
  const { queries } = fixture();
  const first = await queries.getVendorLiabilityStatement(input);
  expect(first).toMatchObject({ postingCount: 2, netLiabilityAmount: "2.00", items: [{ postingId: "a", transactionNumber: "Refund", payableEffect: "1.00" }] });
  const second = await queries.getVendorLiabilityStatement({ ...input, cursor: required(first.nextCursor) });
  expect(second.items[0]?.postingId).toBe("b"); expect(second.nextCursor).toBeUndefined();
});
it("rejects changed controls, currencies, foreign source, duplicate postings and stale revisions", async () => {
  for (const corrupt of ["count", "net", "currency", "source", "duplicate", "party", "bound", "book"] as const) {
    const { state, queries } = fixture();
    if (corrupt === "count") state.control.posting_count++;
    if (corrupt === "net") state.control.net_liability = "4.00";
    if (corrupt === "currency") state.control.posting_currency = "EUR";
    if (corrupt === "source") required(state.rows[0]).source_id = "foreign";
    if (corrupt === "duplicate") required(state.rows[1]).posting_id = "a";
    if (corrupt === "party") state.control.party_type = "customer";
    if (corrupt === "bound") state.control.posting_count = 10001;
    if (corrupt === "book") state.control.source_known = false;
    await expect(queries.getVendorLiabilityStatement(input)).rejects.toBeDefined();
  }
  const { state, queries } = fixture(), first = await queries.getVendorLiabilityStatement(input);
  required(state.rows[1]).transaction_id = "equal-amount-replacement";
  await expect(queries.getVendorLiabilityStatement({ ...input, cursor: required(first.nextCursor) })).rejects.toMatchObject({ code: "optimistic_concurrency_conflict" });
});
it("validates dates and cursor bounds without SQL", async () => {
  const { queries } = fixture();
  for (const change of [{limit:201},{limit:0},{asOfDate:"2026-02-30"},{cursor:"!"},{sourceId:" "}]) await expect(queries.getVendorLiabilityStatement({...input,...change})).rejects.toMatchObject({code:"invalid_input"});
});
