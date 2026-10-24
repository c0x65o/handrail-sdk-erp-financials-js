import type { BankStatement } from "./bank-statements.js";
import { createHash } from "node:crypto";
import { ErpFinancialsError } from "./sdk-errors.js";
import type { PostgresQueryClient } from "./postgres-storage.js";
import type { FiscalPeriodResult, FiscalPeriodScope, FiscalPeriodTransactionRunner } from "./fiscal-periods.js";
import type { CanonicalFiscalCloseReadiness, FiscalCloseDiagnostics } from "./fiscal-close-diagnostics.js";

export type CanonicalFiscalCloseResult = FiscalPeriodResult & { readonly certificateId: string };
export type FiscalCloseCertificate = {
  readonly approvalToken?: string; readonly sourceRevision?: string;
  readonly certificateId: string; readonly bookId: string; readonly capturedAt: string;
  readonly accountingBasis: string; readonly currencyCode: string;
  readonly diagnostics: FiscalCloseDiagnostics; readonly result: CanonicalFiscalCloseResult;
};
export type FiscalCloseControlTotal = {
  readonly accountId: string; readonly accountingBasis: string; readonly currencyCode: string;
  readonly openingNet: string; readonly debitAmount: string; readonly creditAmount: string; readonly closingNet: string;
  readonly postingCount: string; readonly historicalPostingCount: string;
};
export type FiscalCloseBankEvidence = {
  readonly accountId: string; readonly hasActivity: boolean;
  readonly statementId: string | null; readonly statementVersion: number | null; readonly statementEventId: string | null;
};
/** Immutable completion captured by a particular close. A later reopening of
 * the live statement never changes this receipt. Older native completions may
 * lack externalStatementId; do not invent it from a mutable current header. */
export type FiscalCloseBankReceipt = Omit<BankStatement, "externalStatementId" | "status" | "completedBy"> & {
  readonly externalStatementId?: string; readonly status: "completed"; readonly completedBy: string; readonly recordedAt: string;
};
export type FiscalCloseBankReceiptInput = { readonly certificateId: string; readonly accountId: string };
export type FiscalCloseCertificatePageInput = { readonly certificateId: string; readonly limit?: number; readonly cursor?: string };
export type FiscalCloseCertificatePage<T> = { readonly items: readonly T[]; readonly nextCursor?: string };
/** Exact control-total comparison, not an assertion that the period remains
 * closed or that account mappings, metadata, or bank evidence are unchanged. */
export type FiscalCloseTotalsVerification = {
  readonly certificateId: string;
  readonly matches: boolean;
  readonly differingAccountGroupCount: string;
  readonly capturedAccountGroupCount: string;
  readonly currentAccountGroupCount: string;
};
/** Holds the scoped posting guard and period row through the caller's explicit
 * transaction. This verifies the retained close is still the current close. */
export type FiscalCloseStateVerification = {
  readonly certificateId: string;
  readonly closedAtCapturedVersion: boolean;
  readonly bankEvidenceRefs: readonly string[];
  readonly matches: boolean;
  readonly totals: FiscalCloseTotalsVerification;
};
export type FiscalCloseCertificateQueries = {
  verifyClosedState(certificateId: string): Promise<FiscalCloseStateVerification>;
  verifyCurrentTotals(certificateId: string): Promise<FiscalCloseTotalsVerification>;
  get(certificateId: string): Promise<FiscalCloseCertificate>;
  bankReceipt(input: FiscalCloseBankReceiptInput): Promise<FiscalCloseBankReceipt | null>;
  totals(input: FiscalCloseCertificatePageInput): Promise<FiscalCloseCertificatePage<FiscalCloseControlTotal>>;
  banks(input: FiscalCloseCertificatePageInput): Promise<FiscalCloseCertificatePage<FiscalCloseBankEvidence>>;
};

type Scope = FiscalPeriodScope & { readonly bookId: string; readonly database: FiscalPeriodTransactionRunner };
const params = (scope: FiscalPeriodScope) => [scope.tenantId, scope.companyId, scope.sourceId];
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 1500) throw new ErpFinancialsError("invalid_input", "A bounded nonempty certificate identity is required");
  return value;
}
export function canonicalCloseChecksum(value: unknown): string { return createHash("sha256").update(stable(value)).digest("hex"); }
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  return JSON.stringify(value);
}

