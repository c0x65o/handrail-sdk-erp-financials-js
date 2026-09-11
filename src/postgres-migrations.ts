import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { POSTGRES_CANONICAL_SCHEMA_MANIFEST } from "./schema-manifest.js";
import { validatePostgresSchema } from "./postgres-storage.js";

import type { PostgresQueryClient, PostgresSchemaValidationIssue } from "./postgres-storage.js";

export type PostgresMigrationDefinition = {
  readonly migrationId: string;
  readonly name: string;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly sql: string;
  readonly checksum: string;
};

export type AppliedPostgresMigration = {
  readonly migrationId: string;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly name: string;
  readonly checksum: string;
  readonly manifestVersion: string;
  readonly executionMs: number;
  readonly appliedByRef: string;
  readonly appliedAt: string;
  readonly baseline: boolean;
};

export type PostgresMigrationTransactionRunner = {
  transaction<Result>(work: (client: PostgresQueryClient) => Promise<Result>): Promise<Result>;
};

export type PlanPostgresMigrationsOptions = {
  readonly targetVersion?: number;
};

export type PostgresMigrationPlan = {
  readonly currentVersion: number;
  readonly targetVersion: number;
  readonly pendingMigrations: readonly PostgresMigrationDefinition[];
  readonly appliedMigrations: readonly AppliedPostgresMigration[];
  readonly requiresBaselineAdoption: boolean;
};

export type MigratePostgresSchemaOptions = PlanPostgresMigrationsOptions & {
  readonly appliedByRef: string;
  readonly dryRun?: boolean;
};

export type MigratePostgresSchemaResult = PostgresMigrationPlan & {
  readonly executed: boolean;
  readonly adoptedBaselineVersion?: number;
  readonly applied: readonly AppliedPostgresMigration[];
};

export type PostgresMigrationHistoryIssueKind =
  | "unversioned_schema"
  | "unknown_migration"
  | "definition_mismatch"
  | "checksum_mismatch"
  | "non_contiguous_history"
  | "version_ahead_of_package";

export type PostgresMigrationHistoryIssue = {
  readonly kind: PostgresMigrationHistoryIssueKind;
  readonly migrationId: string;
  readonly message: string;
};

export type PostgresMigrationHistoryValidation = {
  readonly compatible: boolean;
  readonly currentVersion: number;
  readonly targetVersion: number;
  readonly appliedMigrations: readonly AppliedPostgresMigration[];
  readonly issues: readonly PostgresMigrationHistoryIssue[];
};

export class PostgresMigrationError extends Error {
  readonly code:
    | "invalid_registry"
    | "unsupported_legacy_schema"
    | "migration_history_drift"
    | "unreachable_target"
    | "schema_validation_failed";

  constructor(code: PostgresMigrationError["code"], message: string) {
    super(message);
    this.name = "PostgresMigrationError";
    this.code = code;
  }
}

