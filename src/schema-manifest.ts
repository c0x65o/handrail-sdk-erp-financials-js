export type PostgresColumnType =
  | "boolean"
  | "date"
  | "integer"
  | "jsonb"
  | "numeric"
  | "text"
  | "timestamptz";

export type PostgresColumnManifest = {
  readonly name: string;
  readonly type: PostgresColumnType;
  readonly nullable?: boolean;
  readonly primaryKey?: boolean;
  readonly defaultSql?: string;
  readonly maxBytes?: number;
};

export type PostgresConstraintManifest = {
  readonly name: string;
  readonly kind?: "check" | "foreign_key";
  readonly sql: string;
};

export type PostgresIndexManifest = {
  readonly name: string;
  readonly columns: readonly string[];
  readonly unique?: boolean;
  readonly whereSql?: string;
};

export type PostgresTriggerManifest = {
  readonly name: string;
  readonly table: string;
  readonly timing: "before" | "after";
  readonly events: readonly ("insert" | "update" | "delete")[];
  readonly updateColumns?: readonly string[];
  readonly functionName: string;
};

export type PostgresTableManifest = {
  readonly name: string;
  readonly description: string;
  readonly columns: readonly PostgresColumnManifest[];
  readonly constraints: readonly PostgresConstraintManifest[];
  readonly indexes: readonly PostgresIndexManifest[];
  readonly policies: {
    readonly tenantScoped: boolean;
    readonly sourceScoped: boolean;
    readonly noRawCredentials: boolean;
    readonly boundedJson: boolean;
  };
};

export type PostgresSchemaManifest = {
  readonly manifestVersion: "2026-09-11.commercial-document-detail";
  readonly schemaVersion: 24;
  readonly dialect: "postgres";
  readonly namespace: "erp_financials";
  readonly requiredTriggers: readonly PostgresTriggerManifest[];
  readonly tables: readonly PostgresTableManifest[];
};

const jsonb = (name: string, maxBytes = 4096, nullable = true): PostgresColumnManifest => ({
  name,
  type: "jsonb",
  nullable,
  maxBytes
});

const text = (name: string, nullable = false): PostgresColumnManifest => ({
  name,
  type: "text",
  nullable
});

const id = (name: string): PostgresColumnManifest => ({
  name,
  type: "text",
  primaryKey: true
});

const timestamp = (name: string, nullable = false): PostgresColumnManifest => ({
  name,
  type: "timestamptz",
  nullable
});

const date = (name: string, nullable = false): PostgresColumnManifest => ({
  name,
  type: "date",
  nullable
});

const integer = (name: string): PostgresColumnManifest => ({
  name,
  type: "integer"
});

const numeric = (name: string, nullable = false): PostgresColumnManifest => ({
  name,
  type: "numeric",
  nullable
});

const bool = (name: string): PostgresColumnManifest => ({
  name,
  type: "boolean"
});

const foreignKey = (
  name: string,
  columns: readonly string[],
  referencedTable: string,
  referencedColumns: readonly string[]
): PostgresConstraintManifest => ({
  name,
  kind: "foreign_key",
  sql: `foreign key (${columns.map(quoteIdentifier).join(", ")}) references ${quoteIdentifier(
    "erp_financials"
  )}.${quoteIdentifier(referencedTable)} (${referencedColumns.map(quoteIdentifier).join(", ")}) on update restrict on delete restrict`
});

const table = (
  name: string,
  description: string,
  columns: readonly PostgresColumnManifest[],
  constraints: readonly PostgresConstraintManifest[],
  indexes: readonly PostgresIndexManifest[],
  sourceScoped = true,
  tenantScoped = true
): PostgresTableManifest => ({
  name,
  description,
  columns,
  constraints,
  indexes,
  policies: {
    tenantScoped,
    sourceScoped,
    noRawCredentials: true,
    boundedJson: columns.some((column) => column.type === "jsonb")
  }
});

