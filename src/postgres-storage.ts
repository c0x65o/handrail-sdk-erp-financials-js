import type { CanonicalAccountingFactSet } from "./source-adapters.js";
import { prepareCustomerPaymentCorrectionImport, loadCustomerPaymentCorrectionReplayState, correctedTransactionIds, type CustomerPaymentCorrectionDependency, type CustomerPaymentCorrectionImportPlan } from "./customer-payment-correction-replay.js";
import type {
  Account,
  AccountingBasis,
  AccountingCompany,
  AccountingDimension,
  AccountingSource,
  CompanySourceBinding,
  AccountingTransaction,
  DecimalString,
  ImportBatch,
  ImportBatchId,
  IsoCurrencyCode,
  IsoDate,
  IsoDateTime,
  Item,
  JsonValue,
  LedgerPosting,
  Party,
  PartyType,
  ReportFreshness,
  ReportFreshnessStatus,
  ReportSnapshot,
  ReportSnapshotSource,
  DrilldownRef,
  ReportSnapshotLine,
  ReportSnapshotTotal,
  SafeSourcePayloadRef,
  SourceId,
  SyncCheckpoint,
  TenantId,
  TransactionLine
} from "./canonical-model.js";
import {
  assertLedgerPostingAmounts,
  assertNoCredentialKeys,
  assertSafeDrilldownRef,
  assertSafeSourcePayloadRef,
  createCompanySourceBinding,
  createCompactDrilldownRef
} from "./canonical-model.js";
import { assertValidAccountHierarchy } from "./account-hierarchy.js";
import { persistQuickBooksSubledgerResources } from "./quickbooks-subledger-import.js";
import type {
  PersistQuickBooksSubledgerResourcesInput,
  QuickBooksSubledgerImportResult
} from "./quickbooks-subledger-import.js";
import type {
  QuickBooksDualBasisBackfillPersistence,
  QuickBooksBasisBackfillProjection
} from "./quickbooks-dual-basis-backfill.js";
import {
  assertPaymentApplication,
  assertPostingRule,
  assertTransactionMatchCandidate,
  assertTransactionMatchDecision
} from "./transaction-matching.js";
import type {
  PaymentApplication,
  PostingRule,
  TransactionMatchCandidate,
  TransactionMatchDecision
} from "./transaction-matching.js";
import { buildAccountHierarchyRollupLines } from "./account-hierarchy-rollup-lines.js";
import type { BuiltReport, ReportBuilderInput, ReportName } from "./report-builders.js";
import type { AccountHierarchyRollupLineAmount } from "./account-hierarchy-rollup-lines.js";
import { type StatementFixtureSet } from "./fixtures.js";
import {
  DISALLOWED_CREDENTIAL_COLUMN_PATTERNS,
  POSTGRES_CANONICAL_SCHEMA_MANIFEST,
  assertManifestHasNoCredentialColumns,
  renderPostgresSchemaSql
} from "./schema-manifest.js";
import type {
  PostgresSchemaManifest,
  PostgresTableManifest,
  PostgresTriggerManifest
} from "./schema-manifest.js";
import type {
  StandardReportAccountingMethod,
  StandardReportDisplayColumnsBy,
  StandardReportPresentationColumn,
  StandardReportPresentationReadModelRequest,
  StandardReportPresentationReadModelStorage,
  StandardReportPresentationReportColumn,
  StandardReportPresentationReportSet
} from "./report-controls.js";
import { resetSourceImportState } from "./source-import-reset.js";
import type {
  ResetSourceImportStateInput,
  SanitizedSourceResetCounts
} from "./source-import-reset.js";

export type PostgresQueryResult<Row extends Record<string, unknown> = Record<string, unknown>> = {
  readonly rows: readonly Row[];
  readonly rowCount?: number | null;
};

export type PostgresQueryClient = {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[]
  ): Promise<PostgresQueryResult<Row>>;
};

export type PostgresTransactionRunner = {
  transaction<Result>(work: (client: PostgresQueryClient) => Promise<Result>): Promise<Result>;
};

export type InstallPostgresSchemaOptions = {
  readonly dryRun?: boolean;
};

export type InstallPostgresSchemaResult = {
  readonly manifestVersion: PostgresSchemaManifest["manifestVersion"];
  readonly schemaVersion: PostgresSchemaManifest["schemaVersion"];
  readonly statements: readonly string[];
  readonly executed: boolean;
};

export type PostgresSchemaValidationIssueKind =
  | "missing_schema"
  | "missing_table"
  | "missing_column"
  | "incompatible_column_type"
  | "incompatible_column_nullability"
  | "incompatible_index_definition"
  | "incompatible_constraint_definition"
  | "incompatible_trigger_definition"
  | "missing_index"
  | "missing_constraint"
  | "missing_trigger"
  | "credential_column"
  | "missing_fixture_support";

export type PostgresSchemaValidationIssue = {
  readonly kind: PostgresSchemaValidationIssueKind;
  readonly table?: string;
  readonly objectName: string;
  readonly message: string;
};

export type PostgresSchemaValidationResult = {
  readonly manifestVersion: PostgresSchemaManifest["manifestVersion"];
  readonly schemaVersion: PostgresSchemaManifest["schemaVersion"];
  readonly compatible: boolean;
  readonly fixtureSupport: boolean;
  readonly issues: readonly PostgresSchemaValidationIssue[];
};

export type RollupBucketGrain = "day" | "month" | "fiscal_period" | "fiscal_quarter" | "fiscal_year";

export type RollupBucket = {
  readonly rollupBucketId: string;
  readonly tenantId: TenantId;
  readonly companyId: string;
  readonly sourceId: SourceId;
  readonly accountId: string;
  readonly accountingBasis: AccountingBasis;
  readonly bucketGrain: RollupBucketGrain;
  readonly bucketStart: IsoDate;
  readonly bucketEnd: IsoDate;
  readonly currencyCode: IsoCurrencyCode;
  readonly dimensionHash: string;
  readonly partyId?: string;
  readonly partyType?: PartyType;
  readonly itemId?: string;
  readonly debitAmount: DecimalString;
  readonly creditAmount: DecimalString;
  readonly netAmount: DecimalString;
  readonly postingCount: number;
  readonly sourcePostingMaxUpdatedAt?: IsoDateTime;
  readonly importBatchId?: string;
  readonly generatedAt: IsoDateTime;
};

export type RollupReprocessWindow = {
  readonly tenantId: TenantId;
  readonly companyId: string;
  readonly sourceId: SourceId;
  readonly accountingBasis: AccountingBasis;
  readonly bucketGrain: RollupBucketGrain;
  readonly bucketStart: IsoDate;
  readonly bucketEnd: IsoDate;
  readonly currencyCode: IsoCurrencyCode;
};

export type ReplaceRollupBucketsForWindowsInput = {
  readonly windows: readonly RollupReprocessWindow[];
  readonly buckets: readonly RollupBucket[];
};

export type ReplaceRollupBucketsForWindowsResult = {
  readonly deleted: number;
  readonly upserted: number;
};

export type ReportFreshnessRow = {
  readonly freshnessId: string;
  readonly tenantId: TenantId;
  readonly companyId: string;
  readonly sourceId: SourceId;
  readonly reportName: string;
  readonly accountingBasis: AccountingBasis;
  readonly periodStart: IsoDate;
  readonly periodEnd: IsoDate;
  readonly currencyCode: IsoCurrencyCode;
  readonly status: ReportFreshnessStatus;
  readonly freshThrough?: IsoDateTime;
  readonly staleReason?: string;
  readonly importBatchId?: string;
  readonly checkpointId?: string;
  readonly updatedAt: IsoDateTime;
};

export type LoadReportBuilderInput = {
  readonly tenantId: TenantId;
  readonly companyId: string;
  readonly sourceId: SourceId;
  readonly reportName: ReportName;
  readonly accountingBasis: AccountingBasis;
  readonly periodStart: IsoDate;
  readonly periodEnd: IsoDate;
  readonly asOfDate?: IsoDate;
  readonly currencyCode: IsoCurrencyCode;
  readonly generatedAt?: IsoDateTime;
};

export type LoadAccountsInput = {
  readonly tenantId: TenantId;
  readonly sourceId: SourceId;
  readonly accountIds?: readonly string[];
};

export type StoredReportSnapshot = {
  readonly snapshot: ReportSnapshot;
  readonly lines: readonly ReportSnapshotLine[];
  readonly totals: readonly ReportSnapshotTotal[];
};

export type LoadReportSnapshotInput = {
  readonly tenantId: TenantId;
  readonly companyId: string;
  readonly sourceId: SourceId;
  readonly reportName: ReportName;
  readonly accountingBasis: AccountingBasis;
  readonly periodStart: IsoDate;
  readonly periodEnd: IsoDate;
  readonly asOfDate?: IsoDate;
  readonly currencyCode: IsoCurrencyCode;
};

export type LoadRollupBucketsInput = {
  readonly tenantId: TenantId;
  readonly companyId: string;
  readonly sourceId: SourceId;
  readonly accountingBasis: AccountingBasis;
  readonly bucketGrain: RollupBucketGrain;
  readonly bucketStart: IsoDate;
  readonly bucketEnd: IsoDate;
  readonly currencyCode: IsoCurrencyCode;
  readonly accountId?: string;
  readonly accountIds?: readonly string[];
  readonly dimensionHash?: string;
  readonly dimensionHashes?: readonly string[];
  readonly partyType?: PartyType;
  readonly partyTypes?: readonly PartyType[];
  readonly partyId?: string;
  readonly partyIds?: readonly string[];
  readonly itemId?: string;
  readonly itemIds?: readonly string[];
};

export type FixtureLoadResult = {
  readonly companies: number;
  readonly sources: number;
  readonly importBatches: number;
  readonly checkpoints: number;
  readonly accounts: number;
  readonly parties: number;
  readonly items: number;
  readonly dimensions: number;
  readonly transactions: number;
  readonly transactionLines: number;
  readonly postings: number;
};

export type PostgresStorageAdapter = StandardReportPresentationReadModelStorage & QuickBooksDualBasisBackfillPersistence & {
  readonly manifest: PostgresSchemaManifest;
  installSchema(options?: InstallPostgresSchemaOptions): Promise<InstallPostgresSchemaResult>;
  validateSchema(): Promise<PostgresSchemaValidationResult>;
  upsertAccountingCompany(company: AccountingCompany): Promise<number>;
  upsertAccountingSource(source: AccountingSource): Promise<number>;
  upsertCompanySourceBinding(binding: CompanySourceBinding): Promise<number>;
  upsertImportBatch(importBatch: ImportBatch): Promise<number>;
  upsertSyncCheckpoint(checkpoint: SyncCheckpoint): Promise<number>;
  upsertAccounts(accounts: readonly Account[]): Promise<number>;
  upsertParties(parties: readonly Party[]): Promise<number>;
  upsertItems(items: readonly Item[]): Promise<number>;
  upsertDimensions(dimensions: readonly AccountingDimension[]): Promise<number>;
  prepareCustomerPaymentCorrectionImport(facts: CanonicalAccountingFactSet): Promise<CustomerPaymentCorrectionImportPlan>;
  upsertTransactions(transactions: readonly AccountingTransaction[]): Promise<number>;
  upsertTransactionLines(lines: readonly TransactionLine[]): Promise<number>;
  upsertLedgerPostings(postings: readonly LedgerPosting[]): Promise<number>;
  persistQuickBooksSubledgerResources(
    input: PersistQuickBooksSubledgerResourcesInput
  ): Promise<QuickBooksSubledgerImportResult>;
  upsertPostingRules(rules: readonly PostingRule[]): Promise<number>;
  upsertTransactionMatchCandidates(candidates: readonly TransactionMatchCandidate[]): Promise<number>;
  recordTransactionMatchDecisions(decisions: readonly TransactionMatchDecision[]): Promise<number>;
  upsertPaymentApplications(applications: readonly PaymentApplication[]): Promise<number>;
  deleteLedgerFactsOutsideImportBatch(
    input: DeleteLedgerFactsOutsideImportBatchInput
  ): Promise<DeleteLedgerFactsOutsideImportBatchResult>;
  resetSourceImportState(input: ResetSourceImportStateInput): Promise<SanitizedSourceResetCounts>;
  loadStatementFixture(fixture: StatementFixtureSet): Promise<FixtureLoadResult>;
  writeReportSnapshot(report: BuiltReport): Promise<number>;
  writeRollupBuckets(buckets: readonly RollupBucket[]): Promise<number>;
  replaceRollupBucketsForWindows(input: ReplaceRollupBucketsForWindowsInput): Promise<ReplaceRollupBucketsForWindowsResult>;
  writeFreshnessRows(rows: readonly ReportFreshnessRow[]): Promise<number>;
  markReportSnapshotsStale(input: MarkReportSnapshotsStaleInput): Promise<number>;
  markReportSnapshotsStaleForPostingChanges(input: MarkReportSnapshotsStaleForPostingChangesInput): Promise<number>;
  markReportSnapshotsStaleForAccountHierarchyChanges(input: MarkReportSnapshotsStaleForAccountHierarchyChangesInput): Promise<number>;
  loadAccounts(input: LoadAccountsInput): Promise<readonly Account[]>;
  loadReportBuilderInput(input: LoadReportBuilderInput): Promise<ReportBuilderInput>;
  loadLatestReportSnapshot(input: LoadReportSnapshotInput): Promise<StoredReportSnapshot | undefined>;
  loadRollupBuckets(input: LoadRollupBucketsInput): Promise<readonly RollupBucket[]>;
};

export type MarkReportSnapshotsStaleInput = {
  readonly tenantId: TenantId;
  readonly reportSnapshotIds: readonly string[];
  readonly staleReason: string;
};

/**
 * Deletes ledger facts (postings, then orphaned transaction lines and
 * transactions) for a tenant/source that were NOT written by the given import
 * batch. Used after a successful FULL sync so the canonical ledger exactly
 * mirrors the latest complete provider state — removing postings from
 * deleted/voided provider transactions and leftovers from a previous posting
 * source (for example, locally derived postings after switching to
 * provider-general-ledger ingestion).
 */
export type DeleteLedgerFactsOutsideImportBatchInput = {
  readonly tenantId: TenantId;
  readonly sourceId: SourceId;
  readonly importBatchId: ImportBatchId;
};

export type DeleteLedgerFactsOutsideImportBatchResult = {
  readonly correctionDependencies?: readonly CustomerPaymentCorrectionDependency[];
  readonly postings: number;
  readonly transactionLines: number;
  readonly transactions: number;
};

export type MarkReportSnapshotsStaleForPostingChangesInput = {
  readonly tenantId: TenantId;
  readonly companyId: string;
  readonly sourceId: SourceId;
  readonly affectedStart: IsoDate;
  readonly affectedEnd: IsoDate;
  readonly staleReason: string;
  readonly reportNames?: readonly string[];
  readonly accountingBasis?: AccountingBasis;
  readonly currencyCode?: IsoCurrencyCode;
};

export type MarkReportSnapshotsStaleForAccountHierarchyChangesInput = {
  readonly tenantId: TenantId;
  readonly companyId: string;
  readonly sourceId: SourceId;
  readonly staleReason: string;
  readonly reportNames?: readonly string[];
  readonly accountingBasis?: AccountingBasis;
  readonly currencyCode?: IsoCurrencyCode;
};

type Row = Readonly<Record<string, unknown>>;

// node-postgres serializes Bind parameter-format counts through a signed
// 16-bit path. Stay below that boundary even though PostgreSQL itself accepts
// a larger unsigned count in the wire protocol.
const MAX_UPSERT_PARAMETERS = 30_000;

type CatalogRow = {
  readonly object_type: "schema" | "table" | "column" | "index" | "constraint" | "trigger";
  readonly table_name: string | null;
  readonly object_name: string;
  readonly data_type?: string | null;
  readonly is_nullable?: string | null;
  readonly definition?: string | null;
  readonly enabled?: boolean | null;
};

const FIXTURE_SUPPORT_TABLES = [
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
] as const;

const PROFIT_AND_LOSS_SECTION_ORDER = [
  "income",
  "cost_of_goods_sold",
  "expense",
  "other_income",
  "other_expense"
] as const;

