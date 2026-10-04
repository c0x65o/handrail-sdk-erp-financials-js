import { describe, expect, it } from "vitest";

import {
  ERP_FINANCIALS_STATEMENT_FIXTURE,
  STANDARD_REPORT_ACCOUNTING_METHODS,
  STANDARD_REPORT_COMPARISON_CALCULATION_OPTIONS,
  STANDARD_REPORT_COMPARE_TO_PERIOD_OPTIONS,
  STANDARD_REPORT_DISPLAY_COLUMNS_BY_OPTIONS,
  assertStandardReportControlsSupported,
  buildProfitAndLossReport,
  buildReferenceStandardReportPresentationFromFacts,
  buildStandardReportPresentationFromFacts,
  buildStandardReportPresentationFromReadModel,
  buildStandardReportPresentationFromReports
} from "../src/index.js";

import type {
  BuiltReport,
  LedgerPosting,
  ReportBuilderInput,
  StandardReportPresentation,
  StandardReportPresentationReadModelRequest,
  StandardReportPresentationReadModelStorage,
  StandardReportPresentationReportSet,
  TransactionLine
} from "../src/index.js";

const fixture = ERP_FINANCIALS_STATEMENT_FIXTURE;

describe("standard report controls", () => {
  it("exports every accounting method, display-column, compare-to, and calculation option from the report UI", () => {
    expect(STANDARD_REPORT_ACCOUNTING_METHODS.map((option) => option.value)).toEqual(["cash", "accrual"]);
    expect(STANDARD_REPORT_DISPLAY_COLUMNS_BY_OPTIONS.map((option) => option.value)).toEqual([
      "none",
      "customer",
      "employee",
      "product_service",
      "days",
      "weeks",
      "months",
      "quarters",
      "years",
      "vendor"
    ]);
    expect(STANDARD_REPORT_COMPARE_TO_PERIOD_OPTIONS.map((option) => option.value)).toEqual([
      "previous_year",
      "previous_period",
      "year_to_date",
      "previous_year_to_date",
      "custom_period"
    ]);
    expect(STANDARD_REPORT_COMPARISON_CALCULATION_OPTIONS.map((option) => option.value)).toEqual([
      "percent_of_row",
      "percent_of_column",
      "percent_of_expense",
      "percent_of_income"
    ]);
  });

  it("builds comparison columns for all compare-to periods and calculation options", () => {
    const presentation = buildReferenceStandardReportPresentationFromFacts({
      reportName: "profit_and_loss",
      reportInput: enrichedReportInput(),
      accountingMethod: "accrual",
      compareTo: {
        periods: ["previous_year", "previous_period", "year_to_date", "previous_year_to_date", "custom_period"],
        customPeriod: {
          periodStart: "2026-01-01",
          periodEnd: "2026-01-15"
        },
        calculations: ["percent_of_row", "percent_of_column", "percent_of_expense", "percent_of_income"]
      },
      fiscalYearStartMonth: fixture.company.fiscalYearStartMonth
    });

    expect(presentation.accountingMethod).toBe("accrual");
    expect(presentation.columns.map((column) => column.columnId)).toEqual([
      "actual:none:total",
      "comparison:previous_year",
      "comparison:previous_period",
      "comparison:year_to_date",
      "comparison:previous_year_to_date",
      "comparison:custom_period",
      "calculation:percent_of_row",
      "calculation:percent_of_column",
      "calculation:percent_of_expense",
      "calculation:percent_of_income"
    ]);
    expect(presentation.columns.find((column) => column.columnId === "comparison:previous_year")).toMatchObject({
      periodStart: "2025-01-01",
      periodEnd: "2025-01-31",
      asOfDate: "2025-01-31"
    });
    expect(presentation.columns.find((column) => column.columnId === "comparison:previous_period")).toMatchObject({
      periodStart: "2025-12-01",
      periodEnd: "2025-12-31",
      asOfDate: "2025-12-31"
    });
    expect(presentation.columns.find((column) => column.columnId === "comparison:custom_period")).toMatchObject({
      periodStart: "2026-01-01",
      periodEnd: "2026-01-15",
      asOfDate: "2026-01-15"
    });
    expect(rowCell(presentation, "total:net_income", "actual:none:total")?.amount).toBe("13800.00");
    expect(rowCell(presentation, "total:net_income", "calculation:percent_of_income")?.percent).toBe("69.00");
  });

  it.each([
    ["customer", ["Acme Stores"]],
    ["employee", ["Primary Owner"]],
    ["product_service", ["Installation", "Production Equipment", "Widget"]],
    ["vendor", ["Landlord LLC", "Supply Vendor"]]
  ] as const)("builds %s display columns from posting dimensions", (displayColumnsBy, expectedLabels) => {
    const presentation = buildReferenceStandardReportPresentationFromFacts({
      reportName: "profit_and_loss",
      reportInput: enrichedReportInput(),
      displayColumnsBy,
      parties: fixture.parties,
      items: fixture.items
    });

    expect(presentation.columns.map((column) => column.label)).toEqual(expectedLabels);
    expect(presentation.columns.every((column) => column.displayColumnsBy === displayColumnsBy)).toBe(true);
  });

  it.each([
    ["days", ["2026-01-01", "2026-01-02", "2026-01-03"]],
    ["weeks", ["2026-01-01 - 2026-01-03", "2026-01-04 - 2026-01-10", "2026-01-11 - 2026-01-17"]],
    ["months", ["01/2026"]],
    ["quarters", ["Q1 2026"]],
    ["years", ["2026"]]
  ] as const)("builds %s display columns from the report period", (displayColumnsBy, expectedStartingLabels) => {
    const presentation = buildReferenceStandardReportPresentationFromFacts({
      reportName: "profit_and_loss",
      reportInput: enrichedReportInput(),
      displayColumnsBy,
      weekStartsOn: 0
    });

    expect(presentation.columns.slice(0, expectedStartingLabels.length).map((column) => column.label)).toEqual(expectedStartingLabels);
    expect(presentation.columns.every((column) => column.displayColumnsBy === displayColumnsBy)).toBe(true);
  });

  it("supports cash-basis presentation requests when cash-basis postings are available", () => {
    const reportInput = {
      ...enrichedReportInput(),
      accountingBasis: "cash" as const,
      postings: enrichedReportInput().postings.map((posting) => ({
        ...posting,
        accountingBasis: "cash" as const
      }))
    } satisfies ReportBuilderInput;
    const presentation = buildReferenceStandardReportPresentationFromFacts({
      reportName: "profit_and_loss",
      reportInput,
      accountingMethod: "cash"
    });

    expect(presentation.accountingMethod).toBe("cash");
    expect(rowCell(presentation, "total:net_income", "actual:none:total")?.amount).toBe("13800.00");
  });

  it("builds the production presentation surface from a read model request without raw postings", async () => {
    const storage = new RecordingPresentationReadModelStorage();

    const presentation = await buildStandardReportPresentationFromReadModel(storage, {
      tenantId: fixture.company.tenantId,
      companyId: fixture.company.companyId,
      sourceId: fixture.source.sourceId,
      reportName: "profit_and_loss",
      accountingMethod: "accrual",
      periodStart: "2026-01-01",
      periodEnd: "2027-12-31",
      asOfDate: "2027-12-31",
      currencyCode: "USD",
      displayColumnsBy: "months"
    });

    expect(storage.requests).toHaveLength(1);
    expect(Object.hasOwn(storage.requests[0] ?? {}, "reportInput")).toBe(false);
    expect(presentation.columns.map((column) => column.columnId)).toEqual(["actual:months:2026-01"]);
    expect(rowCell(presentation, "total:net_income", "actual:months:2026-01")?.amount).toBe("13800.00");
  });

  it("emits presentation hierarchy metadata from primary report line parent chains", () => {
    const report = nestedPresentationReport();
    const presentation = buildStandardReportPresentationFromReports({
      reportName: "profit_and_loss",
      accountingMethod: "accrual",
      displayColumnsBy: "none",
      primaryReport: report,
      amountColumns: [
        {
          column: {
            columnId: "actual:none:total",
            label: "Total",
            kind: "actual",
            periodStart: "2026-01-01",
            periodEnd: "2026-01-31",
            asOfDate: "2026-01-31",
            displayColumnsBy: "none",
            groupKey: "total"
          },
          report
        }
      ]
    });

    expect(presentation.rows.map((row) => row.rowId)).toEqual([
      "line:account:acct_parent",
      "line:account:acct_child",
      "line:account:acct_grandchild",
      "total:total_expenses"
    ]);
    expect(presentationRow(presentation, "line:account:acct_parent").parentRowId).toBeUndefined();
    expect(presentationRow(presentation, "line:account:acct_parent").hierarchyDepth).toBe(0);
    expect(presentationRow(presentation, "line:account:acct_child")).toMatchObject({
      parentRowId: "line:account:acct_parent",
      hierarchyDepth: 1
    });
    expect(presentationRow(presentation, "line:account:acct_grandchild")).toMatchObject({
      parentRowId: "line:account:acct_child",
      hierarchyDepth: 2
    });
    expect(presentationRow(presentation, "total:total_expenses")).toMatchObject({
      rowId: "total:total_expenses",
      kind: "total"
    });
    expect(presentationRow(presentation, "total:total_expenses").parentRowId).toBeUndefined();
    expect(presentationRow(presentation, "total:total_expenses").hierarchyDepth).toBeUndefined();
    expect(rowCell(presentation, "line:account:acct_grandchild", "actual:none:total")?.amount).toBe("30.00");
    expect(rowCell(presentation, "total:total_expenses", "actual:none:total")?.amount).toBe("60.00");
  });

  it("orders nested profit-and-loss rows and totals in financial statement order", () => {
    const presentation = presentationFromReport(profitAndLossOrderingReport());

    expect(presentation.rows.map((row) => row.rowId)).toEqual([
      "line:account:acct_income_parent",
      "line:account:acct_income_child",
      "total:total_income",
      "line:account:acct_cogs",
      "total:total_cost_of_goods_sold",
      "total:gross_profit",
      "line:account:acct_expense_parent",
      "line:account:acct_expense_child",
      "total:total_expenses",
      "total:net_operating_income",
      "line:account:acct_other_income",
      "total:total_other_income",
      "line:account:acct_other_expense",
      "total:total_other_expense",
      "total:net_income"
    ]);
    expect(presentationRow(presentation, "line:account:acct_income_child")).toMatchObject({
      parentRowId: "line:account:acct_income_parent",
      hierarchyDepth: 1
    });
    expect(rowCell(presentation, "total:net_income", "actual:none:total")?.amount).toBe("77.00");
    for (const rowId of [
      "total:total_income",
      "total:gross_profit",
      "total:total_expenses",
      "total:net_operating_income",
      "total:net_income"
    ]) {
      expect(presentationRow(presentation, rowId).parentRowId).toBeUndefined();
      expect(presentationRow(presentation, rowId).hierarchyDepth).toBeUndefined();
    }
  });

  it("orders balance sheet totals in financial statement order", () => {
    const presentation = presentationFromReport(balanceSheetOrderingReport());

    expect(presentation.rows.map((row) => row.rowId)).toEqual([
      "line:account:acct_asset_parent",
      "line:account:acct_asset_child",
      "total:total_assets",
      "line:account:acct_liability",
      "total:total_liabilities",
      "line:account:acct_equity",
      "total:total_equity",
      "total:total_liabilities_and_equity"
    ]);
    expect(presentationRow(presentation, "line:account:acct_asset_child")).toMatchObject({
      parentRowId: "line:account:acct_asset_parent",
      hierarchyDepth: 1
    });
    expect(presentationRow(presentation, "total:total_assets").parentRowId).toBeUndefined();
    expect(presentationRow(presentation, "total:total_liabilities_and_equity").hierarchyDepth).toBeUndefined();
  });

  it("orders trial balance debit and credit totals after their sections", () => {
    const presentation = presentationFromReport(trialBalanceOrderingReport());

    expect(presentation.rows.map((row) => row.rowId)).toEqual([
      "line:account:acct_debit_parent",
      "line:account:acct_debit_child",
      "total:total_debits",
      "line:account:acct_credit",
      "total:total_credits"
    ]);
    expect(presentationRow(presentation, "line:account:acct_debit_child")).toMatchObject({
      parentRowId: "line:account:acct_debit_parent",
      hierarchyDepth: 1
    });
    expect(presentationRow(presentation, "total:total_debits").parentRowId).toBeUndefined();
    expect(presentationRow(presentation, "total:total_credits").hierarchyDepth).toBeUndefined();
  });

  it("emits presentation hierarchy metadata from read-model report sets", async () => {
    const storage = new NestedPresentationReadModelStorage();

    const presentation = await buildStandardReportPresentationFromReadModel(storage, {
      tenantId: "tenant_nested_presentation",
      companyId: "company_nested_presentation",
      sourceId: "source_nested_presentation",
      reportName: "profit_and_loss",
      accountingMethod: "accrual",
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
      asOfDate: "2026-01-31",
      currencyCode: "USD"
    });

    expect(storage.requests).toHaveLength(1);
    expect(presentationRow(presentation, "line:account:acct_parent")).toMatchObject({
      hierarchyDepth: 0
    });
    expect(presentationRow(presentation, "line:account:acct_child")).toMatchObject({
      parentRowId: "line:account:acct_parent",
      hierarchyDepth: 1
    });
    expect(presentationRow(presentation, "line:account:acct_grandchild")).toMatchObject({
      parentRowId: "line:account:acct_child",
      hierarchyDepth: 2
    });
    expect(rowCell(presentation, "line:account:acct_child", "actual:none:total")?.amount).toBe("50.00");
  });

  it("aligns comparison-only and actual-only hierarchy rows by stable row ID", () => {
    const primaryReport = orderingReport(
      "profit_and_loss",
      [
        {
          accountId: "acct_alignment_actual_child",
          label: "Actual Child",
          amount: "20.00",
          sortOrder: 5,
          section: "expense",
          parentAccountId: "acct_alignment_parent"
        },
        {
          accountId: "acct_alignment_parent",
          label: "Primary Parent",
          amount: "120.00",
          sortOrder: 10,
          section: "expense"
        }
      ],
      [{ totalKey: "total_expenses", label: "Total Expenses", amount: "120.00" }]
    );
    const comparisonReport = orderingReport(
      "profit_and_loss",
      [
        {
          accountId: "acct_alignment_comparison_child",
          label: "Comparison Child",
          amount: "35.00",
          sortOrder: 6,
          section: "expense",
          parentAccountId: "acct_alignment_parent"
        },
        {
          accountId: "acct_alignment_parent",
          label: "Comparison Parent",
          amount: "235.00",
          sortOrder: 10,
          section: "expense"
        }
      ],
      [{ totalKey: "total_expenses", label: "Total Expenses", amount: "235.00" }]
    );

    const presentation = buildStandardReportPresentationFromReports({
      reportName: "profit_and_loss",
      accountingMethod: "accrual",
      displayColumnsBy: "none",
      primaryReport,
      amountColumns: [
        {
          column: {
            columnId: "actual:none:total",
            label: "Actual",
            kind: "actual",
            periodStart: "2026-01-01",
            periodEnd: "2026-01-31",
            asOfDate: "2026-01-31",
            displayColumnsBy: "none",
            groupKey: "total"
          },
          report: primaryReport
        },
        {
          column: {
            columnId: "comparison:previous_period",
            label: "Previous Period",
            kind: "comparison",
            periodStart: "2025-12-01",
            periodEnd: "2025-12-31",
            asOfDate: "2025-12-31",
            displayColumnsBy: "none",
            compareTo: "previous_period"
          },
          report: comparisonReport
        }
      ],
      calculationColumns: [
        {
          columnId: "calculation:percent_of_row",
          label: "% of Row",
          kind: "calculation",
          periodStart: "2026-01-01",
          periodEnd: "2026-01-31",
          asOfDate: "2026-01-31",
          displayColumnsBy: "none",
          calculation: "percent_of_row"
        }
      ]
    });

    expect(presentation.rows.map((row) => row.rowId)).toEqual([
      "line:account:acct_alignment_parent",
      "line:account:acct_alignment_actual_child",
      "line:account:acct_alignment_comparison_child",
      "total:total_expenses"
    ]);
    expect(presentationRow(presentation, "line:account:acct_alignment_parent")).toMatchObject({
      label: "Primary Parent",
      hierarchyDepth: 0
    });
    expect(presentationRow(presentation, "line:account:acct_alignment_actual_child")).toMatchObject({
      parentRowId: "line:account:acct_alignment_parent",
      hierarchyDepth: 1
    });
    expect(presentationRow(presentation, "line:account:acct_alignment_comparison_child")).toMatchObject({
      label: "Comparison Child",
      parentRowId: "line:account:acct_alignment_parent",
      hierarchyDepth: 1
    });
    expect(rowCell(presentation, "line:account:acct_alignment_actual_child", "actual:none:total")?.amount).toBe("20.00");
    expect(rowCell(presentation, "line:account:acct_alignment_actual_child", "comparison:previous_period")?.amount).toBe("0.00");
    expect(rowCell(presentation, "line:account:acct_alignment_comparison_child", "actual:none:total")?.amount).toBe("0.00");
    expect(rowCell(presentation, "line:account:acct_alignment_comparison_child", "comparison:previous_period")?.amount).toBe("35.00");
    expect(rowCell(presentation, "line:account:acct_alignment_actual_child", "calculation:percent_of_row")?.percent).toBe("100.00");
    expect(rowCell(presentation, "line:account:acct_alignment_comparison_child", "calculation:percent_of_row")?.percent).toBe("0.00");
  });

  it("keeps the deprecated raw-facts alias only as reference fixture compatibility", () => {
    /* eslint-disable @typescript-eslint/no-deprecated -- This test intentionally pins the deprecated compatibility alias. */
    expect(buildStandardReportPresentationFromFacts).toBe(buildReferenceStandardReportPresentationFromFacts);

    const presentation = buildStandardReportPresentationFromFacts({
      reportName: "profit_and_loss",
      reportInput: enrichedReportInput()
    });
    /* eslint-enable @typescript-eslint/no-deprecated */

    expect(presentation.columns.map((column) => column.columnId)).toEqual(["actual:none:total"]);
    expect(rowCell(presentation, "total:net_income", "actual:none:total")?.amount).toBe("13800.00");
  });

  it("rejects unsupported accounting basis and missing custom comparison periods", () => {
    expect(() => {
      assertStandardReportControlsSupported({
        reportName: "profit_and_loss",
        reportInput: {
          ...enrichedReportInput(),
          accountingBasis: "modified_cash"
        }
      });
    }).toThrow(/accounting method/);

    expect(() => {
      assertStandardReportControlsSupported({
        reportName: "profit_and_loss",
        reportInput: enrichedReportInput(),
        compareTo: {
          periods: ["custom_period"]
        }
      });
    }).toThrow(/customPeriod/);
  });
});

