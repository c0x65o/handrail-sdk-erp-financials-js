import { describe, expect, it } from "vitest";

import {
  ERP_FINANCIALS_PACKAGE,
  POSTGRES_CANONICAL_SCHEMA_MANIFEST,
  createFutureErpInstallHealthPreflightWorker,
  preflightFutureErpInstallHealth
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

const PROVIDER_SECRET_OR_RAW_PAYLOAD_PATTERN =
  /access[_-]?token|refresh[_-]?token|client[_-]?secret|clientSecret|password|rawPayload|rawProviderPayload|raw_provider_payload|raw_payload/i;

describe("Future ERP install health preflight", () => {
  it("returns healthy structured install and fixture smoke results for dev/test callers", async () => {
    const client = new StubPostgresClient(catalogRowsForManifest(POSTGRES_CANONICAL_SCHEMA_MANIFEST));

    const preflight = await preflightFutureErpInstallHealth({
      client,
      executionEnvironment: "test",
      generatedAt: "2026-06-20T07:00:00.000Z"
    });

    expect(preflight).toMatchObject({
      preflightName: "future_erp_install_health",
      status: "healthy",
      executionEnvironment: "test",
      generatedAt: "2026-06-20T07:00:00.000Z",
      install: {
        packageName: "@handrail/erp-financials",
        packageVersion: ERP_FINANCIALS_PACKAGE.version,
        manifestVersion: POSTGRES_CANONICAL_SCHEMA_MANIFEST.manifestVersion,
        schemaVersion: POSTGRES_CANONICAL_SCHEMA_MANIFEST.schemaVersion,
        namespace: "erp_financials",
        dialect: "postgres",
        compatible: true,
        fixtureSupport: true,
        sensitiveColumnBoundary: "pass",
        issueCounts: {
          schema: 0,
          fixtureSupport: 0,
          sensitiveColumnBoundary: 0
        }
      },
      fixtureSmoke: {
        status: "healthy",
        storageMode: "simulated",
        fixtureName: "ERP_FINANCIALS_STATEMENT_FIXTURE",
        rowCounts: {
          reportSnapshots: 4,
          reportFreshness: 4,
          snapshotRowsWritten: 0,
          freshnessRowsWritten: 0
        },
        reportStatuses: {
          profit_and_loss: "pass",
          balance_sheet: "pass",
          trial_balance: "pass",
          cash_flow: "pass"
        },
        issueCount: 0
      },
      checks: [
        { name: "dev_test_only_execution", status: "pass", issueCount: 0 },
        { name: "erp_financials_install_schema", status: "pass", issueCount: 0 },
        { name: "erp_financials_fixture_support", status: "pass", issueCount: 0 },
        { name: "erp_financials_sensitive_column_boundary", status: "pass", issueCount: 0 },
        { name: "erp_financials_fixture_smoke", status: "pass", issueCount: 0 }
      ],
      issues: []
    });
    expect(preflight.fixtureSmoke?.summaryHash).toHaveLength(64);
    expect(JSON.stringify(preflight)).not.toMatch(PROVIDER_SECRET_OR_RAW_PAYLOAD_PATTERN);
    expect(client.calls).toHaveLength(1);
  });

  it("fails closed as blocked when the canonical schema is incompatible", async () => {
    const client = new StubPostgresClient([
      {
        object_type: "schema",
        table_name: null,
        object_name: POSTGRES_CANONICAL_SCHEMA_MANIFEST.namespace
      }
    ]);
    const worker = createFutureErpInstallHealthPreflightWorker({
      client,
      executionEnvironment: "dev",
      generatedAt: "2026-06-20T07:01:00.000Z"
    });

    const preflight = await worker.preflight();

    expect(preflight.status).toBe("blocked");
    expect(preflight.install).toMatchObject({
      compatible: false,
      fixtureSupport: false,
      sensitiveColumnBoundary: "pass"
    });
    const schemaCheck = preflight.checks.find((check) => check.name === "erp_financials_install_schema");
    expect(schemaCheck).toEqual({
      name: "erp_financials_install_schema",
      status: "fail",
      issueCount: schemaCheck?.issueCount,
      message: "Canonical schema is incompatible."
    });
    expect(schemaCheck?.issueCount).toBeGreaterThan(0);
    expect(preflight.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "schema_incompatible",
          severity: "blocker",
          checkName: "erp_financials_install_schema"
        }),
        expect.objectContaining({
          kind: "fixture_support_missing",
          severity: "blocker",
          checkName: "erp_financials_fixture_support"
        })
      ])
    );
    expect(preflight.fixtureSmoke?.status).toBe("healthy");
    expect(JSON.stringify(preflight)).not.toMatch(PROVIDER_SECRET_OR_RAW_PAYLOAD_PATTERN);
  });

  it("blocks outside dev/test even when install and fixture smoke checks are otherwise healthy", async () => {
    const client = new StubPostgresClient(catalogRowsForManifest(POSTGRES_CANONICAL_SCHEMA_MANIFEST));

    const preflight = await preflightFutureErpInstallHealth({
      client,
      executionEnvironment: "production",
      generatedAt: "2026-06-20T07:02:00.000Z"
    });

    expect(preflight.status).toBe("blocked");
    expect(preflight.checks[0]).toMatchObject({
      name: "dev_test_only_execution",
      status: "fail",
      issueCount: 1
    });
    expect(preflight.install?.compatible).toBe(true);
    expect(preflight.fixtureSmoke?.status).toBe("healthy");
    expect(preflight.issues).toContainEqual({
      kind: "environment_not_allowed",
      severity: "blocker",
      checkName: "dev_test_only_execution",
      message: "Future ERP install health preflight is only available in dev and test environments."
    });
  });

  it("returns degraded when deterministic fixture smoke storage hooks are incomplete", async () => {
    const client = new StubPostgresClient(catalogRowsForManifest(POSTGRES_CANONICAL_SCHEMA_MANIFEST));

    const preflight = await preflightFutureErpInstallHealth({
      client,
      executionEnvironment: "dev",
      generatedAt: "2026-06-20T07:03:00.000Z",
      fixtureSmoke: {
        storage: {}
      }
    });

    expect(preflight.status).toBe("degraded");
    expect(preflight.install?.compatible).toBe(true);
    expect(preflight.fixtureSmoke).toMatchObject({
      status: "degraded",
      storageMode: "storage",
      issueCount: 4
    });
    expect(preflight.checks).toContainEqual({
      name: "erp_financials_fixture_smoke",
      status: "warn",
      issueCount: 4,
      message: "Deterministic fixture smoke checks returned degraded results."
    });
    expect(preflight.issues).toContainEqual({
      kind: "fixture_smoke_degraded",
      severity: "warning",
      checkName: "erp_financials_fixture_smoke",
      message: "ERP Financials deterministic fixture smoke checks returned degraded results."
    });
  });

  it("omits raw schema validation failures from blocked preflight output", async () => {
    const client = new ThrowingPostgresClient("access_token=fixture-secret rawPayload={do-not-serialize}");

    const preflight = await preflightFutureErpInstallHealth({
      client,
      executionEnvironment: "dev",
      generatedAt: "2026-06-20T07:04:00.000Z"
    });

    expect(preflight.status).toBe("blocked");
    expect(preflight.install).toMatchObject({
      compatible: false,
      fixtureSupport: false,
      sensitiveColumnBoundary: "pass"
    });
    expect(preflight.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "schema_incompatible",
          message: "schema_validation_failed:schema_validation"
        })
      ])
    );
    expect(JSON.stringify(preflight)).not.toMatch(PROVIDER_SECRET_OR_RAW_PAYLOAD_PATTERN);
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
