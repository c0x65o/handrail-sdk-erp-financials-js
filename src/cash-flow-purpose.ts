import { createHash } from "node:crypto";
import { assertFinancialApproval, copyFinancialOperation, type FinancialActionContext } from "./financial-approval-policy.js";
import { appendFinancialLifecycleEvent, type FinancialOperationContext } from "./financial-lifecycle.js";
import { appendFinancialOutboxEvent } from "./financial-outbox.js";
import { lockCustomerPaymentCorrectionSource } from "./customer-payment-correction.js";
import { assertPostingDateAllowed } from "./fiscal-periods.js";
import { ErpFinancialsError } from "./sdk-errors.js";
import type { ErpFinancialsTransactionRunner } from "./erp-financials-service.js";

export type CashFlowPurposeAmounts = { readonly operating: string; readonly investing: string; readonly financing: string };
export type CorrectCashFlowPurposeInput = CashFlowPurposeAmounts & {
  readonly documentId: string;
  /** Zero means no explicit correction has been accepted. */
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
  readonly operation: FinancialOperationContext;
};
export type CashFlowPurposeCorrection = CashFlowPurposeAmounts & {
  readonly documentId: string; readonly revision: number; readonly lifecycleEventId: string;
};
export type CorrectCashFlowPurposeResult = CashFlowPurposeCorrection & { readonly status: "corrected" | "already_corrected" };

/** Restate an erroneous cash purpose, not cash, balances, allocation or provider
 * movement. Every affected original/return period must be open. Initial accepted
 * document payloads remain intact so old command retries retain their meaning. */
