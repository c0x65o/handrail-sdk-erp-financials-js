import { normalizeInvoiceComponents, invoiceComponentRequirements, assertInvoiceComponentPolicy, type InvoicePostingComponents } from "./invoice-components.js";
import { normalizeInvoiceAccountPolicy as normalizeInvoiceReplacementPolicy, type InvoiceAccountPolicy } from "./invoice-account-policy.js";
import { lockCustomerPaymentCorrectionSource } from "./customer-payment-correction.js";
import { assertFinancialApproval, copyFinancialOperation, runFinancialAction, type FinancialApprovalPolicy } from "./financial-approval-policy.js";
import { createHash } from "node:crypto";

import { assertNoCredentialKeys } from "./canonical-model.js";
import { normalizeCommercialDocumentLine } from "./commercial-lines.js";
import {
  createErpFinancials,
  ErpFinancialsIdempotencyConflictError
} from "./erp-financials-service.js";
import { appendFinancialOutboxEvent } from "./financial-outbox.js";
import {
  appendFinancialLifecycleEvent,
  assertFinancialOperationContext,
} from "./financial-lifecycle.js";
import { ErpFinancialsError } from "./sdk-errors.js";

import type { AccountClassification, AccountingBasis, DecimalString, IsoCurrencyCode, IsoDate, IsoDateTime, JsonValue } from "./canonical-model.js";
import type {
  ErpFinancialsAccountReference,
  ErpFinancialsTransactionRunner,
  SubledgerAmountLine,
  SubledgerApplicationResult
} from "./erp-financials-service.js";
import type { FinancialOperationContext } from "./financial-lifecycle.js";
import type { PostgresQueryClient } from "./postgres-storage.js";
import type { CommercialDocumentLineReadModel } from "./sdk-read-models.js";

export type InvoiceDraftStatus = "draft" | "issued" | "voided";

export type InvoiceDraft = {
  readonly invoiceDraftId: string;
  readonly customerId: string;
  readonly receivableAccountId: string;
  readonly documentNumber?: string;
  readonly documentDate: IsoDate;
  readonly dueDate: IsoDate;
  readonly currencyCode: IsoCurrencyCode;
  readonly memo?: string;
  readonly status: InvoiceDraftStatus;
  /** Host provenance retained on the draft, including after issuance. Not ledger amounts. */
  readonly metadata?: Readonly<Record<string, JsonValue>>;
  readonly version: number;
  readonly originalAmount: DecimalString;
  readonly issuedDocumentId?: string;
  readonly lines: readonly CommercialDocumentLineReadModel[];
};

export type SaveInvoiceDraftInput = {
  readonly operation: FinancialOperationContext;
  readonly idempotencyKey: string;
  readonly customerId: string;
  readonly receivableAccount: ErpFinancialsAccountReference;
  readonly documentNumber?: string;
  readonly documentDate: IsoDate;
  readonly dueDate: IsoDate;
  readonly currencyCode?: IsoCurrencyCode;
  readonly memo?: string;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
  readonly revenueLines: readonly SubledgerAmountLine[];
};

export type UpdateInvoiceDraftInput = Omit<SaveInvoiceDraftInput, "idempotencyKey"> & {
  readonly invoiceDraftId: string;
  readonly expectedVersion: number;
};

export type UpdateInvoiceDraftDatesInput = {
  readonly operation: FinancialOperationContext;
  readonly invoiceDraftId: string;
  readonly expectedVersion: number;
  readonly documentDate: IsoDate;
  readonly dueDate: IsoDate;
};

export type IssueInvoiceDraftInput = {
  readonly operation: FinancialOperationContext;
  readonly invoiceDraftId: string;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
};

export type IssueInvoiceDraftResult = {
  readonly status: "issued" | "already_issued";
  readonly invoiceDraftId: string;
  readonly invoiceDocumentId: string;
  readonly transactionId: string;
  readonly version: number;
};

export type VoidIssuedInvoiceInput = {
  readonly operation: FinancialOperationContext;
  readonly invoiceDocumentId: string;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly date: IsoDate;
  readonly memo?: string;
};

export type VoidIssuedInvoiceResult = {
  readonly status: "voided" | "already_voided";
  readonly invoiceDocumentId: string;
  readonly creditDocumentId: string;
  readonly applicationId: string;
  readonly invoiceVoidId: string;
};

/** Optional caller policy enforced atomically against active, scoped accounts.
 * The SDK supplies no default classification restriction for existing consumers. */
export type InvoiceReplacementAccountPolicy = InvoiceAccountPolicy;

/** A complete reviewed release plan. Source versions are those reviewed before
 * any releases, including when several applications share a receipt/credit.
 * Cancellation never returns cash. Optional reapplication only uses released funds.
 */
export type CorrectIssuedInvoiceInput = VoidIssuedInvoiceInput & {
  readonly releases: readonly {
    readonly applicationId: string;
    readonly expectedVersion: number;
    readonly expectedSourceVersion: number;
    readonly reapplyAmount: DecimalString;
  }[];
  /** Same customer, receivable and posting date; no backdated replacement. */
  readonly replacement?: Omit<SaveInvoiceDraftInput,
    "operation" | "idempotencyKey" | "customerId" | "receivableAccount" | "documentDate" | "currencyCode"> & {
      readonly accountPolicy?: InvoiceReplacementAccountPolicy;
    };
};

/** Immutable completion evidence, not a current balance projection. */
export type CorrectIssuedInvoiceResult = {
  readonly status: "corrected" | "already_corrected";
  readonly cancellation: VoidIssuedInvoiceResult;
  readonly releasedApplications: readonly SubledgerApplicationResult[];
  readonly applications: readonly SubledgerApplicationResult[];
  readonly replacement?: IssueInvoiceDraftResult;
  readonly lifecycleEventId: string;
};

export type RecordInvoiceDeliveryInput = {
  readonly operation: FinancialOperationContext;
  readonly invoiceDocumentId: string;
  readonly idempotencyKey: string;
  readonly status: "sent" | "delivered" | "failed";
  readonly channel: string;
  readonly recipientRef?: string;
  readonly occurredAt?: IsoDateTime;
};

export type InvoiceWorkflow = {
  /** Native write-source draft identity, including issued/voided drafts. Does not resolve posted IDs. */
  getDraft(invoiceDraftId: string): Promise<InvoiceDraft & { readonly metadata: Readonly<Record<string, JsonValue>> }>;
  createDraft(input: SaveInvoiceDraftInput): Promise<InvoiceDraft>;
  updateDraft(input: UpdateInvoiceDraftInput): Promise<InvoiceDraft>;
  updateDraftDates(input: UpdateInvoiceDraftDatesInput): Promise<InvoiceDraft>;
  voidDraft(input: { readonly operation: FinancialOperationContext; readonly invoiceDraftId: string; readonly expectedVersion: number }): Promise<InvoiceDraft>;
  issue(input: IssueInvoiceDraftInput): Promise<IssueInvoiceDraftResult>;
  voidIssued(input: VoidIssuedInvoiceInput): Promise<VoidIssuedInvoiceResult>;
  correctIssued(input: CorrectIssuedInvoiceInput): Promise<CorrectIssuedInvoiceResult>;
  recordDelivery(input: RecordInvoiceDeliveryInput): Promise<{ readonly deliveryEventId: string; readonly lifecycleEventId: string }>;
};

type Scope = {
  readonly invoiceAccountPolicy?: InvoiceAccountPolicy;
  readonly financialApprovalPolicy?: FinancialApprovalPolicy;
  readonly database: ErpFinancialsTransactionRunner;
  readonly tenantId: string;
  readonly companyId: string;
  readonly bookId: string;
  readonly sourceId: string;
  readonly currencyCode: IsoCurrencyCode;
  readonly accountingBasis: AccountingBasis;
  readonly postingPolicy: "enforce_fiscal_periods" | "legacy_unrestricted";
  readonly now: () => IsoDateTime;
};

export function createInvoiceWorkflow(input: {
  readonly invoiceAccountPolicy?: InvoiceAccountPolicy;
  readonly financialApprovalPolicy?: FinancialApprovalPolicy;
  readonly database: ErpFinancialsTransactionRunner;
  readonly tenantId: string;
  readonly companyId: string;
  readonly bookId: string;
  readonly sourceId: string;
  readonly currencyCode: IsoCurrencyCode;
  readonly accountingBasis?: AccountingBasis;
  readonly postingPolicy?: "enforce_fiscal_periods" | "legacy_unrestricted";
  readonly now?: () => IsoDateTime;
}): InvoiceWorkflow {
  const invoiceAccountPolicy = normalizeInvoiceReplacementPolicy(input.invoiceAccountPolicy);
  const scope: Scope = {
    ...input,
    ...(invoiceAccountPolicy === undefined ? {} : { invoiceAccountPolicy }),
    accountingBasis: input.accountingBasis ?? "accrual",
    postingPolicy: input.postingPolicy ?? "enforce_fiscal_periods",
    now: input.now ?? (() => new Date().toISOString())
  };
  for (const [field, value] of Object.entries({ tenantId: input.tenantId, companyId: input.companyId, bookId: input.bookId, sourceId: input.sourceId, currencyCode: input.currencyCode })) {
    assertNonEmpty(value, field);
  }
  assertCurrency(input.currencyCode, "currencyCode");
  return {
    getDraft: async (invoiceDraftId) => {
      if (typeof invoiceDraftId !== "string" || invoiceDraftId.length > 512) {
        throw new ErpFinancialsError("invalid_input", "invoiceDraftId must contain 1–512 characters");
      }
      assertNonEmpty(invoiceDraftId, "invoiceDraftId");
      return scope.database.transaction(async (client) => {
        const draft = await loadDraft(client, scope, invoiceDraftId);
        if (draft.currencyCode !== scope.currencyCode) throw new ErpFinancialsError("missing_document", "Invoice draft does not exist in the configured currency");
        return draft;
      });
    },
    createDraft: (command) => createDraft(scope, command),
    updateDraft: (command) => updateDraft(scope, command),
    updateDraftDates: (command) => updateDraftDates(scope, command),
    voidDraft: (command) => runFinancialAction(scope, "invoices.voidDraft", command, voidDraft),
    issue: (command) => issueDraft(scope, command),
    voidIssued: (command) => runFinancialAction(scope, "invoices.voidIssued", command, voidIssuedInvoice),
    correctIssued: (command) => runFinancialAction(scope, "invoices.correctIssued", command, correctIssuedInvoice),
    recordDelivery: (command) => recordDelivery(scope, command)
  };
}

