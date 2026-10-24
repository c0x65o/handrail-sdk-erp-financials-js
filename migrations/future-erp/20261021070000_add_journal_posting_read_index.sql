-- Additive index only: bounded journal detail must not scan all source postings.
-- Normal transactional migration; schedule the build during the approved cutover.
create index "ledger_postings_transaction_read_idx"
  on "erp_financials"."ledger_postings" (
    "tenant_id", "source_id", "transaction_id", "accounting_basis", "currency_code", "posting_date", "posting_id"
  );
