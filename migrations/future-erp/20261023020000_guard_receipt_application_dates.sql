-- Protect new allocations without rewriting historical financial facts.
-- Existing violations must be reconciled explicitly during migration review.
create function "erp_financials"."guard_receipt_application_date"()
returns trigger language plpgsql as $receipt_date$
declare received date;
begin
 select document_date into received
 from erp_financials.subledger_documents
 where tenant_id=new.tenant_id and company_id=new.company_id and source_id=new.source_id
  and subledger_document_id=new.source_document_id and document_type='customer_payment' for share;
 if found and new.application_date<received then
  raise exception 'application cannot precede cash receipt';
 end if;
 return new;
end;
$receipt_date$;
create trigger "receipt_application_date_guard" before insert on "erp_financials"."subledger_applications"
for each row execute function "erp_financials"."guard_receipt_application_date"();

-- Supports bounded selection without collecting a growing receipt history.
create index "subledger_documents_unapplied_collection_page_idx" on "erp_financials"."subledger_documents"
 ("tenant_id","company_id","source_id","party_id", ("metadata"->>'collectionRef'), "document_date" desc, "subledger_document_id" desc)
 where "document_type"='customer_payment' and "status" not in ('voided','replaced') and "open_amount">0;