function snapshotCommand<Input extends { readonly operation: FinancialOperationContext }>(input: Input): Input {
  return { ...structuredClone(input), operation: copyFinancialOperation(input.operation) };
}

function commandChecksum(operation: FinancialOperationContext, business: JsonValue): string {
  return createHash("sha256").update(stableJson({ business, actorRef: operation.actorRef,
    approverRef: operation.approverRef ?? null, reasonCode: operation.reasonCode, reasonDetail: operation.reasonDetail ?? null })).digest("hex");
}

function draftChecksum(scope: Scope, input: Omit<SaveInvoiceDraftInput, "idempotencyKey">, lines: readonly NormalizedLine[], expectedVersion?: number): string {
  return commandChecksum(input.operation, {
    customerId: input.customerId, receivableAccountId: resolveAccountId(scope, input.receivableAccount),
    documentNumber: input.documentNumber ?? null, documentDate: input.documentDate, dueDate: input.dueDate,
    currencyCode: input.currencyCode ?? scope.currencyCode, memo: input.memo ?? null, metadata: input.metadata ?? {},
    expectedVersion: expectedVersion ?? null, lines: lines.map(normalizeLineForComparison)
  });
}

async function loadCommandReplay(client: PostgresQueryClient, scope: Scope, key: string, id: string, eventType: string,
  operation: FinancialOperationContext, checksum: string): Promise<{ readonly legacy: boolean } | undefined> {
  const row = (await client.query(
    `select * from "erp_financials"."financial_lifecycle_events"
where "tenant_id"=$1 and "company_id"=$2 and "source_id"=$3 and "idempotency_key"=$4 for key share`,
    [scope.tenantId, scope.companyId, scope.sourceId, key]
  )).rows[0];
  if (!row) return undefined;
  const payload = parsedStoredJson(row.payload, "payload") as { readonly commandChecksum?: string };
  if (row.aggregate_id !== id || row.aggregate_type !== "invoice_draft" || row.event_type !== eventType ||
    row.actor_ref !== operation.actorRef || optionalString(row.approver_ref) !== operation.approverRef ||
    row.reason_code !== operation.reasonCode || optionalString(row.reason_detail) !== operation.reasonDetail ||
    (payload.commandChecksum !== undefined && payload.commandChecksum !== checksum)) {
    throw new ErpFinancialsIdempotencyConflictError(key);
  }
  return { legacy: payload.commandChecksum === undefined };
}

async function createDraft(scope: Scope, input: SaveInvoiceDraftInput): Promise<InvoiceDraft> {
  input = snapshotCommand(input);
  assertFinancialOperationContext(input.operation);
  validateDraftInput(scope, input);
  const invoiceDraftId = stableId("invoice_draft", scope.tenantId, scope.companyId, scope.bookId, input.idempotencyKey);
  const lines = normalizedLines(scope, input.revenueLines);
  const timestamp = scope.now();
  const checksum = draftChecksum(scope, input, lines);
  const eventKey = `invoice-draft:${input.idempotencyKey}:created`;
  const metadata = input.metadata ?? {};
  assertNoCredentialKeys(metadata);
  assertBoundedJson(metadata, "metadata");
  return scope.database.transaction(async (client) => {
    await lockCustomerPaymentCorrectionSource(client, scope.tenantId, scope.sourceId);
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `invoice-draft-create:${scope.tenantId}:${scope.companyId}:${scope.bookId}:${input.idempotencyKey}`
    ]);
    const replay = await loadCommandReplay(client, scope, eventKey, invoiceDraftId, "invoice.draft_created", input.operation, checksum);
    if (replay) {
      if (replay.legacy) {
        assertSameDraft(await loadDraftByIdempotency(client, scope, input.idempotencyKey), invoiceDraftId, input, scope);
        await assertSameDraftLines(client, scope, invoiceDraftId, lines, input.idempotencyKey);
      }
      return loadDraft(client, scope, invoiceDraftId);
    }
    await assertDraftReferences(client, scope, input.customerId, resolveAccountId(scope, input.receivableAccount), lines);
    const result = await client.query(
      `insert into "erp_financials"."invoice_drafts" (
  "invoice_draft_id", "tenant_id", "company_id", "book_id", "source_id", "customer_id", "receivable_account_id",
  "document_number", "document_date", "due_date", "currency_code", "memo", "status", "version", "idempotency_key",
  "issue_idempotency_key", "issued_document_id", "metadata", "created_at", "updated_at"
) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'draft', 1, $13, null, null, $14, $15, $15)
on conflict ("tenant_id", "company_id", "book_id", "idempotency_key") do nothing
returning *`,
      [invoiceDraftId, scope.tenantId, scope.companyId, scope.bookId, scope.sourceId, input.customerId,
        resolveAccountId(scope, input.receivableAccount), input.documentNumber, input.documentDate, input.dueDate,
        input.currencyCode ?? scope.currencyCode, input.memo, input.idempotencyKey, JSON.stringify(metadata), timestamp]
    );
    const row = result.rows[0];
    // A row without its creation evidence is not an idempotent success and is
    // never silently adopted as a new request.
    if (row === undefined) throw new ErpFinancialsIdempotencyConflictError(input.idempotencyKey);
    await writeDraftLines(client, scope, invoiceDraftId, lines);
    const lifecycle = await appendFinancialLifecycleEvent(client, lifecycleInput(scope, input.operation, {
      aggregateType: "invoice_draft",
      aggregateId: invoiceDraftId,
      eventType: "invoice.draft_created",
      idempotencyKey: eventKey,
      payload: { invoiceDraftId, lineCount: lines.length, originalAmount: sumLines(lines), commandChecksum: checksum, ...(scope.invoiceAccountPolicy ? { executionAccountPolicy: scope.invoiceAccountPolicy } : {}) }
    }));
    await outbox(client, scope, "invoice.draft_created", "invoice_draft", invoiceDraftId,
      `invoice-draft:${input.idempotencyKey}:outbox:created`, { invoiceDraftId, version: integer(row.version, "version") });
    void lifecycle;
    return loadDraft(client, scope, invoiceDraftId);
  });
}

async function updateDraft(scope: Scope, input: UpdateInvoiceDraftInput): Promise<InvoiceDraft> {
  input = snapshotCommand(input);
  assertFinancialOperationContext(input.operation);
  validateDraftInput(scope, input);
  assertVersion(input.expectedVersion);
  const lines = normalizedLines(scope, input.revenueLines);
  const checksum = draftChecksum(scope, input, lines, input.expectedVersion);
  const eventKey = `invoice-draft:${input.invoiceDraftId}:updated:v${String(input.expectedVersion)}`;
  const metadata = input.metadata ?? {};
  assertNoCredentialKeys(metadata);
  assertBoundedJson(metadata, "metadata");
  return scope.database.transaction(async (client) => {
    await lockCustomerPaymentCorrectionSource(client, scope.tenantId, scope.sourceId);
    const current = await lockDraft(client, scope, input.invoiceDraftId);
    const replay = await loadCommandReplay(client, scope, eventKey, input.invoiceDraftId, "invoice.draft_updated", input.operation, checksum);
    if (replay) {
      if (replay.legacy) {
        if (integer(current.version, "version") !== input.expectedVersion + 1) throw new ErpFinancialsIdempotencyConflictError(eventKey);
        assertSameDraft(current, input.invoiceDraftId, { ...input, idempotencyKey: eventKey }, scope);
        await assertSameDraftLines(client, scope, input.invoiceDraftId, lines, eventKey);
      }
      return loadDraft(client, scope, input.invoiceDraftId);
    }
    assertMutableDraft(current, input.expectedVersion);
    await assertDraftReferences(client, scope, input.customerId, resolveAccountId(scope, input.receivableAccount), lines);
    const result = await client.query(
      `update "erp_financials"."invoice_drafts"
set "customer_id" = $5, "receivable_account_id" = $6, "document_number" = $7, "document_date" = $8,
    "due_date" = $9, "currency_code" = $10, "memo" = $11, "metadata" = $12,
    "version" = "version" + 1, "updated_at" = $13
where "tenant_id" = $1 and "company_id" = $2 and "book_id" = $3 and "invoice_draft_id" = $4
  and "status" = 'draft' and "version" = $14 and "source_id" = $15
returning *`,
      [scope.tenantId, scope.companyId, scope.bookId, input.invoiceDraftId, input.customerId,
        resolveAccountId(scope, input.receivableAccount), input.documentNumber, input.documentDate, input.dueDate,
        input.currencyCode ?? scope.currencyCode, input.memo, JSON.stringify(metadata), scope.now(), input.expectedVersion, scope.sourceId]
    );
    if (result.rows[0] === undefined) throw concurrencyError(input.invoiceDraftId, input.expectedVersion);
    await client.query(
      `delete from "erp_financials"."invoice_draft_lines"
where "tenant_id" = $1 and "company_id" = $2 and "book_id" = $3 and "invoice_draft_id" = $4 and "source_id" = $5`,
      [scope.tenantId, scope.companyId, scope.bookId, input.invoiceDraftId, scope.sourceId]
    );
    await writeDraftLines(client, scope, input.invoiceDraftId, lines);
    const lifecycle = await appendFinancialLifecycleEvent(client, lifecycleInput(scope, input.operation, {
      aggregateType: "invoice_draft",
      aggregateId: input.invoiceDraftId,
      eventType: "invoice.draft_updated",
      idempotencyKey: eventKey,
      payload: { fromVersion: input.expectedVersion, toVersion: input.expectedVersion + 1, commandChecksum: checksum, ...(scope.invoiceAccountPolicy ? { executionAccountPolicy: scope.invoiceAccountPolicy } : {}) }
    }));
    await outbox(client, scope, "invoice.draft_updated", "invoice_draft", input.invoiceDraftId,
      `invoice-draft:${input.invoiceDraftId}:outbox:updated:v${String(input.expectedVersion)}`,
      { invoiceDraftId: input.invoiceDraftId, version: input.expectedVersion + 1 });
    void lifecycle;
    return loadDraft(client, scope, input.invoiceDraftId);
  });
}