const namespace = POSTGRES_CANONICAL_SCHEMA_MANIFEST.namespace;
const migrationLockKey = `${namespace}:schema-migrations`;
const migrationFiles = {
  bootstrapV6: new URL(
    "../migrations/future-erp/20260620000000_create_erp_financials_canonical_schema.sql",
    import.meta.url
  ),
  snapshotScopeV7: new URL("../migrations/future-erp/20260812000000_scope_report_snapshots.sql", import.meta.url),
  migrationLedgerV8: new URL(
    "../migrations/future-erp/20260812010000_add_schema_migration_ledger.sql",
    import.meta.url
  ),
  scopedIntegrityV9: new URL(
    "../migrations/future-erp/20260812020000_add_scoped_financial_integrity.sql",
    import.meta.url
  ),
  auditLifecycleV10: new URL(
    "../migrations/future-erp/20260812030000_add_financial_lifecycle_events.sql",
    import.meta.url
  ),
  fiscalControlsV11: new URL(
    "../migrations/future-erp/20260812040000_add_fiscal_period_controls.sql",
    import.meta.url
  ),
  journalLifecycleV12: new URL(
    "../migrations/future-erp/20260812050000_add_journal_lifecycle_links.sql",
    import.meta.url
  ),
  atomicSubledgersV13: new URL(
    "../migrations/future-erp/20260812060000_add_atomic_subledgers.sql",
    import.meta.url
  ),
  sdkV1FoundationV14: new URL(
    "../migrations/future-erp/20260812070000_add_sdk_v1_foundation.sql",
    import.meta.url
  ),
  receivablesProvenanceV15: new URL(
    "../migrations/future-erp/20260815010000_add_receivables_provenance_reads.sql",
    import.meta.url
  ),
  generalLedgerContractV16: new URL(
    "../migrations/future-erp/20260815020000_add_general_ledger_contract.sql",
    import.meta.url
  ),
  writeOffInvoiceApplicationsV17: new URL(
    "../migrations/future-erp/20260815030000_add_write_off_invoice_applications.sql",
    import.meta.url
  ),
  billPaymentDisbursementsV18: new URL(
    "../migrations/future-erp/20260816010000_add_bill_payment_disbursements.sql",
    import.meta.url
  ),
  importedOperationalDocumentsV19: new URL(
    "../migrations/future-erp/20260819010000_add_imported_operational_document_types.sql",
    import.meta.url
  ),
  subledgerLineCustomersV20: new URL(
    "../migrations/future-erp/20260821010000_add_subledger_line_customers.sql",
    import.meta.url
  ),
  sourceImportResetV21: new URL(
    "../migrations/future-erp/20260823010000_add_source_import_reset_guard.sql",
    import.meta.url
  ),
  bankStatementLineUnignoreV22: new URL(
    "../migrations/future-erp/20260825010000_add_bank_statement_line_unignore.sql",
    import.meta.url
  ),
  commercialDocumentDetailV24: new URL("../migrations/future-erp/20260911010000_commercial_document_detail.sql", import.meta.url),
  customerDepositInvoiceApplicationsV23: new URL(
    "../migrations/future-erp/20260826010000_add_customer_deposit_invoice_applications.sql",
    import.meta.url
  )
} as const;

function migration(
  migrationId: string,
  name: string,
  fromVersion: number,
  toVersion: number,
  fileUrl: URL
): PostgresMigrationDefinition {
  const sql = readFileSync(fileUrl, "utf8");
  return {
    migrationId,
    name,
    fromVersion,
    toVersion,
    sql,
    checksum: sha256(sql)
  };
}

