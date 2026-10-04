import { describe, expect, it } from "vitest";

import {
  FUTURE_ERP_CANONICAL_SCHEMA_PREFLIGHT_ERROR_CODE,
  FutureErpCanonicalSchemaPreflightError,
  POSTGRES_CANONICAL_SCHEMA_MANIFEST,
  validateFutureErpCanonicalSchemaPreflight
} from "../src/index.js";

import type { PostgresQueryClient, PostgresQueryResult, PostgresSchemaManifest } from "../src/index.js";

type QueryCall = {
  readonly sql: string;
  readonly params: readonly unknown[];
};

type CatalogRow = {
  readonly object_type: "schema" | "table" | "column" | "index" | "constraint" | "trigger";
  readonly table_name: string | null;
  readonly object_name: string;
};

describe("Future ERP canonical schema preflight", () => {
  it("returns compatible validation details before import jobs persist facts", async () => {
    const client = new StubPostgresClient(catalogRowsForManifest(POSTGRES_CANONICAL_SCHEMA_MANIFEST));

    const validation = await validateFutureErpCanonicalSchemaPreflight(client, {
      jobName: "quickbooks-full-import"
    });

    expect(validation.compatible).toBe(true);
    expect(validation.issues).toEqual([]);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.sql).toContain("information_schema.schemata");
  });

  it("can install the canonical schema on a blank database before validating", async () => {
    const client = new BlankSchemaInstallClient(POSTGRES_CANONICAL_SCHEMA_MANIFEST);

    const validation = await validateFutureErpCanonicalSchemaPreflight(client, {
      jobName: "quickbooks-full-import",
      installSchemaIfMissing: true
    });

    expect(validation.compatible).toBe(true);
    expect(validation.fixtureSupport).toBe(true);
    expect(validation.issues).toEqual([]);
    expect(validation.install).toMatchObject({
      executed: true,
      manifestVersion: POSTGRES_CANONICAL_SCHEMA_MANIFEST.manifestVersion,
      schemaVersion: POSTGRES_CANONICAL_SCHEMA_MANIFEST.schemaVersion
    });
    expect(client.calls[0]?.sql).toBe('create schema if not exists "erp_financials";');
    expect(client.calls.some((call) => call.sql.includes('create table if not exists "erp_financials"."ledger_postings"'))).toBe(
      true
    );
    expect(client.calls.at(-1)?.sql).toContain("information_schema.schemata");
  });

  it("throws a deterministic preflight failure with issue details for incompatible schemas", async () => {
    const client = new StubPostgresClient([
      {
        object_type: "schema",
        table_name: null,
        object_name: POSTGRES_CANONICAL_SCHEMA_MANIFEST.namespace
      }
    ]);

    let caughtError: unknown;

    try {
      await validateFutureErpCanonicalSchemaPreflight(client, {
        jobName: "quickbooks-incremental-import"
      });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toMatchObject({
      name: "FutureErpCanonicalSchemaPreflightError",
      code: FUTURE_ERP_CANONICAL_SCHEMA_PREFLIGHT_ERROR_CODE,
      jobName: "quickbooks-incremental-import"
    });
    expect(caughtError).toBeInstanceOf(FutureErpCanonicalSchemaPreflightError);

    if (!(caughtError instanceof FutureErpCanonicalSchemaPreflightError)) {
      throw caughtError;
    }

    expect(caughtError.message).toContain("missing_table:accounting_companies");
    expect(caughtError.message).toContain("missing_fixture_support:ledger_postings.ledger_postings");
    expect(caughtError.issues.map((issue) => issue.kind)).toEqual(
      expect.arrayContaining(["missing_table", "missing_index", "missing_constraint", "missing_fixture_support"])
    );
    expect(caughtError.toJSON()).toMatchObject({
      code: FUTURE_ERP_CANONICAL_SCHEMA_PREFLIGHT_ERROR_CODE,
      jobName: "quickbooks-incremental-import",
      validation: {
        compatible: false,
        fixtureSupport: false
      }
    });
    expect(client.calls).toHaveLength(1);
  });
});

class StubPostgresClient implements PostgresQueryClient {
  readonly calls: QueryCall[] = [];

  constructor(private readonly catalogRows: readonly CatalogRow[]) {}

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
