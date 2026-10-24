-- Bound invoice register/receipt cursors to draft line and delivery changes.
-- No data rewrite; future statements advance existing database-managed counters.
create or replace function erp_financials.advance_accounting_source_revision() returns trigger language plpgsql as $$
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
 elsif tg_table_name in ('subledger_document_lines','subledger_document_delivery_events') then
   dated := 'select distinct r.tenant_id,r.source_id,coalesce(p.document_date,date ''0001-01-01'') effective_date from ('||changed||') r
     left join erp_financials.subledger_documents p on p.tenant_id=r.tenant_id and p.source_id=r.source_id and p.subledger_document_id=r.subledger_document_id';
 elsif tg_table_name='invoice_draft_lines' then
   dated := 'select distinct r.tenant_id,r.source_id,coalesce(p.document_date,date ''0001-01-01'') effective_date from ('||changed||') r
     left join erp_financials.invoice_drafts p on p.tenant_id=r.tenant_id and p.company_id=r.company_id and p.book_id=r.book_id and p.source_id=r.source_id and p.invoice_draft_id=r.invoice_draft_id';
 else raise exception 'unsupported accounting revision table'; end if;
 for scope in execute dated || ' order by tenant_id,source_id,effective_date' loop
   insert into erp_financials.accounting_source_revisions(tenant_id,source_id,effective_date,revision) values(scope.tenant_id,scope.source_id,scope.effective_date,1)
   on conflict(tenant_id,source_id,effective_date) do update set revision=erp_financials.accounting_source_revisions.revision+1;
 end loop;
 return null;
end $$;
create trigger accounting_revision_insert after insert on erp_financials.invoice_draft_lines referencing new table as revision_new for each statement execute function erp_financials.advance_accounting_source_revision();
create trigger accounting_revision_update after update on erp_financials.invoice_draft_lines referencing old table as revision_old new table as revision_new for each statement execute function erp_financials.advance_accounting_source_revision();
create trigger accounting_revision_delete after delete on erp_financials.invoice_draft_lines referencing old table as revision_old for each statement execute function erp_financials.advance_accounting_source_revision();
create trigger accounting_revision_insert after insert on erp_financials.subledger_document_delivery_events referencing new table as revision_new for each statement execute function erp_financials.advance_accounting_source_revision();
create trigger accounting_revision_update after update on erp_financials.subledger_document_delivery_events referencing old table as revision_old new table as revision_new for each statement execute function erp_financials.advance_accounting_source_revision();
create trigger accounting_revision_delete after delete on erp_financials.subledger_document_delivery_events referencing old table as revision_old for each statement execute function erp_financials.advance_accounting_source_revision();
