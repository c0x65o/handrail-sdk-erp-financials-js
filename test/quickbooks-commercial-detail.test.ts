import { describe, expect, it } from "vitest";
import { planQuickBooksCommercialDetail } from "../src/quickbooks-commercial-detail.js";
import type { NormalizedQuickBooksLedgerTransaction } from "../src/normalized-accounting-contracts.js";

const references = { accounts: [{ sourceAccountId: "74", accountId: "hardware" }], items: [{ sourceItemId: "20", itemId: "switch", incomeAccountId: "hardware" }] };
const invoice: NormalizedQuickBooksLedgerTransaction = {
  sourceTransactionId: "3519", sourceTransactionType: "Invoice", transactionDate: "2026-07-29",
  totalAmount: "477.00", totalTax: "27.00", openAmount: "0.00", lines: [{ lineNumber: 1, sourceLineId: "1", detailType: "SalesItemLineDetail",
    sourceAmount: "450.00", sourceQuantity: "1", sourceUnitAmount: "450", taxCode: "TAX",
    accountRef: { sourceObjectId: "74" }, itemRef: { sourceObjectId: "20" }, postings: [] }]
};
describe("source-backed QuickBooks commercial detail", () => {
  it("restores invoice 1492 economics and allocates its recorded tax", () => {
    const result = planQuickBooksCommercialDetail(invoice, references);
    expect(result.lines).toMatchObject([{ quantity: "1", unitAmount: "450", amount: "477.00", taxAmount: "27.00", discountAmount: "0.00" }]);
    expect(planQuickBooksCommercialDetail(invoice, references)).toEqual(result);
  });
  it("rejects header-only and unresolved source detail before persistence", () => {
    expect(() => planQuickBooksCommercialDetail({ ...invoice, lines: [] }, references)).toThrow("missing_commercial_lines");
    expect(() => planQuickBooksCommercialDetail(invoice, { accounts: [], items: [] })).toThrow("unresolved_line_account");
    const { totalTax: _tax, ...withoutTax } = invoice;
    expect(() => planQuickBooksCommercialDetail(withoutTax, references)).toThrow("missing_document_tax");
  });
  it("retains discount polarity and provider quantity/price evidence", () => {
    const result = planQuickBooksCommercialDetail({ ...invoice, totalAmount: "212.50", totalTax: "12.50", lines: [
      { ...invoice.lines[0]!, sourceAmount: "225", sourceQuantity: "0.500000", sourceUnitAmount: "450.000000" },
      { lineNumber: 2, sourceLineId: "2", detailType: "DiscountLineDetail", sourceAmount: "25", accountRef: { sourceObjectId: "74" }, postings: [] }
    ] }, references);
    expect(result.lines).toMatchObject([{ quantity: "0.500000", unitAmount: "450.000000", amount: "237.50", taxAmount: "12.50" }, { quantity: "1", unitAmount: "-25.00", amount: "-25.00" }]);
  });
  it("distributes cents deterministically and never taxes exempt lines", () => {
    const source = invoice.lines[0]!;
    const result = planQuickBooksCommercialDetail({ ...invoice, totalAmount: "30.01", totalTax: "0.01", lines: [
      { ...source, sourceAmount: "10", sourceUnitAmount: "10" },
      { ...source, lineNumber: 2, sourceLineId: "2", sourceAmount: "10", sourceUnitAmount: "10" },
      { ...source, lineNumber: 3, sourceLineId: "3", sourceAmount: "10", sourceUnitAmount: "10", taxCode: "NON" }
    ] }, references);
    expect(result.lines.map(line => line.taxAmount)).toEqual(["0.01", "0.00", "0.00"]);
  });
  it("preserves provider seven-decimal quantities and zero-effect lines", () => {
    const result = planQuickBooksCommercialDetail({ ...invoice, totalAmount: "12720", totalTax: "720", lines: [
      { ...invoice.lines[0]!, sourceQuantity: "0.3333333", sourceUnitAmount: "36000", sourceAmount: "12000" },
      { ...invoice.lines[0]!, lineNumber: 2, sourceLineId: "2", sourceQuantity: "0", sourceUnitAmount: "250", sourceAmount: "0", taxCode: "NON" }
    ] }, references);
    expect(result.lines).toMatchObject([{ quantity: "0.3333333", amount: "12720.00" }, { quantity: "0", amount: "0.00" }]);
  });
  it("represents provider amount-only reimbursements without inventing item quantity", () => {
    const result = planQuickBooksCommercialDetail({ ...invoice, lines: [{ lineNumber: 1, detailType: "SalesItemLineDetail", sourceAmount: "450", taxCode: "TAX", accountRef: { sourceObjectId: "74" }, postings: [] }] }, references);
    expect(result.lines).toMatchObject([{ quantity: "1", unitAmount: "450.00", amount: "477.00" }]);
  });
  it("does not turn a price discrepancy into invented tax", () => {
    expect(() => planQuickBooksCommercialDetail({ ...invoice, taxCalculation: "TaxInclusive" }, references)).toThrow("unsupported_tax_inclusive_detail");
    expect(() => planQuickBooksCommercialDetail({ ...invoice, totalAmount: "478", totalTax: "27" }, references)).toThrow("commercial_total_mismatch");
    expect(() => planQuickBooksCommercialDetail({ ...invoice, lines: [{ ...invoice.lines[0]!, sourceUnitAmount: "400" }] }, references)).toThrow("line_price_arithmetic_mismatch");
  });
});