class RecordingPresentationReadModelStorage implements StandardReportPresentationReadModelStorage {
  readonly requests: StandardReportPresentationReadModelRequest[] = [];

  loadStandardReportPresentation(request: StandardReportPresentationReadModelRequest): Promise<StandardReportPresentationReportSet> {
    this.requests.push(request);
    const reportInput = enrichedReportInput();
    const report = buildProfitAndLossReport(reportInput);

    return Promise.resolve({
      reportName: "profit_and_loss",
      accountingMethod: "accrual",
      displayColumnsBy: "months",
      primaryReport: report,
      amountColumns: [
        {
          column: {
            columnId: "actual:months:2026-01",
            label: "01/2026",
            kind: "actual",
            periodStart: reportInput.periodStart,
            periodEnd: reportInput.periodEnd,
            asOfDate: reportInput.asOfDate ?? reportInput.periodEnd,
            displayColumnsBy: "months",
            groupKey: "2026-01"
          },
          report
        }
      ]
    });
  }
}

class NestedPresentationReadModelStorage implements StandardReportPresentationReadModelStorage {
  readonly requests: StandardReportPresentationReadModelRequest[] = [];

  loadStandardReportPresentation(request: StandardReportPresentationReadModelRequest): Promise<StandardReportPresentationReportSet> {
    this.requests.push(request);
    const report = nestedPresentationReport();

    return Promise.resolve({
      reportName: "profit_and_loss",
      accountingMethod: "accrual",
      displayColumnsBy: "none",
      primaryReport: report,
      amountColumns: [
        {
          column: {
            columnId: "actual:none:total",
            label: "Total",
            kind: "actual",
            periodStart: request.periodStart,
            periodEnd: request.periodEnd,
            asOfDate: request.asOfDate ?? request.periodEnd,
            displayColumnsBy: "none",
            groupKey: "total"
          },
          report
        }
      ]
    });
  }
}

