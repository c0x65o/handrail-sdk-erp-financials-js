-- Schema only. No business-data changes. Corrections are permanent source tombstones.
create table "erp_financials"."imported_customer_payment_evidence" (
  "evidence_id" text primary key,
  "tenant_id" text not null, "company_id" text not null, "source_id" text not null,
  "payment_id" text not null, "source_version" text not null, "evidence" jsonb not null,
  constraint "imported_customer_payment_evidence_evidence_bounded_json_check" check (octet_length(coalesce("evidence"::text, '')) <= 65536),
  constraint imported_customer_payment_evidence_document_fk foreign key (tenant_id, company_id, source_id, payment_id)
    references erp_financials.subledger_documents (tenant_id, company_id, source_id, subledger_document_id) on update restrict on delete restrict
);
create unique index imported_customer_payment_evidence_scope_uidx
  on erp_financials.imported_customer_payment_evidence(tenant_id, company_id, source_id, payment_id);
create table "erp_financials"."customer_payment_corrections" (
  "correction_id" text primary key,
  "tenant_id" text not null, "company_id" text not null, "source_id" text not null,
  "payment_id" text not null, "source_version" text not null, "idempotency_key" text not null,
  "command_checksum" text not null, "result" jsonb not null, "lifecycle_event_id" text not null,
  constraint "customer_payment_corrections_result_bounded_json_check" check (octet_length(coalesce("result"::text, '')) <= 65536),
  constraint customer_payment_corrections_document_fk foreign key (tenant_id, company_id, source_id, payment_id)
    references erp_financials.subledger_documents (tenant_id, company_id, source_id, subledger_document_id) on update restrict on delete restrict,
  constraint customer_payment_corrections_event_fk foreign key (tenant_id, company_id, source_id, lifecycle_event_id)
    references erp_financials.financial_lifecycle_events(tenant_id, company_id, source_id, event_id) on update restrict on delete restrict
);
create unique index customer_payment_corrections_payment_uidx
  on erp_financials.customer_payment_corrections(tenant_id, company_id, source_id, payment_id);
create unique index customer_payment_corrections_key_uidx
  on erp_financials.customer_payment_corrections(tenant_id, company_id, source_id, idempotency_key);
create function erp_financials.reject_customer_payment_correction_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'customer payment correction tombstones are permanent';
end $$;
create trigger customer_payment_corrections_immutable before update or delete on erp_financials.customer_payment_corrections
  for each row execute function erp_financials.reject_customer_payment_correction_mutation();

-- All canonical writers share the correction lock, including consumers using
-- the storage adapter directly. Do not depend on a provider job's process lock.
create function erp_financials.guard_customer_payment_correction_source() returns trigger language plpgsql as $$
declare r jsonb; t text; s text; corrected boolean; provider_write boolean := false;
begin
  r := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  t := r->>'tenant_id'; s := r->>'source_id';
  perform pg_advisory_xact_lock(hashtextextended('payment-correction:' || t || ':' || s, 0));
  select exists(select 1 from erp_financials.customer_payment_corrections where tenant_id=t and source_id=s) into corrected;
  if not corrected then return case when tg_op='DELETE' then old else new end; end if;
  if coalesce(current_setting('erp_financials.quickbooks_projection_refresh',true),'off')='on' then
    raise exception 'customer_payment_corrected_source: provider replay requires explicit reconciliation; source is tombstoned';
  end if;
  if tg_table_name = 'transactions' then
    provider_write := (r->>'source_transaction_type') not like 'Native%' and (r->>'source_transaction_type') not like 'Subledger:%';
    -- Native journal source types used by the posting engine.
    provider_write := provider_write and (r->>'source_transaction_type') not in ('JournalEntry', 'JournalEntryAdjustment');
    if tg_op <> 'INSERT' then provider_write := true; end if;
    if r->'source_payload_ref'->>'sourceObjectType'='Payment' then provider_write := true; end if;
  elsif tg_table_name in ('ledger_postings', 'transaction_lines') then
    select source_transaction_type not like 'Subledger:%' and source_transaction_type not in ('JournalEntry', 'JournalEntryAdjustment')
      into provider_write from erp_financials.transactions where tenant_id=t and source_id=s and transaction_id=r->>'transaction_id';
    -- Original and compensating accounting history cannot be removed by replace-full-sync.
    if tg_op<>'INSERT' then provider_write := true; end if;
    if tg_table_name='ledger_postings' and tg_op='INSERT' and r->>'source_posting_id' like 'cash-application:%' then provider_write := false; end if;
  elsif tg_table_name = 'subledger_documents' then
    provider_write := exists(select 1 from erp_financials.customer_payment_corrections where tenant_id=t and source_id=s and payment_id=r->>'subledger_document_id');
  elsif tg_table_name = 'subledger_applications' then
    provider_write := exists(select 1 from erp_financials.customer_payment_corrections where tenant_id=t and source_id=s and payment_id in (r->>'source_document_id',r->>'target_document_id'));
  elsif tg_table_name = 'imported_customer_payment_evidence' then
    provider_write := true;
  elsif tg_table_name = 'bank_reconciliation_matches' and r->>'status' = 'matched' then
    provider_write := exists(select 1 from erp_financials.imported_customer_payment_evidence e
      join erp_financials.customer_payment_corrections c using(tenant_id,company_id,source_id,payment_id)
      where e.tenant_id=t and e.source_id=s and
      (e.evidence->'transactionIds') ? (r->>'transaction_id'));
  end if;
  if provider_write then raise exception 'customer_payment_corrected_source: provider replay requires explicit reconciliation; source is tombstoned'; end if;
  return case when tg_op='DELETE' then old else new end;
end $$;
DO $$ declare n text; begin
  foreach n in array array['transactions','transaction_lines','ledger_postings','subledger_documents','subledger_applications','bank_reconciliation_matches','imported_customer_payment_evidence'] loop
    execute format('create trigger payment_correction_source_guard before insert or update or delete on erp_financials.%I for each row execute function erp_financials.guard_customer_payment_correction_source()', n);
  end loop;
end $$;
