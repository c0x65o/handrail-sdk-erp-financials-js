import type { PostgresTableManifest } from "./schema-manifest.js";

export const FISCAL_CLOSE_CERTIFICATE_TABLES: readonly PostgresTableManifest[] = [
  {
    "name": "fiscal_close_certificates",
    "description": "Immutable native fiscal close receipt and canonical diagnostic snapshot.",
    "policies": {
      "tenantScoped": true,
      "sourceScoped": true,
      "noRawCredentials": true,
      "boundedJson": true
    },
    "columns": [
      {
        "name": "certificate_id",
        "type": "text",
        "primaryKey": true
      },
      {
        "name": "tenant_id",
        "type": "text"
      },
      {
        "name": "company_id",
        "type": "text"
      },
      {
        "name": "source_id",
        "type": "text"
      },
      {
        "name": "book_id",
        "type": "text"
      },
      {
        "name": "accounting_basis",
        "type": "text"
      },
      {
        "name": "currency_code",
        "type": "text"
      },
      {
        "name": "fiscal_period_id",
        "type": "text"
      },
      {
        "name": "idempotency_key",
        "type": "text"
      },
      {
        "name": "command_checksum",
        "type": "text"
      },
      {
        "name": "expected_version",
        "type": "integer"
      },
      {
        "name": "bank_count",
        "type": "integer"
      },
      {
        "name": "captured_at",
        "type": "timestamptz"
      },
      {
        "name": "creation_txid",
        "type": "text"
      },
      {
        "name": "close_event_id",
        "type": "text"
      },
      {
        "name": "diagnostics",
        "type": "jsonb",
        "maxBytes": 8192
      },
      {
        "name": "result",
        "type": "jsonb",
        "maxBytes": 8192
      }
    ],
    "constraints": [
      {
        "name": "fiscal_close_certificates_version_check",
        "sql": "expected_version >= 1 and bank_count between 0 and 200"
      },
      {
        "name": "fiscal_close_certificates_checksum_check",
        "sql": "command_checksum ~ '^[a-f0-9]{64}$'"
      },
      {
        "name": "fiscal_close_certificates_period_fk",
        "kind": "foreign_key",
        "sql": "foreign key (\"fiscal_period_id\") references \"erp_financials\".\"fiscal_periods\" (\"fiscal_period_id\") on update restrict on delete restrict"
      },
      {
        "name": "fiscal_close_certificates_event_fk",
        "kind": "foreign_key",
        "sql": "foreign key (\"close_event_id\") references \"erp_financials\".\"financial_lifecycle_events\" (\"event_id\") on update restrict on delete restrict"
      },
      {
        "name": "fiscal_close_certificates_book_scope_fk",
        "kind": "foreign_key",
        "sql": "foreign key (\"tenant_id\", \"company_id\", \"book_id\", \"source_id\") references \"erp_financials\".\"reporting_book_sources\" (\"tenant_id\", \"company_id\", \"book_id\", \"source_id\") on update restrict on delete restrict"
      }
    ],
    "indexes": [
      {
        "name": "fiscal_close_certificates_scope_uidx",
        "columns": [
          "tenant_id",
          "company_id",
          "source_id",
          "certificate_id"
        ],
        "unique": true
      },
      {
        "name": "fiscal_close_certificates_command_uidx",
        "columns": [
          "tenant_id",
          "company_id",
          "source_id",
          "idempotency_key"
        ],
        "unique": true
      }
    ]
  },
  {
    "name": "fiscal_close_totals",
    "description": "Immutable opening, period and closing account/basis/currency control totals; never a second posting ledger.",
    "policies": {
      "tenantScoped": true,
      "sourceScoped": true,
      "noRawCredentials": true,
      "boundedJson": false
    },
    "columns": [
      {
        "name": "total_id",
        "type": "text",
        "primaryKey": true
      },
      {
        "name": "tenant_id",
        "type": "text"
      },
      {
        "name": "company_id",
        "type": "text"
      },
      {
        "name": "source_id",
        "type": "text"
      },
      {
        "name": "certificate_id",
        "type": "text"
      },
      {
        "name": "account_id",
        "type": "text"
      },
      {
        "name": "accounting_basis",
        "type": "text"
      },
      {
        "name": "currency_code",
        "type": "text"
      },
      {
        "name": "opening_net",
        "type": "numeric"
      },
      {
        "name": "debit_amount",
        "type": "numeric"
      },
      {
        "name": "credit_amount",
        "type": "numeric"
      },
      {
        "name": "closing_net",
        "type": "numeric"
      },
      {
        "name": "posting_count",
        "type": "numeric"
      },
      {
        "name": "historical_posting_count",
        "type": "numeric"
      }
    ],
    "constraints": [
      {
        "name": "fiscal_close_totals_certificate_scope_fk",
        "kind": "foreign_key",
        "sql": "foreign key (\"tenant_id\", \"company_id\", \"source_id\", \"certificate_id\") references \"erp_financials\".\"fiscal_close_certificates\" (\"tenant_id\", \"company_id\", \"source_id\", \"certificate_id\") on update restrict on delete restrict"
      },
      {
        "name": "fiscal_close_totals_account_scope_fk",
        "kind": "foreign_key",
        "sql": "foreign key (\"tenant_id\", \"source_id\", \"account_id\") references \"erp_financials\".\"accounts\" (\"tenant_id\", \"source_id\", \"account_id\") on update restrict on delete restrict"
      },
      {
        "name": "fiscal_close_totals_amount_check",
        "sql": "debit_amount >= 0 and credit_amount >= 0 and closing_net = opening_net + debit_amount - credit_amount and opening_net::text not in ('NaN','Infinity','-Infinity') and closing_net::text not in ('NaN','Infinity','-Infinity') and debit_amount::text not in ('NaN','Infinity','-Infinity') and credit_amount::text not in ('NaN','Infinity','-Infinity')"
      },
      {
        "name": "fiscal_close_totals_count_check",
        "sql": "posting_count >= 0 and posting_count = trunc(posting_count) and historical_posting_count > 0 and historical_posting_count = trunc(historical_posting_count) and posting_count <= historical_posting_count and historical_posting_count::text not in ('NaN','Infinity','-Infinity')"
      }
    ],
    "indexes": [
      {
        "name": "fiscal_close_totals_page_uidx",
        "columns": [
          "tenant_id",
          "company_id",
          "source_id",
          "certificate_id",
          "account_id",
          "accounting_basis",
          "currency_code"
        ],
        "unique": true
      }
    ]
  },
  {
    "name": "fiscal_close_banks",
    "description": "Immutable configured-bank checks and completed statement lifecycle references for one close.",
    "policies": {
      "tenantScoped": true,
      "sourceScoped": true,
      "noRawCredentials": true,
      "boundedJson": false
    },
    "columns": [
      {
        "name": "bank_check_id",
        "type": "text",
        "primaryKey": true
      },
      {
        "name": "tenant_id",
        "type": "text"
      },
      {
        "name": "company_id",
        "type": "text"
      },
      {
        "name": "source_id",
        "type": "text"
      },
      {
        "name": "certificate_id",
        "type": "text"
      },
      {
        "name": "account_id",
        "type": "text"
      },
      {
        "name": "has_activity",
        "type": "boolean"
      },
      {
        "name": "statement_id",
        "type": "text",
        "nullable": true
      },
      {
        "name": "statement_version",
        "type": "integer",
        "nullable": true
      },
      {
        "name": "statement_event_id",
        "type": "text",
        "nullable": true
      }
    ],
    "constraints": [
      {
        "name": "fiscal_close_banks_certificate_scope_fk",
        "kind": "foreign_key",
        "sql": "foreign key (\"tenant_id\", \"company_id\", \"source_id\", \"certificate_id\") references \"erp_financials\".\"fiscal_close_certificates\" (\"tenant_id\", \"company_id\", \"source_id\", \"certificate_id\") on update restrict on delete restrict"
      },
      {
        "name": "fiscal_close_banks_account_scope_fk",
        "kind": "foreign_key",
        "sql": "foreign key (\"tenant_id\", \"source_id\", \"account_id\") references \"erp_financials\".\"accounts\" (\"tenant_id\", \"source_id\", \"account_id\") on update restrict on delete restrict"
      },
      {
        "name": "fiscal_close_banks_statement_fk",
        "kind": "foreign_key",
        "sql": "foreign key (\"statement_id\") references \"erp_financials\".\"bank_statements\" (\"statement_id\") on update restrict on delete restrict"
      },
      {
        "name": "fiscal_close_banks_event_fk",
        "kind": "foreign_key",
        "sql": "foreign key (\"statement_event_id\") references \"erp_financials\".\"financial_lifecycle_events\" (\"event_id\") on update restrict on delete restrict"
      },
      {
        "name": "fiscal_close_banks_shape_check",
        "sql": "(has_activity and statement_id is not null and statement_version > 0 and statement_event_id is not null) or (not has_activity and statement_id is null and statement_version is null and statement_event_id is null)"
      }
    ],
    "indexes": [
      {
        "name": "fiscal_close_banks_page_uidx",
        "columns": [
          "tenant_id",
          "company_id",
          "source_id",
          "certificate_id",
          "account_id"
        ],
        "unique": true
      }
    ]
  }
];
