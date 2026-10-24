create table "erp_financials"."accounting_source_revisions" (
 "tenant_id" text not null,
 "source_id" text not null,
 "effective_date" date not null,
 "revision" numeric not null,
 constraint "accounting_source_revisions_pkey" primary key ("tenant_id","source_id","effective_date"),
 constraint "accounting_source_revisions_value_check" check (revision > 0 and revision = trunc(revision) and revision::text not in ('NaN','Infinity','-Infinity')),
 constraint "accounting_source_revisions_source_fk" foreign key ("tenant_id","source_id") references "erp_financials"."accounting_sources" ("tenant_id","source_id") on update restrict on delete restrict
);
create function erp_financials.guard_accounting_source_revision() returns trigger language plpgsql as $$
begin
 if tg_op='DELETE' or pg_trigger_depth()<2 then raise exception 'accounting revision is database managed'; end if;
 if tg_op='INSERT' then
   if new.revision<>1 then raise exception 'accounting revision must begin at one'; end if;
 elsif (new.tenant_id,new.source_id,new.effective_date) is distinct from (old.tenant_id,old.source_id,old.effective_date) or new.revision<>old.revision+1 then
   raise exception 'accounting revision must advance exactly once';
 end if;
 return new;
end $$;
create trigger accounting_source_revision_guard before insert or update or delete on erp_financials.accounting_source_revisions for each row execute function erp_financials.guard_accounting_source_revision();

-- Transition tables keep the counter cost per affected source/date per SQL statement,
-- not per ledger row. Equal UPDATEs and zero-row statements do not invalidate a
-- review. Existing row guards hold the correction source lock through commit.
create function erp_financials.advance_accounting_source_revision() returns trigger language plpgsql as $$
declare scope record; changed text; dated text; date_column text;
begin
 if tg_op='INSERT' then changed := 'select * from revision_new';
 elsif tg_op='DELETE' then changed := 'select * from revision_old';
 else changed := '(select * from revision_new except all select * from revision_old)
   union all (select * from revision_old except all select * from revision_new)'; end if;
 date_column := case tg_table_name
   when 'ledger_postings' then 'posting_date' when 'transactions' then 'transaction_date'
   when 'subledger_documents' then 'document_date' when 'invoice_drafts' then 'document_date'
   when 'subledger_applications' then 'application_date' when 'bank_statements' then 'statement_date' end;
 if date_column is not null then
   dated := 'select distinct r.tenant_id,r.source_id,r.'||quote_ident(date_column)||' effective_date from ('||changed||') r';
 elsif tg_table_name='transaction_lines' then
   dated := 'select distinct r.tenant_id,r.source_id,coalesce(p.transaction_date,date ''0001-01-01'') effective_date from ('||changed||') r
     left join erp_financials.transactions p on p.tenant_id=r.tenant_id and p.source_id=r.source_id and p.transaction_id=r.transaction_id';
 elsif tg_table_name='subledger_document_lines' then
   dated := 'select distinct r.tenant_id,r.source_id,coalesce(p.document_date,date ''0001-01-01'') effective_date from ('||changed||') r
     left join erp_financials.subledger_documents p on p.tenant_id=r.tenant_id and p.source_id=r.source_id and p.subledger_document_id=r.subledger_document_id';
 else raise exception 'unsupported accounting revision table'; end if;
 for scope in execute dated || ' order by tenant_id,source_id,effective_date' loop
   insert into erp_financials.accounting_source_revisions(tenant_id,source_id,effective_date,revision) values(scope.tenant_id,scope.source_id,scope.effective_date,1)
   on conflict(tenant_id,source_id,effective_date) do update set revision=erp_financials.accounting_source_revisions.revision+1;
 end loop;
 return null;
