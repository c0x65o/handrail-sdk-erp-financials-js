-- No data rewrite. A vendor obligation may already be overdue on recognition.
-- Preserve all other document types' date constraint. Run only via approved migrations.
alter table "erp_financials"."subledger_documents"
  drop constraint "subledger_documents_due_date_check",
  add constraint "subledger_documents_due_date_check"
    check ("due_date" is null or "document_type" = 'vendor_bill' or "due_date" >= "document_date");
