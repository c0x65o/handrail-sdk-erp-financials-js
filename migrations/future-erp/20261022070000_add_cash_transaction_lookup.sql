-- Nonunique lookup: ambiguity remains a report error, never silently deduplicated.
-- Run through the normal transactional migration pipeline during the bounded
-- cutover window. Index construction takes a write-blocking table lock.
create index "subledger_documents_transaction_idx" on "erp_financials"."subledger_documents"
  ("tenant_id", "company_id", "source_id", "transaction_id", "document_type");