export function createPostgresStorageAdapter(
  client: PostgresQueryClient,
  manifest: PostgresSchemaManifest = POSTGRES_CANONICAL_SCHEMA_MANIFEST
): PostgresStorageAdapter {
  assertManifestHasNoCredentialColumns(manifest);

  return {
    manifest,
    async installSchema(options = {}) {
      return installPostgresSchema(client, manifest, options);
    },
    async validateSchema() {
      return validatePostgresSchema(client, manifest);
    },
    async upsertAccountingCompany(company) {
      // A canonical company can be fed by more than one accounting source. For
      // example, Spartan owns the company natively before QuickBooks history is
      // imported. Reconcile that shared reporting entity by its canonical ID;
      // source-specific identity belongs in accounting_sources.
      return upsertRows(client, manifest, "accounting_companies", [companyRow(company)], ["company_id"]);
    },
    async upsertAccountingSource(source) {
      return upsertRows(client, manifest, "accounting_sources", [sourceRow(source)], [
        "tenant_id",
        "source_system",
        "provider_environment",
        "connection_ref"
      ]);
    },
    async upsertCompanySourceBinding(binding) {
      return upsertRows(client, manifest, "company_sources", [companySourceBindingRow(binding)], [
        "tenant_id",
        "company_id",
        "source_id"
      ]);
    },
    async upsertImportBatch(importBatch) {
      return upsertRows(client, manifest, "import_batches", [importBatchRow(importBatch)], [
        "tenant_id",
        "source_id",
        "import_batch_id"
      ]);
    },
    async upsertSyncCheckpoint(checkpoint) {
      return upsertRows(client, manifest, "sync_checkpoints", [syncCheckpointRow(checkpoint)], [
        "tenant_id",
        "source_id",
        "source_object",
        "cursor_kind"
      ]);
    },
    async upsertAccounts(accounts) {
      await assertProspectiveAccountHierarchy(client, manifest, accounts);
      return upsertRows(client, manifest, "accounts", accounts.map(accountRow), [
        "tenant_id",
        "source_id",
        "source_account_id"
      ]);
    },
    async upsertParties(parties) {
      return upsertRows(client, manifest, "parties", parties.map(partyRow), ["tenant_id", "source_id", "source_party_id"]);
    },
    async upsertItems(items) {
      return upsertRows(client, manifest, "items", items.map(itemRow), ["tenant_id", "source_id", "source_item_id"]);
    },
    async upsertDimensions(dimensions) {
      return upsertRows(client, manifest, "accounting_dimensions", dimensions.map(dimensionRow), [
        "tenant_id",
        "source_id",
        "dimension_kind",
        "source_dimension_id"
      ]);
    },
    prepareCustomerPaymentCorrectionImport(facts) {
      return prepareCustomerPaymentCorrectionImport(client, facts);
    },
    async upsertTransactions(transactions) {
      for (const transaction of transactions) {
        if (transaction.sourcePayloadRef !== undefined) {
          assertSafeSourcePayloadRef(transaction.sourcePayloadRef);
        }
      }
      return upsertRows(client, manifest, "transactions", transactions.map(transactionRow), [
        "tenant_id",
        "source_id",
        "source_transaction_type",
        "source_transaction_id"
      ]);
    },
    async upsertTransactionLines(lines) {
      return upsertRows(client, manifest, "transaction_lines", lines.map(transactionLineRow), [
        "tenant_id",
        "source_id",
        "transaction_id",
        "line_number"
      ]);
    },
    async upsertLedgerPostings(postings) {
      for (const posting of postings) {
        assertLedgerPostingAmounts(posting);
        if (posting.sourcePayloadRef !== undefined) {
          assertSafeSourcePayloadRef(posting.sourcePayloadRef);
        }
      }
      return upsertRows(client, manifest, "ledger_postings", postings.map(ledgerPostingRow), [
        "tenant_id",
        "source_id",
        "accounting_basis",
        "source_posting_id"
      ]);
    },
    persistQuickBooksSubledgerResources(input) {
      return persistQuickBooksSubledgerResources({ client, ...input });
    },
    replaceDualBasisRange(input) {
      return replaceQuickBooksDualBasisBackfillRange(client, manifest, input);
    },
    async upsertPostingRules(rules) {
      rules.forEach(assertPostingRule);
      return upsertRows(client, manifest, "posting_rules", rules.map(postingRuleRow), [
        "tenant_id",
        "source_id",
        "rule_code"
      ]);
    },
    async upsertTransactionMatchCandidates(candidates) {
      candidates.forEach(assertTransactionMatchCandidate);
      return upsertRows(client, manifest, "transaction_match_candidates", candidates.map(transactionMatchCandidateRow), [
        "tenant_id",
        "source_id",
        "match_kind",
        "origin_transaction_id",
        "target_transaction_id",
        "matcher_version"
      ]);
    },
    async recordTransactionMatchDecisions(decisions) {
      decisions.forEach(assertTransactionMatchDecision);
      return upsertRows(
        client,
        manifest,
        "transaction_match_decisions",
        decisions.map(transactionMatchDecisionRow),
        ["tenant_id", "source_id", "match_decision_id"],
        "nothing"
      );
    },
    async upsertPaymentApplications(applications) {
      applications.forEach(assertPaymentApplication);
      return upsertRows(client, manifest, "payment_applications", applications.map(paymentApplicationRow), [
        "tenant_id",
        "source_id",
        "payment_transaction_id",
        "invoice_transaction_id"
      ]);
    },
    async deleteLedgerFactsOutsideImportBatch(input) {
      return deleteLedgerFactsOutsideImportBatch(client, manifest, input);
    },
    async resetSourceImportState(input) {
      return resetSourceImportState(client, input);
    },
    async loadStatementFixture(fixture) {
      return loadStatementFixture(client, manifest, fixture);
    },
    async writeReportSnapshot(report) {
      return writeReportSnapshot(client, manifest, report);
    },
    async writeRollupBuckets(buckets) {
      for (const bucket of buckets) {
        assertLedgerPostingAmounts(bucket);
      }
      return upsertRows(client, manifest, "rollup_buckets", buckets.map(rollupBucketRow), [
        "tenant_id",
        "company_id",
        "source_id",
        "accounting_basis",
        "bucket_grain",
        "bucket_start",
        "bucket_end",
        "account_id",
        "currency_code",
        "dimension_hash",
        "party_id",
        "party_type",
        "item_id"
      ]);
    },
    async replaceRollupBucketsForWindows(input) {
      return replaceRollupBucketsForWindows(client, manifest, input);
    },
    async writeFreshnessRows(rows) {
      return upsertRows(client, manifest, "report_freshness", rows.map(reportFreshnessRow), [
        "tenant_id",
        "company_id",
        "source_id",
        "report_name",
        "accounting_basis",
        "period_start",
        "period_end",
        "currency_code"
      ]);
    },
    async markReportSnapshotsStale(input) {
      return markReportSnapshotsStale(client, manifest, input);
    },
    async markReportSnapshotsStaleForPostingChanges(input) {
      return markReportSnapshotsStaleForPostingChanges(client, manifest, input);
    },
    async markReportSnapshotsStaleForAccountHierarchyChanges(input) {
      return markReportSnapshotsStaleForAccountHierarchyChanges(client, manifest, input);
    },
    async loadAccounts(input) {
      return loadAccounts(client, manifest, input);
    },
    async loadReportBuilderInput(input) {
      return loadReportBuilderInput(client, manifest, input);
    },
    async loadLatestReportSnapshot(input) {
      return loadLatestReportSnapshot(client, manifest, input);
    },
    async loadRollupBuckets(input) {
      return loadRollupBuckets(client, manifest, input);
    },
    async loadStandardReportPresentation(request) {
      return loadStandardReportPresentation(client, manifest, request);
    }
  };
}

/**
 * Transaction-safe persistence boundary for the dual-basis QuickBooks worker.
 * A plain storage adapter is useful inside an existing transaction; this
 * wrapper owns the transaction so deletion and replacement of both bases
 * cannot be observed or committed independently.
 */
export function createPostgresQuickBooksDualBasisBackfillPersistence(
  database: PostgresTransactionRunner,
  manifest: PostgresSchemaManifest = POSTGRES_CANONICAL_SCHEMA_MANIFEST
): QuickBooksDualBasisBackfillPersistence {
  assertManifestHasNoCredentialColumns(manifest);
  return {
    replaceDualBasisRange(input) {
      return database.transaction((client) =>
        replaceQuickBooksDualBasisBackfillRange(client, manifest, input)
      );
    }
  };
}

async function assertProspectiveAccountHierarchy(
  client: PostgresQueryClient,
  manifest: PostgresSchemaManifest,
  accounts: readonly Account[]
): Promise<void> {
  const byScope = new Map<string, Account[]>();
  for (const account of accounts) {
    const scopeKey = `${account.tenantId}\u0000${account.sourceId}`;
    const scoped = byScope.get(scopeKey) ?? [];
    scoped.push(account);
    byScope.set(scopeKey, scoped);
  }

  for (const scopedAccounts of byScope.values()) {
    const first = scopedAccounts[0];
    if (first === undefined) continue;
    const existing = await loadAccounts(client, manifest, {
      tenantId: first.tenantId,
      sourceId: first.sourceId
    });
    const prospective = new Map(existing.map((account) => [account.accountId, account]));
    for (const account of scopedAccounts) prospective.set(account.accountId, account);
    const prospectiveAccounts = [...prospective.values()];
    const prospectiveIds = new Set(prospective.keys());
    const unresolvedParentIds = [...new Set(prospectiveAccounts
      .map((account) => account.parentAccountId)
      .filter((parentAccountId): parentAccountId is string =>
        parentAccountId !== undefined && !prospectiveIds.has(parentAccountId)))];
    const crossScopeCandidates = await loadAccountCandidatesByIds(client, manifest, unresolvedParentIds);
    assertValidAccountHierarchy([...prospectiveAccounts, ...crossScopeCandidates], {
      accountsToValidate: prospectiveAccounts
    });
  }
}

async function loadAccountCandidatesByIds(
  client: PostgresQueryClient,
  manifest: PostgresSchemaManifest,
  accountIds: readonly string[]
): Promise<readonly Account[]> {
  if (accountIds.length === 0) return [];
  const result = await client.query(
    `select "account_id", "tenant_id", "source_id", "source_account_id", "account_number", "name", "type", "subtype", "classification", "parent_account_id", "currency_code", "active"
from ${qualifiedTable(manifest, "accounts")}
where "account_id" = any($1::text[])
order by "tenant_id", "source_id", "account_id"`,
    [accountIds]
  );
  return result.rows.map(accountFromRow);
}

export async function installPostgresSchema(
  client: PostgresQueryClient,
  manifest: PostgresSchemaManifest = POSTGRES_CANONICAL_SCHEMA_MANIFEST,
  options: InstallPostgresSchemaOptions = {}
): Promise<InstallPostgresSchemaResult> {
  assertManifestHasNoCredentialColumns(manifest);
  const statements = splitSqlStatements(renderPostgresSchemaSql(manifest));

  if (options.dryRun !== true) {
    for (const statement of statements) {
      await client.query(statement);
    }
  }

  return {
    manifestVersion: manifest.manifestVersion,
    schemaVersion: manifest.schemaVersion,
    statements,
    executed: options.dryRun !== true
  };
}

export async function validatePostgresSchema(
  client: PostgresQueryClient,
  manifest: PostgresSchemaManifest = POSTGRES_CANONICAL_SCHEMA_MANIFEST
): Promise<PostgresSchemaValidationResult> {
  assertManifestHasNoCredentialColumns(manifest);
  const catalogRows = await readCatalogRows(client, manifest.namespace);
  const available = new Set(catalogRows.map(catalogKey));
  const catalogByKey = new Map(catalogRows.map((row) => [catalogKey(row), row]));
  const issues: PostgresSchemaValidationIssue[] = [];

  if (!available.has(`schema::${manifest.namespace}`)) {
    issues.push({
      kind: "missing_schema",
      objectName: manifest.namespace,
      message: `missing schema ${manifest.namespace}`
    });
  }

  for (const table of manifest.tables) {
    if (!available.has(`table::${table.name}`)) {
      issues.push({
        kind: "missing_table",
        table: table.name,
        objectName: table.name,
        message: `missing table ${manifest.namespace}.${table.name}`
      });
    }

    for (const column of table.columns) {
      const key = `column::${table.name}.${column.name}`;
      const catalogColumn = catalogByKey.get(key);
      if (catalogColumn === undefined) {
        issues.push({
          kind: "missing_column",
          table: table.name,
          objectName: column.name,
          message: `missing column ${manifest.namespace}.${table.name}.${column.name}`
        });
      }
      if (catalogColumn?.data_type != null && normalizePostgresType(catalogColumn.data_type) !== column.type) {
        issues.push({
          kind: "incompatible_column_type",
          table: table.name,
          objectName: column.name,
          message: `incompatible column type for ${manifest.namespace}.${table.name}.${column.name}: expected ${column.type}, found ${catalogColumn.data_type}`
        });
      }
      if (catalogColumn?.is_nullable != null) {
        const actualNullable = catalogColumn.is_nullable.toUpperCase() === "YES";
        const expectedNullable = column.nullable === true;
        if (actualNullable !== expectedNullable) {
          issues.push({
            kind: "incompatible_column_nullability",
            table: table.name,
            objectName: column.name,
            message: `incompatible nullability for ${manifest.namespace}.${table.name}.${column.name}: expected ${expectedNullable ? "nullable" : "not null"}`
          });
        }
      }
      if (isDisallowedCredentialColumnName(column.name)) {
        issues.push({
          kind: "credential_column",
          table: table.name,
          objectName: column.name,
          message: `credential-like column is not allowed: ${table.name}.${column.name}`
        });
      }
    }

    for (const index of table.indexes) {
      const key = `index::${index.name}`;
      const catalogIndex = catalogByKey.get(key);
      if (catalogIndex === undefined) {
        issues.push({
          kind: "missing_index",
          table: table.name,
          objectName: index.name,
          message: `missing index ${manifest.namespace}.${index.name}`
        });
      } else if (
        catalogIndex.definition != null &&
        !indexDefinitionMatches(catalogIndex.definition, index.columns, index.unique === true, index.whereSql)
      ) {
        issues.push({
          kind: "incompatible_index_definition",
          table: table.name,
          objectName: index.name,
          message: `incompatible index definition for ${manifest.namespace}.${index.name}`
        });
      }
    }

    for (const constraintName of expectedConstraintNames(table)) {
      const key = `constraint::${table.name}.${constraintName}`;
      const catalogConstraint = catalogByKey.get(key);
      if (catalogConstraint === undefined) {
        issues.push({
          kind: "missing_constraint",
          table: table.name,
          objectName: constraintName,
          message: `missing constraint ${manifest.namespace}.${table.name}.${constraintName}`
        });
      }
    }
    for (const constraint of table.constraints.filter((entry) => entry.kind === "foreign_key")) {
      const catalogConstraint = catalogByKey.get(`constraint::${table.name}.${constraint.name}`);
      if (
        catalogConstraint?.definition != null &&
        normalizeForeignKeyDefinition(catalogConstraint.definition) !== normalizeForeignKeyDefinition(constraint.sql)
      ) {
        issues.push({
          kind: "incompatible_constraint_definition",
          table: table.name,
          objectName: constraint.name,
          message: `incompatible foreign-key definition for ${manifest.namespace}.${table.name}.${constraint.name}`
        });
      }
    }
  }

  for (const trigger of manifest.requiredTriggers) {
    const catalogTrigger = catalogByKey.get(`trigger::${trigger.table}.${trigger.name}`);
    if (catalogTrigger === undefined) {
      issues.push({
        kind: "missing_trigger",
        table: trigger.table,
        objectName: trigger.name,
        message: `missing trigger ${manifest.namespace}.${trigger.table}.${trigger.name}`
      });
    } else if (
      catalogTrigger.enabled !== true ||
      catalogTrigger.definition == null ||
      !triggerDefinitionMatches(catalogTrigger.definition, manifest.namespace, trigger)
    ) {
      issues.push({
        kind: "incompatible_trigger_definition",
        table: trigger.table,
        objectName: trigger.name,
        message: `incompatible or disabled trigger ${manifest.namespace}.${trigger.table}.${trigger.name}`
      });
    }
  }

  for (const tableName of FIXTURE_SUPPORT_TABLES) {
    if (!available.has(`table::${tableName}`)) {
      issues.push({
        kind: "missing_fixture_support",
        table: tableName,
        objectName: tableName,
        message: `fixture loader requires ${manifest.namespace}.${tableName}`
      });
    }
  }

  const fixtureSupport = !issues.some((issue) => issue.kind === "missing_fixture_support");

  return {
    manifestVersion: manifest.manifestVersion,
    schemaVersion: manifest.schemaVersion,
    compatible: issues.length === 0,
    fixtureSupport,
    issues
  };
}