function enrichedReportInput(): ReportBuilderInput {
  const lineById = new Map(fixture.transactionLines.map((line) => [line.transactionLineId, line]));
  return {
    ...fixture.reportRequest,
    accounts: fixture.accounts,
    postings: fixture.postings.map((posting) =>
      postingWithLineDimensions(posting, posting.transactionLineId === undefined ? undefined : lineById.get(posting.transactionLineId))
    ),
    freshness: {
      status: "fresh",
      sourceId: fixture.source.sourceId,
      importBatchId: fixture.importBatch.importBatchId,
      checkpointId: fixture.checkpoint.checkpointId,
      freshThrough: "2026-02-01T00:00:00.000Z"
    }
  };
}

function nestedPresentationReport(): BuiltReport {
  const tenantId = "tenant_nested_presentation";
  const reportSnapshotId = "snapshot:nested:presentation";
  const reportName = "profit_and_loss";

  return {
    snapshot: {
      reportSnapshotId,
      tenantId,
      reportName,
      snapshotSource: "builder",
      accountingBasis: "accrual",
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
      asOfDate: "2026-01-31",
      currencyCode: "USD",
      generatedAt: "2026-02-01T00:00:00.000Z",
      companyId: "company_nested_presentation",
      sourceId: "source_nested_presentation",
      freshness: { status: "fresh", sourceId: "source_nested_presentation" },
      reconciliationStatus: "not_reconciled",
      reconciliationDifference: "0.00"
    },
    lines: [
      nestedPresentationLine(
        tenantId,
        reportSnapshotId,
        "acct_grandchild",
        "Grandchild",
        "30.00",
        1,
        "profit_and_loss:line:account:acct_child"
      ),
      nestedPresentationLine(
        tenantId,
        reportSnapshotId,
        "acct_child",
        "Child",
        "50.00",
        2,
        "profit_and_loss:line:account:acct_parent"
      ),
      nestedPresentationLine(tenantId, reportSnapshotId, "acct_parent", "Parent", "60.00", 3)
    ],
    totals: [
      {
        tenantId,
        reportTotalId: "total:nested:presentation:expenses",
        reportSnapshotId,
        totalKey: "total_expenses",
        label: "Total Expenses",
        amount: "60.00",
        drilldownRef: { token: "profit_and_loss:total_expenses", accountIds: ["acct_parent", "acct_child", "acct_grandchild"] }
      }
    ],
    metadata: {
      reportName,
      generatedFrom: "ledger_postings",
      reconciliationStatus: "not_reconciled",
      reconciliationDifference: "0.00"
    }
  };
}

