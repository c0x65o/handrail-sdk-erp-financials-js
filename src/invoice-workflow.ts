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
  assertIndependentApproval
} from "./financial-lifecycle.js";
import { ErpFinancialsError } from "./sdk-errors.js";

import type { AccountingBasis, DecimalString, IsoCurrencyCode, IsoDate, IsoDateTime, JsonValue } from "./canonical-model.js";
import type {
  ErpFinancialsAccountReference,
  ErpFinancialsTransactionRunner,
  SubledgerAmountLine
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
  createDraft(input: SaveInvoiceDraftInput): Promise<InvoiceDraft>;
  updateDraft(input: UpdateInvoiceDraftInput): Promise<InvoiceDraft>;
  voidDraft(input: { readonly operation: FinancialOperationContext; readonly invoiceDraftId: string; readonly expectedVersion: number }): Promise<InvoiceDraft>;
  issue(input: IssueInvoiceDraftInput): Promise<IssueInvoiceDraftResult>;
  voidIssued(input: VoidIssuedInvoiceInput): Promise<VoidIssuedInvoiceResult>;
  recordDelivery(input: RecordInvoiceDeliveryInput): Promise<{ readonly deliveryEventId: string; readonly lifecycleEventId: string }>;
};

type Scope = {
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
  const scope: Scope = {
    ...input,
    accountingBasis: input.accountingBasis ?? "accrual",
    postingPolicy: input.postingPolicy ?? "enforce_fiscal_periods",
    now: input.now ?? (() => new Date().toISOString())
  };
  for (const [field, value] of Object.entries({ tenantId: input.tenantId, companyId: input.companyId, bookId: input.bookId, sourceId: input.sourceId, currencyCode: input.currencyCode })) {
    assertNonEmpty(value, field);
  }
  assertCurrency(input.currencyCode, "currencyCode");
  return {
    createDraft: (command) => createDraft(scope, command),
    updateDraft: (command) => updateDraft(scope, command),
    voidDraft: (command) => voidDraft(scope, command),
    issue: (command) => issueDraft(scope, command),
    voidIssued: (command) => voidIssuedInvoice(scope, command),
    recordDelivery: (command) => recordDelivery(scope, command)
  };
}

async function createDraft(scope: Scope, input: SaveInvoiceDraftInput): Promise<InvoiceDraft> {
  assertFinancialOperationContext(input.operation);
  validateDraftInput(scope, input);
  const invoiceDraftId = stableId("invoice_draft", scope.tenantId, scope.companyId, scope.bookId, input.idempotencyKey);
  const lines = normalizedLines(scope, input.revenueLines);
  const timestamp = scope.now();
  const metadata = input.metadata ?? {};
  assertNoCredentialKeys(metadata);
  assertBoundedJson(metadata, "metadata");
  return scope.database.transaction(async (client) => {
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
    let row = result.rows[0];
    if (row === undefined) {
      const existing = await loadDraftByIdempotency(client, scope, input.idempotencyKey);
      assertSameDraft(existing, invoiceDraftId, input, scope);
      await assertSameDraftLines(client, scope, invoiceDraftId, lines, input.idempotencyKey);
      row = existing;
    } else {
      await writeDraftLines(client, scope, invoiceDraftId, lines);
    }
    const lifecycle = await appendFinancialLifecycleEvent(client, lifecycleInput(scope, input.operation, {
      aggregateType: "invoice_draft",
      aggregateId: invoiceDraftId,
      eventType: "invoice.draft_created",
      idempotencyKey: `invoice-draft:${input.idempotencyKey}:created`,
      payload: { invoiceDraftId, lineCount: lines.length, originalAmount: sumLines(lines) }
    }));
    await outbox(client, scope, "invoice.draft_created", "invoice_draft", invoiceDraftId,
      `invoice-draft:${input.idempotencyKey}:outbox:created`, { invoiceDraftId, version: integer(row.version, "version") });
    void lifecycle;
    return loadDraft(client, scope, invoiceDraftId);
  });
}

