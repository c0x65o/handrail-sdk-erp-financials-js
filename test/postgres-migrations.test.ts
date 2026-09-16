import { describe, expect, it } from "vitest";

import {
  POSTGRES_CANONICAL_SCHEMA_MANIFEST,
  POSTGRES_MIGRATIONS,
  PostgresMigrationError,
  migratePostgresSchema,
  planPostgresMigrations,
  validatePostgresMigrationHistory
} from "../src/index.js";

import type {
  AppliedPostgresMigration,
  PostgresMigrationTransactionRunner,
  PostgresQueryClient,
  PostgresQueryResult,
  PostgresSchemaManifest
} from "../src/index.js";

type CatalogRow = {
  readonly object_type: "schema" | "table" | "column" | "index" | "constraint" | "trigger";
  readonly table_name: string | null;
  readonly object_name: string;
  readonly data_type?: string | null;
  readonly is_nullable?: string | null;
  readonly definition?: string | null;
  readonly enabled?: boolean | null;
};

type DatabaseState = {
  version: number;
  ledgerExists: boolean;
  ledger: AppliedPostgresMigration[];
};

describe("Postgres schema migrations", () => {
  it("ships an immutable, checksum-addressed path from blank through the current schema", () => {
    expect(POSTGRES_MIGRATIONS.map((entry) => [entry.fromVersion, entry.toVersion])).toEqual([
      [0, 6],
      [6, 7],
      [7, 8],
      [8, 9],
      [9, 10],
      [10, 11],
      [11, 12],
      [12, 13],
      [13, 14],
      [14, 15],
      [15, 16],
      [16, 17],
      [17, 18],
      [18, 19],
      [19, 20],
      [20, 21],
      [21, 22],
      [22, 23],
      [23, 24],
      [24, 25]
    ]);
    expect(POSTGRES_MIGRATIONS.every((entry) => /^[a-f0-9]{64}$/.test(entry.checksum))).toBe(true);
    expect(new Set(POSTGRES_MIGRATIONS.map((entry) => entry.migrationId)).size).toBe(
      POSTGRES_MIGRATIONS.length
    );
  });

  it("plans a blank install without locking or mutating the database", async () => {
    const client = new MigrationClient({ version: 0, ledgerExists: false, ledger: [] });

    const plan = await planPostgresMigrations(client);

    expect(plan.currentVersion).toBe(0);
    expect(plan.targetVersion).toBe(25);
    expect(plan.requiresBaselineAdoption).toBe(false);
    expect(plan.pendingMigrations).toEqual(POSTGRES_MIGRATIONS);
    expect(client.calls.some((call) => call.includes("pg_advisory_xact_lock"))).toBe(false);
    expect(client.state).toEqual({ version: 0, ledgerExists: false, ledger: [] });
  });

  it("locks, transactionally installs a blank database, validates it, and records every migration", async () => {
    const client = new MigrationClient({ version: 0, ledgerExists: false, ledger: [] });
    const runner = new MemoryTransactionRunner(client);

    const result = await migratePostgresSchema(runner, { appliedByRef: "deploy:future-erp:42" });

    expect(result.currentVersion).toBe(0);
    expect(result.targetVersion).toBe(25);
    expect(result.adoptedBaselineVersion).toBeUndefined();
    expect(result.applied.map((entry) => [entry.fromVersion, entry.toVersion])).toEqual([
      [0, 6],
      [6, 7],
      [7, 8],
      [8, 9],
      [9, 10],
      [10, 11],
      [11, 12],
      [12, 13],
      [13, 14],
      [14, 15],
      [15, 16],
      [16, 17],
      [17, 18],
      [18, 19],
      [19, 20],
      [20, 21],
      [21, 22],
      [22, 23],
      [23, 24],
      [24, 25]
    ]);
    expect(client.state.version).toBe(25);
    expect(client.state.ledger.map((entry) => entry.migrationId)).toEqual(
      POSTGRES_MIGRATIONS.map((entry) => entry.migrationId)
    );
    expect(client.calls[0]).toContain("pg_advisory_xact_lock");
    expect(runner.commits).toBe(1);
    expect(runner.rollbacks).toBe(0);
  });

  it("adopts an unversioned v6 database and applies only the remaining ordered upgrades", async () => {
    const client = new MigrationClient({ version: 6, ledgerExists: false, ledger: [] });
    const runner = new MemoryTransactionRunner(client);

    const result = await migratePostgresSchema(runner, { appliedByRef: "operator:ray" });

    expect(result.adoptedBaselineVersion).toBe(6);
    expect(result.applied.map((entry) => entry.migrationId)).toEqual(
      POSTGRES_MIGRATIONS.slice(1).map((entry) => entry.migrationId)
    );
    expect(client.state.ledger.map((entry) => entry.migrationId)).toEqual([
      "baseline:v6",
      ...POSTGRES_MIGRATIONS.slice(1).map((entry) => entry.migrationId)
    ]);
  });

  it("treats a pre-created empty ledger as v7 until a durable v8 row is recorded", async () => {
    const client = new MigrationClient({ version: 7, ledgerExists: true, ledger: [] });

    const plan = await planPostgresMigrations(client);

    expect(plan.currentVersion).toBe(7);
    expect(plan.requiresBaselineAdoption).toBe(true);
    expect(plan.pendingMigrations.map((entry) => entry.toVersion)).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25]);
  });

  it("reports an existing unversioned schema as requiring baseline adoption", async () => {
    const client = new MigrationClient({ version: 6, ledgerExists: false, ledger: [] });

    await expect(validatePostgresMigrationHistory(client)).resolves.toMatchObject({
      compatible: false,
      currentVersion: 6,
      issues: [{ kind: "unversioned_schema", migrationId: "unversioned:v6" }]
    });
  });

  it("fails closed on checksum drift and rolls back the transaction", async () => {
    const firstMigration = POSTGRES_MIGRATIONS[0];
    if (firstMigration === undefined) {
      throw new Error("migration fixture requires a bootstrap migration");
    }
    const client = new MigrationClient({
      version: 6,
      ledgerExists: true,
      ledger: [appliedRow(firstMigration, { checksum: "0".repeat(64) })]
    });
    const runner = new MemoryTransactionRunner(client);

    await expect(migratePostgresSchema(runner, { appliedByRef: "deploy:drift-check" })).rejects.toMatchObject({
      code: "migration_history_drift"
    } satisfies Partial<PostgresMigrationError>);

    expect(runner.commits).toBe(0);
    expect(runner.rollbacks).toBe(1);
    expect(client.state.version).toBe(6);
    expect(client.state.ledger).toHaveLength(1);
  });

  it("fails a read-only plan when stored migration identity metadata drifts", async () => {
    const firstMigration = POSTGRES_MIGRATIONS[0];
    if (firstMigration === undefined) {
      throw new Error("migration fixture requires a bootstrap migration");
    }
    const client = new MigrationClient({
      version: 7,
      ledgerExists: true,
      ledger: [appliedRow(firstMigration, { toVersion: 7, name: "tampered migration name" })]
    });

    await expect(planPostgresMigrations(client)).rejects.toMatchObject({
      code: "migration_history_drift"
    } satisfies Partial<PostgresMigrationError>);
    const validation = await validatePostgresMigrationHistory(client);
    expect(validation.compatible).toBe(false);
    expect(validation.issues.some((issue) => issue.kind === "definition_mismatch")).toBe(true);
  });

  it("rolls back schema and ledger changes when an upgrade statement fails", async () => {
    const client = new MigrationClient(
      { version: 6, ledgerExists: false, ledger: [] },
      POSTGRES_MIGRATIONS[1]?.migrationId
    );
    const runner = new MemoryTransactionRunner(client);

    await expect(migratePostgresSchema(runner, { appliedByRef: "deploy:failure-test" })).rejects.toThrow(
      "injected migration failure"
    );

    expect(runner.rollbacks).toBe(1);
    expect(client.state).toEqual({ version: 6, ledgerExists: false, ledger: [] });
  });
});