export const POSTGRES_MIGRATIONS: readonly PostgresMigrationDefinition[] = [
  migration(
    "20260620000000_create_erp_financials_canonical_schema",
    "Create ERP Financials canonical schema v6",
    0,
    6,
    migrationFiles.bootstrapV6
  ),
  migration(
    "20260812000000_scope_report_snapshots",
    "Scope report snapshots by company and source",
    6,
    7,
    migrationFiles.snapshotScopeV7
  ),
  migration(
    "20260812010000_add_schema_migration_ledger",
    "Add ordered schema migration ledger",
    7,
    8,
    migrationFiles.migrationLedgerV8
  ),
  migration(
    "20260812020000_add_scoped_financial_integrity",
    "Add database-enforced scoped financial integrity",
    8,
    9,
    migrationFiles.scopedIntegrityV9
  ),
  migration(
    "20260812030000_add_financial_lifecycle_events",
    "Add immutable financial authorization and lifecycle events",
    9,
    10,
    migrationFiles.auditLifecycleV10
  ),
  migration(
    "20260812040000_add_fiscal_period_controls",
    "Add fiscal periods, posting locks, and close controls",
    10,
    11,
    migrationFiles.fiscalControlsV11
  ),
  migration(
    "20260812050000_add_journal_lifecycle_links",
    "Add immutable journal reversal and replacement links",
    11,
    12,
    migrationFiles.journalLifecycleV12
  ),
  migration(
    "20260812060000_add_atomic_subledgers",
    "Add atomic subledger documents and applications",
    12,
    13,
    migrationFiles.atomicSubledgersV13
  ),
  migration(
    "20260812070000_add_sdk_v1_foundation",
    "Add reporting books, unified matching evidence, invoice detail, outbox, and bank reconciliation foundation",
    13,
    14,
    migrationFiles.sdkV1FoundationV14
  ),
  migration(
    "20260815010000_add_receivables_provenance_reads",
    "Add immutable invoice unit-cost provenance",
    14,
    15,
    migrationFiles.receivablesProvenanceV15
  ),
  migration(
    "20260815020000_add_general_ledger_contract",
    "Add bounded general-ledger reads and versioned reporting-book accounts",
    15,
    16,
    migrationFiles.generalLedgerContractV16
  ),
  migration(
    "20260815030000_add_write_off_invoice_applications",
    "Add canonical write-off-to-invoice applications",
    16,
    17,
    migrationFiles.writeOffInvoiceApplicationsV17
  ),
  migration(
    "20260816010000_add_bill_payment_disbursements",
    "Add canonical scheduled and cleared bill payment disbursements",
    17,
    18,
    migrationFiles.billPaymentDisbursementsV18
  ),
  migration(
    "20260819010000_add_imported_operational_document_types",
    "Add imported operational document and vendor-credit application types",
    18,
    19,
    migrationFiles.importedOperationalDocumentsV19
  ),
  migration(
    "20260821010000_add_subledger_line_customers",
    "Preserve customer allocations on imported subledger lines",
    19,
    20,
    migrationFiles.subledgerLineCustomersV20
  ),
  migration(
    "20260823010000_add_source_import_reset_guard",
    "Add transaction-scoped external source import reset guard",
    20,
    21,
    migrationFiles.sourceImportResetV21
  ),
  migration(
    "20260825010000_add_bank_statement_line_unignore",
    "Add audited reversible ignored bank statement line lifecycle",
    21,
    22,
    migrationFiles.bankStatementLineUnignoreV22
  ),
  migration(
    "20260826010000_add_customer_deposit_invoice_applications",
    "Allow customer deposits to satisfy invoice credits",
    22,
    23,
    migrationFiles.customerDepositInvoiceApplicationsV23
  ),
  migration("20260911010000_commercial_document_detail", "Preserve signed commercial detail and provider precision", 23, 24, migrationFiles.commercialDocumentDetailV24)
] as const;

export async function planPostgresMigrations(
  client: PostgresQueryClient,
  options: PlanPostgresMigrationsOptions = {}
): Promise<PostgresMigrationPlan> {
  assertMigrationRegistry(POSTGRES_MIGRATIONS);
  const appliedMigrations = await loadAppliedMigrationsIfPresent(client);
  const historyValidation = validateMigrationRows(appliedMigrations, POSTGRES_MIGRATIONS);
  if (!historyValidation.compatible) {
    throw migrationHistoryDriftError(historyValidation.issues);
  }
  const detectedVersion =
    appliedMigrations.length === 0 ? await detectLegacySchemaVersion(client) : latestAppliedVersion(appliedMigrations);
  const targetVersion = options.targetVersion ?? POSTGRES_CANONICAL_SCHEMA_MANIFEST.schemaVersion;
  const pendingMigrations = migrationPath(detectedVersion, targetVersion, POSTGRES_MIGRATIONS);

  return {
    currentVersion: detectedVersion,
    targetVersion,
    pendingMigrations,
    appliedMigrations,
    requiresBaselineAdoption: appliedMigrations.length === 0 && detectedVersion > 0
  };
}

