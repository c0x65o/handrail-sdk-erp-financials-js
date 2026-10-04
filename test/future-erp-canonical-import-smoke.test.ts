import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ERP_FINANCIALS_NORMALIZED_QUICKBOOKS_SYNC_FIXTURES,
  assertNoCredentialKeys,
  buildFutureErpReportFromCanonicalReadModel,
  createFutureErpQuickBooksFullSyncWorker,
  createPostgresStorageAdapter,
  createQuickBooksContractSmokeHarness,
  fetchFutureErpQuickBooksProviderReportParitySnapshot
} from "../src/index.js";

import type {
  BuiltReport,
  CashFlowActivity,
  CashFlowBuilderInput,
  FutureErpCanonicalReportSnapshotStorage,
  FutureErpQuickBooksFullSyncRunResult,
  FutureErpQuickBooksProviderReportParityClient,
  LoadReportBuilderInput,
  NormalizedQuickBooksBalanceSheetReportRequestEnvelope,
  NormalizedQuickBooksCashFlowParityReportRequestEnvelope,
  NormalizedQuickBooksProfitAndLossReportRequestEnvelope,
  NormalizedQuickBooksProviderReportRequestEnvelope,
  NormalizedQuickBooksTrialBalanceReportRequestEnvelope,
  PostgresQueryClient,
  PostgresQueryResult,
  ReportBuilderInput,
  ReportFreshnessRow,
  ReportName,
  RollupBucket,
  StoredReportSnapshot
} from "../src/index.js";

