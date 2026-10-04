import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  assertNoCredentialKeys,
  buildNormalizedQuickBooksFullSyncResponse,
  createPostgresStorageAdapter,
  ERP_FINANCIALS_NORMALIZED_QUICKBOOKS_SYNC_FIXTURES,
  runFutureErpQuickBooksSandboxReplay
} from "../src/index.js";

import type {
  FutureErpQuickBooksSandboxReplayClient,
  NormalizedQuickBooksAccountResource,
  NormalizedQuickBooksFullSyncResponseEnvelope,
  NormalizedQuickBooksLedgerEntryResource,
  NormalizedQuickBooksResourceSet,
  PostgresQueryClient,
  PostgresQueryResult,
  PostgresStorageAdapter,
  ReportName,
  SafeSourcePayloadRef
} from "../src/index.js";

type ReplayStorageCall = {
  readonly method: ReplayWriteMethod;
  readonly entity: ReplayWriteEntity;
  readonly ids: readonly string[];
  readonly lineIds?: readonly string[];
  readonly lines?: readonly ReplaySnapshotLine[];
  readonly totalIds?: readonly string[];
};

type ReplaySnapshotLine = {
  readonly reportLineId: string;
  readonly parentReportLineId?: string;
  readonly accountId?: string;
  readonly amount: string;
  readonly sortOrder: number;
  readonly drilldownRef: {
    readonly accountIds?: readonly string[];
    readonly postingIds?: readonly string[];
    readonly query?: {
      readonly accountIds?: readonly string[];
    };
  };
};

type ReplayWriteMethod =
  | "upsertAccountingCompany"
  | "upsertAccountingSource"
  | "upsertCompanySourceBinding"
  | "upsertImportBatch"
  | "upsertSyncCheckpoint"
  | "upsertAccounts"
  | "upsertParties"
  | "upsertItems"
  | "upsertDimensions"
  | "upsertTransactions"
  | "upsertTransactionLines"
  | "upsertLedgerPostings"
  | "writeReportSnapshot"
  | "writeFreshnessRows";

type ReplayWriteEntity =
  | "companies"
  | "sources"
  | "company_sources"
  | "import_batches"
  | "checkpoints"
  | "accounts"
  | "parties"
  | "items"
  | "dimensions"
  | "transactions"
  | "transaction_lines"
  | "postings"
  | "report_snapshots"
  | "snapshot_lines"
  | "snapshot_totals"
  | "freshness";

type QueryCall = {
  readonly sql: string;
  readonly params: readonly unknown[];
};

const EXPECTED_REPLAY_WRITE_ENTITIES: readonly ReplayWriteEntity[] = [
  "companies",
  "sources",
  "company_sources",
  "import_batches",
  "checkpoints",
  "accounts",
  "parties",
  "items",
  "dimensions",
  "transactions",
  "transaction_lines",
  "postings",
  "report_snapshots",
  "snapshot_lines",
  "snapshot_totals",
  "freshness",
  "report_snapshots",
  "snapshot_lines",
  "snapshot_totals",
  "freshness",
  "report_snapshots",
  "snapshot_lines",
  "snapshot_totals",
  "freshness",
  "report_snapshots",
  "snapshot_lines",
  "snapshot_totals",
  "freshness"
];

const REPORT_NAMES: readonly ReportName[] = ["profit_and_loss", "balance_sheet", "trial_balance", "cash_flow"];
const EXPECTED_REPLAY_EVIDENCE_HASH = "1138a5e8ac5a54ac3bc9c46209db7d47b66e59ae3127ff1dcc30a9d69b9b806f";

