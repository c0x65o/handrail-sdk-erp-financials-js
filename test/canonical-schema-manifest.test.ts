import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  POSTGRES_CANONICAL_SCHEMA_MANIFEST,
  POSTGRES_MIGRATIONS,
  assertLedgerPostingAmounts,
  assertManifestHasNoCredentialColumns,
  assertNoCredentialKeys,
  assertSafeSourcePayloadRef,
  canonicalSourceIdentityKey,
  createDimensionHash,
  renderPostgresSchemaSql
} from "../src/index.js";

const FUTURE_ERP_CANONICAL_SCHEMA_MIGRATION_SQL = readFileSync(
  new URL("../migrations/future-erp/20260620000000_create_erp_financials_canonical_schema.sql", import.meta.url),
  "utf8"
);
const REPORT_SNAPSHOT_SCOPE_UPGRADE_SQL = readFileSync(
  new URL("../migrations/future-erp/20260812000000_scope_report_snapshots.sql", import.meta.url),
  "utf8"
);
const MIGRATION_LEDGER_UPGRADE_SQL = readFileSync(
  new URL("../migrations/future-erp/20260812010000_add_schema_migration_ledger.sql", import.meta.url),
  "utf8"
);
const GENERAL_LEDGER_CONTRACT_UPGRADE_SQL = readFileSync(
  new URL("../migrations/future-erp/20260815020000_add_general_ledger_contract.sql", import.meta.url),
  "utf8"
);
const WRITE_OFF_APPLICATION_UPGRADE_SQL = readFileSync(
  new URL("../migrations/future-erp/20260815030000_add_write_off_invoice_applications.sql", import.meta.url),
  "utf8"
);
const BANK_STATEMENT_LINE_UNIGNORE_UPGRADE_SQL = readFileSync(
  new URL("../migrations/future-erp/20260825010000_add_bank_statement_line_unignore.sql", import.meta.url),
  "utf8"
);
const CUSTOMER_DEPOSIT_INVOICE_APPLICATIONS_UPGRADE_SQL = readFileSync(
  new URL("../migrations/future-erp/20260826010000_add_customer_deposit_invoice_applications.sql", import.meta.url),
  "utf8"
);