export async function migratePostgresSchema(
  runner: PostgresMigrationTransactionRunner,
  options: MigratePostgresSchemaOptions
): Promise<MigratePostgresSchemaResult> {
  assertNonEmpty(options.appliedByRef, "appliedByRef");

  if (options.dryRun === true) {
    return runner.transaction(async (client) => {
      const plan = await planPostgresMigrations(client, options);
      return { ...plan, executed: false, applied: [] };
    });
  }

  return runner.transaction(async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [migrationLockKey]);

    const initialVersion = await detectLegacySchemaVersion(client);
    await ensureMigrationLedger(client);
    let appliedMigrations = await loadAppliedMigrations(client);
    let adoptedBaselineVersion: number | undefined;

    if (appliedMigrations.length === 0 && initialVersion > 0) {
      if (
        initialVersion !== 6 &&
        initialVersion !== 7 &&
        initialVersion !== 8 &&
        initialVersion !== 9 &&
        initialVersion !== 10 &&
        initialVersion !== 11 &&
        initialVersion !== 12 &&
        initialVersion !== 13 &&
        initialVersion !== 14
      ) {
        throw new PostgresMigrationError(
          "unsupported_legacy_schema",
          `Cannot adopt unversioned ERP Financials schema version ${String(initialVersion)}`
        );
      }
      const baseline = await recordBaseline(client, initialVersion, options.appliedByRef);
      appliedMigrations = [baseline];
      adoptedBaselineVersion = initialVersion;
    }

    const historyValidation = validateMigrationRows(appliedMigrations, POSTGRES_MIGRATIONS);
    if (!historyValidation.compatible) {
      throw migrationHistoryDriftError(historyValidation.issues);
    }

    const currentVersion = appliedMigrations.length === 0 ? initialVersion : latestAppliedVersion(appliedMigrations);
    const targetVersion = options.targetVersion ?? POSTGRES_CANONICAL_SCHEMA_MANIFEST.schemaVersion;
    const pendingMigrations = migrationPath(currentVersion, targetVersion, POSTGRES_MIGRATIONS);
    const newlyApplied: AppliedPostgresMigration[] = [];

    for (const definition of pendingMigrations) {
      const startedAt = Date.now();
      await client.query(definition.sql);
      newlyApplied.push(
        await recordMigration(client, definition, Math.max(0, Date.now() - startedAt), options.appliedByRef)
      );
    }

    if (targetVersion === POSTGRES_CANONICAL_SCHEMA_MANIFEST.schemaVersion) {
      const schemaValidation = await validatePostgresSchema(client);
      if (!schemaValidation.compatible) {
        throw new PostgresMigrationError(
          "schema_validation_failed",
          schemaValidationMessage(schemaValidation.issues)
        );
      }
    }

    return {
      currentVersion,
      targetVersion,
      pendingMigrations,
      appliedMigrations,
      requiresBaselineAdoption: adoptedBaselineVersion !== undefined,
      ...(adoptedBaselineVersion === undefined ? {} : { adoptedBaselineVersion }),
      executed: true,
      applied: newlyApplied
    };
  });
}

export async function validatePostgresMigrationHistory(
  client: PostgresQueryClient
): Promise<PostgresMigrationHistoryValidation> {
  assertMigrationRegistry(POSTGRES_MIGRATIONS);
  const appliedMigrations = await loadAppliedMigrationsIfPresent(client);
  const validation = validateMigrationRows(appliedMigrations, POSTGRES_MIGRATIONS);
  if (appliedMigrations.length > 0) {
    return validation;
  }
  const detectedVersion = await detectLegacySchemaVersion(client);
  if (detectedVersion === 0) {
    return validation;
  }
  return {
    ...validation,
    compatible: false,
    currentVersion: detectedVersion,
    issues: [
      {
        kind: "unversioned_schema",
        migrationId: `unversioned:v${String(detectedVersion)}`,
        message: `ERP Financials schema v${String(detectedVersion)} exists without migration history; run migratePostgresSchema to adopt it`
      }
    ]
  };
}

