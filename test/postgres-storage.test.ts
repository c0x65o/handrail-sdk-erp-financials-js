import { describe, expect, it } from "vitest";

import {
  ACCOUNT_HIERARCHY_CHANGED_STALE_REASON,
  ERP_FINANCIALS_STATEMENT_FIXTURE,
  POSTGRES_CANONICAL_SCHEMA_MANIFEST,
  buildAccountHierarchyRollupLines,
  buildStandardReportPresentationFromReadModel,
  buildProfitAndLossReport,
  createPostgresQuickBooksDualBasisBackfillPersistence,
  createPostgresStorageAdapter,
  createCompactDrilldownRef,
  installPostgresSchema,
  materializeQuickBooksBasisBackfill,
  validatePostgresSchema
} from "../src/index.js";
import { rollupPresentationAccountRowFromRow } from "../src/postgres-storage.js";

import type {
  IsoDate,
  Account,
  AccountHierarchyRollupLineAmount,
  BuiltReport,
  PaymentApplication,
  PostgresQueryClient,
  PostgresQueryResult,
  PostingRule,
  ReportSnapshotLine,
  ReportSnapshotTotal,
  PostgresSchemaManifest,
  StandardReportPresentation,
  StandardReportPresentationReadModelRequest,
  TransactionMatchCandidate,
  TransactionMatchDecision
} from "../src/index.js";

type QueryCall = {
  readonly sql: string;
  readonly params: readonly unknown[];
};

type CatalogRow = {
  readonly object_type: "schema" | "table" | "column" | "index" | "constraint" | "trigger";
  readonly table_name: string | null;
  readonly object_name: string;
  readonly data_type?: string | null;
  readonly is_nullable?: string | null;
  readonly definition?: string | null;
  readonly enabled?: boolean | null;
};