describe("Future ERP deterministic canonical import smoke", () => {
  it("imports normalized QuickBooks fixtures through canonical storage and emits stable reports", async () => {
    const fixture = ERP_FINANCIALS_NORMALIZED_QUICKBOOKS_SYNC_FIXTURES.fullSync;
    const contractHarness = createQuickBooksContractSmokeHarness();
    const postgresClient = new RecordingPostgresClient();
    const postgresStorage = createPostgresStorageAdapter(postgresClient);
    const worker = createFutureErpQuickBooksFullSyncWorker({
      quickBooksClient: {
        fullSync(request) {
          expect(request).toBe(fixture.request);
          return Promise.resolve(fixture.response);
        }
      },
      persistence: postgresStorage,
      companyId: "company_future_erp_qbo_fixture",
      accountingBasis: "accrual",
      currencyCode: "USD",
      importedAt: "2026-02-01T10:15:00.000Z",
      handrailQuickBooksServiceEnvironment: "staging"
    });

    const importResult = await worker.fullSync(fixture.request);
    const reportStorage = new FutureErpSmokeReportStorage(postgresStorage, importResult.facts);
    const reports = {
      profit_and_loss: await buildSmokeReport(reportStorage, importResult, "profit_and_loss"),
      balance_sheet: await buildSmokeReport(reportStorage, importResult, "balance_sheet"),
      trial_balance: await buildSmokeReport(reportStorage, importResult, "trial_balance"),
      cash_flow: await buildSmokeReport(reportStorage, importResult, "cash_flow")
    };
    const paritySnapshot = await fetchFutureErpQuickBooksProviderReportParitySnapshot({
      client: new FixtureQuickBooksProviderReportClient(),
      sourceIdentity: fixture.response.sourceIdentity,
      accountingBasis: "accrual",
      currencyCode: "USD",
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
      asOfDate: "2026-01-31",
      requestedAt: "2026-02-01T10:16:00.000Z",
      comparedAt: "2026-02-01T10:17:00.000Z",
      toleranceAmount: "0.00",
      reports
    });
    const summary = {
      contractSmokeHash: contractHarness.snapshotHash,
      sourceIdentity: contractHarness.snapshot.sourceIdentity,
      import: {
        batchId: importResult.persistence.importBatchId,
        checkpointId: importResult.persistence.checkpointId,
        counts: {
          accounts: importResult.persistence.accounts,
          parties: importResult.persistence.parties,
          items: importResult.persistence.items,
          dimensions: importResult.persistence.dimensions,
          transactions: importResult.persistence.transactions,
          transactionLines: importResult.persistence.transactionLines,
          postings: importResult.persistence.postings
        },
        canonicalPostingTotals: contractHarness.snapshot.canonicalPostingTotals
      },
      postgresTables: postgresClient.touchedTables,
      reports: {
        profitAndLoss: reportTotals(reports.profit_and_loss),
        balanceSheet: reportTotals(reports.balance_sheet),
        trialBalance: reportTotals(reports.trial_balance),
        cashFlow: reportTotals(reports.cash_flow)
      },
      snapshots: reportStorage.writtenReports.map((report) => ({
        reportName: report.snapshot.reportName,
        snapshotId: report.snapshot.reportSnapshotId,
        freshness: report.snapshot.freshness
      })),
      freshnessRows: reportStorage.writtenFreshnessRows.map((row) => ({
        reportName: row.reportName,
        freshnessId: row.freshnessId,
        status: row.status,
        freshThrough: row.freshThrough,
        importBatchId: row.importBatchId,
        checkpointId: row.checkpointId
      })),
      providerParity: paritySnapshot.reports.map((report) => ({
        reportName: report.reportName,
        status: report.status,
        reconciliationStatus: report.reconciliationStatus,
        reconciliationDifference: report.reconciliationDifference,
        totalCount: report.evidence?.totals.length ?? 0,
        unsupportedReason: report.unsupportedReason
      }))
    };
    const summaryHash = hashStable(summary);

    expect(importResult.response).toBe(fixture.response);
    expect(reportStorage.loadCount).toBe(4);
    expect(reportStorage.writtenReports).toHaveLength(4);
    expect(reportStorage.writtenFreshnessRows).toHaveLength(4);
    expect(postgresClient.touchedTables).toEqual([
      "accounting_companies",
      "accounting_dimensions",
      "accounting_sources",
      "accounts",
      "company_sources",
      "financial_lifecycle_events",
      "import_batches",
      "items",
      "ledger_postings",
      "parties",
      "report_freshness",
      "report_snapshot_lines",
      "report_snapshot_totals",
      "report_snapshots",
      "subledger_applications",
      "subledger_documents",
      "sync_checkpoints",
      "transaction_lines",
      "transactions"
    ]);
    expect(summary.reports).toMatchObject(contractHarness.snapshot.reports);
    expect(summary.reports.cashFlow).toEqual({
      cash_beginning: "0.00",
      cash_ending: "500.00",
      net_cash_flow: "500.00",
      net_financing_cash: "0.00",
      net_investing_cash: "0.00",
      net_operating_cash: "500.00",
      unclassified_cash_movement: "0.00"
    });
    expect(paritySnapshot.reports.map((report) => [report.reportName, report.status])).toEqual([
      ["profit_and_loss", "mismatched"],
      ["balance_sheet", "mismatched"],
      ["trial_balance", "mismatched"],
      ["cash_flow", "unsupported"]
    ]);
    expect(summary.providerParity).toContainEqual({
      reportName: "cash_flow",
      status: "unsupported",
      reconciliationStatus: undefined,
      reconciliationDifference: undefined,
      totalCount: 0,
      unsupportedReason: "quickbooks_cash_flow_parity_report_not_supported"
    });
    expect(paritySnapshot.reports.find((report) => report.reportName === "cash_flow")?.evidence).toBeUndefined();
    expect(paritySnapshot.reports.find((report) => report.reportName === "cash_flow")?.providerReport?.totals).toEqual([]);
    expect(summary).toMatchObject({
      contractSmokeHash: "d81a1ede70ed9a8d434f4e637261d930caeac63696e72c036ddc08ce63556dc6",
      import: {
        batchId: "batch_qbo_full_fixture_2026_01",
        checkpointId: "checkpoint_qbo_full_fixture_2026_01",
        counts: {
          accounts: 2,
          dimensions: 1,
          items: 1,
          parties: 2,
          postings: 2,
          transactionLines: 2,
          transactions: 1
        }
      }
    });
    expect(summaryHash).toBe("2818efff7c8723d9f8d1b79e128b42e5dd50dbaad627b32b60c5554c99b7de83");
    expect(JSON.stringify({ importResult, reports, paritySnapshot, summary })).not.toMatch(
      /access[_-]?token|refresh[_-]?token|client[_-]?secret|clientSecret|credential|rawPayload|rawProviderPayload/i
    );
    assertNoCredentialKeys(summary);
  });
});

