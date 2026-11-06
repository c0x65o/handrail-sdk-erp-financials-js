-- Schema only: preserve original and reversal postings for native unused receipt voids.
create or replace function erp_financials.customer_payment_correction_protects(n text, r jsonb)
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
  ) or exists (
    select 1 from erp_financials.customer_payment_corrections c
    where c.tenant_id=r->>'tenant_id' and c.source_id=r->>'source_id' and c.source_version like 'native:%' and (
      (n in ('transactions','transaction_lines','ledger_postings','bank_reconciliation_matches') and (
        (c.result->'reversalTransactionIds') ? (r->>'transaction_id') or exists (
          select 1 from jsonb_array_elements(c.result->'basisReversals') b
          where (b->'originalTransactionIds') ? (r->>'transaction_id')
        ))) or
      (n in ('subledger_documents','subledger_document_lines') and c.payment_id=r->>'subledger_document_id') or
      (n='subledger_applications' and c.payment_id in (r->>'source_document_id',r->>'target_document_id'))
    )
  )
$$;