export const POSTGRES_CANONICAL_SCHEMA_MANIFEST: PostgresSchemaManifest = {
  manifestVersion: "2026-09-11.commercial-document-detail",
  schemaVersion: 24,
  dialect: "postgres",
  namespace: "erp_financials",
  requiredTriggers: [
    {
      name: "schema_migrations_immutable",
      table: "schema_migrations",
      timing: "before",
      events: ["update", "delete"],
      functionName: "reject_schema_migration_mutation"
    },
    {
      name: "transactions_posted_journal_immutable",
      table: "transactions",
      timing: "before",
      events: ["update", "delete"],
      functionName: "reject_posted_journal_mutation"
    },
    {
      name: "transaction_lines_posted_journal_immutable",
      table: "transaction_lines",
      timing: "before",
      events: ["update", "delete"],
      functionName: "reject_posted_journal_child_mutation"
    },
    {
      name: "ledger_postings_posted_journal_immutable",
      table: "ledger_postings",
      timing: "before",
      events: ["update", "delete"],
      functionName: "reject_posted_journal_child_mutation"
    },
    {
      name: "ledger_postings_source_window_guard",
      table: "ledger_postings",
      timing: "before",
      events: ["insert", "update"],
      functionName: "enforce_reporting_source_window"
    },
    {
      name: "financial_lifecycle_events_immutable",
      table: "financial_lifecycle_events",
      timing: "before",
      events: ["update", "delete"],
      functionName: "reject_financial_lifecycle_event_mutation"
    },
    {
      name: "fiscal_periods_no_overlap",
      table: "fiscal_periods",
      timing: "before",
      events: ["insert", "update"],
      updateColumns: ["tenant_id", "company_id", "source_id", "period_start", "period_end"],
      functionName: "reject_overlapping_fiscal_period"
    },
    {
      name: "journal_entry_links_immutable",
      table: "journal_entry_links",
      timing: "before",
      events: ["update", "delete"],
      functionName: "reject_journal_entry_link_mutation"
    },
    {
      name: "subledger_documents_validate_insert",
      table: "subledger_documents",
      timing: "before",
      events: ["insert"],
      functionName: "validate_subledger_document_insert"
    },
    {
      name: "subledger_documents_guard",
      table: "subledger_documents",
      timing: "before",
      events: ["update", "delete"],
      functionName: "guard_subledger_document_mutation"
    },
    {
      name: "subledger_applications_validate",
      table: "subledger_applications",
      timing: "before",
      events: ["insert", "update"],
      functionName: "validate_subledger_application"
    },
    {
      name: "subledger_applications_update_balances",
      table: "subledger_applications",
      timing: "after",
      events: ["insert", "update"],
      updateColumns: ["status"],
      functionName: "apply_subledger_application_balances"
    },
    {
      name: "subledger_applications_no_delete",
      table: "subledger_applications",
      timing: "before",
      events: ["delete"],
      functionName: "reject_subledger_application_delete"
    },
    {
      name: "subledger_applications_write_off_validate",
      table: "subledger_applications",
      timing: "before",
      events: ["insert", "update"],
      functionName: "validate_write_off_to_invoice_application"
    },
    {
      name: "subledger_applications_match_evidence_immutable",
      table: "subledger_applications",
      timing: "before",
      events: ["update"],
      functionName: "guard_subledger_application_match_evidence"
    },
    {
      name: "bill_payment_disbursements_guard",
      table: "bill_payment_disbursements",
      timing: "before",
      events: ["update", "delete"],
      functionName: "guard_bill_payment_disbursement_mutation"
    },
    {
      name: "reporting_book_sources_no_primary_overlap",
      table: "reporting_book_sources",
      timing: "before",
      events: ["insert", "update"],
      updateColumns: ["tenant_id", "company_id", "book_id", "source_role", "effective_from", "effective_through"],
      functionName: "reject_overlapping_primary_book_source"
    },
    {
      name: "transaction_match_decisions_immutable",
      table: "transaction_match_decisions",
      timing: "before",
      events: ["update", "delete"],
      functionName: "reject_sdk_immutable_mutation"
    },
    {
      name: "subledger_document_lines_immutable",
      table: "subledger_document_lines",
      timing: "before",
      events: ["update", "delete"],
      functionName: "guard_quickbooks_document_line_mutation"
    },
    {
      name: "subledger_document_delivery_events_immutable",
      table: "subledger_document_delivery_events",
      timing: "before",
      events: ["update", "delete"],
      functionName: "reject_sdk_immutable_mutation"
    },
    {
      name: "invoice_voids_immutable",
      table: "invoice_voids",
      timing: "before",
      events: ["update", "delete"],
      functionName: "reject_sdk_immutable_mutation"
    },
    {
      name: "invoice_drafts_guard",
      table: "invoice_drafts",
      timing: "before",
      events: ["insert", "update", "delete"],
      functionName: "guard_invoice_draft_mutation"
    },
    {
      name: "invoice_draft_lines_guard",
      table: "invoice_draft_lines",
      timing: "before",
      events: ["insert", "update", "delete"],
      functionName: "guard_invoice_draft_line_mutation"
    },
    {
      name: "bank_statement_lines_guard",
      table: "bank_statement_lines",
      timing: "before",
      events: ["insert", "update", "delete"],
      functionName: "guard_bank_statement_line_mutation"
    },
    {
      name: "bank_reconciliation_matches_guard",
      table: "bank_reconciliation_matches",
      timing: "before",
      events: ["insert", "update", "delete"],
      functionName: "guard_bank_reconciliation_match_mutation"
    },
    {
      name: "reporting_book_sources_identity_immutable",
      table: "reporting_book_sources",
      timing: "before",
      events: ["update"],
      functionName: "guard_reporting_book_source_mutation"
    },
    {
      name: "financial_outbox_guard",
      table: "financial_outbox",
      timing: "before",
      events: ["update", "delete"],
      functionName: "guard_financial_outbox_mutation"
    },
    {
      name: "reporting_book_accounts_validate_hierarchy",
      table: "reporting_book_accounts",
      timing: "before",
      events: ["insert", "update"],
      functionName: "validate_reporting_book_account_hierarchy"
    },
    {
      name: "reporting_books_identity_immutable",
      table: "reporting_books",
      timing: "before",
      events: ["update"],
      functionName: "guard_reporting_book_identity"
    },
    {
      name: "reporting_book_account_mappings_validate",
      table: "reporting_book_account_mappings",
      timing: "before",
      events: ["insert", "update"],
      functionName: "validate_reporting_book_account_mapping"
    }
  ],
  tables: [
    table(
      "schema_migrations",
      "Ordered, checksum-verified package schema migration history.",
      [
        id("migration_id"),
        integer("from_version"),
        integer("to_version"),
        text("name"),
        text("checksum"),
        text("manifest_version"),
        integer("execution_ms"),
        text("applied_by_ref"),
        {
          ...timestamp("applied_at"),
          defaultSql: "clock_timestamp()"
        }
      ],
      [
        {
          name: "schema_migrations_version_check",
          sql: "from_version >= 0 and from_version < to_version"
        },
        {
          name: "schema_migrations_checksum_check",
          sql: "length(checksum) = 64"
        },
        {
          name: "schema_migrations_execution_ms_check",
          sql: "execution_ms >= 0"
        }
      ],
      [
        {
          name: "schema_migrations_to_version_uidx",
          columns: ["to_version"],
          unique: true
        }
      ],
      false,
      false
    ),
    table(
      "accounting_companies",
      "Tenant reporting entities.",
      [
        id("company_id"),
        text("tenant_id"),
        text("legal_name"),
        text("display_name"),
        text("base_currency_code"),
        integer("fiscal_year_start_month"),
        text("provider_environment"),
        text("source_system"),
        text("source_company_ref")
      ],
      [
        {
          name: "accounting_companies_fiscal_year_start_month_check",
          sql: "fiscal_year_start_month between 1 and 12"
        }
      ],
      [
        {
          name: "accounting_companies_source_identity_uidx",
          columns: ["tenant_id", "source_system", "provider_environment", "source_company_ref"],
          unique: true
        },
        {
          name: "accounting_companies_scope_uidx",
          columns: ["tenant_id", "company_id"],
          unique: true
        }
      ],
      false
    ),
    table(
      "accounting_sources",
      "Safe source connection references and sync status.",
      [
        id("source_id"),
        text("tenant_id"),
        text("source_system"),
        text("provider_environment"),
        text("connection_ref"),
        text("import_batch_id", true),
        text("checkpoint_id", true),
        timestamp("latest_synced_at", true),
        text("status")
      ],
      [],
      [
        {
          name: "accounting_sources_connection_uidx",
          columns: ["tenant_id", "source_system", "provider_environment", "connection_ref"],
          unique: true
        },
        {
          name: "accounting_sources_scope_uidx",
          columns: ["tenant_id", "source_id"],
          unique: true
        }
      ],
      false
    ),
    table(
      "company_sources",
      "Explicit allowed company/source bindings used to prevent cross-company financial writes.",
      [
        id("company_source_id"),
        text("tenant_id"),
        text("company_id"),
        text("source_id"),
        timestamp("created_at")
      ],
      [
        foreignKey(
          "company_sources_company_scope_fk",
          ["tenant_id", "company_id"],
          "accounting_companies",
          ["tenant_id", "company_id"]
        ),
        foreignKey(
          "company_sources_source_scope_fk",
          ["tenant_id", "source_id"],
          "accounting_sources",
          ["tenant_id", "source_id"]
        )
      ],
      [
        {
          name: "company_sources_scope_uidx",
          columns: ["tenant_id", "company_id", "source_id"],
          unique: true
        }
      ]
    ),
    table(
      "financial_lifecycle_events",
      "Append-only authorization, approval, request, reason, and lifecycle evidence for every financial mutation.",
      [
        id("event_id"),
        text("tenant_id"),
        text("company_id"),
        text("source_id"),
        text("aggregate_type"),
        text("aggregate_id"),
        text("event_type"),
        text("actor_ref"),
        text("approver_ref", true),
        text("request_id"),
        text("correlation_id"),
        text("reason_code"),
        text("reason_detail", true),
        timestamp("occurred_at"),
        timestamp("recorded_at"),
        text("idempotency_key"),
        text("payload_checksum"),
        jsonb("payload", 8192, false),
        text("prior_event_id", true)
      ],
      [
        {
          name: "financial_lifecycle_events_required_refs_check",
          sql: "btrim(actor_ref) <> '' and btrim(request_id) <> '' and btrim(correlation_id) <> '' and btrim(reason_code) <> ''"
        },
        {
          name: "financial_lifecycle_events_checksum_check",
          sql: "length(payload_checksum) = 64"
        },
        {
          name: "financial_lifecycle_events_timestamp_check",
          sql: "occurred_at <= recorded_at"
        },
        foreignKey(
          "financial_lifecycle_events_company_source_scope_fk",
          ["tenant_id", "company_id", "source_id"],
          "company_sources",
          ["tenant_id", "company_id", "source_id"]
        ),
        foreignKey(
          "financial_lifecycle_events_prior_scope_fk",
          ["tenant_id", "company_id", "source_id", "prior_event_id"],
          "financial_lifecycle_events",
          ["tenant_id", "company_id", "source_id", "event_id"]
        )
      ],
      [
        {
          name: "financial_lifecycle_events_idempotency_uidx",
          columns: ["tenant_id", "company_id", "source_id", "idempotency_key"],
          unique: true
        },
        {
          name: "financial_lifecycle_events_scope_uidx",
          columns: ["tenant_id", "company_id", "source_id", "event_id"],
          unique: true
        },
        {
          name: "financial_lifecycle_events_aggregate_idx",
          columns: ["tenant_id", "company_id", "source_id", "aggregate_type", "aggregate_id", "occurred_at"]
        },
        {
          name: "financial_lifecycle_events_correlation_idx",
          columns: ["tenant_id", "correlation_id", "occurred_at"]
        }
      ]
    ),
    table(
      "accounting_book_controls",
      "Versioned posting lock date and book-level close controls for one company/source scope.",
      [
        id("book_control_id"),
        text("tenant_id"),
        text("company_id"),
        text("source_id"),
        date("posting_lock_date", true),
        integer("version"),
        text("last_event_id"),
        timestamp("created_at"),
        timestamp("updated_at")
      ],
      [
        {
          name: "accounting_book_controls_version_check",
          sql: "version >= 1"
        },
        {
          name: "accounting_book_controls_timestamp_check",
          sql: "updated_at >= created_at"
        },
        foreignKey(
          "accounting_book_controls_company_source_scope_fk",
          ["tenant_id", "company_id", "source_id"],
          "company_sources",
          ["tenant_id", "company_id", "source_id"]
        ),
        foreignKey(
          "accounting_book_controls_event_scope_fk",
          ["tenant_id", "company_id", "source_id", "last_event_id"],
          "financial_lifecycle_events",
          ["tenant_id", "company_id", "source_id", "event_id"]
        )
      ],
      [
        {
          name: "accounting_book_controls_scope_uidx",
          columns: ["tenant_id", "company_id", "source_id"],
          unique: true
        }
      ]
    ),
    table(
      "fiscal_periods",
      "Versioned open, closing, and closed fiscal periods with immutable lifecycle evidence links.",
      [
        id("fiscal_period_id"),
        text("tenant_id"),
        text("company_id"),
        text("source_id"),
        integer("fiscal_year"),
        integer("period_number"),
        date("period_start"),
        date("period_end"),
        text("status"),
        integer("version"),
        text("close_event_id", true),
        text("reopen_event_id", true),
        timestamp("created_at"),
        timestamp("updated_at")
      ],
      [
        {
          name: "fiscal_periods_period_check",
          sql: "period_start <= period_end"
        },
        {
          name: "fiscal_periods_number_check",
          sql: "period_number between 1 and 366"
        },
        {
          name: "fiscal_periods_status_check",
          sql: "status in ('open', 'closing', 'closed')"
        },
        {
          name: "fiscal_periods_version_check",
          sql: "version >= 1"
        },
        {
          name: "fiscal_periods_timestamp_check",
          sql: "updated_at >= created_at"
        },
        {
          name: "fiscal_periods_closed_event_check",
          sql: "status <> 'closed' or close_event_id is not null"
        },
        foreignKey(
          "fiscal_periods_company_source_scope_fk",
          ["tenant_id", "company_id", "source_id"],
          "company_sources",
          ["tenant_id", "company_id", "source_id"]
        ),
        foreignKey(
          "fiscal_periods_close_event_scope_fk",
          ["tenant_id", "company_id", "source_id", "close_event_id"],
          "financial_lifecycle_events",
          ["tenant_id", "company_id", "source_id", "event_id"]
        ),
        foreignKey(
          "fiscal_periods_reopen_event_scope_fk",
          ["tenant_id", "company_id", "source_id", "reopen_event_id"],
          "financial_lifecycle_events",
          ["tenant_id", "company_id", "source_id", "event_id"]
        )
      ],
      [
        {
          name: "fiscal_periods_identity_uidx",
          columns: ["tenant_id", "company_id", "source_id", "fiscal_year", "period_number"],
          unique: true
        },
        {
          name: "fiscal_periods_scope_uidx",
          columns: ["tenant_id", "company_id", "source_id", "fiscal_period_id"],
          unique: true
        },
        {
          name: "fiscal_periods_date_idx",
          columns: ["tenant_id", "company_id", "source_id", "period_start", "period_end", "status"]
        }
      ]
    ),
    table(
      "accounts",
      "Provider-neutral chart of accounts.",
      [
        id("account_id"),
        text("tenant_id"),
        text("source_id"),
        text("source_account_id"),
        text("account_number", true),
        text("name"),
        text("type"),
        text("subtype", true),
        text("classification"),
        text("parent_account_id", true),
        text("currency_code", true),
        bool("active")
      ],
      [
        foreignKey(
          "accounts_source_scope_fk",
          ["tenant_id", "source_id"],
          "accounting_sources",
          ["tenant_id", "source_id"]
        ),
        foreignKey(
          "accounts_parent_scope_fk",
          ["tenant_id", "source_id", "parent_account_id"],
          "accounts",
          ["tenant_id", "source_id", "account_id"]
        )
      ],
      [
        {
          name: "accounts_source_account_uidx",
          columns: ["tenant_id", "source_id", "source_account_id"],
          unique: true
        },
        {
          name: "accounts_classification_idx",
          columns: ["tenant_id", "classification"]
        },
        {
          name: "accounts_parent_account_idx",
          columns: ["tenant_id", "source_id", "parent_account_id"]
        },
        {
          name: "accounts_scope_uidx",
          columns: ["tenant_id", "source_id", "account_id"],
          unique: true
        }
      ]
    ),
    table(
      "parties",
      "Customers, vendors, employees, and other parties.",
      [
        id("party_id"),
        text("tenant_id"),
        text("source_id"),
        text("source_party_id"),
        text("party_type"),
        text("display_name"),
        bool("active")
      ],
      [
        foreignKey(
          "parties_source_scope_fk",
          ["tenant_id", "source_id"],
          "accounting_sources",
          ["tenant_id", "source_id"]
        )
      ],
      [
        {
          name: "parties_source_party_uidx",
          columns: ["tenant_id", "source_id", "source_party_id"],
          unique: true
        },
        {
          name: "parties_scope_uidx",
          columns: ["tenant_id", "source_id", "party_id"],
          unique: true
        }
      ]
    ),
    table(
      "items",
      "Products, services, inventory items, and billable items.",
      [
        id("item_id"),
        text("tenant_id"),
        text("source_id"),
        text("source_item_id"),
        text("item_type"),
        text("name"),
        text("income_account_id", true),
        text("expense_account_id", true),
        text("asset_account_id", true),
        bool("active")
      ],
      [
        foreignKey(
          "items_source_scope_fk",
          ["tenant_id", "source_id"],
          "accounting_sources",
          ["tenant_id", "source_id"]
        ),
        foreignKey(
          "items_income_account_scope_fk",
          ["tenant_id", "source_id", "income_account_id"],
          "accounts",
          ["tenant_id", "source_id", "account_id"]
        ),
        foreignKey(
          "items_expense_account_scope_fk",
          ["tenant_id", "source_id", "expense_account_id"],
          "accounts",
          ["tenant_id", "source_id", "account_id"]
        ),
        foreignKey(
          "items_asset_account_scope_fk",
          ["tenant_id", "source_id", "asset_account_id"],
          "accounts",
          ["tenant_id", "source_id", "account_id"]
        )
      ],
      [
        {
          name: "items_source_item_uidx",
          columns: ["tenant_id", "source_id", "source_item_id"],
          unique: true
        },
        {
          name: "items_scope_uidx",
          columns: ["tenant_id", "source_id", "item_id"],
          unique: true
        }
      ]
    ),
    table(
      "accounting_dimensions",
      "Provider-neutral reporting dimensions.",
      [
        id("dimension_id"),
        text("tenant_id"),
        text("source_id"),
        text("dimension_kind"),
        text("source_dimension_id"),
        text("name"),
        text("parent_dimension_id", true),
        bool("active")
      ],
      [
        foreignKey(
          "accounting_dimensions_source_scope_fk",
          ["tenant_id", "source_id"],
          "accounting_sources",
          ["tenant_id", "source_id"]
        ),
        foreignKey(
          "accounting_dimensions_parent_scope_fk",
          ["tenant_id", "source_id", "parent_dimension_id"],
          "accounting_dimensions",
          ["tenant_id", "source_id", "dimension_id"]
        )
      ],
      [
        {
          name: "accounting_dimensions_source_dimension_uidx",
          columns: ["tenant_id", "source_id", "dimension_kind", "source_dimension_id"],
          unique: true
        },
        {
          name: "accounting_dimensions_scope_uidx",
          columns: ["tenant_id", "source_id", "dimension_id"],
          unique: true
        }
      ]
    ),
    table(
      "transactions",
      "Header-level financial events.",
      [
        id("transaction_id"),
        text("tenant_id"),
        text("source_id"),
        text("source_transaction_id"),
        text("source_transaction_type"),
        text("transaction_number", true),
        date("transaction_date"),
        timestamp("posted_at", true),
        timestamp("updated_at", true),
        text("party_id", true),
        text("currency_code"),
        numeric("exchange_rate", true),
        text("status"),
        text("memo", true),
        jsonb("source_payload_ref")
      ],
      [
        foreignKey(
          "transactions_source_scope_fk",
          ["tenant_id", "source_id"],
          "accounting_sources",
          ["tenant_id", "source_id"]
        ),
        foreignKey(
          "transactions_party_scope_fk",
          ["tenant_id", "source_id", "party_id"],
          "parties",
          ["tenant_id", "source_id", "party_id"]
        )
      ],
      [
        {
          name: "transactions_source_transaction_uidx",
          columns: ["tenant_id", "source_id", "source_transaction_type", "source_transaction_id"],
          unique: true
        },
        {
          name: "transactions_date_idx",
          columns: ["tenant_id", "source_id", "transaction_date"]
        },
        {
          name: "transactions_scope_uidx",
          columns: ["tenant_id", "source_id", "transaction_id"],
          unique: true
        }
      ]
    ),
    table(
      "transaction_lines",
      "Line-level detail before double-entry posting expansion.",
      [
        id("transaction_line_id"),
        text("tenant_id"),
        text("source_id"),
        text("transaction_id"),
        integer("line_number"),
        text("account_id", true),
        text("party_id", true),
        text("item_id", true),
        numeric("amount"),
        numeric("quantity", true),
        numeric("unit_amount", true),
        text("description", true),
        jsonb("dimension_refs")
      ],
      [
        {
          name: "transaction_lines_line_number_check",
          sql: "line_number >= 0"
        },
        foreignKey(
          "transaction_lines_transaction_scope_fk",
          ["tenant_id", "source_id", "transaction_id"],
          "transactions",
          ["tenant_id", "source_id", "transaction_id"]
        ),
        foreignKey(
          "transaction_lines_account_scope_fk",
          ["tenant_id", "source_id", "account_id"],
          "accounts",
          ["tenant_id", "source_id", "account_id"]
        ),
        foreignKey(
          "transaction_lines_party_scope_fk",
          ["tenant_id", "source_id", "party_id"],
          "parties",
          ["tenant_id", "source_id", "party_id"]
        ),
        foreignKey(
          "transaction_lines_item_scope_fk",
          ["tenant_id", "source_id", "item_id"],
          "items",
          ["tenant_id", "source_id", "item_id"]
        )
      ],
      [
        {
          name: "transaction_lines_transaction_line_uidx",
          columns: ["tenant_id", "source_id", "transaction_id", "line_number"],
          unique: true
        },
        {
          name: "transaction_lines_scope_uidx",
          columns: ["tenant_id", "source_id", "transaction_line_id"],
          unique: true
        }
      ]
    ),
    table(
      "ledger_postings",
      "Durable reporting facts used by statements and rollups.",
      [
        id("posting_id"),
        text("tenant_id"),
        text("source_id"),
        text("source_posting_id"),
        text("transaction_id"),
        text("transaction_line_id", true),
        text("account_id"),
        text("party_id", true),
        text("item_id", true),
        date("posting_date"),
        text("accounting_basis"),
        numeric("debit_amount"),
        numeric("credit_amount"),
        numeric("net_amount"),
        text("currency_code"),
        text("dimension_hash"),
        jsonb("dimension_refs"),
        jsonb("source_payload_ref"),
        text("import_batch_id"),
        text("checkpoint_id", true)
      ],
      [
        {
          name: "ledger_postings_nonnegative_debit_check",
          sql: "debit_amount >= 0"
        },
        {
          name: "ledger_postings_nonnegative_credit_check",
          sql: "credit_amount >= 0"
        },
        {
          name: "ledger_postings_dimension_hash_check",
          sql: "length(dimension_hash) = 64"
        },
        {
          name: "ledger_postings_single_sided_check",
          sql: "(debit_amount > 0 and credit_amount = 0) or (credit_amount > 0 and debit_amount = 0)"
        },
        {
          name: "ledger_postings_net_amount_check",
          sql: "net_amount = debit_amount - credit_amount"
        },
        foreignKey(
          "ledger_postings_transaction_scope_fk",
          ["tenant_id", "source_id", "transaction_id"],
          "transactions",
          ["tenant_id", "source_id", "transaction_id"]
        ),
        foreignKey(
          "ledger_postings_transaction_line_scope_fk",
          ["tenant_id", "source_id", "transaction_line_id"],
          "transaction_lines",
          ["tenant_id", "source_id", "transaction_line_id"]
        ),
        foreignKey(
          "ledger_postings_account_scope_fk",
          ["tenant_id", "source_id", "account_id"],
          "accounts",
          ["tenant_id", "source_id", "account_id"]
        ),
        foreignKey(
          "ledger_postings_party_scope_fk",
          ["tenant_id", "source_id", "party_id"],
          "parties",
          ["tenant_id", "source_id", "party_id"]
        ),
        foreignKey(
          "ledger_postings_item_scope_fk",
          ["tenant_id", "source_id", "item_id"],
          "items",
          ["tenant_id", "source_id", "item_id"]
        )
      ],
      [
        {
          name: "ledger_postings_source_posting_uidx",
          columns: ["tenant_id", "source_id", "accounting_basis", "source_posting_id"],
          unique: true
        },
        {
          name: "ledger_postings_report_idx",
          columns: ["tenant_id", "posting_date", "accounting_basis", "account_id", "currency_code"]
        },
        {
          name: "ledger_postings_import_batch_idx",
          columns: ["tenant_id", "import_batch_id"]
        }
      ]
    ),
    table(
      "journal_entry_links",
      "Append-only reversal, void, correction, and replacement relationships between immutable posted journals.",
      [
        id("journal_entry_link_id"),
        text("tenant_id"),
        text("company_id"),
        text("source_id"),
        text("original_transaction_id"),
        text("related_transaction_id"),
        text("link_type"),
        text("lifecycle_event_id"),
        timestamp("created_at")
      ],
      [
        {
          name: "journal_entry_links_type_check",
          sql: "link_type in ('reversal', 'void', 'correction', 'replacement')"
        },
        {
          name: "journal_entry_links_distinct_check",
          sql: "original_transaction_id <> related_transaction_id"
        },
        foreignKey(
          "journal_entry_links_company_source_scope_fk",
          ["tenant_id", "company_id", "source_id"],
          "company_sources",
          ["tenant_id", "company_id", "source_id"]
        ),
        foreignKey(
          "journal_entry_links_original_scope_fk",
          ["tenant_id", "source_id", "original_transaction_id"],
          "transactions",
          ["tenant_id", "source_id", "transaction_id"]
        ),
        foreignKey(
          "journal_entry_links_related_scope_fk",
          ["tenant_id", "source_id", "related_transaction_id"],
          "transactions",
          ["tenant_id", "source_id", "transaction_id"]
        ),
        foreignKey(
          "journal_entry_links_event_scope_fk",
          ["tenant_id", "company_id", "source_id", "lifecycle_event_id"],
          "financial_lifecycle_events",
          ["tenant_id", "company_id", "source_id", "event_id"]
        )
      ],
      [
        {
          name: "journal_entry_links_identity_uidx",
          columns: ["tenant_id", "company_id", "source_id", "original_transaction_id", "related_transaction_id", "link_type"],
          unique: true
        },
        {
          name: "journal_entry_links_original_idx",
          columns: ["tenant_id", "company_id", "source_id", "original_transaction_id", "created_at"]
        },
        {
          name: "journal_entry_links_terminal_reversal_uidx",
          columns: ["tenant_id", "company_id", "source_id", "original_transaction_id"],
          unique: true,
          whereSql: `"link_type" = any (array['reversal'::text, 'void'::text])`
        },
        {
          name: "journal_entry_links_terminal_replacement_uidx",
          columns: ["tenant_id", "company_id", "source_id", "original_transaction_id"],
          unique: true,
          whereSql: `"link_type" = any (array['correction'::text, 'replacement'::text])`
        }
      ]
    ),
    table(
      "subledger_documents",
      "Versioned receivable, payable, cash, credit, refund, write-off, deposit, and transfer documents.",
      [
        id("subledger_document_id"),
        text("tenant_id"),
        text("company_id"),
        text("source_id"),
        text("document_type"),
        text("transaction_id"),
        text("party_id", true),
        text("document_number", true),
        date("document_date"),
        date("due_date", true),
        text("currency_code"),
        numeric("original_amount"),
        numeric("open_amount"),
        text("status"),
        integer("version"),
        text("idempotency_key"),
        text("lifecycle_event_id"),
        jsonb("metadata", 4096, false),
        timestamp("created_at"),
        timestamp("updated_at")
      ],
      [
        {
          name: "subledger_documents_type_check",
          sql: "document_type in ('invoice', 'customer_payment', 'credit_memo', 'refund', 'vendor_bill', 'bill_payment', 'write_off', 'deposit', 'transfer', 'sales_receipt', 'purchase', 'vendor_credit')"
        },
        {
          name: "subledger_documents_amount_check",
          sql: "original_amount > 0 and open_amount >= 0 and open_amount <= original_amount"
        },
        {
          name: "subledger_documents_status_check",
          sql: "(status = 'open' and open_amount = original_amount) or (status = 'partially_applied' and open_amount > 0 and open_amount < original_amount) or (status in ('settled', 'voided') and open_amount = 0)"
        },
        {
          name: "subledger_documents_version_check",
          sql: "version >= 1"
        },
        {
          name: "subledger_documents_due_date_check",
          sql: "due_date is null or due_date >= document_date"
        },
        {
          name: "subledger_documents_timestamp_check",
          sql: "updated_at >= created_at"
        },
        foreignKey(
          "subledger_documents_company_source_scope_fk",
          ["tenant_id", "company_id", "source_id"],
          "company_sources",
          ["tenant_id", "company_id", "source_id"]
        ),
        foreignKey(
          "subledger_documents_transaction_scope_fk",
          ["tenant_id", "source_id", "transaction_id"],
          "transactions",
          ["tenant_id", "source_id", "transaction_id"]
        ),
        foreignKey(
          "subledger_documents_party_scope_fk",
          ["tenant_id", "source_id", "party_id"],
          "parties",
          ["tenant_id", "source_id", "party_id"]
        ),
        foreignKey(
          "subledger_documents_event_scope_fk",
          ["tenant_id", "company_id", "source_id", "lifecycle_event_id"],
          "financial_lifecycle_events",
          ["tenant_id", "company_id", "source_id", "event_id"]
        )
      ],
      [
        {
          name: "subledger_documents_idempotency_uidx",
          columns: ["tenant_id", "company_id", "source_id", "idempotency_key"],
          unique: true
        },
        {
          name: "subledger_documents_scope_uidx",
          columns: ["tenant_id", "company_id", "source_id", "subledger_document_id"],
          unique: true
        },
        {
          name: "subledger_documents_open_idx",
          columns: ["tenant_id", "company_id", "source_id", "document_type", "status", "due_date", "document_date"]
        },
        {
          name: "subledger_documents_party_idx",
          columns: ["tenant_id", "company_id", "source_id", "party_id", "document_type", "status"]
        }
      ]
    ),
    table(
      "subledger_applications",
      "Versioned payment and credit allocations with database-enforced balance, party, scope, currency, and terminal-state invariants.",
      [
        id("subledger_application_id"),
        text("tenant_id"),
        text("company_id"),
        text("source_id"),
        text("application_type"),
        text("source_document_id"),
        text("target_document_id"),
        numeric("applied_amount"),
        text("currency_code"),
        date("application_date"),
        text("status"),
        integer("version"),
        text("idempotency_key"),
        text("applied_event_id"),
        text("ended_event_id", true),
        text("match_candidate_id", true),
        text("match_decision_id", true),
        text("match_method", true),
        numeric("match_score", true),
        jsonb("match_evidence", 4096, true),
        timestamp("created_at"),
        timestamp("updated_at")
      ],
      [
        {
          name: "subledger_applications_type_check",
          sql: "application_type in ('customer_payment_to_invoice', 'bill_payment_to_bill', 'credit_to_invoice', 'vendor_credit_to_bill', 'write_off_to_invoice')"
        },
        {
          name: "subledger_applications_amount_check",
          sql: "applied_amount > 0"
        },
        {
          name: "subledger_applications_status_check",
          sql: "status in ('applied', 'unapplied', 'voided')"
        },
        {
          name: "subledger_applications_version_check",
          sql: "version >= 1"
        },
        {
          name: "subledger_applications_distinct_check",
          sql: "source_document_id <> target_document_id"
        },
        {
          name: "subledger_applications_terminal_event_check",
          sql: "(status = 'applied' and ended_event_id is null) or (status in ('unapplied', 'voided') and ended_event_id is not null)"
        },
        {
          name: "subledger_applications_timestamp_check",
          sql: "updated_at >= created_at"
        },
        {
          name: "subledger_applications_match_method_check",
          sql: "match_method is null or match_method in ('automatic', 'manual')"
        },
        {
          name: "subledger_applications_match_score_check",
          sql: "match_score is null or (match_score >= 0 and match_score <= 1)"
        },
        {
          name: "subledger_applications_match_shape_check",
          sql: "num_nonnulls(match_candidate_id, match_decision_id, match_method, match_score) in (0, 4) and (match_candidate_id is not null or match_evidence is null)"
        },
        foreignKey(
          "subledger_applications_source_document_scope_fk",
          ["tenant_id", "company_id", "source_id", "source_document_id"],
          "subledger_documents",
          ["tenant_id", "company_id", "source_id", "subledger_document_id"]
        ),
        foreignKey(
          "subledger_applications_target_document_scope_fk",
          ["tenant_id", "company_id", "source_id", "target_document_id"],
          "subledger_documents",
          ["tenant_id", "company_id", "source_id", "subledger_document_id"]
        ),
        foreignKey(
          "subledger_applications_applied_event_scope_fk",
          ["tenant_id", "company_id", "source_id", "applied_event_id"],
          "financial_lifecycle_events",
          ["tenant_id", "company_id", "source_id", "event_id"]
        ),
        foreignKey(
          "subledger_applications_ended_event_scope_fk",
          ["tenant_id", "company_id", "source_id", "ended_event_id"],
          "financial_lifecycle_events",
          ["tenant_id", "company_id", "source_id", "event_id"]
        ),
        foreignKey(
          "subledger_applications_match_candidate_scope_fk",
          ["tenant_id", "source_id", "match_candidate_id"],
          "transaction_match_candidates",
          ["tenant_id", "source_id", "match_candidate_id"]
        ),
        foreignKey(
          "subledger_applications_match_candidate_decision_scope_fk",
          ["tenant_id", "source_id", "match_candidate_id", "match_decision_id"],
          "transaction_match_decisions",
          ["tenant_id", "source_id", "match_candidate_id", "match_decision_id"]
        )
      ],
      [
        {
          name: "subledger_applications_idempotency_uidx",
          columns: ["tenant_id", "company_id", "source_id", "idempotency_key"],
          unique: true
        },
        {
          name: "subledger_applications_scope_uidx",
          columns: ["tenant_id", "company_id", "source_id", "subledger_application_id"],
          unique: true
        },
        {
          name: "subledger_applications_source_status_idx",
          columns: ["tenant_id", "company_id", "source_id", "source_document_id", "status", "application_date"]
        },
        {
          name: "subledger_applications_target_status_idx",
          columns: ["tenant_id", "company_id", "source_id", "target_document_id", "status", "application_date"]
        }
      ]
    ),
    table(
      "bill_payment_disbursements",
      "Versioned scheduled-to-cleared vendor disbursements with immutable ordered allocations and payment provenance.",
      [
        id("bill_payment_id"),
        text("tenant_id"),
        text("company_id"),
        text("source_id"),
        text("subledger_document_id", true),
        text("vendor_id"),
        date("payment_date"),
        text("document_number", true),
        text("memo", true),
        text("currency_code"),
        numeric("amount"),
        text("payment_method"),
        text("payment_reference", true),
        text("funding_account_id"),
        text("payable_account_id"),
        jsonb("allocations", 8192, false),
        text("status"),
        integer("version"),
        text("idempotency_key"),
        text("payload_checksum"),
        text("scheduled_event_id"),
        text("cleared_event_id", true),
        text("voided_event_id", true),
        timestamp("created_at"),
        timestamp("updated_at")
      ],
      [
        { name: "bill_payment_disbursements_method_check", sql: "payment_method in ('ach', 'card', 'check')" },
        { name: "bill_payment_disbursements_amount_check", sql: "amount > 0" },
        {
          name: "bill_payment_disbursements_allocations_check",
          sql: "jsonb_typeof(allocations) = 'array' and jsonb_array_length(allocations) > 0"
        },
        { name: "bill_payment_disbursements_status_check", sql: "status in ('scheduled', 'cleared', 'voided')" },
        { name: "bill_payment_disbursements_version_check", sql: "version >= 1" },
        { name: "bill_payment_disbursements_checksum_check", sql: "length(payload_checksum) = 64" },
        { name: "bill_payment_disbursements_timestamp_check", sql: "updated_at >= created_at" },
        {
          name: "bill_payment_disbursements_state_shape_check",
          sql: "(status = 'scheduled' and subledger_document_id is null and cleared_event_id is null and voided_event_id is null) or (status = 'cleared' and subledger_document_id is not null and cleared_event_id is not null and voided_event_id is null) or (status = 'voided' and voided_event_id is not null)"
        },
        foreignKey(
          "bill_payment_disbursements_company_source_scope_fk",
          ["tenant_id", "company_id", "source_id"],
          "company_sources",
          ["tenant_id", "company_id", "source_id"]
        ),
        foreignKey(
          "bill_payment_disbursements_document_scope_fk",
          ["tenant_id", "company_id", "source_id", "subledger_document_id"],
          "subledger_documents",
          ["tenant_id", "company_id", "source_id", "subledger_document_id"]
        ),
        foreignKey(
          "bill_payment_disbursements_vendor_scope_fk",
          ["tenant_id", "source_id", "vendor_id"],
          "parties",
          ["tenant_id", "source_id", "party_id"]
        ),
        foreignKey(
          "bill_payment_disbursements_funding_account_scope_fk",
          ["tenant_id", "source_id", "funding_account_id"],
          "accounts",
          ["tenant_id", "source_id", "account_id"]
        ),
        foreignKey(
          "bill_payment_disbursements_payable_account_scope_fk",
          ["tenant_id", "source_id", "payable_account_id"],
          "accounts",
          ["tenant_id", "source_id", "account_id"]
        ),
        foreignKey(
          "bill_payment_disbursements_scheduled_event_scope_fk",
          ["tenant_id", "company_id", "source_id", "scheduled_event_id"],
          "financial_lifecycle_events",
          ["tenant_id", "company_id", "source_id", "event_id"]
        ),
        foreignKey(
          "bill_payment_disbursements_cleared_event_scope_fk",
          ["tenant_id", "company_id", "source_id", "cleared_event_id"],
          "financial_lifecycle_events",
          ["tenant_id", "company_id", "source_id", "event_id"]
        ),
        foreignKey(
          "bill_payment_disbursements_voided_event_scope_fk",
          ["tenant_id", "company_id", "source_id", "voided_event_id"],
          "financial_lifecycle_events",
          ["tenant_id", "company_id", "source_id", "event_id"]
        )
      ],
      [
        {
          name: "bill_payment_disbursements_scope_uidx",
          columns: ["tenant_id", "company_id", "source_id", "bill_payment_id"],
          unique: true
        },
        {
          name: "bill_payment_disbursements_idempotency_uidx",
          columns: ["tenant_id", "company_id", "source_id", "idempotency_key"],
          unique: true
        },
        {
          name: "bill_payment_disbursements_register_idx",
          columns: ["tenant_id", "company_id", "source_id", "status", "payment_date", "bill_payment_id"]
        },
        {
          name: "bill_payment_disbursements_vendor_idx",
          columns: ["tenant_id", "company_id", "source_id", "vendor_id", "payment_date"]
        }
      ]
    ),
    table(
      "posting_rules",
      "Provider-neutral transaction conditions and deterministic posting actions.",
      [
        id("posting_rule_id"),
        text("tenant_id"),
        text("source_id"),
        text("rule_code"),
        text("name"),
        text("description", true),
        integer("priority"),
        text("status"),
        text("condition_mode"),
        jsonb("conditions", 4096, false),
        jsonb("actions", 4096, false),
        date("effective_from", true),
        date("effective_through", true),
        timestamp("created_at"),
        timestamp("updated_at")
      ],
      [
        {
          name: "posting_rules_priority_check",
          sql: "priority >= 0"
        },
        {
          name: "posting_rules_effective_period_check",
          sql: "effective_from is null or effective_through is null or effective_from <= effective_through"
        },
        {
          name: "posting_rules_status_check",
          sql: "status in ('draft', 'active', 'inactive', 'archived')"
        },
        {
          name: "posting_rules_condition_mode_check",
          sql: "condition_mode in ('all', 'any')"
        },
        {
          name: "posting_rules_json_shape_check",
          sql: "jsonb_typeof(conditions) = 'array' and jsonb_array_length(conditions) > 0 and jsonb_typeof(actions) = 'array' and jsonb_array_length(actions) > 0"
        },
        {
          name: "posting_rules_updated_at_check",
          sql: "updated_at >= created_at"
        },
        foreignKey(
          "posting_rules_source_scope_fk",
          ["tenant_id", "source_id"],
          "accounting_sources",
          ["tenant_id", "source_id"]
        )
      ],
      [
        {
          name: "posting_rules_code_uidx",
          columns: ["tenant_id", "source_id", "rule_code"],
          unique: true
        },
        {
          name: "posting_rules_active_priority_idx",
          columns: ["tenant_id", "source_id", "status", "priority", "rule_code"]
        }
      ]
    ),
    table(
      "transaction_match_candidates",
      "Versioned candidate links between payments and receivable or payable transactions.",
      [
        id("match_candidate_id"),
        text("tenant_id"),
        text("source_id"),
        text("match_kind"),
        text("origin_transaction_id"),
        text("target_transaction_id"),
        text("matcher_version"),
        numeric("score"),
        numeric("suggested_application_amount"),
        text("currency_code"),
        text("status"),
        jsonb("evidence", 4096, false),
        timestamp("created_at"),
        timestamp("expires_at", true)
      ],
      [
        {
          name: "transaction_match_candidates_score_check",
          sql: "score >= 0 and score <= 1"
        },
        {
          name: "transaction_match_candidates_amount_check",
          sql: "suggested_application_amount > 0"
        },
        {
          name: "transaction_match_candidates_expiry_check",
          sql: "expires_at is null or expires_at > created_at"
        },
        {
          name: "transaction_match_candidates_kind_check",
          sql: "match_kind in ('customer_payment_to_invoice', 'vendor_payment_to_bill')"
        },
        {
          name: "transaction_match_candidates_status_check",
          sql: "status in ('suggested', 'accepted', 'rejected', 'expired', 'superseded')"
        },
        {
          name: "transaction_match_candidates_distinct_transactions_check",
          sql: "origin_transaction_id <> target_transaction_id"
        },
        {
          name: "transaction_match_candidates_evidence_shape_check",
          sql: "jsonb_typeof(evidence) = 'array' and jsonb_array_length(evidence) > 0"
        },
        foreignKey(
          "transaction_match_candidates_origin_scope_fk",
          ["tenant_id", "source_id", "origin_transaction_id"],
          "transactions",
          ["tenant_id", "source_id", "transaction_id"]
        ),
        foreignKey(
          "transaction_match_candidates_target_scope_fk",
          ["tenant_id", "source_id", "target_transaction_id"],
          "transactions",
          ["tenant_id", "source_id", "transaction_id"]
        )
      ],
      [
        {
          name: "transaction_match_candidates_identity_uidx",
          columns: [
            "tenant_id",
            "source_id",
            "match_kind",
            "origin_transaction_id",
            "target_transaction_id",
            "matcher_version"
          ],
          unique: true
        },
        {
          name: "transaction_match_candidates_origin_status_idx",
          columns: ["tenant_id", "source_id", "origin_transaction_id", "status", "score"]
        },
        {
          name: "transaction_match_candidates_scope_uidx",
          columns: ["tenant_id", "source_id", "match_candidate_id"],
          unique: true
        }
      ]
    ),
    table(
      "transaction_match_decisions",
      "Append-only audit decisions for proposed transaction matches.",
      [
        id("match_decision_id"),
        text("tenant_id"),
        text("source_id"),
        text("match_candidate_id"),
        text("decision"),
        text("method"),
        timestamp("decided_at"),
        text("decided_by_ref", true),
        text("reason", true),
        jsonb("evidence")
      ],
      [
        {
          name: "transaction_match_decisions_value_check",
          sql: "decision in ('accepted', 'rejected', 'superseded')"
        },
        {
          name: "transaction_match_decisions_method_check",
          sql: "method in ('automatic', 'manual')"
        },
        {
          name: "transaction_match_decisions_manual_actor_check",
          sql: "method <> 'manual' or (decided_by_ref is not null and btrim(decided_by_ref) <> '')"
        },
        foreignKey(
          "transaction_match_decisions_candidate_scope_fk",
          ["tenant_id", "source_id", "match_candidate_id"],
          "transaction_match_candidates",
          ["tenant_id", "source_id", "match_candidate_id"]
        )
      ],
      [
        {
          name: "transaction_match_decisions_identity_uidx",
          columns: ["tenant_id", "source_id", "match_decision_id"],
          unique: true
        },
        {
          name: "transaction_match_decisions_candidate_identity_uidx",
          columns: ["tenant_id", "source_id", "match_candidate_id", "match_decision_id"],
          unique: true
        },
        {
          name: "transaction_match_decisions_terminal_uidx",
          columns: ["tenant_id", "source_id", "match_candidate_id"],
          unique: true,
          whereSql: `"decision" = any (array['accepted'::text, 'rejected'::text])`
        },
        {
          name: "transaction_match_decisions_candidate_idx",
          columns: ["tenant_id", "source_id", "match_candidate_id", "decided_at"]
        }
      ]
    ),
    table(
      "payment_applications",
      "Auditable allocations of customer payments to invoices.",
      [
        id("payment_application_id"),
        text("tenant_id"),
        text("source_id"),
        text("payment_transaction_id"),
        text("invoice_transaction_id"),
        text("match_decision_id", true),
        numeric("applied_amount"),
        text("currency_code"),
        date("application_date"),
        text("status"),
        timestamp("created_at"),
        timestamp("updated_at")
      ],
      [
        {
          name: "payment_applications_amount_check",
          sql: "applied_amount > 0"
        },
        {
          name: "payment_applications_status_check",
          sql: "status in ('proposed', 'posted', 'voided')"
        },
        {
          name: "payment_applications_distinct_transactions_check",
          sql: "payment_transaction_id <> invoice_transaction_id"
        },
        {
          name: "payment_applications_updated_at_check",
          sql: "updated_at >= created_at"
        },
        foreignKey(
          "payment_applications_payment_scope_fk",
          ["tenant_id", "source_id", "payment_transaction_id"],
          "transactions",
          ["tenant_id", "source_id", "transaction_id"]
        ),
        foreignKey(
          "payment_applications_invoice_scope_fk",
          ["tenant_id", "source_id", "invoice_transaction_id"],
          "transactions",
          ["tenant_id", "source_id", "transaction_id"]
        ),
        foreignKey(
          "payment_applications_decision_scope_fk",
          ["tenant_id", "source_id", "match_decision_id"],
          "transaction_match_decisions",
          ["tenant_id", "source_id", "match_decision_id"]
        )
      ],
      [
        {
          name: "payment_applications_identity_uidx",
          columns: ["tenant_id", "source_id", "payment_transaction_id", "invoice_transaction_id"],
          unique: true
        },
        {
          name: "payment_applications_invoice_status_idx",
          columns: ["tenant_id", "source_id", "invoice_transaction_id", "status", "application_date"]
        }
      ]
    ),
    table(
      "rollup_buckets",
      "Durable aggregate buckets for normal report reads and late-arrival reprocessing.",
      [
        id("rollup_bucket_id"),
        text("tenant_id"),
        text("company_id"),
        text("source_id"),
        text("account_id"),
        text("accounting_basis"),
        text("bucket_grain"),
        date("bucket_start"),
        date("bucket_end"),
        text("currency_code"),
        text("dimension_hash"),
        text("party_id"),
        text("party_type"),
        text("item_id"),
        numeric("debit_amount"),
        numeric("credit_amount"),
        numeric("net_amount"),
        integer("posting_count"),
        timestamp("source_posting_max_updated_at", true),
        text("import_batch_id", true),
        timestamp("generated_at")
      ],
      [
        {
          name: "rollup_buckets_period_check",
          sql: "bucket_start <= bucket_end"
        },
        {
          name: "rollup_buckets_nonnegative_debit_check",
          sql: "debit_amount >= 0"
        },
        {
          name: "rollup_buckets_nonnegative_credit_check",
          sql: "credit_amount >= 0"
        },
        {
          name: "rollup_buckets_dimension_hash_check",
          sql: "length(dimension_hash) = 64"
        },
        {
          name: "rollup_buckets_posting_count_check",
          sql: "posting_count >= 0"
        },
        foreignKey(
          "rollup_buckets_company_source_scope_fk",
          ["tenant_id", "company_id", "source_id"],
          "company_sources",
          ["tenant_id", "company_id", "source_id"]
        ),
        foreignKey(
          "rollup_buckets_account_scope_fk",
          ["tenant_id", "source_id", "account_id"],
          "accounts",
          ["tenant_id", "source_id", "account_id"]
        )
      ],
      [
        {
          name: "rollup_buckets_identity_uidx",
          columns: [
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
          ],
          unique: true
        },
        {
          name: "rollup_buckets_report_idx",
          columns: [
            "tenant_id",
            "company_id",
            "source_id",
            "accounting_basis",
            "bucket_grain",
            "currency_code",
            "bucket_start",
            "bucket_end",
            "account_id",
            "dimension_hash",
            "party_type",
            "party_id",
            "item_id"
          ]
        }
      ]
    ),
    table(
      "import_batches",
      "Append-only source import work records.",
      [
        id("import_batch_id"),
        text("tenant_id"),
        text("source_id"),
        text("mode"),
        text("status"),
        timestamp("started_at"),
        timestamp("completed_at", true),
        jsonb("source_object_counts"),
        jsonb("warning_summary"),
        jsonb("error_summary")
      ],
      [
        foreignKey(
          "import_batches_source_scope_fk",
          ["tenant_id", "source_id"],
          "accounting_sources",
          ["tenant_id", "source_id"]
        )
      ],
      [
        {
          name: "import_batches_source_batch_uidx",
          columns: ["tenant_id", "source_id", "import_batch_id"],
          unique: true
        },
        {
          name: "import_batches_source_started_idx",
          columns: ["tenant_id", "source_id", "started_at"]
        }
      ]
    ),
    table(
      "sync_checkpoints",
      "Cursor state for delta sync and late-arrival recovery.",
      [
        id("checkpoint_id"),
        text("tenant_id"),
        text("source_id"),
        text("source_object"),
        text("cursor_kind"),
        text("cursor_value"),
        timestamp("fresh_through", true),
        timestamp("latest_source_updated_at", true),
        text("status")
      ],
      [
        foreignKey(
          "sync_checkpoints_source_scope_fk",
          ["tenant_id", "source_id"],
          "accounting_sources",
          ["tenant_id", "source_id"]
        )
      ],
      [
        {
          name: "sync_checkpoints_source_object_uidx",
          columns: ["tenant_id", "source_id", "source_object", "cursor_kind"],
          unique: true
        },
        {
          name: "sync_checkpoints_scope_uidx",
          columns: ["tenant_id", "source_id", "checkpoint_id"],
          unique: true
        }
      ]
    ),
    table(
      "report_freshness",
      "Dashboard-readable source/report freshness and stale snapshot state.",
      [
        id("freshness_id"),
        text("tenant_id"),
        text("company_id"),
        text("source_id"),
        text("report_name"),
        text("accounting_basis"),
        date("period_start"),
        date("period_end"),
        text("currency_code"),
        text("status"),
        timestamp("fresh_through", true),
        text("stale_reason", true),
        text("import_batch_id", true),
        text("checkpoint_id", true),
        timestamp("updated_at")
      ],
      [
        {
          name: "report_freshness_period_check",
          sql: "period_start <= period_end"
        },
        foreignKey(
          "report_freshness_company_source_scope_fk",
          ["tenant_id", "company_id", "source_id"],
          "company_sources",
          ["tenant_id", "company_id", "source_id"]
        )
      ],
      [
        {
          name: "report_freshness_identity_uidx",
          columns: [
            "tenant_id",
            "company_id",
            "source_id",
            "report_name",
            "accounting_basis",
            "period_start",
            "period_end",
            "currency_code"
          ],
          unique: true
        },
        {
          name: "report_freshness_status_idx",
          columns: ["tenant_id", "company_id", "status", "updated_at"]
        }
      ],
      false
    ),
    table(
      "report_snapshots",
      "Durable report outputs and provenance.",
      [
        id("report_snapshot_id"),
        text("tenant_id"),
        text("company_id"),
        text("source_id"),
        text("report_name"),
        text("snapshot_source"),
        text("accounting_basis"),
        date("period_start"),
        date("period_end"),
        date("as_of_date"),
        text("currency_code"),
        timestamp("generated_at"),
        jsonb("freshness"),
        text("reconciliation_status"),
        numeric("reconciliation_difference")
      ],
      [
        {
          name: "report_snapshots_period_check",
          sql: "period_start <= period_end"
        },
        foreignKey(
          "report_snapshots_company_source_scope_fk",
          ["tenant_id", "company_id", "source_id"],
          "company_sources",
          ["tenant_id", "company_id", "source_id"]
        )
      ],
      [
        {
          name: "report_snapshots_request_uidx",
          columns: [
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
          ],
          unique: true
        },
        {
          name: "report_snapshots_scope_uidx",
          columns: ["tenant_id", "company_id", "source_id", "report_snapshot_id"],
          unique: true
        }
      ]
    ),
    table(
      "report_snapshot_lines",
      "Persisted statement rows with drilldown evidence.",
      [
        id("report_line_id"),
        text("tenant_id"),
        text("company_id"),
        text("source_id"),
        text("report_snapshot_id"),
        text("parent_report_line_id", true),
        text("section"),
        text("label"),
        text("account_id", true),
        numeric("amount"),
        integer("sort_order"),
        jsonb("drilldown_ref")
      ],
      [
        foreignKey(
          "report_snapshot_lines_snapshot_scope_fk",
          ["tenant_id", "company_id", "source_id", "report_snapshot_id"],
          "report_snapshots",
          ["tenant_id", "company_id", "source_id", "report_snapshot_id"]
        ),
        foreignKey(
          "report_snapshot_lines_parent_scope_fk",
          ["tenant_id", "company_id", "source_id", "parent_report_line_id"],
          "report_snapshot_lines",
          ["tenant_id", "company_id", "source_id", "report_line_id"]
        ),
        foreignKey(
          "report_snapshot_lines_account_scope_fk",
          ["tenant_id", "source_id", "account_id"],
          "accounts",
          ["tenant_id", "source_id", "account_id"]
        )
      ],
      [
        {
          name: "report_snapshot_lines_sort_uidx",
          columns: ["tenant_id", "company_id", "source_id", "report_snapshot_id", "sort_order", "report_line_id"],
          unique: true
        },
        {
          name: "report_snapshot_lines_scope_uidx",
          columns: ["tenant_id", "company_id", "source_id", "report_line_id"],
          unique: true
        }
      ]
    ),
    table(
      "report_snapshot_totals",
      "Named report totals with drilldown evidence.",
      [
        id("report_total_id"),
        text("tenant_id"),
        text("company_id"),
        text("source_id"),
        text("report_snapshot_id"),
        text("total_key"),
        text("label"),
        numeric("amount"),
        jsonb("drilldown_ref")
      ],
      [
        foreignKey(
          "report_snapshot_totals_snapshot_scope_fk",
          ["tenant_id", "company_id", "source_id", "report_snapshot_id"],
          "report_snapshots",
          ["tenant_id", "company_id", "source_id", "report_snapshot_id"]
        )
      ],
      [
        {
          name: "report_snapshot_totals_total_key_uidx",
          columns: ["tenant_id", "company_id", "source_id", "report_snapshot_id", "total_key"],
          unique: true
        }
      ]
    ),
    ...sdkV1Tables()
  ]
} as const;

