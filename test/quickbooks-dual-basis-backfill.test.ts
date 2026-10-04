import { describe, expect, it, vi } from "vitest";

import { createHandrailQuickBooksBackfillProvider, createQuickBooksDualBasisBackfillWorker, materializeQuickBooksBasisBackfill } from "../src/quickbooks-dual-basis-backfill.js";
import type { Account } from "../src/canonical-model.js";

const accounts: readonly Account[] = ["cash", "ar", "revenue"].map((sourceAccountId) => ({
  tenantId: "tenant", sourceId: "qbo", accountId: `account-${sourceAccountId}`, sourceAccountId,
  name: sourceAccountId, type: sourceAccountId, classification: sourceAccountId === "revenue" ? "income" : "asset", active: true
}));
const input = { tenantId: "tenant", companyId: "company", sourceId: "qbo", currencyCode: "USD", periodStart: "2026-01-01", periodEnd: "2026-12-31", requestedAt: "2027-01-01T00:00:00.000Z", accounts } as const;
const ref = { sourceObjectType: "quickbooks_report_general_ledger", sourceObjectId: "realm:2026", checksum: "safe" } as const;

function report(accountingBasis: "cash" | "accrual") {
  return {
    reportName: "general_ledger" as const, accountingBasis, supportStatus: "supported" as const,
    currencyCode: "USD", generatedAt: "2027-01-01T00:01:00.000Z", providerReportRef: ref,
    totals: [{ totalKey: "provider_total", amount: "999999.00" }],
    ledgerRows: accountingBasis === "accrual" ? [
      { accountSourceId: "ar", transactionId: "invoice-1", transactionType: "Invoice", transactionDate: "2026-01-02", debitAmount: "100.00", creditAmount: "0.00" },
      { accountSourceId: "revenue", transactionId: "invoice-1", transactionType: "Invoice", transactionDate: "2026-01-02", debitAmount: "0.00", creditAmount: "100.00" }
    ] : [
      { accountSourceId: "cash", transactionId: "payment-1", transactionType: "Payment", transactionDate: "2026-03-04", debitAmount: "40.00", creditAmount: "0.00" },
      { accountSourceId: "revenue", transactionId: "payment-1", transactionType: "Payment", transactionDate: "2026-03-04", debitAmount: "0.00", creditAmount: "40.00" }
    ]
  } as const;
}

describe("QuickBooks dual-basis historical backfill", () => {
  it("materializes detailed rows, not provider totals", () => {
    const projection = materializeQuickBooksBasisBackfill(input, report("cash"));
    expect(projection.postings).toHaveLength(2);
    expect(projection.transactions[0]?.sourcePayloadRef).toEqual({sourceObjectType:"Payment",sourceObjectId:"payment-1",preview:{providerReportRef:ref}});
    expect(projection.postings[0]?.sourcePayloadRef).toEqual(projection.transactions[0]?.sourcePayloadRef);
    expect(projection.postings.map((posting) => posting.netAmount)).toEqual(["40.00", "-40.00"]);
    expect(projection.postings.every((posting) => posting.accountingBasis === "cash")).toBe(true);
    expect(JSON.stringify(projection)).not.toContain("999999.00");
  });

  it("fetches both methods and persists them in one atomic range replacement", async () => {
    const generalLedgerReport = vi.fn(({ accountingBasis }: { accountingBasis: "cash" | "accrual" }) => Promise.resolve(report(accountingBasis)));
    const replaceDualBasisRange = vi.fn(() => Promise.resolve({ importBatches: 2, transactions: 2, postings: 4, snapshotsMarkedStale: 2 }));
    const result = await createQuickBooksDualBasisBackfillWorker({ provider: { generalLedgerReport }, persistence: { replaceDualBasisRange } }).backfill(input);
    expect(generalLedgerReport.mock.calls.map(([request]) => request.accountingBasis)).toEqual(["accrual", "cash"]);
    expect(replaceDualBasisRange).toHaveBeenCalledOnce();
    expect(result.projections.map((projection) => projection.accountingBasis)).toEqual(["accrual", "cash"]);
  });

  it("matches QuickBooks partial-payment timing while keeping each basis independently balanced", () => {
    const accrual = materializeQuickBooksBasisBackfill(input, report("accrual"));
    const cash = materializeQuickBooksBasisBackfill(input, report("cash"));
    const accrualRevenue = accrual.postings.find((posting) => posting.accountId === "account-revenue");
    const cashRevenue = cash.postings.find((posting) => posting.accountId === "account-revenue");

    expect(accrualRevenue).toMatchObject({
      accountingBasis: "accrual",
      postingDate: "2026-01-02",
      creditAmount: "100.00"
    });
    expect(cashRevenue).toMatchObject({
      accountingBasis: "cash",
      postingDate: "2026-03-04",
      creditAmount: "40.00"
    });
    expect(accrual.postings.some((posting) => posting.accountId === "account-ar")).toBe(true);
    expect(cash.postings.some((posting) => posting.accountId === "account-ar")).toBe(false);
    expect([accrual, cash].map((projection) => projection.postings.reduce(
      (difference, posting) => difference + Number(posting.debitAmount) - Number(posting.creditAmount),
      0
    ))).toEqual([0, 0]);
  });

  it("rejects unbalanced provider detail before persistence", () => {
    expect(() => materializeQuickBooksBasisBackfill(input, { ...report("cash"), ledgerRows: report("cash").ledgerRows.slice(0, 1) })).toThrow(/not balanced/);
  });

  it("adapts the linked QuickBooks Node SDK report client without host accounting logic", async () => {
    const generalLedger = vi.fn((request: { accountingBasis: "cash" | "accrual"; periodStart: string; periodEnd: string }) => Promise.resolve({
      ok: true as const, reportName: "general_ledger", supportStatus: "supported" as const,
      accountingBasis: request.accountingBasis, currencyCode: "USD", generatedAt: "2027-01-01T00:01:00.000Z",
      providerReportRef: { sourcePayloadRef: ref }, totals: [], ledgerRows: report(request.accountingBasis).ledgerRows
    }));
    const provider = createHandrailQuickBooksBackfillProvider({ providerReports: { generalLedger } });
    const adapted = await provider.generalLedgerReport({ reportName: "general_ledger", accountingBasis: "cash", periodStart: "2026-01-01", periodEnd: "2026-12-31", requestedAt: "2027-01-01T00:00:00.000Z" });
    expect(adapted.accountingBasis).toBe("cash");
    expect(adapted.ledgerRows.length).toBeGreaterThan(0);
    expect(generalLedger).toHaveBeenCalledWith({ accountingBasis: "cash", periodStart: "2026-01-01", periodEnd: "2026-12-31" });
  });
});
