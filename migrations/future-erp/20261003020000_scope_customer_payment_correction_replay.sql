-- Schema only: preserve the released v26 checksum and replace its source-wide gate.
-- A local correction is immutable accounting history, never a provider deletion.
create function erp_financials.customer_payment_correction_protects(n text, r jsonb)
returns boolean language sql stable as $$
  select exists (
    select 1 from erp_financials.customer_payment_corrections c
    join erp_financials.imported_customer_payment_evidence e
      using (tenant_id, company_id, source_id, payment_id)
    where c.tenant_id=r->>'tenant_id' and c.source_id=r->>'source_id' and (
      (n in ('transactions','transaction_lines','ledger_postings','bank_reconciliation_matches') and (
        (e.evidence->'transactionIds') ? (r->>'transaction_id') or
        (c.result->'reversalTransactionIds') ? (r->>'transaction_id') or
        (r->>'source_transaction_type'='QuickBooksGeneralLedger:Payment' and r->>'source_transaction_id' in
          ('accrual:Payment:' || (e.evidence->>'sourceTransactionId') || ':' || (r->>'transaction_date'),
           'cash:Payment:' || (e.evidence->>'sourceTransactionId') || ':' || (r->>'transaction_date'))) or
        (r->>'source_transaction_type'='Payment' and r->>'source_transaction_id'=e.evidence->>'sourceTransactionId') or
        (r->'source_payload_ref'->>'sourceObjectType'='Payment' and r->'source_payload_ref'->>'sourceObjectId'=e.evidence->>'sourceTransactionId')
      )) or
      (n in ('subledger_documents','subledger_document_lines') and (
        c.payment_id=r->>'subledger_document_id' or
        (r->'metadata'->>'sourceTransactionType'='Payment' and r->'metadata'->>'sourceTransactionId'=e.evidence->>'sourceTransactionId')
      )) or
      (n='subledger_applications' and (
        c.payment_id in (r->>'source_document_id',r->>'target_document_id') or
        (c.result->'endedApplicationIds') ? (r->>'subledger_application_id')
      )) or
      (n='imported_customer_payment_evidence' and c.payment_id=r->>'payment_id')
    )
  )
$$;

create or replace function erp_financials.guard_customer_payment_correction_source()
returns trigger language plpgsql as $$
declare r jsonb;
begin
  -- Check BOTH identities on UPDATE, so a row cannot escape by moving scope or
  -- its transaction/document foreign key. Locking is shared with correction.
  for r in select value from jsonb_array_elements(case
    when tg_op='INSERT' then jsonb_build_array(to_jsonb(new))
    when tg_op='DELETE' then jsonb_build_array(to_jsonb(old))
    else jsonb_build_array(to_jsonb(old),to_jsonb(new)) end)
  loop
    perform pg_advisory_xact_lock(hashtextextended('payment-correction:' || (r->>'tenant_id') || ':' || (r->>'source_id'),0));
    if erp_financials.customer_payment_correction_protects(tg_table_name,r) then
      raise exception 'customer_payment_corrected_record: provider dependency requires explicit reconciliation of this Payment identity';
    end if;
  end loop;
  return case when tg_op='DELETE' then old else new end;
end $$;
create trigger payment_correction_source_guard before insert or update or delete on erp_financials.subledger_document_lines
  for each row execute function erp_financials.guard_customer_payment_correction_source();
