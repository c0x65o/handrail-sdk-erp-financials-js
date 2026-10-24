-- Immutable host correlation on native receipts; no financial amount is copied.
create index "subledger_documents_collection_ref_idx" on "erp_financials"."subledger_documents"
 ("tenant_id","company_id","source_id","party_id", ("metadata"->>'collectionRef'))
 where "document_type"='customer_payment';

create function "erp_financials"."guard_receipt_collection_ref"() returns trigger language plpgsql as $$
begin
 if tg_op='UPDATE' and (new.metadata->'collectionRef') is distinct from (old.metadata->'collectionRef') then
  raise exception 'Receipt collection identity is immutable' using errcode='23514';
 end if;
 if new.document_type='customer_payment' and new.metadata ? 'collectionRef' and
  (jsonb_typeof(new.metadata->'collectionRef')<>'string' or length(btrim(new.metadata->>'collectionRef'))=0 or length(new.metadata->>'collectionRef')>512) then
  raise exception 'Receipt collection identity must contain 1-512 characters' using errcode='23514';
 end if;
 return new;
end;
$$;
create trigger "receipt_collection_ref_guard" before insert or update on "erp_financials"."subledger_documents"
 for each row execute function "erp_financials"."guard_receipt_collection_ref"();
