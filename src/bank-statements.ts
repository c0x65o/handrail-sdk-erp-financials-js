import { createHash } from "node:crypto";
import { copyFinancialOperation } from "./financial-approval-policy.js";
import { appendFinancialLifecycleEvent, assertFinancialOperationContext } from "./financial-lifecycle.js";
import { appendFinancialOutboxEvent } from "./financial-outbox.js";
import { assertPostingDateAllowed } from "./fiscal-periods.js";
import { lockCustomerPaymentCorrectionSource } from "./customer-payment-correction.js";
import { ErpFinancialsError } from "./sdk-errors.js";
import type { FinancialOperationContext } from "./financial-lifecycle.js";
import type { ErpFinancialsTransactionRunner } from "./erp-financials-service.js";
import type { PostgresQueryClient } from "./postgres-storage.js";

type Row = Readonly<Record<string, unknown>>;
type Scope = { readonly database: ErpFinancialsTransactionRunner; readonly tenantId: string; readonly companyId: string; readonly bookId: string; readonly sourceId: string; readonly currencyCode: string; readonly now?: () => string };
export type BankStatement = {
  readonly statementId: string; readonly externalStatementId: string; readonly accountId: string; readonly statementDate: string;
  readonly status: "draft" | "completed" | "cancelled"; readonly version: number; readonly currencyCode: string;
  readonly accountingBasis: string; readonly closingBalance: string; readonly openingBalance: string;
  readonly selectedAmount: string; readonly selectedCount: string; readonly difference: string;
  readonly preparedBy: string; readonly completedBy: string | null; readonly previousStatementId: string | null;
  readonly lifecycleEventId: string; readonly evidenceRef: string | null;
};
type Command = { readonly operation: FinancialOperationContext; readonly idempotencyKey: string; readonly expectedVersion: number };
export type PrepareBankStatementInput = Command & {
  readonly externalStatementId: string; readonly accountId: string; readonly statementDate: string; readonly closingBalance: string;
  /** Bounded deltas, never a replacement of the whole growing selection. */
  readonly addPostingIds?: readonly string[]; readonly removePostingIds?: readonly string[];
};
export type BankStatementTransitionInput = Command & { readonly statementId: string };
/** Cancellation of an uncertain command is separate from cancelling a draft statement. */
export type BankStatementCommandAttempt = { readonly action: "prepare"; readonly input: PrepareBankStatementInput }
  | { readonly action: "complete" | "reopen" | "cancel"; readonly input: BankStatementTransitionInput };
export type RetireBankStatementCommandInput = { readonly command: BankStatementCommandAttempt; readonly operation: FinancialOperationContext };
export type RetireBankStatementCommandResult = {
  readonly status: "retired" | "already_retired"; readonly action: BankStatementCommandAttempt["action"];
  readonly idempotencyKey: string; readonly statementId: string; readonly lifecycleEventId: string;
} | {
  readonly status: "already_recorded"; readonly action: BankStatementCommandAttempt["action"]; readonly idempotencyKey: string;
  /** Immutable original outcome, never the current state substituted as proof. */
  readonly statement: BankStatement;
  readonly currentStatement: BankStatement;
};
export type BankStatementActivityPage = {
  readonly items: readonly { readonly postingId: string; readonly transactionId: string; readonly postingDate: string; readonly amount: string; readonly selected: boolean }[];
  readonly nextCursor?: string;
};
export type BankStatementSelectionPage = {
  readonly items: readonly { readonly postingId:string; readonly transactionId:string; readonly transactionLineId?:string; readonly postingDate:string; readonly amount:string }[];
  readonly nextCursor?:string;
};
export type BankStatementClearingHistoryItem = {
  readonly historyId: string; readonly statementVersion: number; readonly action: "added" | "removed";
  readonly postingId: string; readonly transactionId: string; readonly accountId: string;
  readonly accountingBasis: string; readonly currencyCode: string; readonly postingDate: string;
  readonly amount: string; readonly lifecycleEventId: string;
};
export type BankStatementClearingHistoryPage = { readonly items: readonly BankStatementClearingHistoryItem[]; readonly nextCursor?: string };
export type BankStatementListInput = {
  readonly accountId: string; readonly fromDate: string; readonly throughDate: string;
  readonly includeCancelled?: boolean; readonly limit?: number; readonly cursor?: string;
};
export type BankStatementPage = { readonly items: readonly BankStatement[]; readonly nextCursor?: string };
export type BankStatementService = {
  list(input: BankStatementListInput): Promise<BankStatementPage>;
  retireCommandAttempt(input: RetireBankStatementCommandInput): Promise<RetireBankStatementCommandResult>;
  prepare(input: PrepareBankStatementInput): Promise<BankStatement>;
  complete(input: BankStatementTransitionInput): Promise<BankStatement>;
  cancel(input: BankStatementTransitionInput): Promise<BankStatement>;
  reopen(input: BankStatementTransitionInput): Promise<BankStatement>;
  get(statementId: string): Promise<BankStatement>;
  find(externalStatementId: string): Promise<BankStatement | null>;
  history(input: { readonly statementId: string; readonly limit?: number; readonly cursor?: string }): Promise<BankStatementClearingHistoryPage>;
  selection(input: { readonly statementId: string; readonly limit?: number; readonly cursor?: string }): Promise<BankStatementSelectionPage>;
  activity(input: { readonly statementId: string; readonly limit?: number; readonly cursor?: string }): Promise<BankStatementActivityPage>;
};