/** Caller holds the exclusive fiscal lock. Capture uses INSERT SELECT, never
 * loads posting histories or account-total arrays into application memory. */
export async function recordCanonicalCloseCertificate(client: PostgresQueryClient, scope: FiscalPeriodScope, input: {
  readonly bookId: string; readonly idempotencyKey: string; readonly commandChecksum: string;
  readonly expectedVersion: number; readonly capturedAt: string;
  readonly readiness: CanonicalFiscalCloseReadiness; readonly result: CanonicalFiscalCloseResult;
}): Promise<void> {
  const { readiness, result } = input;
  await client.query(`insert into erp_financials.fiscal_close_certificates
    (certificate_id,tenant_id,company_id,source_id,book_id,accounting_basis,currency_code,fiscal_period_id,idempotency_key,command_checksum,
     expected_version,bank_count,captured_at,creation_txid,close_event_id,diagnostics,result)
    values ($4,$1,$2,$3,$5,$6,$7,$8,$9,$10,$11,$12,$13,txid_current()::text,$14,$15::jsonb,$16::jsonb)`,
  [...params(scope), result.certificateId, input.bookId, readiness.accountingBasis, readiness.currencyCode, result.fiscalPeriodId,
    input.idempotencyKey, input.commandChecksum, input.expectedVersion, readiness.banks.length, input.capturedAt,
    result.lifecycleEventId, JSON.stringify({ ...readiness.diagnostics, approvalToken: readiness.approvalToken, sourceRevision: readiness.sourceRevision }), JSON.stringify(result)]);
  await client.query(`insert into erp_financials.fiscal_close_totals
    (total_id,tenant_id,company_id,source_id,certificate_id,account_id,accounting_basis,currency_code,opening_net,debit_amount,credit_amount,closing_net,posting_count,historical_posting_count)
    select $4||':'||jsonb_build_array(account_id,accounting_basis,currency_code)::text,$1,$2,$3,$4,account_id,accounting_basis,currency_code,
      coalesce(sum(net_amount) filter(where posting_date<$5::date),0),
      coalesce(sum(debit_amount) filter(where posting_date>=$5::date),0),
      coalesce(sum(credit_amount) filter(where posting_date>=$5::date),0),sum(net_amount),
      count(*) filter(where posting_date>=$5::date),count(*)
    from erp_financials.ledger_postings where tenant_id=$1 and source_id=$3 and posting_date<=$6::date
    group by account_id,accounting_basis,currency_code`,
  [...params(scope), result.certificateId, readiness.diagnostics.periodStart, readiness.diagnostics.periodEnd]);
  if (readiness.banks.length) await client.query(`insert into erp_financials.fiscal_close_banks
    (bank_check_id,tenant_id,company_id,source_id,certificate_id,account_id,has_activity,statement_id,statement_version,statement_event_id)
    select $4||':'||x.account_id,$1,$2,$3,$4,x.account_id,x.has_activity,x.statement_id,x.statement_version,x.statement_event_id
    from jsonb_to_recordset($5::jsonb) x(account_id text,has_activity boolean,statement_id text,statement_version integer,statement_event_id text)`,
  [...params(scope), result.certificateId, JSON.stringify(readiness.banks.map(bank => ({ account_id: bank.accountId,
    has_activity: bank.hasActivity, statement_id: bank.hasActivity ? bank.statementId : null,
    statement_version: bank.hasActivity ? bank.statementVersion : null,
    statement_event_id: bank.hasActivity ? bank.evidenceRef?.replace(/^erp-financials-bank-statement:/, "") : null }))) ]);
}

async function get(client: PostgresQueryClient, scope: Scope, certificateId: string): Promise<FiscalCloseCertificate> {
  const row = (await client.query(`select certificate_id,book_id,accounting_basis,currency_code,captured_at,diagnostics,result
    from erp_financials.fiscal_close_certificates where tenant_id=$1 and company_id=$2 and source_id=$3 and certificate_id=$4 and book_id=$5`,
  [...params(scope), text(certificateId), scope.bookId])).rows[0];
  if (!row) throw new ErpFinancialsError("missing_document", "Close certificate does not exist in this scope");
  const result = row.result as CanonicalFiscalCloseResult;
  if (result.certificateId !== row.certificate_id || result.status !== "closed") throw new Error("Invalid canonical close receipt");
  const diagnostic = row.diagnostics as FiscalCloseDiagnostics & { approvalToken?: string; sourceRevision?: string };
  return { ...(diagnostic.approvalToken === undefined ? {} : { approvalToken: text(diagnostic.approvalToken), sourceRevision: text(diagnostic.sourceRevision) }), certificateId: text(row.certificate_id), bookId: text(row.book_id), accountingBasis: text(row.accounting_basis), currencyCode: text(row.currency_code),
    capturedAt: row.captured_at instanceof Date ? row.captured_at.toISOString() : new Date(text(row.captured_at)).toISOString(),
    diagnostics: row.diagnostics as FiscalCloseDiagnostics, result };
}

