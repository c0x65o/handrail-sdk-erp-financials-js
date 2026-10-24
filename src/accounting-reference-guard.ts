import { ErpFinancialsError } from "./sdk-errors.js";
import type { ErpFinancialsTransactionRunner } from "./erp-financials-service.js";
import type { PostgresQueryClient } from "./postgres-storage.js";

export type AccountingReferenceGuardRequest = { readonly sourceIds: readonly string[] };
export type AccountingReferenceGuard = {
  /** Same explicit transaction as the guard. Host operational changes must use it. */
  readonly client: PostgresQueryClient;
  /** Conservative literal reference search, including immutable history and drafts.
   * Supply stable operational IDs and known canonical IDs, in bounded batches.
   * A voided/settled fact still counts; absence of a host link is not sufficient. */
  hasReferences(references: readonly string[]): Promise<boolean>;
};
type Scope = { readonly database: ErpFinancialsTransactionRunner; readonly tenantId: string; readonly companyId: string; readonly bookId: string };

function identifiers(raw: unknown, label: string): string[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 200 || raw.some(value => typeof value !== "string" || !value.trim() || value.length > 500)) {
    throw new ErpFinancialsError("invalid_input", `${label} requires 1–200 nonempty identifiers of at most 500 characters`);
  }
  return [...new Set(raw as string[])].sort();
}

// The package owns these tables and their reference representations. No host
// schema query, balances, per-row API fanout or history truncation is involved.
// Literal substring matching deliberately preserves legacy composite references
// and errs on retention. This infrequent operational guard is not a report API.
const referenceTables = [
  ["invoice_drafts", true], ["subledger_documents", true], ["transactions", false],
  ["invoice_draft_lines", true], ["subledger_document_lines", true],
  ["transaction_lines", false], ["ledger_postings", false],
  ["financial_lifecycle_events", true], ["financial_outbox", true],
  ["bill_payment_disbursements", true], ["bank_statement_lines", true], ["bank_reconciliation_matches", true],
] as const;
const referenceSql = `select exists(${referenceTables.map(([table, company]) => `
  select 1 from "erp_financials"."${table}" fact
  where fact."tenant_id"=$1 ${company ? 'and fact."company_id"=$2' : ''} and fact."source_id"=any($3::text[])
    and exists(select 1 from unnest($4::text[]) reference(value) where position(reference.value in to_jsonb(fact)::text)>0)
`).join(" union all ")}) as referenced`;

export async function withAccountingReferenceGuard<Result>(scope: Scope, request: AccountingReferenceGuardRequest,
  work: (guard: AccountingReferenceGuard) => Promise<Result>): Promise<Result> {
  const sourceIds = identifiers((request as AccountingReferenceGuardRequest | null)?.sourceIds, "Accounting reference source scope");
  if (typeof work !== "function") throw new ErpFinancialsError("invalid_input", "An accounting reference guard requires an operational callback");
  return scope.database.transaction(async client => {
    const before = (await client.query("select txid_current()::text transaction_id, current_setting('transaction_isolation') isolation")).rows[0];
    if (before?.isolation !== "read committed") throw new ErpFinancialsError("invalid_input", "Accounting reference guards require READ COMMITTED isolation");
    // Same key as native writes, draft edits and managed imports. Acquire before
    // host row/table locks; a fresh READ COMMITTED snapshot follows any wait.
    await client.query(`select pg_advisory_xact_lock_shared(hashtextextended(lock_key,0))
      from unnest($1::text[]) locks(lock_key) order by lock_key`, [sourceIds.map(sourceId => `payment-correction:${scope.tenantId}:${sourceId}`)]);
    const after = (await client.query("select txid_current()::text transaction_id")).rows[0];
    if (!before.transaction_id || before.transaction_id !== after?.transaction_id) throw new ErpFinancialsError("invalid_input", "Accounting reference guards require one explicit transaction client");
    const book = (await client.query(`select status from erp_financials.reporting_books
      where tenant_id=$1 and company_id=$2 and book_id=$3 for share`, [scope.tenantId,scope.companyId,scope.bookId])).rows[0];
    if (!book) throw new ErpFinancialsError("missing_book", "Accounting reference reporting book does not exist");
    if (book.status !== "active") throw new ErpFinancialsError("terminal_state_conflict", "Accounting reference reporting book is inactive");
    const sources = await client.query(`select source_id from erp_financials.reporting_book_sources
      where tenant_id=$1 and company_id=$2 and book_id=$3 and source_id=any($4::text[]) order by source_id for share`, [scope.tenantId,scope.companyId,scope.bookId,sourceIds]);
    if (sources.rows.length !== sourceIds.length) throw new ErpFinancialsError("missing_document", "Accounting reference source is outside the reporting book");
    let active = true;
    try {
      return await work({ client, hasReferences: async raw => {
        if (!active) throw new ErpFinancialsError("invalid_input", "Accounting reference guard has ended");
        const references = identifiers(raw, "Accounting references");
        const row = (await client.query(referenceSql, [scope.tenantId,scope.companyId,sourceIds,references])).rows[0];
        if (typeof row?.referenced !== "boolean") throw new ErpFinancialsError("invalid_input", "Accounting reference result is unavailable");
        return row.referenced;
      } });
    } finally { active = false; }
  });
}