class RecordingPostgresClient implements PostgresQueryClient {
  readonly calls: { readonly sql: string; readonly params: readonly unknown[] }[] = [];

  get touchedTables(): readonly string[] {
    return [...new Set(this.calls.flatMap((call) => tableNames(call.sql)))].sort();
  }

  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = []
  ): Promise<PostgresQueryResult<Row>> {
    this.calls.push({ sql, params });

    return Promise.resolve({
      rows: [],
      rowCount: null
    });
  }
}

class FutureErpSmokeReportStorage implements FutureErpCanonicalReportSnapshotStorage {
  readonly writtenReports: BuiltReport[] = [];
  readonly writtenFreshnessRows: ReportFreshnessRow[] = [];
  loadCount = 0;

  constructor(
    private readonly postgresStorage: Pick<FutureErpCanonicalReportSnapshotStorage, "writeReportSnapshot" | "writeFreshnessRows">,
    private readonly facts: FutureErpQuickBooksFullSyncRunResult["facts"]
  ) {}

  loadReportBuilderInput(input: LoadReportBuilderInput): Promise<ReportBuilderInput> {
    this.loadCount += 1;

    return Promise.resolve({
      tenantId: input.tenantId,
      companyId: input.companyId,
      accounts: this.facts.accounts,
      postings: this.facts.postings,
      accountingBasis: input.accountingBasis,
      sourceId: input.sourceId,
      currencyCode: input.currencyCode,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      ...(input.asOfDate === undefined ? {} : { asOfDate: input.asOfDate }),
      ...(input.generatedAt === undefined ? {} : { generatedAt: input.generatedAt }),
      freshness: {
        status: "fresh",
        sourceId: this.facts.source.sourceId,
        importBatchId: this.facts.importBatch.importBatchId,
        checkpointId: this.facts.checkpoint.checkpointId,
        ...(this.facts.checkpoint.freshThrough === undefined ? {} : { freshThrough: this.facts.checkpoint.freshThrough })
      }
    });
  }

  loadLatestReportSnapshot(): Promise<StoredReportSnapshot | undefined> {
    return Promise.resolve(undefined);
  }

  loadRollupBuckets(): Promise<readonly RollupBucket[]> {
    return Promise.resolve([]);
  }

  async writeReportSnapshot(report: BuiltReport): Promise<number> {
    this.writtenReports.push(report);

    return this.postgresStorage.writeReportSnapshot(report);
  }

  async writeFreshnessRows(rows: readonly ReportFreshnessRow[]): Promise<number> {
    this.writtenFreshnessRows.push(...rows);

    return this.postgresStorage.writeFreshnessRows(rows);
  }
}

class FixtureQuickBooksProviderReportClient implements FutureErpQuickBooksProviderReportParityClient {
  readonly requests: NormalizedQuickBooksProviderReportRequestEnvelope[] = [];

  profitAndLossReport(request: NormalizedQuickBooksProfitAndLossReportRequestEnvelope) {
    this.requests.push(request);

    return Promise.resolve(ERP_FINANCIALS_NORMALIZED_QUICKBOOKS_SYNC_FIXTURES.providerReports.profitAndLoss.response);
  }

  balanceSheetReport(request: NormalizedQuickBooksBalanceSheetReportRequestEnvelope) {
    this.requests.push(request);

    return Promise.resolve(ERP_FINANCIALS_NORMALIZED_QUICKBOOKS_SYNC_FIXTURES.providerReports.balanceSheet.response);
  }