class MemoryTransactionRunner implements PostgresMigrationTransactionRunner {
  commits = 0;
  rollbacks = 0;

  constructor(private readonly client: MigrationClient) {}

  async transaction<Result>(work: (client: PostgresQueryClient) => Promise<Result>): Promise<Result> {
    const before = structuredClone(this.client.state);
    try {
      const result = await work(this.client);
      this.commits += 1;
      return result;
    } catch (error) {
      this.client.state = before;
      this.rollbacks += 1;
      throw error;
    }
  }
}

class MigrationClient implements PostgresQueryClient {
  readonly calls: string[] = [];

  constructor(
    public state: DatabaseState,
    private readonly failMigrationId?: string
  ) {}

  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = []
  ): Promise<PostgresQueryResult<Row>> {
    this.calls.push(sql);

    if (sql.startsWith("select pg_advisory_xact_lock")) {
      return this.result<Row>([]);
    }

    if (sql.includes("select to_regclass")) {
      const relation = params[0];
      const exists =
        relation === "erp_financials.report_snapshots"
          ? this.state.version >= 6
          : relation === "erp_financials.schema_migrations"
            ? this.state.ledgerExists
            : relation === "erp_financials.company_sources"
              ? this.state.version >= 9
              : relation === "erp_financials.financial_lifecycle_events"
                ? this.state.version >= 10
                : relation === "erp_financials.fiscal_periods" || relation === "erp_financials.accounting_book_controls"
                  ? this.state.version >= 11
                  : relation === "erp_financials.journal_entry_links"
                    ? this.state.version >= 12
                    : relation === "erp_financials.subledger_documents" || relation === "erp_financials.subledger_applications"
                      ? this.state.version >= 13
                      : relation === "erp_financials.reporting_books" || relation === "erp_financials.financial_outbox"
                        ? this.state.version >= 14
            : false;
      return this.result<Row>([{ relation_name: exists ? relation : null }]);
    }

    if (sql.includes("information_schema.columns") && sql.includes("report_snapshots")) {
      return this.result<Row>(
        this.state.version >= 7 ? [{ column_name: "company_id" }, { column_name: "source_id" }] : []
      );
    }

    if (sql.includes("information_schema.columns") && sql.includes("transaction_lines")) {
      return this.result<Row>(
        this.state.version >= 9
          ? [
              { column_name: "source_id" },
              { column_name: "company_id" },
              { column_name: "source_id" },
              { column_name: "company_id" },
              { column_name: "source_id" }
            ]
          : []
      );
    }

    if (sql.includes("from information_schema.schemata")) {
      return this.result<Row>(catalogRowsForManifest(POSTGRES_CANONICAL_SCHEMA_MANIFEST));
    }

    if (sql.includes('from "erp_financials"."schema_migrations"')) {
      return this.result<Row>(this.state.ledger.map(rowToDatabase));
    }

    if (sql.includes('insert into "erp_financials"."schema_migrations"')) {
      const row: AppliedPostgresMigration = {
        migrationId: String(params[0]),
        fromVersion: Number(params[1]),
        toVersion: Number(params[2]),
        name: String(params[3]),
        checksum: String(params[4]),
        manifestVersion: String(params[5]),
        executionMs: Number(params[6]),
        appliedByRef: String(params[7]),
        appliedAt: "2026-08-12T22:00:00.000Z",
        baseline: String(params[0]).startsWith("baseline:v")
      };
      this.state.ledger.push(row);
      return this.result<Row>([rowToDatabase(row)], 1);
    }

    const definition = POSTGRES_MIGRATIONS.find((entry) => entry.sql === sql);
    if (definition !== undefined) {
      if (definition.migrationId === this.failMigrationId) {
        throw new Error("injected migration failure");
      }
      this.state.version = definition.toVersion;
      if (definition.toVersion === 8) {
        this.state.ledgerExists = true;
      }
      return this.result<Row>([]);
    }

    if (sql.includes('create table if not exists "erp_financials"."schema_migrations"')) {
      this.state.ledgerExists = true;
      return this.result<Row>([]);
    }

    if (sql.startsWith("create schema if not exists")) {
      return this.result<Row>([]);
    }

    throw new Error(`Unexpected migration test query: ${sql.slice(0, 100)}`);
  }

  private result<Row extends Record<string, unknown>>(
    rows: readonly Record<string, unknown>[],
    rowCount: number | null = rows.length
  ): Promise<PostgresQueryResult<Row>> {
    return Promise.resolve({ rows: rows as readonly Row[], rowCount });
  }
}