describe("Future ERP QuickBooks sandbox replay orchestration", () => {
  it("returns a bounded deterministic replay result without credentials or raw provider payloads", async () => {
    const result = await runFutureErpQuickBooksSandboxReplay();

    expect(result.sourceIdentity).toEqual({
      tenantId: "tenant_qbo_sync_fixture",
      sourceId: "source_qbo_sync_fixture",
      sourceSystem: "quickbooks",
      providerEnvironment: "sandbox",
      sourceCompanyRef: "realm_qbo_sync_fixture",
      realmId: "realm_qbo_sync_fixture",
      connectionRef: "handrail-quickbooks-sdk:staging:sandbox:realm:realm_qbo_sync_fixture",
      handrailQuickBooksServiceEnvironment: "staging"
    });
    expect(result.importBatchId).toBe("batch_qbo_full_fixture_2026_01");
    expect(result.checkpointId).toBe("checkpoint_qbo_full_fixture_2026_01");
    expect(result.importBatch).toEqual({
      importBatchId: "batch_qbo_full_fixture_2026_01",
      mode: "initial",
      status: "completed",
      startedAt: "2026-02-01T10:00:00.000Z",
      completedAt: "2026-02-01T10:00:05.000Z"
    });
    expect(result.checkpoint).toEqual({
      checkpointId: "checkpoint_qbo_full_fixture_2026_01",
      sourceObject: "quickbooks_full_sync",
      cursorKind: "full_scan",
      cursorValue: "full:realm_qbo_sync_fixture:2026-02-01T10:00:00.000Z",
      freshThrough: "2026-02-01T10:00:00.000Z",
      latestSourceUpdatedAt: "2026-02-01T09:59:59.000Z",
      status: "current"
    });
    expect(result.normalizedResourceCounts).toEqual({
      companyInfo: 1,
      accounts: 2,
      journalEntries: 1,
      ledgerEntries: 1,
      ledgerTransactions: 0,
      ledgerPostings: 2,
      customers: 1,
      vendors: 1,
      items: 1,
      departments: 1,
      classes: 0,
      dimensions: 1,
      parties: 0,
      providerReports: 0,
      reconciliationEvidence: 0
    });
    expect(result.canonicalRowCounts).toEqual({
      companies: 1,
      sources: 1,
      importBatches: 1,
      checkpoints: 1,
      accounts: 2,
      parties: 2,
      items: 1,
      dimensions: 1,
      transactions: 1,
      transactionLines: 2,
      postings: 2
    });
    expect(result.reportStatuses).toEqual({
      profit_and_loss: "generated",
      balance_sheet: "generated",
      trial_balance: "generated",
      cash_flow: "supported"
    });
    expect(Object.keys(result.reports).sort()).toEqual(["balance_sheet", "cash_flow", "profit_and_loss", "trial_balance"]);
    expect(Object.values(result.reports).map((report) => report.freshnessStatus)).toEqual(["fresh", "fresh", "fresh", "fresh"]);
    expect(Object.values(result.reports).map((report) => report.freshnessRowsWritten)).toEqual([1, 1, 1, 1]);
    expect(result.snapshotIds).toEqual({
      profit_and_loss: result.reports.profit_and_loss.snapshotId,
      balance_sheet: result.reports.balance_sheet.snapshotId,
      trial_balance: result.reports.trial_balance.snapshotId,
      cash_flow: result.reports.cash_flow.snapshotId
    });
    expect(result.freshnessIds).toEqual({
      profit_and_loss: result.reports.profit_and_loss.freshnessId,
      balance_sheet: result.reports.balance_sheet.freshnessId,
      trial_balance: result.reports.trial_balance.freshnessId,
      cash_flow: result.reports.cash_flow.freshnessId
    });
    expect(result.parityStatuses).toEqual({
      profit_and_loss: "mismatched",
      balance_sheet: "mismatched",
      trial_balance: "mismatched",
      cash_flow: "unsupported"
    });
    expect(result.providerParity.status).toBe("mismatched");
    expect(result.providerParity.reports.map((report) => [report.reportName, report.status, report.evidenceTotalCount])).toEqual([
      ["profit_and_loss", "mismatched", 8],
      ["balance_sheet", "mismatched", 4],
      ["trial_balance", "mismatched", 2],
      ["cash_flow", "unsupported", 0]
    ]);
    expect(Object.values(result.safeDrilldownRefs).every((refs) => refs.lineRefs.length <= 4 && refs.totalRefs.length <= 4)).toBe(true);
    expect(result.safeDrilldownRefs.profit_and_loss.totalRefs[0]?.refId).toContain("profit_and_loss");
    expect(JSON.stringify(result)).not.toMatch(
      /access[_-]?token|refresh[_-]?token|client[_-]?secret|clientSecret|credential|rawPayload|rawProviderPayload/i
    );
    assertNoCredentialKeys(result);
    expect(replayEvidenceHash(result)).toBe(EXPECTED_REPLAY_EVIDENCE_HASH);
  });

  it("writes canonical facts, report snapshots, and freshness in order with repeatable replay ids", async () => {
    const client = new RecordingReplayPostgresClient();
    const recorded = recordReplayStorage(createPostgresStorageAdapter(client));

    const first = await runFutureErpQuickBooksSandboxReplay({ postgresStorage: recorded.storage });
    const firstCalls = recorded.calls.slice();
    const firstQueryTables = writeQueryTables(client.calls);
    const firstQueryCount = client.calls.length;
    const firstQueryCalls = client.calls.slice(0, firstQueryCount);

    const second = await runFutureErpQuickBooksSandboxReplay({ postgresStorage: recorded.storage });
    const secondCalls = recorded.calls.slice(firstCalls.length);
    const secondQueryTables = writeQueryTables(client.calls.slice(firstQueryCount));

    expect(writeEntities(firstCalls)).toEqual(EXPECTED_REPLAY_WRITE_ENTITIES);
    expect(writeEntities(secondCalls)).toEqual(EXPECTED_REPLAY_WRITE_ENTITIES);
    expect(secondCalls.map(callIdentity)).toEqual(firstCalls.map(callIdentity));
    expect(secondQueryTables).toEqual(firstQueryTables);
    expect(firstQueryTables).toEqual([
      "accounting_companies",
      "accounting_sources",
      "company_sources",
      "import_batches",
      "sync_checkpoints",
      "accounts",
      "parties",
      "items",
      "accounting_dimensions",
      "transactions",
      "transaction_lines",
      "ledger_postings",
      ...REPORT_NAMES.flatMap(() => [
        "report_snapshots",
        "report_snapshot_lines",
        "report_snapshot_totals",
        "report_snapshot_lines",
        "report_snapshot_totals",
        "report_freshness"
      ])
    ]);
    const importBatchRows = insertedRowsForTable(firstQueryCalls, "import_batches");
    expect(importBatchRows).toHaveLength(1);
    expect(importBatchRows[0]).toMatchObject({ import_batch_id: first.importBatchId, status: "completed" });
    expect(requiredRecord(importBatchRows[0]?.source_object_counts, "source_object_counts")).toMatchObject({
      accounts: 2,
      journalEntries: 1,
      ledgerPostings: 2
    });
    expect(insertedRowsForTable(firstQueryCalls, "sync_checkpoints")).toEqual([
      expect.objectContaining({
        checkpoint_id: first.checkpointId,
        cursor_kind: "full_scan",
        cursor_value: "full:realm_qbo_sync_fixture:2026-02-01T10:00:00.000Z",
        fresh_through: "2026-02-01T10:00:00.000Z",
        latest_source_updated_at: "2026-02-01T09:59:59.000Z",
        status: "current"
      })
    ]);
    const postingRows = insertedRowsForTable(firstQueryCalls, "ledger_postings");
    expect(
      postingRows.some((row) => {
        const sourcePayloadRef = requiredRecord(row.source_payload_ref, "source_payload_ref");
        return (
          row.import_batch_id === first.importBatchId &&
          row.checkpoint_id === first.checkpointId &&
          typeof sourcePayloadRef.storageRef === "string" &&
          /^quickbooks-sdk:\/\/sandbox\/realm\/realm_qbo_sync_fixture\//u.test(sourcePayloadRef.storageRef)
        );
      })
    ).toBe(true);
    const freshnessRows = insertedRowsForTable(firstQueryCalls, "report_freshness");
    const snapshotRows = insertedRowsForTable(firstQueryCalls, "report_snapshots");
    for (const reportName of REPORT_NAMES) {
      expect(freshnessRows.find((row) => row.report_name === reportName)).toMatchObject({
        freshness_id: first.freshnessIds[reportName],
        report_name: reportName,
        status: "fresh",
        import_batch_id: first.importBatchId,
        checkpoint_id: first.checkpointId
      });
      const snapshot = snapshotRows.find((row) => row.report_name === reportName);
      expect(snapshot).toMatchObject({
        report_snapshot_id: first.snapshotIds[reportName],
        report_name: reportName
      });
      expect(requiredRecord(snapshot?.freshness, "freshness")).toMatchObject({
        status: "fresh",
        importBatchId: first.importBatchId,
        checkpointId: first.checkpointId
      });
    }
    expect(insertQueries(client.calls).every((call) => call.sql.includes("on conflict"))).toBe(true);
    expect(first.snapshotIds).toEqual(second.snapshotIds);
    expect(first.freshnessIds).toEqual(second.freshnessIds);
    expect(first.snapshotIds).toEqual({
      profit_and_loss:
        "snapshot:tenant_qbo_sync_fixture:company_future_erp_qbo_fixture:source_qbo_sync_fixture:profit_and_loss:builder:accrual:2026-01-01:2026-01-31:2026-01-31:USD",
      balance_sheet:
        "snapshot:tenant_qbo_sync_fixture:company_future_erp_qbo_fixture:source_qbo_sync_fixture:balance_sheet:builder:accrual:2026-01-01:2026-01-31:2026-01-31:USD",
      trial_balance:
        "snapshot:tenant_qbo_sync_fixture:company_future_erp_qbo_fixture:source_qbo_sync_fixture:trial_balance:builder:accrual:2026-01-01:2026-01-31:2026-01-31:USD",
      cash_flow:
        "snapshot:tenant_qbo_sync_fixture:company_future_erp_qbo_fixture:source_qbo_sync_fixture:cash_flow:builder:accrual:2026-01-01:2026-01-31:2026-01-31:USD"
    });
    expect(first.freshnessIds).toEqual({
      profit_and_loss:
        "freshness:tenant_qbo_sync_fixture:company_future_erp_qbo_fixture:source_qbo_sync_fixture:profit_and_loss:accrual:2026-01-01:2026-01-31:USD",
      balance_sheet:
        "freshness:tenant_qbo_sync_fixture:company_future_erp_qbo_fixture:source_qbo_sync_fixture:balance_sheet:accrual:2026-01-01:2026-01-31:USD",
      trial_balance:
        "freshness:tenant_qbo_sync_fixture:company_future_erp_qbo_fixture:source_qbo_sync_fixture:trial_balance:accrual:2026-01-01:2026-01-31:USD",
      cash_flow:
        "freshness:tenant_qbo_sync_fixture:company_future_erp_qbo_fixture:source_qbo_sync_fixture:cash_flow:accrual:2026-01-01:2026-01-31:USD"
    });
  });

  it("persists and exposes nested replay snapshot lines and drilldown refs from canonical parent account ids", async () => {
    const client = new RecordingReplayPostgresClient();
    const recorded = recordReplayStorage(createPostgresStorageAdapter(client));
    const nested = nestedReplayFixtureIds();

    const result = await runFutureErpQuickBooksSandboxReplay({
      postgresStorage: recorded.storage,
      quickBooksClient: nestedQuickBooksReplayClient(),
      maxDrilldownRefsPerReport: 6
    });

    expect(result.normalizedResourceCounts).toMatchObject({
      accounts: 4,
      journalEntries: 1,
      ledgerEntries: 1,
      ledgerTransactions: 0,
      ledgerPostings: 3
    });
    expect(result.canonicalRowCounts).toMatchObject({
      accounts: 4,
      transactions: 1,
      transactionLines: 3,
      postings: 3
    });

    const profitAndLossWrite = requiredSnapshotWrite(recorded.calls, result.snapshotIds.profit_and_loss);
    const parent = requiredReplayLine(profitAndLossWrite.lines ?? [], nested.parentAccountId);
    const child = requiredReplayLine(profitAndLossWrite.lines ?? [], nested.childAccountId);
    const grandchild = requiredReplayLine(profitAndLossWrite.lines ?? [], nested.grandchildAccountId);

    expect(parent.reportLineId).toBe(`${result.snapshotIds.profit_and_loss}:line:account:${nested.parentAccountId}`);
    expect(child.reportLineId).toBe(`${result.snapshotIds.profit_and_loss}:line:account:${nested.childAccountId}`);
    expect(grandchild.reportLineId).toBe(`${result.snapshotIds.profit_and_loss}:line:account:${nested.grandchildAccountId}`);
    expect(child.parentReportLineId).toBe(parent.reportLineId);
    expect(grandchild.parentReportLineId).toBe(child.reportLineId);
    expect(parent.sortOrder).toBeLessThan(child.sortOrder);
    expect(child.sortOrder).toBeLessThan(grandchild.sortOrder);
    expect(parent.amount).toBe("750.00");
    expect(child.amount).toBe("250.00");
    expect(grandchild.amount).toBe("250.00");

    expectReplayLineDrilldown(parent, [nested.parentAccountId, nested.childAccountId, nested.grandchildAccountId], [
      nested.parentPostingId,
      nested.grandchildPostingId
    ]);
    expectReplayLineDrilldown(child, [nested.childAccountId, nested.grandchildAccountId], [nested.grandchildPostingId]);
    expectReplayLineDrilldown(grandchild, [nested.grandchildAccountId], [nested.grandchildPostingId]);

    const persistedProfitAndLossLines = reportSnapshotLineRows(client.calls).filter(
      (row) => row.report_snapshot_id === result.snapshotIds.profit_and_loss
    );
    expect(persistedProfitAndLossLines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          report_line_id: child.reportLineId,
          parent_report_line_id: parent.reportLineId,
          account_id: nested.childAccountId,
          amount: "250.00"
        }),
        expect.objectContaining({
          report_line_id: grandchild.reportLineId,
          parent_report_line_id: child.reportLineId,
          account_id: nested.grandchildAccountId,
          amount: "250.00"
        })
      ])
    );

    const safeParent = requiredSafeLineRef(result.safeDrilldownRefs.profit_and_loss.lineRefs, parent.reportLineId);
    const safeChild = requiredSafeLineRef(result.safeDrilldownRefs.profit_and_loss.lineRefs, child.reportLineId);
    const safeGrandchild = requiredSafeLineRef(result.safeDrilldownRefs.profit_and_loss.lineRefs, grandchild.reportLineId);

    expectSafeReplayDrilldown(safeParent, [nested.parentAccountId, nested.childAccountId, nested.grandchildAccountId], [
      nested.parentPostingId,
      nested.grandchildPostingId
    ]);
    expectSafeReplayDrilldown(safeChild, [nested.childAccountId, nested.grandchildAccountId], [nested.grandchildPostingId]);
    expectSafeReplayDrilldown(safeGrandchild, [nested.grandchildAccountId], [nested.grandchildPostingId]);
    expect(Object.values(result.safeDrilldownRefs).every((refs) => refs.lineRefs.length <= 6 && refs.totalRefs.length <= 6)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(
      /access[_-]?token|refresh[_-]?token|client[_-]?secret|clientSecret|credential|rawPayload|rawProviderPayload|parentAccountRef|ParentRef/i
    );
    assertNoCredentialKeys(result);
  });
});

