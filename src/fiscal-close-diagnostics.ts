import { createHash } from "node:crypto";
import { ErpFinancialsError } from "./sdk-errors.js";
import type { PostgresQueryClient } from "./postgres-storage.js";
import type { IsoDate } from "./canonical-model.js";

/** Source-wide facts because fiscal close excludes posting for the entire source,
 * across its books, accounting bases and currencies. Counts are exact decimal
 * integers. This is a current diagnostic, not an immutable close certificate. */
export type FiscalCloseDiagnostics = {
  readonly fiscalPeriodId: string;
  readonly sourceId: string;
  readonly periodStart: IsoDate;
  readonly periodEnd: IsoDate;
  readonly version: number;
  readonly status: "open" | "closing" | "closed";
  readonly postingCount: string;
  readonly postedTransactionCount: string;
  readonly postingGroupCount: string;
  readonly unbalancedPostingGroupCount: string;
  readonly draftTransactionCount: string;
  readonly draftInvoiceCount: string;
};

/** One database statement gives a coherent MVCC snapshot without collecting
 * posting rows in application memory. Close invokes it while excluding posting.
 * Book membership is an access check, not a filter on source-wide close facts. */
export async function readFiscalCloseDiagnostics(client: PostgresQueryClient, input: {
  readonly tenantId: string; readonly companyId: string; readonly sourceId: string;
  readonly fiscalPeriodId: string; readonly bookId?: string;
}): Promise<FiscalCloseDiagnostics> {
  const result = await client.query(fiscalCloseDiagnosticsSql,
    [input.tenantId, input.companyId, input.sourceId, input.fiscalPeriodId, input.bookId ?? null]);
  return fiscalCloseDiagnosticsFromRow(result.rows[0]);
}

function fiscalCloseDiagnosticsFromRow(row: Record<string, unknown> | undefined): FiscalCloseDiagnostics {
  if (!row) throw new ErpFinancialsError("missing_document", "Fiscal period does not exist in this source/book");
  const text = (key: string): string => {
    if (typeof row[key] !== "string" || row[key].length === 0) throw new Error(`Invalid fiscal diagnostic ${key}`);
    return row[key];
  };
  const count = (key: string): string => {
    const value = text(key);
    if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`Invalid fiscal diagnostic count ${key}`);
    return value;
  };
  if (!Number.isSafeInteger(row.version) || Number(row.version) < 1) throw new Error("Invalid fiscal diagnostic version");
  const status = text("status");
  if (status !== "open" && status !== "closing" && status !== "closed") throw new Error("Invalid fiscal diagnostic status");
  return {
    fiscalPeriodId: text("fiscal_period_id"), sourceId: text("source_id"),
    periodStart: text("period_start"), periodEnd: text("period_end"), version: Number(row.version), status,
    postingCount: count("posting_count"), postedTransactionCount: count("posted_transaction_count"),
    postingGroupCount: count("posting_group_count"), unbalancedPostingGroupCount: count("unbalanced_posting_group_count"),
    draftTransactionCount: count("draft_transaction_count"),
    draftInvoiceCount: count("draft_invoice_count")
  };
}