async function loadStatementFixture(
  client: PostgresQueryClient,
  manifest: PostgresSchemaManifest,
  fixture: StatementFixtureSet
): Promise<FixtureLoadResult> {
  const adapter = createPostgresStorageAdapter(client, manifest);

  const companies = await adapter.upsertAccountingCompany(fixture.company);
  const sources = await adapter.upsertAccountingSource(fixture.source);
  await adapter.upsertCompanySourceBinding(
    createCompanySourceBinding({
      tenantId: fixture.company.tenantId,
      companyId: fixture.company.companyId,
      sourceId: fixture.source.sourceId,
      createdAt: fixture.importBatch.startedAt
    })
  );

  return {
    companies,
    sources,
    importBatches: await adapter.upsertImportBatch(fixture.importBatch),
    checkpoints: await adapter.upsertSyncCheckpoint(fixture.checkpoint),
    accounts: await adapter.upsertAccounts(fixture.accounts),
    parties: await adapter.upsertParties(fixture.parties),
    items: await adapter.upsertItems(fixture.items),
    dimensions: await adapter.upsertDimensions(fixture.dimensions),
    transactions: await adapter.upsertTransactions(fixture.transactions),
    transactionLines: await adapter.upsertTransactionLines(fixture.transactionLines),
    postings: await adapter.upsertLedgerPostings(fixture.postings)
  };
}

async function writeReportSnapshot(
  client: PostgresQueryClient,
  manifest: PostgresSchemaManifest,
  report: BuiltReport
): Promise<number> {
  assertReportSnapshotWriteScope(report);
  const snapshotCount = await upsertRows(client, manifest, "report_snapshots", [reportSnapshotRow(report.snapshot)], [
    "tenant_id",
    "company_id",
    "source_id",
    "report_name",
    "snapshot_source",
    "accounting_basis",
    "period_start",
    "period_end",
    "as_of_date",
    "currency_code"
  ]);
  await pruneMissingSnapshotChildren(
    client,
    manifest,
    "report_snapshot_lines",
    report.snapshot.tenantId,
    report.snapshot.companyId,
    report.snapshot.sourceId,
    report.snapshot.reportSnapshotId,
    "report_line_id",
    report.lines.map((line) => line.reportLineId)
  );
  await pruneMissingSnapshotChildren(
    client,
    manifest,
    "report_snapshot_totals",
    report.snapshot.tenantId,
    report.snapshot.companyId,
    report.snapshot.sourceId,
    report.snapshot.reportSnapshotId,
    "report_total_id",
    report.totals.map((total) => total.reportTotalId)
  );
  const lineCount = await upsertRows(
    client,
    manifest,
    "report_snapshot_lines",
    report.lines.map((line) => reportSnapshotLineRow(line, report.snapshot)),
    ["tenant_id", "company_id", "source_id", "report_line_id"]
  );
  const totalCount = await upsertRows(
    client,
    manifest,
    "report_snapshot_totals",
    report.totals.map((total) => reportSnapshotTotalRow(total, report.snapshot)),
    ["tenant_id", "company_id", "source_id", "report_total_id"]
  );

  return snapshotCount + lineCount + totalCount;
}

function assertReportSnapshotWriteScope(report: BuiltReport): void {
  const { snapshot } = report;
  const childIdPrefix = `${snapshot.reportSnapshotId}:`;
  const lineIds = new Set(report.lines.map((line) => line.reportLineId));

  if (snapshot.companyId.trim().length === 0 || snapshot.sourceId.trim().length === 0) {
    throw new Error("report snapshot companyId and sourceId must not be empty");
  }

  for (const line of report.lines) {
    if (line.tenantId !== snapshot.tenantId || line.reportSnapshotId !== snapshot.reportSnapshotId) {
      throw new Error(`report snapshot line ${line.reportLineId} is outside the snapshot scope`);
    }
    if (!line.reportLineId.startsWith(childIdPrefix)) {
      throw new Error(`report snapshot line ${line.reportLineId} must include its snapshot id`);
    }
    if (line.parentReportLineId !== undefined && !lineIds.has(line.parentReportLineId)) {
      throw new Error(`report snapshot line ${line.reportLineId} references a parent outside the snapshot`);
    }
  }

  for (const total of report.totals) {
    if (total.tenantId !== snapshot.tenantId || total.reportSnapshotId !== snapshot.reportSnapshotId) {
      throw new Error(`report snapshot total ${total.reportTotalId} is outside the snapshot scope`);
    }
    if (!total.reportTotalId.startsWith(childIdPrefix)) {
      throw new Error(`report snapshot total ${total.reportTotalId} must include its snapshot id`);
    }
  }
}

async function markReportSnapshotsStale(
  client: PostgresQueryClient,
  manifest: PostgresSchemaManifest,
  input: MarkReportSnapshotsStaleInput
): Promise<number> {
  if (input.reportSnapshotIds.length === 0) {
    return 0;
  }

  const result = await client.query(
    `update ${qualifiedTable(manifest, "report_snapshots")}
set "freshness" = jsonb_set(coalesce("freshness", '{}'::jsonb), '{status}', '"stale"', true) || jsonb_build_object('staleReason', $3::text)
where "tenant_id" = $1 and "report_snapshot_id" = any($2::text[])`,
    [input.tenantId, input.reportSnapshotIds, input.staleReason]
  );

  return result.rowCount ?? 0;
}

async function markReportSnapshotsStaleForPostingChanges(
  client: PostgresQueryClient,
  manifest: PostgresSchemaManifest,
  input: MarkReportSnapshotsStaleForPostingChangesInput
): Promise<number> {
  const parameters: unknown[] = [
    input.tenantId,
    input.affectedStart,
    input.affectedEnd,
    input.staleReason,
    input.companyId,
    input.sourceId
  ];
  const filters = [
    `rs."tenant_id" = $1`,
    `rs."company_id" = $5`,
    `rs."source_id" = $6`,
    `(("period_start" <= $3::date and "period_end" >= $2::date) or "as_of_date" >= $2::date)`
  ];

  if (input.reportNames !== undefined && input.reportNames.length > 0) {
    parameters.push(input.reportNames);
    filters.push(`rs."report_name" = any($${String(parameters.length)}::text[])`);
  }
  if (input.accountingBasis !== undefined) {
    parameters.push(input.accountingBasis);
    filters.push(`rs."accounting_basis" = $${String(parameters.length)}`);
  }
  if (input.currencyCode !== undefined) {
    parameters.push(input.currencyCode);
    filters.push(`rs."currency_code" = $${String(parameters.length)}`);
  }

  const result = await client.query(
    `update ${qualifiedTable(manifest, "report_snapshots")} rs
set "freshness" = jsonb_set(coalesce(rs."freshness", '{}'::jsonb), '{status}', '"stale"', true) || jsonb_build_object('staleReason', $4::text)
where ${filters.join(" and ")}`,
    parameters
  );

  return result.rowCount ?? 0;
}

async function markReportSnapshotsStaleForAccountHierarchyChanges(
  client: PostgresQueryClient,
  manifest: PostgresSchemaManifest,
  input: MarkReportSnapshotsStaleForAccountHierarchyChangesInput
): Promise<number> {
  const parameters: unknown[] = [input.tenantId, input.companyId, input.sourceId, input.staleReason];
  const filters = [
    `rs."tenant_id" = $1`,
    `rs."company_id" = $2`,
    `rs."source_id" = $3`
  ];

  if (input.reportNames !== undefined && input.reportNames.length > 0) {
    parameters.push(input.reportNames);
    filters.push(`rs."report_name" = any($${String(parameters.length)}::text[])`);
  }
  if (input.accountingBasis !== undefined) {
    parameters.push(input.accountingBasis);
    filters.push(`rs."accounting_basis" = $${String(parameters.length)}`);
  }
  if (input.currencyCode !== undefined) {
    parameters.push(input.currencyCode);
    filters.push(`rs."currency_code" = $${String(parameters.length)}`);
  }

  const result = await client.query(
    `update ${qualifiedTable(manifest, "report_snapshots")} rs
set "freshness" = jsonb_set(coalesce(rs."freshness", '{}'::jsonb), '{status}', '"stale"', true) || jsonb_build_object('staleReason', $4::text)
where ${filters.join(" and ")}`,
    parameters
  );

  return result.rowCount ?? 0;
}

async function loadAccounts(
  client: PostgresQueryClient,
  manifest: PostgresSchemaManifest,
  input: LoadAccountsInput
): Promise<readonly Account[]> {
  if (input.accountIds !== undefined && input.accountIds.length === 0) {
    return [];
  }

  const parameters: unknown[] = [input.tenantId, input.sourceId];
  const filters = [`"tenant_id" = $1`, `"source_id" = $2`];

  if (input.accountIds !== undefined) {
    parameters.push(input.accountIds);
    filters.push(`"account_id" = any($3::text[])`);
  }

  const result = await client.query(
    `select "account_id", "tenant_id", "source_id", "source_account_id", "account_number", "name", "type", "subtype", "classification", "parent_account_id", "currency_code", "active"
from ${qualifiedTable(manifest, "accounts")}
where ${filters.join(" and ")}
order by "account_id"`,
    parameters
  );

  return result.rows.map(accountFromRow);
}

async function deleteLedgerFactsOutsideImportBatch(
  client: PostgresQueryClient,
  manifest: PostgresSchemaManifest,
  input: DeleteLedgerFactsOutsideImportBatchInput
): Promise<DeleteLedgerFactsOutsideImportBatchResult> {
  if (input.tenantId.length === 0 || input.sourceId.length === 0 || input.importBatchId.length === 0) {
    throw new Error("deleteLedgerFactsOutsideImportBatch requires tenantId, sourceId, and importBatchId");
  }

  const corrections = await loadCustomerPaymentCorrectionReplayState(client, input.tenantId, input.sourceId);
  const preserved = await client.query<{transaction_id: string}>(`select t.transaction_id from ${qualifiedTable(manifest, "transactions")} t
    join ${qualifiedTable(manifest, "subledger_documents")} d on d.tenant_id=t.tenant_id and d.source_id=t.source_id
      and (t.transaction_id=d.transaction_id or
        (t.source_payload_ref->>'sourceObjectType'='Invoice' and t.source_payload_ref->>'sourceObjectId'=d.metadata->>'sourceTransactionId') or
        (t.source_transaction_type='QuickBooksGeneralLedger:Invoice' and t.source_transaction_id in
          ('accrual:Invoice:'||(d.metadata->>'sourceTransactionId')||':'||t.transaction_date::text,
           'cash:Invoice:'||(d.metadata->>'sourceTransactionId')||':'||t.transaction_date::text)))
    where d.tenant_id=$1 and d.source_id=$2 and d.subledger_document_id=any($3::text[])`,
    [input.tenantId, input.sourceId, corrections.flatMap(row => row.reopenedInvoiceIds)]);
  const retainedIds = [...corrections.flatMap(row => row.transactionIds), ...preserved.rows.map(row => row.transaction_id)];
  await client.query(`select set_config('erp_financials.quickbooks_projection_refresh', 'on', true)`);
  const postingsResult = await client.query(
    `delete from ${qualifiedTable(manifest, "ledger_postings")} posting
where "tenant_id" = $1 and "source_id" = $2 and "import_batch_id" <> $3
  and not ("transaction_id" = any($4::text[]))
  and not exists (select 1 from ${qualifiedTable(manifest, "transactions")} t
    where t.tenant_id=posting.tenant_id and t.source_id=posting.source_id and t.transaction_id=posting.transaction_id
      and (t.source_transaction_type like 'Subledger:%' or t.source_transaction_type in ('JournalEntry','JournalEntryAdjustment')))`,
    [input.tenantId, input.sourceId, input.importBatchId, retainedIds]
  );
  const transactionLinesResult = await client.query(
    `delete from ${qualifiedTable(manifest, "transaction_lines")} lines
using ${qualifiedTable(manifest, "transactions")} transactions
where transactions."transaction_id" = lines."transaction_id"
  and transactions."tenant_id" = lines."tenant_id"
  and transactions."tenant_id" = $1
  and transactions."source_id" = $2
  and not exists (
    select 1 from ${qualifiedTable(manifest, "ledger_postings")} postings
    where postings."tenant_id" = transactions."tenant_id"
      and postings."transaction_id" = transactions."transaction_id"
  )
  and not exists (
    select 1 from ${qualifiedTable(manifest, "subledger_documents")} document
    where document."tenant_id" = transactions."tenant_id"
      and document."source_id" = transactions."source_id"
      and document."transaction_id" = transactions."transaction_id"
  )`,
    [input.tenantId, input.sourceId]
  );
  const transactionsResult = await client.query(
    `delete from ${qualifiedTable(manifest, "transactions")} transactions
where transactions."tenant_id" = $1
  and transactions."source_id" = $2
  and not exists (
    select 1 from ${qualifiedTable(manifest, "ledger_postings")} postings
    where postings."tenant_id" = transactions."tenant_id"
      and postings."transaction_id" = transactions."transaction_id"
  )
  and not exists (
    select 1 from ${qualifiedTable(manifest, "subledger_documents")} document
    where document."tenant_id" = transactions."tenant_id"
      and document."source_id" = transactions."source_id"
      and document."transaction_id" = transactions."transaction_id"
  )`,
    [input.tenantId, input.sourceId]
  );
  await client.query(`select set_config('erp_financials.quickbooks_projection_refresh', 'off', true)`);

  return {
    ...(corrections.length ? { correctionDependencies: corrections.map(row => row.dependency) } : {}),
    postings: postingsResult.rowCount ?? 0,
    transactionLines: transactionLinesResult.rowCount ?? 0,
    transactions: transactionsResult.rowCount ?? 0
  };
}

async function replaceQuickBooksDualBasisBackfillRange(
  client: PostgresQueryClient,
  manifest: PostgresSchemaManifest,
  input: {
    readonly tenantId: string;
    readonly companyId: string;
    readonly sourceId: string;
    readonly periodStart: IsoDate;
    readonly periodEnd: IsoDate;
    readonly projections: readonly [QuickBooksBasisBackfillProjection, QuickBooksBasisBackfillProjection];
  }
): Promise<{ readonly importBatches: number; readonly transactions: number; readonly postings: number; readonly snapshotsMarkedStale: number; readonly correctionDependencies: readonly CustomerPaymentCorrectionDependency[] }> {
  const methods = input.projections.map((projection) => projection.accountingBasis);
  if (new Set(methods).size !== 2 || !methods.includes("cash") || !methods.includes("accrual")) {
    throw new Error("QuickBooks dual-basis range replacement requires one cash and one accrual projection");
  }
  const corrections = await loadCustomerPaymentCorrectionReplayState(client, input.tenantId, input.sourceId);
  const blocked = correctedTransactionIds(corrections, input.projections.flatMap(p => p.transactions));
  const invoiceTransactions = await client.query<{transaction_id: string}>(`select t.transaction_id from ${qualifiedTable(manifest, "transactions")} t
    join ${qualifiedTable(manifest, "subledger_documents")} d on d.tenant_id=t.tenant_id and d.source_id=t.source_id
      and (t.transaction_id=d.transaction_id or
        (t.source_payload_ref->>'sourceObjectType'='Invoice' and t.source_payload_ref->>'sourceObjectId'=d.metadata->>'sourceTransactionId') or
        (t.source_transaction_type='QuickBooksGeneralLedger:Invoice' and t.source_transaction_id in
          ('accrual:Invoice:'||(d.metadata->>'sourceTransactionId')||':'||t.transaction_date::text,
           'cash:Invoice:'||(d.metadata->>'sourceTransactionId')||':'||t.transaction_date::text)))
    where d.tenant_id=$1 and d.source_id=$2 and d.subledger_document_id=any($3::text[])`,
    [input.tenantId,input.sourceId,corrections.flatMap(row => row.reopenedInvoiceIds)]);
  const retained = [...blocked,...invoiceTransactions.rows.map(row => row.transaction_id)];
  await client.query(
    `delete from ${qualifiedTable(manifest, "ledger_postings")} posting
using ${qualifiedTable(manifest, "transactions")} transaction
where posting."tenant_id" = $1 and posting."source_id" = $2
  and posting."transaction_id" = transaction."transaction_id"
  and transaction."tenant_id" = posting."tenant_id" and transaction."source_id" = posting."source_id"
  and transaction."source_transaction_type" like 'QuickBooksGeneralLedger:%'
  and posting."accounting_basis" = any($3::text[])
  and posting."posting_date" between $4::date and $5::date
  and not (posting."transaction_id"=any($6::text[]))`,
    [input.tenantId, input.sourceId, methods, input.periodStart, input.periodEnd, retained]
  );
  await client.query(
    `delete from ${qualifiedTable(manifest, "transactions")} transaction
where transaction."tenant_id" = $1 and transaction."source_id" = $2
  and transaction."source_transaction_type" like 'QuickBooksGeneralLedger:%'
  and transaction."transaction_date" between $3::date and $4::date
  and not (transaction."transaction_id"=any($5::text[]))
  and not exists (
    select 1 from ${qualifiedTable(manifest, "ledger_postings")} posting
    where posting."tenant_id" = transaction."tenant_id" and posting."source_id" = transaction."source_id"
      and posting."transaction_id" = transaction."transaction_id"
  )`,
    [input.tenantId, input.sourceId, input.periodStart, input.periodEnd, retained]
  );

  let importBatches = 0;
  let transactions = 0;
  let postings = 0;
  let snapshotsMarkedStale = 0;
  for (const projection of input.projections) {
    importBatches += await upsertRows(client, manifest, "import_batches", [importBatchRow(projection.importBatch)], [
      "tenant_id", "source_id", "import_batch_id"
    ]);
    for (const transaction of projection.transactions) {
      if (transaction.sourcePayloadRef !== undefined) assertSafeSourcePayloadRef(transaction.sourcePayloadRef);
    }
    transactions += await upsertRows(client, manifest, "transactions", projection.transactions.filter(row => !blocked.has(row.transactionId)).map(transactionRow), [
      "tenant_id", "source_id", "source_transaction_type", "source_transaction_id"
    ]);
    for (const posting of projection.postings) {
      assertLedgerPostingAmounts(posting);
      if (posting.sourcePayloadRef !== undefined) assertSafeSourcePayloadRef(posting.sourcePayloadRef);
    }
    postings += await upsertRows(client, manifest, "ledger_postings", projection.postings.filter(row => !blocked.has(row.transactionId)).map(ledgerPostingRow), [
      "tenant_id", "source_id", "accounting_basis", "source_posting_id"
    ]);
    const projectionCurrencyCode = projection.postings[0]?.currencyCode;
    snapshotsMarkedStale += await markReportSnapshotsStaleForPostingChanges(client, manifest, {
      tenantId: input.tenantId,
      companyId: input.companyId,
      sourceId: input.sourceId,
      affectedStart: input.periodStart,
      affectedEnd: input.periodEnd,
      staleReason: "quickbooks_dual_basis_backfill_replaced",
      accountingBasis: projection.accountingBasis,
      ...(projectionCurrencyCode === undefined ? {} : { currencyCode: projectionCurrencyCode })
    });
  }
  return { importBatches, transactions, postings, snapshotsMarkedStale, correctionDependencies: corrections.map(row => row.dependency) };
}

