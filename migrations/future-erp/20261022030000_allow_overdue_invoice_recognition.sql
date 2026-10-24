-- Preserve contractual invoice terms when recognition/correction posts later.
-- No dates or financial facts are rewritten. Other document types retain their guard.
-- Execute transactionally through the approved migration runner. Both ALTERs take
-- table locks; rehearse lock duration against the target's volume before cutover.
alter table "erp_financials"."subledger_documents"
  drop constraint "subledger_documents_due_date_check",
  add constraint "subledger_documents_due_date_check"
    check ("due_date" is null or "document_type" in ('vendor_bill', 'invoice') or "due_date" >= "document_date");
alter table "erp_financials"."invoice_drafts"
  drop constraint "invoice_drafts_due_date_check";