async function updateDraft(scope: Scope, input: UpdateInvoiceDraftInput): Promise<InvoiceDraft> {
  assertFinancialOperationContext(input.operation);
  validateDraftInput(scope, input);
  assertVersion(input.expectedVersion);
  const lines = normalizedLines(scope, input.revenueLines);
  const metadata = input.metadata ?? {};
  assertNoCredentialKeys(metadata);
  assertBoundedJson(metadata, "metadata");
  return scope.database.transaction(async (client) => {
    const current = await lockDraft(client, scope, input.invoiceDraftId);
    assertMutableDraft(current, input.expectedVersion);
    await assertDraftReferences(client, scope, input.customerId, resolveAccountId(scope, input.receivableAccount), lines);
    const result = await client.query(
      `update "erp_financials"."invoice_drafts"
set "customer_id" = $5, "receivable_account_id" = $6, "document_number" = $7, "document_date" = $8,
    "due_date" = $9, "currency_code" = $10, "memo" = $11, "metadata" = $12,
    "version" = "version" + 1, "updated_at" = $13
where "tenant_id" = $1 and "company_id" = $2 and "book_id" = $3 and "invoice_draft_id" = $4
  and "status" = 'draft' and "version" = $14
returning *`,
      [scope.tenantId, scope.companyId, scope.bookId, input.invoiceDraftId, input.customerId,
        resolveAccountId(scope, input.receivableAccount), input.documentNumber, input.documentDate, input.dueDate,
        input.currencyCode ?? scope.currencyCode, input.memo, JSON.stringify(metadata), scope.now(), input.expectedVersion]
    );
    if (result.rows[0] === undefined) throw concurrencyError(input.invoiceDraftId, input.expectedVersion);
    await client.query(
      `delete from "erp_financials"."invoice_draft_lines"
where "tenant_id" = $1 and "company_id" = $2 and "book_id" = $3 and "invoice_draft_id" = $4`,
      [scope.tenantId, scope.companyId, scope.bookId, input.invoiceDraftId]
    );
    await writeDraftLines(client, scope, input.invoiceDraftId, lines);
    const lifecycle = await appendFinancialLifecycleEvent(client, lifecycleInput(scope, input.operation, {
      aggregateType: "invoice_draft",
      aggregateId: input.invoiceDraftId,
      eventType: "invoice.draft_updated",
      idempotencyKey: `invoice-draft:${input.invoiceDraftId}:updated:v${String(input.expectedVersion)}`,
      payload: { fromVersion: input.expectedVersion, toVersion: input.expectedVersion + 1 }
    }));
    await outbox(client, scope, "invoice.draft_updated", "invoice_draft", input.invoiceDraftId,
      `invoice-draft:${input.invoiceDraftId}:outbox:updated:v${String(input.expectedVersion)}`,
      { invoiceDraftId: input.invoiceDraftId, version: input.expectedVersion + 1 });
    void lifecycle;
    return loadDraft(client, scope, input.invoiceDraftId);
  });
}

async function voidDraft(
  scope: Scope,
  input: { readonly operation: FinancialOperationContext; readonly invoiceDraftId: string; readonly expectedVersion: number }
): Promise<InvoiceDraft> {
  assertIndependentApproval(input.operation);
  assertVersion(input.expectedVersion);
  return scope.database.transaction(async (client) => {
    const current = await lockDraft(client, scope, input.invoiceDraftId);
    if (current.status === "voided") return loadDraft(client, scope, input.invoiceDraftId);
    assertMutableDraft(current, input.expectedVersion);
    const updated = await client.query(
      `update "erp_financials"."invoice_drafts" set "status" = 'voided', "version" = "version" + 1, "updated_at" = $5
where "tenant_id" = $1 and "company_id" = $2 and "book_id" = $3 and "invoice_draft_id" = $4
  and "status" = 'draft' and "version" = $6 returning *`,
      [scope.tenantId, scope.companyId, scope.bookId, input.invoiceDraftId, scope.now(), input.expectedVersion]
    );
    if (updated.rows[0] === undefined) throw concurrencyError(input.invoiceDraftId, input.expectedVersion);
    const lifecycle = await appendFinancialLifecycleEvent(client, lifecycleInput(scope, input.operation, {
      aggregateType: "invoice_draft", aggregateId: input.invoiceDraftId, eventType: "invoice.draft_voided",
      idempotencyKey: `invoice-draft:${input.invoiceDraftId}:voided:v${String(input.expectedVersion)}`,
      payload: { fromVersion: input.expectedVersion, toVersion: input.expectedVersion + 1 }
    }));
    await outbox(client, scope, "invoice.draft_voided", "invoice_draft", input.invoiceDraftId,
      `invoice-draft:${input.invoiceDraftId}:outbox:voided:v${String(input.expectedVersion)}`,
      { invoiceDraftId: input.invoiceDraftId, version: input.expectedVersion + 1 });
    void lifecycle;
    return loadDraft(client, scope, input.invoiceDraftId);
  });
}