describe("canonical schema manifest", () => {
  it("is versioned and covers the documented canonical entities", () => {
    expect(POSTGRES_CANONICAL_SCHEMA_MANIFEST.manifestVersion).toBe("2026-09-11.commercial-document-detail");
    expect(POSTGRES_CANONICAL_SCHEMA_MANIFEST.schemaVersion).toBe(24);

    const tableNames = POSTGRES_CANONICAL_SCHEMA_MANIFEST.tables.map((table) => table.name);

    expect(tableNames).toEqual([
      "schema_migrations",
      "accounting_companies",
      "accounting_sources",
      "company_sources",
      "financial_lifecycle_events",
      "accounting_book_controls",
      "fiscal_periods",
      "accounts",
      "parties",
      "items",
      "accounting_dimensions",
      "transactions",
      "transaction_lines",
      "ledger_postings",
      "journal_entry_links",
      "subledger_documents",
      "subledger_applications",
      "bill_payment_disbursements",
      "posting_rules",
      "transaction_match_candidates",
      "transaction_match_decisions",
      "payment_applications",
      "rollup_buckets",
      "import_batches",
      "sync_checkpoints",
      "report_freshness",
      "report_snapshots",
      "report_snapshot_lines",
      "report_snapshot_totals",
      "reporting_books",
      "reporting_book_sources",
      "reporting_book_accounts",
      "reporting_book_account_mappings",
      "financial_outbox",
      "invoice_drafts",
      "invoice_draft_lines",
      "subledger_document_lines",
      "subledger_document_delivery_events",
      "invoice_voids",
      "bank_statement_lines",
      "bank_reconciliation_matches"
    ]);
  });

  it("renders deterministic Postgres SQL with idempotency and accounting constraints", () => {
    const firstRender = renderPostgresSchemaSql();
    const secondRender = renderPostgresSchemaSql();

    expect(secondRender).toBe(firstRender);
    expect(firstRender).toContain('create schema if not exists "erp_financials";');
    expect(firstRender).toContain("constraint \"ledger_postings_nonnegative_debit_check\" check (debit_amount >= 0)");
    expect(firstRender).toContain("constraint \"ledger_postings_nonnegative_credit_check\" check (credit_amount >= 0)");
    expect(firstRender).toContain(
      'create unique index if not exists "ledger_postings_source_posting_uidx" on "erp_financials"."ledger_postings" ("tenant_id", "source_id", "accounting_basis", "source_posting_id");'
    );
    expect(firstRender).toContain(
      'create index if not exists "accounts_parent_account_idx" on "erp_financials"."accounts" ("tenant_id", "source_id", "parent_account_id");'
    );
    expect(firstRender).toContain(
      'create unique index if not exists "posting_rules_code_uidx" on "erp_financials"."posting_rules" ("tenant_id", "source_id", "rule_code");'
    );
    expect(firstRender).toContain(
      'create unique index if not exists "transaction_match_candidates_identity_uidx" on "erp_financials"."transaction_match_candidates" ("tenant_id", "source_id", "match_kind", "origin_transaction_id", "target_transaction_id", "matcher_version");'
    );
    expect(firstRender).toContain(
      "constraint \"payment_applications_amount_check\" check (applied_amount > 0)"
    );
    expect(firstRender).toContain(
      "constraint \"posting_rules_json_shape_check\" check (jsonb_typeof(conditions) = 'array' and jsonb_array_length(conditions) > 0 and jsonb_typeof(actions) = 'array' and jsonb_array_length(actions) > 0)"
    );
    expect(firstRender).toContain(
      "constraint \"transaction_match_candidates_distinct_transactions_check\" check (origin_transaction_id <> target_transaction_id)"
    );
    expect(firstRender).toContain(
      "constraint \"transaction_match_decisions_manual_actor_check\" check (method <> 'manual' or (decided_by_ref is not null and btrim(decided_by_ref) <> ''))"
    );
    expect(firstRender).toContain(
      "constraint \"payment_applications_updated_at_check\" check (updated_at >= created_at)"
    );
    expect(firstRender).toContain(
      'create unique index if not exists "rollup_buckets_identity_uidx" on "erp_financials"."rollup_buckets" ("tenant_id", "company_id", "source_id", "accounting_basis", "bucket_grain", "bucket_start", "bucket_end", "account_id", "currency_code", "dimension_hash", "party_id", "party_type", "item_id");'
    );
    expect(firstRender).toContain(
      'create index if not exists "rollup_buckets_report_idx" on "erp_financials"."rollup_buckets" ("tenant_id", "company_id", "source_id", "accounting_basis", "bucket_grain", "currency_code", "bucket_start", "bucket_end", "account_id", "dimension_hash", "party_type", "party_id", "item_id");'
    );
    expect(firstRender).toContain(
      'create unique index if not exists "report_freshness_identity_uidx" on "erp_financials"."report_freshness" ("tenant_id", "company_id", "source_id", "report_name", "accounting_basis", "period_start", "period_end", "currency_code");'
    );
    expect(firstRender).toContain(
      'create unique index if not exists "report_snapshots_request_uidx" on "erp_financials"."report_snapshots" ("tenant_id", "company_id", "source_id", "report_name", "snapshot_source", "accounting_basis", "period_start", "period_end", "as_of_date", "currency_code");'
    );
    expect(
      POSTGRES_CANONICAL_SCHEMA_MANIFEST.tables.find((table) => table.name === "report_snapshots")?.policies.sourceScoped
    ).toBe(true);
    expect(firstRender).toContain(
      "constraint \"transactions_source_payload_ref_bounded_json_check\" check (octet_length(coalesce(\"source_payload_ref\"::text, '')) <= 4096)"
    );
  });

  it("preserves provider-neutral account hierarchy storage and lookup coverage", () => {
    const accountsTable = POSTGRES_CANONICAL_SCHEMA_MANIFEST.tables.find((table) => table.name === "accounts");

    expect(accountsTable?.columns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "parent_account_id",
          type: "text",
          nullable: true
        })
      ])
    );
    expect(accountsTable?.indexes).toEqual(
      expect.arrayContaining([
        {
          name: "accounts_parent_account_idx",
          columns: ["tenant_id", "source_id", "parent_account_id"]
        }
      ])
    );
    expect(FUTURE_ERP_CANONICAL_SCHEMA_MIGRATION_SQL).toContain(
      'create index if not exists "accounts_parent_account_idx" on "erp_financials"."accounts" ("tenant_id", "source_id", "parent_account_id");'
    );
  });

  it("keeps credential custody out of financial tables", () => {
    expect(() => {
      assertManifestHasNoCredentialColumns();
    }).not.toThrow();

    for (const table of POSTGRES_CANONICAL_SCHEMA_MANIFEST.tables) {
      expect(table.policies.noRawCredentials).toBe(true);
    }
  });

  it("rejects audited credential and raw payload schema column variants", () => {
    const firstTable = POSTGRES_CANONICAL_SCHEMA_MANIFEST.tables[0];
    if (!firstTable) {
      throw new Error("Expected canonical schema manifest to contain at least one table.");
    }

    const forbiddenColumnNames = [
      "access_token",
      "access-token",
      "accessToken",
      "refresh_token",
      "refresh-token",
      "refreshToken",
      "client_secret",
      "client-secret",
      "clientSecret",
      "credential",
      "private-key",
      "raw_payload",
      "raw-payload",
      "rawPayload",
      "raw_provider_payload",
      "raw-provider-payload",
      "rawProviderPayload",
      "provider-payload-archive",
      "providerPayloadArchive",
      "payload-archive",
      "payloadArchive",
      "raw-archive",
      "rawArchive"
    ];

    for (const columnName of forbiddenColumnNames) {
      expect(() => {
        assertManifestHasNoCredentialColumns({
          ...POSTGRES_CANONICAL_SCHEMA_MANIFEST,
          tables: [
            {
              ...firstTable,
              columns: [...firstTable.columns, { name: columnName, type: "text" }]
            }
          ]
        });
      }).toThrow("credential-like column is not allowed");
    }
  });

  it("keeps historical migrations immutable and exposes an ordered path to the canonical renderer", () => {
    expect(FUTURE_ERP_CANONICAL_SCHEMA_MIGRATION_SQL).not.toContain('"schema_migrations"');
    expect(FUTURE_ERP_CANONICAL_SCHEMA_MIGRATION_SQL).not.toContain(
      '"report_snapshots" (\n  "report_snapshot_id" text not null,\n  "tenant_id" text not null,\n  "company_id"'
    );
    expect(MIGRATION_LEDGER_UPGRADE_SQL).toContain('create table if not exists "erp_financials"."schema_migrations"');
    expect(MIGRATION_LEDGER_UPGRADE_SQL).toContain('create trigger "schema_migrations_immutable"');
    expect(POSTGRES_CANONICAL_SCHEMA_MANIFEST.requiredTriggers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "schema_migrations_immutable", table: "schema_migrations" }),
        expect.objectContaining({ name: "financial_lifecycle_events_immutable" }),
        expect.objectContaining({ name: "subledger_applications_validate" }),
        expect.objectContaining({ name: "subledger_applications_write_off_validate" })
      ])
    );
    expect(POSTGRES_MIGRATIONS.map(({ fromVersion, toVersion }) => [fromVersion, toVersion])).toEqual([
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
      [23, 24]
    ]);
    expect(renderPostgresSchemaSql()).toContain('create table if not exists "erp_financials"."schema_migrations"');
    expect(FUTURE_ERP_CANONICAL_SCHEMA_MIGRATION_SQL).not.toMatch(
      /\b(token|secret|credential|password|client_secret|access_token|refresh_token|raw_provider_payload|raw_payload)\b/i
    );
  });

  it("adds only the guarded ignored-to-unmatched bank statement line transition", () => {
    expect(BANK_STATEMENT_LINE_UNIGNORE_UPGRADE_SQL).toContain(
      `(old."status" = 'ignored' and new."status" = 'unmatched')`
    );
    expect(BANK_STATEMENT_LINE_UNIGNORE_UPGRADE_SQL).toContain(
      `new."version" <> old."version" + 1`
    );
    expect(BANK_STATEMENT_LINE_UNIGNORE_UPGRADE_SQL).toContain(
      `"erp_financials"."source_import_reset_scope_allowed"`
    );
    expect(BANK_STATEMENT_LINE_UNIGNORE_UPGRADE_SQL).not.toContain("drop table");
    expect(CUSTOMER_DEPOSIT_INVOICE_APPLICATIONS_UPGRADE_SQL).toContain(
      `source_document."document_type" not in ('credit_memo', 'deposit')`
    );
    expect(CUSTOMER_DEPOSIT_INVOICE_APPLICATIONS_UPGRADE_SQL).toContain(
      "subledger application amount exceeds an available document balance"
    );
    expect(CUSTOMER_DEPOSIT_INVOICE_APPLICATIONS_UPGRADE_SQL).not.toContain("drop table");
  });

  it("ships a fail-closed v6 to v7 report snapshot scope upgrade", () => {
    expect(REPORT_SNAPSHOT_SCOPE_UPGRADE_SQL).toContain('add column if not exists "company_id" text');
    expect(REPORT_SNAPSHOT_SCOPE_UPGRADE_SQL).toContain('add column if not exists "source_id" text');
    expect(REPORT_SNAPSHOT_SCOPE_UPGRADE_SQL).toContain(
      "each legacy snapshot must map to exactly one company/source through report_freshness"
    );
    expect(REPORT_SNAPSHOT_SCOPE_UPGRADE_SQL).toContain('alter column "company_id" set not null');
    expect(REPORT_SNAPSHOT_SCOPE_UPGRADE_SQL).toContain('alter column "source_id" set not null');
    expect(REPORT_SNAPSHOT_SCOPE_UPGRADE_SQL).toContain("':legacy-line:' || length(lines.\"report_line_id\")::text");
    expect(REPORT_SNAPSHOT_SCOPE_UPGRADE_SQL).toContain("':legacy-total:' || length(totals.\"report_total_id\")::text");
    expect(REPORT_SNAPSHOT_SCOPE_UPGRADE_SQL).toContain('rs."snapshot_source"');
  });

  it("database-enforces versioned reporting-book account roles and account-number uniqueness", () => {
    expect(GENERAL_LEDGER_CONTRACT_UPGRADE_SQL).toContain('"reporting_book_accounts_number_uidx"');
    expect(GENERAL_LEDGER_CONTRACT_UPGRADE_SQL).toContain("parent must be an active header account");
    expect(GENERAL_LEDGER_CONTRACT_UPGRADE_SQL).toContain("mapped reporting-book account must remain an active posting account");
    expect(GENERAL_LEDGER_CONTRACT_UPGRADE_SQL).toContain("account type cannot change while children or mappings depend on it");
    expect(GENERAL_LEDGER_CONTRACT_UPGRADE_SQL).toContain("version must remain stable for a replay or advance by exactly one");
  });

  it("database-enforces canonical write-off-to-invoice document roles", () => {
    expect(WRITE_OFF_APPLICATION_UPGRADE_SQL).toContain("'write_off_to_invoice'");
    expect(WRITE_OFF_APPLICATION_UPGRADE_SQL).toContain("source_document_type is distinct from 'write_off'");
    expect(WRITE_OFF_APPLICATION_UPGRADE_SQL).toContain("target_document_type is distinct from 'invoice'");
    expect(renderPostgresSchemaSql()).toContain(
      "application_type in ('customer_payment_to_invoice', 'bill_payment_to_bill', 'credit_to_invoice', 'vendor_credit_to_bill', 'write_off_to_invoice')"
    );
  });
});