class RecordingReplayPostgresClient implements PostgresQueryClient {
  readonly calls: QueryCall[] = [];

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

function recordReplayStorage(base: PostgresStorageAdapter): {
  readonly storage: PostgresStorageAdapter;
  readonly calls: ReplayStorageCall[];
} {
  const calls: ReplayStorageCall[] = [];
  const storage: PostgresStorageAdapter = {
    ...base,
    async upsertAccountingCompany(...args) {
      calls.push({ method: "upsertAccountingCompany", entity: "companies", ids: [args[0].companyId] });
      return base.upsertAccountingCompany(...args);
    },
    async upsertAccountingSource(...args) {
      calls.push({ method: "upsertAccountingSource", entity: "sources", ids: [args[0].sourceId] });
      return base.upsertAccountingSource(...args);
    },
    async upsertCompanySourceBinding(...args) {
      calls.push({
        method: "upsertCompanySourceBinding",
        entity: "company_sources",
        ids: [args[0].companySourceId]
      });
      return base.upsertCompanySourceBinding(...args);
    },
    async upsertImportBatch(...args) {
      calls.push({ method: "upsertImportBatch", entity: "import_batches", ids: [args[0].importBatchId] });
      return base.upsertImportBatch(...args);
    },
    async upsertSyncCheckpoint(...args) {
      calls.push({ method: "upsertSyncCheckpoint", entity: "checkpoints", ids: [args[0].checkpointId] });
      return base.upsertSyncCheckpoint(...args);
    },
    async upsertAccounts(...args) {
      calls.push({ method: "upsertAccounts", entity: "accounts", ids: args[0].map((account) => account.accountId) });
      return base.upsertAccounts(...args);
    },
    async upsertParties(...args) {
      calls.push({ method: "upsertParties", entity: "parties", ids: args[0].map((party) => party.partyId) });
      return base.upsertParties(...args);
    },
    async upsertItems(...args) {
      calls.push({ method: "upsertItems", entity: "items", ids: args[0].map((item) => item.itemId) });
      return base.upsertItems(...args);
    },
    async upsertDimensions(...args) {
      calls.push({ method: "upsertDimensions", entity: "dimensions", ids: args[0].map((dimension) => dimension.dimensionId) });
      return base.upsertDimensions(...args);
    },
    async upsertTransactions(...args) {
      calls.push({
        method: "upsertTransactions",
        entity: "transactions",
        ids: args[0].map((transaction) => transaction.transactionId)
      });
      return base.upsertTransactions(...args);
    },
    async upsertTransactionLines(...args) {
      calls.push({
        method: "upsertTransactionLines",
        entity: "transaction_lines",
        ids: args[0].map((line) => line.transactionLineId)
      });
      return base.upsertTransactionLines(...args);
    },
    async upsertLedgerPostings(...args) {
      calls.push({ method: "upsertLedgerPostings", entity: "postings", ids: args[0].map((posting) => posting.postingId) });
      return base.upsertLedgerPostings(...args);
    },
    async writeReportSnapshot(...args) {
      calls.push({
        method: "writeReportSnapshot",
        entity: "report_snapshots",
        ids: [args[0].snapshot.reportSnapshotId],
        lineIds: args[0].lines.map((line) => line.reportLineId),
        lines: args[0].lines.map((line) => ({
          reportLineId: line.reportLineId,
          ...(line.parentReportLineId === undefined ? {} : { parentReportLineId: line.parentReportLineId }),
          ...(line.accountId === undefined ? {} : { accountId: line.accountId }),
          amount: line.amount,
          sortOrder: line.sortOrder,
          drilldownRef: line.drilldownRef
        })),
        totalIds: args[0].totals.map((total) => total.reportTotalId)
      });
      return base.writeReportSnapshot(...args);
    },
    async writeFreshnessRows(...args) {
      calls.push({ method: "writeFreshnessRows", entity: "freshness", ids: args[0].map((row) => row.freshnessId) });
      return base.writeFreshnessRows(...args);
    }
  };

  return { storage, calls };
}

function writeEntities(calls: readonly ReplayStorageCall[]): readonly ReplayWriteEntity[] {
  return calls.flatMap((call) =>
    call.method === "writeReportSnapshot" ? ["report_snapshots", "snapshot_lines", "snapshot_totals"] : [call.entity]
  );
}

function callIdentity(call: ReplayStorageCall): ReplayStorageCall {
  return {
    method: call.method,
    entity: call.entity,
    ids: call.ids,
    ...(call.lineIds === undefined ? {} : { lineIds: call.lineIds }),
    ...(call.lines === undefined ? {} : { lines: call.lines }),
    ...(call.totalIds === undefined ? {} : { totalIds: call.totalIds })
  };
}

function insertQueries(calls: readonly QueryCall[]): readonly QueryCall[] {
  return calls.filter((call) => call.sql.trimStart().startsWith("insert into "));
}

function writeQueryTables(calls: readonly QueryCall[]): readonly string[] {
  return calls
    .filter((call) => call.sql.trimStart().startsWith("insert into ") || call.sql.trimStart().startsWith("delete from "))
    .map((call) => {
      const match = /(?:insert into|delete from) "erp_financials"\."([^"]+)"/u.exec(call.sql);
      if (match?.[1] === undefined) {
        throw new Error(`could not read table name from SQL: ${call.sql}`);
      }
      return match[1];
    });
}

