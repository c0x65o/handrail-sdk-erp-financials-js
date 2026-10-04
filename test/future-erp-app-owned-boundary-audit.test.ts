import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_JSON_REF_MAX_BYTES,
  ERP_FINANCIALS_NORMALIZED_QUICKBOOKS_SYNC_FIXTURES,
  ERP_FINANCIALS_STATEMENT_FIXTURE,
  POSTGRES_MIGRATIONS,
  POSTGRES_CANONICAL_SCHEMA_MANIFEST,
  assertNoCredentialKeys,
  buildBalanceSheetReport,
  buildCashFlowReport,
  buildFutureErpReportFromCanonicalReadModel,
  buildProfitAndLossReport,
  buildTrialBalanceReport,
  createFutureErpQuickBooksSandboxSyncWorker,
  createPostgresStorageAdapter,
  runFutureErpQuickBooksSandboxReplay
} from "../src/index.js";

import type {
  BuiltReport,
  FutureErpCanonicalReportReadModelStorage,
  FutureErpQuickBooksSandboxSyncWorkerClient,
  LoadReportBuilderInput,
  LoadRollupBucketsInput,
  PostgresQueryClient,
  PostgresQueryResult,
  ReportBuilderInput,
  ReportName,
  RollupBucket,
  StoredReportSnapshot
} from "../src/index.js";

type MigrationTable = {
  readonly name: string;
  readonly columns: readonly string[];
};

type QueryCall = {
  readonly sql: string;
  readonly params: readonly unknown[];
};

const FUTURE_ERP_CANONICAL_SCHEMA_MIGRATION_SQL = POSTGRES_MIGRATIONS.map((migration) => migration.sql).join("\n");

const PROVIDER_CREDENTIAL_OR_RAW_PAYLOAD_KEY_PATTERN =
  /intuit|oauth|access[_-]?token|refresh[_-]?token|client[_-]?secret|clientSecret|credential|password|private[_-]?key|rawPayload|rawProviderPayload|raw_provider_payload|raw_payload|provider_payload_archive|payload_archive|raw_archive/i;

const DECLARATION_PROVIDER_SECRET_OR_RAW_PAYLOAD_PATTERN =
  /intuit|oauth|access[_-]?token|refresh[_-]?token|client[_-]?secret|clientSecret|password|private[_-]?key|rawPayload|rawProviderPayload|raw_provider_payload|raw_payload|provider_payload_archive|payload_archive|raw_archive/i;

const CANONICAL_REPORT_BUILDERS = {
  profit_and_loss: buildProfitAndLossReport,
  balance_sheet: buildBalanceSheetReport,
  trial_balance: buildTrialBalanceReport,
  cash_flow: (input: ReportBuilderInput) =>
    buildCashFlowReport({
      ...input,
      cashAccountIds: ERP_FINANCIALS_STATEMENT_FIXTURE.cashFlow.cashAccountIds,
      activityByAccountId: ERP_FINANCIALS_STATEMENT_FIXTURE.cashFlow.activityByAccountId
    })
} satisfies Readonly<Record<ReportName, (input: ReportBuilderInput) => BuiltReport>>;

