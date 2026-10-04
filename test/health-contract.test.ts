import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  POSTGRES_CANONICAL_SCHEMA_MANIFEST,
  checkErpFinancialsFreshnessAndDrilldownHealth,
  checkErpFinancialsInstallHealth,
  runErpFinancialsFixtureSmokeHealth
} from "../src/index.js";

import type { PostgresQueryClient, PostgresQueryResult, PostgresSchemaManifest } from "../src/index.js";

type CatalogRow = {
  readonly object_type: "schema" | "table" | "column" | "index" | "constraint" | "trigger";
  readonly table_name: string | null;
  readonly object_name: string;
};

const PROVIDER_CREDENTIAL_MATERIAL_PATTERN =
  /access[_-]?token|refresh[_-]?token|client[_-]?secret|clientSecret|secret|password|rawPayload|rawProviderPayload|raw_provider_payload|raw_payload/i;

describe("ERP Financials health contract smoke", () => {
  it("runs the deterministic host-app health contract without provider credentials or network calls", async () => {
    const install = await checkErpFinancialsInstallHealth(
      new CatalogPostgresClient(catalogRowsForManifest(POSTGRES_CANONICAL_SCHEMA_MANIFEST))
    );
    const fixtureSmoke = await runErpFinancialsFixtureSmokeHealth();
    const repeatedFixtureSmoke = await runErpFinancialsFixtureSmokeHealth();
    const freshnessDrilldown = checkErpFinancialsFreshnessAndDrilldownHealth();
    const repeatedFreshnessDrilldown = checkErpFinancialsFreshnessAndDrilldownHealth();

    expect(install.status).toBe("healthy");
    expect(install.checks).toEqual([
      { name: "schema_compatibility", status: "pass", issueCount: 0 },
      { name: "fixture_support", status: "pass", issueCount: 0 },
      { name: "no_credential_columns", status: "pass", issueCount: 0 }
    ]);
    expect(fixtureSmoke.status).toBe("healthy");
    expect(fixtureSmoke.storageMode).toBe("simulated");
    expect(fixtureSmoke.summaryHash).toBe(repeatedFixtureSmoke.summaryHash);
    expect(fixtureSmoke.rowCounts.fixture.postings).toBe(22);
    expect(fixtureSmoke.rowCounts.reportSnapshots).toBe(4);
    expect(fixtureSmoke.rowCounts.reportFreshness).toBe(4);
    expect(freshnessDrilldown.status).toBe("healthy");
    expect(freshnessDrilldown.summaryHash).toBe(repeatedFreshnessDrilldown.summaryHash);
    expect(freshnessDrilldown.freshness).toMatchObject({
      expectedRows: 4,
      presentRows: 4,
      missingRows: []
    });
    expect(freshnessDrilldown.drilldown.reportsChecked).toBe(4);
    expect(freshnessDrilldown.drilldown.refsChecked).toBeGreaterThan(0);

    const hostHealthContract = {
      install,
      fixtureSmoke: {
        status: fixtureSmoke.status,
        summaryHash: fixtureSmoke.summaryHash,
        snapshotIds: fixtureSmoke.snapshotIds,
        freshnessIds: fixtureSmoke.freshnessIds,
        rowCounts: fixtureSmoke.rowCounts,
        totals: fixtureSmoke.totals
      },
      freshnessDrilldown: {
        status: freshnessDrilldown.status,
        summaryHash: freshnessDrilldown.summaryHash,
        checks: freshnessDrilldown.checks,
        freshness: freshnessDrilldown.freshness,
        drilldown: freshnessDrilldown.drilldown
      }
    };

    expect(JSON.stringify(hostHealthContract)).not.toMatch(PROVIDER_CREDENTIAL_MATERIAL_PATTERN);
  });

  it("keeps generated declaration output free of provider credential material when dist is present", () => {
    const distDeclarationUrl = new URL("../dist/index.d.ts", import.meta.url);

    if (!existsSync(distDeclarationUrl)) {
      return;
    }

    const declaration = readFileSync(distDeclarationUrl, "utf8");

    expect(declaration).not.toMatch(PROVIDER_CREDENTIAL_MATERIAL_PATTERN);
  });
});

class CatalogPostgresClient implements PostgresQueryClient {
  constructor(private readonly catalogRows: readonly CatalogRow[]) {}

  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string
  ): Promise<PostgresQueryResult<Row>> {
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