async function loadReportBuilderInput(
  client: PostgresQueryClient,
  manifest: PostgresSchemaManifest,
  input: LoadReportBuilderInput
): Promise<ReportBuilderInput> {
  const companyResult = await client.query<Row>(
    `select "fiscal_year_start_month"
from ${qualifiedTable(manifest, "accounting_companies")}
where "tenant_id" = $1 and "company_id" = $2
limit 1`,
    [input.tenantId, input.companyId]
  );
  const accountResult = await client.query<Row>(
    `select "account_id", "tenant_id", "source_id", "source_account_id", "account_number", "name", "type", "subtype", "classification", "parent_account_id", "currency_code", "active"
from ${qualifiedTable(manifest, "accounts")}
where "tenant_id" = $1 and "source_id" = $2 and "active" = true
order by "account_number" nulls last, "name", "account_id"`,
    [input.tenantId, input.sourceId]
  );
  const postingResult = await client.query<Row>(
    `select "posting_id", "tenant_id", "source_id", "source_posting_id", "transaction_id", "transaction_line_id", "account_id", "party_id", "item_id", "posting_date", "accounting_basis", "debit_amount", "credit_amount", "net_amount", "currency_code", "dimension_hash", "dimension_refs", "source_payload_ref", "import_batch_id", "checkpoint_id"
from ${qualifiedTable(manifest, "ledger_postings")}
where "tenant_id" = $1
  and "source_id" = $2
  and "accounting_basis" = $3
  and "currency_code" = $4
  and "posting_date" <= coalesce($5::date, $6::date)
order by "posting_date", "transaction_id", "posting_id"`,
    [input.tenantId, input.sourceId, input.accountingBasis, input.currencyCode, input.asOfDate, input.periodEnd]
  );
  const freshnessResult = await client.query<Row>(
    `select "status", "source_id", "import_batch_id", "checkpoint_id", "fresh_through", "stale_reason"
from ${qualifiedTable(manifest, "report_freshness")}
where "tenant_id" = $1
  and "company_id" = $2
  and "source_id" = $3
  and "report_name" = $4
  and "accounting_basis" = $5
  and "period_start" = $6::date
  and "period_end" = $7::date
  and "currency_code" = $8
order by "updated_at" desc
limit 1`,
    [
      input.tenantId,
      input.companyId,
      input.sourceId,
      input.reportName,
      input.accountingBasis,
      input.periodStart,
      input.periodEnd,
      input.currencyCode
    ]
  );

  return {
    tenantId: input.tenantId,
    companyId: input.companyId,
    sourceId: input.sourceId,
    accounts: accountResult.rows.map(accountFromRow),
    postings: postingResult.rows.map(ledgerPostingFromRow),
    accountingBasis: input.accountingBasis,
    currencyCode: input.currencyCode,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    ...(companyResult.rows[0]?.fiscal_year_start_month === undefined
      ? {}
      : {
          fiscalYearStartMonth: requiredNumber(
            companyResult.rows[0].fiscal_year_start_month,
            "fiscal_year_start_month"
          )
        }),
    ...(input.asOfDate === undefined ? {} : { asOfDate: input.asOfDate }),
    ...(input.generatedAt === undefined ? {} : { generatedAt: input.generatedAt }),
    ...(freshnessResult.rows[0] === undefined ? {} : { freshness: reportFreshnessFromRow(freshnessResult.rows[0]) })
  };
}

async function loadLatestReportSnapshot(
  client: PostgresQueryClient,
  manifest: PostgresSchemaManifest,
  input: LoadReportSnapshotInput
): Promise<StoredReportSnapshot | undefined> {
  const snapshotResult = await client.query<Row>(
    `select "report_snapshot_id", "tenant_id", "company_id", "source_id", "report_name", "snapshot_source", "accounting_basis", "period_start", "period_end", "as_of_date", "currency_code", "generated_at", "freshness", "reconciliation_status", "reconciliation_difference"
from ${qualifiedTable(manifest, "report_snapshots")}
where "tenant_id" = $1
  and "company_id" = $2
  and "source_id" = $3
  and "report_name" = $4
  and "accounting_basis" = $5
  and "period_start" = $6::date
  and "period_end" = $7::date
  and "as_of_date" = coalesce($8::date, $7::date)
  and "currency_code" = $9
order by "generated_at" desc
limit 1`,
    [
      input.tenantId,
      input.companyId,
      input.sourceId,
      input.reportName,
      input.accountingBasis,
      input.periodStart,
      input.periodEnd,
      input.asOfDate,
      input.currencyCode
    ]
  );
  const snapshotRow = snapshotResult.rows[0];

  if (snapshotRow === undefined) {
    return undefined;
  }

  const snapshot = reportSnapshotFromRow(snapshotRow);
  const lineResult = await client.query<Row>(
    `select "report_line_id", "tenant_id", "company_id", "source_id", "report_snapshot_id", "parent_report_line_id", "section", "label", "account_id", "amount", "sort_order", "drilldown_ref"
from ${qualifiedTable(manifest, "report_snapshot_lines")}
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3 and "report_snapshot_id" = $4
order by "sort_order", "report_line_id"`,
    [input.tenantId, input.companyId, input.sourceId, snapshot.reportSnapshotId]
  );
  const totalResult = await client.query<Row>(
    `select "report_total_id", "tenant_id", "company_id", "source_id", "report_snapshot_id", "total_key", "label", "amount", "drilldown_ref"
from ${qualifiedTable(manifest, "report_snapshot_totals")}
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3 and "report_snapshot_id" = $4
order by "report_total_id"`,
    [input.tenantId, input.companyId, input.sourceId, snapshot.reportSnapshotId]
  );

  return {
    snapshot,
    lines: lineResult.rows.map(reportSnapshotLineFromRow),
    totals: totalResult.rows.map(reportSnapshotTotalFromRow)
  };
}

async function loadRollupBuckets(
  client: PostgresQueryClient,
  manifest: PostgresSchemaManifest,
  input: LoadRollupBucketsInput
): Promise<readonly RollupBucket[]> {
  const parameters: unknown[] = [
    input.tenantId,
    input.companyId,
    input.sourceId,
    input.accountingBasis,
    input.bucketGrain,
    input.bucketStart,
    input.bucketEnd,
    input.currencyCode
  ];
  const filters = [
    '"tenant_id" = $1',
    '"company_id" = $2',
    '"source_id" = $3',
    '"accounting_basis" = $4',
    '"bucket_grain" = $5',
    '"bucket_start" >= $6::date',
    '"bucket_end" <= $7::date',
    '"currency_code" = $8'
  ];
  appendRollupBucketTextFilter(filters, parameters, "account_id", input.accountId, input.accountIds);
  appendRollupBucketTextFilter(filters, parameters, "dimension_hash", input.dimensionHash, input.dimensionHashes);
  appendRollupBucketTextFilter(filters, parameters, "party_type", input.partyType, input.partyTypes);
  appendRollupBucketTextFilter(filters, parameters, "party_id", input.partyId, input.partyIds);
  appendRollupBucketTextFilter(filters, parameters, "item_id", input.itemId, input.itemIds);

  const result = await client.query<Row>(
    `select "rollup_bucket_id", "tenant_id", "company_id", "source_id", "account_id", "accounting_basis", "bucket_grain", "bucket_start", "bucket_end", "currency_code", "dimension_hash", "party_id", "party_type", "item_id", "debit_amount", "credit_amount", "net_amount", "posting_count", "source_posting_max_updated_at", "import_batch_id", "generated_at"
from ${qualifiedTable(manifest, "rollup_buckets")}
where ${filters.join("\n  and ")}
order by "bucket_start", "account_id", "dimension_hash", "party_type", "party_id", "item_id"`,
    parameters
  );

  return result.rows.map(rollupBucketFromRow);
}

async function loadStandardReportPresentation(
  client: PostgresQueryClient,
  manifest: PostgresSchemaManifest,
  request: StandardReportPresentationReadModelRequest
): Promise<StandardReportPresentationReportSet> {
  if ((request.compareTo?.periods ?? []).length > 0) {
    throw new Error("Snapshot-backed standard presentation compare-to periods require prebuilt comparison snapshots");
  }

  const accountingMethod = request.accountingMethod ?? "accrual";
  const displayColumnsBy = request.displayColumnsBy ?? "none";

  if (isRollupDimensionDisplayColumnsBy(displayColumnsBy) && request.reportName === "profit_and_loss") {
    return loadDimensionStandardReportPresentationFromRollups(client, manifest, request, accountingMethod, displayColumnsBy);
  }
  if (isRollupDimensionDisplayColumnsBy(displayColumnsBy)) {
    throw new Error(`Snapshot-backed ${request.reportName} presentation does not support ${displayColumnsBy} columns`);
  }

  const groups = presentationSnapshotGroups(request, displayColumnsBy);
  const amountColumns: StandardReportPresentationReportColumn[] = [];

  for (const group of groups) {
    const storedSnapshot = await loadLatestReportSnapshot(client, manifest, {
      tenantId: request.tenantId,
      companyId: request.companyId,
      sourceId: request.sourceId,
      reportName: request.reportName,
      accountingBasis: accountingMethod,
      periodStart: group.periodStart,
      periodEnd: group.periodEnd,
      asOfDate: group.asOfDate,
      currencyCode: request.currencyCode
    });

    if (storedSnapshot === undefined) {
      throw new Error(
        `Missing report snapshot for ${request.reportName} ${accountingMethod} ${group.periodStart} through ${group.periodEnd}`
      );
    }

    amountColumns.push({
      column: group.column,
      report: builtReportFromStoredSnapshot(storedSnapshot)
    });
  }

  const primarySnapshot = await loadLatestReportSnapshot(client, manifest, {
    tenantId: request.tenantId,
    companyId: request.companyId,
    sourceId: request.sourceId,
    reportName: request.reportName,
    accountingBasis: accountingMethod,
    periodStart: request.periodStart,
    periodEnd: request.periodEnd,
    asOfDate: request.asOfDate ?? request.periodEnd,
    currencyCode: request.currencyCode
  });
  if (primarySnapshot === undefined && request.reportName !== "profit_and_loss") {
    throw new Error(
      `Missing primary report snapshot for ${request.reportName} ${accountingMethod} ${request.periodStart} through ${request.periodEnd}`
    );
  }
  const primaryReport = primarySnapshot === undefined
    ? synthesizePrimaryReportFromColumns(request, accountingMethod, amountColumns)
    : builtReportFromStoredSnapshot(primarySnapshot);

  return {
    reportName: request.reportName,
    accountingMethod,
    displayColumnsBy,
    primaryReport,
    amountColumns,
    calculationColumns: presentationCalculationColumns(request, amountColumns.map((entry) => entry.column))
  };
}

type RollupDimensionDisplayColumnsBy = Extract<
  StandardReportDisplayColumnsBy,
  "customer" | "employee" | "product_service" | "vendor"
>;

type RollupPresentationGroup = {
  readonly groupKey: string;
  readonly groupLabel: string;
  readonly column: StandardReportPresentationColumn;
};

export type RollupPresentationAccountRow = {
  readonly groupKey: string;
  readonly groupLabel: string;
  readonly accountId: string;
  readonly accountNumber?: string;
  readonly accountName: string;
  readonly accountClassification: string;
  readonly parentAccountId?: string;
  readonly parentAccountNumber?: string;
  readonly parentAccountName?: string;
  readonly parentAccountClassification?: string;
  readonly debitAmount: DecimalString;
  readonly creditAmount: DecimalString;
  readonly netAmount: DecimalString;
  readonly postingCount: number;
  readonly generatedAt: IsoDateTime;
  readonly sourcePostingMaxUpdatedAt?: IsoDateTime;
  readonly importBatchId?: string;
};

function isRollupDimensionDisplayColumnsBy(
  displayColumnsBy: StandardReportDisplayColumnsBy
): displayColumnsBy is RollupDimensionDisplayColumnsBy {
  return (
    displayColumnsBy === "customer" ||
    displayColumnsBy === "employee" ||
    displayColumnsBy === "product_service" ||
    displayColumnsBy === "vendor"
  );
}

async function loadDimensionStandardReportPresentationFromRollups(
  client: PostgresQueryClient,
  manifest: PostgresSchemaManifest,
  request: StandardReportPresentationReadModelRequest,
  accountingMethod: StandardReportAccountingMethod,
  displayColumnsBy: RollupDimensionDisplayColumnsBy
): Promise<StandardReportPresentationReportSet> {
  const rows = await loadRollupPresentationAccountRows(client, manifest, request, accountingMethod, displayColumnsBy);
  const accounts = await loadRollupPresentationAccounts(client, manifest, request, rows);
  const groups = rollupPresentationGroups(request, displayColumnsBy, rows);
  const rowsByGroupKey = groupRollupPresentationRows(rows);
  const amountColumns = groups.map((group): StandardReportPresentationReportColumn => ({
    column: group.column,
    report: profitAndLossReportFromRollupRows(request, accountingMethod, group, accounts, rowsByGroupKey.get(group.groupKey) ?? [])
  }));
  const primarySnapshot = await loadLatestReportSnapshot(client, manifest, {
    tenantId: request.tenantId,
    companyId: request.companyId,
    sourceId: request.sourceId,
    reportName: request.reportName,
    accountingBasis: accountingMethod,
    periodStart: request.periodStart,
    periodEnd: request.periodEnd,
    asOfDate: request.asOfDate ?? request.periodEnd,
    currencyCode: request.currencyCode
  });
  const primaryReport =
    primarySnapshot === undefined
      ? synthesizePrimaryReportFromColumns(request, accountingMethod, amountColumns)
      : builtReportFromStoredSnapshot(primarySnapshot);

  return {
    reportName: request.reportName,
    accountingMethod,
    displayColumnsBy,
    primaryReport,
    amountColumns,
    calculationColumns: presentationCalculationColumns(request, amountColumns.map((entry) => entry.column))
  };
}