function validateMigrationRows(
  appliedMigrations: readonly AppliedPostgresMigration[],
  registry: readonly PostgresMigrationDefinition[]
): PostgresMigrationHistoryValidation {
  const issues: PostgresMigrationHistoryIssue[] = [];
  const registryById = new Map(registry.map((entry) => [entry.migrationId, entry]));
  let expectedFromVersion = 0;

  for (const applied of [...appliedMigrations].sort((left, right) => left.toVersion - right.toVersion)) {
    if (applied.fromVersion !== expectedFromVersion) {
      issues.push({
        kind: "non_contiguous_history",
        migrationId: applied.migrationId,
        message: `Migration ${applied.migrationId} starts at v${String(applied.fromVersion)} after v${String(expectedFromVersion)}`
      });
    }
    expectedFromVersion = applied.toVersion;

    if (applied.baseline) {
      const expectedBaselineId = `baseline:v${String(applied.toVersion)}`;
      if (
        applied.migrationId !== expectedBaselineId ||
        applied.fromVersion !== 0 ||
        applied.checksum !== sha256(`${expectedBaselineId}:${namespace}`)
      ) {
        issues.push({
          kind: "definition_mismatch",
          migrationId: applied.migrationId,
          message: `Baseline migration ${applied.migrationId} does not match its immutable package identity`
        });
      }
      continue;
    }
    const definition = registryById.get(applied.migrationId);
    if (definition === undefined) {
      issues.push({
        kind: "unknown_migration",
        migrationId: applied.migrationId,
        message: `Applied migration ${applied.migrationId} is not present in the package registry`
      });
      continue;
    }
    if (definition.checksum !== applied.checksum) {
      issues.push({
        kind: "checksum_mismatch",
        migrationId: applied.migrationId,
        message: `Applied migration ${applied.migrationId} checksum does not match the immutable package migration`
      });
    }
    if (
      definition.fromVersion !== applied.fromVersion ||
      definition.toVersion !== applied.toVersion ||
      definition.name !== applied.name
    ) {
      issues.push({
        kind: "definition_mismatch",
        migrationId: applied.migrationId,
        message: `Applied migration ${applied.migrationId} version bounds or name do not match the package registry`
      });
    }
  }

  const currentVersion = appliedMigrations.length === 0 ? 0 : latestAppliedVersion(appliedMigrations);
  const targetVersion = POSTGRES_CANONICAL_SCHEMA_MANIFEST.schemaVersion;
  if (currentVersion > targetVersion) {
    issues.push({
      kind: "version_ahead_of_package",
      migrationId: appliedMigrations.at(-1)?.migrationId ?? "unknown",
      message: `Database schema v${String(currentVersion)} is ahead of package schema v${String(targetVersion)}`
    });
  }

  return {
    compatible: issues.length === 0,
    currentVersion,
    targetVersion,
    appliedMigrations,
    issues
  };
}

function migrationHistoryDriftError(
  issues: readonly PostgresMigrationHistoryIssue[]
): PostgresMigrationError {
  return new PostgresMigrationError(
    "migration_history_drift",
    issues.map((issue) => issue.message).join("; ")
  );
}

function assertMigrationRegistry(registry: readonly PostgresMigrationDefinition[]): void {
  const ids = new Set<string>();
  const fromVersions = new Set<number>();
  const toVersions = new Set<number>();
  let expectedFromVersion = 0;
  for (const entry of registry) {
    if (ids.has(entry.migrationId) || fromVersions.has(entry.fromVersion) || toVersions.has(entry.toVersion)) {
      throw new PostgresMigrationError("invalid_registry", `Duplicate migration path entry ${entry.migrationId}`);
    }
    if (
      entry.fromVersion !== expectedFromVersion ||
      entry.toVersion <= entry.fromVersion ||
      !/^[a-f0-9]{64}$/.test(entry.checksum)
    ) {
      throw new PostgresMigrationError("invalid_registry", `Invalid migration definition ${entry.migrationId}`);
    }
    ids.add(entry.migrationId);
    fromVersions.add(entry.fromVersion);
    toVersions.add(entry.toVersion);
    expectedFromVersion = entry.toVersion;
  }
  if (expectedFromVersion !== POSTGRES_CANONICAL_SCHEMA_MANIFEST.schemaVersion) {
    throw new PostgresMigrationError(
      "invalid_registry",
      `Migration registry ends at v${String(expectedFromVersion)} instead of canonical schema v${String(POSTGRES_CANONICAL_SCHEMA_MANIFEST.schemaVersion)}`
    );
  }
}