describe("Postgres storage adapter", () => {
  it("exposes install dry-run statements without mutating the database", async () => {
    const client = new RecordingClient();
    const result = await installPostgresSchema(client, POSTGRES_CANONICAL_SCHEMA_MANIFEST, { dryRun: true });

    expect(result.executed).toBe(false);
    expect(result.manifestVersion).toBe(POSTGRES_CANONICAL_SCHEMA_MANIFEST.manifestVersion);
    expect(result.schemaVersion).toBe(POSTGRES_CANONICAL_SCHEMA_MANIFEST.schemaVersion);
    expect(result.statements[0]).toBe('create schema if not exists "erp_financials";');
    expect(result.statements.some((statement) => statement.includes('"rollup_buckets"'))).toBe(true);
    expect(result.statements.some((statement) => statement.includes('"report_freshness"'))).toBe(true);
    expect(client.calls).toHaveLength(0);
  });

  it("validates tables, indexes, constraints, and fixture support from catalog reads", async () => {
    const validClient = new RecordingClient(catalogRowsForManifest(POSTGRES_CANONICAL_SCHEMA_MANIFEST));
    const validResult = await validatePostgresSchema(validClient);

    expect(validResult.compatible).toBe(true);
    expect(validResult.fixtureSupport).toBe(true);
    expect(validResult.issues).toEqual([]);
    expect(validClient.calls).toHaveLength(1);
    expect(validClient.calls[0]?.sql).toContain("information_schema.schemata");

    const missingClient = new RecordingClient([
      {
        object_type: "schema",
        table_name: null,
        object_name: "erp_financials"
      }
    ]);
    const missingResult = await validatePostgresSchema(missingClient);

    expect(missingResult.compatible).toBe(false);
    expect(missingResult.fixtureSupport).toBe(false);
    expect(missingResult.issues.map((issue) => issue.kind)).toEqual(
      expect.arrayContaining([
        "missing_table",
        "missing_index",
        "missing_constraint",
        "missing_trigger",
        "missing_fixture_support"
      ])
    );
    expect(missingResult.issues.some((issue) => issue.objectName === "ledger_postings")).toBe(true);
  });

  it("fails schema validation when an existing column has an unsafe type or nullability", async () => {
    const incompatibleRows = catalogRowsForManifest(POSTGRES_CANONICAL_SCHEMA_MANIFEST).map((row) =>
      row.object_type === "column" && row.table_name === "report_snapshots" && row.object_name === "company_id"
        ? { ...row, data_type: "integer", is_nullable: "YES" }
        : row
    );

    const result = await validatePostgresSchema(new RecordingClient(incompatibleRows));

    expect(result.compatible).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "incompatible_column_type",
          table: "report_snapshots",
          objectName: "company_id"
        }),
        expect.objectContaining({
          kind: "incompatible_column_nullability",
          table: "report_snapshots",
          objectName: "company_id"
        })
      ])
    );
  });

  it("detects index and scoped foreign-key definition drift, not only missing names", async () => {
    const incompatibleRows = catalogRowsForManifest(POSTGRES_CANONICAL_SCHEMA_MANIFEST).map((row) => {
      if (row.object_type === "index" && row.object_name === "transactions_scope_uidx") {
        return { ...row, definition: 'create unique index transactions_scope_uidx on erp_financials.transactions using btree (tenant_id, transaction_id)' };
      }
      if (row.object_type === "constraint" && row.object_name === "transactions_source_scope_fk") {
        return {
          ...row,
          definition: "foreign key (tenant_id, source_id) references erp_financials.accounting_sources (source_id, tenant_id) on update restrict on delete restrict"
        };
      }
      if (row.object_type === "trigger" && row.object_name === "transactions_posted_journal_immutable") {
        return { ...row, enabled: false };
      }
      return row;
    });

    const result = await validatePostgresSchema(new RecordingClient(incompatibleRows));

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "incompatible_index_definition", objectName: "transactions_scope_uidx" }),
        expect.objectContaining({
          kind: "incompatible_constraint_definition",
          objectName: "transactions_source_scope_fk"
        }),
        expect.objectContaining({
          kind: "incompatible_trigger_definition",
          objectName: "transactions_posted_journal_immutable"
        })
      ])
    );
  });

  it("generates tenant/source idempotent upserts for reprocessed ledger postings", async () => {
    const client = new RecordingClient();
    const adapter = createPostgresStorageAdapter(client);
    const firstPosting = ERP_FINANCIALS_STATEMENT_FIXTURE.postings[0];

    if (firstPosting === undefined) {
      throw new Error("fixture must include a posting");
    }

    await adapter.upsertLedgerPostings([firstPosting]);

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.sql).toContain('insert into "erp_financials"."ledger_postings"');
    expect(client.calls[0]?.sql).toContain(
      'on conflict ("tenant_id", "source_id", "accounting_basis", "source_posting_id") do update'
    );
    expect(client.calls[0]?.params).toEqual(
      expect.arrayContaining([
        firstPosting.tenantId,
        firstPosting.sourceId,
        firstPosting.accountingBasis,
        firstPosting.sourcePostingId
      ])
    );

    await adapter.upsertLedgerPostings([
      {
        ...firstPosting,
        debitAmount: "50001.00",
        netAmount: "50001.00"
      }
    ]);

    expect(client.calls).toHaveLength(2);
    expect(client.calls[1]?.sql).toBe(client.calls[0]?.sql);
    expect(client.calls[1]?.params).toEqual(expect.arrayContaining(["50001.00"]));
  });

  it("atomically scopes QuickBooks dual-basis backfill replacement by owner, range, and basis", async () => {
    const client = new RecordingClient();
    let transactionCount = 0;
    const persistence = createPostgresQuickBooksDualBasisBackfillPersistence({
      transaction: async (work) => {
        transactionCount += 1;
        return work(client);
      }
    });
    const accounts: readonly Account[] = [
      { tenantId: "tenant_qbo", sourceId: "source_qbo", accountId: "account_cash", sourceAccountId: "cash", name: "Cash", type: "Bank", classification: "asset", active: true },
      { tenantId: "tenant_qbo", sourceId: "source_qbo", accountId: "account_revenue", sourceAccountId: "revenue", name: "Revenue", type: "Income", classification: "income", active: true }
    ];
    const base = {
      tenantId: "tenant_qbo", companyId: "company_qbo", sourceId: "source_qbo", currencyCode: "USD",
      periodStart: "2026-01-01", periodEnd: "2026-12-31", requestedAt: "2027-01-01T00:00:00.000Z", accounts
    } as const;
    const projection = (accountingBasis: "cash" | "accrual") => materializeQuickBooksBasisBackfill(base, {
      reportName: "general_ledger", accountingBasis, supportStatus: "supported", currencyCode: "USD",
      generatedAt: "2027-01-01T00:01:00.000Z",
      providerReportRef: { sourceObjectType: "quickbooks_report_general_ledger", sourceObjectId: `realm:${accountingBasis}` },
      ledgerRows: [
        { accountSourceId: "cash", transactionId: "1", transactionType: "Payment", transactionDate: "2026-02-01", debitAmount: "10.00", creditAmount: "0.00" },
        { accountSourceId: "revenue", transactionId: "1", transactionType: "Payment", transactionDate: "2026-02-01", debitAmount: "0.00", creditAmount: "10.00" }
      ]
    });

    await persistence.replaceDualBasisRange({
      tenantId: base.tenantId, companyId: base.companyId, sourceId: base.sourceId,
      periodStart: base.periodStart, periodEnd: base.periodEnd,
      projections: [projection("accrual"), projection("cash")]
    });

    expect(client.calls[0]?.sql).toContain("pg_advisory_xact_lock");
    expect(client.calls[1]?.sql).toContain("customer_payment_corrections");
    expect(client.calls[2]?.sql).toContain("subledger_documents");
    expect(client.calls[3]?.sql).toContain("QuickBooksGeneralLedger:%");
    expect(client.calls[3]?.sql).toContain('posting."accounting_basis" = any');
    expect(client.calls[3]?.params).toEqual(["tenant_qbo", "source_qbo", ["accrual", "cash"], "2026-01-01", "2026-12-31", []]);
    expect(client.calls.filter((call) => call.sql.includes('insert into "erp_financials"."ledger_postings"'))).toHaveLength(2);
    expect(client.calls.filter((call) => call.sql.includes('update "erp_financials"."report_snapshots"'))).toHaveLength(2);
    expect(transactionCount).toBe(1);
  });

  it("chunks large canonical upserts below the PostgreSQL client bind-parameter limit", async () => {
    const client = new RecordingClient();
    const adapter = createPostgresStorageAdapter(client);
    const firstLine = ERP_FINANCIALS_STATEMENT_FIXTURE.transactionLines[0];

    if (firstLine === undefined) {
      throw new Error("fixture must include a transaction line");
    }

    const lines = Array.from({ length: 3_000 }, (_, index) => ({
      ...firstLine,
      transactionLineId: `line_bulk_${String(index + 1)}`,
      lineNumber: index + 1
    }));

    await expect(adapter.upsertTransactionLines(lines)).resolves.toBe(lines.length);
    expect(client.calls).toHaveLength(2);
    expect(client.calls.every((call) => call.params.length <= 30_000)).toBe(true);
    expect(client.calls.reduce((count, call) => count + call.params.length, 0)).toBe(39_000);
    expect(client.calls[1]?.sql).toContain("($1, $2, $3");
  });

  it("persists posting rules, match audit records, and payment applications with stable conflicts", async () => {
    const client = new RecordingClient();
    const adapter = createPostgresStorageAdapter(client);
    const rule: PostingRule = {
      postingRuleId: "rule_customer_payment",
      tenantId: "tenant_1",
      sourceId: "source_native_erp",
      ruleCode: "customer-payment-default",
      name: "Customer payment",
      priority: 100,
      status: "active",
      conditionMode: "all",
      conditions: [{ field: "source_transaction_type", operator: "equals", value: "Payment" }],
      actions: [
        {
          kind: "create_posting",
          side: "debit",
          accountId: "acct_cash",
          amount: { kind: "transaction_amount" }
        },
        {
          kind: "create_posting",
          side: "credit",
          accountId: "acct_ar",
          amount: { kind: "transaction_amount" }
        }
      ],
      createdAt: "2026-01-15T12:00:00.000Z",
      updatedAt: "2026-01-15T12:00:00.000Z"
    };
    const candidate: TransactionMatchCandidate = {
      matchCandidateId: "candidate_payment_invoice",
      tenantId: rule.tenantId,
      sourceId: rule.sourceId,
      matchKind: "customer_payment_to_invoice",
      originTransactionId: "txn_payment_1",
      targetTransactionId: "txn_invoice_1",
      matcherVersion: "customer-payment-v1",
      score: "1.00",
      suggestedApplicationAmount: "1250.00",
      currencyCode: "USD",
      status: "suggested",
      evidence: [{ criterion: "reference", matched: true, weight: "1.00", score: "1.00" }],
      createdAt: "2026-01-15T12:00:00.000Z"
    };
    const decision: TransactionMatchDecision = {
      matchDecisionId: "decision_payment_invoice",
      matchCandidateId: candidate.matchCandidateId,
      tenantId: rule.tenantId,
      sourceId: rule.sourceId,
      decision: "accepted",
      method: "manual",
      decidedAt: "2026-01-15T13:00:00.000Z",
      decidedByRef: "user_42"
    };
    const application: PaymentApplication = {
      paymentApplicationId: "application_payment_invoice",
      tenantId: rule.tenantId,
      sourceId: rule.sourceId,
      paymentTransactionId: candidate.originTransactionId,
      invoiceTransactionId: candidate.targetTransactionId,
      matchDecisionId: decision.matchDecisionId,
      appliedAmount: candidate.suggestedApplicationAmount,
      currencyCode: candidate.currencyCode,
      applicationDate: "2026-01-15",
      status: "proposed",
      createdAt: decision.decidedAt,
      updatedAt: decision.decidedAt
    };

    await adapter.upsertPostingRules([rule]);
    await adapter.upsertTransactionMatchCandidates([candidate]);
    await adapter.recordTransactionMatchDecisions([decision]);
    await adapter.upsertPaymentApplications([application]);

    expect(client.calls).toHaveLength(4);
    expect(client.calls[0]?.sql).toContain('insert into "erp_financials"."posting_rules"');
    expect(client.calls[0]?.sql).toContain('on conflict ("tenant_id", "source_id", "rule_code") do update');
    expect(client.calls[1]?.sql).toContain('insert into "erp_financials"."transaction_match_candidates"');
    expect(client.calls[1]?.sql).toContain(
      'on conflict ("tenant_id", "source_id", "match_kind", "origin_transaction_id", "target_transaction_id", "matcher_version") do update'
    );
    expect(client.calls[2]?.sql).toContain('insert into "erp_financials"."transaction_match_decisions"');
    expect(client.calls[2]?.sql).toContain(
      'on conflict ("tenant_id", "source_id", "match_decision_id") do nothing'
    );
    expect(client.calls[3]?.sql).toContain('insert into "erp_financials"."payment_applications"');
    expect(client.calls[3]?.sql).toContain(
      'on conflict ("tenant_id", "source_id", "payment_transaction_id", "invoice_transaction_id") do update'
    );
  });

  it("rejects credential-like provider payload refs before writing", async () => {
    const client = new RecordingClient();
    const adapter = createPostgresStorageAdapter(client);
    const firstPosting = ERP_FINANCIALS_STATEMENT_FIXTURE.postings[0];

    if (firstPosting === undefined) {
      throw new Error("fixture must include a posting");
    }

    await expect(
      adapter.upsertLedgerPostings([
        {
          ...firstPosting,
          sourcePayloadRef: {
            sourceObjectType: "Invoice",
            sourceObjectId: "123",
            preview: {
              access_token: "not allowed"
            }
          }
        }
      ])
    ).rejects.toThrow("credential-like field is not allowed");
    expect(client.calls).toHaveLength(0);
  });

  it("loads canonical fixtures and writes report, rollup, and freshness rows through explicit hooks", async () => {
    const client = new RecordingClient();
    const adapter = createPostgresStorageAdapter(client);
    const fixture = ERP_FINANCIALS_STATEMENT_FIXTURE;

    await expect(adapter.loadStatementFixture(fixture)).resolves.toEqual({
      companies: 1,
      sources: 1,
      importBatches: 1,
      checkpoints: 1,
      accounts: fixture.accounts.length,
      parties: fixture.parties.length,
      items: fixture.items.length,
      dimensions: fixture.dimensions.length,
      transactions: fixture.transactions.length,
      transactionLines: fixture.transactionLines.length,
      postings: fixture.postings.length
    });

    const report = buildProfitAndLossReport({
      ...fixture.reportRequest,
      accounts: fixture.accounts,
      postings: fixture.postings
    });

    await adapter.writeReportSnapshot(report);
    await adapter.writeRollupBuckets([
      {
        rollupBucketId: "rollup_fixture_sales_jan",
        tenantId: fixture.company.tenantId,
        companyId: fixture.company.companyId,
        sourceId: fixture.source.sourceId,
        accountId: "acct_sales",
        accountingBasis: "accrual",
        bucketGrain: "month",
        bucketStart: "2026-01-01",
        bucketEnd: "2026-01-31",
        currencyCode: "USD",
        dimensionHash: fixture.postings[2]?.dimensionHash ?? fixture.postings[0]?.dimensionHash ?? "",
        partyId: "party_customer_acme",
        partyType: "customer",
        itemId: "item_consulting",
        debitAmount: "0.00",
        creditAmount: "20000.00",
        netAmount: "-20000.00",
        postingCount: 2,
        importBatchId: fixture.importBatch.importBatchId,
        generatedAt: "2026-02-01T00:00:00.000Z"
      }
    ]);
    await adapter.writeFreshnessRows([
      {
        freshnessId: "freshness_profit_and_loss_fixture",
        tenantId: fixture.company.tenantId,
        companyId: fixture.company.companyId,
        sourceId: fixture.source.sourceId,
        reportName: "profit_and_loss",
        accountingBasis: "accrual",
        periodStart: "2026-01-01",
        periodEnd: "2026-01-31",
        currencyCode: "USD",
        status: "fresh",
        freshThrough: "2026-02-01T00:00:00.000Z",
        importBatchId: fixture.importBatch.importBatchId,
        checkpointId: fixture.checkpoint.checkpointId,
        updatedAt: "2026-02-01T00:00:00.000Z"
      }
    ]);

    expect(client.calls.some((call) => call.sql.includes('"report_snapshots"'))).toBe(true);
    expect(client.calls.some((call) => call.sql.includes('"rollup_buckets"'))).toBe(true);
    expect(client.calls.some((call) => call.sql.includes('"party_id"') && call.sql.includes('"party_type"') && call.sql.includes('"item_id"'))).toBe(true);
    expect(client.calls.some((call) => call.params.includes("party_customer_acme") && call.params.includes("customer") && call.params.includes("item_consulting"))).toBe(true);
    expect(client.calls.some((call) => call.sql.includes('"report_freshness"'))).toBe(true);
  });

  it("persists generated nested snapshot parentReportLineId values through report_snapshot_lines params", async () => {
    const client = new RecordingClient();
    const adapter = createPostgresStorageAdapter(client);
    const report = nestedHierarchyReport();

    await adapter.writeReportSnapshot(report);

    const lineUpsertCall = client.calls.find(
      (call) =>
        call.sql.includes('insert into "erp_financials"."report_snapshot_lines"') &&
        call.sql.includes('"parent_report_line_id"')
    );

    expect(lineUpsertCall).toBeDefined();
    expect(lineUpsertCall?.sql).toContain('"parent_report_line_id"');
    const reportSnapshotId = report.snapshot.reportSnapshotId;
    expect(parentLineParamsByReportLineId(lineUpsertCall?.params ?? [])).toEqual({
      [`${reportSnapshotId}:line:account:acct_storage_parent`]: null,
      [`${reportSnapshotId}:line:account:acct_storage_child`]: `${reportSnapshotId}:line:account:acct_storage_parent`,
      [`${reportSnapshotId}:line:account:acct_storage_grandchild`]: `${reportSnapshotId}:line:account:acct_storage_child`
    });
  });

  it("marks source-scoped snapshots stale for canonical account hierarchy changes", async () => {
    const client = new RecordingClient();
    const adapter = createPostgresStorageAdapter(client);

    await adapter.markReportSnapshotsStaleForAccountHierarchyChanges({
      tenantId: "tenant_1",
      companyId: "company_1",
      sourceId: "source_native",
      staleReason: ACCOUNT_HIERARCHY_CHANGED_STALE_REASON,
      reportNames: ["profit_and_loss", "balance_sheet"],
      accountingBasis: "accrual",
      currencyCode: "USD"
    });

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.sql).toContain('update "erp_financials"."report_snapshots" rs');
    expect(client.calls[0]?.sql).toContain('rs."company_id" = $2');
    expect(client.calls[0]?.sql).toContain('rs."source_id" = $3');
    expect(client.calls[0]?.sql).not.toContain('"report_freshness"');
    expect(client.calls[0]?.sql).toContain(`rs."report_name" = any($5::text[])`);
    expect(client.calls[0]?.sql).toContain(`rs."accounting_basis" = $6`);
    expect(client.calls[0]?.sql).toContain(`rs."currency_code" = $7`);
    expect(client.calls[0]?.params).toEqual([
      "tenant_1",
      "company_1",
      "source_native",
      ACCOUNT_HIERARCHY_CHANGED_STALE_REASON,
      ["profit_and_loss", "balance_sheet"],
      "accrual",
      "USD"
    ]);
  });

  it("prunes missing snapshot rows and upserts parent line ids when hierarchy shape changes", async () => {
    const client = new RecordingClient();
    const adapter = createPostgresStorageAdapter(client);
    const nestedReport = nestedHierarchyReport();
    const flatReport = flatGrandchildReport(nestedReport);
    const reportSnapshotId = nestedReport.snapshot.reportSnapshotId;

    await adapter.writeReportSnapshot(flatReport);
    await adapter.writeReportSnapshot(nestedReport);
    await adapter.writeReportSnapshot(flatReport);

    const lineDeleteCalls = client.calls.filter(
      (call) => call.sql.includes('delete from "erp_financials"."report_snapshot_lines"')
    );
    const lineUpsertCalls = client.calls.filter(
      (call) => call.sql.includes('insert into "erp_financials"."report_snapshot_lines"')
    );

    expect(lineDeleteCalls).toHaveLength(3);
    expect(lineDeleteCalls[1]?.params[4]).toEqual([
      `${reportSnapshotId}:line:account:acct_storage_parent`,
      `${reportSnapshotId}:line:account:acct_storage_child`,
      `${reportSnapshotId}:line:account:acct_storage_grandchild`
    ]);
    expect(lineDeleteCalls[2]?.params[4]).toEqual([`${reportSnapshotId}:line:account:acct_storage_grandchild`]);
    expect(parentLineParamsByReportLineId(lineUpsertCalls[1]?.params ?? [])).toMatchObject({
      [`${reportSnapshotId}:line:account:acct_storage_child`]: `${reportSnapshotId}:line:account:acct_storage_parent`,
      [`${reportSnapshotId}:line:account:acct_storage_grandchild`]: `${reportSnapshotId}:line:account:acct_storage_child`
    });
    expect(parentLineParamsByReportLineId(lineUpsertCalls[2]?.params ?? [])).toEqual({
      [`${reportSnapshotId}:line:account:acct_storage_grandchild`]: null
    });
  });

  it("loads rollup buckets with tenant/source/date/currency scope and optional grouping filters", async () => {
    const client = new RecordingClient();
    const adapter = createPostgresStorageAdapter(client);

    await adapter.loadRollupBuckets({
      tenantId: "tenant_1",
      companyId: "company_1",
      sourceId: "source_qbo",
      accountingBasis: "accrual",
      bucketGrain: "month",
      bucketStart: "2026-01-01",
      bucketEnd: "2026-03-31",
      currencyCode: "USD",
      accountIds: ["acct_sales", "acct_cogs"],
      dimensionHash: "0".repeat(64),
      partyTypes: ["customer", "vendor"],
      partyId: "party_acme",
      itemIds: ["item_consulting", "item_subscription"]
    });

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.sql).toContain('from "erp_financials"."rollup_buckets"');
    expect(client.calls[0]?.sql).toContain('"tenant_id" = $1');
    expect(client.calls[0]?.sql).toContain('"company_id" = $2');
    expect(client.calls[0]?.sql).toContain('"source_id" = $3');
    expect(client.calls[0]?.sql).toContain('"accounting_basis" = $4');
    expect(client.calls[0]?.sql).toContain('"bucket_grain" = $5');
    expect(client.calls[0]?.sql).toContain('"bucket_start" >= $6::date');
    expect(client.calls[0]?.sql).toContain('"bucket_end" <= $7::date');
    expect(client.calls[0]?.sql).toContain('"currency_code" = $8');
    expect(client.calls[0]?.sql).toContain('"account_id" = any($9::text[])');
    expect(client.calls[0]?.sql).toContain('"dimension_hash" = any($10::text[])');
    expect(client.calls[0]?.sql).toContain('"party_type" = any($11::text[])');
    expect(client.calls[0]?.sql).toContain('"party_id" = any($12::text[])');
    expect(client.calls[0]?.sql).toContain('"item_id" = any($13::text[])');
    expect(client.calls[0]?.sql).toContain(
      'order by "bucket_start", "account_id", "dimension_hash", "party_type", "party_id", "item_id"'
    );
    expect(client.calls[0]?.sql).not.toMatch(/Intuit|OAuth|access[_-]?token|refresh[_-]?token|client[_-]?secret/i);
    expect(client.calls[0]?.sql).not.toMatch(/quickbooks_.*archive|provider_.*archive|raw_.*payload/i);
    expect(client.calls[0]?.params).toEqual([
      "tenant_1",
      "company_1",
      "source_qbo",
      "accrual",
      "month",
      "2026-01-01",
      "2026-03-31",
      "USD",
      ["acct_sales", "acct_cogs"],
      ["0".repeat(64)],
      ["customer", "vendor"],
      ["party_acme"],
      ["item_consulting", "item_subscription"]
    ]);
  });

  it("serves a two-year monthly P&L presentation from snapshots without loading raw ledger postings", async () => {
    const request = {
      tenantId: "tenant_1",
      companyId: "company_1",
      sourceId: "source_qbo",
      reportName: "profit_and_loss",
      accountingMethod: "accrual",
      periodStart: "2026-01-01",
      periodEnd: "2027-12-31",
      asOfDate: "2027-12-31",
      currencyCode: "USD",
      displayColumnsBy: "months"
    } satisfies StandardReportPresentationReadModelRequest;
    const client = new SnapshotPresentationClient(monthlyProfitAndLossSnapshots(request));
    const adapter = createPostgresStorageAdapter(client);

    const presentation = await buildStandardReportPresentationFromReadModel(adapter, request);

    expect(Object.hasOwn(request, "reportInput")).toBe(false);
    expect(presentation.columns).toHaveLength(24);
    expect(presentation.columns[0]).toMatchObject({
      columnId: "actual:months:month:2026-01-01:2026-01-31",
      label: "01/2026",
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31"
    });
    expect(presentation.columns[23]).toMatchObject({
      columnId: "actual:months:month:2027-12-01:2027-12-31",
      label: "12/2027",
      periodStart: "2027-12-01",
      periodEnd: "2027-12-31"
    });
    expect(rowCell(presentation, "total:net_income", "actual:months:month:2026-01-01:2026-01-31")?.amount).toBe("100.00");
    expect(rowCell(presentation, "total:net_income", "actual:months:month:2027-12-01:2027-12-31")?.amount).toBe("2400.00");
    expect(presentation.primaryReport.metadata.generatedFrom).toBe("rollup_buckets");
    expect(presentation.primaryReport.totals.find((total) => total.totalKey === "net_income")?.amount).toBe("30000.00");
    expect(client.calls.some((call) => call.sql.includes('"ledger_postings"'))).toBe(false);
    expect(client.calls.some((call) => call.sql.includes('from "erp_financials"."accounts"'))).toBe(false);
    expect(client.calls.every((call) => call.sql.includes('"report_snapshots"') || call.sql.includes('"report_snapshot_'))).toBe(true);
  });

  it.each([
    {
      reportName: "balance_sheet" as const,
      section: "asset",
      accountId: "acct_cash",
      lineLabel: "1000 Cash",
      lineAmount: "425.00",
      totalKey: "total_assets",
      totalLabel: "Total Assets",
      totalAmount: "425.00"
    },
    {
      reportName: "trial_balance" as const,
      section: "asset",
      accountId: "acct_cash",
      lineLabel: "1000 Cash",
      lineAmount: "425.00",
      totalKey: "total_debits",
      totalLabel: "Total Debits",
      totalAmount: "425.00"
    }
  ])("serves a cash-basis $reportName standard presentation from snapshots", async (fixture) => {
    const request = {
      tenantId: "tenant_1",
      companyId: "company_1",
      sourceId: "source_native",
      reportName: fixture.reportName,
      accountingMethod: "cash",
      periodStart: "2026-01-01",
      periodEnd: "2026-03-31",
      asOfDate: "2026-03-31",
      currencyCode: "USD",
      displayColumnsBy: "none"
    } satisfies StandardReportPresentationReadModelRequest;
    const client = new SnapshotPresentationClient([standardStatementSnapshot(request, fixture)]);
    const adapter = createPostgresStorageAdapter(client);

    const presentation = await buildStandardReportPresentationFromReadModel(adapter, request);

    expect(presentation).toMatchObject({
      reportName: fixture.reportName,
      accountingMethod: "cash",
      displayColumnsBy: "none"
    });
    expect(rowCell(presentation, `line:account:${fixture.accountId}`, "actual:none:total")?.amount).toBe(
      fixture.lineAmount
    );
    expect(rowCell(presentation, `total:${fixture.totalKey}`, "actual:none:total")?.amount).toBe(fixture.totalAmount);
    expect(presentation.primaryReport.snapshot).toMatchObject({
      reportName: fixture.reportName,
      accountingBasis: "cash",
      freshness: { status: "fresh" }
    });
    expect(presentation.primaryReport.lines[0]?.drilldownRef.query).toMatchObject({
      accountingBasis: "cash",
      periodStart: request.periodStart,
      periodEnd: request.periodEnd
    });
    expect(client.calls.some((call) => call.sql.includes('"ledger_postings"'))).toBe(false);
  });

  it.each([
    [
      "days",
      "2026-01-01",
      "2026-01-02",
      [
        {
          periodStart: "2026-01-01",
          periodEnd: "2026-01-01",
          columnId: "actual:days:day:2026-01-01:2026-01-01",
          label: "2026-01-01"
        },
        {
          periodStart: "2026-01-02",
          periodEnd: "2026-01-02",
          columnId: "actual:days:day:2026-01-02:2026-01-02",
          label: "2026-01-02"
        }
      ]
    ],
    [
      "weeks",
      "2026-01-01",
      "2026-01-10",
      [
        {
          periodStart: "2026-01-01",
          periodEnd: "2026-01-03",
          columnId: "actual:weeks:week:2026-01-01:2026-01-03",
          label: "2026-01-01 - 2026-01-03"
        },
        {
          periodStart: "2026-01-04",
          periodEnd: "2026-01-10",
          columnId: "actual:weeks:week:2026-01-04:2026-01-10",
          label: "2026-01-04 - 2026-01-10"
        }
      ]
    ],
    [
      "months",
      "2026-01-01",
      "2026-02-28",
      [
        {
          periodStart: "2026-01-01",
          periodEnd: "2026-01-31",
          columnId: "actual:months:month:2026-01-01:2026-01-31",
          label: "01/2026"
        },
        {
          periodStart: "2026-02-01",
          periodEnd: "2026-02-28",
          columnId: "actual:months:month:2026-02-01:2026-02-28",
          label: "02/2026"
        }
      ]
    ],
    [
      "quarters",
      "2026-01-01",
      "2026-06-30",
      [
        {
          periodStart: "2026-01-01",
          periodEnd: "2026-03-31",
          columnId: "actual:quarters:quarter:2026-01-01:2026-03-31",
          label: "Q1 2026"
        },
        {
          periodStart: "2026-04-01",
          periodEnd: "2026-06-30",
          columnId: "actual:quarters:quarter:2026-04-01:2026-06-30",
          label: "Q2 2026"
        }
      ]
    ],
    [
      "years",
      "2026-01-01",
      "2027-12-31",
      [
        {
          periodStart: "2026-01-01",
          periodEnd: "2026-12-31",
          columnId: "actual:years:year:2026-01-01:2026-12-31",
          label: "2026"
        },
        {
          periodStart: "2027-01-01",
          periodEnd: "2027-12-31",
          columnId: "actual:years:year:2027-01-01:2027-12-31",
          label: "2027"
        }
      ]
    ]
  ] as const)(
    "serves nested %s P&L rows from stored snapshots without rollups or raw postings",
    async (displayColumnsBy, periodStart, periodEnd, expectedColumns) => {
      const request = {
        tenantId: "tenant_1",
        companyId: "company_1",
        sourceId: "source_qbo",
        reportName: "profit_and_loss",
        accountingMethod: "accrual",
        periodStart,
        periodEnd,
        asOfDate: periodEnd,
        currencyCode: "USD",
        displayColumnsBy
      } satisfies StandardReportPresentationReadModelRequest;
      const client = new SnapshotPresentationClient(nestedDateGrainProfitAndLossSnapshots(request, expectedColumns));
      const adapter = createPostgresStorageAdapter(client);

      const presentation = await buildStandardReportPresentationFromReadModel(adapter, request);

      expect(Object.hasOwn(request, "reportInput")).toBe(false);
      expect(presentation.columns).toHaveLength(expectedColumns.length);
      expect(presentation.columns.map((column) => ({
        columnId: column.columnId,
        label: column.label,
        periodStart: column.periodStart,
        periodEnd: column.periodEnd,
        displayColumnsBy: column.displayColumnsBy
      }))).toEqual(
        expectedColumns.map((column) => ({
          ...column,
          displayColumnsBy
        }))
      );
      expect(presentation.rows.find((row) => row.rowId === "line:account:acct_snapshot_expense_parent")).toMatchObject({
        hierarchyDepth: 0
      });
      expect(presentation.rows.find((row) => row.rowId === "line:account:acct_snapshot_expense_child")).toMatchObject({
        parentRowId: "line:account:acct_snapshot_expense_parent",
        hierarchyDepth: 1
      });
      expect(presentation.rows.find((row) => row.rowId === "line:account:acct_snapshot_expense_grandchild")).toMatchObject({
        parentRowId: "line:account:acct_snapshot_expense_child",
        hierarchyDepth: 2
      });
      expect(presentation.rows.find((row) => row.rowId === "total:total_expenses")?.parentRowId).toBeUndefined();
      expect(presentation.rows.find((row) => row.rowId === "total:total_expenses")?.hierarchyDepth).toBeUndefined();

      const rowIds = presentation.rows.map((row) => row.rowId);
      expect(rowIds.indexOf("line:account:acct_snapshot_expense_parent")).toBeLessThan(
        rowIds.indexOf("line:account:acct_snapshot_expense_child")
      );
      expect(rowIds.indexOf("line:account:acct_snapshot_expense_child")).toBeLessThan(
        rowIds.indexOf("line:account:acct_snapshot_expense_grandchild")
      );

      expectedColumns.forEach((column, index) => {
        const multiplier = index + 1;
        expect(rowCell(presentation, "line:account:acct_snapshot_income", column.columnId)?.amount).toBe(money(100 * multiplier));
        expect(rowCell(presentation, "line:account:acct_snapshot_expense_parent", column.columnId)?.amount).toBe(money(60 * multiplier));
        expect(rowCell(presentation, "line:account:acct_snapshot_expense_child", column.columnId)?.amount).toBe(money(50 * multiplier));
        expect(rowCell(presentation, "line:account:acct_snapshot_expense_grandchild", column.columnId)?.amount).toBe(money(30 * multiplier));
        expect(rowCell(presentation, "total:total_income", column.columnId)?.amount).toBe(money(100 * multiplier));
        expect(rowCell(presentation, "total:total_expenses", column.columnId)?.amount).toBe(money(60 * multiplier));
        expect(rowCell(presentation, "total:net_income", column.columnId)?.amount).toBe(money(40 * multiplier));
      });

      const totalMultiplier = expectedColumns.reduce((sum, _column, index) => sum + index + 1, 0);
      expect(presentation.primaryReport.metadata.generatedFrom).toBe("rollup_buckets");
      expect(presentation.primaryReport.snapshot.snapshotSource).toBe("rollup");
      expect(snapshotLineByAccountId(presentation.primaryReport.lines, "acct_snapshot_expense_parent").amount).toBe(
        money(60 * totalMultiplier)
      );
      expect(snapshotLineByAccountId(presentation.primaryReport.lines, "acct_snapshot_expense_child")).toMatchObject({
        parentReportLineId: `${presentation.primaryReport.snapshot.reportSnapshotId}:line:account:acct_snapshot_expense_parent`,
        amount: money(50 * totalMultiplier)
      });
      expect(snapshotLineByAccountId(presentation.primaryReport.lines, "acct_snapshot_expense_grandchild")).toMatchObject({
        parentReportLineId: `${presentation.primaryReport.snapshot.reportSnapshotId}:line:account:acct_snapshot_expense_child`,
        amount: money(30 * totalMultiplier)
      });
      expect(presentation.primaryReport.totals.find((total) => total.totalKey === "total_expenses")?.amount).toBe(
        money(60 * totalMultiplier)
      );
      expect(presentation.primaryReport.totals.find((total) => total.totalKey === "net_income")?.amount).toBe(
        money(40 * totalMultiplier)
      );
      const synthesizedExpensesDrilldown = snapshotTotalByKey(presentation.primaryReport.totals, "total_expenses").drilldownRef;
      expect(synthesizedExpensesDrilldown.accountIds).toEqual([
        "acct_snapshot_expense_child",
        "acct_snapshot_expense_grandchild",
        "acct_snapshot_expense_parent"
      ]);
      expect(synthesizedExpensesDrilldown.query).toMatchObject({
        kind: "ledger_postings",
        tenantId: request.tenantId,
        sourceId: request.sourceId,
        accountingBasis: request.accountingMethod,
        periodStart: request.periodStart,
        periodEnd: request.periodEnd,
        accountIds: [
          "acct_snapshot_expense_child",
          "acct_snapshot_expense_grandchild",
          "acct_snapshot_expense_parent"
        ]
      });
      expect(synthesizedExpensesDrilldown.postingIds).toEqual(
        expectedColumns.map((column) => `post_total_expenses_${column.periodStart}`)
      );
      expect(synthesizedExpensesDrilldown.sourceRefs?.map((sourceRef) => sourceRef.sourceObjectType)).toEqual([
        "RollupBucketAggregate",
        "RollupBucketAggregate"
      ]);
      expect(JSON.stringify(synthesizedExpensesDrilldown)).not.toMatch(
        /Intuit|OAuth|access[_-]?token|refresh[_-]?token|client[_-]?secret|rawPayload|raw[_-]?provider/i
      );
      expect(client.calls.some((call) => call.sql.includes('"ledger_postings"'))).toBe(false);
      expect(client.calls.some((call) => call.sql.includes('"rollup_buckets"'))).toBe(false);
      expect(client.calls.some((call) => call.sql.includes('from "erp_financials"."accounts"'))).toBe(false);
      expect(client.calls.every((call) => call.sql.includes('"report_snapshots"') || call.sql.includes('"report_snapshot_'))).toBe(true);
    }
  );

  it("loads nested stored snapshot parentReportLineId values from report_snapshot_lines", async () => {
    const request = {
      tenantId: "tenant_1",
      companyId: "company_1",
      sourceId: "source_qbo",
      reportName: "profit_and_loss",
      accountingMethod: "accrual",
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
      asOfDate: "2026-01-31",
      currencyCode: "USD"
    } satisfies StandardReportPresentationReadModelRequest;
    const reportSnapshotId = "snapshot:tenant_1:profit_and_loss:nested:2026-01";
    const client = new SnapshotPresentationClient([
      {
        snapshot: {
          report_snapshot_id: reportSnapshotId,
          tenant_id: request.tenantId,
          company_id: request.companyId,
          source_id: request.sourceId,
          report_name: request.reportName,
          snapshot_source: "builder",
          accounting_basis: request.accountingMethod,
          period_start: request.periodStart,
          period_end: request.periodEnd,
          as_of_date: request.asOfDate,
          currency_code: request.currencyCode,
          generated_at: "2026-02-01T00:00:00.000Z",
          freshness: { status: "fresh", sourceId: request.sourceId },
          reconciliation_status: "not_reconciled",
          reconciliation_difference: "0.00"
        },
        lines: nestedStoredSnapshotLines(request, reportSnapshotId),
        totals: []
      }
    ]);
    const adapter = createPostgresStorageAdapter(client);

    const storedSnapshot = await adapter.loadLatestReportSnapshot({
      tenantId: request.tenantId,
      companyId: request.companyId,
      sourceId: request.sourceId,
      reportName: request.reportName,
      accountingBasis: request.accountingMethod,
      periodStart: request.periodStart,
      periodEnd: request.periodEnd,
      asOfDate: request.asOfDate,
      currencyCode: request.currencyCode
    });

    expect(storedSnapshot?.lines).toHaveLength(3);
    expect(snapshotLineByAccountId(storedSnapshot?.lines ?? [], "acct_storage_parent").parentReportLineId).toBeUndefined();
    expect(Object.hasOwn(snapshotLineByAccountId(storedSnapshot?.lines ?? [], "acct_storage_parent"), "parentReportLineId")).toBe(false);
    expect(snapshotLineByAccountId(storedSnapshot?.lines ?? [], "acct_storage_child").parentReportLineId).toBe(
      `${reportSnapshotId}:line:account:acct_storage_parent`
    );
    expect(snapshotLineByAccountId(storedSnapshot?.lines ?? [], "acct_storage_grandchild").parentReportLineId).toBe(
      `${reportSnapshotId}:line:account:acct_storage_child`
    );
  });

  it.each([
    ["customer", "party_customer_acme", "Acme Co", '"party_type" = $10', "customer"],
    ["vendor", "party_vendor_northwind", "Northwind Supplies", '"party_type" = $10', "vendor"],
    ["employee", "party_employee_jane", "Jane Employee", '"party_type" = $10', "employee"],
    ["product_service", "item_consulting", "Consulting", '"item_id" <> \'\'', undefined]
  ] as const)(
    "serves %s P&L display columns from grouped rollup buckets without loading raw ledger postings",
    async (displayColumnsBy, groupKey, groupLabel, expectedSql, expectedPartyTypeParam) => {
      const request = {
        tenantId: "tenant_1",
        companyId: "company_1",
        sourceId: "source_qbo",
        reportName: "profit_and_loss",
        accountingMethod: "accrual",
        periodStart: "2026-01-01",
        periodEnd: "2026-01-31",
        asOfDate: "2026-01-31",
        currencyCode: "USD",
        displayColumnsBy
      } satisfies StandardReportPresentationReadModelRequest;
      const client = new RollupPresentationClient([
        rollupPresentationRow(groupKey, groupLabel, "acct_sales", "4000", "Sales", "income", "0.00", "200.00", "-200.00"),
        rollupPresentationRow(groupKey, groupLabel, "acct_expense", "6000", "Expense", "expense", "50.00", "0.00", "50.00")
      ]);
      const adapter = createPostgresStorageAdapter(client);

      const presentation = await buildStandardReportPresentationFromReadModel(adapter, request);

      expect(presentation.columns).toHaveLength(1);
      expect(presentation.columns[0]).toMatchObject({
        columnId: `actual:${displayColumnsBy}:${groupKey}`,
        label: groupLabel,
        displayColumnsBy
      });
      expect(rowCell(presentation, "line:account:acct_sales", `actual:${displayColumnsBy}:${groupKey}`)?.amount).toBe("200.00");
      expect(rowCell(presentation, "line:account:acct_expense", `actual:${displayColumnsBy}:${groupKey}`)?.amount).toBe("50.00");
      expect(rowCell(presentation, "total:net_income", `actual:${displayColumnsBy}:${groupKey}`)?.amount).toBe("150.00");
      expect(presentation.primaryReport.metadata.generatedFrom).toBe("rollup_buckets");

      const rollupCall = client.calls.find((call) => call.sql.includes('from "erp_financials"."rollup_buckets"'));
      expect(rollupCall?.sql).toContain('join "erp_financials"."accounts"');
      expect(rollupCall?.sql).toContain('a."parent_account_id"');
      expect(rollupCall?.sql).toContain('left join "erp_financials"."accounts" pa');
      expect(rollupCall?.sql).toContain('pa."tenant_id" = a."tenant_id"');
      expect(rollupCall?.sql).toContain('pa."source_id" = a."source_id"');
      expect(rollupCall?.sql).toContain('pa."account_id" = a."parent_account_id"');
      expect(rollupCall?.sql).toContain('pa."account_number" as "parent_account_number"');
      expect(rollupCall?.sql).toContain('pa."name" as "parent_account_name"');
      expect(rollupCall?.sql).toContain('pa."classification" as "parent_account_classification"');
      expect(rollupCall?.sql).toContain(expectedSql);
      expect(rollupCall?.sql).toContain('rb."tenant_id" = $1');
      expect(rollupCall?.sql).toContain('rb."company_id" = $2');
      expect(rollupCall?.sql).toContain('rb."source_id" = $3');
      expect(rollupCall?.sql).toContain('rb."accounting_basis" = $4');
      expect(rollupCall?.sql).toContain('rb."bucket_grain" = $5');
      expect(rollupCall?.sql).toContain('rb."bucket_start" >= $6::date');
      expect(rollupCall?.sql).toContain('rb."bucket_end" <= $7::date');
      expect(rollupCall?.sql).toContain('rb."currency_code" = $8');
      expect(rollupCall?.sql).toContain('a."classification" = any($9::text[])');
      expect(rollupCall?.params.slice(0, 9)).toEqual([
        "tenant_1",
        "company_1",
        "source_qbo",
        "accrual",
        "month",
        "2026-01-01",
        "2026-01-31",
        "USD",
        ["income", "cost_of_goods_sold", "expense", "other_income", "other_expense"]
      ]);
      if (expectedPartyTypeParam === undefined) {
        expect(rollupCall?.params).toHaveLength(9);
      } else {
        expect(rollupCall?.params[9]).toBe(expectedPartyTypeParam);
      }
      const accountCall = client.calls.find((call) => call.sql.includes('with recursive "relevant_accounts"'));
      expect(accountCall?.sql).toContain('from "erp_financials"."accounts" a');
      expect(accountCall?.sql).toContain('join "relevant_accounts" child');
      expect(accountCall?.params).toEqual([
        request.tenantId,
        request.sourceId,
        ["acct_expense", "acct_sales"],
        ["income", "cost_of_goods_sold", "expense", "other_income", "other_expense"]
      ]);
      expect(client.calls.some((call) => call.sql.includes('"ledger_postings"'))).toBe(false);
    }
  );

  it.each([
    ["customer", "party_customer_acme", "Acme Co"],
    ["vendor", "party_vendor_northwind", "Northwind Supplies"],
    ["employee", "party_employee_jane", "Jane Employee"],
    ["product_service", "item_consulting", "Consulting"]
  ] as const)(
    "serves nested %s P&L rows from rollup buckets and canonical accounts without loading raw postings",
    async (displayColumnsBy, groupKey, groupLabel) => {
      const request = {
        tenantId: "tenant_1",
        companyId: "company_1",
        sourceId: "source_qbo",
        reportName: "profit_and_loss",
        accountingMethod: "accrual",
        periodStart: "2026-01-01",
        periodEnd: "2026-01-31",
        asOfDate: "2026-01-31",
        currencyCode: "USD",
        displayColumnsBy
      } satisfies StandardReportPresentationReadModelRequest;
      const aggregateRows = [
        rollupPresentationRow(groupKey, groupLabel, "acct_sales", "4000", "Sales", "income", "0.00", "100.00", "-100.00"),
        rollupPresentationRow(groupKey, groupLabel, "acct_parent_expense", "6000", "Parent Expense", "expense", "10.00", "0.00", "10.00", {
          parentAccountId: "acct_root_expense",
          parentAccountNumber: "5900",
          parentAccountName: "Expense Root",
          parentAccountClassification: "expense"
        }),
        rollupPresentationRow(groupKey, groupLabel, "acct_child_expense", "6100", "Child Expense", "expense", "20.00", "0.00", "20.00", {
          parentAccountId: "acct_parent_expense",
          parentAccountNumber: "6000",
          parentAccountName: "Parent Expense",
          parentAccountClassification: "expense"
        }),
        rollupPresentationRow(groupKey, groupLabel, "acct_sibling_expense", "6200", "Sibling Expense", "expense", "5.00", "0.00", "5.00", {
          parentAccountId: "acct_parent_expense",
          parentAccountNumber: "6000",
          parentAccountName: "Parent Expense",
          parentAccountClassification: "expense"
        }),
        rollupPresentationRow(
          groupKey,
          groupLabel,
          "acct_grandchild_expense",
          "6110",
          "Grandchild Expense",
          "expense",
          "30.00",
          "0.00",
          "30.00",
          {
            parentAccountId: "acct_child_expense",
            parentAccountNumber: "6100",
            parentAccountName: "Child Expense",
            parentAccountClassification: "expense"
          }
        )
      ];
      const client = new RollupPresentationClient(aggregateRows, [
        rollupPresentationAccountRow(request, "acct_sales", "4000", "Sales", "income"),
        rollupPresentationAccountRow(request, "acct_root_expense", "5900", "Expense Root", "expense"),
        rollupPresentationAccountRow(request, "acct_parent_expense", "6000", "Parent Expense", "expense", "acct_root_expense"),
        rollupPresentationAccountRow(request, "acct_child_expense", "6100", "Child Expense", "expense", "acct_parent_expense"),
        rollupPresentationAccountRow(request, "acct_sibling_expense", "6200", "Sibling Expense", "expense", "acct_parent_expense"),
        rollupPresentationAccountRow(
          request,
          "acct_grandchild_expense",
          "6110",
          "Grandchild Expense",
          "expense",
          "acct_child_expense"
        )
      ]);
      const adapter = createPostgresStorageAdapter(client);

      const presentation = await buildStandardReportPresentationFromReadModel(adapter, request);
      const columnId = `actual:${displayColumnsBy}:${groupKey}`;

      expect(rowCell(presentation, "line:account:acct_root_expense", columnId)?.amount).toBe("65.00");
      expect(rowCell(presentation, "line:account:acct_parent_expense", columnId)?.amount).toBe("65.00");
      expect(rowCell(presentation, "line:account:acct_child_expense", columnId)?.amount).toBe("50.00");
      expect(rowCell(presentation, "line:account:acct_grandchild_expense", columnId)?.amount).toBe("30.00");
      expect(rowCell(presentation, "line:account:acct_sibling_expense", columnId)?.amount).toBe("5.00");
      expect(presentation.rows.find((row) => row.rowId === "line:account:acct_root_expense")?.parentRowId).toBeUndefined();
      expect(presentation.rows.find((row) => row.rowId === "line:account:acct_root_expense")?.hierarchyDepth).toBe(0);
      expect(presentation.rows.find((row) => row.rowId === "line:account:acct_parent_expense")).toMatchObject({
        parentRowId: "line:account:acct_root_expense",
        hierarchyDepth: 1
      });
      expect(presentation.rows.find((row) => row.rowId === "line:account:acct_child_expense")).toMatchObject({
        parentRowId: "line:account:acct_parent_expense",
        hierarchyDepth: 2
      });
      expect(presentation.rows.find((row) => row.rowId === "line:account:acct_sibling_expense")).toMatchObject({
        parentRowId: "line:account:acct_parent_expense",
        hierarchyDepth: 2
      });
      expect(presentation.rows.find((row) => row.rowId === "line:account:acct_grandchild_expense")).toMatchObject({
        parentRowId: "line:account:acct_child_expense",
        hierarchyDepth: 3
      });
      expect(presentation.rows.find((row) => row.rowId === "total:total_expenses")?.parentRowId).toBeUndefined();
      expect(presentation.rows.find((row) => row.rowId === "total:total_expenses")?.hierarchyDepth).toBeUndefined();
      expect(rowCell(presentation, "total:total_expenses", columnId)?.amount).toBe("65.00");
      expect(rowCell(presentation, "total:net_income", columnId)?.amount).toBe("35.00");
      expect(presentation.primaryReport.totals.find((total) => total.totalKey === "total_expenses")?.amount).toBe("65.00");
      expect(presentation.primaryReport.totals.find((total) => total.totalKey === "net_income")?.amount).toBe("35.00");
      const totalExpensesDrilldown = snapshotTotalByKey(presentation.primaryReport.totals, "total_expenses").drilldownRef;
      expect(totalExpensesDrilldown.accountIds).toEqual([
        "acct_child_expense",
        "acct_grandchild_expense",
        "acct_parent_expense",
        "acct_root_expense",
        "acct_sibling_expense"
      ]);
      expect(totalExpensesDrilldown.query).toMatchObject({
        kind: "ledger_postings",
        tenantId: request.tenantId,
        sourceId: request.sourceId,
        accountingBasis: request.accountingMethod,
        periodStart: request.periodStart,
        periodEnd: request.periodEnd,
        accountIds: [
          "acct_child_expense",
          "acct_grandchild_expense",
          "acct_parent_expense",
          "acct_root_expense",
          "acct_sibling_expense"
        ]
      });
      expect(totalExpensesDrilldown.sourceRefs?.map((sourceRef) => sourceRef.sourceObjectId)).toEqual([
        rollupSourceRefId(request, groupKey, "acct_child_expense"),
        rollupSourceRefId(request, groupKey, "acct_grandchild_expense"),
        rollupSourceRefId(request, groupKey, "acct_parent_expense"),
        rollupSourceRefId(request, groupKey, "acct_sibling_expense")
      ]);
      expect(totalExpensesDrilldown.sourceRefs?.map((sourceRef) => sourceRef.sourceObjectId)).not.toContain(
        rollupSourceRefId(request, groupKey, "acct_sales")
      );
      const netIncomeDrilldown = snapshotTotalByKey(presentation.primaryReport.totals, "net_income").drilldownRef;
      expect(netIncomeDrilldown.accountIds).toEqual([
        "acct_child_expense",
        "acct_grandchild_expense",
        "acct_parent_expense",
        "acct_root_expense",
        "acct_sales",
        "acct_sibling_expense"
      ]);
      expect(netIncomeDrilldown.query?.accountIds).toEqual(netIncomeDrilldown.accountIds);
      expect(netIncomeDrilldown.sourceRefs?.map((sourceRef) => sourceRef.sourceObjectType)).toEqual([
        "RollupBucketAggregate",
        "RollupBucketAggregate",
        "RollupBucketAggregate",
        "RollupBucketAggregate",
        "RollupBucketAggregate"
      ]);
      expect(JSON.stringify(netIncomeDrilldown)).not.toMatch(
        /Intuit|OAuth|access[_-]?token|refresh[_-]?token|client[_-]?secret|rawPayload|raw[_-]?provider/i
      );
      expect(snapshotLineByAccountId(presentation.primaryReport.lines, "acct_root_expense").parentReportLineId).toBeUndefined();
      expect(snapshotLineByAccountId(presentation.primaryReport.lines, "acct_parent_expense").parentReportLineId).toBe(
        `${presentation.primaryReport.snapshot.reportSnapshotId}:line:account:acct_root_expense`
      );
      expect(snapshotLineByAccountId(presentation.primaryReport.lines, "acct_child_expense").parentReportLineId).toBe(
        `${presentation.primaryReport.snapshot.reportSnapshotId}:line:account:acct_parent_expense`
      );
      expect(snapshotLineByAccountId(presentation.primaryReport.lines, "acct_grandchild_expense").parentReportLineId).toBe(
        `${presentation.primaryReport.snapshot.reportSnapshotId}:line:account:acct_child_expense`
      );
      expect(snapshotLineByAccountId(presentation.primaryReport.lines, "acct_sibling_expense").parentReportLineId).toBe(
        `${presentation.primaryReport.snapshot.reportSnapshotId}:line:account:acct_parent_expense`
      );
      expect(snapshotLineByAccountId(presentation.primaryReport.lines, "acct_parent_expense").drilldownRef.accountIds).toEqual([
        "acct_child_expense",
        "acct_grandchild_expense",
        "acct_parent_expense",
        "acct_sibling_expense"
      ]);
      const childDrilldown = snapshotLineByAccountId(presentation.primaryReport.lines, "acct_child_expense").drilldownRef;
      expect(childDrilldown.accountIds).toEqual(["acct_child_expense", "acct_grandchild_expense"]);
      expect(childDrilldown.query?.accountIds).toEqual(["acct_child_expense", "acct_grandchild_expense"]);
      expect(childDrilldown.postingIds).toEqual([]);
      expect(childDrilldown.postingCount).toBe(0);
      expect(childDrilldown.sourceRefs?.map((sourceRef) => sourceRef.sourceObjectId)).toEqual([
        rollupSourceRefId(request, groupKey, "acct_child_expense"),
        rollupSourceRefId(request, groupKey, "acct_grandchild_expense")
      ]);
      expect(childDrilldown.sourceRefs?.map((sourceRef) => sourceRef.sourceObjectId)).not.toContain(
        rollupSourceRefId(request, groupKey, "acct_sibling_expense")
      );
      expect(childDrilldown.sourceRefCount).toBe(2);
      expect(presentation.primaryReport.metadata.generatedFrom).toBe("rollup_buckets");
      expect(client.calls.some((call) => call.sql.includes('"ledger_postings"'))).toBe(false);
    }
  );

  it("maps parent account metadata from rollup presentation account rows into nested row output", async () => {
    const request = {
      tenantId: "tenant_1",
      companyId: "company_1",
      sourceId: "source_qbo",
      reportName: "profit_and_loss",
      accountingMethod: "accrual",
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
      asOfDate: "2026-01-31",
      currencyCode: "USD",
      displayColumnsBy: "customer"
    } satisfies StandardReportPresentationReadModelRequest;
    const aggregateRow = rollupPresentationRow(
      "party_customer_acme",
      "Acme Co",
      "acct_child_expense",
      "6100",
      "Child Expense",
      "expense",
      "75.00",
      "0.00",
      "75.00",
      {
        parentAccountId: "acct_parent_expense",
        parentAccountNumber: "6000",
        parentAccountName: "Parent Expense",
        parentAccountClassification: "expense"
      }
    );
    const client = new RollupPresentationClient([aggregateRow]);
    const adapter = createPostgresStorageAdapter(client);

    const mappedRow = rollupPresentationAccountRowFromRow(aggregateRow);
    const presentation = await buildStandardReportPresentationFromReadModel(adapter, request);

    expect(mappedRow).toMatchObject({
      accountId: "acct_child_expense",
      parentAccountId: "acct_parent_expense",
      parentAccountNumber: "6000",
      parentAccountName: "Parent Expense",
      parentAccountClassification: "expense"
    });
    expect(presentation.rows.find((row) => row.rowId === "line:account:acct_child_expense")?.label).toBe("6100 Child Expense");
    expect(presentation.rows.find((row) => row.rowId === "line:account:acct_parent_expense")?.label).toBe("6000 Parent Expense");
    expect(rowCell(presentation, "line:account:acct_parent_expense", "actual:customer:party_customer_acme")?.amount).toBe("75.00");
    expect(rowCell(presentation, "line:account:acct_child_expense", "actual:customer:party_customer_acme")?.amount).toBe("75.00");
    expect(snapshotLineByAccountId(presentation.primaryReport.lines, "acct_child_expense").parentReportLineId).toBe(
      `${presentation.primaryReport.snapshot.reportSnapshotId}:line:account:acct_parent_expense`
    );
    expect(client.calls.some((call) => call.sql.includes('"ledger_postings"'))).toBe(false);
  });
});

