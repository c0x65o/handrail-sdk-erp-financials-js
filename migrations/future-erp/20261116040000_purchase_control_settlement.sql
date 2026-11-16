-- Purchase checks retain their payee, cash posting and native identity; customer AR scopes use canonical detail.
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
  if new.document_type in ('journal_receivable','journal_payable','journal_customer_credit','journal_vendor_credit') then
    if (journal.source_transaction_type <> 'JournalEntry' and not (journal.source_transaction_type = 'Purchase' and new.document_type in ('journal_receivable','journal_customer_credit'))) or journal.status <> 'posted'
      or journal.currency_code <> new.currency_code or new.party_id is null
      or new.metadata->>'provider' is distinct from 'quickbooks'
      or new.metadata#>>'{journalSettlementScope,sourceTransactionType}' is distinct from journal.source_transaction_type
      or new.metadata#>>'{journalSettlementScope,journalSourceId}' is distinct from journal.source_transaction_id
      or new.metadata#>>'{journalSettlementScope,journalTransactionId}' is distinct from journal.transaction_id
      or new.metadata#>>'{journalSettlementScope,partyId}' is distinct from new.party_id
      or not exists (
        select 1 from erp_financials.transaction_lines p
        join erp_financials.accounts a on a.tenant_id=p.tenant_id and a.source_id=p.source_id and a.account_id=p.account_id
        join erp_financials.parties party on party.tenant_id=p.tenant_id and party.source_id=p.source_id and party.party_id=p.party_id
        where p.tenant_id=new.tenant_id and p.source_id=new.source_id and p.transaction_id=new.transaction_id
          and p.party_id=new.party_id and p.account_id=new.metadata#>>'{journalSettlementScope,accountId}'
          and regexp_replace(lower(a.type),'[^a-z]','','g') = case when new.document_type in ('journal_receivable','journal_customer_credit') then 'accountsreceivable' else 'accountspayable' end
          and party.party_type=case when new.document_type in ('journal_receivable','journal_customer_credit') then 'customer' else 'vendor' end
        group by p.transaction_id
        having sum(p.amount) * case when new.document_type in ('journal_receivable','journal_vendor_credit') then 1 else -1 end = new.original_amount
      ) then raise exception 'journal subledger must match its original posted party and control-account balance'; end if;
    return new;
  end if;
  if new.document_type='settlement_pool' then
    if journal.source_transaction_type not in ('Payment','BillPayment') or journal.status<>'posted'
      or journal.currency_code<>new.currency_code or journal.party_id is distinct from new.party_id
      or new.metadata->>'provider' is distinct from 'quickbooks'
      or new.metadata#>>'{settlementPool,sourceTransactionId}' is distinct from journal.source_transaction_id
      or new.metadata#>>'{settlementPool,side}' is distinct from (case journal.source_transaction_type when 'Payment' then 'receivables' else 'payables' end)
      or not exists(select 1 from erp_financials.subledger_documents d where d.tenant_id=new.tenant_id and d.company_id=new.company_id and d.source_id=new.source_id
        and d.transaction_id=new.transaction_id and d.document_type=case journal.source_transaction_type when 'Payment' then 'customer_payment' else 'bill_payment' end
        and d.original_amount=(new.metadata#>>'{settlementPool,cashAmount}')::numeric and d.original_amount<new.original_amount)
    then raise exception 'settlement pool requires its original cash document and provider identity'; end if;
    return new;
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