function appliedRow(
  definition: (typeof POSTGRES_MIGRATIONS)[number],
  overrides: Partial<AppliedPostgresMigration> = {}
): AppliedPostgresMigration {
  return {
    migrationId: definition.migrationId,
    fromVersion: definition.fromVersion,
    toVersion: definition.toVersion,
    name: definition.name,
    checksum: definition.checksum,
    manifestVersion: POSTGRES_CANONICAL_SCHEMA_MANIFEST.manifestVersion,
    executionMs: 1,
    appliedByRef: "deploy:fixture",
    appliedAt: "2026-08-12T21:00:00.000Z",
    baseline: false,
    ...overrides
  };
}

function rowToDatabase(row: AppliedPostgresMigration): Record<string, unknown> {
  return {
    migration_id: row.migrationId,
    from_version: row.fromVersion,
    to_version: row.toVersion,
    name: row.name,
    checksum: row.checksum,
    manifest_version: row.manifestVersion,
    execution_ms: row.executionMs,
    applied_by_ref: row.appliedByRef,
    applied_at: row.appliedAt
  };
}

function catalogRowsForManifest(manifest: PostgresSchemaManifest): readonly CatalogRow[] {
  return [
    { object_type: "schema", table_name: null, object_name: manifest.namespace },
    ...manifest.tables.flatMap((table) => [
      { object_type: "table" as const, table_name: table.name, object_name: table.name },
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
