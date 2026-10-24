-- Read access paths only. No ledger, audit or legacy data is rewritten.
create index "invoice_drafts_issued_lookup_idx" on "erp_financials"."invoice_drafts"
  ("tenant_id","company_id","source_id","issued_document_id");
create index "financial_lifecycle_events_recorded_page_idx" on "erp_financials"."financial_lifecycle_events"
  ("tenant_id","company_id","source_id","aggregate_type","aggregate_id","recorded_at","event_id");