async function updateDraftDates(scope: Scope, input: UpdateInvoiceDraftDatesInput): Promise<InvoiceDraft> {
  input = snapshotCommand(input);
  assertFinancialOperationContext(input.operation);
  assertVersion(input.expectedVersion);
  assertDate(input.documentDate, "documentDate");
  assertDate(input.dueDate, "dueDate");
  const eventKey = `invoice-draft:${input.invoiceDraftId}:dates:v${String(input.expectedVersion)}`;
  const checksum = commandChecksum(input.operation, { invoiceDraftId: input.invoiceDraftId, expectedVersion: input.expectedVersion,
    documentDate: input.documentDate, dueDate: input.dueDate });
  return scope.database.transaction(async client => {
    await lockCustomerPaymentCorrectionSource(client, scope.tenantId, scope.sourceId);
    const current = await lockDraft(client, scope, input.invoiceDraftId);
    const replay = await loadCommandReplay(client, scope, eventKey, input.invoiceDraftId, "invoice.draft_dates_updated", input.operation, checksum);
    if (replay) return loadDraft(client, scope, input.invoiceDraftId);
    assertMutableDraft(current, input.expectedVersion);
    const updated = await client.query(
      `update "erp_financials"."invoice_drafts" set "document_date"=$6, "due_date"=$7, "version"="version"+1, "updated_at"=$8
where "tenant_id"=$1 and "company_id"=$2 and "book_id"=$3 and "source_id"=$4 and "invoice_draft_id"=$5
  and "status"='draft' and "version"=$9 returning "version"`,
      [scope.tenantId, scope.companyId, scope.bookId, scope.sourceId, input.invoiceDraftId, input.documentDate, input.dueDate, scope.now(), input.expectedVersion]
    );
    if (!updated.rows[0]) throw concurrencyError(input.invoiceDraftId, input.expectedVersion);
    await appendFinancialLifecycleEvent(client, lifecycleInput(scope, input.operation, {
      aggregateType: "invoice_draft", aggregateId: input.invoiceDraftId, eventType: "invoice.draft_dates_updated", idempotencyKey: eventKey,
      payload: { commandChecksum: checksum, fromVersion: input.expectedVersion, toVersion: input.expectedVersion + 1,
        previousDate: date(current.document_date, "document_date"), previousDueDate: date(current.due_date, "due_date"),
        documentDate: input.documentDate, dueDate: input.dueDate }
    }));
    await outbox(client, scope, "invoice.draft_dates_updated", "invoice_draft", input.invoiceDraftId, `${eventKey}:outbox`,
      { invoiceDraftId: input.invoiceDraftId, version: input.expectedVersion + 1 });
    return loadDraft(client, scope, input.invoiceDraftId);
  });
}

async function voidDraft(
  scope: Scope,
  input: { readonly operation: FinancialOperationContext; readonly invoiceDraftId: string; readonly expectedVersion: number }
): Promise<InvoiceDraft> {
  input = snapshotCommand(input);
  assertFinancialApproval(scope, input.operation);
  assertVersion(input.expectedVersion);
  const eventKey = `invoice-draft:${input.invoiceDraftId}:voided:v${String(input.expectedVersion)}`;
  const checksum = commandChecksum(input.operation, { invoiceDraftId: input.invoiceDraftId, expectedVersion: input.expectedVersion });
  return scope.database.transaction(async (client) => {
    await lockCustomerPaymentCorrectionSource(client, scope.tenantId, scope.sourceId);
    const current = await lockDraft(client, scope, input.invoiceDraftId);
    if (current.status === "voided") {
      const replay = await loadCommandReplay(client, scope, eventKey, input.invoiceDraftId, "invoice.draft_voided", input.operation, checksum);
      if (!replay || integer(current.version, "version") !== input.expectedVersion + 1) throw new ErpFinancialsIdempotencyConflictError(eventKey);
      return loadDraft(client, scope, input.invoiceDraftId);
    }
    assertMutableDraft(current, input.expectedVersion);
    const updated = await client.query(
      `update "erp_financials"."invoice_drafts" set "status" = 'voided', "version" = "version" + 1, "updated_at" = $5
where "tenant_id" = $1 and "company_id" = $2 and "book_id" = $3 and "invoice_draft_id" = $4
  and "status" = 'draft' and "version" = $6 and "source_id" = $7 returning *`,
      [scope.tenantId, scope.companyId, scope.bookId, input.invoiceDraftId, scope.now(), input.expectedVersion, scope.sourceId]
    );
    if (updated.rows[0] === undefined) throw concurrencyError(input.invoiceDraftId, input.expectedVersion);
    const lifecycle = await appendFinancialLifecycleEvent(client, lifecycleInput(scope, input.operation, {
      aggregateType: "invoice_draft", aggregateId: input.invoiceDraftId, eventType: "invoice.draft_voided",
      idempotencyKey: eventKey,
      payload: { fromVersion: input.expectedVersion, toVersion: input.expectedVersion + 1, commandChecksum: checksum }
    }));
    await outbox(client, scope, "invoice.draft_voided", "invoice_draft", input.invoiceDraftId,
      `invoice-draft:${input.invoiceDraftId}:outbox:voided:v${String(input.expectedVersion)}`,
      { invoiceDraftId: input.invoiceDraftId, version: input.expectedVersion + 1 });
    void lifecycle;
    return loadDraft(client, scope, input.invoiceDraftId);
  });
}

async function issueDraft(scope: Scope, input: IssueInvoiceDraftInput): Promise<IssueInvoiceDraftResult> {
  input = snapshotCommand(input);
  assertFinancialOperationContext(input.operation);
  assertVersion(input.expectedVersion);
  assertNonEmpty(input.idempotencyKey, "idempotencyKey");
  const checksum = commandChecksum(input.operation, { invoiceDraftId: input.invoiceDraftId, expectedVersion: input.expectedVersion, idempotencyKey: input.idempotencyKey });
  const eventKey = `invoice-draft:${input.invoiceDraftId}:issued:${input.idempotencyKey}`;
  return scope.database.transaction(async (client) => {
    await lockCustomerPaymentCorrectionSource(client, scope.tenantId, scope.sourceId);
    const current = await lockDraft(client, scope, input.invoiceDraftId);
    if (current.status === "issued") {
      if (current.issue_idempotency_key !== input.idempotencyKey) throw new ErpFinancialsIdempotencyConflictError(input.idempotencyKey);
      const replay = await loadCommandReplay(client, scope, eventKey, input.invoiceDraftId, "invoice.issued", input.operation, checksum);
      if (!replay || (replay.legacy && integer(current.version, "version") !== input.expectedVersion + 1)) {
        throw new ErpFinancialsIdempotencyConflictError(input.idempotencyKey);
      }
      return {
        status: "already_issued",
        invoiceDraftId: input.invoiceDraftId,
        invoiceDocumentId: string(current.issued_document_id, "issued_document_id"),
        transactionId: await invoiceTransactionId(client, scope, string(current.issued_document_id, "issued_document_id")),
        version: integer(current.version, "version")
      };
    }
    assertMutableDraft(current, input.expectedVersion);
    const lines = await loadDraftLineInputs(client, scope, input.invoiceDraftId);
    const nested = { transaction: async <Result>(work: (nestedClient: PostgresQueryClient) => Promise<Result>) => work(client) };
    const service = createErpFinancials({
      ...(scope.invoiceAccountPolicy === undefined ? {} : { invoiceAccountPolicy: scope.invoiceAccountPolicy }),
      database: nested,
      tenantId: scope.tenantId,
      companyId: scope.companyId,
      sourceId: scope.sourceId,
      bookId: scope.bookId,
      currencyCode: scope.currencyCode,
      currencyPolicy: "single_currency",
      accountingBasis: scope.accountingBasis,
      postingPolicy: scope.postingPolicy,
      now: scope.now
    });
    const documentNumber = optionalString(current.document_number);
    const memo = optionalString(current.memo);
    const result = await service.invoices.create({
      operation: input.operation,
      idempotencyKey: input.idempotencyKey,
      date: date(current.document_date, "document_date"),
      dueDate: date(current.due_date, "due_date"),
      customerId: string(current.customer_id, "customer_id"),
      receivableAccount: { accountId: string(current.receivable_account_id, "receivable_account_id") },
      ...(documentNumber === undefined ? {} : { documentNumber }),
      ...(memo === undefined ? {} : { memo }),
      currencyCode: scope.currencyCode,
      revenueLines: lines
    });
    const updated = await client.query(
      `update "erp_financials"."invoice_drafts"
set "status" = 'issued', "issue_idempotency_key" = $5, "issued_document_id" = $6,
    "version" = "version" + 1, "updated_at" = $7
where "tenant_id" = $1 and "company_id" = $2 and "book_id" = $3 and "invoice_draft_id" = $4
  and "status" = 'draft' and "version" = $8 and "source_id" = $9 returning "version"`,
      [scope.tenantId, scope.companyId, scope.bookId, input.invoiceDraftId, input.idempotencyKey,
        result.documentId, scope.now(), input.expectedVersion, scope.sourceId]
    );
    if (updated.rows[0] === undefined) throw concurrencyError(input.invoiceDraftId, input.expectedVersion);
    const lifecycle = await appendFinancialLifecycleEvent(client, lifecycleInput(scope, input.operation, {
      aggregateType: "invoice_draft", aggregateId: input.invoiceDraftId, eventType: "invoice.issued",
      idempotencyKey: eventKey,
      payload: { invoiceDocumentId: result.documentId, transactionId: result.journal.transactionId, commandChecksum: checksum, expectedVersion: input.expectedVersion }
    }));
    await outbox(client, scope, "invoice.issued", "invoice", result.documentId,
      `invoice:${input.idempotencyKey}:outbox:issued`, { invoiceDocumentId: result.documentId, invoiceDraftId: input.invoiceDraftId });
    void lifecycle;
    return {
      status: "issued",
      invoiceDraftId: input.invoiceDraftId,
      invoiceDocumentId: result.documentId,
      transactionId: result.journal.transactionId,
      version: integer(requiredRow(updated.rows[0], "issued invoice draft").version, "version")
    };
  });
}

/** A caller may catch a failed SDK command inside an otherwise valid host
 * transaction. Keep the complete credit/application/receipt/outbox unit atomic. */