class RollupPresentationClient implements PostgresQueryClient {
  readonly calls: QueryCall[] = [];

  constructor(
    private readonly aggregateRows: readonly Record<string, unknown>[],
    private readonly accountRows: readonly Record<string, unknown>[] = []
  ) {}

  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = []
  ): Promise<PostgresQueryResult<Row>> {
    this.calls.push({ sql, params });

    if (sql.includes('"ledger_postings"')) {
      throw new Error("raw ledger postings must not be queried for standard presentation");
    }

    if (sql.includes('from "erp_financials"."rollup_buckets"')) {
      return Promise.resolve({
        rows: this.aggregateRows as readonly Row[],
        rowCount: this.aggregateRows.length
      });
    }

    if (sql.includes('with recursive "relevant_accounts"')) {
      const rows =
        this.accountRows.length === 0
          ? rollupPresentationRowsToAccountRows(this.aggregateRows, stringParam(params[0]), stringParam(params[1]))
          : this.accountRows;
      return Promise.resolve({
        rows: rows as readonly Row[],
        rowCount: rows.length
      });
    }

    if (sql.includes('from "erp_financials"."report_snapshots"')) {
      return Promise.resolve({
        rows: [],
        rowCount: 0
      });
    }

    return Promise.resolve({
      rows: [],
      rowCount: null
    });
  }
}