function profitAndLossOrderingReport(): BuiltReport {
  return orderingReport(
    "profit_and_loss",
    [
      {
        accountId: "acct_expense_child",
        label: "Expense Child",
        amount: "15.00",
        sortOrder: 5,
        section: "expense",
        parentAccountId: "acct_expense_parent"
      },
      { accountId: "acct_other_expense", label: "Other Expense", amount: "4.00", sortOrder: 70, section: "other_expense" },
      {
        accountId: "acct_income_child",
        label: "Income Child",
        amount: "40.00",
        sortOrder: 5,
        section: "income",
        parentAccountId: "acct_income_parent"
      },
      { accountId: "acct_cogs", label: "COGS", amount: "20.00", sortOrder: 30, section: "cost_of_goods_sold" },
      { accountId: "acct_expense_parent", label: "Expense Parent", amount: "25.00", sortOrder: 40, section: "expense" },
      { accountId: "acct_income_parent", label: "Income Parent", amount: "100.00", sortOrder: 10, section: "income" },
      { accountId: "acct_other_income", label: "Other Income", amount: "6.00", sortOrder: 60, section: "other_income" }
    ],
    [
      { totalKey: "net_income", label: "Net Income", amount: "77.00" },
      { totalKey: "total_other_expense", label: "Total Other Expense", amount: "4.00" },
      { totalKey: "total_expenses", label: "Total Expenses", amount: "25.00" },
      { totalKey: "total_income", label: "Total Income", amount: "100.00" },
      { totalKey: "total_cost_of_goods_sold", label: "Total Cost of Goods Sold", amount: "20.00" },
      { totalKey: "gross_profit", label: "Gross Profit", amount: "80.00" },
      { totalKey: "net_operating_income", label: "Net Operating Income", amount: "55.00" },
      { totalKey: "total_other_income", label: "Total Other Income", amount: "6.00" }
    ]
  );
}