export function createFiscalCloseCertificateQueries(scope: Scope): FiscalCloseCertificateQueries {
  return {
    get: certificateId => scope.database.transaction(client => get(client, scope, certificateId)),
    verifyCurrentTotals: certificateId => verifyCurrentTotals(scope, certificateId),
    verifyClosedState: certificateId => verifyClosedState(scope, certificateId),
    bankReceipt: input => bankReceipt(scope, input),
    totals: input => page(scope, input, "totals"),
    banks: input => page(scope, input, "banks")
  };
}
async function bankReceipt(scope: Scope, input: FiscalCloseBankReceiptInput): Promise<FiscalCloseBankReceipt | null> {
  const certificateId = text(input.certificateId), accountId = text(input.accountId);
  return scope.database.transaction(async client => {
    const row = (await client.query(`select b.has_activity,b.statement_id,b.statement_version,b.statement_event_id,
      c.accounting_basis,c.currency_code,c.diagnostics->>'periodEnd' period_end,
      e.event_type,e.aggregate_id,e.recorded_at,e.payload
      from erp_financials.fiscal_close_certificates c
      join erp_financials.fiscal_close_banks b on b.tenant_id=c.tenant_id and b.company_id=c.company_id
        and b.source_id=c.source_id and b.certificate_id=c.certificate_id
      left join erp_financials.financial_lifecycle_events e on e.tenant_id=b.tenant_id and e.company_id=b.company_id
        and e.source_id=b.source_id and e.event_id=b.statement_event_id
      where c.tenant_id=$1 and c.company_id=$2 and c.source_id=$3 and c.certificate_id=$4 and c.book_id=$5 and b.account_id=$6`,
    [...params(scope), certificateId, scope.bookId, accountId])).rows[0];
    if (!row) throw new ErpFinancialsError("missing_document", "Bank evidence does not exist in this close certificate and scope");
    if (row.has_activity === false) return null;
    const result = (row.payload as { result?: BankStatement } | null)?.result;
    if (!result || row.event_type !== "bank_statement.completed" || row.aggregate_id !== row.statement_id
      || result.statementId !== row.statement_id || result.accountId !== accountId || result.version !== row.statement_version
      || result.status !== "completed" || !result.completedBy || result.preparedBy === result.completedBy
      || result.statementDate !== row.period_end || result.currencyCode !== row.currency_code || result.accountingBasis !== row.accounting_basis
      || result.difference !== "0.00") throw new Error("Invalid immutable close bank completion receipt");
    const eventId = text(row.statement_event_id);
    const recordedAt = row.recorded_at instanceof Date ? row.recorded_at.toISOString() : new Date(text(row.recorded_at)).toISOString();
    return { ...result, status: "completed", completedBy: result.completedBy, recordedAt,
      lifecycleEventId: eventId, evidenceRef: `erp-financials-bank-statement:${eventId}` };
  });
}

