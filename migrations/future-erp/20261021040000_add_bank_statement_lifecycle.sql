-- Add canonical manual statement evidence without changing historical accounting facts.

create table "erp_financials"."bank_statements" (
 "statement_id" text not null,
 "tenant_id" text not null,
 "company_id" text not null,
 "book_id" text not null,
 "source_id" text not null,
 "account_id" text not null,
 "external_statement_id" text not null,
 "accounting_basis" text not null,
 "currency_code" text not null,
 "statement_date" date not null,
 "closing_balance" numeric not null,
 "opening_balance" numeric not null,
 "previous_statement_id" text,
 "status" text not null,
 "version" integer not null,
 "prepared_by" text not null,
 "completed_by" text,
 "lifecycle_event_id" text,
 "created_at" timestamptz not null,
 "updated_at" timestamptz not null,
 constraint "bank_statements_pkey" primary key ("statement_id"),
 constraint "bank_statements_money_check" check (closing_balance::text not in ('NaN','Infinity','-Infinity') and scale(closing_balance)<=2 and opening_balance::text not in ('NaN','Infinity','-Infinity') and scale(opening_balance)<=2),
 constraint "bank_statements_status_check" check (status in ('draft','completed','cancelled') and ((status in ('draft','cancelled') and completed_by is null) or (status='completed' and completed_by is not null and completed_by<>prepared_by))),
 constraint "bank_statements_version_check" check (version>=1),
 constraint "bank_statements_basis_check" check (accounting_basis in ('accrual','cash','modified_cash')),
 constraint "bank_statements_book_source_fk" foreign key ("tenant_id", "company_id", "book_id", "source_id") references "erp_financials"."reporting_book_sources" ("tenant_id", "company_id", "book_id", "source_id") on update restrict on delete restrict,
 constraint "bank_statements_account_fk" foreign key ("tenant_id", "source_id", "account_id") references "erp_financials"."accounts" ("tenant_id", "source_id", "account_id") on update restrict on delete restrict,
 constraint "bank_statements_event_fk" foreign key ("tenant_id", "company_id", "source_id", "lifecycle_event_id") references "erp_financials"."financial_lifecycle_events" ("tenant_id", "company_id", "source_id", "event_id") on update restrict on delete restrict
);

create unique index "bank_statements_scope_uidx" on erp_financials."bank_statements" ("tenant_id","company_id","book_id","source_id","statement_id");

create unique index "bank_statements_external_uidx" on erp_financials."bank_statements" ("tenant_id","company_id","book_id","source_id","external_statement_id");

create unique index "bank_statements_draft_uidx" on erp_financials."bank_statements" ("tenant_id","company_id","book_id","source_id","account_id") where status='draft';

create index "bank_statements_account_date_idx" on erp_financials."bank_statements" ("tenant_id","company_id","book_id","source_id","account_id","statement_date","statement_id");

create table "erp_financials"."bank_statement_clearings" (
 "clearing_id" text not null,
 "tenant_id" text not null,
 "company_id" text not null,
 "book_id" text not null,
 "source_id" text not null,
 "statement_id" text not null,
 "posting_id" text not null,
 "transaction_id" text not null,
 "account_id" text not null,
 "accounting_basis" text not null,
 "currency_code" text not null,
 "posting_date" date not null,
 "amount" numeric not null,
 constraint "bank_statement_clearings_pkey" primary key ("clearing_id"),
 constraint "bank_statement_clearings_money_check" check (amount<>0 and amount::text not in ('NaN','Infinity','-Infinity') and scale(amount)<=2),
 constraint "bank_statement_clearings_statement_fk" foreign key ("tenant_id", "company_id", "book_id", "source_id", "statement_id") references "erp_financials"."bank_statements" ("tenant_id", "company_id", "book_id", "source_id", "statement_id") on update restrict on delete restrict,
 constraint "bank_statement_clearings_posting_fk" foreign key ("posting_id") references "erp_financials"."ledger_postings" ("posting_id") on update restrict on delete restrict
);

create unique index "bank_statement_clearings_posting_uidx" on erp_financials."bank_statement_clearings" ("tenant_id","source_id","book_id","posting_id");

create index "bank_statement_clearings_statement_idx" on erp_financials."bank_statement_clearings" ("tenant_id","company_id","book_id","source_id","statement_id","posting_date","posting_id");

create index "bank_statement_clearings_transaction_idx" on erp_financials."bank_statement_clearings" ("tenant_id","source_id","transaction_id");

