import { appendFinancialOutboxEvent } from "./financial-outbox.js";
import { createHash } from "node:crypto";
import { appendFinancialLifecycleEvent, type FinancialOperationContext } from "./financial-lifecycle.js";
import { lockCustomerPaymentCorrectionSource } from "./customer-payment-correction.js";
import { assertPostingDateAllowed } from "./fiscal-periods.js";
import type { PostgresQueryClient } from "./postgres-storage.js";
import type { ErpFinancialsTransactionRunner } from "./erp-financials-service.js";
import type { JsonValue } from "./canonical-model.js";

export const SETTLEMENT_ONLY_MEMO = "Settlement-only correction under owner/bookkeeper attestation: erroneous card receipt never processed. Owner accepts imperfect historical cash books for this amount. All accrual/cash postings and the existing offset journal are intentionally unchanged. Provider deletion/convergence remains unverified.";
export type SettlementAttestation = {
  approvedBy: string; authorizationRefs: readonly string[]; evidenceSha256: string;
  erroneousReceiptNeverProcessed: boolean; acceptUnchangedCashHistory: boolean; providerDeletionVerified: boolean;
};
export type SettlementDocument = { id: string; partyId: string; currency: string; version: number; original: string; open: string; status: string };
export type AttestedSettlementState = {
  stale: SettlementDocument; replacement: SettlementDocument; invoice: SettlementDocument;
  application: { id: string; version: number; sourceId: string; targetId: string; amount: string; active: boolean };
  staleActiveApplicationCount: number; amount: string;
};
export type AttestedSettlementRequest = {
  paymentId: string; replacementPaymentId: string; invoiceId: string; applicationId: string;
  offsetTransactionId: string; expectedReplacementOpenAfter?: string; amount: string; date: string; idempotencyKey: string;
  expectedVersions: { payment: number; replacement: number; invoice: number; application: number };
  attestation: SettlementAttestation; operation: FinancialOperationContext;
};
export class AttestedSettlementError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "AttestedSettlementError"; }
}
function fail(code: string, message: string): never { throw new AttestedSettlementError(code, message); }
function minor(value: string) {
  if (!/^\d+(?:\.\d{1,2}(?:0{1,2})?)?$/.test(value)) fail("invalid_amount", "Exact nonnegative cent amount required");
  const [a = "0", b = "00"] = value.split("."); return BigInt(a) * 100n + BigInt(b.slice(0, 2).padEnd(2, "0"));
}
const money = (n: bigint) => `${String(n / 100n)}.${String(n % 100n).padStart(2, "0")}`;
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as JsonValue;
export function planAttestedSettlement(state: AttestedSettlementState, request: AttestedSettlementRequest) {
  const a = request.attestation;
  if (!a.approvedBy.trim() || !a.authorizationRefs.length || a.authorizationRefs.some(r => !r.trim())
    || !/^[a-f0-9]{64}$/.test(a.evidenceSha256) || !a.erroneousReceiptNeverProcessed || !a.acceptUnchangedCashHistory
    || a.providerDeletionVerified) fail("approval_required", "Explicit settlement-only attestation required; provider verification must remain false");
  if (!request.idempotencyKey.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(request.date)
    || !Number.isFinite(Date.parse(request.date)) || new Date(request.date).toISOString().slice(0, 10) !== request.date) fail("invalid_command", "Stable key and valid effective date required");
  const docs = [state.stale, state.replacement, state.invoice];
  if (new Set(docs.map(d => d.id)).size !== 3 || new Set(docs.map(d => d.partyId)).size !== 1
    || new Set(docs.map(d => d.currency)).size !== 1) fail("ownership_mismatch", "Same customer and currency required");
  const actual = [state.stale.version, state.replacement.version, state.invoice.version, state.application.version];
  const expected = [request.expectedVersions.payment, request.expectedVersions.replacement, request.expectedVersions.invoice, request.expectedVersions.application];
  if (actual.some((v, i) => !Number.isInteger(v) || v < 1 || v !== expected[i])) fail("stale_version", "Reload all affected versions");
  const amount = minor(request.amount);
  if (!amount || minor(state.amount) !== amount || minor(state.stale.original) !== amount || minor(state.stale.open) !== 0n
    || state.stale.status !== "settled" || state.invoice.status !== "settled" || minor(state.invoice.open) !== 0n
    || minor(state.invoice.original) !== amount || state.staleActiveApplicationCount !== 1 || !state.application.active
    || state.application.id !== request.applicationId || state.application.sourceId !== state.stale.id
    || state.application.targetId !== state.invoice.id || minor(state.application.amount) !== amount
    || state.stale.id !== request.paymentId || state.replacement.id !== request.replacementPaymentId || state.invoice.id !== request.invoiceId) fail("settlement_mismatch", "Exactly one full active settlement of the specified invoice required");
  if (!["open", "partially_applied"].includes(state.replacement.status) || minor(state.replacement.open) < amount
    || minor(state.replacement.open) > minor(state.replacement.original)) fail("insufficient_credit", "Eligible replacement credit is insufficient");
  if (request.expectedReplacementOpenAfter !== undefined && minor(request.expectedReplacementOpenAfter) !== minor(state.replacement.open) - amount) fail("settlement_mismatch", "Replacement credit differs from the authorized final amount");
  return { amount: money(amount), replacementOpenAfter: money(minor(state.replacement.open) - amount), invoiceOpenAfter: "0.00",
    ledgerPolicy: "preserve_all_postings" as const, providerConvergence: "unverified" as const, memo: SETTLEMENT_ONLY_MEMO };
}
type Row = Record<string, unknown>;
export type AttestedSettlementContext = {
  tenantId: string; companyId: string; sourceId: string; nativeSourceId: string; bookId: string; currencyCode: string;
  database: ErpFinancialsTransactionRunner; now: () => string; businessDate?: () => string;
  /** Server-owned authorization and app restrictions, locked through commit. */
  authorize: (client: PostgresQueryClient, request: AttestedSettlementRequest) => Promise<{ partyId: string; evidence: JsonValue }>;
};
/** No journal posting callback exists: this command cannot post/reverse cash or accrual. */
export function createAttestedSettlementCorrection(context: AttestedSettlementContext) {
  const scope = [context.tenantId, context.companyId, context.sourceId];
  const eventType = "customer_payment.attested_settlement_corrected";
  async function lock(client: PostgresQueryClient) {
    for (const source of [...new Set([context.sourceId, context.nativeSourceId])].sort()) {
      await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`fiscal-period:${context.tenantId}:${context.companyId}:${source}`]);
      await lockCustomerPaymentCorrectionSource(client, context.tenantId, source);
    }
  }
  async function ledger(client: PostgresQueryClient) {
    return (await client.query(`select source_id,accounting_basis,account_id,count(*)::text as count,
      sum(debit_amount)::text as debit,sum(credit_amount)::text as credit,
      md5(string_agg(md5(row_to_json(p)::text),'' order by posting_id)) as digest
      from erp_financials.ledger_postings p where tenant_id=$1 group by source_id,accounting_basis,account_id
      order by source_id,accounting_basis,account_id`, [context.tenantId])).rows;
  }
  async function prepare(client: PostgresQueryClient, request: AttestedSettlementRequest) {
    const authorization = await context.authorize(client, request);
    if (context.businessDate && request.date !== context.businessDate()) fail("invalid_date", "Correction must take effect in the current business date");
    await assertPostingDateAllowed(client, { tenantId: context.tenantId, companyId: context.companyId, sourceId: context.nativeSourceId }, request.date);
    const rows = (await client.query(`select * from erp_financials.subledger_documents where tenant_id=$1 and company_id=$2 and source_id=$3
      and subledger_document_id=any($4::text[]) order by subledger_document_id for update`, [...scope, [request.paymentId, request.replacementPaymentId, request.invoiceId]])).rows;
    const doc = (id: string, type: string): SettlementDocument => {
      const row = rows.find(r => r.subledger_document_id === id);
      if (!row || row.document_type !== type || row.party_id !== authorization.partyId || row.currency_code !== context.currencyCode) return fail("ownership_mismatch", "Scoped document identity/type/currency changed");
      return { id, partyId: row.party_id, currency: row.currency_code, version: Number(row.version), original: String(row.original_amount), open: String(row.open_amount), status: String(row.status) };
    };
    const applications = (await client.query(`select * from erp_financials.subledger_applications where tenant_id=$1 and company_id=$2
      and ((coalesce(source_document_source_id,source_id)=$3 and source_document_id=any($4::text[])) or (coalesce(target_document_source_id,source_id)=$3 and target_document_id=$5))
      order by source_id,subledger_application_id for update`, [...scope, [request.paymentId, request.replacementPaymentId], request.invoiceId])).rows;
    const application = applications.find(r => r.subledger_application_id === request.applicationId && r.source_id === context.sourceId);
    if (!application || application.application_type !== "customer_payment_to_invoice" || (application.source_document_source_id ?? application.source_id) !== context.sourceId
      || (application.target_document_source_id ?? application.source_id) !== context.sourceId || application.ended_event_id !== null) fail("settlement_mismatch", "Original canonical application changed");
    const state: AttestedSettlementState = { stale: doc(request.paymentId, "customer_payment"), replacement: doc(request.replacementPaymentId, "customer_payment"), invoice: doc(request.invoiceId, "invoice"),
      application: { id: String(application.subledger_application_id), version: Number(application.version), sourceId: String(application.source_document_id), targetId: String(application.target_document_id), amount: String(application.applied_amount), active: application.status === "applied" },
      staleActiveApplicationCount: applications.filter(a => a.source_document_id === request.paymentId && a.status === "applied").length, amount: request.amount };
    const plan = planAttestedSettlement(state, request);
    for (const payment of [state.stale, state.replacement]) {
      const active = applications.filter(a => a.source_document_id === payment.id && a.status === "applied");
      if (active.some(a => a.application_type !== "customer_payment_to_invoice") || active.reduce((sum, a) => sum + minor(String(a.applied_amount)), minor(payment.open)) !== minor(payment.original)) fail("settlement_mismatch", "Payment application coverage is incomplete or includes refunds");
    }
    const offset = (await client.query(`select * from erp_financials.transactions where tenant_id=$1 and source_id=$2 and transaction_id=$3 for update`, [context.tenantId, context.nativeSourceId, request.offsetTransactionId])).rows;
    if (offset.length !== 1 || offset[0]?.status !== "posted" || offset[0].currency_code !== context.currencyCode) fail("journal_unavailable", "Offset journal must remain posted");
    const links = (await client.query(`select 1 from erp_financials.journal_entry_links where tenant_id=$1 and company_id=$2 and original_transaction_id=$3`, [context.tenantId, context.companyId, request.offsetTransactionId])).rows;
    const claims = (await client.query(`select 1 from erp_financials.financial_lifecycle_events where tenant_id=$1 and company_id=$2 and event_type=$3 and payload->>'offsetTransactionId'=$4`, [context.tenantId, context.companyId, eventType, request.offsetTransactionId])).rows;
    if (links.length || claims.length) fail("journal_unavailable", "Offset journal was corrected or already claimed");
    const transactions = rows.map(r => String(r.transaction_id));
    const reconciled = (await client.query(`select 1 from erp_financials.bank_reconciliation_matches where tenant_id=$1 and company_id=$2 and transaction_id=any($3::text[]) and status='matched'`, [context.tenantId, context.companyId, transactions])).rows;
    if (reconciled.length) fail("settlement_restricted", "Affected canonical transaction is reconciled");
    const beforeLedger = await ledger(client);
    return { state, plan, rows, application, applications, authorization, offset, beforeLedger,
      confirmation: hash({ request: { ...request, operation: { actorRef: request.operation.actorRef, reasonDetail: request.operation.reasonDetail } }, state, rows, application, applications, authorization, offset, beforeLedger }) };
  }
  return {
    preview(input: AttestedSettlementRequest) {
      const request = structuredClone(input);
      return context.database.transaction(async client => { await lock(client); const p = await prepare(client, request);
        return { ...p.plan, confirmation: p.confirmation, before: p.state, attestation: request.attestation, offsetTransactionId: request.offsetTransactionId, readOnly: true }; });
    },
    execute(input: AttestedSettlementRequest & { confirmation: string }) {
      const { confirmation, ...request } = structuredClone(input);
      const requestChecksum = hash({ ...request, operation: { actorRef: request.operation.actorRef, reasonDetail: request.operation.reasonDetail }, confirmation });
      return context.database.transaction(async client => {
        await lock(client); await context.authorize(client, request);
        const prior = (await client.query(`select event_id,payload from erp_financials.financial_lifecycle_events where tenant_id=$1 and company_id=$2 and source_id=$3
          and event_type=$4 and (aggregate_id=$5 or idempotency_key=$6)`, [...scope, eventType, request.paymentId, `attested-settlement:${request.idempotencyKey}:receipt`])).rows;
        if (prior.length) {
          const p = prior[0]?.payload as Row;
          if (prior.length !== 1 || p.requestChecksum !== requestChecksum) fail("idempotency_conflict", "Correction already bound to another command");
          return { receiptId: String(prior[0]?.event_id), replayed: true, ...p };
        }
        const prepared = await prepare(client, request);
        if (prepared.confirmation !== confirmation) fail("stale_preview", "Locked evidence differs from preview");
        const correctionId = `attested_settlement_${hash([...scope, request.idempotencyKey]).slice(0, 24)}`;
        const event = async (aggregateType: string, aggregateId: string, type: string, suffix: string, payload: unknown, priorEventId?: string) => appendFinancialLifecycleEvent(client, {
          tenantId: context.tenantId, companyId: context.companyId, sourceId: context.sourceId, aggregateType, aggregateId,
          eventType: type, idempotencyKey: `${correctionId}:${suffix}`, operation: request.operation,
          recordedAt: context.now(), ...(priorEventId ? { priorEventId } : {}), payload: json(payload) });
        const ended = await event("subledger_application", request.applicationId, "subledger_application.voided", "end", { correctionId, settlementOnly: true, effectiveDate: request.date, priorVersion: prepared.state.application.version }, typeof prepared.application.applied_event_id === "string" ? prepared.application.applied_event_id : undefined);
        await client.query(`update erp_financials.subledger_applications set status='voided',version=version+1,ended_event_id=$5,updated_at=$6
          where tenant_id=$1 and company_id=$2 and source_id=$3 and subledger_application_id=$4`, [...scope, request.applicationId, ended.eventId, context.now()]);
        const retired = await event("customer_payment", request.paymentId, "customer_payment.voided", "retire", { correctionId, settlementOnly: true, ledgerPolicy: "preserve_all_postings", effectiveDate: request.date });
        await client.query("select set_config('erp_financials.application_balance_update','on',true)");
        await client.query(`update erp_financials.subledger_documents set status='voided',open_amount=0,version=version+1,updated_at=$5 where tenant_id=$1 and company_id=$2 and source_id=$3 and subledger_document_id=$4`, [...scope, request.paymentId, context.now()]);
        await client.query("select set_config('erp_financials.application_balance_update','off',true)");
        const newId = `${correctionId}:application`;
        const applied = await event("subledger_application", newId, "subledger_application.applied", "apply", { correctionId, settlementOnly: true, ledgerPolicy: "preserve_all_postings", confirmation, attestation: request.attestation, endedApplicationId: request.applicationId, offsetTransactionId: request.offsetTransactionId, offsetSourceId: context.nativeSourceId, sourceDocumentId: request.replacementPaymentId, targetDocumentId: request.invoiceId, amount: request.amount, effectiveDate: request.date, sourceDocumentSourceId: context.sourceId, targetDocumentSourceId: context.sourceId, bookId: context.bookId });
        await client.query(`insert into erp_financials.subledger_applications
          (subledger_application_id,tenant_id,company_id,source_id,application_type,source_document_id,target_document_id,applied_amount,currency_code,application_date,status,version,idempotency_key,applied_event_id,created_at,updated_at,source_document_source_id,target_document_source_id)
          values($1,$2,$3,$4,'customer_payment_to_invoice',$5,$6,$7,$8,$9,'applied',1,$10,$11,$12,$12,$4,$4)`,
        [newId, ...scope, request.replacementPaymentId, request.invoiceId, request.amount, context.currencyCode, request.date, `${correctionId}:apply`, applied.eventId, context.now()]);
        const after = (await client.query(`select subledger_document_id,status,open_amount::text,version from erp_financials.subledger_documents where tenant_id=$1 and company_id=$2 and source_id=$3 and subledger_document_id=any($4::text[]) order by subledger_document_id`, [...scope, [request.paymentId, request.replacementPaymentId, request.invoiceId]])).rows;
        if (after.find(r => r.subledger_document_id === request.paymentId)?.status !== "voided"
          || minor(String(after.find(r => r.subledger_document_id === request.invoiceId)?.open_amount)) !== 0n
          || minor(String(after.find(r => r.subledger_document_id === request.replacementPaymentId)?.open_amount)) !== minor(prepared.plan.replacementOpenAfter)
          || hash(await ledger(client)) !== hash(prepared.beforeLedger)) fail("invariant_failed", "Settlement balances or unchanged ledger invariant failed; transaction rolled back");
        // Keep full frozen source evidence in bounded immutable lifecycle chunks.
        // Production documents can contain large provider metadata; never expand
        // the shared audit size guard or discard evidence to fit the receipt.
        const frozenEvidence = { documents: prepared.rows, originalApplication: prepared.application, applications: prepared.applications, authorization: prepared.authorization.evidence, offset: prepared.offset };
        const evidenceText = JSON.stringify(frozenEvidence), evidenceChecksum = hash(frozenEvidence);
        const chunks: string[] = []; let chunk = "", bytes = 0;
        for (const character of evidenceText) {
          const size = new TextEncoder().encode(character).byteLength;
          if (bytes + size > 2000) { chunks.push(chunk); chunk = ""; bytes = 0; }
          chunk += character; bytes += size;
        }
        if (chunk) chunks.push(chunk);
        const evidenceEventIds: string[] = [];
        for (const [index, data] of chunks.entries()) {
          const saved = await event("customer_payment", request.paymentId, "customer_payment.attested_settlement_evidence", `evidence:${String(index)}`, { correctionId, evidenceChecksum, index, count: chunks.length, encoding: "json-utf8", data });
          evidenceEventIds.push(saved.eventId);
        }
        const payload = { correctionId, requestChecksum, confirmation, offsetTransactionId: request.offsetTransactionId, before: prepared.state, after,
          plan: prepared.plan, attestation: request.attestation, affectedDocumentIds: [request.paymentId, request.replacementPaymentId, request.invoiceId],
          applicationId: newId, endedApplicationId: request.applicationId, lifecycleEventIds: [ended.eventId, retired.eventId, applied.eventId],
          frozenEvidence: { checksum: evidenceChecksum, eventIds: evidenceEventIds }, ledgerBeforeChecksum: hash(prepared.beforeLedger), ledgerAfterChecksum: hash(prepared.beforeLedger) };
        const receipt = await appendFinancialLifecycleEvent(client, { tenantId: context.tenantId, companyId: context.companyId, sourceId: context.sourceId,
          aggregateType: "customer_payment", aggregateId: request.paymentId, eventType, idempotencyKey: `attested-settlement:${request.idempotencyKey}:receipt`, operation: request.operation, recordedAt: context.now(), payload: json(payload) });
        await appendFinancialOutboxEvent(client, { tenantId: context.tenantId, companyId: context.companyId, sourceId: context.sourceId, bookId: context.bookId, eventType, aggregateType: "customer_payment", aggregateId: request.paymentId, idempotencyKey: correctionId, payload: { correctionId, receiptId: receipt.eventId, affectedDocumentIds: payload.affectedDocumentIds }, availableAt: context.now() });
        return { receiptId: receipt.eventId, replayed: false, ...payload };
      });
    },
  };
}