async function loadRollupPresentationAccountRows(
  client: PostgresQueryClient,
  manifest: PostgresSchemaManifest,
  request: StandardReportPresentationReadModelRequest,
  accountingMethod: StandardReportAccountingMethod,
  displayColumnsBy: RollupDimensionDisplayColumnsBy
): Promise<readonly RollupPresentationAccountRow[]> {
  const bucketGrain = presentationRollupBucketGrain(request);
  const parameters: unknown[] = [
    request.tenantId,
    request.companyId,
    request.sourceId,
    accountingMethod,
    bucketGrain,
    request.periodStart,
    request.periodEnd,
    request.currencyCode,
    [...PROFIT_AND_LOSS_SECTION_ORDER]
  ];
  const groupKeySql = displayColumnsBy === "product_service" ? 'rb."item_id"' : 'rb."party_id"';
  const groupLabelSql =
    displayColumnsBy === "product_service"
      ? 'coalesce(nullif(i."name", \'\'), rb."item_id")'
      : 'coalesce(nullif(p."display_name", \'\'), rb."party_id")';
  const groupFilterSql =
    displayColumnsBy === "product_service"
      ? 'rb."item_id" <> \'\''
      : `rb."party_type" = $${String(parameters.push(displayColumnsBy))} and rb."party_id" <> ''`;

  const result = await client.query<Row>(
    `select ${groupKeySql} as "group_key",
       ${groupLabelSql} as "group_label",
       rb."account_id",
       a."parent_account_id",
       a."account_number",
       a."name" as "account_name",
       a."classification" as "account_classification",
       pa."account_number" as "parent_account_number",
       pa."name" as "parent_account_name",
       pa."classification" as "parent_account_classification",
       sum(rb."debit_amount")::text as "debit_amount",
       sum(rb."credit_amount")::text as "credit_amount",
       sum(rb."net_amount")::text as "net_amount",
       sum(rb."posting_count")::int as "posting_count",
       max(rb."generated_at")::text as "generated_at",
       max(rb."source_posting_max_updated_at")::text as "source_posting_max_updated_at",
       max(nullif(rb."import_batch_id", '')) as "import_batch_id"
from ${qualifiedTable(manifest, "rollup_buckets")} rb
join ${qualifiedTable(manifest, "accounts")} a
  on a."tenant_id" = rb."tenant_id"
  and a."source_id" = rb."source_id"
  and a."account_id" = rb."account_id"
left join ${qualifiedTable(manifest, "accounts")} pa
  on pa."tenant_id" = a."tenant_id"
  and pa."source_id" = a."source_id"
  and pa."account_id" = a."parent_account_id"
left join ${qualifiedTable(manifest, "parties")} p
  on p."tenant_id" = rb."tenant_id"
  and p."source_id" = rb."source_id"
  and p."party_id" = rb."party_id"
left join ${qualifiedTable(manifest, "items")} i
  on i."tenant_id" = rb."tenant_id"
  and i."source_id" = rb."source_id"
  and i."item_id" = rb."item_id"
where rb."tenant_id" = $1
  and rb."company_id" = $2
  and rb."source_id" = $3
  and rb."accounting_basis" = $4
  and rb."bucket_grain" = $5
  and rb."bucket_start" >= $6::date
  and rb."bucket_end" <= $7::date
  and rb."currency_code" = $8
  and a."classification" = any($9::text[])
  and ${groupFilterSql}
group by "group_key", "group_label", rb."account_id", a."parent_account_id", a."account_number", a."name", a."classification", pa."account_number", pa."name", pa."classification"
having sum(rb."posting_count") > 0
order by lower("group_label"), "group_key", min(array_position($9::text[], a."classification")), a."account_number" nulls last, a."name", rb."account_id"`,
    parameters
  );

  return result.rows.map(rollupPresentationAccountRowFromRow);
}

async function loadRollupPresentationAccounts(
  client: PostgresQueryClient,
  manifest: PostgresSchemaManifest,
  request: StandardReportPresentationReadModelRequest,
  rows: readonly RollupPresentationAccountRow[]
): Promise<readonly Account[]> {
  const accountIds = uniqueStrings(rows.map((row) => row.accountId));

  if (accountIds.length === 0) {
    return [];
  }

  const result = await client.query<Row>(
    `with recursive "relevant_accounts" as (
  select a."account_id", a."tenant_id", a."source_id", a."source_account_id", a."account_number", a."name", a."type", a."subtype", a."classification", a."parent_account_id", a."currency_code", a."active"
  from ${qualifiedTable(manifest, "accounts")} a
  where a."tenant_id" = $1
    and a."source_id" = $2
    and a."account_id" = any($3::text[])
  union
  select pa."account_id", pa."tenant_id", pa."source_id", pa."source_account_id", pa."account_number", pa."name", pa."type", pa."subtype", pa."classification", pa."parent_account_id", pa."currency_code", pa."active"
  from ${qualifiedTable(manifest, "accounts")} pa
  join "relevant_accounts" child
    on pa."tenant_id" = child."tenant_id"
    and pa."source_id" = child."source_id"
    and pa."account_id" = child."parent_account_id"
)
select "account_id", "tenant_id", "source_id", "source_account_id", "account_number", "name", "type", "subtype", "classification", "parent_account_id", "currency_code", "active"
from "relevant_accounts"
where "classification" = any($4::text[])
order by array_position($4::text[], "classification"), "account_number" nulls last, "name", "account_id"`,
    [request.tenantId, request.sourceId, accountIds, [...PROFIT_AND_LOSS_SECTION_ORDER]]
  );

  return result.rows.map(accountFromRow);
}

function presentationRollupBucketGrain(request: StandardReportPresentationReadModelRequest): RollupBucketGrain {
  const start = parseIsoDate(request.periodStart);
  const end = parseIsoDate(request.periodEnd);
  const startsCalendarMonth = start.getUTCDate() === 1;
  const endsCalendarMonth = end.getTime() === new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getTime();

  return startsCalendarMonth && endsCalendarMonth ? "month" : "day";
}

export function rollupPresentationAccountRowFromRow(row: Row): RollupPresentationAccountRow {
  const accountNumber = optionalString(row.account_number);
  const parentAccountId = optionalString(row.parent_account_id);
  const parentAccountNumber = optionalString(row.parent_account_number);
  const parentAccountName = optionalString(row.parent_account_name);
  const parentAccountClassification = optionalString(row.parent_account_classification);
  const sourcePostingMaxUpdatedAt = optionalIsoDateTime(row.source_posting_max_updated_at);
  const importBatchId = optionalString(row.import_batch_id);

  return {
    groupKey: requiredString(row.group_key, "group_key"),
    groupLabel: requiredString(row.group_label, "group_label"),
    accountId: requiredString(row.account_id, "account_id"),
    ...(accountNumber === undefined ? {} : { accountNumber }),
    accountName: requiredString(row.account_name, "account_name"),
    accountClassification: requiredString(row.account_classification, "account_classification"),
    ...(parentAccountId === undefined ? {} : { parentAccountId }),
    ...(parentAccountNumber === undefined ? {} : { parentAccountNumber }),
    ...(parentAccountName === undefined ? {} : { parentAccountName }),
    ...(parentAccountClassification === undefined ? {} : { parentAccountClassification }),
    debitAmount: requiredString(row.debit_amount, "debit_amount"),
    creditAmount: requiredString(row.credit_amount, "credit_amount"),
    netAmount: requiredString(row.net_amount, "net_amount"),
    postingCount: requiredNumber(row.posting_count, "posting_count"),
    generatedAt: isoDateTime(row.generated_at, "generated_at"),
    ...(sourcePostingMaxUpdatedAt === undefined ? {} : { sourcePostingMaxUpdatedAt }),
    ...(importBatchId === undefined ? {} : { importBatchId })
  };
}

function rollupPresentationGroups(
  request: StandardReportPresentationReadModelRequest,
  displayColumnsBy: RollupDimensionDisplayColumnsBy,
  rows: readonly RollupPresentationAccountRow[]
): readonly RollupPresentationGroup[] {
  const groupsByKey = new Map<string, string>();

  for (const row of rows) {
    groupsByKey.set(row.groupKey, row.groupLabel);
  }

  return [...groupsByKey.entries()]
    .sort((left, right) => left[1].localeCompare(right[1], "en", { sensitivity: "base" }) || left[0].localeCompare(right[0]))
    .map(([groupKey, groupLabel]) => ({
      groupKey,
      groupLabel,
      column: {
        columnId: `actual:${displayColumnsBy}:${groupKey}`,
        label: groupLabel,
        kind: "actual",
        periodStart: request.periodStart,
        periodEnd: request.periodEnd,
        asOfDate: request.asOfDate ?? request.periodEnd,
        displayColumnsBy,
        groupKey
      }
    }));
}

function groupRollupPresentationRows(
  rows: readonly RollupPresentationAccountRow[]
): ReadonlyMap<string, readonly RollupPresentationAccountRow[]> {
  const rowsByGroupKey = new Map<string, RollupPresentationAccountRow[]>();

  for (const row of rows) {
    const existing = rowsByGroupKey.get(row.groupKey);
    if (existing === undefined) {
      rowsByGroupKey.set(row.groupKey, [row]);
    } else {
      existing.push(row);
    }
  }

  return rowsByGroupKey;
}

function profitAndLossReportFromRollupRows(
  request: StandardReportPresentationReadModelRequest,
  accountingMethod: StandardReportAccountingMethod,
  group: RollupPresentationGroup,
  accounts: readonly Account[],
  rows: readonly RollupPresentationAccountRow[]
): BuiltReport {
  const reportSnapshotId = [
    "snapshot",
    request.tenantId,
    request.companyId,
    request.sourceId,
    request.reportName,
    "rollup",
    accountingMethod,
    request.periodStart,
    request.periodEnd,
    request.asOfDate ?? request.periodEnd,
    request.currencyCode,
    group.groupKey
  ].join(":");
  const lineRows = rows
    .filter((row) => PROFIT_AND_LOSS_SECTION_ORDER.includes(row.accountClassification as (typeof PROFIT_AND_LOSS_SECTION_ORDER)[number]))
    .map((row) => ({
      row,
      amountMinor: profitAndLossAmount(row)
    }))
    .filter((entry) => entry.amountMinor !== 0n);
  const directAmounts: AccountHierarchyRollupLineAmount[] = lineRows.map((entry) => ({
    accountId: entry.row.accountId,
    amount: formatMoney(entry.amountMinor),
    section: entry.row.accountClassification,
    sourceRefs: [rollupPresentationSourceRef(request, group, entry.row)]
  }));
  const lines = buildAccountHierarchyRollupLines({
    tenantId: request.tenantId,
    sourceId: request.sourceId,
    reportSnapshotId,
    reportName: request.reportName,
    accounts,
    accountAmounts: directAmounts,
    sectionOrder: PROFIT_AND_LOSS_SECTION_ORDER,
    drilldownQuery: {
      sourceId: request.sourceId,
      accountingBasis: accountingMethod,
      periodStart: request.periodStart,
      periodEnd: request.periodEnd
    }
  });
  const totalIncome = sumDirectSection(lineRows, "income");
  const totalCostOfGoodsSold = sumDirectSection(lineRows, "cost_of_goods_sold");
  const grossProfit = totalIncome - totalCostOfGoodsSold;
  const totalExpenses = sumDirectSection(lineRows, "expense");
  const netOperatingIncome = grossProfit - totalExpenses;
  const totalOtherIncome = sumDirectSection(lineRows, "other_income");
  const totalOtherExpense = sumDirectSection(lineRows, "other_expense");
  const netIncome = netOperatingIncome + totalOtherIncome - totalOtherExpense;
  const sectionDrilldowns = (section: string): readonly DrilldownRef[] =>
    lines.filter((line) => line.section === section).map((line) => line.drilldownRef);
  const totalIncomeRow = profitAndLossTotal(
    request,
    reportSnapshotId,
    group.groupKey,
    "total_income",
    "Total Income",
    totalIncome,
    sectionDrilldowns("income")
  );
  const totalCostOfGoodsSoldRow = profitAndLossTotal(
    request,
    reportSnapshotId,
    group.groupKey,
    "total_cost_of_goods_sold",
    "Total Cost of Goods Sold",
    totalCostOfGoodsSold,
    sectionDrilldowns("cost_of_goods_sold")
  );
  const grossProfitRow = profitAndLossTotal(
    request,
    reportSnapshotId,
    group.groupKey,
    "gross_profit",
    "Gross Profit",
    grossProfit,
    [totalIncomeRow.drilldownRef, totalCostOfGoodsSoldRow.drilldownRef]
  );
  const totalExpensesRow = profitAndLossTotal(
    request,
    reportSnapshotId,
    group.groupKey,
    "total_expenses",
    "Total Expenses",
    totalExpenses,
    sectionDrilldowns("expense")
  );
  const netOperatingIncomeRow = profitAndLossTotal(
    request,
    reportSnapshotId,
    group.groupKey,
    "net_operating_income",
    "Net Operating Income",
    netOperatingIncome,
    [grossProfitRow.drilldownRef, totalExpensesRow.drilldownRef]
  );
  const totalOtherIncomeRow = profitAndLossTotal(
    request,
    reportSnapshotId,
    group.groupKey,
    "total_other_income",
    "Total Other Income",
    totalOtherIncome,
    sectionDrilldowns("other_income")
  );
  const totalOtherExpenseRow = profitAndLossTotal(
    request,
    reportSnapshotId,
    group.groupKey,
    "total_other_expense",
    "Total Other Expense",
    totalOtherExpense,
    sectionDrilldowns("other_expense")
  );
  const netIncomeRow = profitAndLossTotal(
    request,
    reportSnapshotId,
    group.groupKey,
    "net_income",
    "Net Income",
    netIncome,
    [netOperatingIncomeRow.drilldownRef, totalOtherIncomeRow.drilldownRef, totalOtherExpenseRow.drilldownRef]
  );
  const totals = [
    totalIncomeRow,
    totalCostOfGoodsSoldRow,
    grossProfitRow,
    totalExpensesRow,
    netOperatingIncomeRow,
    totalOtherIncomeRow,
    totalOtherExpenseRow,
    netIncomeRow
  ];
  const generatedAt =
    rows
      .map((row) => row.generatedAt)
      .sort()
      .at(-1) ?? "1970-01-01T00:00:00.000Z";

  return {
    snapshot: {
      reportSnapshotId,
      tenantId: request.tenantId,
      companyId: request.companyId,
      sourceId: request.sourceId,
      reportName: request.reportName,
      snapshotSource: "rollup",
      accountingBasis: accountingMethod,
      periodStart: request.periodStart,
      periodEnd: request.periodEnd,
      asOfDate: request.asOfDate ?? request.periodEnd,
      currencyCode: request.currencyCode,
      generatedAt,
      freshness: { status: "unknown", sourceId: request.sourceId },
      reconciliationStatus: "not_reconciled",
      reconciliationDifference: "0.00"
    },
    lines,
    totals,
    metadata: {
      reportName: request.reportName,
      generatedFrom: "rollup_buckets",
      reconciliationStatus: "not_reconciled",
      reconciliationDifference: "0.00"
    }
  };
}

function rollupPresentationSourceRef(
  request: StandardReportPresentationReadModelRequest,
  group: RollupPresentationGroup,
  row: RollupPresentationAccountRow
): SafeSourcePayloadRef {
  return {
    sourceObjectType: "RollupBucketAggregate",
    sourceObjectId: [
      request.reportName,
      request.accountingMethod ?? "accrual",
      request.periodStart,
      request.periodEnd,
      request.currencyCode,
      group.groupKey,
      row.accountId
    ].join(":"),
    ...(row.sourcePostingMaxUpdatedAt === undefined ? {} : { sourceUpdatedAt: row.sourcePostingMaxUpdatedAt }),
    preview: {
      groupKey: group.groupKey,
      groupLabel: group.groupLabel,
      accountId: row.accountId,
      postingCount: row.postingCount,
      generatedAt: row.generatedAt,
      ...(row.importBatchId === undefined ? {} : { importBatchId: row.importBatchId })
    }
  };
}

function profitAndLossAmount(row: RollupPresentationAccountRow): bigint {
  const debitMinusCredit = parseMoney(row.debitAmount) - parseMoney(row.creditAmount);

  return row.accountClassification === "income" || row.accountClassification === "other_income"
    ? -debitMinusCredit
    : debitMinusCredit;
}

