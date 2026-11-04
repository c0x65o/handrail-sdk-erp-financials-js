import { createHash } from "node:crypto";
import type { ErpFinancialsTransactionRunner } from "./erp-financials-service.js";
import { ErpFinancialsError } from "./sdk-errors.js";

export type VendorLiabilityStatementRequest = {
  readonly vendorId: string; readonly sourceId: string; readonly asOfDate: string;
  readonly limit?: number; readonly cursor?: string;
};
export type VendorLiabilityPosting = {
  readonly postingId: string; readonly sourceId: string; readonly transactionId: string;
  readonly postingDate: string; readonly transactionType: string; readonly transactionNumber: string | null;
  readonly accountId: string; readonly accountName: string; readonly accountType: string;
  readonly vendorId: string; readonly currencyCode: string;
  readonly debitAmount: string; readonly creditAmount: string; readonly payableEffect: string;
};
export type VendorLiabilityStatement = {
  readonly vendorId: string; readonly sourceId: string; readonly asOfDate: string;
  readonly currencyCode: string; readonly accountingBasis: "accrual"; readonly revision: string;
  readonly postingCount: number; readonly netLiabilityAmount: string;
  readonly items: readonly VendorLiabilityPosting[]; readonly nextCursor?: string;
};
type Scope = { readonly database: ErpFinancialsTransactionRunner; readonly tenantId: string; readonly companyId: string; readonly bookId: string };
const fail = (message: string): never => { throw new ErpFinancialsError("reconciliation_conflict", message); };
const invalid = (): never => { throw new ErpFinancialsError("invalid_input", "Invalid vendor liability statement request"); };
const text = (value: unknown): string => typeof value === "string" && value.length > 0 ? value : fail("Incomplete vendor posting evidence");
const minor = (value: unknown): bigint => {
  if (typeof value !== "string" || !/^-?\d+(?:\.\d+)?$/.test(value)) return fail("Invalid vendor posting amount");
  const [whole, fraction = ""] = value.replace(/^-/, "").split(".");
  if (/[1-9]/.test(fraction.slice(2))) return fail("Vendor amount contains fractional cents");
  return (value.startsWith("-") ? -1n : 1n) * (BigInt(whole ?? fail("Missing vendor amount")) * 100n + BigInt(fraction.slice(0, 2).padEnd(2, "0")));
};
const decimal = (value: bigint): string => `${value < 0n ? "-" : ""}${String((value < 0n ? -value : value) / 100n)}.${String((value < 0n ? -value : value) % 100n).padStart(2, "0")}`;

/** The canonical accrual AP control is authoritative, not bill-open minus
 * funding-open (which double counts refunded funding). Retain all attributed
 * vendor postings, including journals/refunds and their dated reversals, and
 * use only AP postings for net liability. No transaction-type guessing or host
 * database overlays. Book source windows and exact party/source coordinates
 * apply before aggregation. Unattributed entries are never assigned by name. */