function replayEvidenceHash(result: Awaited<ReturnType<typeof runFutureErpQuickBooksSandboxReplay>>): string {
  const evidence = {
    importBatchId: result.importBatchId,
    checkpointId: result.checkpointId,
    sourceIdentity: result.sourceIdentity,
    importBatch: result.importBatch,
    checkpoint: result.checkpoint,
    normalizedResourceCounts: result.normalizedResourceCounts,
    canonicalRowCounts: result.canonicalRowCounts,
    reportStatuses: result.reportStatuses,
    reports: Object.fromEntries(
      REPORT_NAMES.map((reportName) => {
        const report = result.reports[reportName];
        return [
          reportName,
          {
            status: report.status,
            freshnessStatus: report.freshnessStatus,
            reconciliationStatus: report.reconciliationStatus,
            reconciliationDifference: report.reconciliationDifference,
            snapshotId: report.snapshotId,
            freshnessId: report.freshnessId,
            lineCount: report.lineCount,
            totalCount: report.totalCount,
            snapshotRowsWritten: report.snapshotRowsWritten,
            freshnessRowsWritten: report.freshnessRowsWritten
          }
        ];
      })
    ),
    snapshotIds: result.snapshotIds,
    freshnessIds: result.freshnessIds,
    parityStatuses: result.parityStatuses,
    providerParity: result.providerParity,
    safeDrilldownRefs: result.safeDrilldownRefs
  };

  return createHash("sha256").update(JSON.stringify(evidence, null, 2)).digest("hex");
}