function rollupPresentationRow(
  groupKey: string,
  groupLabel: string,
  accountId: string,
  accountNumber: string,
  accountName: string,
  accountClassification: string,
  debitAmount: string,
  creditAmount: string,
  netAmount: string,
  options: {
    readonly parentAccountId?: string;
    readonly parentAccountNumber?: string;
    readonly parentAccountName?: string;
    readonly parentAccountClassification?: string;
  } = {}
): Record<string, unknown> {
  return {
    group_key: groupKey,
    group_label: groupLabel,
    account_id: accountId,
    parent_account_id: options.parentAccountId ?? null,
    account_number: accountNumber,
    account_name: accountName,
    account_classification: accountClassification,
    parent_account_number: options.parentAccountNumber ?? null,
    parent_account_name: options.parentAccountName ?? null,
    parent_account_classification: options.parentAccountClassification ?? null,
    debit_amount: debitAmount,
    credit_amount: creditAmount,
    net_amount: netAmount,
    posting_count: 1,
    generated_at: "2026-02-01T00:00:00.000Z",
    source_posting_max_updated_at: null,
    import_batch_id: null
  };
}

function rollupPresentationAccountRow(
  request: StandardReportPresentationReadModelRequest,
  accountId: string,
  accountNumber: string | null,
  name: string,
  classification: string,
  parentAccountId?: string
): Record<string, unknown> {
  return {
    account_id: accountId,
    tenant_id: request.tenantId,
    source_id: request.sourceId,
    source_account_id: accountId,
    account_number: accountNumber,
    name,
    type: classification,
    subtype: null,
    classification,
    parent_account_id: parentAccountId ?? null,
    currency_code: request.currencyCode,
    active: true
  };
}

