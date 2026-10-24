-- Append-only classification evidence. No cash, balance or original posting is rewritten.
create table "erp_financials"."cash_flow_purpose_corrections" (
  "tenant_id" text not null,
  "company_id" text not null,
  "source_id" text not null,
  "document_id" text not null,
  "revision" integer not null,
  "book_id" text not null,
  "operating" numeric not null,
  "investing" numeric not null,
  "financing" numeric not null,
  "lifecycle_event_id" text not null,
  constraint "cash_flow_purpose_corrections_pkey" primary key ("tenant_id", "company_id", "source_id", "document_id", "revision"),
  constraint "cash_flow_purpose_document_fk" foreign key ("tenant_id", "company_id", "source_id", "document_id") references "erp_financials"."subledger_documents" ("tenant_id", "company_id", "source_id", "subledger_document_id") on update restrict on delete restrict,
  constraint "cash_flow_purpose_event_fk" foreign key ("tenant_id", "company_id", "source_id", "lifecycle_event_id") references "erp_financials"."financial_lifecycle_events" ("tenant_id", "company_id", "source_id", "event_id") on update restrict on delete restrict,
  constraint "cash_flow_purpose_book_fk" foreign key ("tenant_id", "company_id", "book_id") references "erp_financials"."reporting_books" ("tenant_id", "company_id", "book_id") on update restrict on delete restrict,
  constraint "cash_flow_purpose_amounts_check" check (revision>0 and operating>=0 and investing>=0 and financing>=0 and operating+investing+financing>0 and operating+investing+financing<1e18 and operating=trunc(operating,2) and investing=trunc(investing,2) and financing=trunc(financing,2))
);
create function erp_financials.cash_flow_purpose_affected_dates(t text,c text,s text,doc text)
returns table(cash_date date) language sql stable as $$
 with original as (select document_date,transaction_id from erp_financials.subledger_documents where tenant_id=t and company_id=c and source_id=s and subledger_document_id=doc)
 select document_date from original union
 select r.document_date from erp_financials.subledger_applications a
 join erp_financials.subledger_documents r on r.tenant_id=a.tenant_id and r.company_id=a.company_id and r.source_id=a.source_id and r.subledger_document_id=a.target_document_id
 where a.tenant_id=t and a.company_id=c and a.source_id=s and a.source_document_id=doc and a.status='applied' and a.application_type='customer_payment_to_refund'
   and r.document_type='refund' and r.metadata->'customerPaymentReturn'->>'paymentId'=doc union
 select h.transaction_date from original d join erp_financials.journal_entry_links l on l.tenant_id=t and l.company_id=c and l.source_id=s and l.original_transaction_id=d.transaction_id
 join erp_financials.transactions h on h.tenant_id=t and h.source_id=s and h.transaction_id=l.related_transaction_id where l.link_type='void'
$$;
create function erp_financials.guard_cash_flow_purpose() returns trigger language plpgsql as $$
declare d record; e record; prior integer; affected date; lock_date date;
begin
 if tg_op<>'INSERT' then raise exception 'Cash purpose corrections are immutable'; end if;
 perform pg_advisory_xact_lock(hashtextextended('payment-correction:'||new.tenant_id||':'||new.source_id,0));
 perform pg_advisory_xact_lock_shared(hashtextextended('fiscal-period:'||new.tenant_id||':'||new.company_id||':'||new.source_id,0));
 select * into d from erp_financials.subledger_documents where tenant_id=new.tenant_id and company_id=new.company_id and source_id=new.source_id and subledger_document_id=new.document_id for key share;
 if d.document_type not in ('customer_payment','bill_payment') or d.original_amount<>new.operating+new.investing+new.financing
   or (d.document_type='customer_payment' and ((new.operating>0)::integer+(new.investing>0)::integer+(new.financing>0)::integer)<>1)
   or not exists(select 1 from erp_financials.financial_outbox where tenant_id=new.tenant_id and company_id=new.company_id and source_id=new.source_id and book_id=new.book_id
     and aggregate_id=d.transaction_id and event_type='ledger.posted' and idempotency_key='ledger-posted:Subledger:'||d.document_type||':'||d.idempotency_key)
   or exists(select 1 from erp_financials.customer_payment_corrections where tenant_id=new.tenant_id and source_id=new.source_id and payment_id=new.document_id)
 then raise exception 'Cash purpose requires matching native cash evidence'; end if;
 select coalesce(max(revision),0) into prior from erp_financials.cash_flow_purpose_corrections where tenant_id=new.tenant_id and company_id=new.company_id and source_id=new.source_id and document_id=new.document_id;
 if new.revision<>prior+1 then raise exception 'Cash purpose revision must advance exactly once'; end if;
 select * into e from erp_financials.financial_lifecycle_events where tenant_id=new.tenant_id and company_id=new.company_id and source_id=new.source_id and event_id=new.lifecycle_event_id;
 if e.event_type is distinct from 'cash_flow_purpose.corrected' or e.aggregate_type is distinct from 'cash_flow_purpose' or e.aggregate_id is distinct from new.document_id
   or e.payload->'result' is distinct from jsonb_build_object('documentId',new.document_id,'revision',new.revision,'operating',to_char(new.operating,'FM999999999999999990.00'),'investing',to_char(new.investing,'FM999999999999999990.00'),'financing',to_char(new.financing,'FM999999999999999990.00'))
 then raise exception 'Cash purpose correction requires matching lifecycle evidence'; end if;
 select posting_lock_date into lock_date from erp_financials.accounting_book_controls where tenant_id=new.tenant_id and company_id=new.company_id and source_id=new.source_id;
 -- Return/void periods are affected as well as the original cash period. All
 -- dates remain in SQL; a receipt with many partial returns is not collected by JS.
 for affected in
   select cash_date from erp_financials.cash_flow_purpose_affected_dates(new.tenant_id,new.company_id,new.source_id,new.document_id)
 loop
   if affected<=lock_date or not exists(select 1 from erp_financials.fiscal_periods p where p.tenant_id=new.tenant_id and p.company_id=new.company_id and p.source_id=new.source_id
     and affected between p.period_start and p.period_end and p.status='open') then raise exception 'Cash purpose correction requires every affected cash period to be open'; end if;
 end loop;
 return new;
end $$;
create trigger cash_flow_purpose_guard before insert or update or delete on erp_financials.cash_flow_purpose_corrections for each row execute function erp_financials.guard_cash_flow_purpose();
create function erp_financials.advance_cash_flow_purpose_revision() returns trigger language plpgsql as $$
begin
 -- Purpose changes invalidate outstanding source close reviews, even though GL
 -- amounts are unchanged. Counters remain database-owned and transactional.
 insert into erp_financials.accounting_source_revisions(tenant_id,source_id,effective_date,revision)
 select new.tenant_id,new.source_id,document_date,1 from erp_financials.subledger_documents where tenant_id=new.tenant_id and company_id=new.company_id and source_id=new.source_id and subledger_document_id=new.document_id
 on conflict(tenant_id,source_id,effective_date) do update set revision=erp_financials.accounting_source_revisions.revision+1;
 return null;
end $$;
create trigger cash_flow_purpose_revision after insert on erp_financials.cash_flow_purpose_corrections for each row execute function erp_financials.advance_cash_flow_purpose_revision();