function balanceSheetOrderingReport(): BuiltReport {
  return orderingReport(
    "balance_sheet",
    [
      { accountId: "acct_equity", label: "Equity", amount: "40.00", sortOrder: 30, section: "equity" },
      {
        accountId: "acct_asset_child",
        label: "Asset Child",
        amount: "40.00",
        sortOrder: 5,
        section: "asset",
        parentAccountId: "acct_asset_parent"
      },
      { accountId: "acct_liability", label: "Liability", amount: "60.00", sortOrder: 20, section: "liability" },
      { accountId: "acct_asset_parent", label: "Asset Parent", amount: "100.00", sortOrder: 10, section: "asset" }
    ],
    [
      { totalKey: "total_liabilities_and_equity", label: "Total Liabilities and Equity", amount: "100.00" },
      { totalKey: "total_equity", label: "Total Equity", amount: "40.00" },
      { totalKey: "total_assets", label: "Total Assets", amount: "100.00" },
      { totalKey: "total_liabilities", label: "Total Liabilities", amount: "60.00" }
    ]
  );
}

function trialBalanceOrderingReport(): BuiltReport {
  return orderingReport(
    "trial_balance",
    [
      { accountId: "acct_credit", label: "Credit", amount: "-30.00", sortOrder: 20, section: "credit" },
      {
        accountId: "acct_debit_child",
        label: "Debit Child",
        amount: "30.00",
        sortOrder: 5,
        section: "debit",
        parentAccountId: "acct_debit_parent"
      },
      { accountId: "acct_debit_parent", label: "Debit Parent", amount: "30.00", sortOrder: 10, section: "debit" }
    ],
    [
      { totalKey: "total_credits", label: "Total Credits", amount: "30.00" },
      { totalKey: "total_debits", label: "Total Debits", amount: "30.00" }
    ]
  );
}