async function withInvoiceCancellationSavepoint<Result>(client: PostgresQueryClient, work: () => Promise<Result>): Promise<Result> {
  await client.query("savepoint erp_invoice_cancellation");
  try {
    const result = await work();
    await client.query("release savepoint erp_invoice_cancellation");
    return result;
  } catch (error) {
    await client.query("rollback to savepoint erp_invoice_cancellation");
    await client.query("release savepoint erp_invoice_cancellation");
    throw error;
  }
}

async function voidIssuedInvoice(scope: Scope, input: VoidIssuedInvoiceInput): Promise<VoidIssuedInvoiceResult> {
  input = snapshotCommand(input);
  assertFinancialApproval(scope, input.operation);
  assertVersion(input.expectedVersion);
  assertDate(input.date, "date");
  for (const [field, value] of Object.entries({ invoiceDocumentId: input.invoiceDocumentId, idempotencyKey: input.idempotencyKey })) {
    if (typeof value !== "string" || value.length > 512 || value.trim().length === 0) {
      throw new ErpFinancialsError("invalid_input", `${field} must contain 1–512 characters`);
    }
  }
  if (input.memo !== undefined && typeof input.memo !== "string") throw new ErpFinancialsError("invalid_input", "memo must be a string");
  assertBoundedJson({ memo: input.memo ?? null }, "cancellation memo");
  const checksum = commandChecksum(input.operation, { invoiceDocumentId: input.invoiceDocumentId,
    expectedVersion: input.expectedVersion, date: input.date, memo: input.memo ?? null,
    currencyCode: scope.currencyCode, accountingBasis: scope.accountingBasis });
  return scope.database.transaction(client => withInvoiceCancellationSavepoint(client, async () => {
    await lockCustomerPaymentCorrectionSource(client, scope.tenantId, scope.sourceId);
    const existing = await client.query(
      `select * from "erp_financials"."invoice_voids" where "tenant_id" = $1 and "company_id" = $2 and "book_id" = $3 and "idempotency_key" = $4 and "source_id" = $5 for key share`,
      [scope.tenantId, scope.companyId, scope.bookId, input.idempotencyKey, scope.sourceId]
    );
    if (existing.rows[0] !== undefined) {
      const receipt = existing.rows[0];
      if (receipt.invoice_document_id !== input.invoiceDocumentId) throw new ErpFinancialsIdempotencyConflictError(input.idempotencyKey);
      const event = (await client.query(
        `select aggregate_type, aggregate_id, event_type, payload from "erp_financials"."financial_lifecycle_events"
         where tenant_id=$1 and company_id=$2 and source_id=$3 and event_id=$4 for key share`,
        [scope.tenantId, scope.companyId, scope.sourceId, receipt.lifecycle_event_id]
      )).rows[0];
      const payload = event ? parsedStoredJson(event.payload, "payload") as { readonly commandChecksum?: string } : undefined;
      // Older receipts never retained expectedVersion or the complete command.
      // Do not invent that evidence, rewrite history, or report a changed command
      // as successful. Historical cancellation remains readable via invoice audit.
      if (payload?.commandChecksum === undefined) throw new ErpFinancialsError("unsupported_operation",
        "Historical invoice cancellation lacks command identity; reconcile its immutable invoice audit receipt instead of resubmitting or choosing a new key");
      if (event?.aggregate_type !== "invoice" || event.aggregate_id !== input.invoiceDocumentId || event.event_type !== "invoice.voided" || payload.commandChecksum !== checksum) {
        throw new ErpFinancialsIdempotencyConflictError(input.idempotencyKey);
      }
      return invoiceVoidResult(receipt, "already_voided");
    }
    const invoiceResult = await client.query(
      `select *, "document_date"::text as "document_date", "due_date"::text as "due_date", (to_jsonb("subledger_documents")->>'recognition_date') as "recognition_date" from "erp_financials"."subledger_documents"
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3 and "subledger_document_id" = $4
for update`,
      [scope.tenantId, scope.companyId, scope.sourceId, input.invoiceDocumentId]
    );
    const invoice = invoiceResult.rows[0];
    if (invoice === undefined || invoice.document_type !== "invoice") {
      throw new ErpFinancialsError("missing_document", `Invoice ${input.invoiceDocumentId} does not exist in the write source`);
    }
    if (input.date < date(invoice.recognition_date ?? invoice.document_date, "recognition_date")) throw new ErpFinancialsError("invalid_input", "Invoice cancellation cannot precede recognition");
    if (integer(invoice.version, "version") !== input.expectedVersion) throw concurrencyError(input.invoiceDocumentId, input.expectedVersion);
    if (money(invoice.open_amount, "open_amount") !== money(invoice.original_amount, "original_amount")) {
      throw new ErpFinancialsError(
        "terminal_state_conflict",
        "A partially paid or settled invoice cannot be voided; use an explicit credit/refund workflow for the remaining balance"
      );
    }
    const previousVoid = await client.query(
      `select * from "erp_financials"."invoice_voids" where "tenant_id" = $1 and "company_id" = $2 and "book_id" = $3 and "invoice_document_id" = $4 for key share`,
      [scope.tenantId, scope.companyId, scope.bookId, input.invoiceDocumentId]
    );
    if (previousVoid.rows[0] !== undefined) {
      throw new ErpFinancialsError("terminal_state_conflict", `Invoice ${input.invoiceDocumentId} is already voided`);
    }
    const priorChildren = await client.query(`select 1 from erp_financials.subledger_documents
where tenant_id=$1 and company_id=$2 and source_id=$3 and idempotency_key=$4
union all select 1 from erp_financials.subledger_applications
where tenant_id=$1 and company_id=$2 and source_id=$3 and idempotency_key=$5 limit 1`,
      [scope.tenantId, scope.companyId, scope.sourceId, `${input.idempotencyKey}:credit`, `${input.idempotencyKey}:application`]);
    if (priorChildren.rows.length) throw new ErpFinancialsIdempotencyConflictError(input.idempotencyKey);
    const receivable = await loadInvoiceReceivableAccount(client, scope, invoice);
    const lines = await loadPostedInvoiceLineInputs(client, scope, input.invoiceDocumentId);
    const nested = { transaction: async <Result>(work: (nestedClient: PostgresQueryClient) => Promise<Result>) => work(client) };
    const service = createErpFinancials({
      ...(scope.invoiceAccountPolicy === undefined ? {} : { invoiceAccountPolicy: scope.invoiceAccountPolicy }),
      database: nested, tenantId: scope.tenantId, companyId: scope.companyId, sourceId: scope.sourceId,
      bookId: scope.bookId, currencyCode: scope.currencyCode, currencyPolicy: "single_currency",
      accountingBasis: scope.accountingBasis, postingPolicy: "enforce_fiscal_periods", now: scope.now
    });
    const credit = await service.credits.issue({
      operation: input.operation,
      idempotencyKey: `${input.idempotencyKey}:credit`,
      date: input.date,
      customerId: string(invoice.party_id, "party_id"),
      receivableAccount: { accountId: receivable },
      revenueLines: lines,
      ...(input.memo === undefined ? {} : { memo: input.memo })
    });
    const application = await service.paymentApplications.apply({
      operation: input.operation,
      idempotencyKey: `${input.idempotencyKey}:application`,
      applicationType: "credit_to_invoice",
      sourceDocumentId: credit.documentId,
      targetDocumentId: input.invoiceDocumentId,
      amount: credit.originalAmount,
      applicationDate: input.date,
      expectedSourceVersion: credit.version,
      expectedTargetVersion: input.expectedVersion
    });
    const invoiceVoidId = stableId("invoice_void", scope.tenantId, scope.companyId, scope.bookId, input.idempotencyKey);
    const lifecycle = await appendFinancialLifecycleEvent(client, lifecycleInput(scope, input.operation, {
      aggregateType: "invoice", aggregateId: input.invoiceDocumentId, eventType: "invoice.voided",
      idempotencyKey: `invoice:${input.idempotencyKey}:voided`,
      payload: { applicationId: application.applicationId, creditDocumentId: credit.documentId, commandChecksum: checksum }
    }));
    const inserted = await client.query(
      `insert into "erp_financials"."invoice_voids" (
  "invoice_void_id", "tenant_id", "company_id", "book_id", "source_id", "invoice_document_id",
  "credit_document_id", "application_id", "idempotency_key", "lifecycle_event_id", "created_at"
) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning *`,
      [invoiceVoidId, scope.tenantId, scope.companyId, scope.bookId, scope.sourceId, input.invoiceDocumentId,
        credit.documentId, application.applicationId, input.idempotencyKey, lifecycle.eventId, scope.now()]
    );
    await outbox(client, scope, "invoice.voided", "invoice", input.invoiceDocumentId,
      `invoice:${input.idempotencyKey}:outbox:voided`, { applicationId: application.applicationId, creditDocumentId: credit.documentId });
    return invoiceVoidResult(requiredRow(inserted.rows[0], "invoice void"), "voided");
  }));
}

async function assertInvoiceReplacementAccounts(client: PostgresQueryClient, scope: Scope, receivable: string,
  lines: readonly SubledgerAmountLine[], policy: InvoiceReplacementAccountPolicy): Promise<void> {
  const rawLines: unknown = lines;
  if (!Array.isArray(rawLines) || !rawLines.length) throw new ErpFinancialsError("invalid_input", "Invoice replacement requires revenue lines");
  const requirements = [{ accountId: receivable, classifications: policy.receivableClassifications },
    ...lines.map(line => {
      const candidate: unknown = line;
      if (!candidate || typeof candidate !== "object") throw new ErpFinancialsError("invalid_input", "Invoice replacement requires valid account references");
      const accountId = resolveAccountId(scope, line);
      if (typeof accountId !== "string" || !accountId.trim()) throw new ErpFinancialsError("invalid_input", "Invoice replacement requires valid account references");
      return { accountId, classifications: policy.revenueClassifications };
    }),...lines.flatMap(line=>invoiceComponentRequirements(line,policy,ref=>resolveAccountId(scope,ref)))];
  const ids = [...new Set(requirements.map(row => row.accountId))].sort();
  await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`account-hierarchy:${scope.tenantId}:${scope.sourceId}`]);
  // SHARE, not KEY SHARE: active/classification edits must wait for this posting.
  const rows = (await client.query(`select account_id,classification,active from erp_financials.accounts
where tenant_id=$1 and source_id=$2 and account_id=any($3::text[]) order by account_id for share`,
  [scope.tenantId, scope.sourceId, ids])).rows;
  const accounts = new Map(rows.map(row => [string(row.account_id, "account_id"), row]));
  for (const requirement of requirements) {
    const account = accounts.get(requirement.accountId);
    if (!account || account.active !== true) throw new ErpFinancialsError("missing_account", "Invoice replacement requires active accounts in its write source");
    if (!requirement.classifications.includes(account.classification as AccountClassification)) {
      throw new ErpFinancialsError("invalid_input", "Invoice replacement account classification violates the approved policy");
    }
  }
}

