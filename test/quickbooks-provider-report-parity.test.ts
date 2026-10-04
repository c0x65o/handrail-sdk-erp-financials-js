import { describe, expect, it } from "vitest";

import {
  buildProfitAndLossReport,
  buildQuickBooksCanonicalReportTotalsFromBuiltReport,
  buildQuickBooksTrialBalanceAccountParity,
  sanitizeQuickBooksProviderReportAccountTotals
} from "../src/index.js";
import type {
  Account,
  LedgerPosting,
  NormalizedQuickBooksProviderReportResponseEnvelope,
  QuickBooksTrialBalanceAccountParityInput
} from "../src/index.js";

const tenantId = "tenant_parity";
const sourceId = "source_quickbooks";
const importBatchId = "batch_parity_2026_05";

function account(
  accountId: string,
  sourceAccountId: string,
  name: string,
  classification: Account["classification"]
): Account {
  return {
    tenantId,
    sourceId,
    accountId,
    sourceAccountId,
    name,
    type: classification,
    classification,
    active: true
  };
}

function posting(
  postingId: string,
  accountId: string,
  postingDate: string,
  debitAmount: string,
  creditAmount: string
): LedgerPosting {
  const net = (Number(debitAmount) - Number(creditAmount)).toFixed(2);
  return {
    tenantId,
    sourceId,
    postingId,
    sourcePostingId: postingId,
    transactionId: `txn_${postingId}`,
    accountId,
    postingDate,
    accountingBasis: "accrual",
    debitAmount,
    creditAmount,
    netAmount: net,
    currencyCode: "USD",
    dimensionHash: "none",
    dimensionRefs: [],
    importBatchId
  };
}

const accounts: readonly Account[] = [
  account("acct_cash", "35", "Checking", "asset"),
  account("acct_income", "79", "Sales of Product Income", "income"),
  account("acct_cogs", "80", "Cost of Goods Sold", "cost_of_goods_sold"),
  account("acct_inventory", "81", "Inventory Asset", "asset")
];

const postings: readonly LedgerPosting[] = [
  // Prior-period balance-sheet activity accumulates into the trial balance.
  posting("p1", "acct_cash", "2026-01-15", "500.00", "0.00"),
  // In-period sale: cash and income.
  posting("p2", "acct_cash", "2026-05-10", "1000.00", "0.00"),
  posting("p3", "acct_income", "2026-05-10", "0.00", "1000.00"),
  // Prior-period income activity must NOT accumulate (trial balance period semantics).
  posting("p4", "acct_income", "2026-01-15", "0.00", "500.00"),
  // In-period COGS.
  posting("p5", "acct_cogs", "2026-05-10", "250.00", "0.00"),
  posting("p6", "acct_inventory", "2026-05-10", "0.00", "250.00")
];

function providerTrialBalanceReport(
  accountTotals: NormalizedQuickBooksProviderReportResponseEnvelope["accountTotals"]
): NormalizedQuickBooksProviderReportResponseEnvelope {
  return {
    sourceIdentity: {
      tenantId,
      sourceId,
      sourceSystem: "quickbooks",
      providerEnvironment: "sandbox",
      realmId: "realm_1",
      sourceCompanyRef: "realm_1"
    },
    providerEnvironment: "sandbox",
    reportName: "trial_balance",
    supportStatus: "supported",
    accountingBasis: "accrual",
    currencyCode: "USD",
    periodStart: "2026-05-01",
    periodEnd: "2026-05-31",
    providerReportRef: {
      provider: "quickbooks",
      providerEnvironment: "sandbox",
      realmId: "realm_1",
      reportName: "trial_balance",
      accountingBasis: "accrual",
      periodStart: "2026-05-01",
      periodEnd: "2026-05-31",
      sourcePayloadRef: {
        sourceObjectType: "quickbooks_report_trial_balance",
        sourceObjectId: "realm_1:trial_balance:2026-05-01:2026-05-31:accrual"
      }
    },
    totals: [
      { totalKey: "total_debits", amount: "1750.00", currencyCode: "USD" },
      { totalKey: "total_credits", amount: "1750.00", currencyCode: "USD" }
    ],
    ...(accountTotals === undefined ? {} : { accountTotals })
  };
}

function parityInput(
  providerReport: NormalizedQuickBooksProviderReportResponseEnvelope
): QuickBooksTrialBalanceAccountParityInput {
  return {
    providerReport,
    tenantId,
    sourceId,
    accounts,
    postings,
    accountingBasis: "accrual",
    currencyCode: "USD",
    periodStart: "2026-05-01",
    periodEnd: "2026-05-31",
    toleranceAmount: "0.00"
  };
}