  trialBalanceReport(request: NormalizedQuickBooksTrialBalanceReportRequestEnvelope) {
    this.requests.push(request);

    return Promise.resolve(ERP_FINANCIALS_NORMALIZED_QUICKBOOKS_SYNC_FIXTURES.providerReports.trialBalance.response);
  }

  cashFlowParityReport(request: NormalizedQuickBooksCashFlowParityReportRequestEnvelope) {
    this.requests.push(request);

    return Promise.resolve(ERP_FINANCIALS_NORMALIZED_QUICKBOOKS_SYNC_FIXTURES.providerReports.cashFlow.response);
  }
}

async function buildSmokeReport(
  storage: FutureErpCanonicalReportSnapshotStorage,
  importResult: FutureErpQuickBooksFullSyncRunResult,
  reportName: ReportName
): Promise<BuiltReport> {
  const freshThrough = importResult.facts.checkpoint.freshThrough;
  const result = await buildFutureErpReportFromCanonicalReadModel(storage, {
    tenantId: importResult.facts.company.tenantId,
    companyId: importResult.facts.company.companyId,
    sourceId: importResult.facts.source.sourceId,
    reportName,
    accountingBasis: "accrual",
    periodStart: "2026-01-01",
    periodEnd: "2026-01-31",
    asOfDate: "2026-01-31",
    currencyCode: "USD",
    generatedAt: "2026-02-01T10:15:00.000Z",
    preferStoredSnapshot: false,
    persistGeneratedSnapshot: true,
    ...(reportName === "cash_flow" ? { cashFlow: smokeCashFlowOptions(importResult) } : {}),
    ...(freshThrough === undefined
      ? {}
      : {
          sourceFreshThrough: freshThrough,
          importedThrough: freshThrough
        }),
    importBatchId: importResult.facts.importBatch.importBatchId,
    checkpointId: importResult.facts.checkpoint.checkpointId,
    tenantAccess: {
      tenantId: importResult.facts.company.tenantId,
      sourceIds: [importResult.facts.source.sourceId]
    }
  });

  expect(result.source).toBe("canonical_facts");
  expect(result.persistence).toBeDefined();
  expect(result.report.snapshot.freshness).toMatchObject({
    status: "fresh",
    sourceId: importResult.facts.source.sourceId,
    importBatchId: importResult.facts.importBatch.importBatchId,
    checkpointId: importResult.facts.checkpoint.checkpointId
  });

  return result.report;
}

function smokeCashFlowOptions(
  importResult: FutureErpQuickBooksFullSyncRunResult
): Pick<CashFlowBuilderInput, "cashAccountIds" | "activityByAccountId"> {
  const cashAccountIds = importResult.facts.accounts
    .filter(
      (account) =>
        account.active &&
        account.classification === "asset" &&
        (account.type.toLowerCase() === "bank" || account.subtype?.toLowerCase().includes("checking") === true)
    )
    .map((account) => account.accountId);
  const activityByAccountId = Object.fromEntries(
    importResult.facts.accounts
      .filter((account) => !cashAccountIds.includes(account.accountId))
      .map((account): readonly [string, Exclude<CashFlowActivity, "unclassified">] => [
        account.accountId,
        cashFlowActivityForAccount(account.classification)
      ])
  );

  return {
    cashAccountIds,
    activityByAccountId
  };
}

function cashFlowActivityForAccount(classification: string): Exclude<CashFlowActivity, "unclassified"> {
  if (classification === "liability" || classification === "equity") {
    return "financing";
  }
  if (classification === "asset") {
    return "investing";
  }
  return "operating";
}

function tableNames(sql: string): readonly string[] {
  return [...sql.matchAll(/"erp_financials"\."([^"]+)"/g)].map((match) => String(match[1]));
}

function reportTotals(report: BuiltReport): Record<string, string> {
  return Object.fromEntries(
    [...report.totals].sort((left, right) => left.totalKey.localeCompare(right.totalKey)).map((total) => [total.totalKey, total.amount])
  );
}

function hashStable(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value, null, 2)).digest("hex");
}
