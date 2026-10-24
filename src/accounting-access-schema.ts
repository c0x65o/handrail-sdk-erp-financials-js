import type {PostgresTableManifest} from './schema-manifest.js';
export const ACCOUNTING_ACCESS_GUARDED_TABLES=[
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
  "bank_reconciliation_matches",
  "bank_statements",
  "bank_statement_clearings",
  "bank_statement_clearing_history",
  "fiscal_close_certificates",
  "fiscal_close_totals",
  "fiscal_close_banks",
  "cash_flow_purpose_corrections",
  "accounting_source_revisions",
  "imported_customer_payment_evidence",
  "customer_payment_corrections"
] as const;
export const ACCOUNTING_ACCESS_TABLES:readonly PostgresTableManifest[]=[
  {
    "name": "accounting_access_control",
    "description": "Database-wide durable accounting maintenance state; not financial balances.",
    "columns": [
      {
        "name": "control_id",
        "type": "text",
        "primaryKey": true
      },
      {
        "name": "revision",
        "type": "integer",
        "defaultSql": "0"
      },
      {
        "name": "active_session_id",
        "type": "text",
        "nullable": true
      }
    ],
    "constraints": [
      {
        "name": "accounting_access_control_singleton_check",
        "sql": "control_id='database'"
      },
      {
        "name": "accounting_access_control_revision_check",
        "sql": "revision>=0"
      }
    ],
    "indexes": [],
    "policies": {
      "tenantScoped": false,
      "sourceScoped": false,
      "noRawCredentials": true,
      "boundedJson": false
    }
  },
  {
    "name": "accounting_access_commands",
    "description": "Immutable maintenance operation receipts; host owns operator authorization.",
    "columns": [
      {
        "name": "command_key",
        "type": "text",
        "primaryKey": true
      },
      {
        "name": "request_digest",
        "type": "text"
      },
      {
        "name": "revision",
        "type": "integer"
      },
      {
        "name": "active_session_id",
        "type": "text",
        "nullable": true
      },
      {
        "name": "actor_ref",
        "type": "text"
      },
      {
        "name": "operation",
        "type": "jsonb",
        "maxBytes": 8192
      },
      {
        "name": "recorded_at",
        "type": "timestamptz",
        "defaultSql": "now()"
      }
    ],
    "constraints": [
      {
        "name": "accounting_access_commands_revision_check",
        "sql": "revision>0"
      },
      {
        "name": "accounting_access_commands_digest_check",
        "sql": "request_digest ~ '^[a-f0-9]{64}$'"
      }
    ],
    "indexes": [
      {
        "name": "accounting_access_commands_revision_unique",
        "columns": [
          "revision"
        ],
        "unique": true
      }
    ],
    "policies": {
      "tenantScoped": false,
      "sourceScoped": false,
      "noRawCredentials": true,
      "boundedJson": true
    }
  }
];
