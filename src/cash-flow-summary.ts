import type { AccountingBasis, DecimalString } from "./canonical-model.js";
import type { ErpFinancialsTransactionRunner } from "./erp-financials-service.js";
import { ErpFinancialsError } from "./sdk-errors.js";

export type CashFlowAccountRole = "cash" | "operating" | "investing" | "financing";
export type CashFlowSummaryRequest = {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly accountingMethod?: AccountingBasis;
  /** Explicit reporting-book keys. Roles inherit to descendants; the nearest
   * explicit assignment wins. No account-name or number inference. */
  readonly accountRoles: readonly { readonly bookAccountKey: string; readonly role: CashFlowAccountRole }[];
}
export type CashFlowSummary = {
  readonly tenantId: string; readonly companyId: string; readonly bookId: string;
  readonly periodStart: string; readonly periodEnd: string;
  readonly accountingBasis: AccountingBasis; readonly currencyCode: string;
  readonly method: "direct"; readonly derivation: "cash_account_ledger_movement";
  readonly supportStatus: "supported" | "partial";
  readonly beginningCash: DecimalString; readonly operating: DecimalString;
  readonly investing: DecimalString; readonly financing: DecimalString;
  readonly unclassified: DecimalString; readonly netCashFlow: DecimalString; readonly endingCash: DecimalString;
  readonly cashTransactionCount: string; readonly cashPostingCount: string;
  readonly transferTransactionCount: string; readonly allocatedTransactionCount: string; readonly unclassifiedTransactionCount: string;
  readonly unbalancedTransactionCount: string;
  /** Verified in the same SQL snapshot, including unclassified movements.
   * Zero control differences do not imply complete cash-purpose classification. */
  readonly reconciliation: {
    readonly cashLedgerDifference: DecimalString;
    readonly classificationDifference: DecimalString;
  };
}
type Scope = { readonly tenantId: string; readonly companyId: string; readonly bookId: string; readonly database: ErpFinancialsTransactionRunner }
const invalid = (message: string): never => { throw new ErpFinancialsError("invalid_input", message); };
function date(value: string): boolean {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}
function decimal(value: unknown): string {
  if (typeof value !== "string" || !/^-?\d+(?:\.\d+)?$/u.test(value)) throw new Error("Invalid cash-flow amount");
  const [whole, fraction = ""] = value.split(".");
  if (whole === undefined || /[1-9]/u.test(fraction.slice(2))) throw new Error("Invalid cash-flow amount");
  // PostgreSQL numeric preserves trailing scale from exact imported arithmetic.
  // Discard zeroes only; never round away a sub-cent fact.
  return `${whole}.${fraction.slice(0, 2).padEnd(2, "0")}`;
}
function count(value: unknown): string {
  if (typeof value !== "string" || !/^\d+$/u.test(value)) throw new Error("Invalid cash-flow count");
  return value;
}

/** One SQL snapshot, constant-size result. definitionsSql is SDK-owned SQL from
 * the same account-definition space as the public reporting account chart. */
