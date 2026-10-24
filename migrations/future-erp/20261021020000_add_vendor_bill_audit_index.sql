-- Read index only: preserves every accounting fact and immutable payment instruction.
create index if not exists bill_payment_disbursements_allocations_gin_idx
  on erp_financials.bill_payment_disbursements using gin (allocations);