type OrderingLineSpec = {
  readonly accountId: string;
  readonly label: string;
  readonly amount: string;
  readonly sortOrder: number;
  readonly section: string;
  readonly parentAccountId?: string;
};

type OrderingTotalSpec = {
  readonly totalKey: string;
  readonly label: string;
  readonly amount: string;
};

function orderingReport(
  reportName: BuiltReport["metadata"]["reportName"],
  lines: readonly OrderingLineSpec[],
  totals: readonly OrderingTotalSpec[]
): BuiltReport {
  const tenantId = `tenant_ordering_${reportName}`;
  const reportSnapshotId = `snapshot:ordering:${reportName}`;

  return {
    snapshot: {
      reportSnapshotId,
      tenantId,
      reportName,
      snapshotSource: "builder",
      accountingBasis: "accrual",
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
      asOfDate: "2026-01-31",
      currencyCode: "USD",
      generatedAt: "2026-02-01T00:00:00.000Z",
      companyId: `company_ordering_${reportName}`,
      sourceId: `source_ordering_${reportName}`,
      freshness: { status: "fresh", sourceId: `source_ordering_${reportName}` },
      reconciliationStatus: "not_reconciled",
      reconciliationDifference: "0.00"
    },
    lines: lines.map((line) => orderingLine(tenantId, reportSnapshotId, reportName, line)),
    totals: totals.map((total) => orderingTotal(tenantId, reportSnapshotId, total)),
    metadata: {
      reportName,
      generatedFrom: "ledger_postings",
      reconciliationStatus: "not_reconciled",
      reconciliationDifference: "0.00"
    }
  };
}