async function correctIssuedInvoice(scope: Scope, input: CorrectIssuedInvoiceInput): Promise<CorrectIssuedInvoiceResult> {
  const command = snapshotCommand(input);
  assertFinancialApproval(scope, command.operation);
  assertVersion(command.expectedVersion);
  assertDate(command.date, "date");
  for (const [field, value] of Object.entries({ invoiceDocumentId: command.invoiceDocumentId, idempotencyKey: command.idempotencyKey })) {
    if (typeof value !== "string" || !value.trim() || value.length > 512) throw new ErpFinancialsError("invalid_input", `${field} must contain 1–512 characters`);
  }
  const replacementPolicy = normalizeInvoiceReplacementPolicy(command.replacement?.accountPolicy);
  const rawReleases: unknown = command.releases;
  if (!Array.isArray(rawReleases)) throw new ErpFinancialsError("invalid_input", "Correction requires an explicit complete application release plan");
  const releases = command.releases.map(release => {
    assertNonEmpty(release.applicationId, "applicationId");
    assertVersion(release.expectedVersion); assertVersion(release.expectedSourceVersion);
    if (typeof release.reapplyAmount !== "string" || !/^(0|[1-9]\d*)\.\d{2}$/u.test(release.reapplyAmount)) {
      throw new ErpFinancialsError("invalid_input", "Reapply amount must be nonnegative exact money with two decimal places");
    }
    if (!command.replacement && release.reapplyAmount !== "0.00") throw new ErpFinancialsError("invalid_input", "Reapplication requires an explicit replacement invoice");
    return { ...release };
  }).sort((a, b) => a.applicationId.localeCompare(b.applicationId));
  if (new Set(releases.map(release => release.applicationId)).size !== releases.length) throw new ErpFinancialsError("invalid_input", "Application release IDs must be unique");
  const { operation, ...business } = command;
  const checksum = commandChecksum(operation, JSON.parse(JSON.stringify({ ...business, releases,
    bookId: scope.bookId, currencyCode: scope.currencyCode, accountingBasis: scope.accountingBasis })) as JsonValue);
  const key = stableIdWithLength("invoice_correction", 48, scope.tenantId, scope.companyId, scope.sourceId, scope.bookId, command.idempotencyKey);
  return scope.database.transaction(async client => {
    await client.query("savepoint erp_invoice_correction");
    try {
      await lockCustomerPaymentCorrectionSource(client, scope.tenantId, scope.sourceId);
      const previous = (await client.query(
        `select aggregate_id,event_type,payload,event_id from erp_financials.financial_lifecycle_events
where tenant_id=$1 and company_id=$2 and source_id=$3 and idempotency_key=$4 for key share`,
        [scope.tenantId, scope.companyId, scope.sourceId, `${key}:completed`])).rows[0];
      if (previous) {
        const payload = parsedStoredJson(previous.payload, "payload") as { commandChecksum?: string; result?: Omit<CorrectIssuedInvoiceResult, "status" | "lifecycleEventId"> };
        if (previous.aggregate_id !== command.invoiceDocumentId || previous.event_type !== "invoice.corrected" || payload.commandChecksum !== checksum || !payload.result) {
          throw new ErpFinancialsIdempotencyConflictError(command.idempotencyKey);
        }
        await client.query("release savepoint erp_invoice_correction");
        return { ...payload.result, status: "already_corrected", lifecycleEventId: string(previous.event_id, "event_id") };
      }
      const invoice = await correctionDocument(client, scope, command.invoiceDocumentId);
      if (invoice.document_type !== "invoice") throw new ErpFinancialsError("missing_document", "Correction requires a native invoice");
      if (integer(invoice.version, "version") !== command.expectedVersion) throw concurrencyError(command.invoiceDocumentId, command.expectedVersion);
      await assertCorrectionDocumentBook(client, scope, invoice);
      const receivable = await loadInvoiceReceivableAccount(client, scope, invoice);
      if (replacementPolicy && command.replacement) {
        await assertInvoiceReplacementAccounts(client, scope, receivable, command.replacement.revenueLines, replacementPolicy);
      }
      const active = (await client.query(
        `select *,application_date::text as application_date from erp_financials.subledger_applications
where tenant_id=$1 and company_id=$2 and source_id=$3 and target_document_id=$4 and status='applied'
order by subledger_application_id limit $5 for update`,
        [scope.tenantId, scope.companyId, scope.sourceId, command.invoiceDocumentId, releases.length + 1])).rows;
      const byId = new Map(active.map(row => [string(row.subledger_application_id, "application_id"), row]));
      if (active.length !== releases.length || releases.some(release => !byId.has(release.applicationId))) {
        throw new ErpFinancialsError("optimistic_concurrency_conflict", "Review every active invoice application before correction", { retryable: true });
      }
      // Validate the whole plan before releasing anything. Multiple releases may
      // reference one source; every expectedSourceVersion is the initial version.
      for (const release of releases) {
        const row = requiredRow(byId.get(release.applicationId), "reviewed application");
        if (!["customer_payment_to_invoice", "credit_to_invoice"].includes(string(row.application_type, "application_type"))) {
          throw new ErpFinancialsError("unsupported_operation", "Correction cannot release this application type");
        }
        if (integer(row.version, "version") !== release.expectedVersion) throw concurrencyError(release.applicationId, release.expectedVersion);
        if (date(row.application_date, "application_date") > command.date) throw new ErpFinancialsError("invalid_input", "Correction cannot precede a released application");
        if (BigInt(release.reapplyAmount.replace(".", "")) > BigInt(money(row.applied_amount, "applied_amount").replace(".", ""))) {
          throw new ErpFinancialsError("invalid_input", "Reapplication cannot exceed the reviewed released amount");
        }
        const source = await correctionDocument(client, scope, string(row.source_document_id, "source_document_id"));
        if (integer(source.version, "version") !== release.expectedSourceVersion) throw concurrencyError(string(source.subledger_document_id, "document_id"), release.expectedSourceVersion);
        if (source.party_id !== invoice.party_id || source.currency_code !== invoice.currency_code ||
            source.document_type !== (row.application_type === "customer_payment_to_invoice" ? "customer_payment" : "credit_memo")) {
          throw new ErpFinancialsError("scope_mismatch", "Application source differs from the invoice customer, currency or type");
        }
        await assertCorrectionDocumentBook(client, scope, source);
      }
      // Do not adopt an independently created child instruction as this command.
      const children = await client.query(`select 1 from erp_financials.invoice_voids where tenant_id=$1 and company_id=$2 and source_id=$3 and idempotency_key=$4
union all select 1 from erp_financials.invoice_drafts where tenant_id=$1 and company_id=$2 and source_id=$3 and idempotency_key=$5
union all select 1 from erp_financials.subledger_documents where tenant_id=$1 and company_id=$2 and source_id=$3 and idempotency_key=any($6::text[])
union all select 1 from erp_financials.subledger_applications where tenant_id=$1 and company_id=$2 and source_id=$3 and idempotency_key=any($7::text[]) limit 1`,
        [scope.tenantId, scope.companyId, scope.sourceId, `${key}:cancel`, `${key}:draft`, [`${key}:cancel:credit`, `${key}:issue`],
          [`${key}:cancel:application`, ...releases.map(release => `${key}:apply:${release.applicationId}`)]]);
      if (children.rows.length) throw new ErpFinancialsIdempotencyConflictError(command.idempotencyKey);
      const database = { transaction: async <Result>(work: (connection: PostgresQueryClient) => Promise<Result>) => work(client) };
      const nested = { ...scope, database, postingPolicy: "enforce_fiscal_periods" as const };
      const service = createErpFinancials({ database, tenantId: scope.tenantId, companyId: scope.companyId, sourceId: scope.sourceId,
        bookId: scope.bookId, currencyCode: scope.currencyCode, accountingBasis: scope.accountingBasis,
        postingPolicy: "enforce_fiscal_periods", currencyPolicy: "single_currency", now: scope.now });
      const releasedApplications: SubledgerApplicationResult[] = [];
      for (const release of releases) releasedApplications.push(await service.paymentApplications.unapply({ operation,
        applicationId: release.applicationId, expectedVersion: release.expectedVersion, effectiveDate: command.date }));
      const cancellation = await voidIssuedInvoice(nested, { operation, invoiceDocumentId: command.invoiceDocumentId,
        expectedVersion: command.expectedVersion + releases.length, idempotencyKey: `${key}:cancel`, date: command.date,
        ...(command.memo === undefined ? {} : { memo: command.memo }) });
      let replacement: IssueInvoiceDraftResult | undefined;
      const applications: SubledgerApplicationResult[] = [];
      if (command.replacement) {
        const { accountPolicy: _policy, ...replacementInput } = command.replacement;
        void _policy; // Policy was checked and its account rows remain locked through commit.
        const draft = await createDraft(nested, { ...replacementInput, operation, idempotencyKey: `${key}:draft`,
          customerId: string(invoice.party_id, "party_id"), receivableAccount: { accountId: receivable }, documentDate: command.date, currencyCode: scope.currencyCode });
        replacement = await issueDraft(nested, { operation, invoiceDraftId: draft.invoiceDraftId, expectedVersion: draft.version, idempotencyKey: `${key}:issue` });
        for (const release of releases) {
          if (release.reapplyAmount === "0.00") continue;
          const row = requiredRow(byId.get(release.applicationId), "released application");
          const sourceId = string(row.source_document_id, "source_document_id");
          const source = await correctionDocument(client, scope, sourceId), target = await correctionDocument(client, scope, replacement.invoiceDocumentId);
          applications.push(await service.paymentApplications.apply({ operation, idempotencyKey: `${key}:apply:${release.applicationId}`,
            applicationType: row.application_type as "customer_payment_to_invoice" | "credit_to_invoice",
            sourceDocumentId: sourceId, targetDocumentId: replacement.invoiceDocumentId, amount: release.reapplyAmount, applicationDate: command.date,
            expectedSourceVersion: integer(source.version, "version"), expectedTargetVersion: integer(target.version, "version") }));
        }
      }
      const result = { cancellation, releasedApplications, applications, ...(replacement ? { replacement } : {}) };
      const event = await appendFinancialLifecycleEvent(client, lifecycleInput(scope, operation, {
        aggregateType: "invoice", aggregateId: command.invoiceDocumentId, eventType: "invoice.corrected", idempotencyKey: `${key}:completed`,
        payload: JSON.parse(JSON.stringify({ commandChecksum: checksum, result, ...(replacementPolicy ? { accountPolicy: replacementPolicy } : {}) })) as JsonValue }));
      await outbox(client, scope, "invoice.corrected", "invoice", command.invoiceDocumentId, `${key}:outbox`,
        { lifecycleEventId: event.eventId, replacementInvoiceId: replacement?.invoiceDocumentId ?? null });
      await client.query("release savepoint erp_invoice_correction");
      return { ...result, status: "corrected", lifecycleEventId: event.eventId };
    } catch (error) {
      await client.query("rollback to savepoint erp_invoice_correction");
      await client.query("release savepoint erp_invoice_correction");
      throw error;
    }
  });
}

