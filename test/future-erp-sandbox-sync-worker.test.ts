import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ERP_FINANCIALS_NORMALIZED_QUICKBOOKS_SYNC_FIXTURES,
  FutureErpQuickBooksSandboxSyncWorkerPreflightError,
  POSTGRES_CANONICAL_SCHEMA_MANIFEST,
  assertNoCredentialKeys,
  buildFutureErpQuickBooksSandboxSyncOwnerEvidence,
  createFutureErpQuickBooksSandboxSyncWorker,
  createPostgresStorageAdapter
} from "../src/index.js";

import type {
  FutureErpQuickBooksSandboxSyncWorkerClient,
  FutureErpQuickBooksSandboxSyncWorkerPreflightProbeRequest,
  PostgresQueryClient,
  PostgresQueryResult,
  PostgresSchemaManifest
} from "../src/index.js";

type QueryCall = {
  readonly sql: string;
  readonly params: readonly unknown[];
};

type CatalogRow = {
  readonly object_type: "schema" | "table" | "column" | "index" | "constraint" | "trigger";
  readonly table_name: string | null;
  readonly object_name: string;
};

const EXPECTED_OWNER_EVIDENCE_HASH = "f8944a6849a6332610b4feb6e876819576265508080a395b62f027ca0ecdfcf0";