function page(scope: Scope, input: FiscalCloseCertificatePageInput, kind: "totals"): Promise<FiscalCloseCertificatePage<FiscalCloseControlTotal>>;
function page(scope: Scope, input: FiscalCloseCertificatePageInput, kind: "banks"): Promise<FiscalCloseCertificatePage<FiscalCloseBankEvidence>>;
async function page(scope: Scope, raw: FiscalCloseCertificatePageInput, kind: "totals" | "banks"): Promise<FiscalCloseCertificatePage<FiscalCloseControlTotal | FiscalCloseBankEvidence>> {
  const input = structuredClone(raw), limit = input.limit ?? 50;
  text(input.certificateId);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ErpFinancialsError("invalid_input", "Certificate page size must be 1 through 200");
  const fingerprint = canonicalCloseChecksum([...params(scope), scope.bookId, input.certificateId, kind]);
  let account = "", basis = "", currency = "";
  if (input.cursor) {
    try {
      if (input.cursor.length > 4096) throw new Error();
      const cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString()) as Record<string, unknown>;
      if (cursor.scope !== fingerprint) throw new Error();
      account = text(cursor.account); if (kind === "totals") { basis = text(cursor.basis); currency = text(cursor.currency); }
    } catch { throw new ErpFinancialsError("invalid_input", "Certificate cursor does not match this scope"); }
  }
  return scope.database.transaction(async client => {
    await get(client, scope, input.certificateId);
    const rows = kind === "totals" ? (await client.query(`select account_id,accounting_basis,currency_code,opening_net::text,debit_amount::text,credit_amount::text,closing_net::text,posting_count::text,historical_posting_count::text
      from erp_financials.fiscal_close_totals where tenant_id=$1 and company_id=$2 and source_id=$3 and certificate_id=$4
      and (account_id,accounting_basis,currency_code)>($5,$6,$7) order by account_id,accounting_basis,currency_code limit $8`,
    [...params(scope), input.certificateId, account, basis, currency, limit + 1])).rows
      : (await client.query(`select account_id,has_activity,statement_id,statement_version,statement_event_id
      from erp_financials.fiscal_close_banks where tenant_id=$1 and company_id=$2 and source_id=$3 and certificate_id=$4
      and account_id>$5 order by account_id limit $6`, [...params(scope), input.certificateId, account, limit + 1])).rows;
    const items = rows.slice(0, limit).map(row => kind === "totals" ? {
      accountId: text(row.account_id), accountingBasis: text(row.accounting_basis), currencyCode: text(row.currency_code), openingNet: text(row.opening_net),
      debitAmount: text(row.debit_amount), creditAmount: text(row.credit_amount), closingNet: text(row.closing_net), postingCount: text(row.posting_count), historicalPostingCount: text(row.historical_posting_count)
    } : { accountId: text(row.account_id), hasActivity: row.has_activity === true, statementId: row.statement_id === null ? null : text(row.statement_id),
      statementVersion: row.statement_version === null ? null : Number(row.statement_version), statementEventId: row.statement_event_id === null ? null : text(row.statement_event_id) });
    const last = rows[Math.min(rows.length, limit) - 1];
    return { items, ...(rows.length > limit && last ? { nextCursor: Buffer.from(JSON.stringify({ scope: fingerprint, account: last.account_id, ...(kind === "totals" ? { basis: last.accounting_basis, currency: last.currency_code } : {}) })).toString("base64url") } : {}) };
  });
}

async function verifyClosedState(scope: Scope, rawId: string): Promise<FiscalCloseStateVerification> {
  const certificateId=text(rawId);
  return scope.database.transaction(async client=>{
    // Native accounting writes acquire the exclusive counterpart. The period
    // row lock also covers reopen, which uses the separate fiscal lock.
    await client.query("select pg_advisory_xact_lock_shared(hashtextextended($1,0))",[`payment-correction:${scope.tenantId}:${scope.sourceId}`]);
    const row=(await client.query(`select period.status,period.version,period.close_event_id,
        certificate.result,certificate.bank_count,book.status book_status,
        (select coalesce(jsonb_agg(jsonb_build_object('hasActivity',bank.has_activity,'eventId',bank.statement_event_id) order by bank.account_id),'[]'::jsonb)
          from erp_financials.fiscal_close_banks bank where bank.tenant_id=certificate.tenant_id
            and bank.company_id=certificate.company_id and bank.source_id=certificate.source_id
            and bank.certificate_id=certificate.certificate_id) bank_evidence
      from erp_financials.fiscal_close_certificates certificate
      join erp_financials.fiscal_periods period on period.tenant_id=certificate.tenant_id
        and period.company_id=certificate.company_id and period.source_id=certificate.source_id
        and period.fiscal_period_id=certificate.fiscal_period_id
      join erp_financials.reporting_books book on book.tenant_id=certificate.tenant_id
        and book.company_id=certificate.company_id and book.book_id=certificate.book_id
      where certificate.tenant_id=$1 and certificate.company_id=$2 and certificate.source_id=$3
        and certificate.certificate_id=$4 and certificate.book_id=$5 for share of period,book`,
      [...params(scope),certificateId,scope.bookId])).rows[0];
    if(!row)throw new ErpFinancialsError("missing_document","Close certificate does not exist in this scope");
    if(row.book_status!=="active")throw new ErpFinancialsError("terminal_state_conflict","Close certificate reporting book is inactive");
    const result=row.result as CanonicalFiscalCloseResult;
    if(result.certificateId!==certificateId||result.status!=="closed")throw new Error("Invalid canonical close receipt");
    const banks:unknown=row.bank_evidence;
    if(!Array.isArray(banks)||banks.length!==Number(row.bank_count)||banks.length>200)throw new Error("Invalid canonical close bank evidence");
    const bankEvidenceRefs=banks.flatMap((raw:unknown)=>{
      if(!raw||typeof raw!=="object")throw new Error("Invalid canonical close bank evidence");
      const bank=raw as Record<string,unknown>;
      if(typeof bank.hasActivity!=="boolean")throw new Error("Invalid canonical close bank evidence");
      return bank.hasActivity?[`erp-financials-bank-statement:${text(bank.eventId)}`]:[];
    });
    const closedAtCapturedVersion=row.status==="closed"&&Number(row.version)===result.version&&row.close_event_id===result.lifecycleEventId;
    const totals=await verifyCurrentTotals({...scope,database:{transaction:work=>work(client)}},certificateId);
    return {certificateId,closedAtCapturedVersion,bankEvidenceRefs,matches:closedAtCapturedVersion&&totals.matches,totals};
  });
}

