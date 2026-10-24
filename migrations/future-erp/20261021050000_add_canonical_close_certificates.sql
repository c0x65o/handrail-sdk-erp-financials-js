create table "erp_financials"."fiscal_close_certificates" (
 "certificate_id" text not null,
 "tenant_id" text not null,
 "company_id" text not null,
 "source_id" text not null,
 "book_id" text not null,
 "accounting_basis" text not null,
 "currency_code" text not null,
 "fiscal_period_id" text not null,
 "idempotency_key" text not null,
 "command_checksum" text not null,
 "expected_version" integer not null,
 "bank_count" integer not null,
 "captured_at" timestamptz not null,
 "creation_txid" text not null,
 "close_event_id" text not null,
 "diagnostics" jsonb not null,
 "result" jsonb not null,
 constraint "fiscal_close_certificates_pkey" primary key ("certificate_id"),
 constraint "fiscal_close_certificates_version_check" check (expected_version >= 1 and bank_count between 0 and 200),
 constraint "fiscal_close_certificates_checksum_check" check (command_checksum ~ '^[a-f0-9]{64}$'),
 constraint "fiscal_close_certificates_period_fk" foreign key ("fiscal_period_id") references "erp_financials"."fiscal_periods" ("fiscal_period_id") on update restrict on delete restrict,
 constraint "fiscal_close_certificates_event_fk" foreign key ("close_event_id") references "erp_financials"."financial_lifecycle_events" ("event_id") on update restrict on delete restrict,
 constraint "fiscal_close_certificates_book_scope_fk" foreign key ("tenant_id", "company_id", "book_id", "source_id") references "erp_financials"."reporting_book_sources" ("tenant_id", "company_id", "book_id", "source_id") on update restrict on delete restrict,
 constraint "fiscal_close_certificates_diagnostics_bounded_json_check" check (octet_length(coalesce("diagnostics"::text, '')) <= 8192),
 constraint "fiscal_close_certificates_result_bounded_json_check" check (octet_length(coalesce("result"::text, '')) <= 8192)
);

create unique index "fiscal_close_certificates_scope_uidx" on "erp_financials"."fiscal_close_certificates" ("tenant_id", "company_id", "source_id", "certificate_id");

create unique index "fiscal_close_certificates_command_uidx" on "erp_financials"."fiscal_close_certificates" ("tenant_id", "company_id", "source_id", "idempotency_key");

create table "erp_financials"."fiscal_close_totals" (
 "total_id" text not null,
 "tenant_id" text not null,
 "company_id" text not null,
 "source_id" text not null,
 "certificate_id" text not null,
 "account_id" text not null,
 "accounting_basis" text not null,
 "currency_code" text not null,
 "opening_net" numeric not null,
 "debit_amount" numeric not null,
 "credit_amount" numeric not null,
 "closing_net" numeric not null,
 "posting_count" numeric not null,
 "historical_posting_count" numeric not null,
 constraint "fiscal_close_totals_pkey" primary key ("total_id"),
 constraint "fiscal_close_totals_certificate_scope_fk" foreign key ("tenant_id", "company_id", "source_id", "certificate_id") references "erp_financials"."fiscal_close_certificates" ("tenant_id", "company_id", "source_id", "certificate_id") on update restrict on delete restrict,
 constraint "fiscal_close_totals_account_scope_fk" foreign key ("tenant_id", "source_id", "account_id") references "erp_financials"."accounts" ("tenant_id", "source_id", "account_id") on update restrict on delete restrict,
 constraint "fiscal_close_totals_amount_check" check (debit_amount >= 0 and credit_amount >= 0 and closing_net = opening_net + debit_amount - credit_amount and opening_net::text not in ('NaN','Infinity','-Infinity') and closing_net::text not in ('NaN','Infinity','-Infinity') and debit_amount::text not in ('NaN','Infinity','-Infinity') and credit_amount::text not in ('NaN','Infinity','-Infinity')),
 constraint "fiscal_close_totals_count_check" check (posting_count >= 0 and posting_count = trunc(posting_count) and historical_posting_count > 0 and historical_posting_count = trunc(historical_posting_count) and posting_count <= historical_posting_count and historical_posting_count::text not in ('NaN','Infinity','-Infinity'))
);

create unique index "fiscal_close_totals_page_uidx" on "erp_financials"."fiscal_close_totals" ("tenant_id", "company_id", "source_id", "certificate_id", "account_id", "accounting_basis", "currency_code");

