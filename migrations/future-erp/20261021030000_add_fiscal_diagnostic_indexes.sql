-- No accounting facts change. Support exact period diagnostics without scanning
-- all posted transactions to find drafts or hashing all posting groups in RAM.
create index "transactions_fiscal_drafts_idx"
  on "erp_financials"."transactions" ("tenant_id", "source_id", "transaction_date")
  where "status" = 'draft';
create index "ledger_postings_fiscal_groups_idx"
  on "erp_financials"."ledger_postings" (
    "tenant_id", "source_id", "posting_date", "transaction_id", "accounting_basis",
    "currency_code", "debit_amount", "credit_amount"
  );