function rollupSourceRefId(
  request: StandardReportPresentationReadModelRequest,
  groupKey: string,
  accountId: string
): string {
  return [
    request.reportName,
    request.accountingMethod ?? "accrual",
    request.periodStart,
    request.periodEnd,
    request.currencyCode,
    groupKey,
    accountId
  ].join(":");
}

function rollupPresentationRowsToAccountRows(
  rows: readonly Record<string, unknown>[],
  tenantId: string,
  sourceId: string
): readonly Record<string, unknown>[] {
  const byAccountId = new Map<string, Record<string, unknown>>();

  for (const row of rows) {
    const accountId = stringField(row, "account_id");
    const accountNumber = nullableStringField(row, "account_number");
    const parentAccountId = nullableStringField(row, "parent_account_id");
    byAccountId.set(
      accountId,
      rollupPresentationDerivedAccountRow({
        tenantId,
        sourceId,
        accountId,
        name: stringField(row, "account_name"),
        classification: stringField(row, "account_classification"),
        ...(accountNumber === undefined ? {} : { accountNumber }),
        ...(parentAccountId === undefined ? {} : { parentAccountId })
      })
    );

    const parentAccountName = nullableStringField(row, "parent_account_name");
    const parentAccountClassification = nullableStringField(row, "parent_account_classification");
    if (parentAccountId !== undefined && parentAccountName !== undefined && parentAccountClassification !== undefined) {
      const parentAccountNumber = nullableStringField(row, "parent_account_number");
      byAccountId.set(
        parentAccountId,
        rollupPresentationDerivedAccountRow({
          tenantId,
          sourceId,
          accountId: parentAccountId,
          name: parentAccountName,
          classification: parentAccountClassification,
          ...(parentAccountNumber === undefined ? {} : { accountNumber: parentAccountNumber })
        })
      );
    }
  }

  return [...byAccountId.values()];
}