function sdkV1Tables(): readonly PostgresTableManifest[] {
  return [
    table(
      "reporting_books",
      "Financial reporting books decouple one reporting ledger from the provenance sources that contribute facts.",
      [
        id("tenant_id"),
        id("company_id"),
        id("book_id"),
        text("name"),
        text("base_currency_code"),
        text("accounting_basis"),
        text("status"),
        timestamp("created_at"),
        timestamp("updated_at")
      ],
      [
        { name: "reporting_books_basis_check", sql: "accounting_basis in ('accrual', 'cash', 'modified_cash')" },
        { name: "reporting_books_status_check", sql: "status in ('active', 'archived')" },
        { name: "reporting_books_timestamp_check", sql: "updated_at >= created_at" },
        foreignKey(
          "reporting_books_company_scope_fk",
          ["tenant_id", "company_id"],
          "accounting_companies",
          ["tenant_id", "company_id"]
        )
      ],
      [
        { name: "reporting_books_scope_uidx", columns: ["tenant_id", "company_id", "book_id"], unique: true },
        { name: "reporting_books_name_uidx", columns: ["tenant_id", "company_id", "name"], unique: true },
        {
          name: "reporting_books_currency_scope_uidx",
          columns: ["tenant_id", "company_id", "book_id", "base_currency_code"],
          unique: true
        }
      ],
      false
    ),
    table(
      "reporting_book_sources",
      "Effective-dated provenance sources that contribute to a reporting book.",
      [
        id("book_source_id"),
        text("tenant_id"),
        text("company_id"),
        text("book_id"),
        text("source_id"),
        text("source_role"),
        date("effective_from", true),
        date("effective_through", true),
        timestamp("created_at")
      ],
      [
        { name: "reporting_book_sources_role_check", sql: "source_role in ('historical', 'active', 'adjustment')" },
        {
          name: "reporting_book_sources_window_check",
          sql: "effective_from is null or effective_through is null or effective_from <= effective_through"
        },
        foreignKey(
          "reporting_book_sources_book_scope_fk",
          ["tenant_id", "company_id", "book_id"],
          "reporting_books",
          ["tenant_id", "company_id", "book_id"]
        ),
        foreignKey(
          "reporting_book_sources_company_source_scope_fk",
          ["tenant_id", "company_id", "source_id"],
          "company_sources",
          ["tenant_id", "company_id", "source_id"]
        )
      ],
      [
        {
          name: "reporting_book_sources_identity_uidx",
          columns: ["tenant_id", "company_id", "book_id", "source_id"],
          unique: true
        },
        {
          name: "reporting_book_sources_window_idx",
          columns: ["tenant_id", "company_id", "book_id", "effective_from", "effective_through"]
        }
      ]
    ),
    table(
      "reporting_book_accounts",
      "The authoritative cross-source chart of accounts and hierarchy owned by a reporting book.",
      [
        id("book_account_id"),
        text("tenant_id"),
        text("company_id"),
        text("book_id"),
        text("book_account_key"),
        text("account_number", true),
        text("name"),
        text("classification"),
        text("account_type", true),
        text("account_subtype", true),
        text("account_role"),
        text("parent_book_account_key", true),
        text("currency_code", true),
        bool("active"),
        { ...integer("version"), defaultSql: "1" },
        text("last_operation_request_id"),
        text("last_operation_checksum"),
        timestamp("created_at"),
        timestamp("updated_at")
      ],
      [
        {
          name: "reporting_book_accounts_classification_check",
          sql: "classification in ('asset', 'liability', 'equity', 'income', 'cost_of_goods_sold', 'expense', 'other_income', 'other_expense')"
        },
        {
          name: "reporting_book_accounts_no_self_parent_check",
          sql: "parent_book_account_key is null or parent_book_account_key <> book_account_key"
        },
        { name: "reporting_book_accounts_role_check", sql: "account_role in ('header', 'posting')" },
        {
          name: "reporting_book_accounts_number_format_check",
          sql: "account_number is null or (account_number = btrim(account_number) and account_number <> '')"
        },
        { name: "reporting_book_accounts_version_check", sql: "version >= 1" },
        { name: "reporting_book_accounts_operation_checksum_check", sql: "length(last_operation_checksum) = 64" },
        { name: "reporting_book_accounts_timestamp_check", sql: "updated_at >= created_at" },
        foreignKey(
          "reporting_book_accounts_book_scope_fk",
          ["tenant_id", "company_id", "book_id"],
          "reporting_books",
          ["tenant_id", "company_id", "book_id"]
        ),
        foreignKey(
          "reporting_book_accounts_book_currency_scope_fk",
          ["tenant_id", "company_id", "book_id", "currency_code"],
          "reporting_books",
          ["tenant_id", "company_id", "book_id", "base_currency_code"]
        )
      ],
      [
        {
          name: "reporting_book_accounts_key_uidx",
          columns: ["tenant_id", "company_id", "book_id", "book_account_key"],
          unique: true
        },
        {
          name: "reporting_book_accounts_scope_uidx",
          columns: ["tenant_id", "company_id", "book_id", "book_account_id"],
          unique: true
        },
        {
          name: "reporting_book_accounts_parent_idx",
          columns: ["tenant_id", "company_id", "book_id", "parent_book_account_key"]
        },
        {
          name: "reporting_book_accounts_number_uidx",
          columns: ["tenant_id", "company_id", "book_id", "account_number"],
          unique: true,
          whereSql: "account_number is not null"
        }
      ],
      false
    ),
    table(
      "reporting_book_account_mappings",
      "Maps source-scoped accounts onto stable reporting-book account keys for cross-source continuity.",
      [
        id("book_account_mapping_id"),
        text("tenant_id"),
        text("company_id"),
        text("book_id"),
        text("source_id"),
        text("account_id"),
        text("book_account_key"),
        timestamp("created_at"),
        timestamp("updated_at")
      ],
      [
        { name: "reporting_book_account_mappings_timestamp_check", sql: "updated_at >= created_at" },
        foreignKey(
          "reporting_book_account_mappings_book_scope_fk",
          ["tenant_id", "company_id", "book_id"],
          "reporting_books",
          ["tenant_id", "company_id", "book_id"]
        ),
        foreignKey(
          "reporting_book_account_mappings_book_source_scope_fk",
          ["tenant_id", "company_id", "book_id", "source_id"],
          "reporting_book_sources",
          ["tenant_id", "company_id", "book_id", "source_id"]
        ),
        foreignKey(
          "reporting_book_account_mappings_account_scope_fk",
          ["tenant_id", "source_id", "account_id"],
          "accounts",
          ["tenant_id", "source_id", "account_id"]
        ),
        foreignKey(
          "reporting_book_account_mappings_book_account_scope_fk",
          ["tenant_id", "company_id", "book_id", "book_account_key"],
          "reporting_book_accounts",
          ["tenant_id", "company_id", "book_id", "book_account_key"]
        )
      ],
      [
        {
          name: "reporting_book_account_mappings_source_uidx",
          columns: ["tenant_id", "company_id", "book_id", "source_id", "account_id"],
          unique: true
        },
        {
          name: "reporting_book_account_mappings_book_key_idx",
          columns: ["tenant_id", "company_id", "book_id", "book_account_key"]
        }
      ]
    ),
    table(
      "financial_outbox",
      "Durable transactionally-enqueued work for rollup, snapshot, freshness, and host integration processing.",
      [
        id("outbox_event_id"),
        text("tenant_id"),
        text("company_id"),
        text("book_id", true),
        text("source_id"),
        text("event_type"),
        text("aggregate_type"),
        text("aggregate_id"),
        text("idempotency_key"),
        jsonb("payload", 4096, false),
        text("status"),
        integer("attempt_count"),
        timestamp("available_at"),
        timestamp("lease_expires_at", true),
        text("last_error", true),
        timestamp("created_at"),
        timestamp("published_at", true)
      ],
      [
        { name: "financial_outbox_status_check", sql: "status in ('pending', 'processing', 'published', 'failed')" },
        { name: "financial_outbox_attempt_check", sql: "attempt_count >= 0" },
        {
          name: "financial_outbox_published_check",
          sql: "(status = 'published' and published_at is not null) or (status <> 'published' and published_at is null)"
        },
        foreignKey(
          "financial_outbox_company_source_scope_fk",
          ["tenant_id", "company_id", "source_id"],
          "company_sources",
          ["tenant_id", "company_id", "source_id"]
        ),
        foreignKey(
          "financial_outbox_book_scope_fk",
          ["tenant_id", "company_id", "book_id"],
          "reporting_books",
          ["tenant_id", "company_id", "book_id"]
        ),
        foreignKey(
          "financial_outbox_book_source_scope_fk",
          ["tenant_id", "company_id", "book_id", "source_id"],
          "reporting_book_sources",
          ["tenant_id", "company_id", "book_id", "source_id"]
        )
      ],
      [
        {
          name: "financial_outbox_idempotency_uidx",
          columns: ["tenant_id", "company_id", "source_id", "idempotency_key"],
          unique: true
        },
        {
          name: "financial_outbox_delivery_idx",
          columns: ["status", "available_at", "lease_expires_at", "created_at"]
        }
      ]
    ),
    table(
      "invoice_drafts",
      "Versioned invoice drafts that are edited before immutable posting and retain their issued-document link.",
      [
        id("invoice_draft_id"),
        text("tenant_id"),
        text("company_id"),
        text("book_id"),
        text("source_id"),
        text("customer_id"),
        text("receivable_account_id"),
        text("document_number", true),
        date("document_date"),
        date("due_date"),
        text("currency_code"),
        text("memo", true),
        text("status"),
        integer("version"),
        text("idempotency_key"),
        text("issue_idempotency_key", true),
        text("issued_document_id", true),
        jsonb("metadata", 4096, false),
        timestamp("created_at"),
        timestamp("updated_at")
      ],
      [
        { name: "invoice_drafts_status_check", sql: "status in ('draft', 'issued', 'voided')" },
        { name: "invoice_drafts_version_check", sql: "version >= 1" },
        { name: "invoice_drafts_due_date_check", sql: "due_date >= document_date" },
        {
          name: "invoice_drafts_issued_check",
          sql: "(status = 'issued' and issued_document_id is not null and issue_idempotency_key is not null) or (status <> 'issued' and issued_document_id is null and issue_idempotency_key is null)"
        },
        { name: "invoice_drafts_metadata_shape_check", sql: "jsonb_typeof(metadata) = 'object'" },
        { name: "invoice_drafts_timestamp_check", sql: "updated_at >= created_at" },
        foreignKey(
          "invoice_drafts_book_scope_fk",
          ["tenant_id", "company_id", "book_id"],
          "reporting_books",
          ["tenant_id", "company_id", "book_id"]
        ),
        foreignKey(
          "invoice_drafts_book_source_scope_fk",
          ["tenant_id", "company_id", "book_id", "source_id"],
          "reporting_book_sources",
          ["tenant_id", "company_id", "book_id", "source_id"]
        ),
        foreignKey(
          "invoice_drafts_customer_scope_fk",
          ["tenant_id", "source_id", "customer_id"],
          "parties",
          ["tenant_id", "source_id", "party_id"]
        ),
        foreignKey(
          "invoice_drafts_receivable_account_scope_fk",
          ["tenant_id", "source_id", "receivable_account_id"],
          "accounts",
          ["tenant_id", "source_id", "account_id"]
        ),
        foreignKey(
          "invoice_drafts_issued_document_scope_fk",
          ["tenant_id", "company_id", "source_id", "issued_document_id"],
          "subledger_documents",
          ["tenant_id", "company_id", "source_id", "subledger_document_id"]
        )
      ],
      [
        {
          name: "invoice_drafts_idempotency_uidx",
          columns: ["tenant_id", "company_id", "book_id", "idempotency_key"],
          unique: true
        },
        {
          name: "invoice_drafts_scope_uidx",
          columns: ["tenant_id", "company_id", "book_id", "invoice_draft_id"],
          unique: true
        },
        {
          name: "invoice_drafts_source_scope_uidx",
          columns: ["tenant_id", "company_id", "book_id", "source_id", "invoice_draft_id"],
          unique: true
        },
        {
          name: "invoice_drafts_list_idx",
          columns: ["tenant_id", "company_id", "book_id", "status", "document_date", "invoice_draft_id"]
        }
      ]
    ),
    ...sdkV1LineTables(),
    ...sdkV1BankTables()
  ];
}

