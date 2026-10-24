-- Null retains the pre-existing one-date contract without rewriting history.
-- A distinct recognition date is native invoice accounting, not host metadata.
alter table "erp_financials"."subledger_documents"
 add column "recognition_date" date,
 add constraint "subledger_documents_recognition_date_check" check (recognition_date is null or document_type='invoice');

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
      or new."recognition_date" is distinct from old."recognition_date"
    then
      raise exception 'QuickBooks document refresh cannot change canonical identity';
    end if;
    return new;
  end if;
  -- Date restatement is a named lifecycle, not a general mutable-document escape.
  -- All other fields, including payment position and the original journal, stay fixed.
  if old."document_type" = 'invoice' and new."version" = old."version" + 1
    and (to_jsonb(new) - array['document_date','recognition_date','due_date','version','updated_at'])
      = (to_jsonb(old) - array['document_date','recognition_date','due_date','version','updated_at'])
    and exists (
      select 1 from "erp_financials"."financial_lifecycle_events" e
      where e."tenant_id"=old."tenant_id" and e."company_id"=old."company_id" and e."source_id"=old."source_id"
        and e."aggregate_id"=old."subledger_document_id" and e."event_type"='subledger.invoice.dates_corrected'
        and (e."payload"->>'expectedVersion')::integer=old."version"
        and (e."payload"#>>'{result,version}')::integer=new."version"
        and e."payload"->>'previousDate'=old."document_date"::text
        and coalesce(e."payload"->>'previousRecognitionDate',e."payload"->>'previousDate')=coalesce(old."recognition_date",old."document_date")::text
        and (e."payload"->>'previousDueDate') is not distinct from old."due_date"::text
        and e."payload"#>>'{result,documentDate}'=new."document_date"::text
        and coalesce(e."payload"#>>'{result,recognitionDate}',e."payload"#>>'{result,documentDate}')=coalesce(new."recognition_date",new."document_date")::text
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
    or new."recognition_date" is distinct from old."recognition_date"
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

create or replace function "erp_financials"."guard_invoice_date_correction_complete"()
returns trigger language plpgsql as $invoice_correction_complete$
declare
  evidence "erp_financials"."financial_lifecycle_events"%rowtype;
  invoice "erp_financials"."subledger_documents"%rowtype;
  latest jsonb;
  correction jsonb;
  origin_id text;
  reversal_id text;
  replacement_id text;
  journal_id text;
  position integer;
begin
  if tg_table_name='financial_lifecycle_events' then
    if new."event_type" <> 'subledger.invoice.dates_corrected' then return new; end if;
    evidence := new;
  else
    if new."source_transaction_type" <> 'Subledger:invoice_date_correction' then return new; end if;
    select * into evidence from "erp_financials"."financial_lifecycle_events" e
    where e."tenant_id"=new."tenant_id" and e."source_id"=new."source_id"
      and e."aggregate_id"=new."source_payload_ref"#>>'{preview,journalOrigin,reference}'
      and e."event_type"='subledger.invoice.dates_corrected'
      and (e."payload"#>>'{result,reversalTransactionId}'=new."transaction_id"
        or e."payload"#>>'{result,replacementTransactionId}'=new."transaction_id");
    if not found then raise exception 'invoice date correction journal requires completed lifecycle'; end if;
  end if;
  correction := evidence."payload"->'result';
  origin_id := correction->>'originalTransactionId';
  reversal_id := correction->>'reversalTransactionId';
  replacement_id := correction->>'replacementTransactionId';
  select * into invoice from "erp_financials"."subledger_documents" d
    where d."tenant_id"=evidence."tenant_id" and d."company_id"=evidence."company_id" and d."source_id"=evidence."source_id"
      and d."subledger_document_id"=evidence."aggregate_id";
  if not found or invoice."document_type" <> 'invoice' or invoice."transaction_id" is distinct from origin_id
    or evidence."aggregate_type" <> 'subledger_document'
    or correction->>'invoiceId' is distinct from evidence."aggregate_id"
    or (correction->>'version')::integer is distinct from (evidence."payload"->>'expectedVersion')::integer+1
    or invoice."version" < (correction->>'version')::integer
    or (evidence."payload"->>'expectedVersion')::integer is null
    or (correction->>'version')::integer is null
    or coalesce((evidence."payload"->>'commandChecksum') !~ '^[a-f0-9]{64}$', true)
  then raise exception 'invoice date correction must commit with its versioned document'; end if;
  select e."payload"->'result' into latest from "erp_financials"."financial_lifecycle_events" e
    where e."tenant_id"=evidence."tenant_id" and e."company_id"=evidence."company_id" and e."source_id"=evidence."source_id"
      and e."aggregate_id"=evidence."aggregate_id" and e."event_type"='subledger.invoice.dates_corrected'
    order by (e."payload"#>>'{result,version}')::integer desc limit 1;
  if invoice."document_date"::text is distinct from latest->>'documentDate'
    or invoice."due_date"::text is distinct from latest->>'dueDate'
    or coalesce(invoice."recognition_date",invoice."document_date")::text is distinct from coalesce(latest->>'recognitionDate',latest->>'documentDate')
  then raise exception 'invoice date correction must commit its final dates'; end if;
  if exists(select 1 from "erp_financials"."subledger_applications" a
    where a.tenant_id=invoice.tenant_id and a.company_id=invoice.company_id and a.source_id=invoice.source_id
      and a.target_document_id=invoice.subledger_document_id
      and a.application_date<coalesce(invoice.recognition_date,invoice.document_date)) then
    raise exception 'invoice recognition cannot follow historical applications';
  end if;
  if not exists (select 1 from "erp_financials"."financial_outbox" o
    where o."tenant_id"=evidence."tenant_id" and o."company_id"=evidence."company_id" and o."source_id"=evidence."source_id"
      and o."idempotency_key"=evidence."idempotency_key"||':outbox'
      and o."event_type"=evidence."event_type" and o."aggregate_id"=evidence."aggregate_id"
      and o."payload"->>'lifecycleEventId'=evidence."event_id")
  then raise exception 'invoice date correction requires its outbox event'; end if;
  if coalesce(evidence."payload"->>'previousRecognitionDate',evidence."payload"->>'previousDate') = coalesce(correction->>'recognitionDate',correction->>'documentDate') then
    if reversal_id is not null or replacement_id is not null then
      raise exception 'due-date-only correction cannot move ledger recognition';
    end if;
    return new;
  end if;
  if reversal_id is null or replacement_id is null or reversal_id=replacement_id
    or reversal_id=origin_id or replacement_id=origin_id
  then raise exception 'invoice date correction requires distinct compensation journals'; end if;
  if not exists (select 1 from "erp_financials"."transactions" t where t."tenant_id"=invoice."tenant_id"
    and t."source_id"=invoice."source_id" and t."transaction_id"=origin_id and t."source_transaction_type"='Subledger:invoice')
  then raise exception 'invoice date correction requires native original journal'; end if;
  for position in 1..2 loop
    journal_id := case when position=1 then reversal_id else replacement_id end;
    if not exists (select 1 from "erp_financials"."transactions" t
      where t."tenant_id"=invoice."tenant_id" and t."source_id"=invoice."source_id" and t."transaction_id"=journal_id
        and t."source_transaction_type"='Subledger:invoice_date_correction' and t."status"='posted'
        and t."currency_code"=invoice."currency_code"
        and t."transaction_date"::text=case when position=1 then coalesce(evidence."payload"->>'previousRecognitionDate',evidence."payload"->>'previousDate') else coalesce(correction->>'recognitionDate',correction->>'documentDate') end
        and t."source_payload_ref"#>>'{preview,journalOrigin,reference}'=invoice."subledger_document_id")
    then raise exception 'invoice date correction journal scope or date mismatch'; end if;
    if exists (select 1 from "erp_financials"."ledger_postings" p where p."tenant_id"=invoice."tenant_id" and p."source_id"=invoice."source_id" and p."transaction_id"=journal_id and p."accounting_basis"<>'accrual')
      or not exists (select 1 from "erp_financials"."ledger_postings" p where p."tenant_id"=invoice."tenant_id" and p."source_id"=invoice."source_id" and p."transaction_id"=journal_id)
      or exists (
        select 1 from "erp_financials"."ledger_postings" p
        where p."tenant_id"=invoice."tenant_id" and p."source_id"=invoice."source_id"
          and p."transaction_id" in (origin_id,journal_id) and p."accounting_basis"='accrual'
        group by p."account_id",p."party_id",p."item_id",p."dimension_refs",p."currency_code",p."accounting_basis"
        having sum(case when p."transaction_id"=origin_id then p."debit_amount"
          when position=1 then -p."credit_amount" else -p."debit_amount" end) <> 0
          or sum(case when p."transaction_id"=origin_id then p."credit_amount"
          when position=1 then -p."debit_amount" else -p."credit_amount" end) <> 0
      ) then raise exception 'invoice date correction must preserve original amounts and dimensions'; end if;
  end loop;
  return new;
end;
$invoice_correction_complete$;

-- A distinct date must agree with the original native posted journal. Later
-- restatements are protected by the versioned correction lifecycle above.
create function "erp_financials"."guard_invoice_initial_recognition"()
returns trigger language plpgsql as $initial_recognition$
begin
 if new.recognition_date is not null and not exists(
  select 1 from "erp_financials"."transactions" t
  where t.tenant_id=new.tenant_id and t.source_id=new.source_id and t.transaction_id=new.transaction_id
   and t.source_transaction_type='Subledger:invoice' and t.status='posted'
   and t.transaction_date=new.recognition_date and t.currency_code=new.currency_code
 ) then raise exception 'invoice recognition must match its native posted journal'; end if;
 return new;
end;
$initial_recognition$;
create trigger "invoice_initial_recognition_guard" before insert on "erp_financials"."subledger_documents"
for each row execute function "erp_financials"."guard_invoice_initial_recognition"();

create function "erp_financials"."guard_invoice_cancellation_recognition"()
returns trigger language plpgsql as $cancel_recognition$
declare recognized date; cancelled date;
begin
 select coalesce(invoice.recognition_date,invoice.document_date),credit.document_date into recognized,cancelled
 from erp_financials.subledger_documents invoice join erp_financials.subledger_documents credit
  on credit.tenant_id=invoice.tenant_id and credit.company_id=invoice.company_id and credit.source_id=invoice.source_id
 where invoice.tenant_id=new.tenant_id and invoice.company_id=new.company_id and invoice.source_id=new.source_id
  and invoice.subledger_document_id=new.invoice_document_id and invoice.document_type='invoice'
  and credit.subledger_document_id=new.credit_document_id and credit.document_type='credit_memo'
 for share of invoice,credit;
 if recognized is null or cancelled is null or cancelled<recognized then
  raise exception 'invoice cancellation cannot precede recognition';
 end if;
 return new;
end;
$cancel_recognition$;
create trigger "invoice_cancellation_recognition_guard" before insert on "erp_financials"."invoice_voids"
for each row execute function "erp_financials"."guard_invoice_cancellation_recognition"();

create function "erp_financials"."guard_invoice_application_recognition"()
returns trigger language plpgsql as $application_recognition$
declare recognized date;
begin
 select coalesce(recognition_date,document_date) into recognized
 from erp_financials.subledger_documents
 where tenant_id=new.tenant_id and company_id=new.company_id and source_id=new.source_id
  and subledger_document_id=new.target_document_id and document_type='invoice' for share;
 if found and new.application_date<recognized then
  raise exception 'invoice application cannot precede recognition';
 end if;
 return new;
end;
$application_recognition$;
create trigger "invoice_application_recognition_guard" before insert on "erp_financials"."subledger_applications"
for each row execute function "erp_financials"."guard_invoice_application_recognition"();