function rollupPresentationDerivedAccountRow(input: {
  readonly tenantId: string;
  readonly sourceId: string;
  readonly accountId: string;
  readonly accountNumber?: string;
  readonly name: string;
  readonly classification: string;
  readonly parentAccountId?: string;
}): Record<string, unknown> {
  return {
    account_id: input.accountId,
    tenant_id: input.tenantId,
    source_id: input.sourceId,
    source_account_id: input.accountId,
    account_number: input.accountNumber ?? null,
    name: input.name,
    type: input.classification,
    subtype: null,
    classification: input.classification,
    parent_account_id: input.parentAccountId ?? null,
    currency_code: "USD",
    active: true
  };
}

function stringField(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`expected ${key} to be a string`);
  }
  return value;
}

function nullableStringField(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

type SnapshotBundle = {
  readonly snapshot: Record<string, unknown>;
  readonly lines: readonly Record<string, unknown>[];
  readonly totals: readonly Record<string, unknown>[];
};

type DateGrainSnapshotPeriod = {
  readonly periodStart: IsoDate;
  readonly periodEnd: IsoDate;
};

function nestedHierarchyReport(): BuiltReport {
  const tenantId = "tenant_storage_nested";
  const companyId = "company_storage_nested";
  const sourceId = "source_storage_nested";
  const reportSnapshotId = `snapshot:${tenantId}:${companyId}:${sourceId}:profit_and_loss:nested`;
  const periodStart = "2026-01-01";
  const periodEnd = "2026-01-31";
  const lines = buildAccountHierarchyRollupLines({
    tenantId,
    sourceId,
    reportSnapshotId,
    reportName: "profit_and_loss",
    accounts: nestedStorageAccounts(tenantId, sourceId),
    accountAmounts: [
      nestedStorageAmount("acct_storage_parent", "10.00", "post_storage_parent"),
      nestedStorageAmount("acct_storage_child", "20.00", "post_storage_child"),
      nestedStorageAmount("acct_storage_grandchild", "30.00", "post_storage_grandchild")
    ],
    drilldownQuery: {
      sourceId,
      accountingBasis: "accrual",
      periodStart,
      periodEnd
    }
  });

  return {
    snapshot: {
      reportSnapshotId,
      tenantId,
      companyId,
      sourceId,
      reportName: "profit_and_loss",
      snapshotSource: "builder",
      accountingBasis: "accrual",
      periodStart,
      periodEnd,
      asOfDate: periodEnd,
      currencyCode: "USD",
      generatedAt: "2026-02-01T00:00:00.000Z",
      freshness: { status: "fresh", sourceId },
      reconciliationStatus: "not_reconciled",
      reconciliationDifference: "0.00"
    },
    lines,
    totals: [],
    metadata: {
      reportName: "profit_and_loss",
      generatedFrom: "ledger_postings",
      reconciliationStatus: "not_reconciled",
      reconciliationDifference: "0.00"
    }
  };
}

function flatGrandchildReport(report: BuiltReport): BuiltReport {
  const grandchildLine = snapshotLineByAccountId(report.lines, "acct_storage_grandchild");
  const { parentReportLineId, ...flatGrandchildLine } = grandchildLine;
  void parentReportLineId;

  return {
    ...report,
    lines: [
      {
        ...flatGrandchildLine,
        sortOrder: 10
      }
    ],
    totals: []
  };
}

function nestedStorageAccounts(tenantId: string, sourceId: string): readonly Account[] {
  return [
    nestedStorageAccount(tenantId, sourceId, "acct_storage_parent", "6000", "Storage Parent"),
    nestedStorageAccount(tenantId, sourceId, "acct_storage_child", "6100", "Storage Child", "acct_storage_parent"),
    nestedStorageAccount(
      tenantId,
      sourceId,
      "acct_storage_grandchild",
      "6110",
      "Storage Grandchild",
      "acct_storage_child"
    )
  ];
}

function nestedStorageAccount(
  tenantId: string,
  sourceId: string,
  accountId: string,
  accountNumber: string,
  name: string,
  parentAccountId?: string
): Account {
  return {
    tenantId,
    sourceId,
    accountId,
    sourceAccountId: accountId.replace("acct_", ""),
    accountNumber,
    name,
    type: "Expense",
    subtype: "Expense",
    classification: "expense",
    ...(parentAccountId === undefined ? {} : { parentAccountId }),
    active: true
  };
}

function nestedStorageAmount(
  accountId: string,
  amount: string,
  postingId: string
): AccountHierarchyRollupLineAmount {
  return {
    accountId,
    amount,
    section: "expense",
    postingIds: [postingId],
    sourceRefs: [
      {
        sourceObjectType: "LedgerPosting",
        sourceObjectId: postingId
      }
    ]
  };
}

function parentLineParamsByReportLineId(params: readonly unknown[]): Record<string, unknown> {
  const columnsPerReportSnapshotLine = 12;
  const byReportLineId: Record<string, unknown> = {};

  for (let index = 0; index < params.length; index += columnsPerReportSnapshotLine) {
    const reportLineId = params[index];
    if (typeof reportLineId === "string") {
      byReportLineId[reportLineId] = params[index + 5];
    }
  }

  return byReportLineId;
}

function nestedStoredSnapshotLines(
  request: StandardReportPresentationReadModelRequest,
  reportSnapshotId: string
): readonly Record<string, unknown>[] {
  return [
    nestedStoredSnapshotLine(request, reportSnapshotId, "acct_storage_parent", null, 10),
    nestedStoredSnapshotLine(
      request,
      reportSnapshotId,
      "acct_storage_child",
      `${reportSnapshotId}:line:account:acct_storage_parent`,
      20
    ),
    nestedStoredSnapshotLine(
      request,
      reportSnapshotId,
      "acct_storage_grandchild",
      `${reportSnapshotId}:line:account:acct_storage_child`,
      30
    )
  ];
}

function nestedStoredSnapshotLine(
  request: StandardReportPresentationReadModelRequest,
  reportSnapshotId: string,
  accountId: string,
  parentReportLineId: string | null,
  sortOrder: number
): Record<string, unknown> {
  const reportLineId = `${reportSnapshotId}:line:account:${accountId}`;

  return {
    report_line_id: reportLineId,
    tenant_id: request.tenantId,
    report_snapshot_id: reportSnapshotId,
    parent_report_line_id: parentReportLineId,
    section: "expense",
    label: accountId,
    account_id: accountId,
    amount: "10.00",
    sort_order: sortOrder,
    drilldown_ref: drilldownRef(request, request.periodStart, request.periodEnd, accountId, reportLineId)
  };
}

function snapshotLineByAccountId(lines: readonly ReportSnapshotLine[], accountId: string): ReportSnapshotLine {
  const line = lines.find((entry) => entry.accountId === accountId);
  if (line === undefined) {
    throw new Error(`missing loaded snapshot line for ${accountId}`);
  }

  return line;
}

function snapshotTotalByKey(totals: readonly ReportSnapshotTotal[], totalKey: string): ReportSnapshotTotal {
  const total = totals.find((entry) => entry.totalKey === totalKey);
  if (total === undefined) {
    throw new Error(`missing loaded snapshot total for ${totalKey}`);
  }

  return total;
}

class SnapshotPresentationClient implements PostgresQueryClient {
  readonly calls: QueryCall[] = [];
  private readonly snapshotsByKey: ReadonlyMap<string, SnapshotBundle>;

  constructor(snapshots: readonly SnapshotBundle[]) {
    this.snapshotsByKey = new Map(snapshots.map((snapshot) => [snapshotKeyFromRow(snapshot.snapshot), snapshot]));
  }

  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = []
  ): Promise<PostgresQueryResult<Row>> {
    this.calls.push({ sql, params });

    if (sql.includes('"ledger_postings"')) {
      throw new Error("raw ledger postings must not be queried for standard presentation");
    }

    if (sql.includes('from "erp_financials"."report_snapshots"')) {
      const snapshot = this.snapshotsByKey.get(snapshotKeyFromParams(params));
      return Promise.resolve({
        rows: snapshot === undefined ? [] : [snapshot.snapshot as Row],
        rowCount: snapshot === undefined ? 0 : 1
      });
    }

    if (sql.includes('from "erp_financials"."report_snapshot_lines"')) {
      const snapshot = this.snapshotById(stringParam(params[3]));
      return Promise.resolve({
        rows: (snapshot?.lines ?? []) as readonly Row[],
        rowCount: snapshot?.lines.length ?? 0
      });
    }

    if (sql.includes('from "erp_financials"."report_snapshot_totals"')) {
      const snapshot = this.snapshotById(stringParam(params[3]));
      return Promise.resolve({
        rows: (snapshot?.totals ?? []) as readonly Row[],
        rowCount: snapshot?.totals.length ?? 0
      });
    }

    return Promise.resolve({
      rows: [],
      rowCount: null
    });
  }

  private snapshotById(reportSnapshotId: string): SnapshotBundle | undefined {
    return [...this.snapshotsByKey.values()].find((snapshot) => snapshot.snapshot.report_snapshot_id === reportSnapshotId);
  }
}