function nestedQuickBooksReplayClient(): FutureErpQuickBooksSandboxReplayClient {
  const fixtures = ERP_FINANCIALS_NORMALIZED_QUICKBOOKS_SYNC_FIXTURES;
  const fullSyncResponse = nestedQuickBooksFullSyncResponse();

  return {
    fullSync: () => Promise.resolve(fullSyncResponse),
    profitAndLossReport: () => Promise.resolve(fixtures.providerReports.profitAndLoss.response),
    balanceSheetReport: () => Promise.resolve(fixtures.providerReports.balanceSheet.response),
    trialBalanceReport: () => Promise.resolve(fixtures.providerReports.trialBalance.response),
    cashFlowParityReport: () => Promise.resolve(fixtures.providerReports.cashFlow.response)
  };
}

function nestedQuickBooksFullSyncResponse(): NormalizedQuickBooksFullSyncResponseEnvelope {
  const fixture = ERP_FINANCIALS_NORMALIZED_QUICKBOOKS_SYNC_FIXTURES.fullSync;
  const resources = fixture.resources;
  const checking = requiredAccountResource(resources, "35");
  const servicesParent = requiredAccountResource(resources, "79");
  const journalEntry = requiredJournalEntryResource(resources, "100");
  const cashLine = requiredJournalLine(journalEntry, "1");
  const parentRevenueLine = requiredJournalLine(journalEntry, "2");
  const child = derivedAccountResource(servicesParent, {
    sourceAccountId: "80",
    name: "Services Rollup",
    accountNumber: "4010",
    parentSourceAccountId: "79",
    parentName: "Services"
  });
  const grandchild = derivedAccountResource(servicesParent, {
    sourceAccountId: "81",
    name: "Implementation Services",
    accountNumber: "4011",
    parentSourceAccountId: "80",
    parentName: "Services Rollup"
  });

  const nestedResources: NormalizedQuickBooksResourceSet = {
    ...resources,
    accounts: [checking, servicesParent, child, grandchild],
    journalEntries: [
      {
        ...journalEntry,
        resource: {
          ...journalEntry.resource,
          memo: "Recognize services revenue across nested accounts",
          lines: [
            withSinglePostingAmount(cashLine, "750.00", "debit"),
            parentRevenueLine,
            derivedRevenueLine(parentRevenueLine, {
              sourceLineId: "3",
              lineNumber: 3,
              description: "Implementation services revenue",
              sourcePostingId: "100:3",
              amount: "-250.00",
              sourceAccountId: "81",
              accountName: "Implementation Services"
            })
          ]
        }
      }
    ]
  };

  return buildNormalizedQuickBooksFullSyncResponse(fixture.request, nestedResources);
}