async function correctionDocument(client: PostgresQueryClient, scope: Scope, documentId: string): Promise<Record<string, unknown>> {
  const row = (await client.query(`select * from erp_financials.subledger_documents
where tenant_id=$1 and company_id=$2 and source_id=$3 and subledger_document_id=$4 for update`,
    [scope.tenantId, scope.companyId, scope.sourceId, documentId])).rows[0];
  if (!row) throw new ErpFinancialsError("missing_document", "Correction document does not exist in the write scope");
  return row;
}

async function assertCorrectionDocumentBook(client: PostgresQueryClient, scope: Scope, document: Record<string, unknown>): Promise<void> {
  const rows = (await client.query(`select book_id from erp_financials.financial_outbox
where tenant_id=$1 and company_id=$2 and source_id=$3 and aggregate_id=$4 and event_type='ledger.posted' and idempotency_key=$5 for key share`,
    [scope.tenantId, scope.companyId, scope.sourceId, document.transaction_id,
      `ledger-posted:Subledger:${string(document.document_type, "document_type")}:${string(document.idempotency_key, "idempotency_key")}`])).rows;
  if (rows.length !== 1 || rows[0]?.book_id !== scope.bookId || document.currency_code !== scope.currencyCode) {
    throw new ErpFinancialsError("scope_mismatch", "Correction requires native posting evidence in this book and currency");
  }
}

async function recordDelivery(
  scope: Scope,
  input: RecordInvoiceDeliveryInput
): Promise<{ readonly deliveryEventId: string; readonly lifecycleEventId: string }> {
  assertFinancialOperationContext(input.operation);
  assertNonEmpty(input.channel, "channel");
  const occurredAt = input.occurredAt ?? scope.now();
  const deliveryEventId = stableId("delivery_event", scope.tenantId, scope.companyId, scope.sourceId, input.idempotencyKey);
  return scope.database.transaction(async (client) => {
    const document = await client.query(
      `select "document_type" from "erp_financials"."subledger_documents"
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3 and "subledger_document_id" = $4 for key share`,
      [scope.tenantId, scope.companyId, scope.sourceId, input.invoiceDocumentId]
    );
    if (document.rows[0]?.document_type !== "invoice") {
      throw new ErpFinancialsError("missing_document", `Invoice ${input.invoiceDocumentId} does not exist in the write source`);
    }
    const lifecycle = await appendFinancialLifecycleEvent(client, lifecycleInput(scope, input.operation, {
      aggregateType: "invoice", aggregateId: input.invoiceDocumentId, eventType: `invoice.delivery_${input.status}`,
      idempotencyKey: `invoice-delivery:${input.idempotencyKey}`,
      payload: { channel: input.channel, deliveryStatus: input.status }
    }));
    const inserted = await client.query(
      `insert into "erp_financials"."subledger_document_delivery_events" (
  "delivery_event_id", "tenant_id", "company_id", "source_id", "subledger_document_id", "delivery_status",
  "channel", "recipient_ref", "lifecycle_event_id", "occurred_at"
) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
on conflict ("tenant_id", "company_id", "source_id", "delivery_event_id") do nothing returning "delivery_event_id"`,
      [deliveryEventId, scope.tenantId, scope.companyId, scope.sourceId, input.invoiceDocumentId, input.status,
        input.channel, input.recipientRef, lifecycle.eventId, occurredAt]
    );
    if (inserted.rows[0] === undefined) {
      const existing = await client.query(
        `select "delivery_status", "channel", "recipient_ref", "lifecycle_event_id" from "erp_financials"."subledger_document_delivery_events"
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3 and "delivery_event_id" = $4`,
        [scope.tenantId, scope.companyId, scope.sourceId, deliveryEventId]
      );
      const row = requiredRow(existing.rows[0], "delivery event");
      if (row.delivery_status !== input.status || row.channel !== input.channel || optionalString(row.recipient_ref) !== input.recipientRef) {
        throw new ErpFinancialsIdempotencyConflictError(input.idempotencyKey);
      }
    }
    await outbox(client, scope, `invoice.delivery_${input.status}`, "invoice", input.invoiceDocumentId,
      `invoice-delivery:${input.idempotencyKey}:outbox`, { channel: input.channel, deliveryEventId });
    return { deliveryEventId, lifecycleEventId: lifecycle.eventId };
  });
}

type NormalizedLine = ReturnType<typeof normalizeCommercialDocumentLine> & { readonly accountId: string } & InvoicePostingComponents;

function normalizedLines(scope: Scope, lines: readonly SubledgerAmountLine[]): readonly NormalizedLine[] {
  if (lines.length === 0) throw new ErpFinancialsError("invalid_input", "revenueLines must contain at least one line");
  return lines.map((line,index)=>{
    const components=normalizeInvoiceComponents(line);
    return {...normalizeCommercialDocumentLine(line,`revenueLines[${String(index)}]`,2),accountId:resolveAccountId(scope,line),
      ...(components.taxAccount ? {taxAccount:{accountId:resolveAccountId(scope,components.taxAccount)}} : {}),
      ...(components.discountAccount ? {discountAccount:{accountId:resolveAccountId(scope,components.discountAccount)}} : {})};
  });
}

async function writeDraftLines(
  client: PostgresQueryClient,
  scope: Scope,
  invoiceDraftId: string,
  lines: readonly NormalizedLine[]
): Promise<void> {
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    await client.query(
      `insert into "erp_financials"."invoice_draft_lines" (
  "invoice_draft_line_id", "tenant_id", "company_id", "book_id", "source_id", "invoice_draft_id", "line_number",
  "account_id", "item_id", "description", "quantity", "unit_amount", "unit_cost", "discount_amount", "tax_code", "tax_amount",
  "service_period_start", "service_period_end", "dimension_refs", "line_amount", "tax_account_id", "discount_account_id"
) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)`,
      [stableId("invoice_draft_line", scope.tenantId, scope.companyId, scope.bookId, invoiceDraftId, String(lineNumber)),
        scope.tenantId, scope.companyId, scope.bookId, scope.sourceId, invoiceDraftId, lineNumber, line.accountId,
        line.itemId, line.description, line.quantity, line.unitAmount, line.unitCost, line.discountAmount, line.taxCode, line.taxAmount,
        line.servicePeriodStart, line.servicePeriodEnd, JSON.stringify(line.dimensionRefs), line.amount,
        line.taxAccount?.accountId, line.discountAccount?.accountId]
    );
  }
}

async function loadDraft(
  client: PostgresQueryClient,
  scope: Scope,
  invoiceDraftId: string
): Promise<InvoiceDraft & { readonly metadata: Readonly<Record<string, JsonValue>> }> {
  const draft = await client.query(
    `select *, "document_date"::text as "document_date", "due_date"::text as "due_date" from "erp_financials"."invoice_drafts" where "tenant_id" = $1 and "company_id" = $2 and "book_id" = $3 and "invoice_draft_id" = $4 and "source_id" = $5 for share`,
    [scope.tenantId, scope.companyId, scope.bookId, invoiceDraftId, scope.sourceId]
  );
  const row = draft.rows[0];
  if (row === undefined) throw new ErpFinancialsError("missing_document", "Invoice draft does not exist in the configured scope");
  const lineResult = await client.query(
    `select "invoice_draft_line_id" as "line_id", *, "service_period_start"::text as "service_period_start", "service_period_end"::text as "service_period_end" from "erp_financials"."invoice_draft_lines"
where "tenant_id" = $1 and "company_id" = $2 and "book_id" = $3 and "invoice_draft_id" = $4 and "source_id" = $5 order by "line_number"`,
    [scope.tenantId, scope.companyId, scope.bookId, invoiceDraftId, scope.sourceId]
  );
  const lines = lineResult.rows.map(lineReadModel);
  const documentNumber = optionalString(row.document_number);
  const memo = optionalString(row.memo);
  const issuedDocumentId = optionalString(row.issued_document_id);
  return {
    invoiceDraftId,
    customerId: string(row.customer_id, "customer_id"),
    receivableAccountId: string(row.receivable_account_id, "receivable_account_id"),
    ...(documentNumber === undefined ? {} : { documentNumber }),
    documentDate: date(row.document_date, "document_date"),
    dueDate: date(row.due_date, "due_date"),
    currencyCode: string(row.currency_code, "currency_code"),
    ...(memo === undefined ? {} : { memo }),
    status: string(row.status, "status") as InvoiceDraftStatus,
    metadata: draftMetadata(row.metadata),
    version: integer(row.version, "version"),
    originalAmount: sumReadLines(lines),
    ...(issuedDocumentId === undefined ? {} : { issuedDocumentId }),
    lines
  };
}

function draftMetadata(value: unknown): Readonly<Record<string, JsonValue>> {
  const metadata = parsedStoredJson(value, "metadata");
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("Stored invoice draft metadata must be an object");
  }
  return metadata as Readonly<Record<string, JsonValue>>;
}

