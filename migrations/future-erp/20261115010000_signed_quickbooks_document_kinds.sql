-- Retain signed provider documents without changing canonical ledger facts.
create or replace function "erp_financials"."validate_subledger_document_insert"()
returns trigger
language plpgsql
as $subledger_document_insert_validate$
declare
  journal "erp_financials"."transactions"%rowtype;
  expected_provider_type text;
begin
  select * into journal
  from "erp_financials"."transactions"
  where "tenant_id" = new."tenant_id" and "source_id" = new."source_id" and "transaction_id" = new."transaction_id"
  for key share;
  if journal."transaction_id" is null then
    raise exception 'subledger document journal does not exist in the requested scope';
  end if;
  expected_provider_type := case new."document_type"
    when 'invoice' then 'Invoice'
    when 'customer_payment' then 'Payment'
    when 'credit_memo' then 'CreditMemo'
    when 'refund' then 'RefundReceipt'
    when 'vendor_bill' then 'Bill'
    when 'bill_payment' then 'BillPayment'
    when 'deposit' then 'Deposit'
    when 'transfer' then 'Transfer'
    when 'sales_receipt' then 'SalesReceipt'
    when 'purchase' then 'Purchase'
    when 'vendor_credit' then 'VendorCredit'
    else null
  end;
  -- Negative QBO commercial totals reverse the document kind, while the
  -- original journal and its polarity remain unchanged. Require explicit signed
  -- provenance and an exact magnitude match; native command guards stay intact.
  if new."metadata"->>'provider' = 'quickbooks'
    and new."metadata"->>'signedTotalMapping' = new."document_type"
    and new."metadata"->>'sourceTransactionId' = journal."source_transaction_id"
    and new."metadata"->>'sourceTransactionType' = journal."source_transaction_type"
    and coalesce(new."metadata"->>'providerSignedTotal', '') ~ '^-[0-9]+([.][0-9]+)?$'
  then
    if (new."metadata"->>'providerSignedTotal')::numeric < 0
      and -(new."metadata"->>'providerSignedTotal')::numeric = new."original_amount"
    then
      expected_provider_type := case new."document_type"
        when 'invoice' then 'CreditMemo'
        when 'credit_memo' then 'Invoice'
        when 'vendor_bill' then 'VendorCredit'
        when 'vendor_credit' then 'Bill'
        else expected_provider_type
      end;
    end if;
  end if;
  if journal."status" <> 'posted'
    or (journal."source_transaction_type" <> 'Subledger:' || new."document_type"
      and journal."source_transaction_type" is distinct from expected_provider_type)
    or journal."currency_code" <> new."currency_code"
    or journal."party_id" is distinct from new."party_id"
  then
    raise exception 'subledger document must match its posted journal type, currency, and party';
  end if;
  return new;
end;
$subledger_document_insert_validate$;
