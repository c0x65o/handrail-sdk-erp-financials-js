-- Restore provider-owned application refresh deltas while retaining source-qualified balances.
-- Additive repair: the published schema50 migration and existing financial facts remain unchanged.
create or replace function "erp_financials"."apply_subledger_application_balances"()
returns trigger
language plpgsql
as $subledger_application_balances$
declare
  balance_delta numeric;
begin
  if tg_op = 'INSERT' then
    balance_delta := -new."applied_amount";
  elsif old."status" = 'applied' and new."status" in ('unapplied', 'voided') then
    balance_delta := new."applied_amount";
  elsif coalesce(current_setting('erp_financials.quickbooks_projection_refresh', true), 'off') = 'on'
    and new."status" = 'applied'
  then
    balance_delta := case when old."status" = 'applied'
      then old."applied_amount" - new."applied_amount"
      else -new."applied_amount"
    end;
  else
    return new;
  end if;
  perform set_config('erp_financials.application_balance_update', 'on', true);
  update "erp_financials"."subledger_documents"
  set "open_amount" = "open_amount" + balance_delta,
      "status" = case
        when "open_amount" + balance_delta = 0 then 'settled'
        when "open_amount" + balance_delta = "original_amount" then 'open'
        else 'partially_applied'
      end,
      "version" = "version" + 1,
      "updated_at" = new."updated_at"
  where "tenant_id" = new."tenant_id" and "company_id" = new."company_id" 
    and (("source_id" = new."source_id" and "subledger_document_id" = new."source_document_id")
      or ("source_id" = coalesce(new."target_document_source_id",new."source_id") and "subledger_document_id" = new."target_document_id"));
  perform set_config('erp_financials.application_balance_update', 'off', true);
  return new;
end
$subledger_application_balances$;