async function lockDraft(client: PostgresQueryClient, scope: Scope, id: string): Promise<Record<string, unknown>> {
  const result = await client.query(
    `select *, "document_date"::text as "document_date", "due_date"::text as "due_date" from "erp_financials"."invoice_drafts" where "tenant_id" = $1 and "company_id" = $2 and "book_id" = $3 and "invoice_draft_id" = $4 and "source_id" = $5 for update`,
    [scope.tenantId, scope.companyId, scope.bookId, id, scope.sourceId]
  );
  if (result.rows[0] === undefined) throw new ErpFinancialsError("missing_document", `Invoice draft ${id} does not exist`);
  return result.rows[0];
}

async function loadDraftByIdempotency(client: PostgresQueryClient, scope: Scope, key: string): Promise<Record<string, unknown>> {
  const result = await client.query(
    `select *, "document_date"::text as "document_date", "due_date"::text as "due_date" from "erp_financials"."invoice_drafts" where "tenant_id" = $1 and "company_id" = $2 and "book_id" = $3 and "idempotency_key" = $4 and "source_id" = $5 for share`,
    [scope.tenantId, scope.companyId, scope.bookId, key, scope.sourceId]
  );
  if (!result.rows[0]) throw new ErpFinancialsIdempotencyConflictError(key);
  return result.rows[0];
}

function assertSameDraft(row: Record<string, unknown>, id: string, input: SaveInvoiceDraftInput, scope: Scope): void {
  if (row.invoice_draft_id !== id || row.customer_id !== input.customerId ||
    row.receivable_account_id !== resolveAccountId(scope, input.receivableAccount) ||
    date(row.document_date, "document_date") !== input.documentDate || date(row.due_date, "due_date") !== input.dueDate ||
    string(row.currency_code, "currency_code") !== (input.currencyCode ?? scope.currencyCode) ||
    optionalString(row.document_number) !== input.documentNumber || optionalString(row.memo) !== input.memo ||
    stableJson(parsedStoredJson(row.metadata, "metadata")) !== stableJson(input.metadata ?? {})) {
    throw new ErpFinancialsIdempotencyConflictError(input.idempotencyKey);
  }
}

async function assertSameDraftLines(
  client: PostgresQueryClient,
  scope: Scope,
  invoiceDraftId: string,
  expected: readonly NormalizedLine[],
  idempotencyKey: string
): Promise<void> {
  const result = await client.query(
    `select *, "service_period_start"::text as "service_period_start", "service_period_end"::text as "service_period_end" from "erp_financials"."invoice_draft_lines"
where "tenant_id" = $1 and "company_id" = $2 and "book_id" = $3 and "invoice_draft_id" = $4 and "source_id" = $5 order by "line_number"`,
    [scope.tenantId, scope.companyId, scope.bookId, invoiceDraftId, scope.sourceId]
  );
  const actual = result.rows.map((row) => normalizeLineForComparison(lineInputFromRow(row)));
  const normalizedExpected = expected.map(normalizeLineForComparison);
  if (stableJson(actual) !== stableJson(normalizedExpected)) {
    throw new ErpFinancialsIdempotencyConflictError(idempotencyKey);
  }
}

function normalizeLineForComparison(line: SubledgerAmountLine): JsonValue {
  return {
    accountId: "accountId" in line ? line.accountId ?? null : null,
    amount: line.amount,
    description: line.description ?? null,
    dimensionRefs: line.dimensionRefs ?? [],
    discountAmount: line.discountAmount ?? "0.00",
    itemId: line.itemId ?? null,
    quantity: line.quantity ?? "1",
    servicePeriodEnd: line.servicePeriodEnd ?? null,
    servicePeriodStart: line.servicePeriodStart ?? null,
    taxAmount: line.taxAmount ?? "0.00",
    taxCode: line.taxCode ?? null,
    unitAmount: line.unitAmount ?? line.amount,
    unitCost: line.unitCost ?? null,
    ...(line.taxAccount === undefined ? {} : {taxAccount:line.taxAccount}),
    ...(line.discountAccount === undefined ? {} : {discountAccount:line.discountAccount})
  };
}

function assertMutableDraft(row: Record<string, unknown>, expectedVersion: number): void {
  if (row.status !== "draft") throw new ErpFinancialsError("terminal_state_conflict", `Invoice draft is already ${String(row.status)}`);
  if (integer(row.version, "version") !== expectedVersion) throw concurrencyError(string(row.invoice_draft_id, "invoice_draft_id"), expectedVersion);
}

async function assertDraftReferences(
  client: PostgresQueryClient,
  scope: Scope,
  customerId: string,
  receivableAccountId: string,
  lines: readonly NormalizedLine[]
): Promise<void> {
  const scopeResult = await client.query(
    `select book."base_currency_code", source."book_source_id"
from "erp_financials"."reporting_books" book
join "erp_financials"."reporting_book_sources" source
  on source."tenant_id" = book."tenant_id" and source."company_id" = book."company_id" and source."book_id" = book."book_id"
where book."tenant_id" = $1 and book."company_id" = $2 and book."book_id" = $3 and source."source_id" = $4 and book."status" = 'active'`,
    [scope.tenantId, scope.companyId, scope.bookId, scope.sourceId]
  );
  const scopeRow = scopeResult.rows[0];
  if (scopeRow === undefined) throw new ErpFinancialsError("scope_mismatch", "The write source is not bound to the active reporting book");
  if (scopeRow.base_currency_code !== scope.currencyCode) throw new ErpFinancialsError("currency_not_supported", "SDK currency does not match reporting book base currency");
  const party = await client.query(
    `select "party_id" from "erp_financials"."parties" where "tenant_id" = $1 and "source_id" = $2 and "party_id" = $3 and "party_type" = 'customer' and "active" for share`,
    [scope.tenantId, scope.sourceId, customerId]
  );
  if (party.rows[0] === undefined) throw new ErpFinancialsError("missing_party", `Customer ${customerId} is missing or inactive`);
  const componentRequirements=lines.flatMap(line=>invoiceComponentRequirements(line,scope.invoiceAccountPolicy,ref=>resolveAccountId(scope,ref)));
  for(const line of lines) assertInvoiceComponentPolicy(line,scope.invoiceAccountPolicy,receivableAccountId,ref=>resolveAccountId(scope,ref));
  const accountIds = [...new Set([receivableAccountId, ...lines.map((line) => line.accountId),...componentRequirements.map(row=>row.accountId)])].sort();
  await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`account-hierarchy:${scope.tenantId}:${scope.sourceId}`]);
  const accounts = await client.query(
    `select "account_id", "classification" from "erp_financials"."accounts" where "tenant_id" = $1 and "source_id" = $2 and "account_id" = any($3::text[]) and "active" order by "account_id" for share`,
    [scope.tenantId, scope.sourceId, accountIds]
  );
  if (accounts.rows.length !== accountIds.length) throw new ErpFinancialsError("missing_account", "Invoice references a missing or inactive account");
  for(const requirement of componentRequirements){
    const account=accounts.rows.find(row=>row.account_id===requirement.accountId);
    if(!account || !requirement.classifications.includes(account.classification as AccountClassification))throw new ErpFinancialsError("invalid_input","Invoice component account classification violates the configured policy");
  }
  const policy = scope.invoiceAccountPolicy;
  if (policy) {
    const byId = new Map(accounts.rows.map(row => [row.account_id, row.classification]));
    if (!policy.receivableClassifications.includes(byId.get(receivableAccountId) as AccountClassification)
        || lines.some(line => !policy.revenueClassifications.includes(byId.get(line.accountId) as AccountClassification))) {
      throw new ErpFinancialsError("invalid_input", "Invoice account classification violates the configured policy");
    }
  }
}

async function loadDraftLineInputs(client: PostgresQueryClient, scope: Scope, draftId: string): Promise<readonly SubledgerAmountLine[]> {
  const result = await client.query(
    `select *, "service_period_start"::text as "service_period_start", "service_period_end"::text as "service_period_end" from "erp_financials"."invoice_draft_lines" where "tenant_id" = $1 and "company_id" = $2 and "book_id" = $3 and "invoice_draft_id" = $4 and "source_id" = $5 order by "line_number"`,
    [scope.tenantId, scope.companyId, scope.bookId, draftId, scope.sourceId]
  );
  return result.rows.map(lineInputFromRow);
}

async function loadPostedInvoiceLineInputs(client: PostgresQueryClient, scope: Scope, documentId: string): Promise<readonly SubledgerAmountLine[]> {
  const result = await client.query(
    `select *, "service_period_start"::text as "service_period_start", "service_period_end"::text as "service_period_end" from "erp_financials"."subledger_document_lines" where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3 and "subledger_document_id" = $4 order by "line_number"`,
    [scope.tenantId, scope.companyId, scope.sourceId, documentId]
  );
  if (result.rows.length === 0) throw new ErpFinancialsError("unsupported_operation", "Invoice lacks SDK line provenance and cannot be safely voided automatically");
  return result.rows.map(lineInputFromRow);
}

function lineInputFromRow(row: Readonly<Record<string, unknown>>): SubledgerAmountLine & { readonly accountId: string } {
  const itemId = optionalString(row.item_id);
  const description = optionalString(row.description);
  const taxCode = optionalString(row.tax_code);
  const start = optionalDate(row.service_period_start, "service_period_start");
  const end = optionalDate(row.service_period_end, "service_period_end");
  const unitCost = row.unit_cost === null || row.unit_cost === undefined ? undefined : decimal(row.unit_cost, "unit_cost");
  const dimensionRefs: unknown = typeof row.dimension_refs === "string" ? JSON.parse(row.dimension_refs) as unknown : row.dimension_refs;
  if (!Array.isArray(dimensionRefs)) throw new Error("Stored dimension_refs must be an array");
  return {
    accountId: string(row.account_id, "account_id"), amount: money(row.line_amount, "line_amount"),
    ...(optionalString(row.tax_account_id) === undefined ? {} : {taxAccount:{accountId:string(row.tax_account_id,"tax_account_id")}}),
    ...(optionalString(row.discount_account_id) === undefined ? {} : {discountAccount:{accountId:string(row.discount_account_id,"discount_account_id")}}),
    ...(itemId === undefined ? {} : { itemId }), ...(description === undefined ? {} : { description }),
    quantity: decimal(row.quantity, "quantity"), unitAmount: money(row.unit_amount, "unit_amount"),
    ...(unitCost === undefined ? {} : { unitCost }),
    discountAmount: money(row.discount_amount, "discount_amount"), ...(taxCode === undefined ? {} : { taxCode }),
    taxAmount: money(row.tax_amount, "tax_amount"), ...(start === undefined ? {} : { servicePeriodStart: start }),
    ...(end === undefined ? {} : { servicePeriodEnd: end }), dimensionRefs
  };
}