function sdkV1LineTables(): readonly PostgresTableManifest[] {
  const amountConstraints = (prefix: string): readonly PostgresConstraintManifest[] => [
    { name: `${prefix}_number_check`, sql: "line_number > 0" },
    {
      name: `${prefix}_amount_check`,
      sql: prefix === "subledger_document_lines" ? "discount_amount >= 0 and (quantity <> 0 or (line_amount = 0 and discount_amount = 0 and tax_amount = 0))" : "quantity > 0 and unit_amount >= 0 and discount_amount >= 0 and tax_amount >= 0 and line_amount > 0"
    },
    {
      name: `${prefix}_scale_check`,
      sql: prefix === "subledger_document_lines" ? "scale(quantity) <= 12 and scale(unit_amount) <= 12 and scale(discount_amount) <= 2 and scale(tax_amount) <= 2 and scale(line_amount) <= 2" : "scale(quantity) <= 4 and scale(unit_amount) <= 2 and scale(discount_amount) <= 2 and scale(tax_amount) <= 2 and scale(line_amount) <= 2"
    },
    {
      name: `${prefix}_arithmetic_check`,
      sql: prefix === "subledger_document_lines" ? "discount_amount <= abs(round(quantity * unit_amount, 2)) and line_amount = round(quantity * unit_amount, 2) - (case when quantity * unit_amount < 0 then -discount_amount else discount_amount end) + tax_amount" : "discount_amount <= round(quantity * unit_amount, 2) and line_amount = round(quantity * unit_amount, 2) - discount_amount + tax_amount"
    },
    {
      name: `${prefix}_dimension_refs_shape_check`,
      sql: "jsonb_typeof(dimension_refs) = 'array'"
    }
  ];
  const lineColumns = (): readonly PostgresColumnManifest[] => [
    integer("line_number"),
    text("account_id"),
    text("item_id", true),
    text("description", true),
    numeric("quantity"),
    numeric("unit_amount"),
    numeric("unit_cost", true),
    numeric("discount_amount"),
    text("tax_code", true),
    numeric("tax_amount"),
    date("service_period_start", true),
    date("service_period_end", true),
    jsonb("dimension_refs", 4096, false),
    numeric("line_amount")
  ];
  return [
    table(
      "invoice_draft_lines",
      "Commercial invoice detail retained while an invoice is editable.",
      [
        id("invoice_draft_line_id"),
        text("tenant_id"),
        text("company_id"),
        text("book_id"),
        text("source_id"),
        text("invoice_draft_id"),
        ...lineColumns()
      ],
      [
        ...amountConstraints("invoice_draft_lines"),
        {
          name: "invoice_draft_lines_unit_cost_check",
          sql: "unit_cost is null or (unit_cost >= 0 and scale(unit_cost) <= 6)"
        },
        {
          name: "invoice_draft_lines_service_period_check",
          sql: "service_period_start is null or service_period_end is null or service_period_start <= service_period_end"
        },
        foreignKey(
          "invoice_draft_lines_draft_scope_fk",
          ["tenant_id", "company_id", "book_id", "source_id", "invoice_draft_id"],
          "invoice_drafts",
          ["tenant_id", "company_id", "book_id", "source_id", "invoice_draft_id"]
        ),
        foreignKey(
          "invoice_draft_lines_account_scope_fk",
          ["tenant_id", "source_id", "account_id"],
          "accounts",
          ["tenant_id", "source_id", "account_id"]
        ),
        foreignKey(
          "invoice_draft_lines_item_scope_fk",
          ["tenant_id", "source_id", "item_id"],
          "items",
          ["tenant_id", "source_id", "item_id"]
        )
      ],
      [
        {
          name: "invoice_draft_lines_order_uidx",
          columns: ["tenant_id", "company_id", "book_id", "invoice_draft_id", "line_number"],
          unique: true
        }
      ]
    ),
    table(
      "subledger_document_lines",
      "Immutable commercial detail for posted invoices and other native subledger documents.",
      [
        id("subledger_document_line_id"),
        text("tenant_id"),
        text("company_id"),
        text("source_id"),
        text("subledger_document_id"),
        ...lineColumns(),
        text("customer_party_id", true)
      ],
      [
        ...amountConstraints("subledger_document_lines"),
        {
          name: "subledger_document_lines_unit_cost_check",
          sql: "unit_cost is null or (unit_cost >= 0 and scale(unit_cost) <= 6)"
        },
        foreignKey(
          "subledger_document_lines_document_scope_fk",
          ["tenant_id", "company_id", "source_id", "subledger_document_id"],
          "subledger_documents",
          ["tenant_id", "company_id", "source_id", "subledger_document_id"]
        ),
        foreignKey(
          "subledger_document_lines_account_scope_fk",
          ["tenant_id", "source_id", "account_id"],
          "accounts",
          ["tenant_id", "source_id", "account_id"]
        ),
        foreignKey(
          "subledger_document_lines_item_scope_fk",
          ["tenant_id", "source_id", "item_id"],
          "items",
          ["tenant_id", "source_id", "item_id"]
        ),
        foreignKey(
          "subledger_document_lines_customer_party_scope_fk",
          ["tenant_id", "source_id", "customer_party_id"],
          "parties",
          ["tenant_id", "source_id", "party_id"]
        )
      ],
      [
        {
          name: "subledger_document_lines_order_uidx",
          columns: ["tenant_id", "company_id", "source_id", "subledger_document_id", "line_number"],
          unique: true
        }
      ]
    ),
    table(
      "subledger_document_delivery_events",
      "Append-only sent, delivered, and failed delivery evidence for posted subledger documents.",
      [
        id("delivery_event_id"),
        text("tenant_id"),
        text("company_id"),
        text("source_id"),
        text("subledger_document_id"),
        text("delivery_status"),
        text("channel"),
        text("recipient_ref", true),
        text("lifecycle_event_id"),
        timestamp("occurred_at")
      ],
      [
        {
          name: "subledger_document_delivery_events_status_check",
          sql: "delivery_status in ('sent', 'delivered', 'failed')"
        },
        foreignKey(
          "subledger_document_delivery_events_document_scope_fk",
          ["tenant_id", "company_id", "source_id", "subledger_document_id"],
          "subledger_documents",
          ["tenant_id", "company_id", "source_id", "subledger_document_id"]
        ),
        foreignKey(
          "subledger_document_delivery_events_event_scope_fk",
          ["tenant_id", "company_id", "source_id", "lifecycle_event_id"],
          "financial_lifecycle_events",
          ["tenant_id", "company_id", "source_id", "event_id"]
        )
      ],
      [
        {
          name: "subledger_document_delivery_events_scope_uidx",
          columns: ["tenant_id", "company_id", "source_id", "delivery_event_id"],
          unique: true
        },
        {
          name: "subledger_document_delivery_events_document_idx",
          columns: ["tenant_id", "company_id", "source_id", "subledger_document_id", "occurred_at"]
        }
      ]
    ),
    table(
      "invoice_voids",
      "Immutable links proving that an open invoice was fully offset by an SDK credit and atomic application.",
      [
        id("invoice_void_id"),
        text("tenant_id"),
        text("company_id"),
        text("book_id"),
        text("source_id"),
        text("invoice_document_id"),
        text("credit_document_id"),
        text("application_id"),
        text("idempotency_key"),
        text("lifecycle_event_id"),
        timestamp("created_at")
      ],
      [
        foreignKey(
          "invoice_voids_book_scope_fk",
          ["tenant_id", "company_id", "book_id"],
          "reporting_books",
          ["tenant_id", "company_id", "book_id"]
        ),
        foreignKey(
          "invoice_voids_book_source_scope_fk",
          ["tenant_id", "company_id", "book_id", "source_id"],
          "reporting_book_sources",
          ["tenant_id", "company_id", "book_id", "source_id"]
        ),
        foreignKey(
          "invoice_voids_invoice_scope_fk",
          ["tenant_id", "company_id", "source_id", "invoice_document_id"],
          "subledger_documents",
          ["tenant_id", "company_id", "source_id", "subledger_document_id"]
        ),
        foreignKey(
          "invoice_voids_credit_scope_fk",
          ["tenant_id", "company_id", "source_id", "credit_document_id"],
          "subledger_documents",
          ["tenant_id", "company_id", "source_id", "subledger_document_id"]
        ),
        foreignKey(
          "invoice_voids_application_scope_fk",
          ["tenant_id", "company_id", "source_id", "application_id"],
          "subledger_applications",
          ["tenant_id", "company_id", "source_id", "subledger_application_id"]
        ),
        foreignKey(
          "invoice_voids_event_scope_fk",
          ["tenant_id", "company_id", "source_id", "lifecycle_event_id"],
          "financial_lifecycle_events",
          ["tenant_id", "company_id", "source_id", "event_id"]
        )
      ],
      [
        {
          name: "invoice_voids_invoice_uidx",
          columns: ["tenant_id", "company_id", "book_id", "invoice_document_id"],
          unique: true
        },
        {
          name: "invoice_voids_idempotency_uidx",
          columns: ["tenant_id", "company_id", "book_id", "idempotency_key"],
          unique: true
        }
      ]
    )
  ];
}