function orderingLine(
  tenantId: string,
  reportSnapshotId: string,
  reportName: BuiltReport["metadata"]["reportName"],
  line: OrderingLineSpec
): BuiltReport["lines"][number] {
  const reportLineId = `${reportName}:line:account:${line.accountId}`;

  return {
    tenantId,
    reportLineId,
    reportSnapshotId,
    ...(line.parentAccountId === undefined ? {} : { parentReportLineId: `${reportName}:line:account:${line.parentAccountId}` }),
    section: line.section,
    label: line.label,
    accountId: line.accountId,
    amount: line.amount,
    sortOrder: line.sortOrder,
    drilldownRef: { token: reportLineId, accountIds: [line.accountId] }
  };
}

function orderingTotal(
  tenantId: string,
  reportSnapshotId: string,
  total: OrderingTotalSpec
): BuiltReport["totals"][number] {
  return {
    tenantId,
    reportTotalId: `total:ordering:${total.totalKey}`,
    reportSnapshotId,
    totalKey: total.totalKey,
    label: total.label,
    amount: total.amount,
    drilldownRef: { token: total.totalKey }
  };
}

function presentationFromReport(report: BuiltReport): StandardReportPresentation {
  return buildStandardReportPresentationFromReports({
    reportName: report.metadata.reportName,
    accountingMethod: "accrual",
    displayColumnsBy: "none",
    primaryReport: report,
    amountColumns: [
      {
        column: {
          columnId: "actual:none:total",
          label: "Total",
          kind: "actual",
          periodStart: report.snapshot.periodStart,
          periodEnd: report.snapshot.periodEnd,
          asOfDate: report.snapshot.asOfDate,
          displayColumnsBy: "none",
          groupKey: "total"
        },
        report
      }
    ]
  });
}