describe("Future ERP app-owned storage and reporting boundary audit", () => {
  it("installs only canonical ERP Financials tables with bounded safe refs, not provider credential or raw payload custody", () => {
    const migrationTables = parseMigrationTables(FUTURE_ERP_CANONICAL_SCHEMA_MIGRATION_SQL);
    const manifestTableNames = POSTGRES_CANONICAL_SCHEMA_MANIFEST.tables.map((table) => table.name);
    const forbiddenNames = migrationTables.flatMap((table) =>
      [table.name, ...table.columns]
        .filter((name) => PROVIDER_CREDENTIAL_OR_RAW_PAYLOAD_KEY_PATTERN.test(name))
        .map((name) => `${table.name}.${name}`)
    );
    const jsonColumns = POSTGRES_CANONICAL_SCHEMA_MANIFEST.tables.flatMap((table) =>
      table.columns
        .filter((column) => column.type === "jsonb")
        .map((column) => ({
          tableName: table.name,
          columnName: column.name,
          maxBytes: column.maxBytes
        }))
    );

    expect([...migrationTables.map((table) => table.name)].sort()).toEqual([...manifestTableNames].sort());
    expect(forbiddenNames).toEqual([]);
    expect(FUTURE_ERP_CANONICAL_SCHEMA_MIGRATION_SQL).not.toMatch(PROVIDER_CREDENTIAL_OR_RAW_PAYLOAD_KEY_PATTERN);
    expect(jsonColumns.length).toBeGreaterThanOrEqual(14);
    expect(jsonColumns.every((column) => column.maxBytes !== undefined)).toBe(true);
    for (const column of jsonColumns) {
      expect(FUTURE_ERP_CANONICAL_SCHEMA_MIGRATION_SQL.replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")")).toContain(
        `"${column.tableName}_${column.columnName}_bounded_json_check" check (octet_length(coalesce("${column.columnName}"::text, '')) <= ${String(column.maxBytes ?? DEFAULT_JSON_REF_MAX_BYTES)})`
      );
    }
  });

  it.each(Object.keys(CANONICAL_REPORT_BUILDERS) as ReportName[])(
    "serves %s through ERP Financials canonical report builders and compact drilldowns",
    async (reportName) => {
      const reportInput = canonicalReportInput();
      const result = await buildFutureErpReportFromCanonicalReadModel(new CanonicalReportStorage(reportInput), {
        ...ERP_FINANCIALS_STATEMENT_FIXTURE.reportRequest,
        companyId: ERP_FINANCIALS_STATEMENT_FIXTURE.company.companyId,
        sourceId: ERP_FINANCIALS_STATEMENT_FIXTURE.source.sourceId,
        reportName,
        preferStoredSnapshot: false,
        ...(reportName === "cash_flow" ? { cashFlow: ERP_FINANCIALS_STATEMENT_FIXTURE.cashFlow } : {})
      });
      const expectedReport = CANONICAL_REPORT_BUILDERS[reportName](reportInput);

      expect(result.source).toBe("canonical_facts");
      expect(result.report.metadata.generatedFrom).toBe("ledger_postings");
      expect(reportTotals(result.report)).toEqual(reportTotals(expectedReport));
      expect(result.drilldownSurface.reportSnapshotRef).toMatchObject({
        sourceObjectType: "CanonicalReportSnapshot",
        sourceObjectId: result.report.snapshot.reportSnapshotId
      });
      expect(result.drilldownSurface.reconciliationDifference.drilldownRef.query).toMatchObject({
        kind: "ledger_postings",
        tenantId: ERP_FINANCIALS_STATEMENT_FIXTURE.company.tenantId,
        accountingBasis: "accrual",
        periodStart: "2026-01-01",
        periodEnd: "2026-01-31"
      });
      expect(findForbiddenKeyPaths(result)).toEqual([]);
      expect(JSON.stringify(result)).not.toMatch(PROVIDER_CREDENTIAL_OR_RAW_PAYLOAD_KEY_PATTERN);
    }
  );

  it("keeps Future ERP sandbox replay, preflight, and captured app-owned writes credential-free", async () => {
    const client = new CapturingPostgresClient();
    const replay = await runFutureErpQuickBooksSandboxReplay({
      postgresStorage: createPostgresStorageAdapter(client)
    });
    const worker = createFutureErpQuickBooksSandboxSyncWorker({
      quickBooksClient: fixtureWorkerClient(),
      executionEnvironment: "dev",
      handrailQuickBooksServiceEnvironment: "staging"
    });
    const preflight = await worker.preflight({ mode: "sandbox_replay", requestedAt: "2026-02-01T10:00:00.000Z" });
    const writeTables = client.calls
      .map((call) => /^insert into "erp_financials"\."([^"]+)"/.exec(call.sql)?.[1])
      .filter((table): table is string => table !== undefined);

    expect(preflight.status).toBe("ready");
    expect(replay.providerParity.reports.map((report) => [report.reportName, report.status])).toEqual([
      ["profit_and_loss", "mismatched"],
      ["balance_sheet", "mismatched"],
      ["trial_balance", "mismatched"],
      ["cash_flow", "unsupported"]
    ]);
    expect(writeTables).toEqual(
      expect.arrayContaining([
        "accounting_companies",
        "accounting_sources",
        "import_batches",
        "sync_checkpoints",
        "ledger_postings",
        "report_snapshots",
        "report_snapshot_lines",
        "report_snapshot_totals",
        "report_freshness"
      ])
    );
    expect(client.calls.every((call) => /(?:"erp_financials"|erp_financials)\.|^select (?:pg_advisory_xact_lock|set_config)/.test(call.sql))).toBe(true);
    expect(findForbiddenKeyPaths(preflight)).toEqual([]);
    expect(findForbiddenKeyPaths(replay)).toEqual([]);
    expect(findForbiddenKeyPaths(client.calls.map((call) => call.params))).toEqual([]);
    expect(JSON.stringify({ preflight, replay, params: client.calls.map((call) => call.params) })).not.toMatch(
      PROVIDER_CREDENTIAL_OR_RAW_PAYLOAD_KEY_PATTERN
    );
    assertNoCredentialKeys(preflight);
    assertNoCredentialKeys(replay);
  });

  it("keeps generated declarations free of provider credential and raw provider payload fields when dist is present", () => {
    const declarationUrl = new URL("../dist/index.d.ts", import.meta.url);

    if (!existsSync(declarationUrl)) {
      return;
    }

    const declaration = readFileSync(declarationUrl, "utf8");

    expect(declaration).not.toMatch(DECLARATION_PROVIDER_SECRET_OR_RAW_PAYLOAD_PATTERN);
  });
});