export async function readVendorLiabilityStatement(scope: Scope, raw: VendorLiabilityStatementRequest): Promise<VendorLiabilityStatement> {
  const input = structuredClone(raw), limit = input.limit ?? 100;
  if (![input.vendorId, input.sourceId].every(v => typeof v === "string" && v.trim().length > 0 && v.length <= 500)
    || !Number.isInteger(limit) || limit < 1 || limit > 200 || typeof input.asOfDate !== "string"
    || !/^\d{4}-\d{2}-\d{2}$/.test(input.asOfDate) || !Number.isFinite(Date.parse(input.asOfDate))
    || new Date(input.asOfDate).toISOString().slice(0, 10) !== input.asOfDate) invalid();
  let offset = 0, expectedRevision: string | undefined;
  if (input.cursor !== undefined) {
    try {
      if (typeof input.cursor !== "string" || input.cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(input.cursor)) invalid();
      const cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString()) as { revision: string; offset: number };
      if (!/^[a-f0-9]{64}$/.test(cursor.revision) || !Number.isInteger(cursor.offset) || cursor.offset < 1 || cursor.offset > 10000) invalid();
      offset = cursor.offset; expectedRevision = cursor.revision;
    } catch { invalid(); }
  }
  return scope.database.transaction(async client => {
    const result = await client.query(`with selected as materialized (
      select p.posting_id,p.source_id,p.transaction_id,p.posting_date::text,p.party_id,p.currency_code,
        t.source_transaction_type,t.transaction_number,a.account_id,a.name as account_name,a.type as account_type,
        p.debit_amount::text,p.credit_amount::text,
        case when a.classification='liability' and lower(regexp_replace(a.type,'[^a-zA-Z]','','g'))='accountspayable'
          then p.credit_amount-p.debit_amount else 0 end as payable_effect
      from erp_financials.ledger_postings p
      join erp_financials.reporting_book_sources s on s.tenant_id=p.tenant_id and s.source_id=p.source_id and s.company_id=$2 and s.book_id=$3
        and (s.effective_from is null or s.effective_from<=p.posting_date) and (s.effective_through is null or s.effective_through>=p.posting_date)
      join erp_financials.transactions t on t.tenant_id=p.tenant_id and t.source_id=p.source_id and t.transaction_id=p.transaction_id
      join erp_financials.accounts a on a.tenant_id=p.tenant_id and a.source_id=p.source_id and a.account_id=p.account_id
      where p.tenant_id=$1 and p.source_id=$4 and p.party_id=$5 and p.accounting_basis='accrual' and p.posting_date<=$6::date
    ), controls as (
      select count(*)::integer posting_count,coalesce(sum(payable_effect),0)::text net_liability,
        count(distinct currency_code)::integer currency_count,min(currency_code) as posting_currency from selected
    )
    select b.status as book_status,b.base_currency_code,party.party_type,controls.*,rows.*,
      exists(select 1 from erp_financials.reporting_book_sources s where s.tenant_id=$1 and s.company_id=$2 and s.book_id=$3 and s.source_id=$4) as source_known
    from erp_financials.reporting_books b cross join controls
    left join erp_financials.parties party on party.tenant_id=b.tenant_id and party.source_id=$4 and party.party_id=$5
    left join lateral (select *,payable_effect::text as liability_effect from selected order by posting_date,source_id,posting_id limit 10001) rows on true
    where b.tenant_id=$1 and b.company_id=$2 and b.book_id=$3`,
      [scope.tenantId, scope.companyId, scope.bookId, input.sourceId, input.vendorId, input.asOfDate]);
    const control = result.rows[0];
    if (!control || control.book_status !== "active" || control.source_known !== true) return fail("Vendor statement requires an active reporting book");
    const currencyCode = text(control.base_currency_code), count = control.posting_count;
    if (control.party_type !== null && control.party_type !== "vendor") return fail("Statement identity is not a vendor");
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > 10000) return fail("Vendor statement exceeds the complete-scan bound");
    if (count > 0 && (control.party_type !== "vendor" || control.currency_count !== 1 || control.posting_currency !== currencyCode)) return fail("Vendor statement currency or party evidence is incomplete");
    const seen = new Set<string>();
    const items: VendorLiabilityPosting[] = result.rows.filter(row => row.posting_id !== null).map(row => {
      const postingId = text(row.posting_id), debit = minor(row.debit_amount), credit = minor(row.credit_amount), effect = minor(row.liability_effect);
      if (seen.has(postingId) || debit < 0n || credit < 0n || row.source_id !== input.sourceId || row.party_id !== input.vendorId || row.currency_code !== currencyCode) return fail("Vendor posting does not reconcile to its source identity");
      seen.add(postingId);
      return { postingId, sourceId: input.sourceId, vendorId: input.vendorId, transactionId: text(row.transaction_id), postingDate: text(row.posting_date),
        transactionType: text(row.source_transaction_type), transactionNumber: row.transaction_number == null ? null : text(row.transaction_number),
        accountId: text(row.account_id), accountName: text(row.account_name), accountType: text(row.account_type), currencyCode,
        debitAmount: decimal(debit), creditAmount: decimal(credit), payableEffect: decimal(effect) };
    });
    const net = items.reduce((total, row) => total + minor(row.payableEffect), 0n);
    if (items.length !== count || net !== minor(control.net_liability)) return fail("Vendor postings disagree with liability control");
    const revision = createHash("sha256").update(JSON.stringify([scope.tenantId, scope.companyId, scope.bookId, input.vendorId, input.sourceId, input.asOfDate, currencyCode, items])).digest("hex");
    if (expectedRevision !== undefined && revision !== expectedRevision) throw new ErpFinancialsError("optimistic_concurrency_conflict", "Vendor liability changed; restart the statement");
    if (offset > items.length) invalid();
    const next = offset + limit;
    return { vendorId: input.vendorId, sourceId: input.sourceId, asOfDate: input.asOfDate, currencyCode, accountingBasis: "accrual", revision,
      postingCount: count, netLiabilityAmount: decimal(net), items: items.slice(offset, next),
      ...(next < items.length ? { nextCursor: Buffer.from(JSON.stringify({ revision, offset: next })).toString("base64url") } : {}) };
  });
}