function standardStatementSnapshot(
  request: StandardReportPresentationReadModelRequest,
  fixture: {
    readonly section: string;
    readonly accountId: string;
    readonly lineLabel: string;
    readonly lineAmount: string;
    readonly totalKey: string;
    readonly totalLabel: string;
    readonly totalAmount: string;
  }
): SnapshotBundle {
  const reportSnapshotId = [
    "snapshot",
    request.tenantId,
    request.companyId,
    request.sourceId,
    request.reportName,
    request.accountingMethod ?? "accrual",
    request.periodStart,
    request.periodEnd
  ].join(":");
  const reportLineId = `${reportSnapshotId}:line:account:${fixture.accountId}`;

  return {
    snapshot: {
      report_snapshot_id: reportSnapshotId,
      tenant_id: request.tenantId,
      company_id: request.companyId,
      source_id: request.sourceId,
      report_name: request.reportName,
      snapshot_source: "rollup",
      accounting_basis: request.accountingMethod ?? "accrual",
      period_start: request.periodStart,
      period_end: request.periodEnd,
      as_of_date: request.asOfDate ?? request.periodEnd,
      currency_code: request.currencyCode,
      generated_at: `${request.periodEnd}T12:00:00.000Z`,
      freshness: { status: "fresh", sourceId: request.sourceId },
      reconciliation_status: "balanced",
      reconciliation_difference: "0.00"
    },
    lines: [{
      report_line_id: reportLineId,
      tenant_id: request.tenantId,
      report_snapshot_id: reportSnapshotId,
      parent_report_line_id: null,
      section: fixture.section,
      label: fixture.lineLabel,
      account_id: fixture.accountId,
      amount: fixture.lineAmount,
      sort_order: 10,
      drilldown_ref: drilldownRef(
        request,
        request.periodStart,
        request.periodEnd,
        fixture.accountId,
        `${request.reportName}:${fixture.accountId}`
      )
    }],
    totals: [
      totalRow(
        request,
        reportSnapshotId,
        request.periodStart,
        request.periodEnd,
        fixture.totalKey,
        fixture.totalLabel,
        fixture.totalAmount
      )
    ]
  };
}

function monthlyProfitAndLossSnapshots(request: StandardReportPresentationReadModelRequest): readonly SnapshotBundle[] {
  const snapshots: SnapshotBundle[] = [];
  let cursor = parseIsoDate(request.periodStart);
  const end = parseIsoDate(request.periodEnd);
  let monthNumber = 1;

  while (cursor.getTime() <= end.getTime()) {
    const periodStart = formatIsoDate(cursor);
    const periodEnd = formatIsoDate(new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0)));
    snapshots.push(profitAndLossSnapshot(request, periodStart, periodEnd, monthNumber));
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
    monthNumber += 1;
  }

  return snapshots;
}

function nestedDateGrainProfitAndLossSnapshots(
  request: StandardReportPresentationReadModelRequest,
  periods: readonly DateGrainSnapshotPeriod[]
): readonly SnapshotBundle[] {
  return periods.map((period, index) =>
    nestedDateGrainProfitAndLossSnapshot(request, period.periodStart, period.periodEnd, index + 1)
  );
}