const fiscalCloseDiagnosticsSql = `with fiscal_close_period as (
  select p.* from erp_financials.fiscal_periods p
  where p.tenant_id=$1 and p.company_id=$2 and p.source_id=$3 and p.fiscal_period_id=$4
    and ($5::text is null or exists (select 1 from erp_financials.reporting_book_sources s
      where s.tenant_id=p.tenant_id and s.company_id=p.company_id and s.source_id=p.source_id and s.book_id=$5))
), posting_groups as (
  select l.transaction_id, l.posting_date, l.accounting_basis, l.currency_code,
    count(*) posting_count, sum(l.debit_amount) debits, sum(l.credit_amount) credits
  from erp_financials.ledger_postings l
  where l.tenant_id=$1 and l.source_id=$3
    and l.posting_date between (select period_start from fiscal_close_period) and (select period_end from fiscal_close_period)
  group by l.posting_date,l.transaction_id,l.accounting_basis,l.currency_code
  order by l.posting_date,l.transaction_id,l.accounting_basis,l.currency_code
), posting_totals as (
  select coalesce(sum(posting_count),0)::text posting_count,
    count(distinct transaction_id)::text posted_transaction_count,
    count(*)::text posting_group_count,
    count(*) filter (where debits<>credits or debits::text in ('NaN','Infinity','-Infinity')
      or credits::text in ('NaN','Infinity','-Infinity'))::text unbalanced_posting_group_count from posting_groups
)
select p.fiscal_period_id,p.source_id,p.period_start::text,p.period_end::text,p.version,p.status,t.*,
  (select count(*)::text from erp_financials.transactions d where d.tenant_id=p.tenant_id
    and d.source_id=p.source_id and d.status='draft' and d.transaction_date between p.period_start and p.period_end) draft_transaction_count,
  (select count(*)::text from erp_financials.invoice_drafts d where d.tenant_id=p.tenant_id
    and d.company_id=p.company_id and d.source_id=p.source_id and d.status='draft'
    and d.document_date between p.period_start and p.period_end) draft_invoice_count
from fiscal_close_period p cross join posting_totals t`;

/** Bank identities are trusted accounting configuration, never a browser's
 * selection of which accounts it would like to ignore. This diagnostic is not
 * a close authorization or a frozen certificate. Close must revalidate it. */
export type CanonicalFiscalCloseReadiness = {
  readonly sourceRevision: string;
  readonly approvalToken: string;
  readonly diagnostics: FiscalCloseDiagnostics;
  readonly bookId: string;
  readonly accountingBasis: string;
  readonly currencyCode: string;
  readonly ready: boolean;
  readonly banks: readonly CanonicalFiscalCloseBankCheck[];
};
export type CanonicalFiscalCloseBankCheck = {
  readonly accountId: string;
  readonly hasActivity: boolean;
  readonly statementId: string | null;
  readonly statementVersion: number | null;
  readonly statementStatus: "draft" | "completed" | null;
  readonly evidenceRef: string | null;
  readonly ready: boolean;
  readonly reason: "missing_account" | "no_activity" | "missing_statement" | "statement_not_completed" | "statement_difference" | "ready";
};