describe("Future ERP QuickBooks sandbox sync worker", () => {
  it("preflights the SDK/service and returns safe replay import metadata", async () => {
    let probeRequest: FutureErpQuickBooksSandboxSyncWorkerPreflightProbeRequest | undefined;
    const worker = createFutureErpQuickBooksSandboxSyncWorker({
      quickBooksClient: fixtureWorkerClient((request) => {
        probeRequest = request;

        return Promise.resolve({
          connected: true,
          replayAvailable: true,
          message: "sandbox replay available",
          metadata: {
            provider: "handrail",
            serviceEnvironment: "staging"
          }
        });
      }),
      executionEnvironment: "dev",
      handrailQuickBooksServiceEnvironment: "staging",
      companyId: "company_future_erp_qbo_fixture",
      accountingBasis: "accrual",
      currencyCode: "USD"
    });

    const result = await worker.run({ mode: "sandbox_replay", requestedAt: "2026-02-01T10:00:00.000Z" });

    expect(probeRequest).toMatchObject({
      mode: "sandbox_replay",
      requestedAt: "2026-02-01T10:00:00.000Z",
      sourceIdentity: {
        tenantId: "tenant_qbo_sync_fixture",
        sourceId: "source_qbo_sync_fixture",
        sourceSystem: "quickbooks",
        providerEnvironment: "sandbox",
        realmId: "realm_qbo_sync_fixture",
        connectionRef: "handrail-quickbooks-sdk:staging:sandbox:realm:realm_qbo_sync_fixture"
      }
    });
    expect(result.mode).toBe("sandbox_replay");
    expect(result.preflight.status).toBe("ready");
    expect(result.preflight.checks.map((check) => [check.name, check.status])).toEqual([
      ["dev_only_execution", "ready"],
      ["quickbooks_full_sync", "ready"],
      ["quickbooks_profit_and_loss_report", "ready"],
      ["quickbooks_balance_sheet_report", "ready"],
      ["quickbooks_trial_balance_report", "ready"],
      ["quickbooks_cash_flow_parity_report", "ready"],
      ["erp_financials_canonical_schema", "skipped"],
      ["quickbooks_service_availability", "ready"]
    ]);
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
    expect(result.counts.normalizedResourceCounts).toEqual({
      companyInfo: 1,
      accounts: 2,
      classes: 0,
      journalEntries: 1,
      ledgerEntries: 1,
      ledgerTransactions: 0,
      ledgerPostings: 2,
      customers: 1,
      vendors: 1,
      items: 1,
      departments: 1,
      dimensions: 1,
      parties: 0,
      providerReports: 0,
      reconciliationEvidence: 0
    });
    expect(result.counts.canonicalRowCounts).toEqual({
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
    expect(result.replay?.providerParity.reports.map((report) => [report.reportName, report.status])).toEqual([
      ["profit_and_loss", "mismatched"],
      ["balance_sheet", "mismatched"],
      ["trial_balance", "mismatched"],
      ["cash_flow", "unsupported"]
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      /access[_-]?token|refresh[_-]?token|client[_-]?secret|clientSecret|credential|rawPayload|rawProviderPayload/i
    );
    assertNoCredentialKeys(result);
  });

  it("emits bounded owner evidence for a mounted Future ERP replay through ERP storage and SDK parity links", async () => {
    const client = new RecordingWorkerPostgresClient();
    const worker = createFutureErpQuickBooksSandboxSyncWorker({
      quickBooksClient: fixtureWorkerClient(() => Promise.resolve({ connected: true, replayAvailable: true })),
      postgresStorage: createPostgresStorageAdapter(client),
      executionEnvironment: "dev",
      handrailQuickBooksServiceEnvironment: "staging",
      companyId: "company_future_erp_qbo_fixture",
      accountingBasis: "accrual",
      currencyCode: "USD"
    });

    const result = await worker.run({ mode: "sandbox_replay", requestedAt: "2026-02-01T10:00:00.000Z" });
    const evidence = buildFutureErpQuickBooksSandboxSyncOwnerEvidence(result);
    const writeTables = writeQueryTables(client.calls);

    expect(writeTables.slice(0, 12)).toEqual([
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
      "ledger_postings"
    ]);
    expect(writeTables.filter((table) => table === "report_snapshots")).toHaveLength(4);
    expect(writeTables.filter((table) => table === "report_freshness")).toHaveLength(4);

    expect(evidence).toMatchObject({
      evidenceKind: "future_erp_quickbooks_sandbox_replay",
      evidenceVersion: 1,
      mode: "sandbox_replay",
      status: "passed",
      preflightStatus: "ready",
      importBatchId: "batch_qbo_full_fixture_2026_01",
      checkpointId: "checkpoint_qbo_full_fixture_2026_01",
      sourceFreshThrough: "2026-02-01T10:00:00.000Z",
      latestSourceUpdatedAt: "2026-02-01T09:59:59.000Z"
    });
    expect(evidence.counts.canonicalRowCounts).toEqual({
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
    expect(evidence.reports.map((report) => [report.reportName, report.status, report.snapshotRowsWritten, report.freshnessRowsWritten])).toEqual([
      ["profit_and_loss", "generated", 10, 1],
      ["balance_sheet", "generated", 7, 1],
      ["trial_balance", "generated", 5, 1],
      ["cash_flow", "supported", 9, 1]
    ]);
    expect(evidence.reports.every((report) => report.safeDrilldownRefCounts.lineRefs <= 4)).toBe(true);
    expect(evidence.reports.every((report) => report.safeDrilldownRefCounts.totalRefs <= 4)).toBe(true);
    expect(evidence.reports.every((report) => report.safeDrilldownRefCounts.hasReportSnapshotRef)).toBe(true);
    expect(evidence.reports.every((report) => report.safeDrilldownRefCounts.hasReconciliationDifferenceRef)).toBe(true);
    expect(evidence.providerParity?.reports.map((report) => [report.reportName, report.status, report.evidenceTotalCount])).toEqual([
      ["profit_and_loss", "mismatched", 8],
      ["balance_sheet", "mismatched", 4],
      ["trial_balance", "mismatched", 2],
      ["cash_flow", "unsupported", 0]
    ]);
    expect(JSON.stringify(evidence)).not.toMatch(
      /access[_-]?token|refresh[_-]?token|client[_-]?secret|clientSecret|credential|rawPayload|rawProviderPayload/i
    );
    assertNoCredentialKeys(evidence);
    expect(ownerEvidenceHash(evidence)).toBe(EXPECTED_OWNER_EVIDENCE_HASH);
  });

  it("blocks execution outside dev/test before calling the sync path", async () => {
    const worker = createFutureErpQuickBooksSandboxSyncWorker({
      quickBooksClient: fixtureWorkerClient(),
      executionEnvironment: "production"
    });

    const preflight = await worker.preflight({ mode: "full_sync" });

    expect(preflight.status).toBe("blocked");
    expect(preflight.checks.find((check) => check.name === "dev_only_execution")).toMatchObject({
      status: "blocked",
      message: "Future ERP QuickBooks sandbox sync workers may only run in dev or test."
    });
    await expect(worker.run({ mode: "full_sync" })).rejects.toBeInstanceOf(
      FutureErpQuickBooksSandboxSyncWorkerPreflightError
    );
  });

  it("uses the QuickBooks service health probe contract when the SDK client exposes it", async () => {
    const worker = createFutureErpQuickBooksSandboxSyncWorker({
      quickBooksClient: {
        ...fixtureWorkerClient(),
        serviceHealth: () => Promise.resolve(ERP_FINANCIALS_NORMALIZED_QUICKBOOKS_SYNC_FIXTURES.serviceHealth.ready.response)
      },
      executionEnvironment: "dev",
      handrailQuickBooksServiceEnvironment: "staging"
    });

    const preflight = await worker.preflight({ mode: "sandbox_replay", requestedAt: "2026-02-01T10:02:30.000Z" });
    const availabilityCheck = preflight.checks.find((check) => check.name === "quickbooks_service_availability");

    expect(preflight.status).toBe("ready");
    expect(availabilityCheck).toMatchObject({
      status: "ready",
      metadata: {
        serviceAvailability: "available",
        providerMode: "sandbox",
        sandboxAvailable: true,
        replayAvailable: true,
        fullSyncAvailable: true,
        incrementalSyncAvailable: true,
        providerReportsAvailable: true,
        checkpointStatus: "current",
        checkpointId: "checkpoint_qbo_full_fixture_2026_01",
        sourceFreshThrough: "2026-02-01T10:00:00.000Z",
        importedThrough: "2026-02-01T10:00:00.000Z",
        latestSourceUpdatedAt: "2026-02-01T09:59:59.000Z"
      }
    });
    expect(JSON.stringify(preflight)).not.toMatch(/access[_-]?token|refresh[_-]?token|client[_-]?secret|credential|rawPayload/i);
  });

  it("passes worker preflight against a blank schema when canonical install is explicitly enabled", async () => {
    const schemaClient = new BlankSchemaInstallClient(POSTGRES_CANONICAL_SCHEMA_MANIFEST);
    const worker = createFutureErpQuickBooksSandboxSyncWorker({
      quickBooksClient: fixtureWorkerClient(() => Promise.resolve({ connected: true, replayAvailable: true })),
      schemaPreflightClient: schemaClient,
      installSchemaIfMissing: true,
      executionEnvironment: "dev"
    });

    const preflight = await worker.preflight({ mode: "full_sync" });

    expect(preflight.status).toBe("ready");
    expect(preflight.checks.find((check) => check.name === "erp_financials_canonical_schema")).toMatchObject({
      status: "ready",
      metadata: {
        fixtureSupport: true,
        schemaInstalled: true
      }
    });
    expect(schemaClient.calls[0]?.sql).toBe('create schema if not exists "erp_financials";');
    expect(schemaClient.calls.at(-1)?.sql).toContain("information_schema.schemata");
  });

  it("generates and persists canonical report snapshots after a configured full sync", async () => {
    const client = new RecordingWorkerPostgresClient();
    const worker = createFutureErpQuickBooksSandboxSyncWorker({
      quickBooksClient: fixtureWorkerClient(() => Promise.resolve({ connected: true })),
      postgresStorage: createPostgresStorageAdapter(client),
      executionEnvironment: "dev",
      companyId: "company_future_erp_qbo_fixture",
      accountingBasis: "accrual",
      currencyCode: "USD",
      generatedAt: "2026-02-01T10:15:00.000Z",
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
      asOfDate: "2026-01-31"
    });

    const result = await worker.run({ mode: "full_sync" });

    expect(result.mode).toBe("full_sync");
    expect(result.replay).toBeUndefined();
    expect(result.reports?.reportStatuses).toEqual({
      profit_and_loss: "generated",
      balance_sheet: "generated",
      trial_balance: "generated",
      cash_flow: "supported"
    });
    expect(result.reports?.reports.cash_flow).toMatchObject({
      reportName: "cash_flow",
      status: "supported",
      freshnessStatus: "fresh",
      freshnessRowsWritten: 1
    });
    expect(result.reports?.snapshotIds).toEqual({
      profit_and_loss:
        "snapshot:tenant_qbo_sync_fixture:company_future_erp_qbo_fixture:source_qbo_sync_fixture:profit_and_loss:builder:accrual:2026-01-01:2026-01-31:2026-01-31:USD",
      balance_sheet:
        "snapshot:tenant_qbo_sync_fixture:company_future_erp_qbo_fixture:source_qbo_sync_fixture:balance_sheet:builder:accrual:2026-01-01:2026-01-31:2026-01-31:USD",
      trial_balance:
        "snapshot:tenant_qbo_sync_fixture:company_future_erp_qbo_fixture:source_qbo_sync_fixture:trial_balance:builder:accrual:2026-01-01:2026-01-31:2026-01-31:USD",
      cash_flow:
        "snapshot:tenant_qbo_sync_fixture:company_future_erp_qbo_fixture:source_qbo_sync_fixture:cash_flow:builder:accrual:2026-01-01:2026-01-31:2026-01-31:USD"
    });
    expect(writeQueryTables(client.calls).filter((table) => table === "report_snapshots")).toHaveLength(4);
    expect(writeQueryTables(client.calls).filter((table) => table === "report_freshness")).toHaveLength(4);
    expect(JSON.stringify(result)).not.toMatch(
      /access[_-]?token|refresh[_-]?token|client[_-]?secret|clientSecret|credential|rawPayload|rawProviderPayload/i
    );
  });
});

function fixtureWorkerClient(
  preflight?: FutureErpQuickBooksSandboxSyncWorkerClient["preflight"]
): FutureErpQuickBooksSandboxSyncWorkerClient {
  const fixtures = ERP_FINANCIALS_NORMALIZED_QUICKBOOKS_SYNC_FIXTURES;

  return {
    fullSync() {
      return Promise.resolve(fixtures.fullSync.response);
    },
    profitAndLossReport() {
      return Promise.resolve(fixtures.providerReports.profitAndLoss.response);
    },
    balanceSheetReport() {
      return Promise.resolve(fixtures.providerReports.balanceSheet.response);
    },
    trialBalanceReport() {
      return Promise.resolve(fixtures.providerReports.trialBalance.response);
    },
    cashFlowParityReport() {
      return Promise.resolve(fixtures.providerReports.cashFlow.response);
    },
    ...(preflight === undefined ? {} : { preflight })
  };
}

class BlankSchemaInstallClient implements PostgresQueryClient {
  readonly calls: QueryCall[] = [];
  private installed = false;

  constructor(private readonly manifest: PostgresSchemaManifest) {}

  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = []
  ): Promise<PostgresQueryResult<Row>> {
    this.calls.push({ sql, params });

    if (sql.includes("information_schema.schemata")) {
      const rows = this.installed ? catalogRowsForManifest(this.manifest) : [];

      return Promise.resolve({
        rows: rows as unknown as readonly Row[],
        rowCount: rows.length
      });
    }

    if (sql.startsWith('create schema if not exists "erp_financials"')) {
      this.installed = true;
    }

    return Promise.resolve({
      rows: [],
      rowCount: null
    });
  }
}

class RecordingWorkerPostgresClient implements PostgresQueryClient {
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

function writeQueryTables(calls: readonly QueryCall[]): readonly string[] {
  return calls
    .map((call) => /^insert into "erp_financials"\."([^"]+)"/.exec(call.sql)?.[1])
    .filter((table): table is string => table !== undefined);
}

function catalogRowsForManifest(manifest: PostgresSchemaManifest): readonly CatalogRow[] {
  return [
    {
      object_type: "schema",
      table_name: null,
      object_name: manifest.namespace
    },
    ...manifest.requiredTriggers.map(trigger => ({
      object_type: "trigger" as const, table_name: trigger.table, object_name: trigger.name,
      enabled: true,
      definition: `create trigger ${trigger.name} ${trigger.timing} ${trigger.events.map(event => event === "update" && trigger.updateColumns ? `update of ${trigger.updateColumns.join(", ")}` : event).join(" or ")} on ${manifest.namespace}.${trigger.table} for each row execute function ${manifest.namespace}.${trigger.functionName}()`
    })),
    ...manifest.tables.flatMap((table) => [
      {
        object_type: "table" as const,
        table_name: table.name,
        object_name: table.name
      },
      ...table.columns.map((column) => ({
        object_type: "column" as const,
        table_name: table.name,
        object_name: column.name
      })),
      ...table.indexes.map((index) => ({
        object_type: "index" as const,
        table_name: table.name,
        object_name: index.name
      })),
      ...[
        `${table.name}_pkey`,
        ...table.constraints.map((constraint) => constraint.name),
        ...table.columns
          .filter((column) => column.type === "jsonb" && column.maxBytes !== undefined)
          .map((column) => `${table.name}_${column.name}_bounded_json_check`)
      ].map((constraintName) => ({
        object_type: "constraint" as const,
        table_name: table.name,
        object_name: constraintName
      }))
    ])
  ];
}

function ownerEvidenceHash(evidence: unknown): string {
  return createHash("sha256").update(JSON.stringify(evidence, null, 2)).digest("hex");
}
