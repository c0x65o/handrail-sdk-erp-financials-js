-- Full-sync cleanup finds transactions without a subledger document by
-- (tenant, source, transaction). The existing index leads with company_id, so
-- each lookup scanned every document for the tenant. Only add its access path.
create index subledger_documents_source_transaction_idx
on erp_financials.subledger_documents (tenant_id, source_id, transaction_id);
