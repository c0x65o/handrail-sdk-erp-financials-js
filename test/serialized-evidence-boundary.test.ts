import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ERP_FINANCIALS_NORMALIZED_QUICKBOOKS_SYNC_FIXTURES,
  POSTGRES_MIGRATIONS,
  POSTGRES_CANONICAL_SCHEMA_MANIFEST,
  createPostgresStorageAdapter,
  renderPostgresSchemaSql,
  runFutureErpQuickBooksSandboxReplay
} from "../src/index.js";

import type { PostgresQueryClient, PostgresQueryResult } from "../src/index.js";

type CapturedQuery = {
  readonly sql: string;
  readonly params: readonly unknown[];
};

type EvidenceSurface = {
  readonly name: string;
  readonly value: unknown;
};

const PROVIDER_CREDENTIAL_OR_RAW_PAYLOAD_KEY_PATTERN =
  /access[_-]?token|refresh[_-]?token|client[_-]?secret|clientSecret|credential|rawPayload|rawProviderPayload|raw_provider_payload|raw_payload/i;

const FUTURE_ERP_CANONICAL_SCHEMA_MIGRATION_SQL = POSTGRES_MIGRATIONS.map((migration) => migration.sql).join("\n");

describe("serialized evidence credential and raw payload boundary", () => {
  it("keeps app-owned financial tables bounded and credential-free", () => {
    const jsonColumns = POSTGRES_CANONICAL_SCHEMA_MANIFEST.tables.flatMap((table) =>
      table.columns
        .filter((column) => column.type === "jsonb")
        .map((column) => ({
          tableName: table.name,
          columnName: column.name,
          maxBytes: column.maxBytes
        }))
    );
    const forbiddenColumns = POSTGRES_CANONICAL_SCHEMA_MANIFEST.tables.flatMap((table) =>
      table.columns
        .filter((column) => PROVIDER_CREDENTIAL_OR_RAW_PAYLOAD_KEY_PATTERN.test(column.name))
        .map((column) => `${table.name}.${column.name}`)
    );

    expect(forbiddenColumns).toEqual([]);
    expect(jsonColumns.length).toBeGreaterThanOrEqual(14);
    expect(jsonColumns.every((column) => column.maxBytes !== undefined)).toBe(true);
    for (const table of POSTGRES_CANONICAL_SCHEMA_MANIFEST.tables) {
      expect(renderPostgresSchemaSql()).toContain(`create table if not exists "erp_financials"."${table.name}"`);
    }
    expect(FUTURE_ERP_CANONICAL_SCHEMA_MIGRATION_SQL).not.toMatch(PROVIDER_CREDENTIAL_OR_RAW_PAYLOAD_KEY_PATTERN);
  });

  it("keeps fixtures, replay summaries, and output-store writes credential-free", async () => {
    const client = new CapturingPostgresClient();
    const replay = await runFutureErpQuickBooksSandboxReplay({
      postgresStorage: createPostgresStorageAdapter(client)
    });
    const replaySummary = {
      importBatchId: replay.importBatchId,
      checkpointId: replay.checkpointId,
      sourceIdentity: replay.sourceIdentity,
      normalizedResourceCounts: replay.normalizedResourceCounts,
      canonicalRowCounts: replay.canonicalRowCounts,
      reportStatuses: replay.reportStatuses,
      snapshotIds: replay.snapshotIds,
      freshnessIds: replay.freshnessIds,
      parityStatuses: replay.parityStatuses,
      providerParity: replay.providerParity,
      safeDrilldownRefs: replay.safeDrilldownRefs
    };
    const surfaces: readonly EvidenceSurface[] = [
      { name: "normalized QuickBooks fixtures", value: ERP_FINANCIALS_NORMALIZED_QUICKBOOKS_SYNC_FIXTURES },
      { name: "sandbox replay result", value: replay },
      { name: "serialized replay summary", value: replaySummary },
      { name: "captured Postgres write params", value: client.calls.map((call) => call.params) }
    ];

    const mutatingCalls = client.calls.filter((call) => /^\s*(insert|delete|update)\b/i.test(call.sql));

    expect(mutatingCalls.length).toBeGreaterThan(0);
    expect(mutatingCalls.every((call) => /"erp_financials"\./i.test(call.sql))).toBe(true);
    expect(mutatingCalls.map((call) => call.sql).join("\n")).not.toMatch(PROVIDER_CREDENTIAL_OR_RAW_PAYLOAD_KEY_PATTERN);

    for (const surface of surfaces) {
      expect(findForbiddenKeyPaths(surface.value), surface.name).toEqual([]);
      expect(JSON.stringify(surface.value), surface.name).not.toMatch(PROVIDER_CREDENTIAL_OR_RAW_PAYLOAD_KEY_PATTERN);
    }

    const serializedReplaySummary = JSON.stringify(replaySummary, null, 2);
    expect(JSON.stringify(JSON.parse(serializedReplaySummary), null, 2)).toBe(serializedReplaySummary);
    expect(createHash("sha256").update(serializedReplaySummary).digest("hex")).toBe(
      "36019e35933aa3674905545e36656e23664b592104e7c9b971e4da8388afd054"
    );
  });

  it("keeps generated declaration evidence free of provider credential fields when dist is present", () => {
    const distDeclarationUrl = new URL("../dist/index.d.ts", import.meta.url);

    if (!existsSync(distDeclarationUrl)) {
      return;
    }

    const declaration = readFileSync(distDeclarationUrl, "utf8");

    expect(declaration).not.toMatch(/access[_-]?token|refresh[_-]?token|client[_-]?secret|clientSecret|rawPayload|rawProviderPayload/i);
  });
});

class CapturingPostgresClient implements PostgresQueryClient {
  readonly calls: CapturedQuery[] = [];

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

function findForbiddenKeyPaths(value: unknown, path = "$"): readonly string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => findForbiddenKeyPaths(entry, `${path}[${String(index)}]`));
  }

  if (isRecord(value)) {
    return Object.entries(value).flatMap(([key, entry]) => {
      const entryPath = `${path}.${key}`;
      return [
        ...(PROVIDER_CREDENTIAL_OR_RAW_PAYLOAD_KEY_PATTERN.test(key) ? [entryPath] : []),
        ...findForbiddenKeyPaths(entry, entryPath)
      ];
    });
  }

  return [];
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object";
}