function migrationPath(
  currentVersion: number,
  targetVersion: number,
  registry: readonly PostgresMigrationDefinition[]
): readonly PostgresMigrationDefinition[] {
  if (!Number.isInteger(targetVersion) || targetVersion < currentVersion) {
    throw new PostgresMigrationError(
      "unreachable_target",
      `Cannot migrate ERP Financials schema from v${String(currentVersion)} to v${String(targetVersion)}`
    );
  }

  const byFromVersion = new Map(registry.map((entry) => [entry.fromVersion, entry]));
  const path: PostgresMigrationDefinition[] = [];
  let cursor = currentVersion;
  while (cursor < targetVersion) {
    const next = byFromVersion.get(cursor);
    if (next === undefined || next.toVersion > targetVersion) {
      throw new PostgresMigrationError(
        "unreachable_target",
        `No ordered ERP Financials migration path from v${String(cursor)} to v${String(targetVersion)}`
      );
    }
    path.push(next);
    cursor = next.toVersion;
  }
  return path;
}

async function detectLegacySchemaVersion(client: PostgresQueryClient): Promise<number> {
  const snapshotTable = await client.query<{ readonly relation_name: string | null }>(
    "select to_regclass($1) as relation_name",
    [`${namespace}.report_snapshots`]
  );
  if (snapshotTable.rows[0]?.relation_name == null) {
    return 0;
  }

  const columns = await client.query<{ readonly column_name: string }>(
    `select column_name
from information_schema.columns
where table_schema = $1 and table_name = 'report_snapshots' and column_name = any($2::text[])
order by column_name`,
    [namespace, ["company_id", "source_id"]]
  );
  const scopedColumns = new Set(columns.rows.map((row) => row.column_name));
  if (scopedColumns.size === 0) {
    return 6;
  }
  if (scopedColumns.has("company_id") && scopedColumns.has("source_id")) {
    const v9Columns = await client.query<{ readonly column_name: string }>(
      `select column_name
from information_schema.columns
where table_schema = $1
  and ((table_name = 'transaction_lines' and column_name = 'source_id')
    or (table_name = 'report_snapshot_lines' and column_name in ('company_id', 'source_id'))
    or (table_name = 'report_snapshot_totals' and column_name in ('company_id', 'source_id')))
order by table_name, column_name`,
      [namespace]
    );
    if (v9Columns.rows.length === 5 && (await relationExists(client, `${namespace}.company_sources`))) {
      if (!(await relationExists(client, `${namespace}.financial_lifecycle_events`))) {
        return 9;
      }
      const hasFiscalControls = (await relationExists(client, `${namespace}.fiscal_periods`)) &&
        (await relationExists(client, `${namespace}.accounting_book_controls`))
      if (!hasFiscalControls) {
        return 10;
      }
      if (!(await relationExists(client, `${namespace}.journal_entry_links`))) {
        return 11;
      }
      if (
        !(await relationExists(client, `${namespace}.subledger_documents`)) ||
        !(await relationExists(client, `${namespace}.subledger_applications`))
      ) {
        return 12;
      }
      return (await relationExists(client, `${namespace}.reporting_books`)) &&
        (await relationExists(client, `${namespace}.financial_outbox`))
        ? 14
        : 13;
    }
    // An empty ledger can exist after an interrupted/manual bootstrap. The
    // ledger itself is the v8 change, but without a durable migration row we
    // intentionally adopt the database as v7 and replay the idempotent v8
    // migration so version provenance is never inferred from table existence.
    return 7;
  }
  throw new PostgresMigrationError(
    "unsupported_legacy_schema",
    "Unversioned report_snapshots has only part of the required company/source scope"
  );
}

async function ensureMigrationLedger(client: PostgresQueryClient): Promise<void> {
  await client.query(`create schema if not exists "${namespace}"`);
  await client.query(readFileSync(migrationFiles.migrationLedgerV8, "utf8"));
}

async function loadAppliedMigrationsIfPresent(client: PostgresQueryClient): Promise<readonly AppliedPostgresMigration[]> {
  return (await relationExists(client, `${namespace}.schema_migrations`)) ? loadAppliedMigrations(client) : [];
}

