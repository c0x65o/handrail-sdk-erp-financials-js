-- Extend independently reviewed cross-source settlement to native bill payments.
-- No financial facts, amounts, journals or published migrations are rewritten.
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
    and (("source_id" = new."source_id" and "subledger_document_id" = new."source_document_id")
      or ("source_id" = coalesce(new."target_document_source_id",new."source_id") and "subledger_document_id" = new."target_document_id"))
  order by "subledger_document_id"
  for update;

  select * into source_document from "erp_financials"."subledger_documents"
  where "tenant_id" = new."tenant_id" and "company_id" = new."company_id" and "source_id" = new."source_id"
    and "subledger_document_id" = new."source_document_id";
  select * into target_document from "erp_financials"."subledger_documents"
  where "tenant_id" = new."tenant_id" and "company_id" = new."company_id" and "source_id" = coalesce(new."target_document_source_id",new."source_id")
    and "subledger_document_id" = new."target_document_id";

  if source_document."subledger_document_id" is null or target_document."subledger_document_id" is null then
    raise exception 'subledger application documents do not exist in the requested scope';
  end if;
  if source_document."party_id" is null or target_document."party_id" is null
    or (coalesce(new."target_document_source_id",new."source_id") = new."source_id"
      and source_document."party_id" <> target_document."party_id")
  then
    raise exception 'subledger application documents must have the same non-null party';
  end if;
  if coalesce(new.target_document_source_id,new.source_id) <> new.source_id then
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