export async function correctCashFlowPurpose(context: FinancialActionContext, input: CorrectCashFlowPurposeInput): Promise<CorrectCashFlowPurposeResult> {
  const operation = copyFinancialOperation(input.operation);
  assertFinancialApproval(context, operation);
  const command = { documentId: nonempty(input.documentId), expectedRevision: input.expectedRevision,
    idempotencyKey: nonempty(input.idempotencyKey), operating: money(input.operating), investing: money(input.investing), financing: money(input.financing) };
  if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0 || command.expectedRevision >= 2147483647) invalid("Invalid purpose revision");
  if (!context.bookId) invalid("A native posting book is required for cash purpose correction");
  const checksum = createHash("sha256").update(JSON.stringify({ ...command, bookId: context.bookId, currencyCode: context.currencyCode,
    actorRef: operation.actorRef, approverRef: operation.approverRef, reasonCode: operation.reasonCode, reasonDetail: operation.reasonDetail })).digest("hex");
  const key = `cash-flow-purpose:${command.idempotencyKey}`;
  return context.database.transaction(async client => {
    await client.query("savepoint erp_cash_flow_purpose");
    try {
      await lockCustomerPaymentCorrectionSource(client, context.tenantId, context.sourceId);
      const scope = [context.tenantId, context.companyId, context.sourceId];
      if (!(await client.query(`select 1 from erp_financials.company_sources where tenant_id=$1 and company_id=$2 and source_id=$3 for key share`, scope)).rows.length) throw new ErpFinancialsError("scope_mismatch", "Company is not bound to this source");
      const prior = (await client.query(`select event_id,aggregate_id,payload from erp_financials.financial_lifecycle_events
where tenant_id=$1 and company_id=$2 and source_id=$3 and idempotency_key=$4`, [...scope, key])).rows[0];
      if (prior) {
        const payload = prior.payload as { commandChecksum?: string; result?: CashFlowPurposeCorrection };
        if (prior.aggregate_id !== command.documentId || payload.commandChecksum !== checksum || !payload.result) throw new ErpFinancialsError("idempotency_conflict", "Cash purpose correction key has a different accepted command");
        await client.query("release savepoint erp_cash_flow_purpose");
        return { ...payload.result, lifecycleEventId: prior.event_id as string, status: "already_corrected" };
      }
      const document = (await client.query(`select d.*,d.document_date::text cash_date from erp_financials.subledger_documents d
join erp_financials.company_sources s using(tenant_id,company_id,source_id)
where d.tenant_id=$1 and d.company_id=$2 and d.source_id=$3 and d.subledger_document_id=$4 for update of d`, [...scope, command.documentId])).rows[0];
      if (!document || document.currency_code !== context.currencyCode || !["customer_payment", "bill_payment"].includes(document.document_type as string)) throw new ErpFinancialsError("scope_mismatch", "Cash purpose requires a receipt or bill payment in the selected currency and scope");
      const native = (await client.query(`select 1 from erp_financials.financial_outbox
where tenant_id=$1 and company_id=$2 and source_id=$3 and book_id=$4 and event_type='ledger.posted' and aggregate_id=$5 and idempotency_key=$6`,
      [...scope, context.bookId, document.transaction_id, `ledger-posted:Subledger:${String(document.document_type)}:${String(document.idempotency_key)}`])).rows;
      if (native.length !== 1) throw new ErpFinancialsError("unsupported_operation", "Cash purpose correction requires native posting evidence in this book");
      const previous = (await client.query(`select revision from erp_financials.cash_flow_purpose_corrections
where tenant_id=$1 and company_id=$2 and source_id=$3 and document_id=$4 order by revision desc limit 1`, [...scope, command.documentId])).rows[0];
      if ((previous?.revision ?? 0) !== command.expectedRevision) throw new ErpFinancialsError("optimistic_concurrency_conflict", "Cash purpose changed after review", { retryable: true });
      const amounts = [command.operating, command.investing, command.financing];
      if (amounts.reduce((sum, value) => sum + minor(value), 0n) !== minor(money(document.original_amount as string))) invalid("Cash purpose amounts must equal original cash amount");
      if (document.document_type === "customer_payment" && amounts.filter(value => value !== "0.00").length !== 1) invalid("A receipt requires one purpose so partial returns inherit it exactly");
      // The database guard also checks every related return/reversal date while
      // this fiscal lock and the source lock exclude close and new cash returns.
      await assertPostingDateAllowed(client, context, document.cash_date as string);
      const locked = (await client.query(`select min(cash_date)::text locked_date
from erp_financials.cash_flow_purpose_affected_dates($1,$2,$3,$4) dates
where not exists(select 1 from erp_financials.fiscal_periods where tenant_id=$1 and company_id=$2 and source_id=$3 and dates.cash_date between period_start and period_end and status='open')
or exists(select 1 from erp_financials.accounting_book_controls where tenant_id=$1 and company_id=$2 and source_id=$3 and dates.cash_date<=posting_lock_date)`, [...scope, command.documentId])).rows[0]?.locked_date;
      if (typeof locked === "string") await assertPostingDateAllowed(client, context, locked);
      const result = { documentId: command.documentId, revision: command.expectedRevision + 1,
        operating: command.operating, investing: command.investing, financing: command.financing };
      const event = await appendFinancialLifecycleEvent(client, { ...context, operation, aggregateType: "cash_flow_purpose", aggregateId: command.documentId,
        eventType: "cash_flow_purpose.corrected", idempotencyKey: key, recordedAt: context.now(), payload: { commandChecksum: checksum, result } });
      await client.query(`insert into erp_financials.cash_flow_purpose_corrections
(tenant_id,company_id,source_id,document_id,revision,book_id,operating,investing,financing,lifecycle_event_id)
values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [...scope, command.documentId, result.revision, context.bookId, result.operating, result.investing, result.financing, event.eventId]);
      await appendFinancialOutboxEvent(client, { ...context, eventType: "cash_flow_purpose.corrected", aggregateType: "cash_flow_purpose", aggregateId: command.documentId,
        idempotencyKey: key, payload: { lifecycleEventId: event.eventId, revision: result.revision }, availableAt: context.now() });
      await client.query("release savepoint erp_cash_flow_purpose");
      return { ...result, lifecycleEventId: event.eventId, status: "corrected" };
    } catch (error) {
      await client.query("rollback to savepoint erp_cash_flow_purpose");
      await client.query("release savepoint erp_cash_flow_purpose");
      throw error;
    }
  });
}

/** Null means original immutable posting/clearing evidence still owns purpose. */
export async function readCashFlowPurpose(scope: { database: ErpFinancialsTransactionRunner; tenantId: string; companyId: string; bookId: string }, input: { sourceId: string; documentId: string }): Promise<CashFlowPurposeCorrection | null> {
  const sourceId = nonempty(input.sourceId), documentId = nonempty(input.documentId);
  return scope.database.transaction(async client => {
    const row = (await client.query(`select c.document_id,c.revision,c.operating::text,c.investing::text,c.financing::text,c.lifecycle_event_id
from erp_financials.cash_flow_purpose_corrections c join erp_financials.reporting_book_sources s
on s.tenant_id=c.tenant_id and s.company_id=c.company_id and s.source_id=c.source_id and s.book_id=$3
where c.tenant_id=$1 and c.company_id=$2 and c.source_id=$4 and c.document_id=$5 order by c.revision desc limit 1`,
    [scope.tenantId, scope.companyId, scope.bookId, sourceId, documentId])).rows[0];
    return row ? { documentId: row.document_id as string, revision: row.revision as number, operating: money(row.operating as string), investing: money(row.investing as string), financing: money(row.financing as string), lifecycleEventId: row.lifecycle_event_id as string } : null;
  });
}
function nonempty(value: string): string { if (typeof value !== "string" || !value.trim() || value.length > 512) invalid("Invalid cash purpose identity"); return value; }
function money(value: string): string {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,17})(\.\d{1,2})?$/.test(value)) invalid("Cash purpose amounts must be nonnegative exact money");
  const [whole = "0", fraction = ""] = value.split("."); return `${whole}.${fraction.padEnd(2, "0")}`;
}
function minor(value: string): bigint { return BigInt(value.replace(".", "")); }
function invalid(message: string): never { throw new ErpFinancialsError("invalid_input", message); }