async function relationExists(client: PostgresQueryClient, relation: string): Promise<boolean> {
  const result = await client.query<{ readonly relation_name: string | null }>(
    "select to_regclass($1) as relation_name",
    [relation]
  );
  return result.rows[0]?.relation_name != null;
}

async function loadAppliedMigrations(client: PostgresQueryClient): Promise<readonly AppliedPostgresMigration[]> {
  const result = await client.query(
    `select "migration_id", "from_version", "to_version", "name", "checksum", "manifest_version", "execution_ms", "applied_by_ref", "applied_at"
from "${namespace}"."schema_migrations"
order by "to_version", "migration_id"`
  );
  return result.rows.map(appliedMigrationFromRow);
}

async function recordBaseline(
  client: PostgresQueryClient,
  version: number,
  appliedByRef: string
): Promise<AppliedPostgresMigration> {
  const migrationId = `baseline:v${String(version)}`;
  const definition: PostgresMigrationDefinition = {
    migrationId,
    name: `Adopt existing unversioned ERP Financials schema v${String(version)}`,
    fromVersion: 0,
    toVersion: version,
    sql: "",
    checksum: sha256(`${migrationId}:${namespace}`)
  };
  return recordMigration(client, definition, 0, appliedByRef);
}

async function recordMigration(
  client: PostgresQueryClient,
  definition: PostgresMigrationDefinition,
  executionMs: number,
  appliedByRef: string
): Promise<AppliedPostgresMigration> {
  const result = await client.query(
    `insert into "${namespace}"."schema_migrations" (
  "migration_id", "from_version", "to_version", "name", "checksum", "manifest_version", "execution_ms", "applied_by_ref"
) values ($1, $2, $3, $4, $5, $6, $7, $8)
returning "migration_id", "from_version", "to_version", "name", "checksum", "manifest_version", "execution_ms", "applied_by_ref", "applied_at"`,
    [
      definition.migrationId,
      definition.fromVersion,
      definition.toVersion,
      definition.name,
      definition.checksum,
      POSTGRES_CANONICAL_SCHEMA_MANIFEST.manifestVersion,
      executionMs,
      appliedByRef
    ]
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`Migration ledger did not return ${definition.migrationId}`);
  }
  return appliedMigrationFromRow(row);
}

function appliedMigrationFromRow(row: Readonly<Record<string, unknown>>): AppliedPostgresMigration {
  const migrationId = requiredString(row.migration_id, "migration_id");
  return {
    migrationId,
    fromVersion: requiredInteger(row.from_version, "from_version"),
    toVersion: requiredInteger(row.to_version, "to_version"),
    name: requiredString(row.name, "name"),
    checksum: requiredString(row.checksum, "checksum"),
    manifestVersion: requiredString(row.manifest_version, "manifest_version"),
    executionMs: requiredInteger(row.execution_ms, "execution_ms"),
    appliedByRef: requiredString(row.applied_by_ref, "applied_by_ref"),
    appliedAt: requiredDateTime(row.applied_at, "applied_at"),
    baseline: migrationId.startsWith("baseline:v")
  };
}

function latestAppliedVersion(applied: readonly AppliedPostgresMigration[]): number {
  return applied.reduce((latest, entry) => Math.max(latest, entry.toVersion), 0);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Migration row ${field} must be a non-empty string`);
  }
  return value;
}

function requiredInteger(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed)) {
    throw new Error(`Migration row ${field} must be an integer`);
  }
  return parsed;
}

function requiredDateTime(value: unknown, field: string): string {
  const dateTime = value instanceof Date ? value.toISOString() : requiredString(value, field);
  if (Number.isNaN(Date.parse(dateTime))) {
    throw new Error(`Migration row ${field} must be an ISO date-time`);
  }
  return dateTime;
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${field} must not be empty`);
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function schemaValidationMessage(issues: readonly PostgresSchemaValidationIssue[]): string {
  const firstIssues = issues.slice(0, 10).map((issue) => issue.message);
  return `Migrated schema failed compatibility validation: ${firstIssues.join("; ")}${issues.length > 10 ? "; additional issues omitted" : ""}`;
}