/** One SQL snapshot and one result row. All aggregation and comparison stays in
 * PostgreSQL; even a million-entry history never crosses into application RAM.
 * Compare every captured basis/currency, including inactive historical accounts.
 * A later-period posting is excluded; prior-period changes affect opening totals.
 */
async function verifyCurrentTotals(scope: Scope, rawId: string): Promise<FiscalCloseTotalsVerification> {
  const certificateId = text(rawId);
  return scope.database.transaction(async client => {
    const row = (await client.query(`with certificate as (
      select certificate_id,(diagnostics->>'periodStart')::date period_start,(diagnostics->>'periodEnd')::date period_end
      from erp_financials.fiscal_close_certificates
      where tenant_id=$1 and company_id=$2 and source_id=$3 and certificate_id=$4 and book_id=$5
    ), captured as (
      select account_id,accounting_basis,currency_code,opening_net,debit_amount,credit_amount,closing_net,posting_count,historical_posting_count
      from erp_financials.fiscal_close_totals where tenant_id=$1 and company_id=$2 and source_id=$3
        and certificate_id=(select certificate_id from certificate)
    ), current_totals as (
      select account_id,accounting_basis,currency_code,
        coalesce(sum(net_amount) filter(where posting_date<(select period_start from certificate)),0) opening_net,
        coalesce(sum(debit_amount) filter(where posting_date>=(select period_start from certificate)),0) debit_amount,
        coalesce(sum(credit_amount) filter(where posting_date>=(select period_start from certificate)),0) credit_amount,
        sum(net_amount) closing_net,
        count(*) filter(where posting_date>=(select period_start from certificate)) posting_count,
        count(*) historical_posting_count
      from erp_financials.ledger_postings where tenant_id=$1 and source_id=$3
        and posting_date<=(select period_end from certificate)
      group by account_id,accounting_basis,currency_code
    ), differences as (
      select 1 from captured c full outer join current_totals n using(account_id,accounting_basis,currency_code)
      where c.account_id is null or n.account_id is null
        or row(c.opening_net,c.debit_amount,c.credit_amount,c.closing_net,c.posting_count,c.historical_posting_count)
          is distinct from row(n.opening_net,n.debit_amount,n.credit_amount,n.closing_net,n.posting_count,n.historical_posting_count)
    ) select certificate_id,(select count(*)::text from differences) difference_count,
      (select count(*)::text from captured) captured_count,(select count(*)::text from current_totals) current_count
      from certificate`, [...params(scope), certificateId, scope.bookId])).rows[0];
    if (!row) throw new ErpFinancialsError("missing_document", "Close certificate does not exist in this scope");
    const count = (key: string) => {
      const value = row[key];
      if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("Invalid close control-total count");
      return value;
    };
    const differingAccountGroupCount = count("difference_count");
    return { certificateId, matches: differingAccountGroupCount === "0", differingAccountGroupCount,
      capturedAccountGroupCount: count("captured_count"), currentAccountGroupCount: count("current_count") };
  });
}