function nestedDateGrainProfitAndLossSnapshot(
  request: StandardReportPresentationReadModelRequest,
  periodStart: IsoDate,
  periodEnd: IsoDate,
  multiplier: number
): SnapshotBundle {
  const reportSnapshotId = `snapshot:${request.tenantId}:${request.companyId}:${request.sourceId}:profit_and_loss:nested:${periodStart}:${periodEnd}`;
  const incomeAmount = money(100 * multiplier);
  const parentExpenseAmount = money(60 * multiplier);
  const childExpenseAmount = money(50 * multiplier);
  const grandchildExpenseAmount = money(30 * multiplier);
  const netIncomeAmount = money(40 * multiplier);
  const generatedAt = `${periodEnd}T12:00:00.000Z`;

  return {
    snapshot: {
      report_snapshot_id: reportSnapshotId,
      tenant_id: request.tenantId,
      company_id: request.companyId,
      source_id: request.sourceId,
      report_name: request.reportName,
      snapshot_source: "rollup",
      accounting_basis: request.accountingMethod,
      period_start: periodStart,
      period_end: periodEnd,
      as_of_date: periodEnd,
      currency_code: request.currencyCode,
      generated_at: generatedAt,
      freshness: { status: "fresh", sourceId: request.sourceId },
      reconciliation_status: "not_reconciled",
      reconciliation_difference: "0.00"
    },
    lines: [
      nestedDateGrainSnapshotLine(
        request,
        reportSnapshotId,
        periodStart,
        periodEnd,
        "acct_snapshot_income",
        "4000 Snapshot Income",
        "income",
        incomeAmount,
        10
      ),
      nestedDateGrainSnapshotLine(
        request,
        reportSnapshotId,
        periodStart,
        periodEnd,
        "acct_snapshot_expense_parent",
        "6000 Snapshot Expense Parent",
        "expense",
        parentExpenseAmount,
        20
      ),
      nestedDateGrainSnapshotLine(
        request,
        reportSnapshotId,
        periodStart,
        periodEnd,
        "acct_snapshot_expense_child",
        "6100 Snapshot Expense Child",
        "expense",
        childExpenseAmount,
        30,
        "acct_snapshot_expense_parent"
      ),
      nestedDateGrainSnapshotLine(
        request,
        reportSnapshotId,
        periodStart,
        periodEnd,
        "acct_snapshot_expense_grandchild",
        "6110 Snapshot Expense Grandchild",
        "expense",
        grandchildExpenseAmount,
        40,
        "acct_snapshot_expense_child"
      )
    ],
    totals: [
      totalRow(request, reportSnapshotId, periodStart, periodEnd, "total_income", "Total Income", incomeAmount, {
        accountIds: ["acct_snapshot_income"],
        postingIds: [`post_total_income_${periodStart}`],
        sourceObjectIds: [`rollup:total_income:${periodStart}`]
      }),
      totalRow(request, reportSnapshotId, periodStart, periodEnd, "total_expenses", "Total Expenses", parentExpenseAmount, {
        accountIds: ["acct_snapshot_expense_parent", "acct_snapshot_expense_child", "acct_snapshot_expense_grandchild"],
        postingIds: [`post_total_expenses_${periodStart}`],
        sourceObjectIds: [`rollup:total_expenses:${periodStart}`]
      }),
      totalRow(request, reportSnapshotId, periodStart, periodEnd, "net_income", "Net Income", netIncomeAmount, {
        accountIds: [
          "acct_snapshot_income",
          "acct_snapshot_expense_parent",
          "acct_snapshot_expense_child",
          "acct_snapshot_expense_grandchild"
        ],
        postingIds: [`post_net_income_${periodStart}`],
        sourceObjectIds: [`rollup:net_income:${periodStart}`]
      })
    ]
  };
}

function nestedDateGrainSnapshotLine(
  request: StandardReportPresentationReadModelRequest,
  reportSnapshotId: string,
  periodStart: IsoDate,
  periodEnd: IsoDate,
  accountId: string,
  label: string,
  section: string,
  amount: string,
  sortOrder: number,
  parentAccountId?: string
): Record<string, unknown> {
  const reportLineId = `${reportSnapshotId}:line:account:${accountId}`;
  const parentReportLineId =
    parentAccountId === undefined ? null : `${reportSnapshotId}:line:account:${parentAccountId}`;

  return {
    report_line_id: reportLineId,
    tenant_id: request.tenantId,
    report_snapshot_id: reportSnapshotId,
    parent_report_line_id: parentReportLineId,
    section,
    label,
    account_id: accountId,
    amount,
    sort_order: sortOrder,
    drilldown_ref: drilldownRef(request, periodStart, periodEnd, accountId, reportLineId)
  };
}

function profitAndLossSnapshot(
  request: StandardReportPresentationReadModelRequest,
  periodStart: IsoDate,
  periodEnd: IsoDate,
  monthNumber: number
): SnapshotBundle {
  const reportSnapshotId = `snapshot:${request.tenantId}:${request.companyId}:${request.sourceId}:profit_and_loss:${periodStart}:${periodEnd}`;
  const income = money(monthNumber * 200);
  const expense = money(monthNumber * 100);
  const netIncome = money(monthNumber * 100);
  const generatedAt = `${periodEnd}T12:00:00.000Z`;

  return {
    snapshot: {
      report_snapshot_id: reportSnapshotId,
      tenant_id: request.tenantId,
      company_id: request.companyId,
      source_id: request.sourceId,
      report_name: request.reportName,
      snapshot_source: "rollup",
      accounting_basis: request.accountingMethod,
      period_start: periodStart,
      period_end: periodEnd,
      as_of_date: periodEnd,
      currency_code: request.currencyCode,
      generated_at: generatedAt,
      freshness: { status: "fresh", sourceId: request.sourceId },
      reconciliation_status: "not_reconciled",
      reconciliation_difference: "0.00"
    },
    lines: [
      {
        report_line_id: `${reportSnapshotId}:line:001:acct_sales`,
        tenant_id: request.tenantId,
        report_snapshot_id: reportSnapshotId,
        parent_report_line_id: null,
        section: "income",
        label: "4000 Sales",
        account_id: "acct_sales",
        amount: income,
        sort_order: 10,
        drilldown_ref: drilldownRef(request, periodStart, periodEnd, "acct_sales", "profit_and_loss:acct_sales")
      },
      {
        report_line_id: `${reportSnapshotId}:line:002:acct_expense`,
        tenant_id: request.tenantId,
        report_snapshot_id: reportSnapshotId,
        parent_report_line_id: null,
        section: "expense",
        label: "6000 Expense",
        account_id: "acct_expense",
        amount: expense,
        sort_order: 20,
        drilldown_ref: drilldownRef(request, periodStart, periodEnd, "acct_expense", "profit_and_loss:acct_expense")
      }
    ],
    totals: [
      totalRow(request, reportSnapshotId, periodStart, periodEnd, "total_income", "Total Income", income),
      totalRow(request, reportSnapshotId, periodStart, periodEnd, "total_expenses", "Total Expenses", expense),
      totalRow(request, reportSnapshotId, periodStart, periodEnd, "net_income", "Net Income", netIncome)
    ]
  };
}

function totalRow(
  request: StandardReportPresentationReadModelRequest,
  reportSnapshotId: string,
  periodStart: IsoDate,
  periodEnd: IsoDate,
  totalKey: string,
  label: string,
  amount: string,
  drilldownScope?: {
    readonly accountIds?: readonly string[];
    readonly postingIds?: readonly string[];
    readonly sourceObjectIds?: readonly string[];
  }
): Record<string, unknown> {
  return {
    report_total_id: `${reportSnapshotId}:total:${totalKey}`,
    tenant_id: request.tenantId,
    report_snapshot_id: reportSnapshotId,
    total_key: totalKey,
    label,
    amount,
    drilldown_ref:
      drilldownScope === undefined
        ? drilldownRef(request, periodStart, periodEnd, undefined, `${request.reportName}:${totalKey}`)
        : createCompactDrilldownRef({
            token: `${request.reportName}:${totalKey}`,
            postingIds: drilldownScope.postingIds ?? [],
            ...(drilldownScope.accountIds === undefined ? {} : { accountIds: drilldownScope.accountIds }),
            query: {
              kind: "ledger_postings",
              tenantId: request.tenantId,
              sourceId: request.sourceId,
              accountingBasis: request.accountingMethod ?? "accrual",
              periodStart,
              periodEnd,
              ...(drilldownScope.accountIds === undefined ? {} : { accountIds: drilldownScope.accountIds })
            },
            sourceRefs: (drilldownScope.sourceObjectIds ?? []).map((sourceObjectId) => ({
              sourceObjectType: "RollupBucketAggregate",
              sourceObjectId,
              preview: {
                totalKey,
                periodStart,
                periodEnd
              }
            }))
          })
  };
}

function drilldownRef(
  request: StandardReportPresentationReadModelRequest,
  periodStart: IsoDate,
  periodEnd: IsoDate,
  accountId: string | undefined,
  token: string
): ReturnType<typeof createCompactDrilldownRef> {
  const accountingBasis = request.accountingMethod ?? "accrual";

  return createCompactDrilldownRef({
    token,
    postingIds: [],
    ...(accountId === undefined ? {} : { accountIds: [accountId] }),
    query: {
      kind: "ledger_postings",
      tenantId: request.tenantId,
      sourceId: request.sourceId,
      accountingBasis,
      periodStart,
      periodEnd,
      ...(accountId === undefined ? {} : { accountIds: [accountId] })
    }
  });
}

function snapshotKeyFromParams(params: readonly unknown[]): string {
  return [
    params[0],
    params[1],
    params[2],
    params[3],
    params[4],
    params[5],
    params[6],
    params[7] ?? params[6],
    params[8]
  ].join("|");
}

function stringParam(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function snapshotKeyFromRow(row: Record<string, unknown>): string {
  return [
    row.tenant_id,
    row.company_id,
    row.source_id,
    row.report_name,
    row.accounting_basis,
    row.period_start,
    row.period_end,
    row.as_of_date,
    row.currency_code
  ].join("|");
}

function rowCell(
  presentation: StandardReportPresentation,
  rowId: string,
  columnId: string
): { readonly amount?: string; readonly percent?: string } | undefined {
  return presentation.rows.find((row) => row.rowId === rowId)?.cells.find((cell) => cell.columnId === columnId);
}

function parseIsoDate(value: IsoDate): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null || match[1] === undefined || match[2] === undefined || match[3] === undefined) {
    throw new Error(`Invalid ISO date: ${value}`);
  }

  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function formatIsoDate(date: Date): IsoDate {
  return date.toISOString().slice(0, 10);
}

function money(amount: number): string {
  return `${amount.toString()}.00`;
}

class RecordingClient implements PostgresQueryClient {
  readonly calls: QueryCall[] = [];

  constructor(private readonly catalogRows: readonly CatalogRow[] = []) {}

  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = []
  ): Promise<PostgresQueryResult<Row>> {
    this.calls.push({ sql, params });

    if (sql.includes("information_schema.schemata")) {
      return Promise.resolve({
        rows: this.catalogRows as unknown as readonly Row[],
        rowCount: this.catalogRows.length
      });
    }

    return Promise.resolve({
      rows: [],
      rowCount: null
    });
  }
}

function catalogRowsForManifest(manifest: PostgresSchemaManifest): readonly CatalogRow[] {
  return [
    {
      object_type: "schema",
      table_name: null,
      object_name: manifest.namespace
    },
    ...manifest.tables.flatMap((table) => [
      {
        object_type: "table" as const,
        table_name: table.name,
        object_name: table.name
      },
      ...table.columns.map((column) => ({
        object_type: "column" as const,
        table_name: table.name,
        object_name: column.name,
        data_type: column.type,
        is_nullable: column.nullable === true ? "YES" : "NO"
      })),
      ...table.indexes.map((index) => ({
        object_type: "index" as const,
        table_name: table.name,
        object_name: index.name,
        definition: `create ${index.unique === true ? "unique " : ""}index ${index.name} on ${manifest.namespace}.${table.name} using btree (${index.columns.join(", ")})${index.whereSql === undefined ? "" : ` where ${index.whereSql}`}`
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
        object_name: constraintName,
        definition: table.constraints.find((constraint) => constraint.name === constraintName)?.sql ?? null
      }))
    ]),
    ...manifest.requiredTriggers.map((trigger) => ({
      object_type: "trigger" as const,
      table_name: trigger.table,
      object_name: trigger.name,
      enabled: true,
      definition: `create trigger ${trigger.name} ${trigger.timing} ${trigger.events
        .map((event) => event === "update" && trigger.updateColumns !== undefined
          ? `update of ${trigger.updateColumns.join(", ")}`
          : event)
        .join(" or ")} on ${manifest.namespace}.${trigger.table} for each row execute function ${manifest.namespace}.${trigger.functionName}()`
    }))
  ];
}
