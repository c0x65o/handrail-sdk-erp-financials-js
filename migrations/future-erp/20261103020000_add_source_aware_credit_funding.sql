-- Shared SDK fix - Spartan should pick up. Application ownership and funding
-- document ownership are separate coordinates. Existing nulls retain legacy scope.
alter table erp_financials.subledger_applications add column source_document_source_id text;
alter table erp_financials.subledger_applications drop constraint subledger_applications_source_document_scope_fk;
alter table erp_financials.subledger_applications add constraint subledger_applications_source_document_scope_fk
 foreign key (tenant_id,company_id,source_document_source_id,source_document_id)
 references erp_financials.subledger_documents(tenant_id,company_id,source_id,subledger_document_id) on update restrict on delete restrict;
create index subledger_applications_funding_coordinate_idx on erp_financials.subledger_applications
 (tenant_id,company_id,source_document_source_id,source_document_id);
create or replace function "erp_financials"."validate_subledger_application"()
returns trigger
language plpgsql
as $subledger_application_validate$
declare
  source_document "erp_financials"."subledger_documents"%rowtype;
  target_document "erp_financials"."subledger_documents"%rowtype;
  existing_application "erp_financials"."subledger_applications"%rowtype;
begin
  if tg_op = 'INSERT' then
    if new."status" <> 'applied' or new."version" <> 1 or new."ended_event_id" is not null then
      raise exception 'new subledger applications must begin applied at version 1 without an ended event';
    end if;
    select * into existing_application
    from "erp_financials"."subledger_applications"
    where "tenant_id" = new."tenant_id" and "company_id" = new."company_id" and "source_id" = new."source_id"
      and "idempotency_key" = new."idempotency_key";
    if found then
      if existing_application."application_type" <> new."application_type"
        or existing_application."source_document_id" <> new."source_document_id"
        or existing_application."target_document_id" <> new."target_document_id"
        or existing_application."source_document_source_id" is distinct from new."source_document_source_id"
        or existing_application."target_document_source_id" is distinct from new."target_document_source_id"
        or existing_application."applied_amount" <> new."applied_amount"
        or existing_application."currency_code" <> new."currency_code"
      then
        if coalesce(current_setting('erp_financials.quickbooks_projection_refresh', true), 'off') <> 'on' then
          raise exception 'subledger application idempotency key is already associated with different content';
        end if;
      end if;
      return new;
    end if;
  elsif coalesce(current_setting('erp_financials.quickbooks_projection_refresh', true), 'off') = 'on'
    and new."status" = 'applied'
  then
    if new."version" <> old."version" + 1 or new."updated_at" < old."updated_at" then
      raise exception 'QuickBooks application refresh must increment version and timestamp';
    end if;
    if new."tenant_id" is distinct from old."tenant_id"
      or new."company_id" is distinct from old."company_id"
      or new."source_id" is distinct from old."source_id"
      or new."application_type" is distinct from old."application_type"
      or new."source_document_id" is distinct from old."source_document_id"
      or new."target_document_id" is distinct from old."target_document_id"
      or new."source_document_source_id" is distinct from old."source_document_source_id"
      or new."target_document_source_id" is distinct from old."target_document_source_id"
      or new."currency_code" is distinct from old."currency_code"
      or new."idempotency_key" is distinct from old."idempotency_key"
      or new."applied_event_id" is distinct from old."applied_event_id"
    then
      raise exception 'QuickBooks application refresh cannot change canonical identity';
    end if;
  else
    if old."status" <> 'applied' or new."status" not in ('unapplied', 'voided') then
      raise exception 'subledger applications may only transition from applied to unapplied or voided';
    end if;
    if new."version" <> old."version" + 1 or new."updated_at" < old."updated_at" then
      raise exception 'subledger application terminal transitions must increment version and timestamp';
    end if;
    if new."tenant_id" is distinct from old."tenant_id"
      or new."company_id" is distinct from old."company_id"
      or new."source_id" is distinct from old."source_id"
      or new."application_type" is distinct from old."application_type"
      or new."source_document_id" is distinct from old."source_document_id"
      or new."target_document_id" is distinct from old."target_document_id"
      or new."source_document_source_id" is distinct from old."source_document_source_id"
      or new."target_document_source_id" is distinct from old."target_document_source_id"
      or new."applied_amount" is distinct from old."applied_amount"
      or new."currency_code" is distinct from old."currency_code"
      or new."application_date" is distinct from old."application_date"
      or new."idempotency_key" is distinct from old."idempotency_key"
      or new."applied_event_id" is distinct from old."applied_event_id"
    then
      raise exception 'subledger application accounting facts are immutable';
    end if;
    return new;
  end if;

  perform 1
  from "erp_financials"."subledger_documents"
  where "tenant_id" = new."tenant_id" and "company_id" = new."company_id" 
    and (("source_id" = coalesce(new."source_document_source_id",new."source_id") and "subledger_document_id" = new."source_document_id")
      or ("source_id" = coalesce(new."target_document_source_id",new."source_id") and "subledger_document_id" = new."target_document_id"))
  order by "subledger_document_id"
  for update;

  select * into source_document from "erp_financials"."subledger_documents"
  where "tenant_id" = new."tenant_id" and "company_id" = new."company_id" and "source_id" = coalesce(new."source_document_source_id",new."source_id")
    and "subledger_document_id" = new."source_document_id";
  select * into target_document from "erp_financials"."subledger_documents"
  where "tenant_id" = new."tenant_id" and "company_id" = new."company_id" and "source_id" = coalesce(new."target_document_source_id",new."source_id")
    and "subledger_document_id" = new."target_document_id";

  if source_document."subledger_document_id" is null or target_document."subledger_document_id" is null then
    raise exception 'subledger application documents do not exist in the requested scope';
  end if;
  if source_document."party_id" is null or target_document."party_id" is null
    or (coalesce(new."target_document_source_id",new."source_id") = coalesce(new."source_document_source_id",new."source_id")
      and source_document."party_id" <> target_document."party_id")
  then
    raise exception 'subledger application documents must have the same non-null party';
  end if;
  if new.source_document_source_id is not null or
    (new.application_type in ('credit_to_invoice','vendor_credit_to_bill','credit_to_refund') and coalesce(new.target_document_source_id,new.source_id)<>new.source_id) then
    if new.application_type not in ('credit_to_invoice','vendor_credit_to_bill','credit_to_refund') or not exists (
      select 1 from erp_financials.financial_lifecycle_events e
      where e.tenant_id=new.tenant_id and e.company_id=new.company_id and e.source_id=new.source_id
        and e.event_id=new.applied_event_id and e.aggregate_id=new.subledger_application_id and e.event_type='subledger_application.applied'
        and e.approver_ref is not null and e.approver_ref<>e.actor_ref
        and e.payload#>>'{creditSettlement,sourceSourceId}'=coalesce(new.source_document_source_id,new.source_id)
        and e.payload#>>'{creditSettlement,targetSourceId}'=coalesce(new.target_document_source_id,new.source_id)
        and e.payload#>>'{creditSettlement,sourcePartyId}'=source_document.party_id
        and e.payload#>>'{creditSettlement,targetPartyId}'=target_document.party_id
        and length(e.payload#>>'{creditSettlement,reviewRef}')>0
    ) then raise exception 'source-aware credit funding requires independent settlement approval'; end if;
  elsif coalesce(new.target_document_source_id,new.source_id) <> new.source_id then
    if new.application_type not in ('customer_payment_to_invoice','bill_payment_to_bill') or not exists (
      select 1 from erp_financials.financial_lifecycle_events e
      where e.tenant_id=new.tenant_id and e.company_id=new.company_id and e.source_id=new.source_id
        and e.event_id=new.applied_event_id and e.aggregate_id=new.subledger_application_id
        and e.event_type='subledger_application.applied'
        and e.approver_ref is not null and e.approver_ref<>e.actor_ref
        and e.payload#>>'{crossSource,targetSourceId}'=new.target_document_source_id
        and e.payload#>>'{crossSource,nativePartyId}'=source_document.party_id
        and e.payload#>>'{crossSource,historicalPartyId}'=target_document.party_id
        and length(e.payload#>>'{crossSource,reviewRef}')>0
    ) then raise exception 'cross-source settlement requires independently reviewed source and party evidence'; end if;
  end if;
  if source_document."currency_code" <> target_document."currency_code"
    or new."currency_code" <> source_document."currency_code"
  then
    raise exception 'subledger application currency must match both documents';
  end if;
  if (new."application_type" = 'customer_payment_to_invoice' and (source_document."document_type" <> 'customer_payment' or target_document."document_type" <> 'invoice'))
    or (new."application_type" = 'bill_payment_to_bill' and (source_document."document_type" <> 'bill_payment' or target_document."document_type" <> 'vendor_bill'))
    or (new."application_type" = 'credit_to_invoice' and (source_document."document_type" not in ('credit_memo', 'deposit') or target_document."document_type" <> 'invoice'))
    or (new."application_type" = 'vendor_credit_to_bill' and (source_document."document_type" <> 'vendor_credit' or target_document."document_type" <> 'vendor_bill'))
    or (new."application_type" = 'customer_payment_to_refund' and (source_document."document_type" <> 'customer_payment' or target_document."document_type" <> 'refund'))
    or (new."application_type" = 'credit_to_refund' and (source_document."document_type" <> 'credit_memo' or target_document."document_type" <> 'refund'
      or not (target_document.metadata ? 'creditRefundFunding') or new.application_date < source_document.document_date or new.application_date < target_document.document_date))
    or (new."application_type" = 'write_off_to_invoice' and (source_document."document_type" <> 'write_off' or target_document."document_type" <> 'invoice'))
  then
    raise exception 'subledger application document types do not match application_type';
  end if;
  if new."application_type" = 'customer_payment_to_refund' and (
    target_document."metadata" #>> '{customerPaymentReturn,paymentId}' is distinct from new."source_document_id"
    or new."applied_amount" <> target_document."original_amount"
    or new."application_date" <> target_document."document_date"
  ) then
    raise exception 'receipt return must fully settle its bound refund on the refund date';
  end if;
  if new."applied_amount" > source_document."open_amount" + (case when tg_op = 'UPDATE' and old."status" = 'applied' then old."applied_amount" else 0 end)
    or new."applied_amount" > target_document."open_amount" + (case when tg_op = 'UPDATE' and old."status" = 'applied' then old."applied_amount" else 0 end)
  then
    raise exception 'subledger application amount exceeds an available document balance';
  end if;
  return new;
end;
$subledger_application_validate$;

create or replace function "erp_financials"."apply_subledger_application_balances"()
returns trigger
language plpgsql
as $subledger_application_balances$
declare
  balance_delta numeric;
begin
  if tg_op = 'INSERT' then
    balance_delta := -new."applied_amount";
  elsif old."status" = 'applied' and new."status" in ('unapplied', 'voided') then
    balance_delta := new."applied_amount";
  else
    return new;
  end if;
  perform set_config('erp_financials.application_balance_update', 'on', true);
  update "erp_financials"."subledger_documents"
  set "open_amount" = "open_amount" + balance_delta,
      "status" = case
        when "open_amount" + balance_delta = 0 then 'settled'
        when "open_amount" + balance_delta = "original_amount" then 'open'
        else 'partially_applied'
      end,
      "version" = "version" + 1,
      "updated_at" = new."updated_at"
  where "tenant_id" = new."tenant_id" and "company_id" = new."company_id" 
    and (("source_id" = coalesce(new."source_document_source_id",new."source_id") and "subledger_document_id" = new."source_document_id")
      or ("source_id" = coalesce(new."target_document_source_id",new."source_id") and "subledger_document_id" = new."target_document_id"));
  perform set_config('erp_financials.application_balance_update', 'off', true);
  return new;
end
$subledger_application_balances$;


create function erp_financials.guard_reviewed_credit_funding() returns trigger language plpgsql as $$
begin
 if exists(select 1 from erp_financials.subledger_applications a
   where a.tenant_id=old.tenant_id and a.company_id=old.company_id and a.source_id<>old.source_id
    and a.source_document_source_id=old.source_id and a.source_document_id=old.subledger_document_id) then
   if tg_op='DELETE' or (coalesce(current_setting('erp_financials.application_balance_update',true),'off')<>'on'
     and (new.original_amount is distinct from old.original_amount or new.open_amount is distinct from old.open_amount
      or new.status is distinct from old.status or new.party_id is distinct from old.party_id
      or new.currency_code is distinct from old.currency_code or new.transaction_id is distinct from old.transaction_id
      or new.document_date is distinct from old.document_date)) then
     raise exception 'imported credit has retained reviewed funding; reconcile provider changes explicitly';
   end if;
 end if;
 if tg_op='DELETE' then return old; end if;
 return new;
end; $$;
create trigger reviewed_credit_funding_guard before update or delete on erp_financials.subledger_documents
 for each row execute function erp_financials.guard_reviewed_credit_funding();

create or replace function erp_financials.guard_cross_source_historical_journal() returns trigger language plpgsql as $journal$
declare journal_id text; journal erp_financials.transactions%rowtype; fact jsonb; existing jsonb;
begin
 fact:=case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end;
 journal_id:=fact->>'transaction_id';
 select * into journal from erp_financials.transactions t where t.tenant_id=fact->>'tenant_id' and t.source_id=fact->>'source_id' and t.transaction_id=journal_id;
 if exists(select 1 from erp_financials.subledger_documents d join erp_financials.subledger_applications a
   on a.tenant_id=d.tenant_id and a.company_id=d.company_id and a.source_id<>d.source_id
    and ((a.target_document_source_id=d.source_id and a.target_document_id=d.subledger_document_id)
      or (a.source_document_source_id=d.source_id and a.source_document_id=d.subledger_document_id))
   where d.tenant_id=fact->>'tenant_id' and d.source_id=fact->>'source_id'
    and (d.transaction_id=journal_id or (d.metadata->>'sourceTransactionId'=journal.source_payload_ref->>'sourceObjectId'
      and d.metadata->>'sourceTransactionType'=journal.source_payload_ref->>'sourceObjectType'))) then
   if tg_op='INSERT' then
     if tg_table_name='ledger_postings' then
       select to_jsonb(p) into existing from erp_financials.ledger_postings p where p.posting_id=fact->>'posting_id';
     elsif tg_table_name='transaction_lines' then
       select to_jsonb(l) into existing from erp_financials.transaction_lines l where l.transaction_line_id=fact->>'transaction_line_id';
     else
       select to_jsonb(t) into existing from erp_financials.transactions t where t.transaction_id=journal_id;
     end if;
     if existing is null or (existing-array['updated_at','posted_at','import_batch_id','checkpoint_id'])
       is distinct from (fact-array['updated_at','posted_at','import_batch_id','checkpoint_id']) then
       raise exception 'historical journal supports retained cross-source settlement and cannot be extended';
     end if;
     return new;
   end if;
   if tg_op='DELETE' or (to_jsonb(new)-array['updated_at','posted_at','import_batch_id','checkpoint_id'])
     is distinct from (to_jsonb(old)-array['updated_at','posted_at','import_batch_id','checkpoint_id']) then
     raise exception 'historical journal supports retained cross-source settlement and cannot be rewritten';
   end if;
 end if;
 if tg_op='DELETE' then return old; end if;
 return new;
end;
$journal$;