function sdkV1BankTables(): readonly PostgresTableManifest[] {
  return [
    table(
      "bank_statement_lines",
      "Idempotent bank-feed lines with explicit review state and safe provider provenance.",
      [
        id("bank_statement_line_id"),
        text("tenant_id"),
        text("company_id"),
        text("book_id"),
        text("source_id"),
        text("bank_account_id"),
        text("external_line_id"),
        date("posted_date"),
        numeric("amount"),
        text("currency_code"),
        text("description", true),
        text("reference", true),
        text("status"),
        integer("version"),
        jsonb("source_payload_ref", 4096, true),
        timestamp("created_at"),
        timestamp("updated_at")
      ],
      [
        { name: "bank_statement_lines_amount_check", sql: "amount <> 0 and scale(amount) <= 2" },
        { name: "bank_statement_lines_status_check", sql: "status in ('unmatched', 'matched', 'ignored')" },
        { name: "bank_statement_lines_version_check", sql: "version >= 1" },
        {
          name: "bank_statement_lines_source_payload_ref_shape_check",
          sql: "source_payload_ref is null or jsonb_typeof(source_payload_ref) = 'object'"
        },
        { name: "bank_statement_lines_timestamp_check", sql: "updated_at >= created_at" },
        foreignKey(
          "bank_statement_lines_book_scope_fk",
          ["tenant_id", "company_id", "book_id"],
          "reporting_books",
          ["tenant_id", "company_id", "book_id"]
        ),
        foreignKey(
          "bank_statement_lines_book_source_scope_fk",
          ["tenant_id", "company_id", "book_id", "source_id"],
          "reporting_book_sources",
          ["tenant_id", "company_id", "book_id", "source_id"]
        ),
        foreignKey(
          "bank_statement_lines_bank_account_scope_fk",
          ["tenant_id", "source_id", "bank_account_id"],
          "accounts",
          ["tenant_id", "source_id", "account_id"]
        )
      ],
      [
        {
          name: "bank_statement_lines_external_uidx",
          columns: ["tenant_id", "company_id", "book_id", "external_line_id"],
          unique: true
        },
        {
          name: "bank_statement_lines_scope_uidx",
          columns: ["tenant_id", "company_id", "book_id", "bank_statement_line_id"],
          unique: true
        },
        {
          name: "bank_statement_lines_source_scope_uidx",
          columns: ["tenant_id", "company_id", "book_id", "source_id", "bank_statement_line_id"],
          unique: true
        },
        {
          name: "bank_statement_lines_review_idx",
          columns: ["tenant_id", "company_id", "book_id", "status", "posted_date"]
        }
      ]
    ),
    table(
      "bank_reconciliation_matches",
      "Versioned manual or automatic matches from bank lines to canonical transactions.",
      [
        id("bank_reconciliation_match_id"),
        text("tenant_id"),
        text("company_id"),
        text("book_id"),
        text("source_id"),
        text("bank_statement_line_id"),
        text("transaction_id"),
        numeric("matched_amount"),
        text("method"),
        text("status"),
        integer("version"),
        text("idempotency_key"),
        text("lifecycle_event_id"),
        timestamp("created_at"),
        timestamp("updated_at")
      ],
      [
        { name: "bank_reconciliation_matches_amount_check", sql: "matched_amount > 0" },
        { name: "bank_reconciliation_matches_method_check", sql: "method in ('automatic', 'manual')" },
        { name: "bank_reconciliation_matches_status_check", sql: "status in ('matched', 'unmatched', 'voided')" },
        { name: "bank_reconciliation_matches_version_check", sql: "version >= 1" },
        { name: "bank_reconciliation_matches_timestamp_check", sql: "updated_at >= created_at" },
        foreignKey(
          "bank_reconciliation_matches_book_scope_fk",
          ["tenant_id", "company_id", "book_id"],
          "reporting_books",
          ["tenant_id", "company_id", "book_id"]
        ),
        foreignKey(
          "bank_reconciliation_matches_book_source_scope_fk",
          ["tenant_id", "company_id", "book_id", "source_id"],
          "reporting_book_sources",
          ["tenant_id", "company_id", "book_id", "source_id"]
        ),
        foreignKey(
          "bank_reconciliation_matches_line_scope_fk",
          ["tenant_id", "company_id", "book_id", "source_id", "bank_statement_line_id"],
          "bank_statement_lines",
          ["tenant_id", "company_id", "book_id", "source_id", "bank_statement_line_id"]
        ),
        foreignKey(
          "bank_reconciliation_matches_transaction_scope_fk",
          ["tenant_id", "source_id", "transaction_id"],
          "transactions",
          ["tenant_id", "source_id", "transaction_id"]
        ),
        foreignKey(
          "bank_reconciliation_matches_event_scope_fk",
          ["tenant_id", "company_id", "source_id", "lifecycle_event_id"],
          "financial_lifecycle_events",
          ["tenant_id", "company_id", "source_id", "event_id"]
        )
      ],
      [
        {
          name: "bank_reconciliation_matches_idempotency_uidx",
          columns: ["tenant_id", "company_id", "book_id", "idempotency_key"],
          unique: true
        },
        {
          name: "bank_reconciliation_matches_active_line_uidx",
          columns: ["tenant_id", "company_id", "book_id", "bank_statement_line_id"],
          unique: true,
          whereSql: `"status" = 'matched'::text`
        },
        {
          name: "bank_reconciliation_matches_active_transaction_uidx",
          columns: ["tenant_id", "source_id", "transaction_id"],
          unique: true,
          whereSql: `"status" = 'matched'::text`
        },
        {
          name: "bank_reconciliation_matches_transaction_idx",
          columns: ["tenant_id", "source_id", "transaction_id", "status"]
        }
      ]
    )
  ];
}