function derivedAccountResource(
  base: NormalizedQuickBooksAccountResource,
  input: {
    readonly sourceAccountId: string;
    readonly name: string;
    readonly accountNumber: string;
    readonly parentSourceAccountId: string;
    readonly parentName: string;
  }
): NormalizedQuickBooksAccountResource {
  return {
    ...base,
    resourceId: input.sourceAccountId,
    sourcePayloadRef: safeQboSourcePayloadRef("Account", input.sourceAccountId, "2026-02-01T09:59:59.000Z", {
      name: input.name
    }),
    resource: {
      ...base.resource,
      sourceAccountId: input.sourceAccountId,
      name: input.name,
      accountNumber: input.accountNumber,
      parentAccountRef: {
        sourceObjectId: input.parentSourceAccountId,
        displayName: input.parentName
      },
      sourcePayloadRef: safeQboSourcePayloadRef("Account", input.sourceAccountId, "2026-02-01T09:59:59.000Z", {
        name: input.name
      })
    }
  };
}

function withSinglePostingAmount(
  line: NormalizedQuickBooksLedgerEntryResource["resource"]["lines"][number],
  amount: string,
  postingKind: "debit" | "credit"
): NormalizedQuickBooksLedgerEntryResource["resource"]["lines"][number] {
  const posting = line.postings[0];
  if (posting === undefined) {
    throw new Error(`expected normalized QuickBooks line ${line.sourceLineId ?? String(line.lineNumber)} to have a posting`);
  }
  const { debitAmount, creditAmount, netAmount, ...postingWithoutAmounts } = posting;
  void debitAmount;
  void creditAmount;
  void netAmount;

  return {
    ...line,
    amount,
    postings: [
      {
        ...postingWithoutAmounts,
        ...(postingKind === "debit" ? { debitAmount: amount } : { creditAmount: positiveDecimal(amount) })
      }
    ]
  };
}

