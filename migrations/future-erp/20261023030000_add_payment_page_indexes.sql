-- Additive indexes; no financial fact or lifecycle update. Transactional migration
-- requires a maintenance window for index construction on an existing large store.
create index "subledger_documents_payment_page_idx" on "erp_financials"."subledger_documents"
 ("tenant_id", "company_id", "currency_code", "document_date" desc, "subledger_document_id" desc)
 where "document_type" in ('customer_payment', 'bill_payment');
create index "bill_payment_disbursements_page_idx" on "erp_financials"."bill_payment_disbursements"
 ("tenant_id", "company_id", "currency_code", "payment_date" desc, "bill_payment_id" desc);