function nestedPresentationLine(
  tenantId: string,
  reportSnapshotId: string,
  accountId: string,
  label: string,
  amount: string,
  sortOrder: number,
  parentReportLineId?: string
): BuiltReport["lines"][number] {
  const reportLineId = `profit_and_loss:line:account:${accountId}`;

  return {
    tenantId,
    reportLineId,
    reportSnapshotId,
    ...(parentReportLineId === undefined ? {} : { parentReportLineId }),
    section: "expense",
    label,
    accountId,
    amount,
    sortOrder,
    drilldownRef: { token: reportLineId, accountIds: [accountId] }
  };
}

function postingWithLineDimensions(posting: LedgerPosting, line: TransactionLine | undefined): LedgerPosting {
  return {
    ...posting,
    ...(line?.partyId === undefined ? {} : { partyId: line.partyId }),
    ...(line?.itemId === undefined ? {} : { itemId: line.itemId })
  };
}

function rowCell(
  presentation: StandardReportPresentation,
  rowId: string,
  columnId: string
): { readonly amount?: string; readonly percent?: string } | undefined {
  return presentation.rows.find((row) => row.rowId === rowId)?.cells.find((cell) => cell.columnId === columnId);
}

function presentationRow(presentation: StandardReportPresentation, rowId: string): StandardReportPresentation["rows"][number] {
  const row = presentation.rows.find((entry) => entry.rowId === rowId);
  if (row === undefined) {
    throw new Error(`missing presentation row ${rowId}`);
  }
  return row;
}