export async function readCanonicalFiscalCloseReadiness(client: PostgresQueryClient, raw: {
  readonly tenantId: string; readonly companyId: string; readonly sourceId: string;
  readonly fiscalPeriodId: string; readonly bookId: string; readonly bankAccountIds: readonly string[];
}): Promise<CanonicalFiscalCloseReadiness> {
  const input = { tenantId: raw.tenantId, companyId: raw.companyId, sourceId: raw.sourceId,
    fiscalPeriodId: raw.fiscalPeriodId, bookId: raw.bookId, bankAccountIds: [...raw.bankAccountIds] };
  if (input.bankAccountIds.length > 200 || new Set(input.bankAccountIds).size !== input.bankAccountIds.length
    || input.bankAccountIds.some(id => typeof id !== "string" || !id.trim() || id.length > 1000)) {
    throw new ErpFinancialsError("invalid_input", "Bank account configuration must contain distinct bounded identities (maximum 200)");
  }
  // All diagnostics and bank checks share one MVCC statement. Per-account EXISTS
  // uses the scoped posting index and returns no growing transaction collection.
  const result = await client.query(`with diagnostics as (${fiscalCloseDiagnosticsSql}),
  active_book as (
    select b.* from erp_financials.reporting_books b where b.tenant_id=$1 and b.company_id=$2 and b.book_id=$5 and b.status='active'
  ), bank_checks as (
    select ids.account_id, a.account_id is not null account_exists,
      exists(select 1 from erp_financials.ledger_postings p where p.tenant_id=$1 and p.source_id=$3 and p.account_id=ids.account_id
        and p.accounting_basis=b.accounting_basis and p.currency_code=b.base_currency_code and p.posting_date<=d.period_end::date) has_activity,
      s.statement_id,s.version statement_version,s.status statement_status,s.lifecycle_event_id,
      e.payload->'result'->>'difference' difference
    from unnest($6::text[]) ids(account_id) cross join diagnostics d cross join active_book b
    left join erp_financials.accounts a on a.tenant_id=$1 and a.source_id=$3 and a.account_id=ids.account_id
    left join lateral (select h.* from erp_financials.bank_statements h where h.tenant_id=$1 and h.company_id=$2
      and h.source_id=$3 and h.book_id=$5 and h.account_id=ids.account_id and h.accounting_basis=b.accounting_basis
      and h.currency_code=b.base_currency_code and h.statement_date=d.period_end::date and h.status<>'cancelled'
      order by h.version desc,h.statement_id limit 1) s on true
    left join erp_financials.financial_lifecycle_events e on e.event_id=s.lifecycle_event_id
  ) select to_jsonb(d) diagnostics,b.accounting_basis,b.base_currency_code,
    (select coalesce(sum(revision),0)::text from erp_financials.accounting_source_revisions where tenant_id=$1 and source_id=$3 and effective_date<=d.period_end::date) source_revision,
    (select coalesce(jsonb_agg(to_jsonb(c) order by c.account_id),'[]'::jsonb) from bank_checks c) banks
  from diagnostics d cross join active_book b`,
  [input.tenantId, input.companyId, input.sourceId, input.fiscalPeriodId, input.bookId, [...input.bankAccountIds].sort()]);
  const row = result.rows[0];
  if (!row) throw new ErpFinancialsError("missing_document", "Fiscal period or active book does not exist in this scope");
  const diagnostics = fiscalCloseDiagnosticsFromRow(row.diagnostics as Record<string, unknown>);
  const bankRows: unknown = row.banks;
  if (!Array.isArray(bankRows) || bankRows.length !== input.bankAccountIds.length) throw new Error("Invalid canonical close bank checks");
  const banks = bankRows.map((rawBank: unknown): CanonicalFiscalCloseBankCheck => {
    if (!rawBank || typeof rawBank !== "object" || Array.isArray(rawBank)) throw new Error("Invalid canonical close bank row");
    const bank = rawBank as Record<string, unknown>;
    if (typeof bank.account_id !== "string" || typeof bank.has_activity !== "boolean" || typeof bank.account_exists !== "boolean"
      || (bank.statement_id !== null && (typeof bank.statement_id !== "string" || !Number.isSafeInteger(bank.statement_version)
        || Number(bank.statement_version) < 1 || (bank.statement_status !== "draft" && bank.statement_status !== "completed")))) {
      throw new Error("Invalid canonical close statement state");
    }
    const hasActivity = bank.has_activity;
    const reason = !bank.account_exists ? "missing_account" : !hasActivity ? "no_activity"
      : bank.statement_id === null ? "missing_statement" : bank.statement_status !== "completed" ? "statement_not_completed"
      : bank.difference !== "0.00" ? "statement_difference" : "ready";
    return { accountId: bank.account_id, hasActivity, statementId: bank.statement_id,
      statementVersion: bank.statement_version === null ? null : Number(bank.statement_version),
      statementStatus: bank.statement_status as "draft" | "completed" | null,
      evidenceRef: reason === "ready" ? `erp-financials-bank-statement:${String(bank.lifecycle_event_id)}` : null,
      ready: reason === "ready" || reason === "no_activity", reason };
  });
  const sourceRevision = String(row.source_revision);
  if (!/^(0|[1-9][0-9]*)$/.test(sourceRevision)) throw new Error("Invalid accounting source revision");
  const approvalToken = createHash("sha256").update(JSON.stringify(["canonical-fiscal-review-v1", input.tenantId, input.companyId, input.sourceId,
    input.bookId, sourceRevision, diagnostics, row.accounting_basis, row.base_currency_code, banks])).digest("hex");
  return { sourceRevision, approvalToken, diagnostics, bookId: input.bookId, accountingBasis: String(row.accounting_basis), currencyCode: String(row.base_currency_code), banks,
    ready: diagnostics.status !== "closed" && diagnostics.unbalancedPostingGroupCount === "0"
      && diagnostics.draftTransactionCount === "0" && diagnostics.draftInvoiceCount === "0" && banks.every(bank => bank.ready) };
}