create table "erp_financials"."fiscal_close_banks" (
 "bank_check_id" text not null,
 "tenant_id" text not null,
 "company_id" text not null,
 "source_id" text not null,
 "certificate_id" text not null,
 "account_id" text not null,
 "has_activity" boolean not null,
 "statement_id" text,
 "statement_version" integer,
 "statement_event_id" text,
 constraint "fiscal_close_banks_pkey" primary key ("bank_check_id"),
 constraint "fiscal_close_banks_certificate_scope_fk" foreign key ("tenant_id", "company_id", "source_id", "certificate_id") references "erp_financials"."fiscal_close_certificates" ("tenant_id", "company_id", "source_id", "certificate_id") on update restrict on delete restrict,
 constraint "fiscal_close_banks_account_scope_fk" foreign key ("tenant_id", "source_id", "account_id") references "erp_financials"."accounts" ("tenant_id", "source_id", "account_id") on update restrict on delete restrict,
 constraint "fiscal_close_banks_statement_fk" foreign key ("statement_id") references "erp_financials"."bank_statements" ("statement_id") on update restrict on delete restrict,
 constraint "fiscal_close_banks_event_fk" foreign key ("statement_event_id") references "erp_financials"."financial_lifecycle_events" ("event_id") on update restrict on delete restrict,
 constraint "fiscal_close_banks_shape_check" check ((has_activity and statement_id is not null and statement_version > 0 and statement_event_id is not null) or (not has_activity and statement_id is null and statement_version is null and statement_event_id is null))
);

create unique index "fiscal_close_banks_page_uidx" on "erp_financials"."fiscal_close_banks" ("tenant_id", "company_id", "source_id", "certificate_id", "account_id");

create function erp_financials.guard_close_certificate_write() returns trigger language plpgsql as $$
declare seal text;
begin
 if tg_op <> 'INSERT' then raise exception 'canonical close evidence is immutable'; end if;
 if tg_table_name='fiscal_close_certificates' then
   perform pg_advisory_xact_lock(hashtextextended('payment-correction:'||new.tenant_id||':'||new.source_id,0));
   perform pg_advisory_xact_lock(hashtextextended('fiscal-period:'||new.tenant_id||':'||new.company_id||':'||new.source_id,0));
   seal := new.creation_txid;
 else
   select creation_txid into seal from erp_financials.fiscal_close_certificates
    where tenant_id=new.tenant_id and company_id=new.company_id and source_id=new.source_id and certificate_id=new.certificate_id for key share;
 end if;
 if seal is distinct from txid_current()::text then raise exception 'close evidence can only be inserted in its capture transaction'; end if;
 return new;
end $$;
create trigger close_certificate_write_guard before insert or update or delete on erp_financials.fiscal_close_certificates for each row execute function erp_financials.guard_close_certificate_write();
create trigger close_totals_write_guard before insert or update or delete on erp_financials.fiscal_close_totals for each row execute function erp_financials.guard_close_certificate_write();
create trigger close_banks_write_guard before insert or update or delete on erp_financials.fiscal_close_banks for each row execute function erp_financials.guard_close_certificate_write();