end $$;
create trigger accounting_revision_insert after insert on erp_financials.transactions referencing new table as revision_new for each statement execute function erp_financials.advance_accounting_source_revision();
create trigger accounting_revision_update after update on erp_financials.transactions referencing old table as revision_old new table as revision_new for each statement execute function erp_financials.advance_accounting_source_revision();
create trigger accounting_revision_delete after delete on erp_financials.transactions referencing old table as revision_old for each statement execute function erp_financials.advance_accounting_source_revision();
create trigger accounting_revision_insert after insert on erp_financials.transaction_lines referencing new table as revision_new for each statement execute function erp_financials.advance_accounting_source_revision();
create trigger accounting_revision_update after update on erp_financials.transaction_lines referencing old table as revision_old new table as revision_new for each statement execute function erp_financials.advance_accounting_source_revision();
create trigger accounting_revision_delete after delete on erp_financials.transaction_lines referencing old table as revision_old for each statement execute function erp_financials.advance_accounting_source_revision();
create trigger accounting_revision_insert after insert on erp_financials.ledger_postings referencing new table as revision_new for each statement execute function erp_financials.advance_accounting_source_revision();
create trigger accounting_revision_update after update on erp_financials.ledger_postings referencing old table as revision_old new table as revision_new for each statement execute function erp_financials.advance_accounting_source_revision();
create trigger accounting_revision_delete after delete on erp_financials.ledger_postings referencing old table as revision_old for each statement execute function erp_financials.advance_accounting_source_revision();
create trigger accounting_revision_insert after insert on erp_financials.subledger_documents referencing new table as revision_new for each statement execute function erp_financials.advance_accounting_source_revision();
create trigger accounting_revision_update after update on erp_financials.subledger_documents referencing old table as revision_old new table as revision_new for each statement execute function erp_financials.advance_accounting_source_revision();
create trigger accounting_revision_delete after delete on erp_financials.subledger_documents referencing old table as revision_old for each statement execute function erp_financials.advance_accounting_source_revision();
create trigger accounting_revision_insert after insert on erp_financials.subledger_document_lines referencing new table as revision_new for each statement execute function erp_financials.advance_accounting_source_revision();
create trigger accounting_revision_update after update on erp_financials.subledger_document_lines referencing old table as revision_old new table as revision_new for each statement execute function erp_financials.advance_accounting_source_revision();
create trigger accounting_revision_delete after delete on erp_financials.subledger_document_lines referencing old table as revision_old for each statement execute function erp_financials.advance_accounting_source_revision();
create trigger accounting_revision_insert after insert on erp_financials.subledger_applications referencing new table as revision_new for each statement execute function erp_financials.advance_accounting_source_revision();
create trigger accounting_revision_update after update on erp_financials.subledger_applications referencing old table as revision_old new table as revision_new for each statement execute function erp_financials.advance_accounting_source_revision();
create trigger accounting_revision_delete after delete on erp_financials.subledger_applications referencing old table as revision_old for each statement execute function erp_financials.advance_accounting_source_revision();
create trigger accounting_revision_insert after insert on erp_financials.invoice_drafts referencing new table as revision_new for each statement execute function erp_financials.advance_accounting_source_revision();
create trigger accounting_revision_update after update on erp_financials.invoice_drafts referencing old table as revision_old new table as revision_new for each statement execute function erp_financials.advance_accounting_source_revision();
create trigger accounting_revision_delete after delete on erp_financials.invoice_drafts referencing old table as revision_old for each statement execute function erp_financials.advance_accounting_source_revision();
create trigger accounting_revision_insert after insert on erp_financials.bank_statements referencing new table as revision_new for each statement execute function erp_financials.advance_accounting_source_revision();
create trigger accounting_revision_update after update on erp_financials.bank_statements referencing old table as revision_old new table as revision_new for each statement execute function erp_financials.advance_accounting_source_revision();
create trigger accounting_revision_delete after delete on erp_financials.bank_statements referencing old table as revision_old for each statement execute function erp_financials.advance_accounting_source_revision();

create function erp_financials.assert_close_review_revision() returns trigger language plpgsql as $$
begin
 if new.diagnostics->>'sourceRevision' is distinct from (select coalesce(sum(revision),0)::text from erp_financials.accounting_source_revisions where tenant_id=new.tenant_id and source_id=new.source_id and effective_date<=(new.diagnostics->>'periodEnd')::date)
   or coalesce(new.diagnostics->>'approvalToken','') !~ '^[a-f0-9]{64}$'
 then raise exception 'canonical close review revision changed'; end if;
 return new;
end $$;
create constraint trigger close_review_revision_guard after insert on erp_financials.fiscal_close_certificates deferrable initially deferred for each row execute function erp_financials.assert_close_review_revision();