export const DISALLOWED_CREDENTIAL_COLUMN_PATTERNS: readonly RegExp[] = [
  /token/i,
  /secret/i,
  /password/i,
  /credential/i,
  /private[-_]?key/i,
  /raw[-_]?provider[-_]?payload/i,
  /raw[-_]?payload/i,
  /provider[-_]?payload[-_]?archive/i,
  /payload[-_]?archive/i,
  /raw[-_]?archive/i
];

export function renderPostgresSchemaSql(
  manifest: PostgresSchemaManifest = POSTGRES_CANONICAL_SCHEMA_MANIFEST
): string {
  const statements = [
    `create schema if not exists ${quoteIdentifier(manifest.namespace)};`,
    ...manifest.tables.flatMap((tableManifest) => renderTableSql(manifest.namespace, tableManifest))
  ];

  return `${statements.join("\n\n")}\n`;
}

export function assertManifestHasNoCredentialColumns(
  manifest: PostgresSchemaManifest = POSTGRES_CANONICAL_SCHEMA_MANIFEST
): void {
  for (const tableManifest of manifest.tables) {
    for (const column of tableManifest.columns) {
      if (DISALLOWED_CREDENTIAL_COLUMN_PATTERNS.some((pattern) => pattern.test(column.name))) {
        throw new Error(`credential-like column is not allowed: ${tableManifest.name}.${column.name}`);
      }
    }
  }
}

