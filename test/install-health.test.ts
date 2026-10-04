import { describe, expect, it } from "vitest";

import {
  ERP_FINANCIALS_PACKAGE,
  POSTGRES_CANONICAL_SCHEMA_MANIFEST,
  checkErpFinancialsInstallHealth
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

const PROVIDER_CREDENTIAL_OR_RAW_PAYLOAD_KEY_PATTERN =
  /access[_-]?token|refresh[_-]?token|client[_-]?secret|clientSecret|secret|password|rawPayload|rawProviderPayload|raw_provider_payload|raw_payload/i;

describe("ERP Financials install health", () => {
  it("returns healthy package, manifest, schema, fixture, and credential-column status for compatible installs", async () => {
    const client = new StubPostgresClient(catalogRowsForManifest(POSTGRES_CANONICAL_SCHEMA_MANIFEST));

    const health = await checkErpFinancialsInstallHealth(client);

    expect(health).toMatchObject({
      packageName: "@handrail/erp-financials",
      packageVersion: ERP_FINANCIALS_PACKAGE.version,
      manifestVersion: POSTGRES_CANONICAL_SCHEMA_MANIFEST.manifestVersion,
      schemaVersion: POSTGRES_CANONICAL_SCHEMA_MANIFEST.schemaVersion,
      status: "healthy",
      schema: {
        namespace: "erp_financials",
        dialect: "postgres",
        compatible: true,
        fixtureSupport: true,
        noCredentialColumns: true,
        issues: {
          missingTables: [],
          missingColumns: [],
          missingIndexes: [],
          missingConstraints: [],
          credentialColumns: []
        }
      },
      issues: []
    });
    expect(health.checks).toEqual([
      { name: "schema_compatibility", status: "pass", issueCount: 0 },
      { name: "fixture_support", status: "pass", issueCount: 0 },
      { name: "no_credential_columns", status: "pass", issueCount: 0 }
    ]);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.sql).toContain("information_schema.schemata");
  });

  it("returns degraded structured issues for missing schema objects and fixture support", async () => {
    const client = new StubPostgresClient([
      {
        object_type: "schema",
        table_name: null,
        object_name: POSTGRES_CANONICAL_SCHEMA_MANIFEST.namespace
      }
    ]);

    const health = await checkErpFinancialsInstallHealth(client);

    expect(health.status).toBe("degraded");
    expect(health.schema.compatible).toBe(false);
    expect(health.schema.fixtureSupport).toBe(false);
    expect(health.schema.noCredentialColumns).toBe(true);
    expect(health.schema.issues.missingTables).toContain("ledger_postings");
    expect(health.schema.issues.missingIndexes).toContain("ledger_postings_source_posting_uidx");
    expect(health.schema.issues.missingConstraints).toContain("ledger_postings.ledger_postings_pkey");
    expect(health.issues.map((issue) => issue.kind)).toEqual(
      expect.arrayContaining(["missing_table", "missing_index", "missing_constraint", "missing_fixture_support"])
    );
    const fixtureSupportCheck = health.checks.find((check) => check.name === "fixture_support");
    expect(fixtureSupportCheck).toMatchObject({ name: "fixture_support", status: "fail" });
    expect(fixtureSupportCheck?.issueCount).toBeGreaterThan(0);
    expect(JSON.stringify(health)).not.toMatch(PROVIDER_CREDENTIAL_OR_RAW_PAYLOAD_KEY_PATTERN);
  });

  it("keeps thrown schema validation failures bounded without raw error payloads", async () => {
    const client = new ThrowingPostgresClient("access_token=fixture-secret rawPayload={do-not-serialize}");

    const health = await checkErpFinancialsInstallHealth(client);

    expect(health).toMatchObject({
      status: "degraded",
      schema: {
        compatible: false,
        fixtureSupport: false,
        noCredentialColumns: true
      },
      issues: [
        {
          kind: "schema_validation_failed",
          objectName: "schema_validation",
          message: "schema validation failed before compatibility could be confirmed"
        }
      ]
    });
    expect(JSON.stringify(health)).not.toMatch(PROVIDER_CREDENTIAL_OR_RAW_PAYLOAD_KEY_PATTERN);
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

class ThrowingPostgresClient implements PostgresQueryClient {
  constructor(private readonly message: string) {}

  query<Row extends Record<string, unknown> = Record<string, unknown>>(): Promise<PostgresQueryResult<Row>> {
    return Promise.reject(new Error(this.message));
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