/** Manual statement attestation over canonical postings. It neither posts money
 * nor fabricates imported bank lines. Hosts authenticate actual actors; SDK
 * enforces distinct preparer/completer and immutable completion evidence. */
export function createBankStatementService(scope: Scope): BankStatementService {
  for (const value of [scope.tenantId, scope.companyId, scope.bookId, scope.sourceId]) text(value);
  return {
    list: input => list(scope, input),
    retireCommandAttempt: input => retireCommandAttempt(scope, input),
    prepare: input => prepare(scope, input),
    complete: input => transition(scope, input, "complete"),
    reopen: input => transition(scope, input, "reopen"),
    cancel: input => transition(scope, input, "cancel"),
    get: statementId => scope.database.transaction(async client => project(client, scope, await header(client, scope, statementId))),
    find: externalStatementId => scope.database.transaction(async client => {
      const id = `bank_statement_${hash([...params(scope), text(externalStatementId)])}`;
      const row = (await client.query(`select *,statement_date::text from erp_financials.bank_statements where ${scopeWhere} and statement_id=$5 for share`, [...params(scope), id])).rows[0];
      return row ? project(client, scope, row) : null;
    }),
    history: input => history(scope, input),
    selection: input => selection(scope, input),
    activity: input => activity(scope, input)
  };
}
const params = (s: Scope) => [s.tenantId, s.companyId, s.bookId, s.sourceId];
const scopeWhere = 'tenant_id=$1 and company_id=$2 and book_id=$3 and source_id=$4';
function text(value: unknown): string { if (typeof value !== "string" || !value.trim() || value.length > 1000) throw new ErpFinancialsError("invalid_input", "A bounded nonempty identity is required"); return value; }
function date(value: string): string { if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value + "T00:00:00Z")) || new Date(value + "T00:00:00Z").toISOString().slice(0, 10) !== value) throw new ErpFinancialsError("invalid_input", "A valid civil date is required"); return value; }
function minor(value: unknown): bigint { const s = String(value); if (!/^-?\d+(\.\d{1,2})?$/.test(s)) throw new ErpFinancialsError("invalid_input", "Money must be finite exact decimal cents"); const [whole, fraction = ""] = s.replace(/^-/, "").split("."); return BigInt((whole ?? "0") + fraction.padEnd(2, "0")) * (s.startsWith("-") ? -1n : 1n); }
function money(value: unknown): string { const n = minor(value), a = n < 0n ? -n : n; return `${n < 0n ? "-" : ""}${(a / 100n).toString()}.${String(a % 100n).padStart(2, "0")}`; }
function stable(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`; return JSON.stringify(value); }
const hash = (value: unknown) => createHash("sha256").update(stable(value)).digest("hex");
function snapshot<T extends Command>(input: T): T { const copy = { ...structuredClone(input), operation: copyFinancialOperation(input.operation) }; assertFinancialOperationContext(copy.operation); text(copy.idempotencyKey); if (!Number.isSafeInteger(copy.expectedVersion) || copy.expectedVersion < 0) throw new ErpFinancialsError("invalid_input", "Expected version must be a nonnegative integer"); return copy; }
function checksum(input: Command): string { const { operation, ...command } = input; return hash({ ...command, operation: { actorRef: operation.actorRef, approverRef: operation.approverRef, reasonCode: operation.reasonCode, reasonDetail: operation.reasonDetail } }); }
function conflict(message: string): never { throw new ErpFinancialsError("reconciliation_conflict", message); }
function required(row: Row | undefined): Row { if (!row) throw new ErpFinancialsError("missing_document", "Bank statement does not exist in the selected scope"); return row; }
async function header(client: PostgresQueryClient, scope: Scope, id: string): Promise<Row> {
  return required((await client.query(`select *,statement_date::text from erp_financials.bank_statements where ${scopeWhere} and statement_id=$5 for share`, [...params(scope), text(id)])).rows[0]);
}
async function project(client: PostgresQueryClient, scope: Scope, row: Row): Promise<BankStatement> {
  const totals = required((await client.query(`select coalesce(sum(amount),0)::text amount,count(*)::text count
    from erp_financials.bank_statement_clearings where ${scopeWhere} and statement_id=$5`, [...params(scope), row.statement_id])).rows[0]);
  const event = String(row.lifecycle_event_id);
  return { statementId: String(row.statement_id), externalStatementId: text(row.external_statement_id), accountId: String(row.account_id), statementDate: String(row.statement_date),
    status: row.status as BankStatement["status"], version: Number(row.version), currencyCode: String(row.currency_code), accountingBasis: String(row.accounting_basis),
    closingBalance: money(row.closing_balance), openingBalance: money(row.opening_balance), selectedAmount: money(totals.amount), selectedCount: String(totals.count),
    difference: moneyFromMinor(minor(row.closing_balance) - minor(row.opening_balance) - minor(totals.amount)),
    preparedBy: String(row.prepared_by), completedBy: row.completed_by === null ? null : text(row.completed_by), previousStatementId: row.previous_statement_id === null ? null : text(row.previous_statement_id),
    lifecycleEventId: event, evidenceRef: row.status === "completed" ? `erp-financials-bank-statement:${event}` : null };
}
function moneyFromMinor(n: bigint) { const a = n < 0n ? -n : n; return `${n < 0n ? "-" : ""}${(a / 100n).toString()}.${String(a % 100n).padStart(2, "0")}`; }
async function replay(client: PostgresQueryClient, scope: Scope, input: Command, action: string): Promise<BankStatement | undefined> {
  const row = (await client.query(`select event_id,payload from erp_financials.financial_lifecycle_events
    where tenant_id=$1 and company_id=$2 and source_id=$3 and idempotency_key=$4`,
    [scope.tenantId, scope.companyId, scope.sourceId, `bank-statement:${scope.bookId}:${input.idempotencyKey}`])).rows[0];
  if (!row) return;
  const payload = row.payload as { action?: string; checksum?: string; result?: Omit<BankStatement, "externalStatementId"> & { externalStatementId?: string } };
  if (payload.action !== action || payload.checksum !== checksum(input) || !payload.result) throw new ErpFinancialsError("idempotency_conflict", "Bank statement command key has different content");
  const externalStatementId = payload.result.externalStatementId ?? text((await header(client, scope, payload.result.statementId)).external_statement_id);
  return { ...payload.result, externalStatementId, lifecycleEventId: String(row.event_id), evidenceRef: payload.result.status === "completed" ? `erp-financials-bank-statement:${String(row.event_id)}` : null };
}
async function record(client: PostgresQueryClient, scope: Scope, input: Command, action: string, row: Row, changes: readonly { action: "added" | "removed"; row: Row }[] = []): Promise<BankStatement> {
  const projected = await project(client, scope, row);
  const result = { ...projected, lifecycleEventId: "", evidenceRef: null };
  const event = await appendFinancialLifecycleEvent(client, { tenantId: scope.tenantId, companyId: scope.companyId, sourceId: scope.sourceId,
    operation: input.operation, aggregateType: "bank_statement", aggregateId: result.statementId,
    eventType: `bank_statement.${action}`, idempotencyKey: `bank-statement:${scope.bookId}:${input.idempotencyKey}`,
    recordedAt: scope.now?.() ?? new Date().toISOString(), payload: { action, checksum: checksum(input), result } });
  if (changes.length) await client.query(`insert into erp_financials.bank_statement_clearing_history
    (history_id,tenant_id,company_id,book_id,source_id,statement_id,posting_id,transaction_id,account_id,accounting_basis,currency_code,posting_date,amount,statement_version,action,lifecycle_event_id)
    select x.history_id,$1,$2,$3,$4,$5,x.posting_id,x.transaction_id,x.account_id,x.accounting_basis,x.currency_code,x.posting_date,x.amount,$7,x.action,$6
    from jsonb_to_recordset($8::jsonb) as x(history_id text,posting_id text,transaction_id text,account_id text,accounting_basis text,currency_code text,posting_date date,amount numeric,action text)`,
    [...params(scope), result.statementId, event.eventId, result.version, JSON.stringify(changes.map(change => ({ ...change.row, action: change.action, history_id: `statement_clearing_${hash([event.eventId, change.action, change.row.posting_id])}` })))]);
  await client.query(`update erp_financials.bank_statements set lifecycle_event_id=$6 where ${scopeWhere} and statement_id=$5`, [...params(scope), result.statementId, event.eventId]);
  await appendFinancialOutboxEvent(client, { tenantId: scope.tenantId, companyId: scope.companyId, sourceId: scope.sourceId, bookId: scope.bookId,
    eventType: `bank_statement.${action}`, aggregateType: "bank_statement", aggregateId: result.statementId,
    idempotencyKey: `bank-statement:${scope.bookId}:${input.idempotencyKey}`, payload: { statementId: result.statementId, version: result.version, status: result.status }, availableAt: scope.now?.() ?? new Date().toISOString() });
  return { ...result, lifecycleEventId: event.eventId, evidenceRef: result.status === "completed" ? `erp-financials-bank-statement:${event.eventId}` : null };
}
async function lock(client: PostgresQueryClient, scope: Scope): Promise<void> {
  // Same order as native corrections/import protection: source before fiscal.
  await lockCustomerPaymentCorrectionSource(client, scope.tenantId, scope.sourceId);
}
function ids(input: readonly string[] | undefined): string[] { const items = [...(input ?? [])]; if (items.length > 500 || new Set(items).size !== items.length) throw new ErpFinancialsError("invalid_input", "Posting deltas must be unique and at most500 per command"); items.forEach(text); return items.sort(); }
function prepareInput(raw: PrepareBankStatementInput) {
  const input = snapshot({ ...raw, addPostingIds: ids(raw.addPostingIds), removePostingIds: ids(raw.removePostingIds), closingBalance: money(raw.closingBalance) });
  text(input.externalStatementId); text(input.accountId); date(input.statementDate);
  if (input.addPostingIds.some(id => input.removePostingIds.includes(id))) conflict("A posting cannot be both added and removed");
  return input;
}
function transitionInput(raw: BankStatementTransitionInput, action: "complete" | "reopen" | "cancel") {
  const input = snapshot(raw); text(input.statementId);
  if (action !== "complete" && (input.operation.reasonDetail?.trim().length ?? 0) < 10) throw new ErpFinancialsError("invalid_input", "Reopening or cancelling requires an explanatory reason");
  return input;
}
async function prepare(scope: Scope, raw: PrepareBankStatementInput): Promise<BankStatement> {
  const input = prepareInput(raw);
  const statementId = `bank_statement_${hash([...params(scope), input.externalStatementId])}`;
  return scope.database.transaction(async client => {
    await lock(client, scope);
    const prior = await replay(client, scope, input, "prepared"); if (prior) return prior;
    await assertPostingDateAllowed(client, scope, input.statementDate);
    const book = required((await client.query(`select b.accounting_basis,b.base_currency_code from erp_financials.reporting_books b
      join erp_financials.reporting_book_sources s using(tenant_id,company_id,book_id)
      join erp_financials.accounts a on a.tenant_id=s.tenant_id and a.source_id=s.source_id
      where b.tenant_id=$1 and b.company_id=$2 and b.book_id=$3 and s.source_id=$4 and a.account_id=$5
        and b.status='active' and a.classification in ('asset','liability')`, [...params(scope), input.accountId])).rows[0]);
    if (book.base_currency_code !== scope.currencyCode) conflict("Bank statement currency differs from the book");
    let row = (await client.query(`select *,statement_date::text from erp_financials.bank_statements where ${scopeWhere} and statement_id=$5 for update`, [...params(scope), statementId])).rows[0];
    if (!row) {
      if ((await client.query(`select 1 from erp_financials.bank_statements where ${scopeWhere} and account_id=$5 and status='draft' limit 1`, [...params(scope), input.accountId])).rows.length) conflict("Finish or cancel the existing account statement draft first");
      if (input.expectedVersion !== 0 || input.removePostingIds.length) conflict("New statements require version0 and no removals");
      const previous = (await client.query(`select statement_id,statement_date::text,closing_balance from erp_financials.bank_statements
        where ${scopeWhere} and account_id=$5 and status='completed' order by statement_date desc,statement_id desc limit 1`, [...params(scope), input.accountId])).rows[0];
      if (previous && String(previous.statement_date) >= input.statementDate) conflict("Statement dates must follow the latest completed statement");
      row = required((await client.query(`insert into erp_financials.bank_statements
        (statement_id,tenant_id,company_id,book_id,source_id,account_id,external_statement_id,accounting_basis,currency_code,statement_date,closing_balance,previous_statement_id,opening_balance,status,version,prepared_by,created_at,updated_at)
        values($5,$1,$2,$3,$4,$6,$7,$8,$9,$10,$11,$12,$13,'draft',1,$14,$15,$15) returning *,statement_date::text`,
        [...params(scope), statementId, input.accountId, input.externalStatementId, book.accounting_basis, scope.currencyCode, input.statementDate, input.closingBalance, previous?.statement_id ?? null, previous?.closing_balance ?? "0.00", input.operation.actorRef, scope.now?.() ?? new Date().toISOString()])).rows[0]);
    } else {
      if (row.status !== "draft" || row.version !== input.expectedVersion || row.account_id !== input.accountId) conflict("Only the current draft statement can be prepared");
      row = required((await client.query(`update erp_financials.bank_statements set statement_date=$6,closing_balance=$7,prepared_by=$8,version=version+1,updated_at=$9
        where ${scopeWhere} and statement_id=$5 returning *,statement_date::text`, [...params(scope), statementId, input.statementDate, input.closingBalance, input.operation.actorRef, scope.now?.() ?? new Date().toISOString()])).rows[0]);
    }
    const changes: { action: "added" | "removed"; row: Row }[] = [];
    if (input.removePostingIds.length) {
      const removed = await client.query(`delete from erp_financials.bank_statement_clearings where ${scopeWhere} and statement_id=$5 and posting_id=any($6::text[]) returning *,posting_date::text`, [...params(scope), statementId, input.removePostingIds]);
      changes.push(...removed.rows.map(row => ({ action: "removed" as const, row })));
      if (removed.rows.length !== input.removePostingIds.length) conflict("Only selected postings can be removed");
    }
    if (input.addPostingIds.length) {
      const added = await client.query(`insert into erp_financials.bank_statement_clearings
        (clearing_id,tenant_id,company_id,book_id,source_id,statement_id,posting_id,transaction_id,account_id,accounting_basis,currency_code,posting_date,amount)
        select $5||':'||p.posting_id,$1,$2,$3,$4,$5,p.posting_id,p.transaction_id,p.account_id,p.accounting_basis,p.currency_code,p.posting_date,p.net_amount
        from erp_financials.ledger_postings p join erp_financials.transactions t using(tenant_id,source_id,transaction_id)
        where p.tenant_id=$1 and p.source_id=$4 and p.posting_id=any($6::text[]) and p.account_id=$7 and p.accounting_basis=$8
          and p.currency_code=$9 and p.posting_date<=$10 and p.net_amount<>0 and t.status='posted'
        returning *,posting_date::text`, [...params(scope), statementId, input.addPostingIds, input.accountId, book.accounting_basis, scope.currencyCode, input.statementDate]);
      changes.push(...added.rows.map(row => ({ action: "added" as const, row })));
      if (added.rows.length !== input.addPostingIds.length) conflict("Selected postings are outside the statement scope, basis, currency, date or posted state");
    }
    const invalid = await client.query(`select 1 from erp_financials.bank_statement_clearings where ${scopeWhere} and statement_id=$5 and posting_date>$6 limit 1`, [...params(scope), statementId, input.statementDate]);
    if (invalid.rows.length) conflict("The statement cutoff excludes selected postings");
    return record(client, scope, input, "prepared", row, changes);
  });
}
async function transition(scope: Scope, raw: BankStatementTransitionInput, action: "complete" | "reopen" | "cancel"): Promise<BankStatement> {
  const input = transitionInput(raw, action);
  return scope.database.transaction(async client => {
    await lock(client, scope); const prior = await replay(client, scope, input, action === "complete" ? "completed" : action === "reopen" ? "reopened" : "cancelled"); if (prior) return prior;
    const row = await header(client, scope, input.statementId);
    await assertPostingDateAllowed(client, scope, String(row.statement_date));
    if (row.version !== input.expectedVersion || row.status !== (action === "reopen" ? "completed" : "draft")) conflict("The bank statement version or state changed");
    if (action === "complete") {
      if (row.prepared_by === input.operation.actorRef) throw new ErpFinancialsError("authorization_context_invalid", "A different actor must complete the prepared statement");
      if ((await project(client, scope, row)).difference !== "0.00") conflict("Bank statement must reconcile to exactly zero difference");
    } else if (action === "reopen") {
      if (row.completed_by === input.operation.actorRef) throw new ErpFinancialsError("authorization_context_invalid", "A different actor must reopen completed evidence");
      const later = await client.query(`select 1 from erp_financials.bank_statements where ${scopeWhere} and previous_statement_id=$5 and status<>'cancelled' limit 1`, [...params(scope), input.statementId]);
      if (later.rows.length) conflict("A later statement depends on this completion; unwind later statements first");
    }
    if (action === "cancel") await client.query(`update erp_financials.bank_statements set version=version+1 where ${scopeWhere} and statement_id=$5`, [...params(scope), input.statementId]);
    const removed = action === "cancel" ? (await client.query(`delete from erp_financials.bank_statement_clearings where ${scopeWhere} and statement_id=$5 returning *,posting_date::text`, [...params(scope), input.statementId])).rows : [];
    const updated = required((await client.query(`update erp_financials.bank_statements set status=$6,completed_by=$7,version=version+case when $6='cancelled' then 0 else 1 end,updated_at=$8
      where ${scopeWhere} and statement_id=$5 returning *,statement_date::text`, [...params(scope), input.statementId, action === "complete" ? "completed" : action === "reopen" ? "draft" : "cancelled", action === "complete" ? input.operation.actorRef : null, scope.now?.() ?? new Date().toISOString()])).rows[0]);
    return record(client, scope, input, action === "complete" ? "completed" : action === "reopen" ? "reopened" : "cancelled", updated, removed.map(row => ({ action: "removed", row })));
  });
}
/** Occupy the original lifecycle key while holding the same source lock as
 * prepare/transition. Older SDK replay code also rejects this terminal event,
 * so a delayed old writer cannot commit after cancellation. No statement,
 * clearing, posting or completion evidence is changed by this command. */
async function retireCommandAttempt(scope: Scope, raw: RetireBankStatementCommandInput): Promise<RetireBankStatementCommandResult> {
  const snapshot = structuredClone(raw), command = snapshot.command, operation = copyFinancialOperation(snapshot.operation);
  assertFinancialOperationContext(operation);
  if (!["prepare", "complete", "reopen", "cancel"].includes(command.action)) throw new ErpFinancialsError("invalid_input", "Unsupported bank statement command");
  const input = command.action === "prepare" ? prepareInput(command.input) : transitionInput(command.input, command.action);
  if (operation.actorRef !== input.operation.actorRef) throw new ErpFinancialsError("authorization_context_invalid", "Only the original actor may retire a statement command");
  const statementId = "externalStatementId" in input ? `bank_statement_${hash([...params(scope), input.externalStatementId])}` : input.statementId;
  const action = command.action === "prepare" ? "prepared" : command.action === "complete" ? "completed" : command.action === "reopen" ? "reopened" : "cancelled";
  const commandChecksum = checksum(input), retirementChecksum = checksum({ operation, idempotencyKey: input.idempotencyKey, expectedVersion: input.expectedVersion });
  const key = `bank-statement:${scope.bookId}:${input.idempotencyKey}`;
  return scope.database.transaction(async client => {
    await lock(client, scope);
    const row = (await client.query(`select event_id,event_type,aggregate_type,aggregate_id,payload from erp_financials.financial_lifecycle_events
      where tenant_id=$1 and company_id=$2 and source_id=$3 and idempotency_key=$4`, [scope.tenantId, scope.companyId, scope.sourceId, key])).rows[0];
    if (row) {
      const payload = row.payload as { action?: string; commandAction?: string; checksum?: string; retirementChecksum?: string };
      if (row.aggregate_type !== "bank_statement" || row.aggregate_id !== statementId) throw new ErpFinancialsError("idempotency_conflict", "Bank statement command key belongs to another statement");
      if (row.event_type === "bank_statement.command_retired") {
        if (payload.action !== "command_retired" || payload.commandAction !== command.action || payload.checksum !== commandChecksum || payload.retirementChecksum !== retirementChecksum) {
          throw new ErpFinancialsError("idempotency_conflict", "Bank statement retirement key has different content");
        }
        return { status: "already_retired", action: command.action, idempotencyKey: input.idempotencyKey, statementId, lifecycleEventId: String(row.event_id) };
      }
      if (row.event_type !== `bank_statement.${action}`) throw new ErpFinancialsError("idempotency_conflict", "Bank statement command key has a different action");
      const original = await replay(client, scope, input, action);
      if (!original) throw new ErpFinancialsError("idempotency_conflict", "Bank statement receipt is missing");
      return { status: "already_recorded", action: command.action, idempotencyKey: input.idempotencyKey, statement: original,
        currentStatement: await project(client, scope, await header(client, scope, statementId)) };
    }
    // Provenance only: current version, fiscal eligibility and completion status
    // must not strand an unaccepted command. A foreign scope cannot reserve it.
    if ("externalStatementId" in input) {
      const provenance = (await client.query(`select b.base_currency_code from erp_financials.reporting_books b
        join erp_financials.reporting_book_sources s using(tenant_id,company_id,book_id)
        join erp_financials.accounts a on a.tenant_id=s.tenant_id and a.source_id=s.source_id
        where b.tenant_id=$1 and b.company_id=$2 and b.book_id=$3 and s.source_id=$4 and a.account_id=$5`, [...params(scope), input.accountId])).rows[0];
      if (!provenance || provenance.base_currency_code !== scope.currencyCode) throw new ErpFinancialsError("scope_mismatch", "Statement retirement requires the original account, book, source and currency");
    } else await header(client, scope, statementId);
    const event = await appendFinancialLifecycleEvent(client, { tenantId: scope.tenantId, companyId: scope.companyId, sourceId: scope.sourceId,
      operation, aggregateType: "bank_statement", aggregateId: statementId, eventType: "bank_statement.command_retired", idempotencyKey: key,
      recordedAt: scope.now?.() ?? new Date().toISOString(), payload: { action: "command_retired", commandAction: command.action, checksum: commandChecksum, retirementChecksum } });
    return { status: "retired", action: command.action, idempotencyKey: input.idempotencyKey, statementId, lifecycleEventId: event.eventId };
  });
}
/** Only retained selected postings, never all outstanding account history. */
async function selection(scope:Scope,raw:{readonly statementId:string;readonly limit?:number;readonly cursor?:string}):Promise<BankStatementSelectionPage>{
  const input=structuredClone(raw),limit=input.limit??50;
  if(!Number.isInteger(limit)||limit<1||limit>500)throw new ErpFinancialsError("invalid_input","Selection page size must be 1 through 500");
  return scope.database.transaction(async client=>{
    const statement=await header(client,scope,input.statementId);
    const fingerprint=hash([...params(scope),input.statementId,statement.version,"selection"]);let afterDate:string|null=null,afterId:string|null=null;
    if(input.cursor){try{if(input.cursor.length>4096)throw Error();const cursor=JSON.parse(Buffer.from(input.cursor,"base64url").toString()) as Record<string,unknown>;if(cursor.scope!==fingerprint)throw Error();afterDate=date(text(cursor.date));afterId=text(cursor.id);}catch{throw new ErpFinancialsError("invalid_input","Selection cursor is invalid or stale");}}
    const rows=(await client.query(`select c.posting_id,c.transaction_id,c.posting_date::text,c.amount::text,
        p.posting_id valid_posting_id,p.transaction_line_id,line.transaction_line_id valid_line_id
      from erp_financials.bank_statement_clearings c
      left join erp_financials.ledger_postings p on p.tenant_id=c.tenant_id and p.source_id=c.source_id
        and p.posting_id=c.posting_id and p.transaction_id=c.transaction_id and p.account_id=c.account_id
        and p.accounting_basis=c.accounting_basis and p.currency_code=c.currency_code and p.net_amount=c.amount
      left join erp_financials.transaction_lines line on line.tenant_id=p.tenant_id and line.source_id=p.source_id
        and line.transaction_id=p.transaction_id and line.transaction_line_id=p.transaction_line_id and line.account_id=p.account_id
      where c.tenant_id=$1 and c.company_id=$2 and c.book_id=$3 and c.source_id=$4 and c.statement_id=$5
        and ($6::date is null or (c.posting_date,c.posting_id)>($6::date,$7::text)) order by c.posting_date,c.posting_id limit $8`,[...params(scope),input.statementId,afterDate,afterId,limit+1])).rows;
    const items=rows.slice(0,limit).map(row=>{
      if(row.valid_posting_id!==row.posting_id||(row.transaction_line_id!==null&&row.transaction_line_id!==row.valid_line_id))throw new ErpFinancialsError("invalid_input","Selected posting has invalid canonical line ownership");
      return {postingId:text(row.posting_id),transactionId:text(row.transaction_id),...(row.valid_line_id===null?{}:{transactionLineId:text(row.valid_line_id)}),postingDate:text(row.posting_date),amount:money(row.amount)};
    });
    const last=items.at(-1);return {items,...(rows.length>limit&&last?{nextCursor:Buffer.from(JSON.stringify({scope:fingerprint,date:last.postingDate,id:last.postingId})).toString("base64url")}:{})};
  });
}

async function activity(scope: Scope, raw: { readonly statementId: string; readonly limit?: number; readonly cursor?: string }): Promise<BankStatementActivityPage> {
  const input = structuredClone(raw), limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new ErpFinancialsError("invalid_input", "Page size must be1 to500");
  return scope.database.transaction(async client => {
    const row = await header(client, scope, input.statementId);
    const fingerprint = hash([...params(scope), input.statementId, row.version, row.statement_date]);
    let afterDate: string | null = null, afterId: string | null = null;
    if (input.cursor && input.cursor.length > 4096) throw new ErpFinancialsError("invalid_input", "Statement cursor exceeds its bound");
    if (input.cursor) {
      try { const parsed = JSON.parse(Buffer.from(input.cursor, "base64url").toString()) as { scope: string; date: string; id: string }; if (parsed.scope !== fingerprint) throw new Error(); afterDate = date(parsed.date); afterId = text(parsed.id); } catch { throw new ErpFinancialsError("invalid_input", "Statement cursor is invalid or stale"); }
    }
    const rows = (await client.query(`select p.posting_id,p.transaction_id,p.posting_date::text,p.net_amount::text amount,c.statement_id=$5 selected
      from erp_financials.ledger_postings p join erp_financials.transactions t using(tenant_id,source_id,transaction_id)
      left join erp_financials.bank_statement_clearings c on c.tenant_id=p.tenant_id and c.source_id=p.source_id and c.book_id=$3 and c.posting_id=p.posting_id
      where p.tenant_id=$1 and p.source_id=$4 and p.account_id=$6 and p.accounting_basis=$7 and p.currency_code=$8
        and p.posting_date<=$9 and p.net_amount<>0 and t.status='posted' and (c.statement_id is null or c.statement_id=$5)
        and not exists(select 1 from erp_financials.journal_entry_links l where l.tenant_id=p.tenant_id and l.source_id=p.source_id and l.original_transaction_id=p.transaction_id and l.link_type in ('void','reversal'))
        and ($10::date is null or (p.posting_date,p.posting_id)>($10::date,$11::text))
        and exists(select 1 from erp_financials.reporting_book_sources s where s.tenant_id=$1 and s.company_id=$2 and s.book_id=$3 and s.source_id=$4)
      order by p.posting_date,p.posting_id limit $12`, [...params(scope), input.statementId, row.account_id, row.accounting_basis, row.currency_code, row.statement_date, afterDate, afterId, limit + 1])).rows;
    const items = rows.slice(0, limit).map(p => ({ postingId: String(p.posting_id), transactionId: String(p.transaction_id), postingDate: String(p.posting_date), amount: money(p.amount), selected: p.selected === true }));
    const last = items.at(-1);
    return { items, ...(rows.length > limit && last ? { nextCursor: Buffer.from(JSON.stringify({ scope: fingerprint, date: last.postingDate, id: last.postingId })).toString("base64url") } : {}) };
  });
}

async function history(scope: Scope, raw: { readonly statementId: string; readonly limit?: number; readonly cursor?: string }): Promise<BankStatementClearingHistoryPage> {
  const input = structuredClone(raw), limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new ErpFinancialsError("invalid_input", "History page size must be1 to500");
  return scope.database.transaction(async client => {
    const row = await header(client, scope, input.statementId);
    const fingerprint = hash([...params(scope), input.statementId]);
    let version = Number(row.version), afterVersion = 0, afterId = "";
    if (input.cursor) {
      try {
        if (input.cursor.length > 4096) throw new Error();
        const parsed = JSON.parse(Buffer.from(input.cursor, "base64url").toString()) as { scope: string; version: number; afterVersion: number; afterId: string };
        if (parsed.scope !== fingerprint || !Number.isInteger(parsed.version) || parsed.version < 1 || parsed.version > version || !Number.isInteger(parsed.afterVersion) || parsed.afterVersion < 1 || parsed.afterVersion > parsed.version) throw new Error();
        version = parsed.version; afterVersion = parsed.afterVersion; afterId = text(parsed.afterId);
      } catch { throw new ErpFinancialsError("invalid_input", "Statement history cursor is invalid"); }
    }
    const rows = (await client.query(`select *,posting_date::text from erp_financials.bank_statement_clearing_history
      where ${scopeWhere} and statement_id=$5 and statement_version<=$6 and (statement_version,history_id)>($7,$8)
      order by statement_version,history_id limit $9`, [...params(scope), input.statementId, version, afterVersion, afterId, limit + 1])).rows;
    const items = rows.slice(0, limit).map(r => ({ historyId: text(r.history_id), statementVersion: Number(r.statement_version), action: r.action as "added" | "removed",
      postingId: text(r.posting_id), transactionId: text(r.transaction_id), accountId: text(r.account_id), accountingBasis: text(r.accounting_basis), currencyCode: text(r.currency_code), postingDate: text(r.posting_date), amount: money(r.amount), lifecycleEventId: text(r.lifecycle_event_id) }));
    const last = items.at(-1);
    return { items, ...(rows.length > limit && last ? { nextCursor: Buffer.from(JSON.stringify({ scope: fingerprint, version, afterVersion: last.statementVersion, afterId: last.historyId })).toString("base64url") } : {}) };
  });
}

async function list(scope: Scope, raw: BankStatementListInput): Promise<BankStatementPage> {
  const input = structuredClone(raw), limit = input.limit ?? 50;
  text(input.accountId); date(input.fromDate); date(input.throughDate);
  if (input.fromDate > input.throughDate || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new ErpFinancialsError("invalid_input", "Statement range or page size is invalid");
  const fingerprint = hash([...params(scope), input.accountId, input.fromDate, input.throughDate, input.includeCancelled ?? false]);
  let afterDate: string | null = null, afterId: string | null = null;
  if (input.cursor) {
    try {
      if (input.cursor.length > 4096) throw new Error();
      const parsed = JSON.parse(Buffer.from(input.cursor, "base64url").toString()) as { scope: string; date: string; id: string };
      if (parsed.scope !== fingerprint) throw new Error(); afterDate = date(parsed.date); afterId = text(parsed.id);
    } catch { throw new ErpFinancialsError("invalid_input", "Statement list cursor is invalid for this scope"); }
  }
  return scope.database.transaction(async client => {
    // The committed header and its immutable, constraint-validated receipt form
    // one MVCC result. Never collect selections or issue a detail query per row.
    const rows = (await client.query(`select s.statement_id,s.external_statement_id,s.statement_date::text,s.version,s.status,e.event_id,e.payload
      from erp_financials.bank_statements s join erp_financials.financial_lifecycle_events e on e.event_id=s.lifecycle_event_id
      where s.tenant_id=$1 and s.company_id=$2 and s.book_id=$3 and s.source_id=$4 and s.account_id=$5
        and s.statement_date between $6 and $7 and ($8::boolean or s.status<>'cancelled')
        and ($9::date is null or (s.statement_date,s.statement_id)<($9::date,$10::text))
      order by s.statement_date desc,s.statement_id desc limit $11`, [...params(scope), input.accountId, input.fromDate, input.throughDate, input.includeCancelled ?? false, afterDate, afterId, limit + 1])).rows;
    const items = rows.slice(0, limit).map(row => {
      const result = (row.payload as { result?: BankStatement }).result;
      if (!result || result.statementId !== row.statement_id || result.version !== row.version || result.status !== row.status) throw new ErpFinancialsError("invalid_input", "Statement receipt does not agree with current canonical state");
      return { ...result, externalStatementId: text(row.external_statement_id), lifecycleEventId: text(row.event_id), evidenceRef: result.status === "completed" ? `erp-financials-bank-statement:${text(row.event_id)}` : null };
    });
    const last = items.at(-1);
    return { items, ...(rows.length > limit && last ? { nextCursor: Buffer.from(JSON.stringify({ scope: fingerprint, date: last.statementDate, id: last.statementId })).toString("base64url") } : {}) };
  });
}