function derivedRevenueLine(
  base: NormalizedQuickBooksLedgerEntryResource["resource"]["lines"][number],
  input: {
    readonly sourceLineId: string;
    readonly lineNumber: number;
    readonly description: string;
    readonly sourcePostingId: string;
    readonly amount: string;
    readonly sourceAccountId: string;
    readonly accountName: string;
  }
): NormalizedQuickBooksLedgerEntryResource["resource"]["lines"][number] {
  const posting = base.postings[0];
  if (posting === undefined) {
    throw new Error(`expected normalized QuickBooks line ${base.sourceLineId ?? String(base.lineNumber)} to have a posting`);
  }
  const { debitAmount, creditAmount, netAmount, ...postingWithoutAmounts } = posting;
  void debitAmount;
  void creditAmount;
  void netAmount;
  const sourcePayloadRef = safeQboSourcePayloadRef("JournalEntryLine", input.sourcePostingId, "2026-01-15T16:00:00.000Z", {
    lineNumber: input.lineNumber
  });

  return {
    ...base,
    sourceLineId: input.sourceLineId,
    lineNumber: input.lineNumber,
    description: input.description,
    amount: input.amount,
    accountRef: {
      sourceObjectId: input.sourceAccountId,
      displayName: input.accountName
    },
    sourcePayloadRef,
    postings: [
      {
        ...postingWithoutAmounts,
        sourcePostingId: input.sourcePostingId,
        accountRef: {
          sourceObjectId: input.sourceAccountId,
          displayName: input.accountName
        },
        creditAmount: positiveDecimal(input.amount),
        sourcePayloadRef
      }
    ]
  };
}

function safeQboSourcePayloadRef(
  sourceObjectType: string,
  sourceObjectId: string,
  sourceUpdatedAt: string,
  preview: NonNullable<SafeSourcePayloadRef["preview"]>
): SafeSourcePayloadRef {
  return {
    sourceObjectType,
    sourceObjectId,
    sourceUpdatedAt,
    storageRef: `quickbooks-sdk://sandbox/realm/realm_qbo_sync_fixture/${sourceObjectType}/${sourceObjectId}`,
    checksum: `sha256:${sourceObjectType}:${sourceObjectId}:${sourceUpdatedAt}`,
    preview
  };
}

function positiveDecimal(amount: string): string {
  return amount.startsWith("-") ? amount.slice(1) : amount;
}

function requiredAccountResource(resources: NormalizedQuickBooksResourceSet, sourceAccountId: string): NormalizedQuickBooksAccountResource {
  const account = resources.accounts.find((candidate) => candidate.resource.sourceAccountId === sourceAccountId);
  if (account === undefined) {
    throw new Error(`expected normalized QuickBooks account ${sourceAccountId}`);
  }
  return account;
}

function requiredJournalEntryResource(
  resources: NormalizedQuickBooksResourceSet,
  sourceTransactionId: string
): NormalizedQuickBooksLedgerEntryResource {
  const journalEntry = (resources.journalEntries ?? []).find(
    (candidate) => candidate.resource.sourceTransactionId === sourceTransactionId
  );
  if (journalEntry === undefined) {
    throw new Error(`expected normalized QuickBooks journal entry ${sourceTransactionId}`);
  }
  return journalEntry;
}

function requiredJournalLine(
  journalEntry: NormalizedQuickBooksLedgerEntryResource,
  sourceLineId: string
): NormalizedQuickBooksLedgerEntryResource["resource"]["lines"][number] {
  const line = journalEntry.resource.lines.find((candidate) => candidate.sourceLineId === sourceLineId);
  if (line === undefined) {
    throw new Error(`expected normalized QuickBooks journal line ${sourceLineId}`);
  }
  return line;
}