describe("canonical model constraints", () => {
  it("rejects negative debit or credit amounts", () => {
    expect(() => {
      assertLedgerPostingAmounts({
        debitAmount: "0",
        creditAmount: "12.34"
      });
    }).not.toThrow();

    expect(() => {
      assertLedgerPostingAmounts({
        debitAmount: "-0.01",
        creditAmount: "0"
      });
    }).toThrow("debitAmount must be a nonnegative decimal string");
  });

  it("builds tenant-scoped idempotent source identity keys", () => {
    expect(
      canonicalSourceIdentityKey({
        tenantId: "tenant_1",
        sourceId: "source_1",
        sourceSystem: "quickbooks",
        providerEnvironment: "sandbox",
        sourceObjectType: "Invoice",
        sourceObjectId: "123"
      })
    ).toBe("tenant_1:source_1:quickbooks:sandbox:Invoice:123");
  });

  it("enforces bounded safe source payload refs with no credential-like fields", () => {
    expect(() => {
      assertSafeSourcePayloadRef({
        sourceObjectType: "Invoice",
        sourceObjectId: "123",
        byteLength: 128,
        checksum: "sha256:abc",
        preview: {
          txnDate: "2026-01-31"
        }
      });
    }).not.toThrow();

    expect(() => {
      assertSafeSourcePayloadRef({
        sourceObjectType: "Invoice",
        sourceObjectId: "123",
        byteLength: 4097
      });
    }).toThrow("sourcePayloadRef.byteLength exceeds 4096 bytes");

    expect(() => {
      assertSafeSourcePayloadRef({
        sourceObjectType: "Invoice",
        sourceObjectId: "123",
        preview: {
          access_token: "not allowed"
        }
      });
    }).toThrow("credential-like field is not allowed");
  });

  it("rejects audited credential and raw provider payload field names", () => {
    const forbiddenKeys = [
      "access_token",
      "access-token",
      "accessToken",
      "refresh_token",
      "refresh-token",
      "refreshToken",
      "client_secret",
      "client-secret",
      "clientSecret",
      "token",
      "secret",
      "password",
      "credential",
      "private_key",
      "private-key",
      "raw_payload",
      "raw-payload",
      "rawPayload",
      "raw_provider_payload",
      "raw-provider-payload",
      "rawProviderPayload",
      "provider-payload-archive",
      "providerPayloadArchive",
      "payload-archive",
      "payloadArchive",
      "raw-archive",
      "rawArchive"
    ];

    for (const key of forbiddenKeys) {
      expect(() => {
        assertNoCredentialKeys({ nested: { [key]: "not allowed" } });
      }).toThrow("credential-like field is not allowed");
    }
  });

  it("creates deterministic dimension hashes independent of input order", () => {
    const firstHash = createDimensionHash([
      {
        dimensionKind: "department",
        sourceDimensionId: "engineering",
        name: "Engineering"
      },
      {
        dimensionKind: "location",
        sourceDimensionId: "chicago",
        name: "Chicago"
      }
    ]);
    const secondHash = createDimensionHash([
      {
        dimensionKind: "location",
        sourceDimensionId: "chicago",
        name: "Chicago"
      },
      {
        dimensionKind: "department",
        sourceDimensionId: "engineering",
        name: "Engineering"
      }
    ]);

    expect(firstHash).toBe(secondHash);
    expect(firstHash).toHaveLength(64);
  });
});