async function issueDraft(scope: Scope, input: IssueInvoiceDraftInput): Promise<IssueInvoiceDraftResult> {
  assertFinancialOperationContext(input.operation);
  assertVersion(input.expectedVersion);
  assertNonEmpty(input.idempotencyKey, "idempotencyKey");
  return scope.database.transaction(async (client) => {
    const current = await lockDraft(client, scope, input.invoiceDraftId);
    if (current.status === "issued") {
      if (current.issue_idempotency_key !== input.idempotencyKey) throw new ErpFinancialsIdempotencyConflictError(input.idempotencyKey);
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
  and "status" = 'draft' and "version" = $8 returning "version"`,
      [scope.tenantId, scope.companyId, scope.bookId, input.invoiceDraftId, input.idempotencyKey,
        result.documentId, scope.now(), input.expectedVersion]
    );
    if (updated.rows[0] === undefined) throw concurrencyError(input.invoiceDraftId, input.expectedVersion);
    const lifecycle = await appendFinancialLifecycleEvent(client, lifecycleInput(scope, input.operation, {
      aggregateType: "invoice_draft", aggregateId: input.invoiceDraftId, eventType: "invoice.issued",
      idempotencyKey: `invoice-draft:${input.invoiceDraftId}:issued:${input.idempotencyKey}`,
      payload: { invoiceDocumentId: result.documentId, transactionId: result.journal.transactionId }
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

async function voidIssuedInvoice(scope: Scope, input: VoidIssuedInvoiceInput): Promise<VoidIssuedInvoiceResult> {
  assertIndependentApproval(input.operation);
  assertVersion(input.expectedVersion);
  assertDate(input.date, "date");
  return scope.database.transaction(async (client) => {
    const existing = await client.query(
      `select * from "erp_financials"."invoice_voids" where "tenant_id" = $1 and "company_id" = $2 and "book_id" = $3 and "idempotency_key" = $4 for key share`,
      [scope.tenantId, scope.companyId, scope.bookId, input.idempotencyKey]
    );
    if (existing.rows[0] !== undefined) return invoiceVoidResult(existing.rows[0], "already_voided");
    const invoiceResult = await client.query(
      `select * from "erp_financials"."subledger_documents"
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3 and "subledger_document_id" = $4
for update`,
      [scope.tenantId, scope.companyId, scope.sourceId, input.invoiceDocumentId]
    );
    const invoice = invoiceResult.rows[0];
    if (invoice === undefined || invoice.document_type !== "invoice") {
      throw new ErpFinancialsError("missing_document", `Invoice ${input.invoiceDocumentId} does not exist in the write source`);
    }
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
    const receivable = await loadInvoiceReceivableAccount(client, scope, invoice);
    const lines = await loadPostedInvoiceLineInputs(client, scope, input.invoiceDocumentId);
    const nested = { transaction: async <Result>(work: (nestedClient: PostgresQueryClient) => Promise<Result>) => work(client) };
    const service = createErpFinancials({
      database: nested, tenantId: scope.tenantId, companyId: scope.companyId, sourceId: scope.sourceId,
      bookId: scope.bookId, currencyCode: scope.currencyCode, currencyPolicy: "single_currency",
      accountingBasis: scope.accountingBasis, postingPolicy: scope.postingPolicy, now: scope.now
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
      payload: { applicationId: application.applicationId, creditDocumentId: credit.documentId }
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
  });
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

type NormalizedLine = ReturnType<typeof normalizeCommercialDocumentLine> & { readonly accountId: string };

function normalizedLines(scope: Scope, lines: readonly SubledgerAmountLine[]): readonly NormalizedLine[] {
  if (lines.length === 0) throw new ErpFinancialsError("invalid_input", "revenueLines must contain at least one line");
  return lines.map((line, index) => ({
    // Invoice drafts retain their existing two-place storage contract.
    ...normalizeCommercialDocumentLine(line, `revenueLines[${String(index)}]`, 2),
    accountId: resolveAccountId(scope, line)
  }));
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
  "service_period_start", "service_period_end", "dimension_refs", "line_amount"
) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
      [stableId("invoice_draft_line", scope.tenantId, scope.companyId, scope.bookId, invoiceDraftId, String(lineNumber)),
        scope.tenantId, scope.companyId, scope.bookId, scope.sourceId, invoiceDraftId, lineNumber, line.accountId,
        line.itemId, line.description, line.quantity, line.unitAmount, line.unitCost, line.discountAmount, line.taxCode, line.taxAmount,
        line.servicePeriodStart, line.servicePeriodEnd, JSON.stringify(line.dimensionRefs), line.amount]
    );
  }
}

async function loadDraft(
  client: PostgresQueryClient,
  scope: Scope,
  invoiceDraftId: string
): Promise<InvoiceDraft> {
  const draft = await client.query(
    `select * from "erp_financials"."invoice_drafts" where "tenant_id" = $1 and "company_id" = $2 and "book_id" = $3 and "invoice_draft_id" = $4`,
    [scope.tenantId, scope.companyId, scope.bookId, invoiceDraftId]
  );
  const row = requiredRow(draft.rows[0], "invoice draft");
  const lineResult = await client.query(
    `select "invoice_draft_line_id" as "line_id", * from "erp_financials"."invoice_draft_lines"
where "tenant_id" = $1 and "company_id" = $2 and "book_id" = $3 and "invoice_draft_id" = $4 order by "line_number"`,
    [scope.tenantId, scope.companyId, scope.bookId, invoiceDraftId]
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
    version: integer(row.version, "version"),
    originalAmount: sumReadLines(lines),
    ...(issuedDocumentId === undefined ? {} : { issuedDocumentId }),
    lines
  };
}

async function lockDraft(client: PostgresQueryClient, scope: Scope, id: string): Promise<Record<string, unknown>> {
  const result = await client.query(
    `select * from "erp_financials"."invoice_drafts" where "tenant_id" = $1 and "company_id" = $2 and "book_id" = $3 and "invoice_draft_id" = $4 for update`,
    [scope.tenantId, scope.companyId, scope.bookId, id]
  );
  if (result.rows[0] === undefined) throw new ErpFinancialsError("missing_document", `Invoice draft ${id} does not exist`);
  return result.rows[0];
}

async function loadDraftByIdempotency(client: PostgresQueryClient, scope: Scope, key: string): Promise<Record<string, unknown>> {
  const result = await client.query(
    `select * from "erp_financials"."invoice_drafts" where "tenant_id" = $1 and "company_id" = $2 and "book_id" = $3 and "idempotency_key" = $4 for key share`,
    [scope.tenantId, scope.companyId, scope.bookId, key]
  );
  return requiredRow(result.rows[0], "invoice draft idempotency");
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
    `select * from "erp_financials"."invoice_draft_lines"
where "tenant_id" = $1 and "company_id" = $2 and "book_id" = $3 and "invoice_draft_id" = $4 order by "line_number"`,
    [scope.tenantId, scope.companyId, scope.bookId, invoiceDraftId]
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
    unitCost: line.unitCost ?? null
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
    `select "party_id" from "erp_financials"."parties" where "tenant_id" = $1 and "source_id" = $2 and "party_id" = $3 and "party_type" = 'customer' and "active" for key share`,
    [scope.tenantId, scope.sourceId, customerId]
  );
  if (party.rows[0] === undefined) throw new ErpFinancialsError("missing_party", `Customer ${customerId} is missing or inactive`);
  const accountIds = [...new Set([receivableAccountId, ...lines.map((line) => line.accountId)])];
  const accounts = await client.query(
    `select "account_id" from "erp_financials"."accounts" where "tenant_id" = $1 and "source_id" = $2 and "account_id" = any($3::text[]) and "active" for key share`,
    [scope.tenantId, scope.sourceId, accountIds]
  );
  if (accounts.rows.length !== accountIds.length) throw new ErpFinancialsError("missing_account", "Invoice references a missing or inactive account");
}

async function loadDraftLineInputs(client: PostgresQueryClient, scope: Scope, draftId: string): Promise<readonly SubledgerAmountLine[]> {
  const result = await client.query(
    `select * from "erp_financials"."invoice_draft_lines" where "tenant_id" = $1 and "company_id" = $2 and "book_id" = $3 and "invoice_draft_id" = $4 order by "line_number"`,
    [scope.tenantId, scope.companyId, scope.bookId, draftId]
  );
  return result.rows.map(lineInputFromRow);
}

async function loadPostedInvoiceLineInputs(client: PostgresQueryClient, scope: Scope, documentId: string): Promise<readonly SubledgerAmountLine[]> {
  const result = await client.query(
    `select * from "erp_financials"."subledger_document_lines" where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3 and "subledger_document_id" = $4 order by "line_number"`,
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
    `select "account_id" from "erp_financials"."ledger_postings"
where "tenant_id" = $1 and "source_id" = $2 and "transaction_id" = $3 and "debit_amount" > 0
order by "debit_amount" desc, "posting_id" limit 1`,
    [scope.tenantId, scope.sourceId, invoice.transaction_id]
  );
  return string(requiredRow(result.rows[0], "invoice receivable posting").account_id, "account_id");
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
    accountId: input.accountId, ...(input.itemId === undefined ? {} : { itemId: input.itemId }),
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
  if (input.dueDate < input.documentDate) throw new ErpFinancialsError("invalid_input", "dueDate must be on or after documentDate");
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
