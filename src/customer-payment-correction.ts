import { assertFinancialApproval, runFinancialAction, type FinancialApprovalPolicy, copyFinancialOperation } from "./financial-approval-policy.js";
import { createHash } from "node:crypto";
import { assertNoCredentialKeys } from "./canonical-model.js";
import { appendFinancialLifecycleEvent } from "./financial-lifecycle.js";
import { assertPostingDateAllowed } from "./fiscal-periods.js";
import { appendFinancialOutboxEvent } from "./financial-outbox.js";
import { ErpFinancialsError } from "./sdk-errors.js";
import type { DimensionRef } from "./canonical-model.js";
import type { FinancialOperationContext } from "./financial-lifecycle.js";
import type { PostgresQueryClient } from "./postgres-storage.js";
import type { ErpFinancialsTransactionRunner, PostJournalEntryInput, PostJournalEntryResult } from "./erp-financials-service.js";
/** Supplied only from complete normalized import evidence, never from a browser. */
export type ImportedCustomerPaymentEvidence = {
  readonly paymentId: string;
  readonly sourceVersion: string;
  readonly sourceTransactionId: string;
  readonly bookId: string | null;
  /** Includes the document header and ALL separate accrual/cash basis transactions. */
  readonly transactionIds: readonly string[];
  readonly provenanceRef: string;
};
export type CustomerPaymentCorrectionRequest = {
  readonly paymentId: string;
  readonly date: string;
  readonly idempotencyKey: string;
  readonly operation: FinancialOperationContext;
};
export type CustomerPaymentCorrectionGuard = (input: {
  readonly client: PostgresQueryClient;
  readonly phase: "preview" | "confirm";
  readonly confirmation?: string;
  readonly approvalRef?: string;
  readonly tenantId: string;
  readonly companyId: string;
  readonly sourceId: string;
  readonly bookId: string | null;
  readonly request: CustomerPaymentCorrectionRequest;
}) => Promise<{
  readonly authorized: boolean;
  /** Version of app-owned deposit/reconciliation/refund/permission evidence locked through commit. */
  readonly version: string;
  readonly complete: boolean;
  readonly deposited: boolean;
  readonly reconciled: boolean;
  readonly refunded: boolean;
}>;
export type CustomerPaymentCorrectionPreview = {
  readonly replayPolicy: "preserve_corrected_payment";
  readonly confirmation: string;
  readonly paymentId: string;
  readonly paymentVersion: number;
  readonly sourceVersion: string;
  readonly applications: readonly {
    readonly applicationId: string;
    readonly version: number;
    readonly invoiceId: string;
    readonly invoiceVersion: number;
    readonly amount: string;
    readonly status: string;
  }[];
  readonly postingIds: readonly string[];
  readonly reversals: readonly {
    readonly basis: string;
    readonly accountId: string;
    readonly debit: string;
    readonly credit: string;
  }[];
};
export type VoidAndUnapplyCustomerPaymentInput = CustomerPaymentCorrectionRequest & {
  readonly confirmation: string;
  /** Server-issued record bound by the app guard to request + confirmation.
   * Under administrator_direct this is the real admin confirmation, not a second approval. */
  readonly approvalRef: string;
};
export type VoidAndUnapplyCustomerPaymentResult = {
  readonly replayPolicy: "preserve_corrected_payment";
  readonly status: "voided" | "already_voided";
  readonly correctionId: string;
  readonly paymentId: string;
  readonly sourceVersion: string;
  readonly endedApplicationIds: readonly string[];
  readonly reopenedInvoiceIds: readonly string[];
  readonly reversalTransactionIds: readonly string[];
  readonly basisReversals: readonly {
    readonly basis: "accrual" | "cash";
    readonly originalTransactionIds: readonly string[];
    readonly reversalTransactionId: string;
  }[];
  readonly lifecycleEventId: string;
};
type Scope = {
  readonly tenantId: string;
  readonly companyId: string;
  readonly sourceId: string;
  readonly bookId?: string;
  readonly currencyCode: string;
};
type Context = Scope & {
  readonly financialApprovalPolicy?: FinancialApprovalPolicy;
  readonly database: ErpFinancialsTransactionRunner;
  readonly now: () => string;
  readonly customerPaymentCorrectionGuard?: CustomerPaymentCorrectionGuard;
};
type Row = Record<string, unknown>;
function fail(message: string): never { throw new ErpFinancialsError("invalid_input", message); }
const hash = (value: unknown): string => createHash("sha256").update(stable(value)).digest("hex");
function stable(value: unknown): string {
  if (value === undefined)
    return "null";
  if (value === null || typeof value !== "object")
    return JSON.stringify(value);
  if (value instanceof Date)
    return JSON.stringify(value.toISOString());
  if (Array.isArray(value))
    return `[${value.map(stable).join(",")}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
}
function nonempty(value: unknown): asserts value is string { if (typeof value !== "string" || !value.trim())
  fail("Missing correction evidence or command field"); }
function minor(value: unknown): bigint {
  const s = String(value);
  if (!/^-?\d+(\.\d{1,2})?$/.test(s))
    return fail("Correction requires exact currency minor units");
  const [whole, fraction = ""] = s.replace(/^-/, "").split(".");
  return BigInt((whole ?? "0") + fraction.padEnd(2, "0")) * (s.startsWith("-") ? -1n : 1n);
}
function money(value: unknown): string { const n = minor(value); return `${n < 0 ? "-" : ""}${((n < 0 ? -n : n) / 100n).toString()}.${((n < 0 ? -n : n) % 100n).toString().padStart(2, "0")}`; }
export async function lockCustomerPaymentCorrectionSource(client: PostgresQueryClient, tenantId: string, sourceId: string): Promise<void> {
  await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`payment-correction:${tenantId}:${sourceId}`]);
}
/** Record-scoped guard for custom import paths. Prefer prepareCustomerPaymentCorrectionImport for batches. */
export async function assertCustomerPaymentCorrectionImportAllowed(client: PostgresQueryClient, tenantId: string, sourceId: string, paymentId?: string): Promise<void> {
  await lockCustomerPaymentCorrectionSource(client, tenantId, sourceId);
  if (paymentId === undefined) return;
  const result = await client.query("select correction_id from erp_financials.customer_payment_corrections where tenant_id=$1 and source_id=$2 and payment_id=$3", [tenantId, sourceId, paymentId]);
  if (result.rows.length)
    throw new ErpFinancialsError("provider_dependency", "Corrected Payment requires provider reconciliation", {details: {paymentId, sourceId}});
}
async function assertCorrectionTransaction(client: PostgresQueryClient): Promise<void> {
  const first = await client.query("select txid_current()::text as transaction_id");
  const second = await client.query("select txid_current()::text as transaction_id");
  if (!first.rows[0]?.transaction_id || first.rows[0].transaction_id !== second.rows[0]?.transaction_id)
    fail("Payment correction requires one explicit transaction client");
}
async function loadPaymentAccountingEvidence(client: PostgresQueryClient, tenantId: string, sourceId: string, transactionIds: readonly string[]) {
  const transactions = (await client.query(`select * from erp_financials.transactions where tenant_id=$1 and source_id=$2 and transaction_id=any($3::text[]) order by transaction_id for update`, [tenantId, sourceId, transactionIds])).rows;
  const postings = (await client.query(`select * from erp_financials.ledger_postings where tenant_id=$1 and source_id=$2 and transaction_id=any($3::text[]) order by posting_id for update`, [tenantId, sourceId, transactionIds])).rows;
  return { transactions, postings };
}
export async function persistImportedCustomerPaymentEvidence(client: PostgresQueryClient, scope: Omit<Scope, "currencyCode" | "bookId">, evidence: ImportedCustomerPaymentEvidence): Promise<void> {
  await assertCorrectionTransaction(client);
  await assertCustomerPaymentCorrectionImportAllowed(client, scope.tenantId, scope.sourceId, evidence.paymentId);
  for (const v of [evidence.paymentId, evidence.sourceVersion, evidence.sourceTransactionId, evidence.provenanceRef])
    nonempty(v);
  if (!Array.isArray(evidence.transactionIds) || !evidence.transactionIds.length || new Set(evidence.transactionIds).size !== evidence.transactionIds.length)
    fail("Complete unique transaction provenance is required");
  assertNoCredentialKeys(evidence);
  if (!Number.isFinite(Date.parse(evidence.sourceVersion)))
    fail("sourceVersion must be the normalized sourceUpdatedAt timestamp");
  const previous = (await client.query("select source_version from erp_financials.imported_customer_payment_evidence where tenant_id=$1 and company_id=$2 and source_id=$3 and payment_id=$4 for update", [scope.tenantId, scope.companyId, scope.sourceId, evidence.paymentId])).rows[0];
  if (previous && Date.parse(String(previous.source_version)) > Date.parse(evidence.sourceVersion))
    fail("Delayed payment evidence cannot replace a newer source version");
  const accounting = await loadPaymentAccountingEvidence(client, scope.tenantId, scope.sourceId, evidence.transactionIds);
  if (accounting.transactions.length !== evidence.transactionIds.length || accounting.postings.length < 4)
    fail("Incomplete imported payment accounting evidence");
  const storedEvidence = { ...evidence, accountingChecksum: hash(accounting) };
  await client.query(`insert into erp_financials.imported_customer_payment_evidence
  (evidence_id,tenant_id,company_id,source_id,payment_id,source_version,evidence) values($1,$2,$3,$4,$5,$6,$7::jsonb)
  on conflict(tenant_id,company_id,source_id,payment_id) do update set source_version=excluded.source_version,evidence=excluded.evidence`, [`payment_evidence_${hash([scope, evidence.paymentId]).slice(0, 24)}`, scope.tenantId, scope.companyId, scope.sourceId, evidence.paymentId, evidence.sourceVersion, JSON.stringify(storedEvidence)]);
}
export function createCustomerPaymentCorrectionService(context: Context, post: (client: PostgresQueryClient, input: PostJournalEntryInput) => Promise<PostJournalEntryResult>) {
  return {
    previewVoidAndUnapply: (input: CustomerPaymentCorrectionRequest) => runFinancialAction(context, "customerPayments.voidAndUnapply", input,
      (context, command) => correctionService(context, post).previewVoidAndUnapply(command), "preview"),
    voidAndUnapply: (input: VoidAndUnapplyCustomerPaymentInput) => runFinancialAction(context, "customerPayments.voidAndUnapply", input,
      (context, command) => correctionService(context, post).voidAndUnapply(command))
  };
}
function correctionService(context: Context, post: (client: PostgresQueryClient, input: PostJournalEntryInput) => Promise<PostJournalEntryResult>) {
  const scope = [context.tenantId, context.companyId, context.sourceId];
  async function guard(client: PostgresQueryClient, request: CustomerPaymentCorrectionRequest, phase: "preview" | "confirm", approval?: {
    confirmation: string;
    approvalRef: string;
  }) {
    if (!context.customerPaymentCorrectionGuard)
      throw new ErpFinancialsError("authorization_context_invalid", "App-owned transactional correction guard is required");
    const evidence: Record<string, unknown> = await context.customerPaymentCorrectionGuard({ client, phase, tenantId: context.tenantId, companyId: context.companyId, sourceId: context.sourceId, bookId: context.bookId ?? null, request: structuredClone(request), ...approval });
    if (evidence.authorized !== true)
      throw new ErpFinancialsError("authorization_context_invalid", "Customer payment correction permission denied");
    nonempty(evidence.version);
    if (evidence.complete !== true || evidence.deposited !== false || evidence.reconciled !== false || evidence.refunded !== false)
      fail("Incomplete evidence or deposit/reconciliation/refund blocks correction");
    return evidence;
  }
  async function prepare(client: PostgresQueryClient, request: CustomerPaymentCorrectionRequest, phase: "preview" | "confirm", approval?: {
    confirmation: string;
    approvalRef: string;
  }) {
    await assertCorrectionTransaction(client);
    await lockCustomerPaymentCorrectionSource(client, context.tenantId, context.sourceId);
    await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`fiscal-period:${context.tenantId}:${context.companyId}:${context.sourceId}`]);
    const bindings = await client.query(`select * from erp_financials.company_sources where tenant_id=$1 and source_id=$2 for share`, [context.tenantId, context.sourceId]);
    if (bindings.rows.length !== 1 || bindings.rows[0]?.company_id !== context.companyId)
      fail("Correction source must belong exclusively to this company");
    const sources = await client.query("select source_system from erp_financials.accounting_sources where tenant_id=$1 and source_id=$2 for share", [context.tenantId, context.sourceId]);
    if (sources.rows[0]?.source_system !== "quickbooks")
      fail("Correction requires a QuickBooks import source");
    const books = (await client.query("select book_id from erp_financials.reporting_book_sources where tenant_id=$1 and company_id=$2 and source_id=$3 for share", scope)).rows;
    if (context.bookId ? !books.some(b => b.book_id === context.bookId) : books.length > 0)
      fail("Missing or mismatched reporting book provenance");
    const appEvidence = await guard(client, request, phase, approval);
    const payment = (await client.query(`select * from erp_financials.subledger_documents where tenant_id=$1 and company_id=$2 and source_id=$3 and subledger_document_id=$4 for update`, [...scope, request.paymentId])).rows[0];
    if (!payment || payment.document_type !== "customer_payment" || payment.status === "voided" || payment.currency_code !== context.currencyCode)
      fail("Payment is missing, terminal or outside correction scope");
    const metadata = payment.metadata as Row | undefined;
    if (metadata?.provider !== "quickbooks" || metadata.sourceTransactionType !== "Payment" || metadata.customerPaymentProvenance)
      fail("Imported payment provenance is missing or has external associations");
    const row = (await client.query(`select * from erp_financials.imported_customer_payment_evidence where tenant_id=$1 and company_id=$2 and source_id=$3 and payment_id=$4 for update`, [...scope, request.paymentId])).rows[0];
    if (!row)
      fail("Complete durable import/basis evidence is required");
    const evidence = row.evidence as ImportedCustomerPaymentEvidence & {
      accountingChecksum: string;
    };
    if (evidence.sourceVersion !== row.source_version || evidence.sourceVersion !== metadata.sourceUpdatedAt || evidence.sourceTransactionId !== metadata.sourceTransactionId || evidence.bookId !== (context.bookId ?? null) || !evidence.transactionIds.includes(String(payment.transaction_id)))
      fail("Stale source version, book or payment provenance");
    const transactions = (await client.query(`select * from erp_financials.transactions where tenant_id=$1 and source_id=$2 and transaction_id=any($3::text[]) order by transaction_id for update`, [context.tenantId, context.sourceId, evidence.transactionIds])).rows;
    if (transactions.length !== evidence.transactionIds.length)
      fail("Missing basis transaction");
    for (const t of transactions) {
      const ref = t.source_payload_ref as Row | undefined;
      if (t.status !== "posted" || t.currency_code !== context.currencyCode || (t.party_id !== null && t.party_id !== payment.party_id) ||
        !(t.source_transaction_type === "Payment" && t.source_transaction_id === evidence.sourceTransactionId || ref?.sourceObjectType === "Payment" && ref.sourceObjectId === evidence.sourceTransactionId))
        fail("Basis transaction lacks exact Payment provenance");
    }
    // Discover all transactions carrying this provider identity: omitted basis evidence is never accepted.
    const discovered = (await client.query(`select transaction_id from erp_financials.transactions where tenant_id=$1 and source_id=$2 and
   ((source_transaction_type='Payment' and source_transaction_id=$3) or (source_payload_ref->>'sourceObjectType'='Payment' and source_payload_ref->>'sourceObjectId'=$3)) order by transaction_id`, [context.tenantId, context.sourceId, evidence.sourceTransactionId])).rows.map(r => String(r.transaction_id));
    if (stable(discovered) !== stable([...evidence.transactionIds].sort()))
      fail("Omitted payment basis transaction");
    const postings = (await client.query(`select * from erp_financials.ledger_postings where tenant_id=$1 and source_id=$2 and transaction_id=any($3::text[]) order by posting_id for update`, [context.tenantId, context.sourceId, evidence.transactionIds])).rows;
    // Older basis imports did not populate transaction.party_id. Exact object
    // identity plus unanimous posting parties is sufficient; missing/conflicting
    // posting identity is not permission to infer a party.
    for (const transaction of transactions.filter(t => t.party_id === null)) {
      const entries = postings.filter(p => p.transaction_id === transaction.transaction_id);
      if (!entries.length || entries.some(p => p.party_id !== payment.party_id))
        fail("Basis transaction lacks complete Payment party provenance");
    }
    if (evidence.accountingChecksum !== hash({ transactions, postings }))
      fail("Imported payment accounting changed without complete refreshed evidence");
    for (const basis of ["accrual", "cash"]) {
      const entries = postings.filter(p => p.accounting_basis === basis);
      if (entries.length < 2 || entries.reduce((sum, p) => sum + minor(p.debit_amount) - minor(p.credit_amount), 0n) !== 0n)
        fail(`Incomplete or unbalanced ${basis} payment evidence`);
      if (entries.reduce((sum, p) => sum + minor(p.debit_amount), 0n) !== minor(payment.original_amount))
        fail(`Unsupported ${basis} payment amount; complete allocation evidence required`);
    }
    if (postings.some(p => !["accrual", "cash"].includes(String(p.accounting_basis)) || p.currency_code !== context.currencyCode || (minor(p.debit_amount) > 0n) === (minor(p.credit_amount) > 0n) || minor(p.debit_amount) < 0n || minor(p.credit_amount) < 0n))
      fail("Invalid payment posting evidence");
    const links = await client.query(`select 1 from erp_financials.journal_entry_links where tenant_id=$1 and source_id=$2 and original_transaction_id=any($3::text[]) and link_type in ('reversal','void')`, [context.tenantId, context.sourceId, evidence.transactionIds]);
    if (links.rows.length)
      fail("Payment accounting has already been reversed");
    const matches = await client.query(`select * from erp_financials.bank_reconciliation_matches where tenant_id=$1 and source_id=$2 and transaction_id=any($3::text[]) and status='matched' for update`, [context.tenantId, context.sourceId, evidence.transactionIds]);
    if (matches.rows.length)
      fail("Reconciled payment cannot be corrected");
    const applications = (await client.query(`select * from erp_financials.subledger_applications where tenant_id=$1 and company_id=$2 and source_id=$3 and (source_document_id=$4 or target_document_id=$4) order by subledger_application_id for update`, [...scope, request.paymentId])).rows;
    const invoices: Row[] = [];
    for (const a of applications) {
      if (a.application_type !== "customer_payment_to_invoice" || a.source_document_id !== request.paymentId)
        fail("Unsupported payment application");
      const invoice = (await client.query(`select * from erp_financials.subledger_documents where tenant_id=$1 and company_id=$2 and source_id=$3 and subledger_document_id=$4 for update`, [...scope, a.target_document_id])).rows[0];
      if (!invoice || invoice.document_type !== "invoice" || invoice.status === "voided" || invoice.currency_code !== payment.currency_code || invoice.party_id !== payment.party_id)
        fail("Invalid linked invoice");
      invoices.push(invoice);
    }
    const invoiceApplications = (await client.query(`select * from erp_financials.subledger_applications where tenant_id=$1 and company_id=$2 and source_id=$3 and target_document_id=any($4::text[]) order by subledger_application_id for update`, [...scope, invoices.map(i => i.subledger_document_id)])).rows;
    for (const invoice of invoices) {
      const applied = invoiceApplications.filter(a => a.target_document_id === invoice.subledger_document_id && a.status === "applied").reduce((sum, a) => sum + minor(a.applied_amount), 0n);
      if (minor(invoice.open_amount) + applied !== minor(invoice.original_amount))
        fail("Incomplete invoice application evidence");
    }
    if (minor(payment.open_amount) + applications.filter(a => a.status === "applied").reduce((sum, a) => sum + minor(a.applied_amount), 0n) !== minor(payment.original_amount))
      fail("Omitted application or inconsistent payment balance");
    // Imported applications are represented in the provider cash journal. Refuse
    // mixed native cash projections instead of reversing cash recognition twice.
    const nativeProjection = await client.query(`select 1 from erp_financials.ledger_postings where tenant_id=$1 and source_id=$2 and source_posting_id like 'cash-application:%' and transaction_id=any($3::text[])`, [context.tenantId, context.sourceId, invoices.map(i => i.transaction_id)]);
    if (nativeProjection.rows.length)
      fail("Mixed native/imported cash evidence requires reconciliation");
    const dates = new Set([request.date, String(payment.document_date instanceof Date ? payment.document_date.toISOString().slice(0, 10) : payment.document_date), ...postings.map(p => p.posting_date instanceof Date ? p.posting_date.toISOString().slice(0, 10) : String(p.posting_date)), ...applications.filter(a => a.status === 'applied').map(a => a.application_date instanceof Date ? a.application_date.toISOString().slice(0, 10) : String(a.application_date))]);
    for (const invoice of invoices)
      dates.add(invoice.document_date instanceof Date ? invoice.document_date.toISOString().slice(0, 10) : String(invoice.document_date));
    if ([...dates].some(date => date > request.date))
      fail("Effective date precedes payment or application accounting");
    for (const date of dates)
      await assertPostingDateAllowed(client, context, date);
    const snapshot = { scope, bookId: context.bookId ?? null, request, payment, evidence, transactions, postings, applications, invoices, invoiceApplications, appEvidence };
    const preview: CustomerPaymentCorrectionPreview = { replayPolicy: "preserve_corrected_payment", confirmation: hash(snapshot), paymentId: request.paymentId, paymentVersion: Number(payment.version), sourceVersion: evidence.sourceVersion,
      applications: applications.map((a, i) => ({ applicationId: String(a.subledger_application_id), version: Number(a.version), invoiceId: String(a.target_document_id), invoiceVersion: Number(invoices[i]?.version), amount: money(a.applied_amount), status: String(a.status) })),
      postingIds: postings.map(p => String(p.posting_id)), reversals: postings.map(p => ({ basis: String(p.accounting_basis), accountId: String(p.account_id), debit: money(p.credit_amount), credit: money(p.debit_amount) })) };
    return { preview, payment, evidence, postings, applications };
  }
  function requestCopy(input: CustomerPaymentCorrectionRequest): CustomerPaymentCorrectionRequest {
    const request = structuredClone({ paymentId: input.paymentId, date: input.date, idempotencyKey: input.idempotencyKey, operation: input.operation });
    request.operation = copyFinancialOperation(input.operation);
    assertFinancialApproval(context, request.operation);
    [request.paymentId, request.idempotencyKey, request.operation.reasonDetail].forEach(nonempty);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(request.date) || !Number.isFinite(Date.parse(request.date)) || new Date(request.date).toISOString().slice(0, 10) !== request.date)
      fail("Invalid correction effective date");
    return request;
  }
  return {
    previewVoidAndUnapply(input: CustomerPaymentCorrectionRequest): Promise<CustomerPaymentCorrectionPreview> {
      const request = requestCopy(input);
      return context.database.transaction(async (client) => (await prepare(client, request, "preview")).preview);
    },
    voidAndUnapply(input: VoidAndUnapplyCustomerPaymentInput): Promise<VoidAndUnapplyCustomerPaymentResult> {
      const request = requestCopy(input);
      const confirmation = input.confirmation;
      const approvalRef = input.approvalRef;
      nonempty(confirmation);
      nonempty(approvalRef);
      const commandChecksum = hash({ scope, bookId: context.bookId ?? null, request, confirmation, approvalRef });
      return context.database.transaction(async (client) => {
        await assertCorrectionTransaction(client);
        await lockCustomerPaymentCorrectionSource(client, context.tenantId, context.sourceId);
        const replay = (await client.query(`select * from erp_financials.customer_payment_corrections where tenant_id=$1 and company_id=$2 and source_id=$3 and (payment_id=$4 or idempotency_key=$5)`, [...scope, request.paymentId, request.idempotencyKey])).rows;
        if (replay.length) {
          await guard(client, request, "confirm", { confirmation, approvalRef });
          if (replay.length !== 1 || replay[0]?.command_checksum !== commandChecksum)
            throw new ErpFinancialsError("idempotency_conflict", "Correction identity is already bound to another command");
          return { ...replay[0].result as VoidAndUnapplyCustomerPaymentResult, status: "already_voided", replayPolicy: "preserve_corrected_payment" };
        }
        const state = await prepare(client, request, "confirm", { confirmation, approvalRef });
        if (state.preview.confirmation !== confirmation)
          throw new ErpFinancialsError("optimistic_concurrency_conflict", "Correction preview is stale or confirmation does not match");
        const correctionId = `payment_correction_${hash({ scope, key: request.idempotencyKey }).slice(0, 24)}`;
        const event = await appendFinancialLifecycleEvent(client, { tenantId: context.tenantId, companyId: context.companyId, sourceId: context.sourceId, aggregateType: "customer_payment", aggregateId: request.paymentId, eventType: "customer_payment.voided", idempotencyKey: `${correctionId}:void`, operation: request.operation, recordedAt: context.now(), priorEventId: String(state.payment.lifecycle_event_id), payload: { confirmation, approvalRef, sourceVersion: state.evidence.sourceVersion, correctionId, effectiveDate: request.date } });
        const reversalTransactionIds: string[] = [];
        const basisReversals: {
          basis: "accrual" | "cash";
          originalTransactionIds: string[];
          reversalTransactionId: string;
        }[] = [];
        const linkedTransactions = new Set<string>();
        for (const basis of ["accrual", "cash"] as const) {
          const entries = state.postings.filter(p => p.accounting_basis === basis);
          const result = await post(client, { operation: request.operation, idempotencyKey: `${correctionId}:${basis}`, date: request.date, accountingBasis: basis, accountingPolicy: "configured_basis_only", currencyCode: context.currencyCode, adjustment: true, lines: entries.map(p => ({ accountId: String(p.account_id), ...(typeof p.party_id === "string" ? { partyId: p.party_id } : {}), ...(typeof p.item_id === "string" ? { itemId: p.item_id } : {}), dimensionRefs: p.dimension_refs as DimensionRef[], ...(minor(p.credit_amount) > 0n ? { debit: money(p.credit_amount) } : { credit: money(p.debit_amount) }) })) });
          reversalTransactionIds.push(result.transactionId);
          const originalTransactionIds = [...new Set(entries.map(p => String(p.transaction_id)))];
          basisReversals.push({ basis, originalTransactionIds, reversalTransactionId: result.transactionId });
          for (const original of originalTransactionIds) {
            if (linkedTransactions.has(original))
              continue;
            linkedTransactions.add(original);
            await client.query(`insert into erp_financials.journal_entry_links(journal_entry_link_id,tenant_id,company_id,source_id,original_transaction_id,related_transaction_id,link_type,lifecycle_event_id,created_at) values($1,$2,$3,$4,$5,$6,'void',$7,$8)`, [`${correctionId}_${hash([original, basis]).slice(0, 16)}`, ...scope, original, result.transactionId, event.eventId, context.now()]);
          }
        }
        const endedApplicationIds: string[] = [];
        const reopenedInvoiceIds = [...new Set(state.applications.filter(a => a.status === "applied").map(a => String(a.target_document_id)))];
        for (const a of state.applications.filter(a => a.status === "applied")) {
          const applicationId = String(a.subledger_application_id);
          const ended = await appendFinancialLifecycleEvent(client, {
            tenantId: context.tenantId, companyId: context.companyId, sourceId: context.sourceId,
            aggregateType: "subledger_application", aggregateId: applicationId,
            eventType: "subledger_application.voided", idempotencyKey: `${correctionId}:${applicationId}`,
            operation: request.operation, recordedAt: context.now(), priorEventId: String(a.applied_event_id),
            payload: {correctionId, effectiveDate: request.date, priorVersion: Number(a.version), status: "voided"}
          });
          await client.query(`update erp_financials.subledger_applications set status='voided',version=version+1,ended_event_id=$5,updated_at=$6 where tenant_id=$1 and company_id=$2 and source_id=$3 and subledger_application_id=$4`, [...scope, a.subledger_application_id, ended.eventId, context.now()]);
          endedApplicationIds.push(String(a.subledger_application_id));
        }
        await client.query("select set_config('erp_financials.application_balance_update','on',true)");
        await client.query(`update erp_financials.subledger_documents set status='voided',open_amount=0,version=version+1,updated_at=$5 where tenant_id=$1 and company_id=$2 and source_id=$3 and subledger_document_id=$4`, [...scope, request.paymentId, context.now()]);
        await client.query("select set_config('erp_financials.application_balance_update','off',true)");
        const result: VoidAndUnapplyCustomerPaymentResult = { replayPolicy: "preserve_corrected_payment", status: "voided", correctionId, paymentId: request.paymentId, sourceVersion: state.evidence.sourceVersion, endedApplicationIds, reopenedInvoiceIds, reversalTransactionIds, basisReversals, lifecycleEventId: event.eventId };
        await client.query(`insert into erp_financials.customer_payment_corrections(correction_id,tenant_id,company_id,source_id,payment_id,source_version,idempotency_key,command_checksum,result,lifecycle_event_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`, [correctionId, ...scope, request.paymentId, state.evidence.sourceVersion, request.idempotencyKey, commandChecksum, JSON.stringify(result), event.eventId]);
        await appendFinancialOutboxEvent(client, { tenantId: context.tenantId, companyId: context.companyId, sourceId: context.sourceId, ...(context.bookId ? { bookId: context.bookId } : {}), eventType: "subledger_document.customer_payment.voided", aggregateType: "customer_payment", aggregateId: request.paymentId, idempotencyKey: correctionId, payload: result, availableAt: context.now() });
        return result;
      });
    }
  };
}