export async function readCashFlowSummary(scope: Scope, raw: CashFlowSummaryRequest, definitionsSql: string): Promise<CashFlowSummary> {
  const { periodStart, periodEnd, accountingMethod } = raw;
  if (!date(periodStart) || !date(periodEnd) || periodStart > periodEnd) invalid("Invalid cash-flow period");
  if (accountingMethod !== undefined && !["cash", "accrual", "modified_cash"].includes(accountingMethod)) invalid("Invalid cash-flow accounting basis");
  if (!Array.isArray(raw.accountRoles) || !raw.accountRoles.length || raw.accountRoles.length > 2000) invalid("Cash-flow account policy requires 1 to 2000 roots");
  const roles = raw.accountRoles.map((value: unknown) => {
    if (!value || typeof value !== "object") invalid("Invalid cash-flow account policy");
    const item = value as Record<string, unknown>;
    if (typeof item.bookAccountKey !== "string" || !item.bookAccountKey.trim() || item.bookAccountKey.length > 512 ||
      typeof item.role !== "string" || !["cash", "operating", "investing", "financing"].includes(item.role)) invalid("Invalid cash-flow account policy");
    return { key: item.bookAccountKey, role: item.role };
  });
  if (new Set(roles.map(item => item.key)).size !== roles.length || !roles.some(item => item.role === "cash")) invalid("Cash-flow policy requires distinct roots and a cash assignment");
  const policy = JSON.stringify(roles);
  return scope.database.transaction(async client => {
    const result = await client.query(`with recursive book as (
  select base_currency_code currency_code,coalesce($6::text,accounting_basis) basis,status
  from erp_financials.reporting_books where tenant_id=$1 and company_id=$2 and book_id=$3
), definitions_raw as (
${definitionsSql}
), definitions as (
  select distinct on (book_account_key) * from definitions_raw order by book_account_key
), policy as (
  select * from jsonb_to_recordset($7::jsonb) as item(key text,role text)
), inherited(key,role,depth,path,cycle) as (
  select definition.book_account_key,policy.role,0,array[definition.book_account_key],false
  from policy join definitions definition on definition.book_account_key=policy.key
  union all
  select child.book_account_key,parent.role,parent.depth+1,parent.path||child.book_account_key,child.book_account_key=any(parent.path)
  from inherited parent join definitions child on child.parent_book_account_key=parent.key where not parent.cycle
), resolved as (
  select distinct on (key) key,role from inherited where not cycle order by key,depth
), scoped as not materialized (
  -- Inline this relation so period and document predicates reach the postings
  -- indexes. Materializing all history spills wide rows even for one month.
  select posting.source_id,posting.transaction_id,posting.account_id,posting.posting_date,posting.net_amount,posting.debit_amount,posting.credit_amount,role.role
  from erp_financials.ledger_postings posting
  join book on book.status='active' and book.basis=posting.accounting_basis and book.currency_code=posting.currency_code
  join erp_financials.reporting_book_sources source on source.tenant_id=$1 and source.company_id=$2 and source.book_id=$3 and source.source_id=posting.source_id
    and (source.effective_from is null or source.effective_from<=posting.posting_date) and (source.effective_through is null or source.effective_through>=posting.posting_date)
  left join erp_financials.reporting_book_account_mappings mapping on mapping.tenant_id=$1 and mapping.company_id=$2 and mapping.book_id=$3 and mapping.source_id=posting.source_id and mapping.account_id=posting.account_id
  left join resolved role on role.key=coalesce(mapping.book_account_key,posting.source_id||':'||posting.account_id)
  where posting.tenant_id=$1 and posting.posting_date<=$4::date
), cash as (
  select coalesce(sum(net_amount) filter(where role='cash' and posting_date<$5::date),0) beginning,
    coalesce(sum(net_amount) filter(where role='cash'),0) ending,
    count(*) filter(where role='cash' and posting_date>=$5::date) posting_count,
    coalesce(bool_or(debit_amount<>trunc(debit_amount,2) or credit_amount<>trunc(credit_amount,2) or net_amount<>trunc(net_amount,2)),false) invalid_precision
  from scoped
), transactions as (
  select source_id,transaction_id,coalesce(sum(net_amount) filter(where role='cash'),0) cash_net,sum(net_amount) net,
    count(*) filter(where role='cash') cash_count,
    count(*) filter(where role is distinct from 'cash' and (debit_amount<>0 or credit_amount<>0)) counterpart_count,
    count(*) filter(where role is null and (debit_amount<>0 or credit_amount<>0)) unknown_count,
    count(distinct role) filter(where role<>'cash' and (debit_amount<>0 or credit_amount<>0)) activity_count,
    min(role) filter(where role<>'cash' and (debit_amount<>0 or credit_amount<>0)) activity,
    min(net_amount) filter(where role is distinct from 'cash') counterpart_min,
    max(net_amount) filter(where role is distinct from 'cash') counterpart_max,
    -coalesce(sum(net_amount) filter(where role='operating'),0) operating_movement,
    -coalesce(sum(net_amount) filter(where role='investing'),0) investing_movement,
    -coalesce(sum(net_amount) filter(where role='financing'),0) financing_movement
  from scoped where posting_date>=$5::date group by source_id,transaction_id
  having count(*) filter(where role='cash')>0
), cash_headers as (
  select t.source_id,t.transaction_id,h.source_transaction_type,primary_header.transaction_id primary_transaction_id
  from transactions t join erp_financials.transactions h
    on h.tenant_id=$1 and h.source_id=t.source_id and h.transaction_id=t.transaction_id
  join erp_financials.transactions primary_header on primary_header.tenant_id=$1 and primary_header.source_id=h.source_id
    and primary_header.source_transaction_type=h.source_transaction_type
    and primary_header.source_transaction_id=case when (select basis from book)='cash'
      then regexp_replace(h.source_transaction_id,':accounting-basis:cash$','') else h.source_transaction_id end
), payment_references as (
  select h.source_id,h.transaction_id,h.primary_transaction_id payment_transaction_id,-1 cash_sign
  from cash_headers h where h.source_transaction_type='Subledger:bill_payment'
  union all
  select h.source_id,h.transaction_id,link.original_transaction_id,1 cash_sign
  from cash_headers h join erp_financials.journal_entry_links link
    on link.tenant_id=$1 and link.company_id=$2 and link.source_id=h.source_id
    and link.related_transaction_id=h.primary_transaction_id and link.link_type='void'
), receipt_cash_references as (
  select h.source_id,h.transaction_id,d.original_amount,coalesce(c.activity,d.metadata->>'cashFlowActivity') activity,1 cash_sign
  from cash_headers h join erp_financials.subledger_documents d
    on d.tenant_id=$1 and d.company_id=$2 and d.source_id=h.source_id and d.transaction_id=h.primary_transaction_id
    and d.document_type='customer_payment' and d.currency_code=(select currency_code from book)
  left join lateral (select case when operating>0 then 'operating' when investing>0 then 'investing' else 'financing' end activity
    from erp_financials.cash_flow_purpose_corrections where tenant_id=$1 and company_id=$2 and source_id=d.source_id
      and document_id=d.subledger_document_id order by revision desc limit 1) c on true
  where h.source_transaction_type='Subledger:customer_payment'
  union all
  select h.source_id,h.transaction_id,d.original_amount,coalesce(c.activity,receipt.metadata->>'cashFlowActivity') activity,-1 cash_sign
  from cash_headers h join erp_financials.subledger_documents d
    on d.tenant_id=$1 and d.company_id=$2 and d.source_id=h.source_id and d.transaction_id=h.primary_transaction_id
    and d.document_type='refund' and d.currency_code=(select currency_code from book)
  join erp_financials.subledger_documents receipt on receipt.tenant_id=$1 and receipt.company_id=$2 and receipt.source_id=d.source_id
    and receipt.subledger_document_id=d.metadata->'customerPaymentReturn'->>'paymentId'
    and receipt.document_type='customer_payment' and receipt.party_id=d.party_id and receipt.currency_code=d.currency_code
  left join lateral (select case when operating>0 then 'operating' when investing>0 then 'investing' else 'financing' end activity
    from erp_financials.cash_flow_purpose_corrections where tenant_id=$1 and company_id=$2 and source_id=receipt.source_id
      and document_id=receipt.subledger_document_id order by revision desc limit 1) c on true
  where h.source_transaction_type='Subledger:refund'
), native_payment_candidates as (
  select r.source_id,r.transaction_id,r.payment_transaction_id,d.subledger_document_id,d.original_amount,r.cash_sign,
    d.metadata->'billPaymentProvenance'->>'payableAccountId' control_account_id
  from payment_references r join erp_financials.subledger_documents d
    on d.tenant_id=$1 and d.company_id=$2 and d.source_id=r.source_id and d.transaction_id=r.payment_transaction_id
    and d.document_type='bill_payment' and d.currency_code=(select currency_code from book)
), native_payments as (
  select n.source_id,n.transaction_id,n.payment_transaction_id,n.subledger_document_id,n.original_amount,n.control_account_id,n.cash_sign,
    bool_and(coalesce(c.role='cash',false) or coalesce(c.account_id=n.control_account_id,false)) controls_valid
  from native_payment_candidates n join scoped c on c.source_id=n.source_id and c.transaction_id=n.transaction_id
  group by n.source_id,n.transaction_id,n.payment_transaction_id,n.subledger_document_id,n.original_amount,n.control_account_id,n.cash_sign
), payment_applications as (
  -- Cash purpose is the accepted clearing allocation, not the mutable current
  -- payable application. Later noncash reassignment must not rewrite history.
  select n.source_id,n.transaction_id,n.control_account_id,a.subledger_application_id,a.applied_amount,a.application_date,b.transaction_id bill_transaction_id
  from native_payments n join erp_financials.bill_payment_disbursements instruction
    on instruction.tenant_id=$1 and instruction.company_id=$2 and instruction.source_id=n.source_id
    and instruction.subledger_document_id=n.subledger_document_id and instruction.bill_payment_id=n.subledger_document_id
    and instruction.currency_code=(select currency_code from book) and instruction.amount=n.original_amount
    and instruction.payable_account_id=n.control_account_id and instruction.status in ('cleared','voided')
  join erp_financials.financial_lifecycle_events cleared on cleared.tenant_id=$1 and cleared.company_id=$2 and cleared.source_id=n.source_id
    and cleared.event_id=instruction.cleared_event_id and cleared.aggregate_type='bill_payment'
    and cleared.aggregate_id=instruction.bill_payment_id and cleared.event_type='bill_payment.cleared'
    and cleared.payload->'allocations'=instruction.allocations and cleared.payload->>'amount'=instruction.amount::text
    and cleared.payload->>'transactionId'=n.payment_transaction_id
  cross join lateral jsonb_array_elements(instruction.allocations) with ordinality allocation(item,position)
  join erp_financials.subledger_applications a
    on a.tenant_id=$1 and a.company_id=$2 and a.source_id=n.source_id and a.source_document_id=n.subledger_document_id
    and a.idempotency_key=instruction.idempotency_key||':allocation:'||allocation.position||':'||(allocation.item->>'billId')
    and a.target_document_id=allocation.item->>'billId' and a.applied_amount::text=allocation.item->>'amount'
    and a.application_type='bill_payment_to_bill' and a.currency_code=instruction.currency_code and a.application_date=instruction.payment_date
  join erp_financials.subledger_documents b on b.tenant_id=$1 and b.company_id=$2 and b.source_id=a.source_id
    and b.subledger_document_id=a.target_document_id and b.document_type='vendor_bill' and b.currency_code=a.currency_code
), allocation_lines as (
  select a.*,p.posting_id,p.account_id,p.net_amount,p.debit_amount,p.credit_amount,role.role
  from payment_applications a left join erp_financials.ledger_postings p
    on p.tenant_id=$1 and p.source_id=a.source_id and p.transaction_id=a.bill_transaction_id
    and p.accounting_basis='cash' and p.currency_code=(select currency_code from book) and p.posting_date=a.application_date
    and left(p.source_posting_id,length('cash-application:'||a.subledger_application_id||':recognize:'))='cash-application:'||a.subledger_application_id||':recognize:'
  left join erp_financials.reporting_book_account_mappings mapping on mapping.tenant_id=$1 and mapping.company_id=$2 and mapping.book_id=$3
    and mapping.source_id=a.source_id and mapping.account_id=p.account_id
  left join resolved role on role.key=coalesce(mapping.book_account_key,a.source_id||':'||p.account_id)
), allocations as (
  select source_id,transaction_id,subledger_application_id,applied_amount,
    count(posting_id)>0 and sum(net_amount)=0
      and coalesce(sum(net_amount) filter(where account_id=control_account_id),0)=-applied_amount
      and count(*) filter(where posting_id is null or account_id<>control_account_id and (role is null or role='cash'))=0
      and count(*) filter(where net_amount<>trunc(net_amount,2) or debit_amount<>trunc(debit_amount,2) or credit_amount<>trunc(credit_amount,2))=0 valid,
    -coalesce(sum(net_amount) filter(where account_id<>control_account_id and role='operating'),0) operating,
    -coalesce(sum(net_amount) filter(where account_id<>control_account_id and role='investing'),0) investing,
    -coalesce(sum(net_amount) filter(where account_id<>control_account_id and role='financing'),0) financing
  from allocation_lines group by source_id,transaction_id,subledger_application_id,applied_amount
), payment_totals as (
  select source_id,transaction_id,bool_and(valid) valid,sum(applied_amount) applied_amount,
    sum(operating) operating,sum(investing) investing,sum(financing) financing
  from allocations group by source_id,transaction_id
), classified as (
  select t.*,case when c.revision is not null then n.cash_sign*c.operating when n.subledger_document_id is not null then -n.cash_sign*p.operating else t.operating_movement end resolved_operating,
    case when c.revision is not null then n.cash_sign*c.investing when n.subledger_document_id is not null then -n.cash_sign*p.investing else t.investing_movement end resolved_investing,
    case when c.revision is not null then n.cash_sign*c.financing when n.subledger_document_id is not null then -n.cash_sign*p.financing else t.financing_movement end resolved_financing,
    case when t.net<>0 then 'unclassified'
    when r.transaction_id is not null then case when r.activity in ('operating','investing','financing')
      and t.cash_net=r.cash_sign*r.original_amount and t.cash_count=1 and t.counterpart_count=1
      then r.activity else 'unclassified' end
    when c.revision is not null then case when t.cash_net=n.cash_sign*n.original_amount and n.controls_valid
      and c.operating+c.investing+c.financing=n.original_amount then 'allocated' else 'unclassified' end
    when n.subledger_document_id is not null then case when p.valid and t.cash_net=n.cash_sign*n.original_amount
      and p.applied_amount=n.original_amount and -n.cash_sign*(p.operating+p.investing+p.financing)=t.cash_net
      and n.controls_valid
      then 'allocated' else 'unclassified' end
    when counterpart_count=0 and cash_net=0 then 'transfer'
    when unknown_count=0 and activity_count=1 then t.activity
    when unknown_count=0 and activity_count>1 and ((cash_net<0 and counterpart_min>=0) or (cash_net>0 and counterpart_max<=0)) then 'allocated'
    else 'unclassified' end category from transactions t
  left join receipt_cash_references r on r.source_id=t.source_id and r.transaction_id=t.transaction_id
  left join native_payments n on n.source_id=t.source_id and n.transaction_id=t.transaction_id
  left join payment_totals p on p.source_id=t.source_id and p.transaction_id=t.transaction_id
  left join lateral (select revision,operating,investing,financing from erp_financials.cash_flow_purpose_corrections
    where tenant_id=$1 and company_id=$2 and source_id=n.source_id and document_id=n.subledger_document_id order by revision desc limit 1) c on true
)
select (select status from book) book_status,(select basis from book) basis,(select currency_code from book) currency_code,
  exists(select 1 from policy left join definitions on definitions.book_account_key=policy.key where definitions.book_account_key is null) missing_policy,
  (exists(select 1 from inherited where cycle) or exists(select 1 from definitions_raw group by book_account_key having count(*)>1)) invalid_hierarchy,
  exists(select 1 from resolved join definitions on definitions.book_account_key=resolved.key where resolved.role='cash' and definitions.classification<>'asset') invalid_cash,
  (exists(select 1 from receipt_cash_references group by source_id,transaction_id having count(*)>1)
    or exists(select 1 from native_payment_candidates group by source_id,transaction_id having count(*)>1)) ambiguous_cash_document,
  cash.invalid_precision,
  cash.beginning::text,cash.ending::text,cash.posting_count::text,
  coalesce(sum(case when category='operating' then cash_net when category='allocated' then resolved_operating else 0 end),0)::text operating,
  coalesce(sum(case when category='investing' then cash_net when category='allocated' then resolved_investing else 0 end),0)::text investing,
  coalesce(sum(case when category='financing' then cash_net when category='allocated' then resolved_financing else 0 end),0)::text financing,
  coalesce(sum(cash_net) filter(where category='unclassified'),0)::text unclassified,
  coalesce(sum(cash_net),0)::text net_cash_flow,count(classified.transaction_id)::text transaction_count,
  count(*) filter(where category='transfer')::text transfer_count,count(*) filter(where category='allocated')::text allocated_count,count(*) filter(where category='unclassified')::text unclassified_count,
  count(*) filter(where net<>0)::text unbalanced_count
from cash left join classified on true group by cash.beginning,cash.ending,cash.posting_count,cash.invalid_precision`,
    [scope.tenantId,scope.companyId,scope.bookId,periodEnd,periodStart,accountingMethod??null,policy]);
    const row = result.rows[0];
    if (!row || row.book_status !== "active") throw new ErpFinancialsError("missing_book", "Cash-flow reporting book is unavailable");
    if (row.missing_policy || row.invalid_cash || row.invalid_hierarchy) invalid("Cash-flow policy references missing, non-asset cash, cyclic or ambiguous accounts");
    if (row.ambiguous_cash_document) throw new ErpFinancialsError("invalid_input", "Cash transaction has ambiguous native document ownership");
    if (row.invalid_precision) throw new ErpFinancialsError("invalid_input", "Cash-flow postings exceed two-decimal precision");
    const unclassifiedTransactionCount=count(row.unclassified_count), unbalancedTransactionCount=count(row.unbalanced_count);
    const beginningCash=decimal(row.beginning),endingCash=decimal(row.ending),netCashFlow=decimal(row.net_cash_flow);
    const operating=decimal(row.operating),investing=decimal(row.investing),financing=decimal(row.financing),unclassified=decimal(row.unclassified);
    const minor=(amount:string)=>BigInt(amount.replace(".",""));
    if (minor(beginningCash)+minor(netCashFlow)!==minor(endingCash)
      || minor(operating)+minor(investing)+minor(financing)+minor(unclassified)!==minor(netCashFlow)) {
      throw new ErpFinancialsError("invalid_input", "Cash-flow categories do not reconcile to the cash ledger");
    }
    return { tenantId:scope.tenantId,companyId:scope.companyId,bookId:scope.bookId,periodStart,periodEnd,
      accountingBasis:row.basis as AccountingBasis,currencyCode:row.currency_code as string,
      method:"direct",derivation:"cash_account_ledger_movement",supportStatus:unclassifiedTransactionCount==="0"?"supported":"partial",
      beginningCash,endingCash,operating,investing,financing,unclassified,netCashFlow,
      // Both exact minor-unit equalities above must succeed before exposing
      // these controls. Never let the host infer them from formatted totals.
      reconciliation:{cashLedgerDifference:"0.00",classificationDifference:"0.00"},
      cashTransactionCount:count(row.transaction_count),cashPostingCount:count(row.posting_count),transferTransactionCount:count(row.transfer_count),allocatedTransactionCount:count(row.allocated_count),unclassifiedTransactionCount,unbalancedTransactionCount };
  });
}
