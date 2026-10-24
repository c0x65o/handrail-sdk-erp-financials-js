import type { PostgresTableManifest } from "./schema-manifest.js";

export const BANK_STATEMENT_TABLES: readonly PostgresTableManifest[] = [
  {
    "name": "bank_statements",
    "policies": {
      "tenantScoped": true,
      "sourceScoped": true,
      "noRawCredentials": true,
      "boundedJson": true
    },
    "description": "SDK-owned manual bank statement lifecycle; balances and clearance evidence are canonical, never host projections.",
    "columns": [
      {
        "name": "statement_id",
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
        "name": "book_id",
        "type": "text"
      },
      {
        "name": "source_id",
        "type": "text"
      },
      {
        "name": "account_id",
        "type": "text"
      },
      {
        "name": "external_statement_id",
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
        "name": "statement_date",
        "type": "date"
      },
      {
        "name": "closing_balance",
        "type": "numeric"
      },
      {
        "name": "opening_balance",
        "type": "numeric"
      },
      {
        "name": "previous_statement_id",
        "type": "text",
        "nullable": true
      },
      {
        "name": "status",
        "type": "text"
      },
      {
        "name": "version",
        "type": "integer"
      },
      {
        "name": "prepared_by",
        "type": "text"
      },
      {
        "name": "completed_by",
        "type": "text",
        "nullable": true
      },
      {
        "name": "lifecycle_event_id",
        "type": "text",
        "nullable": true
      },
      {
        "name": "created_at",
        "type": "timestamptz"
      },
      {
        "name": "updated_at",
        "type": "timestamptz"
      }
    ],
    "constraints": [
      {
        "name": "bank_statements_money_check",
        "sql": "closing_balance::text not in ('NaN','Infinity','-Infinity') and scale(closing_balance)<=2 and opening_balance::text not in ('NaN','Infinity','-Infinity') and scale(opening_balance)<=2"
      },
      {
        "name": "bank_statements_status_check",
        "sql": "status in ('draft','completed','cancelled') and ((status in ('draft','cancelled') and completed_by is null) or (status='completed' and completed_by is not null and completed_by<>prepared_by))"
      },
      {
        "name": "bank_statements_version_check",
        "sql": "version>=1"
      },
      {
        "name": "bank_statements_basis_check",
        "sql": "accounting_basis in ('accrual','cash','modified_cash')"
      },
      {
        "name": "bank_statements_book_source_fk",
        "kind": "foreign_key",
        "sql": "foreign key (\"tenant_id\", \"company_id\", \"book_id\", \"source_id\") references \"erp_financials\".\"reporting_book_sources\" (\"tenant_id\", \"company_id\", \"book_id\", \"source_id\") on update restrict on delete restrict"
      },
      {
        "name": "bank_statements_account_fk",
        "kind": "foreign_key",
        "sql": "foreign key (\"tenant_id\", \"source_id\", \"account_id\") references \"erp_financials\".\"accounts\" (\"tenant_id\", \"source_id\", \"account_id\") on update restrict on delete restrict"
      },
      {
        "name": "bank_statements_event_fk",
        "kind": "foreign_key",
        "sql": "foreign key (\"tenant_id\", \"company_id\", \"source_id\", \"lifecycle_event_id\") references \"erp_financials\".\"financial_lifecycle_events\" (\"tenant_id\", \"company_id\", \"source_id\", \"event_id\") on update restrict on delete restrict"
      }
    ],
    "indexes": [
      {
        "name": "bank_statements_scope_uidx",
        "columns": [
          "tenant_id",
          "company_id",
          "book_id",
          "source_id",
          "statement_id"
        ],
        "unique": true
      },
      {
        "name": "bank_statements_external_uidx",
        "columns": [
          "tenant_id",
          "company_id",
          "book_id",
          "source_id",
          "external_statement_id"
        ],
        "unique": true
      },
      {
        "name": "bank_statements_draft_uidx",
        "columns": [
          "tenant_id",
          "company_id",
          "book_id",
          "source_id",
          "account_id"
        ],
        "unique": true,
        "whereSql": "\"status\" = 'draft'::text"
      },
      {
        "name": "bank_statements_account_date_idx",
        "columns": [
          "tenant_id",
          "company_id",
          "book_id",
          "source_id",
          "account_id",
          "statement_date",
          "statement_id"
        ]
      }
    ]
  },
  {
    "name": "bank_statement_clearings",
    "policies": {
      "tenantScoped": true,
      "sourceScoped": true,
      "noRawCredentials": true,
      "boundedJson": true
    },
    "description": "Canonical posting selections for an SDK manual bank statement; completed selections cannot change.",
    "columns": [
      {
        "name": "clearing_id",
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
        "name": "book_id",
        "type": "text"
      },
      {
        "name": "source_id",
        "type": "text"
      },
      {
        "name": "statement_id",
        "type": "text"
      },
      {
        "name": "posting_id",
        "type": "text"
      },
      {
        "name": "transaction_id",
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
        "name": "posting_date",
        "type": "date"
      },
      {
        "name": "amount",
        "type": "numeric"
      }
    ],
    "constraints": [
      {
        "name": "bank_statement_clearings_money_check",
        "sql": "amount<>0 and amount::text not in ('NaN','Infinity','-Infinity') and scale(amount)<=2"
      },
      {
        "name": "bank_statement_clearings_statement_fk",
        "kind": "foreign_key",
        "sql": "foreign key (\"tenant_id\", \"company_id\", \"book_id\", \"source_id\", \"statement_id\") references \"erp_financials\".\"bank_statements\" (\"tenant_id\", \"company_id\", \"book_id\", \"source_id\", \"statement_id\") on update restrict on delete restrict"
      },
      {
        "name": "bank_statement_clearings_posting_fk",
        "kind": "foreign_key",
        "sql": "foreign key (\"posting_id\") references \"erp_financials\".\"ledger_postings\" (\"posting_id\") on update restrict on delete restrict"
      }
    ],
    "indexes": [
      {
        "name": "bank_statement_clearings_posting_uidx",
        "columns": [
          "tenant_id",
          "source_id",
          "book_id",
          "posting_id"
        ],
        "unique": true
      },
      {
        "name": "bank_statement_clearings_statement_idx",
        "columns": [
          "tenant_id",
          "company_id",
          "book_id",
          "source_id",
          "statement_id",
          "posting_date",
          "posting_id"
        ]
      },
      {
        "name": "bank_statement_clearings_transaction_idx",
        "columns": [
          "tenant_id",
          "source_id",
          "transaction_id"
        ]
      }
    ]
  },
  {
    "name": "bank_statement_clearing_history",
    "description": "Immutable exact posting evidence for every statement selection change, including removed selections after reopening.",
    "policies": {
      "tenantScoped": true,
      "sourceScoped": true,
      "noRawCredentials": true,
      "boundedJson": true
    },
    "columns": [
      {
        "name": "history_id",
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
        "name": "book_id",
        "type": "text"
      },
      {
        "name": "source_id",
        "type": "text"
      },
      {
        "name": "statement_id",
        "type": "text"
      },
      {
        "name": "posting_id",
        "type": "text"
      },
      {
        "name": "transaction_id",
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
        "name": "posting_date",
        "type": "date"
      },
      {
        "name": "amount",
        "type": "numeric"
      },
      {
        "name": "statement_version",
        "type": "integer"
      },
      {
        "name": "action",
        "type": "text"
      },
      {
        "name": "lifecycle_event_id",
        "type": "text"
      }
    ],
    "constraints": [
      {
        "name": "bank_statement_clearing_history_action_check",
        "sql": "action in ('added','removed') and statement_version>=1"
      },
      {
        "name": "bank_statement_clearing_history_money_check",
        "sql": "amount<>0 and amount::text not in ('NaN','Infinity','-Infinity') and scale(amount)<=2"
      },
      {
        "name": "bank_statement_clearing_history_statement_fk",
        "kind": "foreign_key",
        "sql": "foreign key (\"tenant_id\", \"company_id\", \"book_id\", \"source_id\", \"statement_id\") references \"erp_financials\".\"bank_statements\" (\"tenant_id\", \"company_id\", \"book_id\", \"source_id\", \"statement_id\") on update restrict on delete restrict"
      },
      {
        "name": "bank_statement_clearing_history_event_fk",
        "kind": "foreign_key",
        "sql": "foreign key (\"tenant_id\", \"company_id\", \"source_id\", \"lifecycle_event_id\") references \"erp_financials\".\"financial_lifecycle_events\" (\"tenant_id\", \"company_id\", \"source_id\", \"event_id\") on update restrict on delete restrict"
      }
    ],
    "indexes": [
      {
        "name": "bank_statement_clearing_history_page_idx",
        "columns": [
          "tenant_id",
          "company_id",
          "book_id",
          "source_id",
          "statement_id",
          "statement_version",
          "history_id"
        ]
      },
      {
        "name": "bank_statement_clearing_history_event_uidx",
        "columns": [
          "lifecycle_event_id",
          "posting_id",
          "action"
        ],
        "unique": true
      }
    ]
  }
];