class CapturingPostgresClient implements PostgresQueryClient {
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

class CanonicalReportStorage implements FutureErpCanonicalReportReadModelStorage {
  constructor(private readonly reportInput: ReportBuilderInput) {}

  loadReportBuilderInput(_input: LoadReportBuilderInput): Promise<ReportBuilderInput> {
    void _input;
    return Promise.resolve(this.reportInput);
  }

  loadLatestReportSnapshot(): Promise<StoredReportSnapshot | undefined> {
    return Promise.resolve(undefined);
  }

  loadRollupBuckets(_input: LoadRollupBucketsInput): Promise<readonly RollupBucket[]> {
    void _input;
    return Promise.resolve([]);
  }
}

function fixtureWorkerClient(): FutureErpQuickBooksSandboxSyncWorkerClient {
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
    preflight() {
      return Promise.resolve({
        connected: true,
        replayAvailable: true,
        metadata: {
          provider: "handrail",
          serviceEnvironment: "staging"
        }
      });
    }
  };
}

function canonicalReportInput(): ReportBuilderInput {
  return {
    ...ERP_FINANCIALS_STATEMENT_FIXTURE.reportRequest,
    sourceId: ERP_FINANCIALS_STATEMENT_FIXTURE.source.sourceId,
    accounts: ERP_FINANCIALS_STATEMENT_FIXTURE.accounts,
    postings: ERP_FINANCIALS_STATEMENT_FIXTURE.postings,
    freshness: {
      status: "fresh",
      sourceId: ERP_FINANCIALS_STATEMENT_FIXTURE.source.sourceId,
      importBatchId: ERP_FINANCIALS_STATEMENT_FIXTURE.importBatch.importBatchId,
      checkpointId: ERP_FINANCIALS_STATEMENT_FIXTURE.checkpoint.checkpointId,
      freshThrough: "2026-02-01T00:00:00.000Z"
    }
  };
}

function reportTotals(report: BuiltReport): Readonly<Record<string, string>> {
  return Object.fromEntries(report.totals.map((total) => [total.totalKey, total.amount]));
}

function parseMigrationTables(sql: string): readonly MigrationTable[] {
  const tables: MigrationTable[] = [];
  const tablePattern = /create table(?: if not exists)? "erp_financials"\."([^"]+)" \(([\s\S]*?)\n\);/g;
  let match: RegExpExecArray | null;

  while ((match = tablePattern.exec(sql)) !== null) {
    const name = match[1];
    const body = match[2];
    if (!name || body === undefined) {
      throw new Error("Expected Future ERP canonical migration table regex to capture table name and body.");
    }
    tables.push({
      name,
      columns: body
        .split("\n")
        .map((line) => /^\s+"([^"]+)"\s+/.exec(line)?.[1])
        .filter((column): column is string => column !== undefined)
    });
  }

  return tables;
}

function findForbiddenKeyPaths(value: unknown, path = "$"): readonly string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => findForbiddenKeyPaths(entry, `${path}[${String(index)}]`));
  }

  if (value !== null && typeof value === "object") {
    return Object.entries(value as Readonly<Record<string, unknown>>).flatMap(([key, entry]) => {
      const entryPath = `${path}.${key}`;
      return [
        ...(PROVIDER_CREDENTIAL_OR_RAW_PAYLOAD_KEY_PATTERN.test(key) ? [entryPath] : []),
        ...findForbiddenKeyPaths(entry, entryPath)
      ];
    });
  }

  return [];
}