function renderTableSql(namespace: string, tableManifest: PostgresTableManifest): readonly string[] {
  const qualifiedTableName = `${quoteIdentifier(namespace)}.${quoteIdentifier(tableManifest.name)}`;
  const columnDefinitions = tableManifest.columns.map((column) => renderColumnSql(column));
  const primaryKeyColumns = tableManifest.columns
    .filter((column) => column.primaryKey === true)
    .map((column) => column.name);
  const primaryKeyDefinition =
    primaryKeyColumns.length > 0
      ? [`constraint ${quoteIdentifier(`${tableManifest.name}_pkey`)} primary key (${primaryKeyColumns.map(quoteIdentifier).join(", ")})`]
      : [];
  const checkDefinitions = [
    ...tableManifest.constraints.map(
      (constraint) =>
        `constraint ${quoteIdentifier(constraint.name)} ${constraint.kind === "foreign_key" ? constraint.sql : `check (${constraint.sql})`}`
    ),
    ...tableManifest.columns
      .filter((column) => column.type === "jsonb" && column.maxBytes !== undefined)
      .map(
        (column) =>
          `constraint ${quoteIdentifier(`${tableManifest.name}_${column.name}_bounded_json_check`)} check (octet_length(coalesce(${quoteIdentifier(
            column.name
          )}::text, '')) <= ${String(column.maxBytes)})`
      )
  ];
  const createTableSql = `create table if not exists ${qualifiedTableName} (\n  ${[
    ...columnDefinitions,
    ...primaryKeyDefinition,
    ...checkDefinitions
  ].join(",\n  ")}\n);`;

  return [
    createTableSql,
    ...tableManifest.indexes.map((index) => {
      const uniqueSql = index.unique === true ? "unique " : "";
      const whereSql = index.whereSql === undefined ? "" : ` where ${index.whereSql}`;
      return `create ${uniqueSql}index if not exists ${quoteIdentifier(index.name)} on ${qualifiedTableName} (${index.columns
        .map(quoteIdentifier)
        .join(", ")})${whereSql};`;
    })
  ];
}

function renderColumnSql(column: PostgresColumnManifest): string {
  const nullSql = column.primaryKey === true || column.nullable !== true ? " not null" : "";
  const defaultSql = column.defaultSql === undefined ? "" : ` default ${column.defaultSql}`;
  return `${quoteIdentifier(column.name)} ${column.type}${defaultSql}${nullSql}`;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