async function loadInvoiceReceivableAccount(
  client: PostgresQueryClient,
  scope: Scope,
  invoice: Record<string, unknown>
): Promise<string> {
  const result = await client.query(
    `select "account_id", "debit_amount"::text, "credit_amount"::text, "currency_code"
from "erp_financials"."ledger_postings"
where "tenant_id" = $1 and "source_id" = $2 and "transaction_id" = $3
  and "accounting_basis" = 'accrual' and "debit_amount" > 0
  and "account_id" not in (select discount_account_id from erp_financials.subledger_document_lines
    where tenant_id=$1 and source_id=$2 and company_id=$4 and subledger_document_id=$5 and discount_account_id is not null)
limit 2 for key share`,
    [scope.tenantId, scope.sourceId, invoice.transaction_id,scope.companyId,invoice.subledger_document_id]
  );
  // Native issuance creates one accrual receivable debit for the full amount.
  // Receipt applications and their cash-basis reversals share this transaction
  // identity: their debit postings cannot identify the invoice's receivable.
  const posting = result.rows[0];
  if (result.rows.length !== 1 || posting === undefined ||
      posting.currency_code !== scope.currencyCode || posting.currency_code !== invoice.currency_code ||
      money(posting.debit_amount, "debit_amount") !== money(invoice.original_amount, "original_amount") ||
      money(posting.credit_amount, "credit_amount") !== "0.00") {
    throw new ErpFinancialsError("unsupported_operation", "Invoice lacks a single complete accrual receivable posting; reconcile its accounting provenance before cancellation");
  }
  return string(posting.account_id, "account_id");
}

async function invoiceTransactionId(client: PostgresQueryClient, scope: Scope, documentId: string): Promise<string> {
  const result = await client.query(
    `select "transaction_id" from "erp_financials"."subledger_documents" where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3 and "subledger_document_id" = $4`,
    [scope.tenantId, scope.companyId, scope.sourceId, documentId]
  );
  return string(requiredRow(result.rows[0], "issued invoice").transaction_id, "transaction_id");
}

function invoiceVoidResult(row: Readonly<Record<string, unknown>>, status: VoidIssuedInvoiceResult["status"]): VoidIssuedInvoiceResult {
  return {
    status,
    invoiceDocumentId: string(row.invoice_document_id, "invoice_document_id"),
    creditDocumentId: string(row.credit_document_id, "credit_document_id"),
    applicationId: string(row.application_id, "application_id"),
    invoiceVoidId: string(row.invoice_void_id, "invoice_void_id")
  };
}

function lineReadModel(row: Readonly<Record<string, unknown>>): CommercialDocumentLineReadModel {
  const input = lineInputFromRow(row);
  return {
    lineId: string(row.line_id, "line_id"), lineNumber: integer(row.line_number, "line_number"),
    accountId: input.accountId,
    ...(input.taxAccount === undefined ? {} : {taxAccountId:string(input.taxAccount.accountId,"tax_account_id")}),
    ...(input.discountAccount === undefined ? {} : {discountAccountId:string(input.discountAccount.accountId,"discount_account_id")}), ...(input.itemId === undefined ? {} : { itemId: input.itemId }),
    ...(input.description === undefined ? {} : { description: input.description }), quantity: input.quantity ?? "1",
    unitAmount: input.unitAmount ?? input.amount, discountAmount: input.discountAmount ?? "0.00",
    ...(input.unitCost === undefined ? {} : { unitCost: input.unitCost }),
    ...(input.taxCode === undefined ? {} : { taxCode: input.taxCode }), taxAmount: input.taxAmount ?? "0.00",
    ...(input.servicePeriodStart === undefined ? {} : { servicePeriodStart: input.servicePeriodStart }),
    ...(input.servicePeriodEnd === undefined ? {} : { servicePeriodEnd: input.servicePeriodEnd }),
    dimensionRefs: input.dimensionRefs ?? [], amount: input.amount
  };
}

function resolveAccountId(scope: Pick<Scope, "tenantId" | "sourceId">, reference: ErpFinancialsAccountReference): string {
  if (reference.accountId !== undefined) return reference.accountId;
  const accountKey: unknown = reference.accountKey;
  if (typeof accountKey !== "string" || accountKey.trim().length === 0) {
    throw new ErpFinancialsError("invalid_input", "Account reference must contain exactly one accountId or accountKey");
  }
  return `account_${createHash("sha256")
    .update([scope.tenantId, scope.sourceId, "account", accountKey].join("\u0000"))
    .digest("hex")
    .slice(0, 16)}`;
}

function validateDraftInput(scope: Scope, input: Omit<SaveInvoiceDraftInput, "idempotencyKey"> & { readonly idempotencyKey?: string }): void {
  if (input.idempotencyKey !== undefined) assertNonEmpty(input.idempotencyKey, "idempotencyKey");
  assertNonEmpty(input.customerId, "customerId");
  assertDate(input.documentDate, "documentDate");
  assertDate(input.dueDate, "dueDate");
  if (input.currencyCode !== undefined && input.currencyCode !== scope.currencyCode) {
    throw new ErpFinancialsError("currency_not_supported", `Currency ${input.currencyCode} is outside this single-currency book`, {
      details: { baseCurrencyCode: scope.currencyCode, currencyCode: input.currencyCode }
    });
  }
}

function lifecycleInput(
  scope: Scope,
  operation: FinancialOperationContext,
  input: { readonly aggregateType: string; readonly aggregateId: string; readonly eventType: string; readonly idempotencyKey: string; readonly payload: JsonValue }
) {
  return {
    tenantId: scope.tenantId, companyId: scope.companyId, sourceId: scope.sourceId,
    operation, recordedAt: scope.now(), ...input
  };
}

async function outbox(
  client: PostgresQueryClient,
  scope: Scope,
  eventType: string,
  aggregateType: string,
  aggregateId: string,
  idempotencyKey: string,
  payload: JsonValue
): Promise<void> {
  await appendFinancialOutboxEvent(client, {
    tenantId: scope.tenantId, companyId: scope.companyId, bookId: scope.bookId, sourceId: scope.sourceId,
    eventType, aggregateType, aggregateId, idempotencyKey, payload, availableAt: scope.now()
  });
}

function concurrencyError(id: string, version: number): ErpFinancialsError {
  return new ErpFinancialsError("optimistic_concurrency_conflict", `Invoice ${id} is no longer at version ${String(version)}`, {
    retryable: true, details: { documentId: id, expectedVersion: version }
  });
}

function assertVersion(value: number): void {
  if (!Number.isInteger(value) || value < 1) throw new ErpFinancialsError("invalid_input", "expectedVersion must be a positive integer");
}

function assertDate(value: string, field: string): asserts value is IsoDate {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ErpFinancialsError("invalid_input", `${field} must be a valid ISO date`);
  }
}

function parsedStoredJson(value: unknown, field: string): JsonValue {
  const result = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (result === undefined) throw new Error(`Stored ${field} is missing`);
  return result as JsonValue;
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) throw new ErpFinancialsError("invalid_input", `${field} must not be empty`);
}

function assertCurrency(value: string, field: string): void {
  if (!/^[A-Z]{3}$/u.test(value)) {
    throw new ErpFinancialsError("invalid_input", `${field} must be a three-letter uppercase ISO currency code`);
  }
}

function assertBoundedJson(value: JsonValue, field: string): void {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 4096) throw new ErpFinancialsError("invalid_input", `${field} exceeds 4096 bytes`);
}

function stableId(prefix: string, ...parts: readonly string[]): string {
  return stableIdWithLength(prefix, 24, ...parts);
}

function stableIdWithLength(prefix: string, length: number, ...parts: readonly string[]): string {
  return `${prefix}_${createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, length)}`;
}

function requiredRow(row: Record<string, unknown> | undefined, field: string): Record<string, unknown> {
  if (row === undefined) throw new Error(`Missing ${field} row`);
  return row;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Stored ${field} must be a non-empty string`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("Stored optional field must be a string");
  return value;
}

function date(value: unknown, field: string): IsoDate {
  const result = value instanceof Date ? value.toISOString().slice(0, 10) : string(value, field).slice(0, 10);
  assertDate(result, field);
  return result;
}

function optionalDate(value: unknown, field: string): IsoDate | undefined {
  return value === null || value === undefined ? undefined : date(value, field);
}

function decimal(value: unknown, field: string): DecimalString {
  const result = typeof value === "number" ? String(value) : string(value, field);
  if (!/^-?\d+(?:\.\d+)?$/u.test(result)) throw new Error(`Stored ${field} must be decimal`);
  return result;
}

function money(value: unknown, field: string): DecimalString {
  const result = decimal(value, field);
  const negative = result.startsWith("-");
  const raw = negative ? result.slice(1) : result;
  const [whole = "0", fraction = ""] = raw.split(".");
  return `${negative ? "-" : ""}${whole}.${fraction.padEnd(2, "0").slice(0, 2)}`;
}

function integer(value: unknown, field: string): number {
  const result = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isInteger(result)) throw new Error(`Stored ${field} must be an integer`);
  return result;
}

function sumLines(lines: readonly NormalizedLine[]): DecimalString {
  return sumMoney(lines.map((line) => line.amount));
}

function sumReadLines(lines: readonly CommercialDocumentLineReadModel[]): DecimalString {
  return sumMoney(lines.map((line) => line.amount));
}

function sumMoney(values: readonly DecimalString[]): DecimalString {
  const total = values.reduce((sum, value) => {
    const [whole = "0", fraction = ""] = value.split(".");
    return sum + BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2));
  }, 0n);
  return `${(total / 100n).toString()}.${(total % 100n).toString().padStart(2, "0")}`;
}

function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}