create function erp_financials.assert_close_certificate_complete() returns trigger language plpgsql as $$
declare p erp_financials.fiscal_periods%rowtype; e erp_financials.financial_lifecycle_events%rowtype;
begin
 select * into p from erp_financials.fiscal_periods where fiscal_period_id=new.fiscal_period_id;
 select * into e from erp_financials.financial_lifecycle_events where event_id=new.close_event_id;
 if (p.tenant_id,p.company_id,p.source_id,p.status,p.close_event_id,p.version) is distinct from
    (new.tenant_id,new.company_id,new.source_id,'closed'::text,new.close_event_id,new.expected_version+1)
   or (e.tenant_id,e.company_id,e.source_id,e.aggregate_type,e.aggregate_id,e.event_type) is distinct from
    (new.tenant_id,new.company_id,new.source_id,'fiscal_period'::text,new.fiscal_period_id,'fiscal_period.closed'::text)
   or e.payload->>'canonicalCloseCertificateId' is distinct from new.certificate_id
   or e.payload->>'commandChecksum' is distinct from new.command_checksum
   or new.result->>'certificateId' is distinct from new.certificate_id
   or new.result->>'lifecycleEventId' is distinct from new.close_event_id
   or (new.result->>'version')::integer is distinct from p.version
   or new.result->>'status' is distinct from 'closed'
   or new.result->>'fiscalPeriodId' is distinct from p.fiscal_period_id
   or new.diagnostics->>'fiscalPeriodId' is distinct from p.fiscal_period_id
   or new.diagnostics->>'sourceId' is distinct from p.source_id
   or (new.diagnostics->>'version')::integer is distinct from new.expected_version
   or (new.diagnostics->>'periodStart')::date is distinct from p.period_start
   or (new.diagnostics->>'periodEnd')::date is distinct from p.period_end
 then raise exception 'canonical close receipt does not match fiscal transition'; end if;
 if not exists(select 1 from erp_financials.reporting_books b where b.tenant_id=new.tenant_id and b.company_id=new.company_id
    and b.book_id=new.book_id and b.accounting_basis=new.accounting_basis and b.base_currency_code=new.currency_code and b.status='active')
   or new.diagnostics->>'draftTransactionCount' is distinct from '0'
   or new.diagnostics->>'draftInvoiceCount' is distinct from '0'
   or exists(select 1 from erp_financials.invoice_drafts d where d.tenant_id=new.tenant_id and d.company_id=new.company_id and d.source_id=new.source_id and d.status='draft' and d.document_date between p.period_start and p.period_end)
   or exists(select 1 from erp_financials.transactions d where d.tenant_id=new.tenant_id and d.source_id=new.source_id and d.status='draft' and d.transaction_date between p.period_start and p.period_end)
   or new.diagnostics->>'unbalancedPostingGroupCount' is distinct from '0'
   or (select count(*) from erp_financials.fiscal_close_banks where certificate_id=new.certificate_id) <> new.bank_count
 then raise exception 'canonical close certificate is incomplete'; end if;
 if exists(
   with actual as (
     select account_id,accounting_basis,currency_code,
       coalesce(sum(net_amount) filter(where posting_date<p.period_start),0) opening_net,
       coalesce(sum(debit_amount) filter(where posting_date>=p.period_start),0) debit_amount,
       coalesce(sum(credit_amount) filter(where posting_date>=p.period_start),0) credit_amount,
       sum(net_amount) closing_net,count(*) filter(where posting_date>=p.period_start) posting_count,count(*) historical_posting_count
     from erp_financials.ledger_postings where tenant_id=new.tenant_id and source_id=new.source_id and posting_date<=p.period_end
     group by account_id,accounting_basis,currency_code
   ), saved as (select * from erp_financials.fiscal_close_totals where certificate_id=new.certificate_id)
   select 1 from actual a full join saved s using(account_id,accounting_basis,currency_code)
   where a.account_id is null or s.account_id is null or (a.opening_net,a.debit_amount,a.credit_amount,a.closing_net,a.posting_count,a.historical_posting_count)
    is distinct from (s.opening_net,s.debit_amount,s.credit_amount,s.closing_net,s.posting_count,s.historical_posting_count)
 ) or (select coalesce(sum(posting_count),0) from erp_financials.fiscal_close_totals where certificate_id=new.certificate_id)
    is distinct from (new.diagnostics->>'postingCount')::numeric
 then raise exception 'canonical close control totals differ from ledger facts'; end if;
 if exists(select 1 from erp_financials.fiscal_close_banks b
   left join erp_financials.bank_statements s on s.statement_id=b.statement_id
   where b.certificate_id=new.certificate_id and (
    b.has_activity is distinct from exists(select 1 from erp_financials.ledger_postings l where l.tenant_id=new.tenant_id and l.source_id=new.source_id
     and l.account_id=b.account_id and l.accounting_basis=new.accounting_basis and l.currency_code=new.currency_code and l.posting_date<=p.period_end)
    or (b.has_activity and (s.tenant_id,s.company_id,s.source_id,s.book_id,s.account_id,s.accounting_basis,s.currency_code,s.statement_date,s.status,s.version,s.lifecycle_event_id)
      is distinct from (new.tenant_id,new.company_id,new.source_id,new.book_id,b.account_id,new.accounting_basis,new.currency_code,p.period_end,'completed'::text,b.statement_version,b.statement_event_id))
   )) then raise exception 'canonical close bank evidence does not match cutoff'; end if;
 return new;
end $$;
create constraint trigger close_certificate_complete after insert on erp_financials.fiscal_close_certificates deferrable initially deferred for each row execute function erp_financials.assert_close_certificate_complete();

create trigger payment_correction_source_guard before insert or update or delete on erp_financials.invoice_drafts for each row execute function erp_financials.guard_customer_payment_correction_source();