function nestedReplayFixtureIds(): {
  readonly parentAccountId: string;
  readonly childAccountId: string;
  readonly grandchildAccountId: string;
  readonly parentPostingId: string;
  readonly grandchildPostingId: string;
} {
  return {
    parentAccountId: canonicalQuickBooksFixtureId("account", "79"),
    childAccountId: canonicalQuickBooksFixtureId("account", "80"),
    grandchildAccountId: canonicalQuickBooksFixtureId("account", "81"),
    parentPostingId: canonicalQuickBooksFixtureId("posting", "100:2"),
    grandchildPostingId: canonicalQuickBooksFixtureId("posting", "100:3")
  };
}

function canonicalQuickBooksFixtureId(kind: string, sourceObjectId: string): string {
  const digest = createHash("sha256")
    .update(["tenant_qbo_sync_fixture", "source_qbo_sync_fixture", "quickbooks", "sandbox", kind, sourceObjectId].join(":"))
    .digest("hex")
    .slice(0, 16);
  return `${kind}_${digest}`;
}

function requiredSnapshotWrite(calls: readonly ReplayStorageCall[], snapshotId: string): ReplayStorageCall {
  const call = calls.find((candidate) => candidate.method === "writeReportSnapshot" && candidate.ids[0] === snapshotId);
  if (call === undefined) {
    throw new Error(`expected writeReportSnapshot call for ${snapshotId}`);
  }
  return call;
}

function requiredReplayLine(lines: readonly ReplaySnapshotLine[], accountId: string): ReplaySnapshotLine {
  const line = lines.find((candidate) => candidate.accountId === accountId);
  if (line === undefined) {
    throw new Error(`expected replay snapshot line for account ${accountId}`);
  }
  return line;
}

function expectReplayLineDrilldown(
  line: ReplaySnapshotLine,
  expectedAccountIds: readonly string[],
  expectedPostingIds: readonly string[]
): void {
  expect(new Set(line.drilldownRef.accountIds)).toEqual(new Set(expectedAccountIds));
  expect(new Set(line.drilldownRef.query?.accountIds)).toEqual(new Set(expectedAccountIds));
  expect(new Set(line.drilldownRef.postingIds)).toEqual(new Set(expectedPostingIds));
}

function reportSnapshotLineRows(calls: readonly QueryCall[]): readonly Record<string, unknown>[] {
  return insertedRowsForTable(calls, "report_snapshot_lines");
}

function insertedRowsForTable(calls: readonly QueryCall[], tableName: string): readonly Record<string, unknown>[] {
  return calls.filter((call) => call.sql.includes(`"${tableName}"`)).flatMap(insertedRowsFromCall);
}

function insertedRowsFromCall(call: QueryCall): readonly Record<string, unknown>[] {
  if (!call.sql.trimStart().startsWith("insert into ")) {
    return [];
  }
  const match = /insert into "erp_financials"\."[^"]+" \(([^)]+)\)/u.exec(call.sql);
  if (match?.[1] === undefined) {
    return [];
  }
  const columns = match[1].split(",").map((column) => column.trim().replace(/^"|"$/gu, ""));
  const rows: Record<string, unknown>[] = [];
  for (let offset = 0; offset < call.params.length; offset += columns.length) {
    rows.push(Object.fromEntries(columns.map((column, index) => [column, call.params[offset + index]])));
  }
  return rows;
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value === "string") return requiredRecord(JSON.parse(value), label);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label} to be a record`);
  }
  return value as Record<string, unknown>;
}

function requiredSafeLineRef(
  refs: readonly Awaited<ReturnType<typeof runFutureErpQuickBooksSandboxReplay>>["safeDrilldownRefs"][ReportName]["lineRefs"][number][],
  reportLineId: string
): Awaited<ReturnType<typeof runFutureErpQuickBooksSandboxReplay>>["safeDrilldownRefs"][ReportName]["lineRefs"][number] {
  const accountId = reportLineId.split(":line:account:")[1];
  if (accountId === undefined) {
    throw new Error(`expected account line id, received ${reportLineId}`);
  }
  const ref = refs.find((candidate) => candidate.refId === `profit_and_loss:${accountId}`);
  if (ref === undefined) {
    throw new Error(`expected safe drilldown ref for ${reportLineId}`);
  }
  return ref;
}

function expectSafeReplayDrilldown(
  ref: Awaited<ReturnType<typeof runFutureErpQuickBooksSandboxReplay>>["safeDrilldownRefs"][ReportName]["lineRefs"][number],
  expectedAccountIds: readonly string[],
  expectedPostingIds: readonly string[]
): void {
  expect(new Set(ref.accountIds)).toEqual(new Set(expectedAccountIds));
  expect(new Set(ref.query?.accountIds)).toEqual(new Set(expectedAccountIds));
  expect(new Set(ref.postingIds)).toEqual(new Set(expectedPostingIds));
  expect(ref.postingCount).toBe(expectedPostingIds.length);
}
