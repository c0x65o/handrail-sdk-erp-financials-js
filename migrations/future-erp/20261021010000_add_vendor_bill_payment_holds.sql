-- Existing financial facts and balances are preserved. Holds default to absent.
alter table "erp_financials"."subledger_documents"
  add column "payment_hold" boolean not null default false,
  add column "payment_hold_reason" text,
  add constraint "subledger_documents_payment_hold_check" check (
    (not payment_hold and payment_hold_reason is null)
    or (document_type='vendor_bill' and payment_hold and length(btrim(payment_hold_reason)) between 1 and 1000 and payment_hold_reason is not null)
  );

create or replace function "erp_financials"."guard_subledger_document_mutation"()
returns trigger
language plpgsql
as $subledger_document_guard$
begin
  if tg_op = 'DELETE' then
    if "erp_financials"."source_import_reset_scope_allowed"(
      old."tenant_id", old."company_id", old."source_id"
    ) then
      return old;
    end if;
    raise exception 'subledger documents cannot be deleted';
  end if;
  -- A hold changes only payment control and the canonical optimistic version.
  if new."payment_hold" is distinct from old."payment_hold"
    or new."payment_hold_reason" is distinct from old."payment_hold_reason" then
    if old."document_type"='vendor_bill' and new."payment_hold" is distinct from old."payment_hold"
      and old."status" in ('open','partially_applied') and old."open_amount">0
      and new."version"=old."version"+1
      and (to_jsonb(new)-array['payment_hold','payment_hold_reason','version','updated_at'])
        = (to_jsonb(old)-array['payment_hold','payment_hold_reason','version','updated_at'])
      and exists(select 1 from "erp_financials"."financial_lifecycle_events" e
        where e."tenant_id"=old."tenant_id" and e."company_id"=old."company_id" and e."source_id"=old."source_id"
          and e."aggregate_type"='subledger_document' and e."aggregate_id"=old."subledger_document_id"
          and e."event_type"='subledger.vendor_bill.payment_hold_changed'
          and (e."payload"->>'expectedVersion')::integer=old."version"
          and (e."payload"->>'previousHold')::boolean=old."payment_hold"
          and (e."payload"#>>'{result,version}')::integer=new."version"
          and (e."payload"#>>'{result,paymentHold}')::boolean=new."payment_hold"
          and (e."payload"#>>'{result,paymentHoldReason}') is not distinct from new."payment_hold_reason")
    then return new; end if;
    raise exception 'vendor bill hold requires its versioned lifecycle';
  end if;
  if coalesce(current_setting('erp_financials.quickbooks_projection_refresh', true), 'off') = 'on'
    and old."metadata" ->> 'provider' = 'quickbooks'
    and new."metadata" ->> 'provider' = 'quickbooks'
  then
    if new."tenant_id" is distinct from old."tenant_id"
      or new."company_id" is distinct from old."company_id"
      or new."source_id" is distinct from old."source_id"
      or new."subledger_document_id" is distinct from old."subledger_document_id"
      or new."document_type" is distinct from old."document_type"
      or new."idempotency_key" is distinct from old."idempotency_key"
      or new."lifecycle_event_id" is distinct from old."lifecycle_event_id"
    then
      raise exception 'QuickBooks document refresh cannot change canonical identity';
    end if;
    return new;
  end if;
  -- Date restatement is a named lifecycle, not a general mutable-document escape.
  -- All other fields, including payment position and the original journal, stay fixed.
  if old."document_type" = 'invoice' and new."version" = old."version" + 1
    and (to_jsonb(new) - array['document_date','due_date','version','updated_at'])
      = (to_jsonb(old) - array['document_date','due_date','version','updated_at'])
    and exists (
      select 1 from "erp_financials"."financial_lifecycle_events" e
      where e."tenant_id"=old."tenant_id" and e."company_id"=old."company_id" and e."source_id"=old."source_id"
        and e."aggregate_id"=old."subledger_document_id" and e."event_type"='subledger.invoice.dates_corrected'
        and (e."payload"->>'expectedVersion')::integer=old."version"
        and (e."payload"#>>'{result,version}')::integer=new."version"
        and e."payload"->>'previousDate'=old."document_date"::text
        and (e."payload"->>'previousDueDate') is not distinct from old."due_date"::text
        and e."payload"#>>'{result,documentDate}'=new."document_date"::text
        and e."payload"#>>'{result,dueDate}'=new."due_date"::text
        and e."payload"#>>'{result,originalTransactionId}'=old."transaction_id"
    ) then return new;
  end if;
  if coalesce(current_setting('erp_financials.application_balance_update', true), 'off') <> 'on' then
    raise exception 'posted subledger documents are immutable; use an application, unapplication, or compensating document';
  end if;
  if new."tenant_id" is distinct from old."tenant_id"
    or new."company_id" is distinct from old."company_id"
    or new."source_id" is distinct from old."source_id"
    or new."document_type" is distinct from old."document_type"
    or new."transaction_id" is distinct from old."transaction_id"
    or new."party_id" is distinct from old."party_id"
    or new."document_date" is distinct from old."document_date"
    or new."due_date" is distinct from old."due_date"
    or new."currency_code" is distinct from old."currency_code"
    or new."original_amount" is distinct from old."original_amount"
    or new."idempotency_key" is distinct from old."idempotency_key"
    or new."lifecycle_event_id" is distinct from old."lifecycle_event_id"
  then
    raise exception 'posted subledger document identity and accounting facts are immutable';
  end if;
  return new;
end;
$subledger_document_guard$;

create function "erp_financials"."guard_vendor_bill_initial_hold"()
returns trigger language plpgsql as $initial_hold$
begin
  if new.payment_hold or new.payment_hold_reason is not null then
    raise exception 'new documents cannot bypass the payment hold lifecycle';
  end if;
  return new;
end;
$initial_hold$;
create trigger "subledger_document_initial_hold_guard" before insert on "erp_financials"."subledger_documents"
for each row execute function "erp_financials"."guard_vendor_bill_initial_hold"();

create function "erp_financials"."guard_vendor_bill_payment_application"()
returns trigger language plpgsql as $payment_hold$
begin
  if new.application_type <> 'bill_payment_to_bill' then return new; end if;
  -- Same deterministic row order as the existing application validator.
  perform 1 from "erp_financials"."subledger_documents"
    where tenant_id=new.tenant_id and company_id=new.company_id and source_id=new.source_id
      and subledger_document_id in (new.source_document_id,new.target_document_id)
    order by subledger_document_id for update;
  if exists(select 1 from "erp_financials"."subledger_documents"
    where tenant_id=new.tenant_id and company_id=new.company_id and source_id=new.source_id
      and subledger_document_id=new.target_document_id and payment_hold) then
    raise exception 'vendor bill is on payment hold';
  end if;
  return new;
end;
$payment_hold$;
create trigger "subledger_application_payment_hold_guard" before insert on "erp_financials"."subledger_applications"
for each row execute function "erp_financials"."guard_vendor_bill_payment_application"();

create function "erp_financials"."guard_vendor_bill_hold_complete"()
returns trigger language plpgsql as $hold_complete$
declare bill "erp_financials"."subledger_documents"%rowtype; latest jsonb; matches integer;
begin
  if new.event_type <> 'subledger.vendor_bill.payment_hold_changed' then return new; end if;
  select * into bill from "erp_financials"."subledger_documents"
    where tenant_id=new.tenant_id and company_id=new.company_id and source_id=new.source_id
      and subledger_document_id=new.aggregate_id for key share;
  if not found or bill.document_type <> 'vendor_bill'
    or new.aggregate_type <> 'subledger_document'
    or jsonb_typeof(new.payload->'previousHold') is distinct from 'boolean'
    or jsonb_typeof(new.payload#>'{result,paymentHold}') is distinct from 'boolean'
    or (new.payload->>'expectedVersion')::integer is null
    or (new.payload#>>'{result,version}')::integer is distinct from (new.payload->>'expectedVersion')::integer+1
    or (new.payload#>>'{result,paymentHold}')::boolean is not distinct from (new.payload->>'previousHold')::boolean
    or new.payload#>>'{result,vendorBillId}' is distinct from bill.subledger_document_id
    or bill.version < (new.payload#>>'{result,version}')::integer
  then raise exception 'vendor bill hold must commit its versioned document'; end if;
  select count(*) into matches from "erp_financials"."financial_lifecycle_events" e
    where e.tenant_id=new.tenant_id and e.company_id=new.company_id and e.source_id=new.source_id
      and e.aggregate_id=new.aggregate_id and e.event_type=new.event_type
      and e.payload->>'expectedVersion'=new.payload->>'expectedVersion';
  if matches<>1 then raise exception 'vendor bill hold version has multiple lifecycle owners'; end if;
  select e.payload into latest from "erp_financials"."financial_lifecycle_events" e
    where e.tenant_id=new.tenant_id and e.company_id=new.company_id and e.source_id=new.source_id
      and e.aggregate_id=new.aggregate_id and e.event_type=new.event_type
    order by (e.payload#>>'{result,version}')::integer desc limit 1;
  if bill.payment_hold is distinct from (latest#>>'{result,paymentHold}')::boolean
    or bill.payment_hold_reason is distinct from latest#>>'{result,paymentHoldReason}'
  then raise exception 'vendor bill hold must preserve the latest lifecycle state'; end if;
  if not exists(select 1 from "erp_financials"."financial_outbox" o
    where o.tenant_id=new.tenant_id and o.company_id=new.company_id and o.source_id=new.source_id
      and o.aggregate_id=new.aggregate_id and o.event_type=new.event_type
      and o.payload->>'lifecycleEventId'=new.event_id)
  then raise exception 'vendor bill hold must commit its outbox event'; end if;
  return new;
end;
$hold_complete$;
create constraint trigger "vendor_bill_hold_event_complete" after insert on "erp_financials"."financial_lifecycle_events"
deferrable initially deferred for each row execute function "erp_financials"."guard_vendor_bill_hold_complete"();