create function erp_financials.guard_bank_statement_write() returns trigger language plpgsql as $$
declare r jsonb; s erp_financials.bank_statements; p erp_financials.ledger_postings;
begin
  if tg_op='DELETE' then r=to_jsonb(old); else r=to_jsonb(new); end if;
  perform pg_advisory_xact_lock(hashtextextended('payment-correction:'||(r->>'tenant_id')||':'||(r->>'source_id'),0));
  if tg_table_name='bank_statements' then
    if tg_op='DELETE' then raise exception 'bank statement history cannot be deleted'; end if;
    if tg_op='UPDATE' then
      if (to_jsonb(new)-array['statement_date','closing_balance','status','version','prepared_by','completed_by','lifecycle_event_id','updated_at'])
        <> (to_jsonb(old)-array['statement_date','closing_balance','status','version','prepared_by','completed_by','lifecycle_event_id','updated_at']) then
        raise exception 'bank statement identity and prior chain are immutable'; end if;
      if new.version=old.version and (to_jsonb(new)-'lifecycle_event_id')=(to_jsonb(old)-'lifecycle_event_id') then return new; end if;
      if new.version=old.version and old.status='draft' and new.status='cancelled'
        and (to_jsonb(new)-array['status','updated_at'])=(to_jsonb(old)-array['status','updated_at'])
        and exists(select 1 from erp_financials.financial_lifecycle_events e where e.event_id=old.lifecycle_event_id and (e.payload#>>'{result,version}')::integer<>old.version)
      then return new; end if;
      if new.version<>old.version+1 then raise exception 'bank statement requires next version'; end if;
      if old.status='cancelled' then raise exception 'cancelled statement is immutable'; end if;
      if old.status='completed' then
        if new.status<>'draft' or new.prepared_by<>old.prepared_by or new.statement_date<>old.statement_date or new.closing_balance<>old.closing_balance then
          raise exception 'completed statement must be explicitly reopened before editing'; end if;
        if exists(select 1 from erp_financials.bank_statements where previous_statement_id=old.statement_id and status<>'cancelled') then raise exception 'later statement depends on completion'; end if;
      end if;
    elsif new.status<>'draft' or new.version<>1 then raise exception 'bank statement must start as draft version1'; end if;
    s=new;
  else
    select * into strict s from erp_financials.bank_statements where statement_id=r->>'statement_id' for update;
    if s.status<>'draft' then raise exception 'completed statement clearings are immutable'; end if;
    if exists(select 1 from erp_financials.financial_lifecycle_events e where e.event_id=s.lifecycle_event_id and (e.payload#>>'{result,version}')::integer=s.version) then
      raise exception 'statement selection changes require a pending new version'; end if;
    if tg_op='UPDATE' then raise exception 'clearing identity is immutable; remove and add within a draft'; end if;
    if tg_op='INSERT' then
      select * into strict p from erp_financials.ledger_postings where posting_id=new.posting_id for key share;
      if (new.tenant_id,new.company_id,new.book_id,new.source_id,new.account_id,new.accounting_basis,new.currency_code)
        is distinct from (s.tenant_id,s.company_id,s.book_id,s.source_id,s.account_id,s.accounting_basis,s.currency_code)
        or (new.tenant_id,new.source_id,new.transaction_id,new.account_id,new.accounting_basis,new.currency_code,new.posting_date,new.amount)
        is distinct from (p.tenant_id,p.source_id,p.transaction_id,p.account_id,p.accounting_basis,p.currency_code,p.posting_date,p.net_amount)
        or p.posting_date>s.statement_date then raise exception 'clearing must exactly identify an eligible canonical posting'; end if;
      if not exists(select 1 from erp_financials.transactions t where t.tenant_id=p.tenant_id and t.source_id=p.source_id and t.transaction_id=p.transaction_id and t.status='posted')
        or exists(select 1 from erp_financials.journal_entry_links l where l.tenant_id=p.tenant_id and l.source_id=p.source_id and l.original_transaction_id=p.transaction_id and l.link_type in ('void','reversal')) then
        raise exception 'retired or reversed transactions cannot become new statement clearings'; end if;
    end if;
  end if;
  perform pg_advisory_xact_lock_shared(hashtextextended('fiscal-period:'||s.tenant_id||':'||s.company_id||':'||s.source_id,0));
  if not exists(select 1 from erp_financials.fiscal_periods f where f.tenant_id=s.tenant_id and f.company_id=s.company_id and f.source_id=s.source_id and s.statement_date between f.period_start and f.period_end and f.status='open')
    or exists(select 1 from erp_financials.accounting_book_controls c where c.tenant_id=s.tenant_id and c.company_id=s.company_id and c.source_id=s.source_id and s.statement_date<=c.posting_lock_date) then raise exception 'statement date must be in an unlocked open fiscal period'; end if;
  if tg_op='DELETE' then return old; end if; return new;
end $$;
create trigger bank_statement_write_guard before insert or update or delete on erp_financials.bank_statements for each row execute function erp_financials.guard_bank_statement_write();
create trigger bank_statement_clearing_write_guard before insert or update or delete on erp_financials.bank_statement_clearings for each row execute function erp_financials.guard_bank_statement_write();

create function erp_financials.assert_bank_statement_evidence() returns trigger language plpgsql as $$
declare s erp_financials.bank_statements; prior erp_financials.bank_statements; e erp_financials.financial_lifecycle_events; total numeric; selected_count bigint; opening numeric=0;
begin
  select * into strict s from erp_financials.bank_statements where statement_id=case when tg_op='DELETE' then old.statement_id else new.statement_id end;
  select * into e from erp_financials.financial_lifecycle_events where event_id=s.lifecycle_event_id;
  if e.event_id is null or e.aggregate_type<>'bank_statement' or e.aggregate_id<>s.statement_id
    or (e.tenant_id,e.company_id,e.source_id) is distinct from (s.tenant_id,s.company_id,s.source_id)
    or (e.payload#>>'{result,version}')::integer is distinct from s.version
    or e.payload#>>'{result,status}' is distinct from s.status
    or e.payload#>>'{result,statementDate}' is distinct from s.statement_date::text
    or (e.payload#>>'{result,closingBalance}')::numeric is distinct from s.closing_balance
    or e.payload#>>'{result,preparedBy}' is distinct from s.prepared_by
    or e.payload#>>'{result,completedBy}' is distinct from s.completed_by then raise exception 'bank statement requires matching canonical lifecycle evidence'; end if;
  if s.previous_statement_id is not null then
    select * into prior from erp_financials.bank_statements where statement_id=s.previous_statement_id;
    if prior.statement_id is null or (s.status<>'cancelled' and (prior.status<>'completed' or prior.statement_date>=s.statement_date or prior.closing_balance<>s.opening_balance))
      or (prior.tenant_id,prior.company_id,prior.book_id,prior.source_id,prior.account_id,prior.accounting_basis,prior.currency_code)
        is distinct from (s.tenant_id,s.company_id,s.book_id,s.source_id,s.account_id,s.accounting_basis,s.currency_code) then raise exception 'bank statement prior completion is invalid'; end if;
    opening=s.opening_balance;
  end if;
  select coalesce(sum(amount),0),count(*) into total,selected_count from erp_financials.bank_statement_clearings where statement_id=s.statement_id;
  if (e.payload#>>'{result,selectedAmount}')::numeric is distinct from total or (e.payload#>>'{result,selectedCount}')::bigint is distinct from selected_count
    or (e.payload#>>'{result,openingBalance}')::numeric is distinct from opening then raise exception 'bank statement clearing evidence differs'; end if;
  if s.previous_statement_id is null and s.opening_balance<>0 then raise exception 'first statement opening must come from canonical postings'; end if;
  if s.status='cancelled' and selected_count<>0 then raise exception 'cancelled statement cannot retain clearings'; end if;
  if s.status='completed' and (opening+total<>s.closing_balance or e.actor_ref<>s.completed_by) then raise exception 'completed statement must balance with actual completing actor'; end if;
  if exists(select 1 from erp_financials.bank_statement_clearings where statement_id=s.statement_id and posting_date>s.statement_date) then raise exception 'statement cutoff excludes clearing'; end if;
  return null;
end $$;
create constraint trigger bank_statement_evidence_guard after insert or update on erp_financials.bank_statements deferrable initially deferred for each row execute function erp_financials.assert_bank_statement_evidence();
create constraint trigger bank_statement_clearing_evidence_guard after insert or update or delete on erp_financials.bank_statement_clearings deferrable initially deferred for each row execute function erp_financials.assert_bank_statement_evidence();

create function erp_financials.guard_statement_cleared_fact() returns trigger language plpgsql as $$
declare t text; src text; txn text; r jsonb;
begin
  if tg_op='INSERT' then r=to_jsonb(new); else r=to_jsonb(old); end if;
  t=r->>'tenant_id'; src=r->>'source_id';
  perform pg_advisory_xact_lock(hashtextextended('payment-correction:'||t||':'||src,0));
  if tg_table_name='journal_entry_links' then
    if new.link_type not in ('void','reversal') then return new; end if; txn=new.original_transaction_id;
  else txn=r->>'transaction_id';
    if tg_op='UPDATE' and tg_table_name='transactions' then
      if new.status=old.status then return new; end if;
    end if;
    if tg_op='UPDATE' and tg_table_name='ledger_postings' and (to_jsonb(new)-array['updated_at','import_batch_id'])=(to_jsonb(old)-array['updated_at','import_batch_id']) then return new; end if;
  end if;
  if exists(select 1 from erp_financials.bank_statement_clearings c where c.tenant_id=t and c.source_id=src and c.transaction_id=txn) then raise exception 'statement-cleared accounting must be reopened and unselected before correction'; end if;
  if tg_op='DELETE' then return old; end if; return new;
end $$;
create trigger statement_cleared_posting_guard before update or delete on erp_financials.ledger_postings for each row execute function erp_financials.guard_statement_cleared_fact();
create trigger statement_cleared_transaction_guard before update or delete on erp_financials.transactions for each row execute function erp_financials.guard_statement_cleared_fact();
create trigger statement_cleared_reversal_guard before insert on erp_financials.journal_entry_links for each row execute function erp_financials.guard_statement_cleared_fact();

create index ledger_postings_bank_activity_idx on erp_financials.ledger_postings (tenant_id,source_id,account_id,accounting_basis,currency_code,posting_date,posting_id);

create table "erp_financials"."bank_statement_clearing_history" (
 "history_id" text not null,
 "tenant_id" text not null,
 "company_id" text not null,
 "book_id" text not null,
 "source_id" text not null,
 "statement_id" text not null,
 "posting_id" text not null,
 "transaction_id" text not null,
 "account_id" text not null,
 "accounting_basis" text not null,
 "currency_code" text not null,
 "posting_date" date not null,
 "amount" numeric not null,
 "statement_version" integer not null,
 "action" text not null,
 "lifecycle_event_id" text not null,
 constraint "bank_statement_clearing_history_pkey" primary key (history_id),
 constraint "bank_statement_clearing_history_action_check" check (action in ('added','removed') and statement_version>=1),
 constraint "bank_statement_clearing_history_money_check" check (amount<>0 and amount::text not in ('NaN','Infinity','-Infinity') and scale(amount)<=2),
 constraint "bank_statement_clearing_history_statement_fk" foreign key ("tenant_id", "company_id", "book_id", "source_id", "statement_id") references "erp_financials"."bank_statements" ("tenant_id", "company_id", "book_id", "source_id", "statement_id") on update restrict on delete restrict,
 constraint "bank_statement_clearing_history_event_fk" foreign key ("tenant_id", "company_id", "source_id", "lifecycle_event_id") references "erp_financials"."financial_lifecycle_events" ("tenant_id", "company_id", "source_id", "event_id") on update restrict on delete restrict
);

create index "bank_statement_clearing_history_page_idx" on erp_financials."bank_statement_clearing_history" ("tenant_id","company_id","book_id","source_id","statement_id","statement_version","history_id");

create unique index "bank_statement_clearing_history_event_uidx" on erp_financials."bank_statement_clearing_history" ("lifecycle_event_id","posting_id","action");

create function erp_financials.guard_bank_statement_history() returns trigger language plpgsql as $$
declare e erp_financials.financial_lifecycle_events;
begin
  if tg_op<>'INSERT' then raise exception 'statement clearing history is immutable'; end if;
  select * into e from erp_financials.financial_lifecycle_events where event_id=new.lifecycle_event_id;
  if e.aggregate_type<>'bank_statement' or e.aggregate_id<>new.statement_id
    or e.event_type not in ('bank_statement.prepared','bank_statement.cancelled')
    or (e.payload#>>'{result,version}')::integer<>new.statement_version
    or (e.tenant_id,e.company_id,e.source_id) is distinct from (new.tenant_id,new.company_id,new.source_id) then raise exception 'clearing history requires its statement command event'; end if;
  return new;
end $$;
create trigger bank_statement_history_guard before insert or update or delete on erp_financials.bank_statement_clearing_history for each row execute function erp_financials.guard_bank_statement_history();
