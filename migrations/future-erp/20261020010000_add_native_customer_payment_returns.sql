-- Native receipt returns consume receipt credit through an immutable refund
-- settlement. Existing invoice/credit application behavior is preserved.
alter table "erp_financials"."subledger_applications"
  drop constraint "subledger_applications_type_check";
alter table "erp_financials"."subledger_applications"
  add constraint "subledger_applications_type_check" check (application_type in (
    'customer_payment_to_invoice', 'bill_payment_to_bill', 'credit_to_invoice',
    'vendor_credit_to_bill', 'write_off_to_invoice', 'customer_payment_to_refund'
  ));

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
  where "tenant_id" = new."tenant_id" and "company_id" = new."company_id" and "source_id" = new."source_id"
    and "subledger_document_id" in (new."source_document_id", new."target_document_id")
  order by "subledger_document_id"
  for update;

  select * into source_document from "erp_financials"."subledger_documents"
  where "tenant_id" = new."tenant_id" and "company_id" = new."company_id" and "source_id" = new."source_id"
    and "subledger_document_id" = new."source_document_id";
  select * into target_document from "erp_financials"."subledger_documents"
  where "tenant_id" = new."tenant_id" and "company_id" = new."company_id" and "source_id" = new."source_id"
    and "subledger_document_id" = new."target_document_id";

  if source_document."subledger_document_id" is null or target_document."subledger_document_id" is null then
    raise exception 'subledger application documents do not exist in the requested scope';
  end if;
  if source_document."party_id" is null or target_document."party_id" is null
    or source_document."party_id" <> target_document."party_id"
  then
    raise exception 'subledger application documents must have the same non-null party';
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

-- Settlement cannot be detached from cash by generic unapply, provider refresh,
-- or source reset. A mistaken cash return needs an explicit compensating fact.
create function "erp_financials"."guard_customer_payment_return_application"()
returns trigger language plpgsql as $return_application_guard$
begin
  if old."application_type" = 'customer_payment_to_refund' then
    raise exception 'receipt return settlement is immutable';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$return_application_guard$;
create trigger "customer_payment_return_application_guard"
before update or delete on "erp_financials"."subledger_applications"
for each row execute function "erp_financials"."guard_customer_payment_return_application"();

create function "erp_financials"."guard_customer_payment_return_document"()
returns trigger language plpgsql as $return_document_guard$
begin
  if tg_op = 'UPDATE' and not (old."metadata" ? 'customerPaymentReturn') and new."metadata" ? 'customerPaymentReturn' then
    raise exception 'receipt return identity cannot be added to an existing document';
  end if;
  if old."metadata" ? 'customerPaymentReturn' then
    if tg_op = 'DELETE' then raise exception 'receipt return document is immutable'; end if;
    if old."version" <> 1 or old."open_amount" <> old."original_amount"
      or new."version" <> 2 or new."open_amount" <> 0 or new."status" <> 'settled'
      or new."metadata" is distinct from old."metadata"
      or not exists (
        select 1 from "erp_financials"."subledger_applications" a
        where a."tenant_id" = old."tenant_id" and a."company_id" = old."company_id"
          and a."source_id" = old."source_id" and a."target_document_id" = old."subledger_document_id"
          and a."source_document_id" = old."metadata" #>> '{customerPaymentReturn,paymentId}'
          and a."application_type" = 'customer_payment_to_refund' and a."status" = 'applied'
          and a."applied_amount" = old."original_amount"
      ) then raise exception 'receipt return document may only be settled by its bound receipt';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$return_document_guard$;
create trigger "customer_payment_return_document_guard"
before update or delete on "erp_financials"."subledger_documents"
for each row execute function "erp_financials"."guard_customer_payment_return_document"();

-- A crash/early return inside a caller transaction must not leave an open
-- refund or cash movement without its receipt-credit settlement and audit.
create function "erp_financials"."assert_customer_payment_return_complete"()
returns trigger language plpgsql as $return_complete_guard$
begin
  if new."metadata" ? 'customerPaymentReturn' and not exists (
    select 1 from "erp_financials"."subledger_documents" d
    join "erp_financials"."subledger_applications" a
      on a."tenant_id" = d."tenant_id" and a."company_id" = d."company_id" and a."source_id" = d."source_id"
      and a."target_document_id" = d."subledger_document_id"
      and a."application_type" = 'customer_payment_to_refund' and a."status" = 'applied'
      and a."source_document_id" = d."metadata" #>> '{customerPaymentReturn,paymentId}'
      and a."applied_amount" = d."original_amount"
    join "erp_financials"."financial_lifecycle_events" e
      on e."tenant_id" = d."tenant_id" and e."company_id" = d."company_id" and e."source_id" = d."source_id"
      and e."aggregate_id" = a."source_document_id" and e."event_type" = 'customer_payment.returned'
      and e."payload" #>> '{result,refundDocumentId}' = d."subledger_document_id"
    where d."tenant_id" = new."tenant_id" and d."company_id" = new."company_id" and d."source_id" = new."source_id"
      and d."subledger_document_id" = new."subledger_document_id" and d."document_type" = 'refund'
      and d."open_amount" = 0 and d."status" = 'settled'
  ) then raise exception 'receipt return must commit with its settlement and completed lifecycle';
  end if;
  return new;
end;
$return_complete_guard$;
create constraint trigger "customer_payment_return_complete_guard"
after insert on "erp_financials"."subledger_documents"
deferrable initially deferred
for each row execute function "erp_financials"."assert_customer_payment_return_complete"();