describe("buildQuickBooksTrialBalanceAccountParity", () => {
  it("reports balanced parity when provider and canonical account balances match", () => {
    const report = buildQuickBooksTrialBalanceAccountParity(
      parityInput(
        providerTrialBalanceReport([
          { accountSourceId: "35", label: "Checking", amount: "1500.00" },
          { accountSourceId: "79", label: "Sales of Product Income", amount: "-1000.00" },
          { accountSourceId: "80", label: "Cost of Goods Sold", amount: "250.00" },
          { accountSourceId: "81", label: "Inventory Asset", amount: "-250.00" }
        ])
      )
    );

    expect(report.reconciliationStatus).toBe("balanced");
    expect(report.reconciliationDifference).toBe("0.00");
    expect(report.matchedCount).toBe(4);
    expect(report.mismatchedCount).toBe(0);
    expect(report.missingInProviderCount).toBe(0);
    expect(report.missingInCanonicalCount).toBe(0);
    expect(report.lines).toHaveLength(4);
    expect(report.lines.every((line) => line.status === "matched")).toBe(true);
  });

  it("applies period activity semantics to income accounts and cumulative semantics to balance sheet accounts", () => {
    const report = buildQuickBooksTrialBalanceAccountParity(
      parityInput(
        providerTrialBalanceReport([
          // Cumulative cash includes January posting; income excludes it.
          { accountSourceId: "35", amount: "1500.00" },
          { accountSourceId: "79", amount: "-1000.00" }
        ])
      )
    );

    const cash = report.lines.find((line) => line.accountSourceId === "35");
    const income = report.lines.find((line) => line.accountSourceId === "79");
    expect(cash?.canonicalAmount).toBe("1500.00");
    expect(cash?.status).toBe("matched");
    expect(income?.canonicalAmount).toBe("-1000.00");
    expect(income?.status).toBe("matched");
  });

  it("flags mismatched, provider-missing, and canonical-missing accounts with worst differences first", () => {
    const report = buildQuickBooksTrialBalanceAccountParity(
      parityInput(
        providerTrialBalanceReport([
          { accountSourceId: "35", label: "Checking", amount: "1500.00" },
          // QuickBooks says COGS is 400 while canonical says 250 (a COGS drift).
          { accountSourceId: "80", label: "Cost of Goods Sold", amount: "400.00" },
          // Account that only exists on the QuickBooks side.
          { accountSourceId: "999", label: "Payroll Expenses", amount: "75.00" },
          { accountSourceId: "81", label: "Inventory Asset", amount: "-250.00" }
        ])
      )
    );

    expect(report.reconciliationStatus).toBe("out_of_balance");
    // Income account 79 (-1000.00) is missing from the provider rows.
    expect(report.reconciliationDifference).toBe("1000.00");
    expect(report.mismatchedCount).toBe(1);
    expect(report.missingInProviderCount).toBe(1);
    expect(report.missingInCanonicalCount).toBe(1);

    const [worst] = report.lines;
    expect(worst?.accountSourceId).toBe("79");
    expect(worst?.status).toBe("missing_in_provider");
    expect(worst?.providerAmount).toBe("0.00");

    const cogs = report.lines.find((line) => line.accountSourceId === "80");
    expect(cogs?.status).toBe("mismatched");
    expect(cogs?.difference).toBe("150.00");

    const payroll = report.lines.find((line) => line.accountSourceId === "999");
    expect(payroll?.status).toBe("missing_in_canonical");
    expect(payroll?.canonicalAmount).toBe("0.00");
  });

  it("treats differences within the tolerance as matched", () => {
    const report = buildQuickBooksTrialBalanceAccountParity({
      ...parityInput(
        providerTrialBalanceReport([
          { accountSourceId: "35", amount: "1500.01" },
          { accountSourceId: "79", amount: "-1000.00" },
          { accountSourceId: "80", amount: "250.00" },
          { accountSourceId: "81", amount: "-250.00" }
        ])
      ),
      toleranceAmount: "0.01"
    });

    expect(report.reconciliationStatus).toBe("balanced");
  });

  it("rejects provider reports without accountTotals", () => {
    const report = providerTrialBalanceReport(undefined);
    expect(() => buildQuickBooksTrialBalanceAccountParity(parityInput(report))).toThrow(
      /requires provider accountTotals/
    );
  });

  it("rejects non trial balance provider reports", () => {
    const report = { ...providerTrialBalanceReport([]), reportName: "profit_and_loss" as const };
    expect(() => buildQuickBooksTrialBalanceAccountParity(parityInput(report))).toThrow(
      /requires a trial_balance provider report/
    );
  });
});

describe("sanitizeQuickBooksProviderReportAccountTotals", () => {
  it("normalizes amounts and rejects duplicates", () => {
    expect(sanitizeQuickBooksProviderReportAccountTotals([{ accountSourceId: "1", amount: "10.5" }])).toEqual([
      { accountSourceId: "1", amount: "10.50" }
    ]);
    expect(() =>
      sanitizeQuickBooksProviderReportAccountTotals([
        { accountSourceId: "1", amount: "10.50" },
        { accountSourceId: "1", amount: "11.00" }
      ])
    ).toThrow(/duplicate accountSourceId/);
  });
});

describe("buildQuickBooksCanonicalReportTotalsFromBuiltReport", () => {
  it("maps built report totals to canonical reconciliation totals", () => {
    const report = buildProfitAndLossReport({
      tenantId,
      companyId: "company_parity",
      sourceId,
      accounts,
      postings,
      accountingBasis: "accrual",
      currencyCode: "USD",
      periodStart: "2026-05-01",
      periodEnd: "2026-05-31"
    });

    const totals = buildQuickBooksCanonicalReportTotalsFromBuiltReport(report);
    const byKey = new Map(totals.map((total) => [total.totalKey, total]));

    expect(byKey.get("total_income")?.amount).toBe("1000.00");
    expect(byKey.get("total_cost_of_goods_sold")?.amount).toBe("250.00");
    expect(byKey.get("gross_profit")?.amount).toBe("750.00");
    expect(byKey.get("net_income")?.amount).toBe("750.00");
    expect(totals.every((total) => total.currencyCode === "USD")).toBe(true);
  });
});