function sumDirectSection(
  lineRows: readonly { readonly row: RollupPresentationAccountRow; readonly amountMinor: bigint }[],
  section: string
): bigint {
  return lineRows.filter((entry) => entry.row.accountClassification === section).reduce((sum, entry) => sum + entry.amountMinor, 0n);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function mergedDrilldownPostingIds(refs: readonly DrilldownRef[]): string[] {
  return uniqueStrings(refs.flatMap((ref) => ref.postingIds ?? []));
}

function mergedDrilldownAccountIds(refs: readonly DrilldownRef[]): string[] {
  return uniqueStrings(refs.flatMap((ref) => ref.accountIds ?? ref.query?.accountIds ?? []));
}

function mergedDrilldownSourceRefs(refs: readonly DrilldownRef[]): SafeSourcePayloadRef[] {
  const byKey = new Map<string, SafeSourcePayloadRef>();

  for (const sourceRef of refs.flatMap((ref) => ref.sourceRefs ?? [])) {
    assertSafeSourcePayloadRef(sourceRef);
    byKey.set(
      [
        sourceRef.sourceObjectType,
        sourceRef.sourceObjectId,
        sourceRef.storageRef ?? "",
        sourceRef.checksum ?? "",
        sourceRef.sourceUpdatedAt ?? ""
      ].join(":"),
      sourceRef
    );
  }

  return [...byKey.values()].sort((left, right) =>
    [left.sourceObjectType, left.sourceObjectId, left.storageRef ?? "", left.checksum ?? ""]
      .join(":")
      .localeCompare([right.sourceObjectType, right.sourceObjectId, right.storageRef ?? "", right.checksum ?? ""].join(":"))
  );
}

function profitAndLossTotal(
  request: StandardReportPresentationReadModelRequest,
  reportSnapshotId: string,
  groupKey: string,
  totalKey: string,
  label: string,
  amountMinor: bigint,
  drilldownRefs: readonly DrilldownRef[]
): ReportSnapshotTotal {
  const accountIds = mergedDrilldownAccountIds(drilldownRefs);
  const sourceRefs = mergedDrilldownSourceRefs(drilldownRefs);

  return {
    tenantId: request.tenantId,
    reportSnapshotId,
    reportTotalId: `profit_and_loss:total:${groupKey}:${totalKey}`,
    totalKey,
    label,
    amount: formatMoney(amountMinor),
    drilldownRef: createCompactDrilldownRef({
      token: `${request.reportName}:${groupKey}:${totalKey}`,
      postingIds: mergedDrilldownPostingIds(drilldownRefs),
      ...(accountIds.length === 0 ? {} : { accountIds }),
      query: {
        kind: "ledger_postings",
        tenantId: request.tenantId,
        sourceId: request.sourceId,
        accountingBasis: request.accountingMethod ?? "accrual",
        periodStart: request.periodStart,
        periodEnd: request.periodEnd,
        ...(accountIds.length === 0 ? {} : { accountIds })
      },
      ...(sourceRefs.length === 0 ? {} : { sourceRefs })
    })
  };
}

type PresentationSnapshotGroup = {
  readonly periodStart: IsoDate;
  readonly periodEnd: IsoDate;
  readonly asOfDate: IsoDate;
  readonly column: StandardReportPresentationColumn;
};

function presentationSnapshotGroups(
  request: StandardReportPresentationReadModelRequest,
  displayColumnsBy: StandardReportDisplayColumnsBy
): readonly PresentationSnapshotGroup[] {
  if (displayColumnsBy === "none") {
    return [
      {
        periodStart: request.periodStart,
        periodEnd: request.periodEnd,
        asOfDate: request.asOfDate ?? request.periodEnd,
        column: {
          columnId: "actual:none:total",
          label: "Total",
          kind: "actual",
          periodStart: request.periodStart,
          periodEnd: request.periodEnd,
          asOfDate: request.asOfDate ?? request.periodEnd,
          displayColumnsBy,
          groupKey: "total"
        }
      }
    ];
  }

  const grain = dateGrainForDisplayColumnsBy(displayColumnsBy);
  if (grain === undefined) {
    throw new Error(`Snapshot-backed standard presentation does not support ${displayColumnsBy} columns`);
  }

  const groups: PresentationSnapshotGroup[] = [];
  let cursor = parseIsoDate(request.periodStart);
  const end = parseIsoDate(request.periodEnd);

  while (cursor.getTime() <= end.getTime()) {
    const start = cursor;
    const periodEndDate = minDate(end, endOfPresentationGrain(start, grain, request));
    const periodStart = formatIsoDate(start);
    const periodEnd = formatIsoDate(periodEndDate);
    const key = `${grain}:${periodStart}:${periodEnd}`;

    groups.push({
      periodStart,
      periodEnd,
      asOfDate: periodEnd,
      column: {
        columnId: `actual:${displayColumnsBy}:${key}`,
        label: presentationDateGroupLabel(start, periodEndDate, grain),
        kind: "actual",
        periodStart,
        periodEnd,
        asOfDate: periodEnd,
        displayColumnsBy,
        groupKey: key
      }
    });
    cursor = addDays(periodEndDate, 1);
  }

  return groups;
}

function dateGrainForDisplayColumnsBy(
  displayColumnsBy: StandardReportDisplayColumnsBy
): "day" | "week" | "month" | "quarter" | "year" | undefined {
  switch (displayColumnsBy) {
    case "days":
      return "day";
    case "weeks":
      return "week";
    case "months":
      return "month";
    case "quarters":
      return "quarter";
    case "years":
      return "year";
    case "none":
    case "customer":
    case "employee":
    case "product_service":
    case "vendor":
      return undefined;
  }
}

function presentationCalculationColumns(
  request: StandardReportPresentationReadModelRequest,
  amountColumns: readonly StandardReportPresentationColumn[]
): readonly StandardReportPresentationColumn[] {
  return (request.compareTo?.calculations ?? []).map((calculation) => ({
    columnId: `calculation:${calculation}`,
    label: presentationCalculationLabel(calculation),
    kind: "calculation",
    periodStart: request.periodStart,
    periodEnd: request.periodEnd,
    asOfDate: request.asOfDate ?? request.periodEnd,
    displayColumnsBy: "none",
    calculation,
    groupKey: amountColumns.map((column) => column.columnId).join(",")
  }));
}

function presentationCalculationLabel(calculation: StandardReportPresentationColumn["calculation"]): string {
  switch (calculation) {
    case "percent_of_row":
      return "% of Row";
    case "percent_of_column":
      return "% of Column";
    case "percent_of_expense":
      return "% of Expense";
    case "percent_of_income":
      return "% of Income";
    case undefined:
      return "";
  }
}

function builtReportFromStoredSnapshot(stored: StoredReportSnapshot): BuiltReport {
  const reportName = stored.snapshot.reportName as ReportName;
  return {
    snapshot: stored.snapshot,
    lines: stored.lines,
    totals: stored.totals,
    metadata: {
      reportName,
      generatedFrom: stored.snapshot.snapshotSource === "rollup" ? "rollup_buckets" : "report_snapshot",
      reconciliationStatus: stored.snapshot.reconciliationStatus,
      reconciliationDifference: stored.snapshot.reconciliationDifference
    }
  };
}

function synthesizePrimaryReportFromColumns(
  request: StandardReportPresentationReadModelRequest,
  accountingMethod: StandardReportAccountingMethod,
  amountColumns: readonly StandardReportPresentationReportColumn[]
): BuiltReport {
  if (amountColumns.length === 0) {
    throw new Error("Cannot synthesize a standard presentation primary report without amount columns");
  }

  const reportSnapshotId = [
    "snapshot",
    request.tenantId,
    request.companyId,
    request.sourceId,
    request.reportName,
    "rollup",
    accountingMethod,
    request.periodStart,
    request.periodEnd,
    request.asOfDate ?? request.periodEnd,
    request.currencyCode,
    "presentation"
  ].join(":");
  const lineAggregates = new Map<string, ReportLineAggregate>();
  const totalAggregates = new Map<string, ReportTotalAggregate>();

  for (const entry of amountColumns) {
    for (const line of entry.report.lines) {
      const key = line.accountId ?? line.reportLineId;
      const existing = lineAggregates.get(key);
      if (existing === undefined) {
        lineAggregates.set(key, {
          template: line,
          amountMinor: parseMoney(line.amount),
          sortOrder: line.sortOrder,
          postingIds: [...(line.drilldownRef.postingIds ?? [])],
          sourceRefs: [...(line.drilldownRef.sourceRefs ?? [])]
        });
      } else {
        existing.amountMinor += parseMoney(line.amount);
        existing.sortOrder = Math.min(existing.sortOrder, line.sortOrder);
        existing.postingIds.push(...(line.drilldownRef.postingIds ?? []));
        existing.sourceRefs.push(...(line.drilldownRef.sourceRefs ?? []));
      }
    }
    for (const total of entry.report.totals) {
      const existing = totalAggregates.get(total.totalKey);
      if (existing === undefined) {
        totalAggregates.set(total.totalKey, {
          template: total,
          amountMinor: parseMoney(total.amount),
          postingIds: [...(total.drilldownRef.postingIds ?? [])],
          accountIds: [...(total.drilldownRef.accountIds ?? total.drilldownRef.query?.accountIds ?? [])],
          sourceRefs: [...(total.drilldownRef.sourceRefs ?? [])]
        });
      } else {
        existing.amountMinor += parseMoney(total.amount);
        existing.postingIds.push(...(total.drilldownRef.postingIds ?? []));
        existing.accountIds.push(...(total.drilldownRef.accountIds ?? total.drilldownRef.query?.accountIds ?? []));
        existing.sourceRefs.push(...(total.drilldownRef.sourceRefs ?? []));
      }
    }
  }

  const sourceReports = amountColumns.map((entry) => entry.report);
  const freshnessStatuses = sourceReports.map((report) => report.snapshot.freshness.status);
  const freshness: ReportFreshness =
    freshnessStatuses.every((status) => status === "fresh")
      ? { status: "fresh", sourceId: request.sourceId }
      : freshnessStatuses.some((status) => status === "stale")
        ? { status: "stale", sourceId: request.sourceId, staleReason: "presentation_columns_include_stale_snapshot" }
        : { status: "unknown", sourceId: request.sourceId };
  const generatedAt = sourceReports
    .map((report) => report.snapshot.generatedAt)
    .sort()
    .at(-1) ?? "1970-01-01T00:00:00.000Z";
  const reconciliationDifference = formatMoney(
    sourceReports.reduce((sum, report) => sum + parseMoney(report.snapshot.reconciliationDifference), 0n)
  );

  return {
    snapshot: {
      reportSnapshotId,
      tenantId: request.tenantId,
      companyId: request.companyId,
      sourceId: request.sourceId,
      reportName: request.reportName,
      snapshotSource: "rollup",
      accountingBasis: accountingMethod,
      periodStart: request.periodStart,
      periodEnd: request.periodEnd,
      asOfDate: request.asOfDate ?? request.periodEnd,
      currencyCode: request.currencyCode,
      generatedAt,
      freshness,
      reconciliationStatus: sourceReports.every((report) => report.snapshot.reconciliationStatus === "balanced")
        ? "balanced"
        : "not_reconciled",
      reconciliationDifference
    },
    lines: [...lineAggregates.entries()]
      .sort(
        ([, left], [, right]) =>
          profitAndLossSectionIndex(left.template.section) - profitAndLossSectionIndex(right.template.section) ||
          left.sortOrder - right.sortOrder ||
          left.template.label.localeCompare(right.template.label)
      )
      .map(([key, aggregate], index) => ({
        ...aggregate.template,
        tenantId: request.tenantId,
        reportSnapshotId,
        reportLineId:
          aggregate.template.accountId === undefined
            ? `${reportSnapshotId}:line:${key}`
            : `${reportSnapshotId}:line:account:${key}`,
        ...(aggregate.template.parentReportLineId === undefined
          ? {}
          : {
              parentReportLineId: `${reportSnapshotId}:line:${
                aggregate.template.parentReportLineId.split(":line:").at(-1) ?? aggregate.template.parentReportLineId
              }`
            }),
        amount: formatMoney(aggregate.amountMinor),
        sortOrder: (index + 1) * 10,
        drilldownRef: createCompactDrilldownRef({
          token: `${request.reportName}:${key}`,
          postingIds: aggregate.postingIds,
          ...(aggregate.template.accountId === undefined ? {} : { accountIds: accountIdsForLineAggregate(aggregate) }),
          query: {
            kind: "ledger_postings",
            tenantId: request.tenantId,
            sourceId: request.sourceId,
            accountingBasis: accountingMethod,
            periodStart: request.periodStart,
            periodEnd: request.periodEnd,
            ...(aggregate.template.accountId === undefined ? {} : { accountIds: accountIdsForLineAggregate(aggregate) })
          },
          sourceRefs: aggregate.sourceRefs
        })
      })),
    totals: [...totalAggregates.entries()].map(([key, aggregate]) => {
      const accountIds = uniqueStrings(aggregate.accountIds);
      return {
        ...aggregate.template,
        tenantId: request.tenantId,
        reportSnapshotId,
        reportTotalId: `${reportSnapshotId}:total:${key}`,
        amount: formatMoney(aggregate.amountMinor),
        drilldownRef: createCompactDrilldownRef({
          token: `${request.reportName}:${key}`,
          postingIds: aggregate.postingIds,
          ...(accountIds.length === 0 ? {} : { accountIds }),
          query: {
            kind: "ledger_postings",
            tenantId: request.tenantId,
            sourceId: request.sourceId,
            accountingBasis: accountingMethod,
            periodStart: request.periodStart,
            periodEnd: request.periodEnd,
            ...(accountIds.length === 0 ? {} : { accountIds })
          },
          sourceRefs: aggregate.sourceRefs
        })
      };
    }),
    metadata: {
      reportName: request.reportName,
      generatedFrom: "rollup_buckets",
      reconciliationStatus: sourceReports.every((report) => report.snapshot.reconciliationStatus === "balanced")
        ? "balanced"
        : "not_reconciled",
      reconciliationDifference
    }
  };
}

type ReportLineAggregate = {
  readonly template: ReportSnapshotLine;
  amountMinor: bigint;
  sortOrder: number;
  readonly postingIds: string[];
  readonly sourceRefs: SafeSourcePayloadRef[];
};

function accountIdsForLineAggregate(aggregate: ReportLineAggregate): readonly string[] {
  return aggregate.template.drilldownRef.accountIds ?? (aggregate.template.accountId === undefined ? [] : [aggregate.template.accountId]);
}

type ReportTotalAggregate = {
  readonly template: ReportSnapshotTotal;
  amountMinor: bigint;
  readonly postingIds: string[];
  readonly accountIds: string[];
  readonly sourceRefs: SafeSourcePayloadRef[];
};

function profitAndLossSectionIndex(section: string): number {
  const index = PROFIT_AND_LOSS_SECTION_ORDER.indexOf(section as (typeof PROFIT_AND_LOSS_SECTION_ORDER)[number]);
  return index === -1 ? PROFIT_AND_LOSS_SECTION_ORDER.length : index;
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

function addDays(date: Date, days: number): Date {
  const result = new Date(date.getTime());
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function minDate(left: Date, right: Date): Date {
  return left.getTime() <= right.getTime() ? left : right;
}

function endOfPresentationGrain(
  date: Date,
  grain: "day" | "week" | "month" | "quarter" | "year",
  request: StandardReportPresentationReadModelRequest
): Date {
  switch (grain) {
    case "day":
      return date;
    case "week": {
      const weekStartsOn = request.weekStartsOn ?? 0;
      const dayOffset = (date.getUTCDay() - weekStartsOn + 7) % 7;
      return addDays(date, 6 - dayOffset);
    }
    case "month":
      return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
    case "quarter": {
      const quarterStartMonth = Math.floor(date.getUTCMonth() / 3) * 3;
      return new Date(Date.UTC(date.getUTCFullYear(), quarterStartMonth + 3, 0));
    }
    case "year":
      return new Date(Date.UTC(date.getUTCFullYear() + 1, 0, 0));
  }
}

function presentationDateGroupLabel(start: Date, end: Date, grain: "day" | "week" | "month" | "quarter" | "year"): string {
  if (grain === "day") {
    return formatIsoDate(start);
  }
  if (grain === "month") {
    return `${String(start.getUTCMonth() + 1).padStart(2, "0")}/${String(start.getUTCFullYear())}`;
  }
  if (grain === "quarter") {
    return `Q${String(Math.floor(start.getUTCMonth() / 3) + 1)} ${String(start.getUTCFullYear())}`;
  }
  if (grain === "year") {
    return String(start.getUTCFullYear());
  }

  return `${formatIsoDate(start)} - ${formatIsoDate(end)}`;
}

function parseMoney(value: DecimalString): bigint {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (match === null || match[2] === undefined) {
    throw new Error(`Decimal value must have at most two fractional digits: ${value}`);
  }
  const sign = match[1] === "-" ? -1n : 1n;
  const whole = BigInt(match[2]);
  const fraction = BigInt((match[3] ?? "").padEnd(2, "0"));
  return sign * (whole * 100n + fraction);
}

function formatMoney(value: bigint): DecimalString {
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  const whole = absolute / 100n;
  const fraction = absolute % 100n;
  return `${sign}${whole.toString()}.${fraction.toString().padStart(2, "0")}`;
}

function appendRollupBucketTextFilter(
  filters: string[],
  parameters: unknown[],
  columnName: string,
  singularValue: string | undefined,
  pluralValues: readonly string[] | undefined
): void {
  const values = uniqueDefinedValues(singularValue, pluralValues);
  if (values === undefined) {
    return;
  }
  if (values.length === 0) {
    filters.push("false");
    return;
  }

  parameters.push(values);
  filters.push(`"${columnName}" = any($${String(parameters.length)}::text[])`);
}

function uniqueDefinedValues(singularValue: string | undefined, pluralValues: readonly string[] | undefined): readonly string[] | undefined {
  if (singularValue === undefined && pluralValues === undefined) {
    return undefined;
  }

  return [...new Set([...(singularValue === undefined ? [] : [singularValue]), ...(pluralValues ?? [])])];
}

async function replaceRollupBucketsForWindows(
  client: PostgresQueryClient,
  manifest: PostgresSchemaManifest,
  input: ReplaceRollupBucketsForWindowsInput
): Promise<ReplaceRollupBucketsForWindowsResult> {
  for (const bucket of input.buckets) {
    assertLedgerPostingAmounts(bucket);
  }

  const deleted = await deleteRollupBucketsForWindows(client, manifest, input.windows);
  const upserted = await upsertRows(client, manifest, "rollup_buckets", input.buckets.map(rollupBucketRow), [
    "tenant_id",
    "company_id",
    "source_id",
    "accounting_basis",
    "bucket_grain",
    "bucket_start",
    "bucket_end",
    "account_id",
    "currency_code",
    "dimension_hash",
    "party_id",
    "party_type",
    "item_id"
  ]);

  return { deleted, upserted };
}

async function deleteRollupBucketsForWindows(
  client: PostgresQueryClient,
  manifest: PostgresSchemaManifest,
  windows: readonly RollupReprocessWindow[]
): Promise<number> {
  if (windows.length === 0) {
    return 0;
  }

  const parameters: unknown[] = [];
  const predicates = windows
    .map((window) => {
      const startIndex = parameters.length + 1;
      parameters.push(
        window.tenantId,
        window.companyId,
        window.sourceId,
        window.accountingBasis,
        window.bucketGrain,
        window.bucketStart,
        window.bucketEnd,
        window.currencyCode
      );
      return `("tenant_id" = $${String(startIndex)} and "company_id" = $${String(startIndex + 1)} and "source_id" = $${String(
        startIndex + 2
      )} and "accounting_basis" = $${String(startIndex + 3)} and "bucket_grain" = $${String(
        startIndex + 4
      )} and "bucket_start" = $${String(startIndex + 5)}::date and "bucket_end" = $${String(
        startIndex + 6
      )}::date and "currency_code" = $${String(startIndex + 7)})`;
    })
    .join(" or ");
  const result = await client.query(`delete from ${qualifiedTable(manifest, "rollup_buckets")} where ${predicates}`, parameters);

  return result.rowCount ?? 0;
}

async function pruneMissingSnapshotChildren(
  client: PostgresQueryClient,
  manifest: PostgresSchemaManifest,
  tableName: string,
  tenantId: TenantId,
  companyId: string,
  sourceId: string,
  reportSnapshotId: string,
  idColumn: string,
  retainedIds: readonly string[]
): Promise<void> {
  await client.query(
    `delete from ${qualifiedTable(manifest, tableName)}
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3 and "report_snapshot_id" = $4 and not ("${idColumn}" = any($5::text[]))`,
    [tenantId, companyId, sourceId, reportSnapshotId, retainedIds]
  );
}

async function upsertRows(
  client: PostgresQueryClient,
  manifest: PostgresSchemaManifest,
  tableName: string,
  rows: readonly Row[],
  conflictColumns: readonly string[],
  conflictAction: "update" | "nothing" = "update"
): Promise<number> {
  if (rows.length === 0) {
    return 0;
  }

  const table = tableManifest(manifest, tableName);
  const columns = table.columns.map((column) => column.name);
  const rowsPerBatch = Math.max(1, Math.floor(MAX_UPSERT_PARAMETERS / columns.length));
  let affectedRows = 0;

  for (let start = 0; start < rows.length; start += rowsPerBatch) {
    affectedRows += await upsertRowBatch(
      client,
      manifest,
      tableName,
      table,
      columns,
      rows.slice(start, start + rowsPerBatch),
      conflictColumns,
      conflictAction
    );
  }

  return affectedRows;
}

async function upsertRowBatch(
  client: PostgresQueryClient,
  manifest: PostgresSchemaManifest,
  tableName: string,
  table: PostgresTableManifest,
  columns: readonly string[],
  rows: readonly Row[],
  conflictColumns: readonly string[],
  conflictAction: "update" | "nothing"
): Promise<number> {
  const parameters: unknown[] = [];
  const valuesSql = rows
    .map((row) => {
      validateCredentialFreeRow(tableName, row);
      return `(${columns
        .map((column) => {
          const value = row[column] ?? null;
          const columnManifest = table.columns.find((candidate) => candidate.name === column);
          parameters.push(columnManifest?.type === "jsonb" && value !== null ? JSON.stringify(value) : value);
          return `$${String(parameters.length)}`;
        })
        .join(", ")})`;
    })
    .join(",\n  ");
  const nonConflictColumns = columns.filter((column) => !conflictColumns.includes(column));
  const updateSql =
    conflictAction === "nothing" || nonConflictColumns.length === 0
      ? "do nothing"
      : `do update set ${nonConflictColumns
          .map((column) => `${quoteIdentifier(column)} = excluded.${quoteIdentifier(column)}`)
          .join(", ")}`;
  const sql = `insert into ${qualifiedTable(manifest, tableName)} (${columns.map(quoteIdentifier).join(", ")})
values
  ${valuesSql}
on conflict (${conflictColumns.map(quoteIdentifier).join(", ")}) ${updateSql}`;
  const result = await client.query(sql, parameters);

  return result.rowCount ?? rows.length;
}

async function readCatalogRows(client: PostgresQueryClient, namespace: string): Promise<readonly CatalogRow[]> {
  const result = await client.query<CatalogRow>(
    `select 'schema'::text as object_type, null::text as table_name, schema_name as object_name, null::text as data_type, null::text as is_nullable, null::text as definition, null::boolean as enabled
from information_schema.schemata
where schema_name = $1
union all
select 'table'::text as object_type, table_name, table_name as object_name, null::text as data_type, null::text as is_nullable, null::text as definition, null::boolean as enabled
from information_schema.tables
where table_schema = $1 and table_type = 'BASE TABLE'
union all
select 'column'::text as object_type, table_name, column_name as object_name, data_type, is_nullable, null::text as definition, null::boolean as enabled
from information_schema.columns
where table_schema = $1
union all
select 'index'::text as object_type, tablename as table_name, indexname as object_name, null::text as data_type, null::text as is_nullable, indexdef as definition, null::boolean as enabled
from pg_indexes
where schemaname = $1
union all
select 'constraint'::text as object_type, conrelid::regclass::text as table_name, conname as object_name, null::text as data_type, null::text as is_nullable, pg_get_constraintdef(oid, true) as definition, null::boolean as enabled
from pg_constraint
where connamespace = $1::regnamespace
union all
select 'trigger'::text as object_type, relation.relname as table_name, trigger.tgname as object_name,
  null::text as data_type, null::text as is_nullable, pg_get_triggerdef(trigger.oid, true) as definition,
  trigger.tgenabled <> 'D' as enabled
from pg_trigger trigger
join pg_class relation on relation.oid = trigger.tgrelid
join pg_namespace namespace on namespace.oid = relation.relnamespace
where namespace.nspname = $1 and not trigger.tgisinternal`,
    [namespace]
  );

  return result.rows;
}

function normalizePostgresType(dataType: string): string {
  return dataType === "timestamp with time zone" ? "timestamptz" : dataType;
}

function catalogKey(row: CatalogRow): string {
  if (row.object_type === "column") {
    return `column::${String(row.table_name)}.${row.object_name}`;
  }

  if (row.object_type === "constraint" || row.object_type === "trigger") {
    return `${row.object_type}::${unqualifiedTableName(String(row.table_name))}.${row.object_name}`;
  }

  return `${row.object_type}::${row.object_name}`;
}

function expectedConstraintNames(table: PostgresTableManifest): readonly string[] {
  return [
    `${table.name}_pkey`,
    ...table.constraints.map((constraint) => constraint.name),
    ...table.columns
      .filter((column) => column.type === "jsonb" && column.maxBytes !== undefined)
      .map((column) => `${table.name}_${column.name}_bounded_json_check`)
  ];
}

function indexDefinitionMatches(
  definition: string,
  expectedColumns: readonly string[],
  expectedUnique: boolean,
  expectedWhereSql?: string
): boolean {
  const actualUnique = /\bcreate\s+unique\s+index\b/i.test(definition);
  const columnsMatch = /\(([^()]*)\)\s*(?:where\b.*)?$/i.exec(definition);
  if (columnsMatch?.[1] === undefined || actualUnique !== expectedUnique) {
    return false;
  }
  const actualColumns = columnsMatch[1]
    .split(",")
    .map((column) => column.trim().replaceAll('"', "").split(/\s+/u)[0]);
  const columnsCompatible = actualColumns.length === expectedColumns.length &&
    actualColumns.every((column, index) => column === expectedColumns[index]);
  if (!columnsCompatible) {
    return false;
  }
  const actualWhereSql = /\bwhere\s+(.+)$/iu.exec(definition)?.[1];
  if (expectedWhereSql === undefined) {
    return actualWhereSql === undefined;
  }
  return actualWhereSql !== undefined && normalizeIndexPredicate(actualWhereSql) === normalizeIndexPredicate(expectedWhereSql);
}

function normalizeIndexPredicate(predicate: string): string {
  return predicate.toLowerCase().replaceAll('"', "").replace(/[\s()]/gu, "");
}

function normalizeForeignKeyDefinition(definition: string): string {
  return definition
    .toLowerCase()
    .replaceAll('"', "")
    .replace(/\s+/gu, "")
    .replace(/\bonupdatenoaction\b/gu, "")
    .replace(/\bondeletenoaction\b/gu, "");
}

function triggerDefinitionMatches(
  definition: string,
  namespace: string,
  expected: PostgresTriggerManifest
): boolean {
  const normalized = definition.toLowerCase().replaceAll('"', "").replace(/\s+/gu, " ").trim();
  const prefix = `create trigger ${expected.name} ${expected.timing}`;
  const tableClause = ` on ${namespace}.${expected.table} `;
  if (
    !normalized.startsWith(prefix) ||
    !normalized.includes(tableClause) ||
    !normalized.includes(`execute function ${namespace}.${expected.functionName}()`)
  ) {
    return false;
  }
  const eventClause = normalized.slice(prefix.length, normalized.indexOf(tableClause)).trim();
  const expectedEventClause = expected.events
    .map((event) =>
      event === "update" && expected.updateColumns !== undefined
        ? `update of ${expected.updateColumns.join(", ")}`
        : event
    )
    .join(" or ");
  return eventClause.split(" or ").sort().join(" or ") === expectedEventClause.split(" or ").sort().join(" or ");
}

function companyRow(company: AccountingCompany): Row {
  return {
    company_id: company.companyId,
    tenant_id: company.tenantId,
    legal_name: company.legalName,
    display_name: company.displayName,
    base_currency_code: company.baseCurrencyCode,
    fiscal_year_start_month: company.fiscalYearStartMonth,
    provider_environment: company.providerEnvironment,
    source_system: company.sourceSystem,
    source_company_ref: company.sourceCompanyRef
  };
}

function sourceRow(source: AccountingSource): Row {
  return {
    source_id: source.sourceId,
    tenant_id: source.tenantId,
    source_system: source.sourceSystem,
    provider_environment: source.providerEnvironment,
    connection_ref: source.connectionRef,
    import_batch_id: source.importBatchId,
    checkpoint_id: source.checkpointId,
    latest_synced_at: source.latestSyncedAt,
    status: source.status
  };
}

function companySourceBindingRow(binding: CompanySourceBinding): Row {
  return {
    company_source_id: binding.companySourceId,
    tenant_id: binding.tenantId,
    company_id: binding.companyId,
    source_id: binding.sourceId,
    created_at: binding.createdAt
  };
}

function accountRow(account: Account): Row {
  return {
    account_id: account.accountId,
    tenant_id: account.tenantId,
    source_id: account.sourceId,
    source_account_id: account.sourceAccountId,
    account_number: account.accountNumber,
    name: account.name,
    type: account.type,
    subtype: account.subtype,
    classification: account.classification,
    parent_account_id: account.parentAccountId,
    currency_code: account.currencyCode,
    active: account.active
  };
}

function partyRow(party: Party): Row {
  return {
    party_id: party.partyId,
    tenant_id: party.tenantId,
    source_id: party.sourceId,
    source_party_id: party.sourcePartyId,
    party_type: party.partyType,
    display_name: party.displayName,
    active: party.active
  };
}

function itemRow(item: Item): Row {
  return {
    item_id: item.itemId,
    tenant_id: item.tenantId,
    source_id: item.sourceId,
    source_item_id: item.sourceItemId,
    item_type: item.itemType,
    name: item.name,
    income_account_id: item.incomeAccountId,
    expense_account_id: item.expenseAccountId,
    asset_account_id: item.assetAccountId,
    active: item.active
  };
}

function dimensionRow(dimension: AccountingDimension): Row {
  return {
    dimension_id: dimension.dimensionId,
    tenant_id: dimension.tenantId,
    source_id: dimension.sourceId,
    dimension_kind: dimension.dimensionKind,
    source_dimension_id: dimension.sourceDimensionId,
    name: dimension.name,
    parent_dimension_id: dimension.parentDimensionId,
    active: dimension.active
  };
}

function transactionRow(transaction: AccountingTransaction): Row {
  return {
    transaction_id: transaction.transactionId,
    tenant_id: transaction.tenantId,
    source_id: transaction.sourceId,
    source_transaction_id: transaction.sourceTransactionId,
    source_transaction_type: transaction.sourceTransactionType,
    transaction_number: transaction.transactionNumber,
    transaction_date: transaction.transactionDate,
    posted_at: transaction.postedAt,
    updated_at: transaction.updatedAt,
    party_id: transaction.partyId,
    currency_code: transaction.currencyCode,
    exchange_rate: transaction.exchangeRate,
    status: transaction.status,
    memo: transaction.memo,
    source_payload_ref: transaction.sourcePayloadRef
  };
}

function transactionLineRow(line: TransactionLine): Row {
  return {
    transaction_line_id: line.transactionLineId,
    tenant_id: line.tenantId,
    source_id: line.sourceId,
    transaction_id: line.transactionId,
    line_number: line.lineNumber,
    account_id: line.accountId,
    party_id: line.partyId,
    item_id: line.itemId,
    amount: line.amount,
    quantity: line.quantity,
    unit_amount: line.unitAmount,
    description: line.description,
    dimension_refs: line.dimensionRefs
  };
}

function ledgerPostingRow(posting: LedgerPosting): Row {
  return {
    posting_id: posting.postingId,
    tenant_id: posting.tenantId,
    source_id: posting.sourceId,
    source_posting_id: posting.sourcePostingId,
    transaction_id: posting.transactionId,
    transaction_line_id: posting.transactionLineId,
    account_id: posting.accountId,
    party_id: posting.partyId,
    item_id: posting.itemId,
    posting_date: posting.postingDate,
    accounting_basis: posting.accountingBasis,
    debit_amount: posting.debitAmount,
    credit_amount: posting.creditAmount,
    net_amount: posting.netAmount,
    currency_code: posting.currencyCode,
    dimension_hash: posting.dimensionHash,
    dimension_refs: posting.dimensionRefs,
    source_payload_ref: posting.sourcePayloadRef,
    import_batch_id: posting.importBatchId,
    checkpoint_id: posting.checkpointId
  };
}

function postingRuleRow(rule: PostingRule): Row {
  return {
    posting_rule_id: rule.postingRuleId,
    tenant_id: rule.tenantId,
    source_id: rule.sourceId,
    rule_code: rule.ruleCode,
    name: rule.name,
    description: rule.description,
    priority: rule.priority,
    status: rule.status,
    condition_mode: rule.conditionMode,
    conditions: rule.conditions,
    actions: rule.actions,
    effective_from: rule.effectiveFrom,
    effective_through: rule.effectiveThrough,
    created_at: rule.createdAt,
    updated_at: rule.updatedAt
  };
}

function transactionMatchCandidateRow(candidate: TransactionMatchCandidate): Row {
  return {
    match_candidate_id: candidate.matchCandidateId,
    tenant_id: candidate.tenantId,
    source_id: candidate.sourceId,
    match_kind: candidate.matchKind,
    origin_transaction_id: candidate.originTransactionId,
    target_transaction_id: candidate.targetTransactionId,
    matcher_version: candidate.matcherVersion,
    score: candidate.score,
    suggested_application_amount: candidate.suggestedApplicationAmount,
    currency_code: candidate.currencyCode,
    status: candidate.status,
    evidence: candidate.evidence,
    created_at: candidate.createdAt,
    expires_at: candidate.expiresAt
  };
}

function transactionMatchDecisionRow(decision: TransactionMatchDecision): Row {
  return {
    match_decision_id: decision.matchDecisionId,
    tenant_id: decision.tenantId,
    source_id: decision.sourceId,
    match_candidate_id: decision.matchCandidateId,
    decision: decision.decision,
    method: decision.method,
    decided_at: decision.decidedAt,
    decided_by_ref: decision.decidedByRef,
    reason: decision.reason,
    evidence: decision.evidence
  };
}

function paymentApplicationRow(application: PaymentApplication): Row {
  return {
    payment_application_id: application.paymentApplicationId,
    tenant_id: application.tenantId,
    source_id: application.sourceId,
    payment_transaction_id: application.paymentTransactionId,
    invoice_transaction_id: application.invoiceTransactionId,
    match_decision_id: application.matchDecisionId,
    applied_amount: application.appliedAmount,
    currency_code: application.currencyCode,
    application_date: application.applicationDate,
    status: application.status,
    created_at: application.createdAt,
    updated_at: application.updatedAt
  };
}

function importBatchRow(importBatch: ImportBatch): Row {
  return {
    import_batch_id: importBatch.importBatchId,
    tenant_id: importBatch.tenantId,
    source_id: importBatch.sourceId,
    mode: importBatch.mode,
    status: importBatch.status,
    started_at: importBatch.startedAt,
    completed_at: importBatch.completedAt,
    source_object_counts: importBatch.sourceObjectCounts,
    warning_summary: importBatch.warningSummary,
    error_summary: importBatch.errorSummary
  };
}

function syncCheckpointRow(checkpoint: SyncCheckpoint): Row {
  return {
    checkpoint_id: checkpoint.checkpointId,
    tenant_id: checkpoint.tenantId,
    source_id: checkpoint.sourceId,
    source_object: checkpoint.sourceObject,
    cursor_kind: checkpoint.cursorKind,
    cursor_value: checkpoint.cursorValue,
    fresh_through: checkpoint.freshThrough,
    latest_source_updated_at: checkpoint.latestSourceUpdatedAt,
    status: checkpoint.status
  };
}

function reportSnapshotRow(snapshot: ReportSnapshot): Row {
  return {
    report_snapshot_id: snapshot.reportSnapshotId,
    tenant_id: snapshot.tenantId,
    company_id: snapshot.companyId,
    source_id: snapshot.sourceId,
    report_name: snapshot.reportName,
    snapshot_source: snapshot.snapshotSource,
    accounting_basis: snapshot.accountingBasis,
    period_start: snapshot.periodStart,
    period_end: snapshot.periodEnd,
    as_of_date: snapshot.asOfDate,
    currency_code: snapshot.currencyCode,
    generated_at: snapshot.generatedAt,
    freshness: snapshot.freshness,
    reconciliation_status: snapshot.reconciliationStatus,
    reconciliation_difference: snapshot.reconciliationDifference
  };
}

function reportSnapshotLineRow(line: ReportSnapshotLine, snapshot: ReportSnapshot): Row {
  assertSafeDrilldownRef(line.drilldownRef);
  return {
    report_line_id: line.reportLineId,
    tenant_id: line.tenantId,
    company_id: snapshot.companyId,
    source_id: snapshot.sourceId,
    report_snapshot_id: line.reportSnapshotId,
    parent_report_line_id: line.parentReportLineId,
    section: line.section,
    label: line.label,
    account_id: line.accountId,
    amount: line.amount,
    sort_order: line.sortOrder,
    drilldown_ref: line.drilldownRef
  };
}

function reportSnapshotTotalRow(total: ReportSnapshotTotal, snapshot: ReportSnapshot): Row {
  assertSafeDrilldownRef(total.drilldownRef);
  return {
    report_total_id: total.reportTotalId,
    tenant_id: total.tenantId,
    company_id: snapshot.companyId,
    source_id: snapshot.sourceId,
    report_snapshot_id: total.reportSnapshotId,
    total_key: total.totalKey,
    label: total.label,
    amount: total.amount,
    drilldown_ref: total.drilldownRef
  };
}

function rollupBucketRow(bucket: RollupBucket): Row {
  return {
    rollup_bucket_id: bucket.rollupBucketId,
    tenant_id: bucket.tenantId,
    company_id: bucket.companyId,
    source_id: bucket.sourceId,
    account_id: bucket.accountId,
    accounting_basis: bucket.accountingBasis,
    bucket_grain: bucket.bucketGrain,
    bucket_start: bucket.bucketStart,
    bucket_end: bucket.bucketEnd,
    currency_code: bucket.currencyCode,
    dimension_hash: bucket.dimensionHash,
    party_id: bucket.partyId ?? "",
    party_type: bucket.partyType ?? "",
    item_id: bucket.itemId ?? "",
    debit_amount: bucket.debitAmount,
    credit_amount: bucket.creditAmount,
    net_amount: bucket.netAmount,
    posting_count: bucket.postingCount,
    source_posting_max_updated_at: bucket.sourcePostingMaxUpdatedAt,
    import_batch_id: bucket.importBatchId,
    generated_at: bucket.generatedAt
  };
}

function reportFreshnessRow(row: ReportFreshnessRow): Row {
  const freshness: ReportFreshness = {
    status: row.status,
    sourceId: row.sourceId,
    ...(row.importBatchId === undefined ? {} : { importBatchId: row.importBatchId }),
    ...(row.checkpointId === undefined ? {} : { checkpointId: row.checkpointId }),
    ...(row.freshThrough === undefined ? {} : { freshThrough: row.freshThrough }),
    ...(row.staleReason === undefined ? {} : { staleReason: row.staleReason })
  };
  assertNoCredentialKeys(freshness);

  return {
    freshness_id: row.freshnessId,
    tenant_id: row.tenantId,
    company_id: row.companyId,
    source_id: row.sourceId,
    report_name: row.reportName,
    accounting_basis: row.accountingBasis,
    period_start: row.periodStart,
    period_end: row.periodEnd,
    currency_code: row.currencyCode,
    status: row.status,
    fresh_through: row.freshThrough,
    stale_reason: row.staleReason,
    import_batch_id: row.importBatchId,
    checkpoint_id: row.checkpointId,
    updated_at: row.updatedAt
  };
}

function accountFromRow(row: Row): Account {
  const accountNumber = optionalString(row.account_number);
  const subtype = optionalString(row.subtype);
  const parentAccountId = optionalString(row.parent_account_id);
  const currencyCode = optionalString(row.currency_code);

  return {
    accountId: requiredString(row.account_id, "account_id"),
    tenantId: requiredString(row.tenant_id, "tenant_id"),
    sourceId: requiredString(row.source_id, "source_id"),
    sourceAccountId: requiredString(row.source_account_id, "source_account_id"),
    ...(accountNumber === undefined ? {} : { accountNumber }),
    name: requiredString(row.name, "name"),
    type: requiredString(row.type, "type"),
    ...(subtype === undefined ? {} : { subtype }),
    classification: requiredString(row.classification, "classification") as Account["classification"],
    ...(parentAccountId === undefined ? {} : { parentAccountId }),
    ...(currencyCode === undefined ? {} : { currencyCode }),
    active: Boolean(row.active)
  };
}

function ledgerPostingFromRow(row: Row): LedgerPosting {
  const sourcePayloadRef = optionalJson(row.source_payload_ref) as LedgerPosting["sourcePayloadRef"] | undefined;
  const transactionLineId = optionalString(row.transaction_line_id);
  const partyId = optionalString(row.party_id);
  const itemId = optionalString(row.item_id);
  const checkpointId = optionalString(row.checkpoint_id);

  if (sourcePayloadRef !== undefined) {
    assertSafeSourcePayloadRef(sourcePayloadRef);
  }

  return {
    postingId: requiredString(row.posting_id, "posting_id"),
    tenantId: requiredString(row.tenant_id, "tenant_id"),
    sourceId: requiredString(row.source_id, "source_id"),
    sourcePostingId: requiredString(row.source_posting_id, "source_posting_id"),
    transactionId: requiredString(row.transaction_id, "transaction_id"),
    ...(transactionLineId === undefined ? {} : { transactionLineId }),
    accountId: requiredString(row.account_id, "account_id"),
    ...(partyId === undefined ? {} : { partyId }),
    ...(itemId === undefined ? {} : { itemId }),
    postingDate: isoDate(row.posting_date, "posting_date"),
    accountingBasis: requiredString(row.accounting_basis, "accounting_basis") as AccountingBasis,
    debitAmount: requiredString(row.debit_amount, "debit_amount"),
    creditAmount: requiredString(row.credit_amount, "credit_amount"),
    netAmount: requiredString(row.net_amount, "net_amount"),
    currencyCode: requiredString(row.currency_code, "currency_code"),
    dimensionHash: requiredString(row.dimension_hash, "dimension_hash"),
    dimensionRefs: (optionalJson(row.dimension_refs) as LedgerPosting["dimensionRefs"] | undefined) ?? [],
    ...(sourcePayloadRef === undefined ? {} : { sourcePayloadRef }),
    importBatchId: requiredString(row.import_batch_id, "import_batch_id"),
    ...(checkpointId === undefined ? {} : { checkpointId })
  };
}

function reportFreshnessFromRow(row: Row): ReportFreshness {
  const sourceId = optionalString(row.source_id);
  const importBatchId = optionalString(row.import_batch_id);
  const checkpointId = optionalString(row.checkpoint_id);
  const freshThrough = optionalIsoDateTime(row.fresh_through);
  const staleReason = optionalString(row.stale_reason);

  return {
    status: requiredString(row.status, "status") as ReportFreshnessStatus,
    ...(sourceId === undefined ? {} : { sourceId }),
    ...(importBatchId === undefined ? {} : { importBatchId }),
    ...(checkpointId === undefined ? {} : { checkpointId }),
    ...(freshThrough === undefined ? {} : { freshThrough }),
    ...(staleReason === undefined ? {} : { staleReason })
  };
}

function reportSnapshotFromRow(row: Row): ReportSnapshot {
  const freshness = (optionalJson(row.freshness) as ReportFreshness | undefined) ?? { status: "unknown" };
  assertNoCredentialKeys(freshness);

  return {
    reportSnapshotId: requiredString(row.report_snapshot_id, "report_snapshot_id"),
    tenantId: requiredString(row.tenant_id, "tenant_id"),
    companyId: requiredString(row.company_id, "company_id"),
    sourceId: requiredString(row.source_id, "source_id"),
    reportName: requiredString(row.report_name, "report_name"),
    snapshotSource: requiredString(row.snapshot_source, "snapshot_source") as ReportSnapshotSource,
    accountingBasis: requiredString(row.accounting_basis, "accounting_basis") as AccountingBasis,
    periodStart: isoDate(row.period_start, "period_start"),
    periodEnd: isoDate(row.period_end, "period_end"),
    asOfDate: isoDate(row.as_of_date, "as_of_date"),
    currencyCode: requiredString(row.currency_code, "currency_code"),
    generatedAt: isoDateTime(row.generated_at, "generated_at"),
    freshness,
    reconciliationStatus: requiredString(row.reconciliation_status, "reconciliation_status") as ReportSnapshot["reconciliationStatus"],
    reconciliationDifference: requiredString(row.reconciliation_difference, "reconciliation_difference")
  };
}

function reportSnapshotLineFromRow(row: Row): ReportSnapshotLine {
  const drilldownRef = optionalJson(row.drilldown_ref) as ReportSnapshotLine["drilldownRef"] | undefined;
  const parentReportLineId = optionalString(row.parent_report_line_id);
  const accountId = optionalString(row.account_id);
  if (drilldownRef === undefined) {
    throw new Error("report snapshot line is missing drilldown_ref");
  }
  assertSafeDrilldownRef(drilldownRef);

  return {
    reportLineId: requiredString(row.report_line_id, "report_line_id"),
    tenantId: requiredString(row.tenant_id, "tenant_id"),
    reportSnapshotId: requiredString(row.report_snapshot_id, "report_snapshot_id"),
    ...(parentReportLineId === undefined ? {} : { parentReportLineId }),
    section: requiredString(row.section, "section"),
    label: requiredString(row.label, "label"),
    ...(accountId === undefined ? {} : { accountId }),
    amount: requiredString(row.amount, "amount"),
    sortOrder: requiredNumber(row.sort_order, "sort_order"),
    drilldownRef
  };
}

function reportSnapshotTotalFromRow(row: Row): ReportSnapshotTotal {
  const drilldownRef = optionalJson(row.drilldown_ref) as ReportSnapshotTotal["drilldownRef"] | undefined;
  if (drilldownRef === undefined) {
    throw new Error("report snapshot total is missing drilldown_ref");
  }
  assertSafeDrilldownRef(drilldownRef);

  return {
    reportTotalId: requiredString(row.report_total_id, "report_total_id"),
    tenantId: requiredString(row.tenant_id, "tenant_id"),
    reportSnapshotId: requiredString(row.report_snapshot_id, "report_snapshot_id"),
    totalKey: requiredString(row.total_key, "total_key"),
    label: requiredString(row.label, "label"),
    amount: requiredString(row.amount, "amount"),
    drilldownRef
  };
}

function rollupBucketFromRow(row: Row): RollupBucket {
  const sourcePostingMaxUpdatedAt = optionalIsoDateTime(row.source_posting_max_updated_at);
  const importBatchId = optionalString(row.import_batch_id);
  const partyId = optionalNonEmptyString(row.party_id);
  const partyType = optionalNonEmptyString(row.party_type) as PartyType | undefined;
  const itemId = optionalNonEmptyString(row.item_id);

  return {
    rollupBucketId: requiredString(row.rollup_bucket_id, "rollup_bucket_id"),
    tenantId: requiredString(row.tenant_id, "tenant_id"),
    companyId: requiredString(row.company_id, "company_id"),
    sourceId: requiredString(row.source_id, "source_id"),
    accountId: requiredString(row.account_id, "account_id"),
    accountingBasis: requiredString(row.accounting_basis, "accounting_basis") as AccountingBasis,
    bucketGrain: requiredString(row.bucket_grain, "bucket_grain") as RollupBucketGrain,
    bucketStart: isoDate(row.bucket_start, "bucket_start"),
    bucketEnd: isoDate(row.bucket_end, "bucket_end"),
    currencyCode: requiredString(row.currency_code, "currency_code"),
    dimensionHash: requiredString(row.dimension_hash, "dimension_hash"),
    ...(partyId === undefined ? {} : { partyId }),
    ...(partyType === undefined ? {} : { partyType }),
    ...(itemId === undefined ? {} : { itemId }),
    debitAmount: requiredString(row.debit_amount, "debit_amount"),
    creditAmount: requiredString(row.credit_amount, "credit_amount"),
    netAmount: requiredString(row.net_amount, "net_amount"),
    postingCount: requiredNumber(row.posting_count, "posting_count"),
    ...(sourcePostingMaxUpdatedAt === undefined ? {} : { sourcePostingMaxUpdatedAt }),
    ...(importBatchId === undefined ? {} : { importBatchId }),
    generatedAt: isoDateTime(row.generated_at, "generated_at")
  };
}

function requiredString(value: unknown, fieldName: string): string {
  if (value === undefined || value === null) {
    throw new Error(`missing required row field ${fieldName}`);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return value.toString();
  }

  throw new Error(`row field ${fieldName} must be string-like`);
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return value.toString();
  }

  throw new Error("optional row field must be string-like");
}

function optionalNonEmptyString(value: unknown): string | undefined {
  const stringValue = optionalString(value);
  return stringValue === "" ? undefined : stringValue;
}

function requiredNumber(value: unknown, fieldName: string): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string" && value.trim() !== "") {
    return Number(value);
  }

  throw new Error(`missing required numeric row field ${fieldName}`);
}

function optionalJson(value: unknown): unknown {
  if (value === undefined || value === null) {
    return undefined;
  }

  return value;
}

function isoDate(value: unknown, fieldName: string): IsoDate {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  return requiredString(value, fieldName).slice(0, 10);
}

function isoDateTime(value: unknown, fieldName: string): IsoDateTime {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return requiredString(value, fieldName);
}

function optionalIsoDateTime(value: unknown): IsoDateTime | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return value.toString();
  }

  throw new Error("optional datetime row field must be string-like");
}

function validateCredentialFreeRow(tableName: string, row: Row): void {
  for (const [key, value] of Object.entries(row)) {
    if (isDisallowedCredentialColumnName(key)) {
      throw new Error(`credential-like field is not allowed: ${tableName}.${key}`);
    }
    if (isJsonLike(value) && key !== "drilldown_ref") {
      assertNoCredentialKeys(value, `$${tableName}.${key}`);
    }
  }
}

function isDisallowedCredentialColumnName(name: string): boolean {
  return DISALLOWED_CREDENTIAL_COLUMN_PATTERNS.some((pattern) => pattern.test(name));
}

function isJsonLike(value: unknown): value is JsonValue {
  return Array.isArray(value) || (value !== null && typeof value === "object");
}

function splitSqlStatements(sql: string): readonly string[] {
  return sql
    .split(/;\s*\n/)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
    .map((statement) => `${statement};`);
}

function tableManifest(manifest: PostgresSchemaManifest, tableName: string): PostgresTableManifest {
  const table = manifest.tables.find((entry) => entry.name === tableName);
  if (table === undefined) {
    throw new Error(`unknown Postgres manifest table: ${tableName}`);
  }

  return table;
}

function qualifiedTable(manifest: PostgresSchemaManifest, tableName: string): string {
  return `${quoteIdentifier(manifest.namespace)}.${quoteIdentifier(tableName)}`;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function unqualifiedTableName(tableName: string): string {
  const [, unqualified = tableName] = tableName.split(".");
  return unqualified.replaceAll('"', "");
}
