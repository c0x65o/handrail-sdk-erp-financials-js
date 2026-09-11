import { createHash } from "node:crypto";
import { planQuickBooksCommercialDetail, QuickBooksCommercialDetailError, type QuickBooksCommercialDetailPlan, type QuickBooksCommercialReferences } from "./quickbooks-commercial-detail.js";

import type { JsonValue } from "./canonical-model.js";
import type { NormalizedQuickBooksLedgerTransaction, NormalizedQuickBooksResourceSet } from "./normalized-accounting-contracts.js";
import type { PostgresQueryClient } from "./postgres-storage.js";
import type { HandrailQuickBooksSdkResourceSet, CanonicalAccountingFactSet } from "./source-adapters.js";

type ImportedDocumentType =
  | "invoice"
  | "customer_payment"
  | "credit_memo"
  | "refund"
  | "vendor_bill"
  | "bill_payment"
  | "deposit"
  | "transfer"
  | "sales_receipt"
  | "purchase"
  | "vendor_credit";

type ImportedApplicationType =
  | "customer_payment_to_invoice"
  | "bill_payment_to_bill"
  | "credit_to_invoice"
  | "vendor_credit_to_bill";

export type QuickBooksSubledgerImportResult = {
  readonly documents: number;
  readonly documentLines: number;
  readonly applications: number;
  readonly skippedTransactions: number;
  readonly skippedDocumentLines: number;
  readonly skippedApplications: number;
  readonly voidedDocuments: number;
  readonly removedLedgerPostings: number;
  readonly unresolvedApplications: readonly {
    readonly sourceTransactionId: string;
    readonly targetSourceTransactionId: string;
    readonly sourceLineId: string;
    readonly reason: "missing_target_document" | "missing_positive_amount";
  }[];
};

export type PersistQuickBooksSubledgerResourcesInput = {
  readonly companyId: string;
  readonly importedAt: string;
  readonly facts: CanonicalAccountingFactSet;
  readonly resources: HandrailQuickBooksSdkResourceSet | NormalizedQuickBooksResourceSet;
  /** Treat the supplied operational documents as the complete provider snapshot. */
  readonly replaceMissingDocuments?: boolean;
};

export type QuickBooksSubledgerProjectionDiagnostic = {
  readonly sourceTransactionType: string;
  readonly sourceTransactionId: string;
  readonly missingBalancedJournal: boolean;
  readonly totalAmountState: "missing" | "invalid" | "zero" | "positive";
  readonly totalAmount?: string;
  readonly openAmount?: string;
  readonly unappliedAmount?: string;
  readonly projectionKind:
    | "canonical_document"
    | "customer_credit_application"
    | "customer_deposit_application"
    | "vendor_credit_application"
    | "unclassified_zero_total";
  readonly rejectionReasons: readonly string[];
  readonly lineCount: number;
  readonly linkedTransactionCount: number;
  readonly linkedTransactionTypes: readonly { readonly type: string; readonly count: number }[];
  readonly nonZeroLineCount: number;
  readonly unlinkedNonZeroLineCount: number;
  readonly multiLinkedLineCount: number;
  readonly missingLinkedAmountCount: number;
  readonly billLinkedAmountTotal: string;
  readonly vendorCreditLinkedAmountTotal: string;
  readonly invoiceLinkedAmountTotal: string;
  readonly creditMemoLinkedAmountTotal: string;
  readonly otherLinkedAmountTotal: string;
  readonly missingLinkedTransactionIds: readonly string[];
  readonly memoIndicatesVoid: boolean;
};

export const QUICKBOOKS_SUBLEDGER_PROJECTION_DIAGNOSTIC_LIMIT = 100;

export class QuickBooksSubledgerProjectionError extends Error {
  readonly code = "quickbooks_subledger_projection_invalid";
  readonly diagnostic: QuickBooksSubledgerProjectionDiagnostic;
  readonly diagnostics: readonly QuickBooksSubledgerProjectionDiagnostic[];
  readonly diagnosticCount: number;
  readonly diagnosticsTruncated: boolean;

  constructor(
    diagnosticOrDiagnostics:
      | QuickBooksSubledgerProjectionDiagnostic
      | readonly QuickBooksSubledgerProjectionDiagnostic[],
    diagnosticCount?: number
  ) {
    const diagnosticArray = Array.isArray(diagnosticOrDiagnostics)
      ? diagnosticOrDiagnostics as readonly QuickBooksSubledgerProjectionDiagnostic[]
      : [diagnosticOrDiagnostics as QuickBooksSubledgerProjectionDiagnostic];
    const diagnostics = diagnosticArray.slice(0, QUICKBOOKS_SUBLEDGER_PROJECTION_DIAGNOSTIC_LIMIT);
    const diagnostic = diagnostics[0];
    if (diagnostic === undefined) {
      throw new Error("QuickBooks subledger projection errors require at least one diagnostic.");
    }
    const totalCount = Math.max(diagnosticCount ?? diagnostics.length, diagnostics.length);
    const reasons = diagnostic.rejectionReasons.length === 0
      ? "the provider evidence is not projectable"
      : diagnostic.rejectionReasons.join(", ");
    super(
      `QuickBooks ${diagnostic.sourceTransactionType} ${diagnostic.sourceTransactionId} cannot be projected into the canonical subledger: ${reasons}` +
      (totalCount > 1 ? `; ${String(totalCount - 1)} additional provider record${totalCount === 2 ? "" : "s"} failed projection preflight` : "")
    );
    this.name = "QuickBooksSubledgerProjectionError";
    this.diagnostic = diagnostic;
    this.diagnostics = diagnostics;
    this.diagnosticCount = totalCount;
    this.diagnosticsTruncated = totalCount > diagnostics.length;
  }
}

export async function persistQuickBooksSubledgerResources(
  input: PersistQuickBooksSubledgerResourcesInput & { readonly client: PostgresQueryClient }
): Promise<QuickBooksSubledgerImportResult> {
  await input.client.query(
    `select set_config('erp_financials.quickbooks_projection_refresh', 'on', true)`
  );
  const transactionBySourceId = new Map(
    input.facts.transactions.map((transaction) => [transaction.sourceTransactionId, transaction])
  );
  const documentIdBySourceId = new Map<string, string>();
  const accountIdBySourceId = new Map(input.facts.accounts.map((account) => [account.sourceAccountId, account.accountId]));
  const itemBySourceId = new Map(input.facts.items.map((item) => [item.sourceItemId, item]));
  const partyIdBySourceId = new Map(input.facts.parties.map((party) => [party.sourcePartyId, party.partyId]));
  const operationalDocuments = input.resources.operationalDocuments ?? input.resources.ledgerTransactions ?? [];
  // Incremental envelopes need not repeat unchanged (including inactive) references.
  const retainedAccounts = await input.client.query<{ source_account_id: string; account_id: string }>(
    `select source_account_id, account_id from erp_financials.accounts where tenant_id=$1 and source_id=$2`,
    [input.facts.company.tenantId, input.facts.source.sourceId]);
  const retainedItems = await input.client.query<{ source_item_id: string; item_id: string; income_account_id: string | null; expense_account_id: string | null }>(
    `select source_item_id, item_id, income_account_id, expense_account_id from erp_financials.items where tenant_id=$1 and source_id=$2`,
    [input.facts.company.tenantId, input.facts.source.sourceId]);
  const commercialReferences: QuickBooksCommercialReferences = {
    accounts: [...retainedAccounts.rows.map(row => ({ sourceAccountId: row.source_account_id, accountId: row.account_id })), ...input.facts.accounts],
    items: [...retainedItems.rows.map(row => ({ sourceItemId: row.source_item_id, itemId: row.item_id,
      ...(row.income_account_id ? { incomeAccountId: row.income_account_id } : {}),
      ...(row.expense_account_id ? { expenseAccountId: row.expense_account_id } : {}) })), ...input.facts.items]
  };
  const commercialPlans = new Map<string, QuickBooksCommercialDetailPlan>();
  for (const resource of operationalDocuments) {
    const normalized = resource.resource;
    if (importedDocumentType(normalized.sourceTransactionType) !== undefined) {
      documentIdBySourceId.set(
        normalized.sourceTransactionId,
        stableId("qbo_document", input.facts.source.sourceId, normalized.sourceTransactionType, normalized.sourceTransactionId)
      );
    }
  }
  const existingDocuments = await input.client.query<{
    source_transaction_id: string;
    subledger_document_id: string;
    status: string;
    party_id: string | null;
  }>(
    `select "metadata" ->> 'sourceTransactionId' as "source_transaction_id", "subledger_document_id", "status", "party_id"
from "erp_financials"."subledger_documents"
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3
  and "metadata" ->> 'provider' = 'quickbooks'`,
    [input.facts.company.tenantId, input.companyId, input.facts.source.sourceId]
  );
  for (const row of existingDocuments.rows) {
    if (row.source_transaction_id && row.subledger_document_id) {
      documentIdBySourceId.set(row.source_transaction_id, row.subledger_document_id);
    }
  }
  const projectableDocumentSourceIds = new Set(
    existingDocuments.rows
      .filter((row) => row.status !== "voided")
      .map((row) => row.source_transaction_id)
      .filter((value) => value !== "")
  );
  for (const resource of operationalDocuments) {
    if (resource.syncAction === "voided" || resource.syncAction === "deleted" || resource.syncAction === "skipped") continue;
    const normalized = resource.resource;
    if (
      importedDocumentType(normalized.sourceTransactionType) !== undefined &&
      positiveAmount(normalized.totalAmount) !== undefined &&
      transactionBySourceId.has(normalized.sourceTransactionId)
    ) {
      projectableDocumentSourceIds.add(normalized.sourceTransactionId);
    }
  }
  let documents = 0;
  let documentLines = 0;
  let skippedTransactions = 0;
  let voidedDocuments = 0;
  let removedLedgerPostings = 0;
  let skippedDocumentLines = 0;
  const applicationOnlyProjections = new Map<string, ApplicationOnlyProjection>();
  const providerOffsetBillPayments = new Set<string>();
  const customerDepositApplicationSourceIds = new Set<string>();
  const customerDepositPartyIdBySourceId = new Map<string, string>();
  const conflictingCustomerDepositPartySourceIds = new Set<string>();

  for (const resource of operationalDocuments) {
    if (resource.syncAction === "voided" || resource.syncAction === "deleted" || resource.syncAction === "skipped") continue;
    const normalized = resource.resource;
    const projection = quickBooksZeroTotalCustomerCreditProjection(
      normalized,
      transactionBySourceId.get(normalized.sourceTransactionId) === undefined,
      projectableDocumentSourceIds
    );
    if (projection?.eligible === true && projection.projectionKind === "customer_deposit_application") {
      const applicationPartyId = normalized.partyRef?.partyType === "customer"
        ? partyIdBySourceId.get(normalized.partyRef.sourceObjectId)
        : undefined;
      for (const allocation of projection.allocations) {
        customerDepositApplicationSourceIds.add(allocation.sourceDocumentSourceTransactionId);
        if (applicationPartyId === undefined) continue;
        const existingPartyId = customerDepositPartyIdBySourceId.get(allocation.sourceDocumentSourceTransactionId);
        if (existingPartyId !== undefined && existingPartyId !== applicationPartyId) {
          conflictingCustomerDepositPartySourceIds.add(allocation.sourceDocumentSourceTransactionId);
        } else {
          customerDepositPartyIdBySourceId.set(
            allocation.sourceDocumentSourceTransactionId,
            applicationPartyId
          );
        }
      }
    }
  }

  const existingDocumentPartyIdBySourceId = new Map(
    existingDocuments.rows.map((row) => [row.source_transaction_id, row.party_id ?? undefined])
  );
  const projectedDocumentPartyId = (sourceTransactionId: string): string | undefined =>
    transactionBySourceId.get(sourceTransactionId)?.partyId ??
    existingDocumentPartyIdBySourceId.get(sourceTransactionId);
  const applicationOnlyPartyRejectionReasons = (
    normalized: NormalizedQuickBooksLedgerTransaction,
    projection: ApplicationOnlyProjection
  ): string[] => {
    const expectedPartyType = projection.sourceTransactionType === "Payment" ? "customer" : "vendor";
    const applicationPartyId = normalized.partyRef?.partyType === expectedPartyType
      ? partyIdBySourceId.get(normalized.partyRef.sourceObjectId)
      : undefined;
    const reasons = new Set<string>();
    if (applicationPartyId === undefined) reasons.add("missing_application_party");

    for (const allocation of projection.allocations) {
      if (conflictingCustomerDepositPartySourceIds.has(allocation.sourceDocumentSourceTransactionId)) {
        reasons.add("conflicting_application_party");
      }
      const sourcePartyId = projection.projectionKind === "customer_deposit_application"
        ? customerDepositPartyIdBySourceId.get(allocation.sourceDocumentSourceTransactionId)
        : projectedDocumentPartyId(allocation.sourceDocumentSourceTransactionId);
      const targetPartyId = projectedDocumentPartyId(allocation.targetDocumentSourceTransactionId);
      if (sourcePartyId === undefined || targetPartyId === undefined) {
        reasons.add("missing_application_party");
      } else if (
        applicationPartyId === undefined ||
        sourcePartyId !== applicationPartyId ||
        targetPartyId !== applicationPartyId
      ) {
        reasons.add("application_party_mismatch");
      }
    }
    return [...reasons];
  };

  const projectionDiagnostics: QuickBooksSubledgerProjectionDiagnostic[] = [];
  let projectionDiagnosticCount = 0;
  const recordProjectionDiagnostic = (diagnostic: QuickBooksSubledgerProjectionDiagnostic): void => {
    projectionDiagnosticCount += 1;
    if (projectionDiagnostics.length < QUICKBOOKS_SUBLEDGER_PROJECTION_DIAGNOSTIC_LIMIT) {
      projectionDiagnostics.push(diagnostic);
    }
  };
  for (const resource of operationalDocuments) {
    if (resource.syncAction === "voided" || resource.syncAction === "deleted" || resource.syncAction === "skipped") continue;
    const normalized = resource.resource;
    const documentType = importedDocumentType(normalized.sourceTransactionType);
    if (documentType === undefined) continue;
    const transaction = transactionBySourceId.get(normalized.sourceTransactionId);
    const originalAmount = positiveAmount(normalized.totalAmount);
    if (
      transaction !== undefined &&
      zeroAmount(normalized.totalAmount) &&
      importedApplicationType(normalized.sourceTransactionType) === undefined
    ) {
      continue;
    }
    if (transaction === undefined || originalAmount === undefined) {
      if (quickBooksZeroTotalProviderOffsetBillPayment(
        normalized,
        transaction === undefined,
        projectableDocumentSourceIds
      )) {
        continue;
      }
      const applicationOnly = quickBooksZeroTotalBillPaymentProjection(
        normalized,
        transaction === undefined,
        projectableDocumentSourceIds
      ) ?? quickBooksZeroTotalCustomerCreditProjection(
        normalized,
        transaction === undefined,
        projectableDocumentSourceIds
      );
      if (applicationOnly?.eligible === true) {
        const partyRejectionReasons = applicationOnlyPartyRejectionReasons(normalized, applicationOnly);
        if (partyRejectionReasons.length === 0) continue;
        recordProjectionDiagnostic({
          ...applicationOnly.diagnostic,
          rejectionReasons: partyRejectionReasons
        });
        continue;
      }
      recordProjectionDiagnostic(
        applicationOnly?.diagnostic ?? quickBooksSubledgerProjectionDiagnostic(
          normalized,
          transaction === undefined
        )
      );
      continue;
    }

    const rejectionReasons = quickBooksDocumentProjectionRejectionReasons(
      documentType,
      normalized,
      originalAmount
    );
    if (["invoice", "vendor_bill", "credit_memo", "vendor_credit"].includes(documentType)) {
      try {
        commercialPlans.set(`${normalized.sourceTransactionType}:${normalized.sourceTransactionId}`, planQuickBooksCommercialDetail(normalized, commercialReferences));
      } catch (error) {
        if (!(error instanceof QuickBooksCommercialDetailError)) throw error;
        rejectionReasons.push(error.reason);
      }
    }
    if (rejectionReasons.length > 0) {
      recordProjectionDiagnostic({
        ...quickBooksSubledgerProjectionDiagnostic(normalized, false),
        rejectionReasons
      });
    }
  }
  if (projectionDiagnosticCount > 0) {
    throw new QuickBooksSubledgerProjectionError(
      projectionDiagnostics,
      projectionDiagnosticCount
    );
  }

  for (const resource of operationalDocuments) {
    if (resource.syncAction === "voided" || resource.syncAction === "deleted" || resource.syncAction === "skipped") continue;
    const normalized = resource.resource;
    const documentType = importedDocumentType(normalized.sourceTransactionType);
    if (documentType === undefined) continue;
    const transaction = transactionBySourceId.get(normalized.sourceTransactionId);
    const originalAmount = positiveAmount(normalized.totalAmount);
    if (
      transaction !== undefined &&
      zeroAmount(normalized.totalAmount) &&
      importedApplicationType(normalized.sourceTransactionType) === undefined
    ) {
      // A zero-net provider document can still own a balanced canonical journal
      // (for example revenue offset by a discount). Keep that accounting
      // activity while omitting a meaningless zero-value subledger header.
      skippedTransactions += 1;
      continue;
    }
    if (transaction === undefined || originalAmount === undefined) {
      if (quickBooksZeroTotalProviderOffsetBillPayment(
        normalized,
        transaction === undefined,
        projectableDocumentSourceIds
      )) {
        // QuickBooks uses a zero-cash BillPayment as a relationship container
        // when vendor credits exactly offset Purchase or Deposit documents.
        // Those linked documents and their balanced journals retain the full
        // accounting effect; the container must not create another document,
        // application, or posting.
        providerOffsetBillPayments.add(normalized.sourceTransactionId);
        skippedTransactions += 1;
        continue;
      }
      const applicationOnly = quickBooksZeroTotalBillPaymentProjection(
        normalized,
        transaction === undefined,
        projectableDocumentSourceIds
      ) ?? quickBooksZeroTotalCustomerCreditProjection(
        normalized,
        transaction === undefined,
        projectableDocumentSourceIds
      );
      if (applicationOnly?.eligible === true) {
        applicationOnlyProjections.set(normalized.sourceTransactionId, applicationOnly);
        continue;
      }
      throw new QuickBooksSubledgerProjectionError(
        applicationOnly?.diagnostic ?? quickBooksSubledgerProjectionDiagnostic(
          normalized,
          transaction === undefined
        )
      );
    }
    const documentId = documentIdBySourceId.get(normalized.sourceTransactionId);
    if (documentId === undefined) {
      skippedTransactions += 1;
      continue;
    }
    const eventId = stableId("qbo_event", documentId, "imported");
    const idempotencyKey = `quickbooks:subledger:${input.facts.source.sourceId}:${normalized.sourceTransactionType}:${normalized.sourceTransactionId}`;
    const initialState = initialDocumentState(
      documentType,
      originalAmount,
      customerDepositApplicationSourceIds.has(normalized.sourceTransactionId)
    );
    const payload: JsonValue = {
      provider: "quickbooks",
      sourceTransactionId: normalized.sourceTransactionId,
      sourceTransactionType: normalized.sourceTransactionType,
      importBatchId: input.facts.importBatch.importBatchId
    };
    await insertLifecycleEvent(input.client, {
      eventId,
      tenantId: input.facts.company.tenantId,
      companyId: input.companyId,
      sourceId: input.facts.source.sourceId,
      aggregateId: documentId,
      eventType: "quickbooks_document_imported",
      occurredAt: normalized.sourceUpdatedAt ?? input.importedAt,
      recordedAt: input.importedAt,
      idempotencyKey: `${idempotencyKey}:event`,
      payload
    });
    const result = await input.client.query(
      `insert into "erp_financials"."subledger_documents" (
        "subledger_document_id", "tenant_id", "company_id", "source_id", "document_type",
        "transaction_id", "party_id", "document_number", "document_date", "due_date",
        "currency_code", "original_amount", "open_amount", "status", "version",
        "idempotency_key", "lifecycle_event_id", "metadata", "created_at", "updated_at"
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,1,$15,$16,$17::jsonb,$18,$18)
      on conflict ("tenant_id", "company_id", "source_id", "idempotency_key") do update
      set "transaction_id" = excluded."transaction_id",
        "party_id" = excluded."party_id",
        "document_number" = excluded."document_number",
        "document_date" = excluded."document_date",
        "due_date" = excluded."due_date",
        "currency_code" = excluded."currency_code",
        "original_amount" = excluded."original_amount",
        "open_amount" = excluded."original_amount" - (case
          when "subledger_documents"."status" = 'voided' then 0
          else "subledger_documents"."original_amount" - "subledger_documents"."open_amount"
        end),
        "status" = case
          when excluded."status" = 'settled' then 'settled'
          when excluded."original_amount" - (case when "subledger_documents"."status" = 'voided' then 0 else "subledger_documents"."original_amount" - "subledger_documents"."open_amount" end) = 0 then 'settled'
          when excluded."original_amount" - (case when "subledger_documents"."status" = 'voided' then 0 else "subledger_documents"."original_amount" - "subledger_documents"."open_amount" end) = excluded."original_amount" then 'open'
          else 'partially_applied'
        end,
        "version" = "subledger_documents"."version" + 1,
        "metadata" = excluded."metadata",
        "updated_at" = excluded."updated_at"
      where "subledger_documents"."transaction_id" is distinct from excluded."transaction_id"
        or "subledger_documents"."party_id" is distinct from excluded."party_id"
        or "subledger_documents"."document_number" is distinct from excluded."document_number"
        or "subledger_documents"."document_date" is distinct from excluded."document_date"
        or "subledger_documents"."due_date" is distinct from excluded."due_date"
        or "subledger_documents"."currency_code" is distinct from excluded."currency_code"
        or "subledger_documents"."original_amount" is distinct from excluded."original_amount"
        or "subledger_documents"."metadata" is distinct from excluded."metadata"`,
      [
        documentId,
        input.facts.company.tenantId,
        input.companyId,
        input.facts.source.sourceId,
        documentType,
        transaction.transactionId,
        customerDepositPartyIdBySourceId.get(normalized.sourceTransactionId) ?? transaction.partyId ?? null,
        normalized.transactionNumber ?? null,
        normalized.transactionDate,
        normalized.dueDate ?? normalized.transactionDate,
        normalized.currencyCode ?? input.facts.company.baseCurrencyCode,
        originalAmount,
        initialState.openAmount,
        initialState.status,
        idempotencyKey,
        eventId,
        JSON.stringify({
          provider: "quickbooks",
          sourceTransactionId: normalized.sourceTransactionId,
          sourceTransactionType: normalized.sourceTransactionType,
          sourceUpdatedAt: normalized.sourceUpdatedAt ?? null,
          reportedOpenAmount: normalized.openAmount ?? normalized.unappliedAmount ?? null,
          emailStatus: normalized.emailStatus ?? null,
          printStatus: normalized.printStatus ?? null
        }),
        input.importedAt
      ]
    );
    documents += result.rowCount ?? 0;

    const commercialPlan = commercialPlans.get(`${normalized.sourceTransactionType}:${normalized.sourceTransactionId}`);
    const persistedLineNumbers: number[] = [];
    if (!importsCommercialDocumentLines(documentType)) {
      await input.client.query(
        `delete from "erp_financials"."subledger_document_lines"
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3 and "subledger_document_id" = $4`,
        [input.facts.company.tenantId, input.companyId, input.facts.source.sourceId, documentId]
      );
      continue;
    }
    for (const line of normalized.lines) {
      if (isQuickBooksProviderOnlyNonPostingLine(line.detailType)) {
        skippedDocumentLines += 1;
        continue;
      }
      const plannedLine = commercialPlan?.lines.find(candidate => candidate.source === line);
      const amount = plannedLine?.amount ?? positiveAmount(line.sourceAmount);
      const item = line.itemRef === undefined ? undefined : itemBySourceId.get(line.itemRef.sourceObjectId);
      const accountId = plannedLine?.accountId ?? (line.accountRef === undefined
        ? documentLineItemAccount(documentType, item)
        : accountIdBySourceId.get(line.accountRef.sourceObjectId));
      if (amount === undefined) {
        continue;
      }
      if (accountId === undefined) {
        // The canonical transaction above is already backed by QuickBooks'
        // balanced General Ledger. Some valid provider documents omit the
        // commercial line AccountRef (and have no item account fallback).
        // Preserve the authoritative journal and document header without
        // inventing a line account; the bounded skipped-line count keeps this
        // loss of subledger detail visible to hosts.
        skippedDocumentLines += 1;
        continue;
      }
      const commercialAmounts = plannedLine ?? commercialLineAmounts(amount, line.sourceQuantity, line.sourceUnitAmount);
      const customerPartyId = line.partyRef?.partyType === "customer"
        ? partyIdBySourceId.get(line.partyRef.sourceObjectId)
        : undefined;
      const lineResult = await input.client.query(
        `insert into "erp_financials"."subledger_document_lines" (
          "subledger_document_line_id", "tenant_id", "company_id", "source_id",
          "subledger_document_id", "line_number", "account_id", "item_id", "customer_party_id", "description",
          "quantity", "unit_amount", "discount_amount", "tax_code", "tax_amount",
          "dimension_refs", "line_amount"
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17)
        on conflict ("tenant_id", "company_id", "source_id", "subledger_document_id", "line_number") do update
        set "account_id" = excluded."account_id", "item_id" = excluded."item_id",
          "customer_party_id" = excluded."customer_party_id",
          "description" = excluded."description", "quantity" = excluded."quantity",
          "unit_amount" = excluded."unit_amount", "discount_amount" = excluded."discount_amount",
          "tax_code" = excluded."tax_code", "tax_amount" = excluded."tax_amount",
          "dimension_refs" = excluded."dimension_refs", "line_amount" = excluded."line_amount"`,
        [
          stableId("qbo_document_line", documentId, line.sourceLineId ?? String(line.lineNumber)),
          input.facts.company.tenantId,
          input.companyId,
          input.facts.source.sourceId,
          documentId,
          line.lineNumber,
          accountId,
          plannedLine?.itemId ?? item?.itemId ?? null,
          customerPartyId ?? null,
          line.description ?? null,
          commercialAmounts.quantity,
          commercialAmounts.unitAmount,
          commercialAmounts.discountAmount,
          line.taxCode ?? null,
          commercialAmounts.taxAmount,
          JSON.stringify(line.dimensionRefs ?? []),
          amount
        ]
      );
      documentLines += lineResult.rowCount ?? 0;
      persistedLineNumbers.push(line.lineNumber);
    }
    await input.client.query(
      `delete from "erp_financials"."subledger_document_lines"
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3
  and "subledger_document_id" = $4 and not ("line_number" = any($5::int[]))`,
      [input.facts.company.tenantId, input.companyId, input.facts.source.sourceId, documentId, persistedLineNumbers]
    );
  }

  let applications = 0;
  let skippedApplications = 0;
  const unresolvedApplications: QuickBooksSubledgerImportResult["unresolvedApplications"][number][] = [];
  for (const resource of operationalDocuments) {
    if (resource.syncAction === "voided" || resource.syncAction === "deleted" || resource.syncAction === "skipped") continue;
    const source = resource.resource;
    if (
      applicationOnlyProjections.has(source.sourceTransactionId) ||
      providerOffsetBillPayments.has(source.sourceTransactionId)
    ) continue;
    if (importedApplicationType(source.sourceTransactionType) === undefined) continue;
    const sourceDocumentId = documentIdBySourceId.get(source.sourceTransactionId);
    if (sourceDocumentId === undefined) continue;
    const incomingApplicationIds = new Set(
      source.lines.flatMap((line) => (line.linkedTransactions ?? []).map((linked) => {
        const targetDocumentId = documentIdBySourceId.get(linked.sourceTransactionId);
        return targetDocumentId === undefined
          ? undefined
          : stableId("qbo_application", sourceDocumentId, targetDocumentId, line.sourceLineId ?? String(line.lineNumber));
      })).filter((value): value is string => value !== undefined)
    );
    const existingApplications = await input.client.query<{
      subledger_application_id: string;
      version: number;
    }>(
      `select "subledger_application_id", "version"
from "erp_financials"."subledger_applications"
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3
  and "source_document_id" = $4 and "status" = 'applied'`,
      [input.facts.company.tenantId, input.companyId, input.facts.source.sourceId, sourceDocumentId]
    );
    for (const existing of existingApplications.rows) {
      if (incomingApplicationIds.has(existing.subledger_application_id)) continue;
      const endedEventId = stableId(
        "qbo_event",
        existing.subledger_application_id,
        "unapplied",
        source.sourceUpdatedAt ?? input.facts.importBatch.importBatchId
      );
      await insertLifecycleEvent(input.client, {
        eventId: endedEventId,
        tenantId: input.facts.company.tenantId,
        companyId: input.companyId,
        sourceId: input.facts.source.sourceId,
        aggregateId: existing.subledger_application_id,
        eventType: "quickbooks_application_removed",
        occurredAt: source.sourceUpdatedAt ?? input.importedAt,
        recordedAt: input.importedAt,
        idempotencyKey: `quickbooks:application-removed:${existing.subledger_application_id}:${source.sourceUpdatedAt ?? input.facts.importBatch.importBatchId}`,
        payload: {
          provider: "quickbooks",
          sourceTransactionId: source.sourceTransactionId,
          importBatchId: input.facts.importBatch.importBatchId
        }
      });
      await input.client.query(
        `update "erp_financials"."subledger_applications"
set "status" = 'voided', "version" = "version" + 1, "ended_event_id" = $5, "updated_at" = $6
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3
  and "subledger_application_id" = $4 and "status" = 'applied'`,
        [
          input.facts.company.tenantId,
          input.companyId,
          input.facts.source.sourceId,
          existing.subledger_application_id,
          endedEventId,
          input.importedAt
        ]
      );
    }
  }
  for (const resource of operationalDocuments) {
    if (resource.syncAction === "voided" || resource.syncAction === "deleted" || resource.syncAction === "skipped") continue;
    const source = resource.resource;
    if (
      applicationOnlyProjections.has(source.sourceTransactionId) ||
      providerOffsetBillPayments.has(source.sourceTransactionId)
    ) continue;
    const applicationType = importedApplicationType(source.sourceTransactionType);
    if (applicationType === undefined) continue;
    const sourceDocumentId = documentIdBySourceId.get(source.sourceTransactionId);
    if (sourceDocumentId === undefined) continue;
    for (const line of source.lines) {
      if ((line.linkedTransactions?.length ?? 0) > 1) {
        throw new Error(
          `QuickBooks ${source.sourceTransactionType} ${source.sourceTransactionId} line ${line.sourceLineId ?? String(line.lineNumber)} links multiple documents without per-link amounts`
        );
      }
      for (const linked of line.linkedTransactions ?? []) {
        const targetDocumentId = documentIdBySourceId.get(linked.sourceTransactionId);
        const amount = positiveAmount(line.sourceAmount);
        if (targetDocumentId === undefined || amount === undefined) {
          skippedApplications += 1;
          unresolvedApplications.push({
            sourceTransactionId: source.sourceTransactionId,
            targetSourceTransactionId: linked.sourceTransactionId,
            sourceLineId: line.sourceLineId ?? String(line.lineNumber),
            reason: targetDocumentId === undefined ? "missing_target_document" : "missing_positive_amount"
          });
          continue;
        }
        const applicationId = stableId("qbo_application", sourceDocumentId, targetDocumentId, line.sourceLineId ?? String(line.lineNumber));
        const eventId = stableId("qbo_event", applicationId, "applied");
        const idempotencyKey = `quickbooks:application:${input.facts.source.sourceId}:${source.sourceTransactionId}:${linked.sourceTransactionId}:${line.sourceLineId ?? String(line.lineNumber)}`;
        const payload: JsonValue = {
          provider: "quickbooks",
          sourceTransactionId: source.sourceTransactionId,
          targetSourceTransactionId: linked.sourceTransactionId,
          importBatchId: input.facts.importBatch.importBatchId
        };
        await insertLifecycleEvent(input.client, {
          eventId,
          tenantId: input.facts.company.tenantId,
          companyId: input.companyId,
          sourceId: input.facts.source.sourceId,
          aggregateId: applicationId,
          eventType: "quickbooks_application_imported",
          occurredAt: source.sourceUpdatedAt ?? input.importedAt,
          recordedAt: input.importedAt,
          idempotencyKey: `${idempotencyKey}:event`,
          payload
        });
        const result = await input.client.query(
          `insert into "erp_financials"."subledger_applications" (
            "subledger_application_id", "tenant_id", "company_id", "source_id", "application_type",
            "source_document_id", "target_document_id", "applied_amount", "currency_code",
            "application_date", "status", "version", "idempotency_key", "applied_event_id",
            "created_at", "updated_at"
          ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'applied',1,$11,$12,$13,$13)
          on conflict ("tenant_id", "company_id", "source_id", "idempotency_key") do update
          set "applied_amount" = excluded."applied_amount",
            "application_date" = excluded."application_date",
            "status" = 'applied', "version" = "subledger_applications"."version" + 1,
            "ended_event_id" = null, "updated_at" = excluded."updated_at"
          where "subledger_applications"."applied_amount" is distinct from excluded."applied_amount"
            or "subledger_applications"."application_date" is distinct from excluded."application_date"
            or "subledger_applications"."status" <> 'applied'`,
          [
            applicationId,
            input.facts.company.tenantId,
            input.companyId,
            input.facts.source.sourceId,
            applicationType,
            sourceDocumentId,
            targetDocumentId,
            amount,
            source.currencyCode ?? input.facts.company.baseCurrencyCode,
            source.transactionDate,
            idempotencyKey,
            eventId,
            input.importedAt
          ]
        );
        applications += result.rowCount ?? 0;
      }
    }
  }

  for (const [sourceTransactionId, projection] of applicationOnlyProjections) {
    const incomingApplicationIds = new Set(projection.allocations.map((allocation, index) =>
      stableId(
        "qbo_application",
        input.facts.source.sourceId,
        sourceTransactionId,
        allocation.sourceDocumentSourceTransactionId,
        allocation.targetDocumentSourceTransactionId,
        String(index + 1)
      )
    ));
    const existingApplications = await input.client.query<{
      subledger_application_id: string;
      version: number;
    }>(
      `select application."subledger_application_id", application."version"
from "erp_financials"."subledger_applications" application
join "erp_financials"."financial_lifecycle_events" event
  on event."tenant_id" = application."tenant_id" and event."company_id" = application."company_id"
  and event."source_id" = application."source_id" and event."event_id" = application."applied_event_id"
where application."tenant_id" = $1 and application."company_id" = $2 and application."source_id" = $3
  and application."application_type" = $4 and application."status" = 'applied'
  and event."payload" ->> 'sourceTransactionId' = $5
  and event."payload" ->> 'projectionKind' = $6`,
      [
        input.facts.company.tenantId,
        input.companyId,
        input.facts.source.sourceId,
        projection.applicationType,
        sourceTransactionId,
        projection.projectionKind
      ]
    );
    for (const existing of existingApplications.rows) {
      if (incomingApplicationIds.has(existing.subledger_application_id)) continue;
      const endedEventId = stableId(
        "qbo_event",
        existing.subledger_application_id,
        "unapplied",
        projection.sourceUpdatedAt ?? input.facts.importBatch.importBatchId
      );
      await insertLifecycleEvent(input.client, {
        eventId: endedEventId,
        tenantId: input.facts.company.tenantId,
        companyId: input.companyId,
        sourceId: input.facts.source.sourceId,
        aggregateId: existing.subledger_application_id,
        eventType: "quickbooks_application_removed",
        occurredAt: projection.sourceUpdatedAt ?? input.importedAt,
        recordedAt: input.importedAt,
        idempotencyKey: `quickbooks:application-removed:${existing.subledger_application_id}:${projection.sourceUpdatedAt ?? input.facts.importBatch.importBatchId}`,
        payload: {
          provider: "quickbooks",
          sourceTransactionId,
          importBatchId: input.facts.importBatch.importBatchId,
          projectionKind: projection.projectionKind
        }
      });
      await input.client.query(
        `update "erp_financials"."subledger_applications"
set "status" = 'voided', "version" = "version" + 1, "ended_event_id" = $5, "updated_at" = $6
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3
  and "subledger_application_id" = $4 and "status" = 'applied'`,
        [input.facts.company.tenantId, input.companyId, input.facts.source.sourceId,
          existing.subledger_application_id, endedEventId, input.importedAt]
      );
    }

    for (const [index, allocation] of projection.allocations.entries()) {
      const sourceDocumentId = documentIdBySourceId.get(allocation.sourceDocumentSourceTransactionId);
      const targetDocumentId = documentIdBySourceId.get(allocation.targetDocumentSourceTransactionId);
      if (sourceDocumentId === undefined || targetDocumentId === undefined) {
        throw new QuickBooksSubledgerProjectionError(projection.diagnostic);
      }
      const applicationId = stableId(
        "qbo_application",
        input.facts.source.sourceId,
        sourceTransactionId,
        allocation.sourceDocumentSourceTransactionId,
        allocation.targetDocumentSourceTransactionId,
        String(index + 1)
      );
      const eventId = stableId("qbo_event", applicationId, "applied");
      const idempotencyKey = `quickbooks:${projection.projectionKind.replaceAll("_", "-")}:${input.facts.source.sourceId}:${sourceTransactionId}:${allocation.sourceDocumentSourceTransactionId}:${allocation.targetDocumentSourceTransactionId}:${String(index + 1)}`;
      const payload: JsonValue = {
        provider: "quickbooks",
        sourceTransactionId,
        sourceTransactionType: projection.sourceTransactionType,
        ...(projection.projectionKind === "vendor_credit_application"
          ? {
              vendorCreditSourceTransactionId: allocation.sourceDocumentSourceTransactionId,
              billSourceTransactionId: allocation.targetDocumentSourceTransactionId
            }
          : projection.projectionKind === "customer_deposit_application"
            ? {
                depositSourceTransactionId: allocation.sourceDocumentSourceTransactionId,
                invoiceSourceTransactionId: allocation.targetDocumentSourceTransactionId
              }
          : {
              creditMemoSourceTransactionId: allocation.sourceDocumentSourceTransactionId,
              invoiceSourceTransactionId: allocation.targetDocumentSourceTransactionId
            }),
        projectionKind: projection.projectionKind,
        importBatchId: input.facts.importBatch.importBatchId
      };
      await insertLifecycleEvent(input.client, {
        eventId,
        tenantId: input.facts.company.tenantId,
        companyId: input.companyId,
        sourceId: input.facts.source.sourceId,
        aggregateId: applicationId,
        eventType: projection.projectionKind === "vendor_credit_application"
          ? "quickbooks_vendor_credit_application_imported"
          : projection.projectionKind === "customer_deposit_application"
            ? "quickbooks_customer_deposit_application_imported"
            : "quickbooks_customer_credit_application_imported",
        occurredAt: projection.sourceUpdatedAt ?? input.importedAt,
        recordedAt: input.importedAt,
        idempotencyKey: `${idempotencyKey}:event`,
        payload
      });
      const result = await input.client.query(
        `insert into "erp_financials"."subledger_applications" (
          "subledger_application_id", "tenant_id", "company_id", "source_id", "application_type",
          "source_document_id", "target_document_id", "applied_amount", "currency_code",
          "application_date", "status", "version", "idempotency_key", "applied_event_id",
          "created_at", "updated_at"
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'applied',1,$11,$12,$13,$13)
        on conflict ("tenant_id", "company_id", "source_id", "idempotency_key") do update
        set "applied_amount" = excluded."applied_amount",
          "application_date" = excluded."application_date",
          "status" = 'applied', "version" = "subledger_applications"."version" + 1,
          "ended_event_id" = null, "updated_at" = excluded."updated_at"
        where "subledger_applications"."applied_amount" is distinct from excluded."applied_amount"
          or "subledger_applications"."application_date" is distinct from excluded."application_date"
          or "subledger_applications"."status" <> 'applied'`,
        [
          applicationId,
          input.facts.company.tenantId,
          input.companyId,
          input.facts.source.sourceId,
          projection.applicationType,
          sourceDocumentId,
          targetDocumentId,
          allocation.amount,
          projection.currencyCode ?? input.facts.company.baseCurrencyCode,
          projection.transactionDate,
          idempotencyKey,
          eventId,
          input.importedAt
        ]
      );
      applications += result.rowCount ?? 0;
    }
  }

  // Application-only provider wrappers are provenance, not cash documents.
  // Retire their canonical application directly when an incremental change no
  // longer carries the supported shape, or when QuickBooks voids/deletes it.
  for (const resource of operationalDocuments) {
    const source = resource.resource;
    if (source.sourceTransactionType !== "Payment" && source.sourceTransactionType !== "BillPayment") continue;
    if (applicationOnlyProjections.has(source.sourceTransactionId)) continue;
    await retireQuickBooksApplicationOnlyProjection(input, {
      sourceTransactionId: source.sourceTransactionId,
      sourceTransactionType: source.sourceTransactionType,
      action: resource.syncAction === "voided" || resource.syncAction === "deleted"
        ? resource.syncAction
        : "removed",
      occurredAt: source.sourceUpdatedAt ?? input.importedAt,
      ...(resource.syncAction === "voided" || resource.syncAction === "deleted"
        ? {}
        : { reason: "projection_changed" as const })
    });
  }
  if (input.replaceMissingDocuments === true) {
    const incomingSourceIds = operationalDocuments.map((resource) => resource.resource.sourceTransactionId);
    const missingApplicationOnlySources = await input.client.query<{
      source_transaction_id: string;
      source_transaction_type: "BillPayment" | "Payment";
    }>(
      `select distinct event."payload" ->> 'sourceTransactionId' as "source_transaction_id",
  event."payload" ->> 'sourceTransactionType' as "source_transaction_type"
from "erp_financials"."subledger_applications" application
join "erp_financials"."financial_lifecycle_events" event
  on event."tenant_id" = application."tenant_id" and event."company_id" = application."company_id"
  and event."source_id" = application."source_id" and event."event_id" = application."applied_event_id"
where application."tenant_id" = $1 and application."company_id" = $2 and application."source_id" = $3
  and application."status" = 'applied'
  and event."payload" ->> 'projectionKind' in ('customer_credit_application', 'customer_deposit_application', 'vendor_credit_application')
  and not (event."payload" ->> 'sourceTransactionId' = any($4::text[]))`,
      [input.facts.company.tenantId, input.companyId, input.facts.source.sourceId, incomingSourceIds]
    );
    for (const source of missingApplicationOnlySources.rows) {
      await retireQuickBooksApplicationOnlyProjection(input, {
        sourceTransactionId: source.source_transaction_id,
        sourceTransactionType: source.source_transaction_type,
        action: "removed",
        occurredAt: input.importedAt,
        reason: "missing_from_full_snapshot"
      });
    }
  }

  // QuickBooks Balance/UnappliedAmt is the authoritative current snapshot.
  // Applications preserve the dated history, but a provider may omit or
  // normalize LinkedTxn evidence differently; never let that make the current
  // operational balance disagree with QuickBooks.
  for (const resource of operationalDocuments) {
    if (resource.syncAction === "voided" || resource.syncAction === "deleted" || resource.syncAction === "skipped") continue;
    const normalized = resource.resource;
    const documentType = importedDocumentType(normalized.sourceTransactionType);
    const originalAmount = positiveAmount(normalized.totalAmount);
    if (documentType === undefined || originalAmount === undefined) continue;
    const openAmount = reportedQuickBooksOpenAmount(documentType, normalized, originalAmount);
    const documentId = documentIdBySourceId.get(normalized.sourceTransactionId);
    if (openAmount === undefined || documentId === undefined) continue;
    await input.client.query(
      `update "erp_financials"."subledger_documents"
set "open_amount" = $5,
  "status" = case when $5::numeric = 0 then 'settled'
    when $5::numeric = "original_amount" then 'open' else 'partially_applied' end,
  "version" = "version" + 1, "updated_at" = $6
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3
  and "subledger_document_id" = $4 and "open_amount" is distinct from $5::numeric`,
      [
        input.facts.company.tenantId,
        input.companyId,
        input.facts.source.sourceId,
        documentId,
        openAmount,
        input.importedAt
      ]
    );
  }

  for (const resource of operationalDocuments) {
    if (resource.syncAction !== "voided" && resource.syncAction !== "deleted") continue;
    const source = resource.resource;
    const documentId = documentIdBySourceId.get(source.sourceTransactionId);
    if (documentId === undefined) continue;
    const outcome = await voidQuickBooksDocument(input, {
      documentId,
      sourceTransactionId: source.sourceTransactionId,
      action: resource.syncAction,
      occurredAt: source.sourceUpdatedAt ?? input.importedAt
    });
    voidedDocuments += outcome.documents;
    removedLedgerPostings += outcome.postings;
  }

  if (input.replaceMissingDocuments === true) {
    const incomingSourceIds = operationalDocuments
      .filter((resource) => importedDocumentType(resource.resource.sourceTransactionType) !== undefined)
      .map((resource) => resource.resource.sourceTransactionId);
    const missing = await input.client.query<{
      subledger_document_id: string;
      source_transaction_id: string;
    }>(
      `select "subledger_document_id", "metadata" ->> 'sourceTransactionId' as "source_transaction_id"
from "erp_financials"."subledger_documents"
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3
  and "metadata" ->> 'provider' = 'quickbooks' and "status" <> 'voided'
  and not ("metadata" ->> 'sourceTransactionId' = any($4::text[]))`,
      [input.facts.company.tenantId, input.companyId, input.facts.source.sourceId, incomingSourceIds]
    );
    for (const document of missing.rows) {
      const outcome = await voidQuickBooksDocument(input, {
        documentId: document.subledger_document_id,
        sourceTransactionId: document.source_transaction_id,
        action: "deleted",
        occurredAt: input.importedAt,
        reason: "missing_from_full_snapshot"
      });
      voidedDocuments += outcome.documents;
      removedLedgerPostings += outcome.postings;
    }
  }

  const retiredNonDocumentTransactions = [
    // Older normalized-sync envelopes can omit this family even though the
    // current resource-set contract materializes it as an empty array.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    ...(input.resources.journalEntries ?? []).map((resource) => ({
      syncAction: resource.syncAction,
      sourceTransactionType: "JournalEntry",
      sourceTransactionId: "Id" in resource.resource ? resource.resource.Id : resource.resource.sourceTransactionId
    })),
    ...(input.resources.operationalDocuments ?? input.resources.ledgerTransactions ?? []).map((resource) => ({
      syncAction: resource.syncAction,
      sourceTransactionType: resource.resource.sourceTransactionType,
      sourceTransactionId: resource.resource.sourceTransactionId
    }))
  ];
  const retiredTransactionKeys = new Set<string>();
  for (const resource of retiredNonDocumentTransactions) {
    if (resource.syncAction !== "voided" && resource.syncAction !== "deleted") continue;
    if (importedDocumentType(resource.sourceTransactionType) !== undefined) continue;
    const key = `${resource.sourceTransactionType}:${resource.sourceTransactionId}`;
    if (retiredTransactionKeys.has(key)) continue;
    retiredTransactionKeys.add(key);
    const postingsResult = await input.client.query(
      `delete from "erp_financials"."ledger_postings" posting
using "erp_financials"."transactions" transaction
where transaction."tenant_id" = $1 and transaction."source_id" = $2
  and transaction."source_transaction_type" = $3 and transaction."source_transaction_id" = $4
  and posting."tenant_id" = transaction."tenant_id"
  and posting."source_id" = transaction."source_id"
  and posting."transaction_id" = transaction."transaction_id"`,
      [input.facts.company.tenantId, input.facts.source.sourceId,
        resource.sourceTransactionType, resource.sourceTransactionId]
    );
    removedLedgerPostings += postingsResult.rowCount ?? 0;
  }

  await input.client.query(
    `select set_config('erp_financials.quickbooks_projection_refresh', 'off', true)`
  );
  return {
    documents,
    documentLines,
    applications,
    skippedTransactions,
    skippedDocumentLines,
    skippedApplications,
    voidedDocuments,
    removedLedgerPostings,
    unresolvedApplications
  };
}

async function retireQuickBooksApplicationOnlyProjection(
  input: PersistQuickBooksSubledgerResourcesInput & { readonly client: PostgresQueryClient },
  target: {
    readonly sourceTransactionId: string;
    readonly sourceTransactionType: "BillPayment" | "Payment";
    readonly action: "deleted" | "removed" | "voided";
    readonly occurredAt: string;
    readonly reason?: "missing_from_full_snapshot" | "projection_changed";
  }
): Promise<number> {
  const activeApplications = await input.client.query<{ subledger_application_id: string }>(
    `select application."subledger_application_id"
from "erp_financials"."subledger_applications" application
join "erp_financials"."financial_lifecycle_events" event
  on event."tenant_id" = application."tenant_id" and event."company_id" = application."company_id"
  and event."source_id" = application."source_id" and event."event_id" = application."applied_event_id"
where application."tenant_id" = $1 and application."company_id" = $2 and application."source_id" = $3
  and application."status" = 'applied'
  and event."payload" ->> 'sourceTransactionId' = $4
  and event."payload" ->> 'sourceTransactionType' = $5
  and event."payload" ->> 'projectionKind' in ('customer_credit_application', 'customer_deposit_application', 'vendor_credit_application')`,
    [
      input.facts.company.tenantId,
      input.companyId,
      input.facts.source.sourceId,
      target.sourceTransactionId,
      target.sourceTransactionType
    ]
  );
  let retired = 0;
  for (const application of activeApplications.rows) {
    const terminalRef = target.reason ?? target.action;
    const endedEventId = stableId(
      "qbo_event",
      application.subledger_application_id,
      target.action,
      terminalRef,
      input.facts.importBatch.importBatchId
    );
    await insertLifecycleEvent(input.client, {
      eventId: endedEventId,
      tenantId: input.facts.company.tenantId,
      companyId: input.companyId,
      sourceId: input.facts.source.sourceId,
      aggregateId: application.subledger_application_id,
      eventType: target.action === "removed"
        ? "quickbooks_application_removed"
        : `quickbooks_application_${target.action}`,
      occurredAt: target.occurredAt,
      recordedAt: input.importedAt,
      idempotencyKey: `quickbooks:application-${target.action}:${application.subledger_application_id}:${terminalRef}:${input.facts.importBatch.importBatchId}`,
      payload: {
        provider: "quickbooks",
        sourceTransactionId: target.sourceTransactionId,
        sourceTransactionType: target.sourceTransactionType,
        importBatchId: input.facts.importBatch.importBatchId,
        ...(target.reason === undefined ? {} : { reason: target.reason })
      }
    });
    const result = await input.client.query(
      `update "erp_financials"."subledger_applications"
set "status" = 'voided', "version" = "version" + 1, "ended_event_id" = $5, "updated_at" = $6
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3
  and "subledger_application_id" = $4 and "status" = 'applied'`,
      [
        input.facts.company.tenantId,
        input.companyId,
        input.facts.source.sourceId,
        application.subledger_application_id,
        endedEventId,
        input.importedAt
      ]
    );
    retired += result.rowCount ?? 0;
  }
  return retired;
}

async function voidQuickBooksDocument(
  input: PersistQuickBooksSubledgerResourcesInput & { readonly client: PostgresQueryClient },
  target: {
    readonly documentId: string;
    readonly sourceTransactionId: string;
    readonly action: "voided" | "deleted";
    readonly occurredAt: string;
    readonly reason?: "missing_from_full_snapshot";
  }
): Promise<{ readonly documents: number; readonly postings: number }> {
  const activeApplications = await input.client.query<{ subledger_application_id: string }>(
    `select "subledger_application_id"
from "erp_financials"."subledger_applications"
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3 and "status" = 'applied'
  and ("source_document_id" = $4 or "target_document_id" = $4)`,
    [input.facts.company.tenantId, input.companyId, input.facts.source.sourceId, target.documentId]
  );
  for (const application of activeApplications.rows) {
    const endedEventId = stableId(
      "qbo_event", application.subledger_application_id, target.action,
      target.reason ?? input.facts.importBatch.importBatchId
    );
    await insertLifecycleEvent(input.client, {
      eventId: endedEventId,
      tenantId: input.facts.company.tenantId,
      companyId: input.companyId,
      sourceId: input.facts.source.sourceId,
      aggregateId: application.subledger_application_id,
      eventType: `quickbooks_application_${target.action}`,
      occurredAt: target.occurredAt,
      recordedAt: input.importedAt,
      idempotencyKey: `quickbooks:application-${target.action}:${application.subledger_application_id}:${target.reason ?? input.facts.importBatch.importBatchId}`,
      payload: {
        provider: "quickbooks",
        sourceTransactionId: target.sourceTransactionId,
        importBatchId: input.facts.importBatch.importBatchId,
        ...(target.reason === undefined ? {} : { reason: target.reason })
      }
    });
    await input.client.query(
      `update "erp_financials"."subledger_applications"
set "status" = 'voided', "version" = "version" + 1, "ended_event_id" = $5, "updated_at" = $6
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3
  and "subledger_application_id" = $4 and "status" = 'applied'`,
      [input.facts.company.tenantId, input.companyId, input.facts.source.sourceId,
        application.subledger_application_id, endedEventId, input.importedAt]
    );
  }
  const eventId = stableId("qbo_event", target.documentId, target.action, target.reason ?? input.facts.importBatch.importBatchId);
  await insertLifecycleEvent(input.client, {
    eventId,
    tenantId: input.facts.company.tenantId,
    companyId: input.companyId,
    sourceId: input.facts.source.sourceId,
    aggregateId: target.documentId,
    eventType: `quickbooks_document_${target.action}`,
    occurredAt: target.occurredAt,
    recordedAt: input.importedAt,
    idempotencyKey: `quickbooks:document-${target.action}:${target.documentId}:${target.reason ?? input.facts.importBatch.importBatchId}`,
    payload: {
      provider: "quickbooks",
      sourceTransactionId: target.sourceTransactionId,
      importBatchId: input.facts.importBatch.importBatchId,
      ...(target.reason === undefined ? {} : { reason: target.reason })
    }
  });
  const documentResult = await input.client.query(
    `update "erp_financials"."subledger_documents"
set "open_amount" = 0, "status" = 'voided', "version" = "version" + 1,
  "metadata" = "metadata" || jsonb_build_object('syncAction', $5::text, 'importBatchId', $6::text, 'retirementReason', $7::text),
  "updated_at" = $8
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3
  and "subledger_document_id" = $4 and "status" <> 'voided'`,
    [input.facts.company.tenantId, input.companyId, input.facts.source.sourceId, target.documentId,
      target.action, input.facts.importBatch.importBatchId, target.reason ?? target.action, input.importedAt]
  );
  const postingsResult = await input.client.query(
    `delete from "erp_financials"."ledger_postings" posting
using "erp_financials"."transactions" transaction
where transaction."tenant_id" = $1 and transaction."source_id" = $2
  and transaction."source_transaction_id" = $3
  and posting."tenant_id" = transaction."tenant_id"
  and posting."source_id" = transaction."source_id"
  and posting."transaction_id" = transaction."transaction_id"`,
    [input.facts.company.tenantId, input.facts.source.sourceId, target.sourceTransactionId]
  );
  return { documents: documentResult.rowCount ?? 0, postings: postingsResult.rowCount ?? 0 };
}

function initialDocumentState(
  documentType: ImportedDocumentType,
  originalAmount: string,
  applicationCreditAvailable = false
): { readonly openAmount: string; readonly status: "open" | "settled" } {
  if (documentType === "deposit" && applicationCreditAvailable) {
    return { openAmount: originalAmount, status: "open" };
  }
  if (["refund", "deposit", "transfer", "sales_receipt", "purchase"].includes(documentType)) {
    return { openAmount: "0.00", status: "settled" };
  }
  return { openAmount: originalAmount, status: "open" };
}

function documentLineItemAccount(
  documentType: ImportedDocumentType,
  item: CanonicalAccountingFactSet["items"][number] | undefined
): string | undefined {
  if (item === undefined) return undefined;
  if (documentType === "invoice" || documentType === "credit_memo" || documentType === "refund" || documentType === "sales_receipt") {
    return item.incomeAccountId;
  }
  if (documentType === "vendor_bill" || documentType === "purchase" || documentType === "vendor_credit") {
    return item.expenseAccountId;
  }
  return item.assetAccountId ?? item.expenseAccountId ?? item.incomeAccountId;
}

function importsCommercialDocumentLines(documentType: ImportedDocumentType): boolean {
  // Payment lines describe allocations to other documents; they are persisted
  // as subledger applications below, not duplicated as commercial detail.
  // Deposit lines likewise describe which already-recorded receipts were moved
  // into a bank account. QuickBooks may omit an AccountRef from those lines
  // because the balanced provider GL carries the authoritative Undeposited
  // Funds and bank accounts. Retain the settled deposit header and its canonical
  // ledger postings without inventing an account for an allocation line.
  return documentType !== "customer_payment" &&
    documentType !== "bill_payment" &&
    documentType !== "deposit";
}

function isQuickBooksProviderOnlyNonPostingLine(detailType: string | undefined): boolean {
  return detailType === "SubTotalLineDetail" ||
    detailType === "DescriptionOnly" ||
    detailType === "DescriptionOnlyLineDetail" ||
    detailType === "GroupLineDetail";
}

function importedDocumentType(sourceType: string): ImportedDocumentType | undefined {
  const types: Readonly<Record<string, ImportedDocumentType>> = {
    Invoice: "invoice",
    Payment: "customer_payment",
    CreditMemo: "credit_memo",
    RefundReceipt: "refund",
    Bill: "vendor_bill",
    BillPayment: "bill_payment",
    Deposit: "deposit",
    Transfer: "transfer",
    SalesReceipt: "sales_receipt",
    Purchase: "purchase",
    VendorCredit: "vendor_credit"
  };
  return types[sourceType];
}

function importedApplicationType(sourceType: string): ImportedApplicationType | undefined {
  const types: Readonly<Record<string, ImportedApplicationType>> = {
    Payment: "customer_payment_to_invoice",
    BillPayment: "bill_payment_to_bill",
    CreditMemo: "credit_to_invoice",
    VendorCredit: "vendor_credit_to_bill"
  };
  return types[sourceType];
}

function positiveAmount(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const amount = Math.abs(Number(value));
  return Number.isFinite(amount) && amount > 0 ? amount.toFixed(2) : undefined;
}

function zeroAmount(value: string | undefined): boolean {
  if (value === undefined) return false;
  const amount = Number(value);
  return Number.isFinite(amount) && amount === 0;
}

function quickBooksDocumentProjectionRejectionReasons(
  documentType: ImportedDocumentType,
  normalized: NormalizedQuickBooksLedgerTransaction,
  originalAmount: string
): string[] {
  const rejectionReasons = new Set<string>();
  if (
    importedApplicationType(normalized.sourceTransactionType) !== undefined &&
    normalized.lines.some((line) => (line.linkedTransactions?.length ?? 0) > 1)
  ) {
    rejectionReasons.add("multi_link_amount_ambiguous");
  }

  const openAmountValue = documentType === "customer_payment"
    ? normalized.unappliedAmount
    : documentType === "invoice"
      ? normalized.openAmount
      : documentType === "bill_payment"
        ? normalized.unappliedAmount ?? normalized.openAmount
        : normalized.openAmount ?? normalized.unappliedAmount;
  if (
    openAmountValue === undefined &&
    (documentType === "invoice" || documentType === "customer_payment")
  ) {
    rejectionReasons.add("missing_authoritative_open_amount");
  } else if (openAmountValue !== undefined) {
    const openAmount = Math.abs(Number(openAmountValue));
    const original = Number(originalAmount);
    if (!Number.isFinite(openAmount) || openAmount < 0 || openAmount > original) {
      rejectionReasons.add("invalid_authoritative_open_amount");
    }
  }
  return [...rejectionReasons];
}

type ApplicationOnlyAllocation = {
  readonly sourceDocumentSourceTransactionId: string;
  readonly targetDocumentSourceTransactionId: string;
  readonly amount: string;
};

type ApplicationOnlyProjection = {
  readonly eligible: true;
  readonly sourceTransactionType: "BillPayment" | "Payment";
  readonly applicationType: "credit_to_invoice" | "vendor_credit_to_bill";
  readonly projectionKind:
    | "customer_credit_application"
    | "customer_deposit_application"
    | "vendor_credit_application";
  readonly allocations: readonly ApplicationOnlyAllocation[];
  readonly currencyCode?: string;
  readonly transactionDate: string;
  readonly sourceUpdatedAt?: string;
  readonly diagnostic: QuickBooksSubledgerProjectionDiagnostic;
};

type RejectedZeroTotalApplicationProjection = {
  readonly eligible: false;
  readonly allocations: readonly [];
  readonly diagnostic: QuickBooksSubledgerProjectionDiagnostic;
};

function quickBooksZeroTotalProviderOffsetBillPayment(
  transaction: NormalizedQuickBooksLedgerTransaction,
  missingBalancedJournal: boolean,
  projectableDocumentSourceIds: ReadonlySet<string>
): boolean {
  if (
    transaction.sourceTransactionType !== "BillPayment" ||
    transaction.totalAmount === undefined ||
    Number(transaction.totalAmount) !== 0 ||
    !missingBalancedJournal ||
    transaction.lines.length === 0
  ) {
    return false;
  }

  let offsetDocumentTotal = 0;
  let vendorCreditTotal = 0;
  for (const line of transaction.lines) {
    const amount = line.sourceAmount === undefined ? Number.NaN : Math.abs(Number(line.sourceAmount));
    const linked = line.linkedTransactions ?? [];
    const reference = linked.length === 1 ? linked[0] : undefined;
    if (
      !Number.isFinite(amount) ||
      amount <= 0 ||
      reference === undefined ||
      !projectableDocumentSourceIds.has(reference.sourceTransactionId)
    ) {
      return false;
    }
    if (reference.sourceTransactionType === "VendorCredit") {
      vendorCreditTotal += amount;
    } else if (
      reference.sourceTransactionType === "Purchase" ||
      reference.sourceTransactionType === "Deposit"
    ) {
      offsetDocumentTotal += amount;
    } else {
      return false;
    }
  }

  return offsetDocumentTotal > 0 &&
    vendorCreditTotal > 0 &&
    Math.abs(offsetDocumentTotal - vendorCreditTotal) <= 0.005;
}

function quickBooksZeroTotalBillPaymentProjection(
  transaction: NormalizedQuickBooksLedgerTransaction,
  missingBalancedJournal: boolean,
  projectableDocumentSourceIds: ReadonlySet<string>
): ApplicationOnlyProjection | RejectedZeroTotalApplicationProjection | undefined {
  if (
    transaction.sourceTransactionType !== "BillPayment" ||
    transaction.totalAmount === undefined ||
    Number(transaction.totalAmount) !== 0 ||
    !missingBalancedJournal
  ) {
    return undefined;
  }

  type LinkedAmount = {
    readonly sourceTransactionId: string;
    readonly amount: number;
    readonly lineNumber: number;
  };
  const bills: LinkedAmount[] = [];
  const vendorCredits: LinkedAmount[] = [];
  const typeCounts = new Map<string, number>();
  let otherLinkedAmount = 0;
  let linkedTransactionCount = 0;
  let nonZeroLineCount = 0;
  let unlinkedNonZeroLineCount = 0;
  let multiLinkedLineCount = 0;
  let missingLinkedAmountCount = 0;

  for (const line of transaction.lines) {
    const linked = line.linkedTransactions ?? [];
    const amount = line.sourceAmount === undefined ? undefined : Math.abs(Number(line.sourceAmount));
    const hasPositiveAmount = amount !== undefined && Number.isFinite(amount) && amount > 0;
    if (hasPositiveAmount) nonZeroLineCount += 1;
    if (linked.length === 0 && hasPositiveAmount) unlinkedNonZeroLineCount += 1;
    if (linked.length > 1) multiLinkedLineCount += 1;

    for (const reference of linked) {
      linkedTransactionCount += 1;
      const type = reference.sourceTransactionType ?? "Unknown";
      typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
      if (!hasPositiveAmount || linked.length !== 1) {
        missingLinkedAmountCount += 1;
        continue;
      }
      const evidence = {
        sourceTransactionId: reference.sourceTransactionId,
        amount,
        lineNumber: line.lineNumber
      };
      if (type === "Bill") bills.push(evidence);
      else if (type === "VendorCredit") vendorCredits.push(evidence);
      else otherLinkedAmount += amount;
    }
  }

  bills.sort(compareLinkedAmount);
  vendorCredits.sort(compareLinkedAmount);
  const billTotal = bills.reduce((sum, value) => sum + value.amount, 0);
  const vendorCreditTotal = vendorCredits.reduce((sum, value) => sum + value.amount, 0);
  const missingLinkedTransactionIds = [...bills, ...vendorCredits]
    .filter((value) => !projectableDocumentSourceIds.has(value.sourceTransactionId))
    .map((value) => value.sourceTransactionId)
    .filter((value, index, values) => values.indexOf(value) === index)
    .slice(0, 20);
  const rejectionReasons = [
    ...(linkedTransactionCount === 0 ? ["no_linked_transactions"] : []),
    ...(bills.length === 0 ? ["no_bill_link"] : []),
    ...(vendorCredits.length === 0 ? ["no_vendor_credit_link"] : []),
    ...(otherLinkedAmount !== 0 || [...typeCounts.keys()].some((type) => type !== "Bill" && type !== "VendorCredit")
      ? ["unsupported_linked_transaction_type"]
      : []),
    ...(unlinkedNonZeroLineCount > 0 ? ["unlinked_nonzero_line"] : []),
    ...(multiLinkedLineCount > 0 ? ["multi_link_amount_ambiguous"] : []),
    ...(missingLinkedAmountCount > 0 ? ["missing_per_link_amount"] : []),
    ...(Math.abs(billTotal - vendorCreditTotal) > 0.005 ? ["bill_credit_totals_mismatch"] : []),
    ...(missingLinkedTransactionIds.length > 0 ? ["missing_linked_document"] : [])
  ];

  const diagnostic: QuickBooksSubledgerProjectionDiagnostic = {
    sourceTransactionType: transaction.sourceTransactionType,
    sourceTransactionId: transaction.sourceTransactionId,
    missingBalancedJournal,
    totalAmountState: "zero",
    totalAmount: transaction.totalAmount,
    ...(transaction.openAmount === undefined ? {} : { openAmount: transaction.openAmount }),
    ...(transaction.unappliedAmount === undefined ? {} : { unappliedAmount: transaction.unappliedAmount }),
    projectionKind: rejectionReasons.length === 0
      ? "vendor_credit_application"
      : "unclassified_zero_total",
    rejectionReasons,
    lineCount: transaction.lines.length,
    linkedTransactionCount,
    linkedTransactionTypes: [...typeCounts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([type, count]) => ({ type, count })),
    nonZeroLineCount,
    unlinkedNonZeroLineCount,
    multiLinkedLineCount,
    missingLinkedAmountCount,
    billLinkedAmountTotal: billTotal.toFixed(2),
    vendorCreditLinkedAmountTotal: vendorCreditTotal.toFixed(2),
    invoiceLinkedAmountTotal: linkedAmountTotal(transaction, "Invoice"),
    creditMemoLinkedAmountTotal: linkedAmountTotal(transaction, "CreditMemo"),
    otherLinkedAmountTotal: otherLinkedAmount.toFixed(2),
    missingLinkedTransactionIds,
    memoIndicatesVoid: transaction.memo !== undefined && /\bvoid(?:ed)?\b/i.test(transaction.memo)
  };
  if (rejectionReasons.length > 0) {
    return { eligible: false, allocations: [], diagnostic };
  }

  const allocations: ApplicationOnlyAllocation[] = [];
  const remainingBills = bills.map((value) => ({ ...value }));
  const remainingCredits = vendorCredits.map((value) => ({ ...value }));
  let billIndex = 0;
  let creditIndex = 0;
  while (billIndex < remainingBills.length && creditIndex < remainingCredits.length) {
    const bill = remainingBills[billIndex];
    const credit = remainingCredits[creditIndex];
    if (bill === undefined || credit === undefined) break;
    const amount = Math.min(bill.amount, credit.amount);
    if (amount <= 0) break;
    allocations.push({
      sourceDocumentSourceTransactionId: credit.sourceTransactionId,
      targetDocumentSourceTransactionId: bill.sourceTransactionId,
      amount: amount.toFixed(2)
    });
    bill.amount -= amount;
    credit.amount -= amount;
    if (bill.amount <= 0.005) billIndex += 1;
    if (credit.amount <= 0.005) creditIndex += 1;
  }
  return {
    eligible: true,
    sourceTransactionType: "BillPayment",
    applicationType: "vendor_credit_to_bill",
    projectionKind: "vendor_credit_application",
    allocations,
    ...(transaction.currencyCode === undefined ? {} : { currencyCode: transaction.currencyCode }),
    transactionDate: transaction.transactionDate,
    ...(transaction.sourceUpdatedAt === undefined ? {} : { sourceUpdatedAt: transaction.sourceUpdatedAt }),
    diagnostic
  };
}

function quickBooksZeroTotalCustomerCreditProjection(
  transaction: NormalizedQuickBooksLedgerTransaction,
  missingBalancedJournal: boolean,
  projectableDocumentSourceIds: ReadonlySet<string>
): ApplicationOnlyProjection | RejectedZeroTotalApplicationProjection | undefined {
  if (
    transaction.sourceTransactionType !== "Payment" ||
    transaction.totalAmount === undefined ||
    Number(transaction.totalAmount) !== 0 ||
    !missingBalancedJournal
  ) {
    return undefined;
  }

  type LinkedAmount = {
    readonly sourceTransactionId: string;
    readonly amount: number;
    readonly lineNumber: number;
  };
  const invoices: LinkedAmount[] = [];
  const creditMemos: LinkedAmount[] = [];
  const deposits: LinkedAmount[] = [];
  const typeCounts = new Map<string, number>();
  let otherLinkedAmount = 0;
  let linkedTransactionCount = 0;
  let nonZeroLineCount = 0;
  let unlinkedNonZeroLineCount = 0;
  let multiLinkedLineCount = 0;
  let missingLinkedAmountCount = 0;

  for (const line of transaction.lines) {
    const linked = line.linkedTransactions ?? [];
    const amount = line.sourceAmount === undefined ? undefined : Math.abs(Number(line.sourceAmount));
    const hasPositiveAmount = amount !== undefined && Number.isFinite(amount) && amount > 0;
    if (hasPositiveAmount) nonZeroLineCount += 1;
    if (linked.length === 0 && hasPositiveAmount) unlinkedNonZeroLineCount += 1;
    if (linked.length > 1) multiLinkedLineCount += 1;

    for (const reference of linked) {
      linkedTransactionCount += 1;
      const type = reference.sourceTransactionType ?? "Unknown";
      typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
      if (!hasPositiveAmount || linked.length !== 1) {
        missingLinkedAmountCount += 1;
        continue;
      }
      const evidence = {
        sourceTransactionId: reference.sourceTransactionId,
        amount,
        lineNumber: line.lineNumber
      };
      if (type === "Invoice") invoices.push(evidence);
      else if (type === "CreditMemo") creditMemos.push(evidence);
      else if (type === "Deposit") deposits.push(evidence);
      else otherLinkedAmount += amount;
    }
  }

  invoices.sort(compareLinkedAmount);
  creditMemos.sort(compareLinkedAmount);
  deposits.sort(compareLinkedAmount);
  const invoiceTotal = invoices.reduce((sum, value) => sum + value.amount, 0);
  const creditMemoTotal = creditMemos.reduce((sum, value) => sum + value.amount, 0);
  const depositTotal = deposits.reduce((sum, value) => sum + value.amount, 0);
  const depositApplication = deposits.length > 0 && creditMemos.length === 0;
  const credits = depositApplication ? deposits : creditMemos;
  const creditTotal = depositApplication ? depositTotal : creditMemoTotal;
  const missingLinkedTransactionIds = [...invoices, ...credits]
    .filter((value) => !projectableDocumentSourceIds.has(value.sourceTransactionId))
    .map((value) => value.sourceTransactionId)
    .filter((value, index, values) => values.indexOf(value) === index)
    .slice(0, 20);
  const unappliedAmount = transaction.unappliedAmount === undefined
    ? undefined
    : Number(transaction.unappliedAmount);
  const memoIndicatesVoid = transaction.memo !== undefined && /\bvoid(?:ed)?\b/i.test(transaction.memo);
  const rejectionReasons = [
    ...(linkedTransactionCount === 0 ? ["no_linked_transactions"] : []),
    ...(invoices.length === 0 ? ["no_invoice_link"] : []),
    ...(credits.length === 0 ? [depositApplication ? "no_deposit_link" : "no_credit_memo_link"] : []),
    ...(deposits.length > 0 && creditMemos.length > 0 ? ["mixed_credit_source_types"] : []),
    ...(otherLinkedAmount !== 0 || [...typeCounts.keys()].some((type) =>
      type !== "Invoice" && type !== (depositApplication ? "Deposit" : "CreditMemo"))
      ? ["unsupported_linked_transaction_type"]
      : []),
    ...(transaction.lines.length === 0 ||
      transaction.lines.length !== nonZeroLineCount ||
      transaction.lines.length !== linkedTransactionCount ||
      invoices.length === 0 ||
      credits.length === 0
      ? ["incomplete_application_lines"]
      : []),
    ...(unlinkedNonZeroLineCount > 0 ? ["unlinked_nonzero_line"] : []),
    ...(multiLinkedLineCount > 0 ? ["multi_link_amount_ambiguous"] : []),
    ...(missingLinkedAmountCount > 0 ? ["missing_per_link_amount"] : []),
    ...(Math.abs(invoiceTotal - creditTotal) > 0.005 ? ["invoice_credit_totals_mismatch"] : []),
    ...(transaction.unappliedAmount === undefined || !Number.isFinite(unappliedAmount) || unappliedAmount !== 0
      ? ["invalid_unapplied_amount"]
      : []),
    ...(memoIndicatesVoid ? ["memo_indicates_void"] : []),
    ...(missingLinkedTransactionIds.length > 0 ? ["missing_linked_document"] : [])
  ];
  const diagnostic: QuickBooksSubledgerProjectionDiagnostic = {
    sourceTransactionType: transaction.sourceTransactionType,
    sourceTransactionId: transaction.sourceTransactionId,
    missingBalancedJournal,
    totalAmountState: "zero",
    totalAmount: transaction.totalAmount,
    ...(transaction.openAmount === undefined ? {} : { openAmount: transaction.openAmount }),
    ...(transaction.unappliedAmount === undefined ? {} : { unappliedAmount: transaction.unappliedAmount }),
    projectionKind: rejectionReasons.length === 0
      ? depositApplication ? "customer_deposit_application" : "customer_credit_application"
      : "unclassified_zero_total",
    rejectionReasons,
    lineCount: transaction.lines.length,
    linkedTransactionCount,
    linkedTransactionTypes: [...typeCounts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([type, count]) => ({ type, count })),
    nonZeroLineCount,
    unlinkedNonZeroLineCount,
    multiLinkedLineCount,
    missingLinkedAmountCount,
    billLinkedAmountTotal: linkedAmountTotal(transaction, "Bill"),
    vendorCreditLinkedAmountTotal: linkedAmountTotal(transaction, "VendorCredit"),
    invoiceLinkedAmountTotal: invoiceTotal.toFixed(2),
    creditMemoLinkedAmountTotal: creditMemoTotal.toFixed(2),
    otherLinkedAmountTotal: (otherLinkedAmount + (depositApplication ? 0 : depositTotal)).toFixed(2),
    missingLinkedTransactionIds,
    memoIndicatesVoid
  };
  if (rejectionReasons.length > 0) {
    return { eligible: false, allocations: [], diagnostic };
  }

  const allocations: ApplicationOnlyAllocation[] = [];
  const remainingInvoices = invoices.map((value) => ({ ...value }));
  const remainingCredits = credits.map((value) => ({ ...value }));
  let invoiceIndex = 0;
  let creditIndex = 0;
  while (invoiceIndex < remainingInvoices.length && creditIndex < remainingCredits.length) {
    const invoice = remainingInvoices[invoiceIndex];
    const creditMemo = remainingCredits[creditIndex];
    if (invoice === undefined || creditMemo === undefined) break;
    const amount = Math.min(invoice.amount, creditMemo.amount);
    if (amount <= 0) break;
    allocations.push({
      sourceDocumentSourceTransactionId: creditMemo.sourceTransactionId,
      targetDocumentSourceTransactionId: invoice.sourceTransactionId,
      amount: amount.toFixed(2)
    });
    invoice.amount -= amount;
    creditMemo.amount -= amount;
    if (invoice.amount <= 0.005) invoiceIndex += 1;
    if (creditMemo.amount <= 0.005) creditIndex += 1;
  }
  return {
    eligible: true,
    sourceTransactionType: "Payment",
    applicationType: "credit_to_invoice",
    projectionKind: depositApplication ? "customer_deposit_application" : "customer_credit_application",
    allocations,
    ...(transaction.currencyCode === undefined ? {} : { currencyCode: transaction.currencyCode }),
    transactionDate: transaction.transactionDate,
    ...(transaction.sourceUpdatedAt === undefined ? {} : { sourceUpdatedAt: transaction.sourceUpdatedAt }),
    diagnostic
  };
}

function compareLinkedAmount(
  left: { readonly sourceTransactionId: string; readonly lineNumber: number },
  right: { readonly sourceTransactionId: string; readonly lineNumber: number }
): number {
  return left.lineNumber - right.lineNumber || left.sourceTransactionId.localeCompare(right.sourceTransactionId);
}

function quickBooksSubledgerProjectionDiagnostic(
  transaction: NormalizedQuickBooksLedgerTransaction,
  missingBalancedJournal: boolean
): QuickBooksSubledgerProjectionDiagnostic {
  const amount = transaction.totalAmount === undefined ? undefined : Number(transaction.totalAmount);
  const totalAmountState = transaction.totalAmount === undefined
    ? "missing"
    : !Number.isFinite(amount)
      ? "invalid"
      : amount === 0
        ? "zero"
        : "positive";
  return {
    sourceTransactionType: transaction.sourceTransactionType,
    sourceTransactionId: transaction.sourceTransactionId,
    missingBalancedJournal,
    totalAmountState,
    ...(transaction.totalAmount === undefined ? {} : { totalAmount: transaction.totalAmount }),
    ...(transaction.openAmount === undefined ? {} : { openAmount: transaction.openAmount }),
    ...(transaction.unappliedAmount === undefined ? {} : { unappliedAmount: transaction.unappliedAmount }),
    projectionKind: "canonical_document",
    rejectionReasons: [
      ...(missingBalancedJournal ? ["missing_balanced_journal"] : []),
      ...(totalAmountState !== "positive" ? ["non_positive_total"] : [])
    ],
    lineCount: transaction.lines.length,
    linkedTransactionCount: transaction.lines.reduce(
      (count, line) => count + (line.linkedTransactions?.length ?? 0),
      0
    ),
    linkedTransactionTypes: [...transaction.lines.reduce((counts, line) => {
      for (const linked of line.linkedTransactions ?? []) {
        const type = linked.sourceTransactionType ?? "Unknown";
        counts.set(type, (counts.get(type) ?? 0) + 1);
      }
      return counts;
    }, new Map<string, number>()).entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([type, count]) => ({ type, count })),
    nonZeroLineCount: transaction.lines.filter((line) => {
      if (line.sourceAmount === undefined) return false;
      const lineAmount = Number(line.sourceAmount);
      return Number.isFinite(lineAmount) && lineAmount !== 0;
    }).length,
    unlinkedNonZeroLineCount: transaction.lines.filter((line) => {
      const amount = line.sourceAmount === undefined ? undefined : Number(line.sourceAmount);
      return (line.linkedTransactions?.length ?? 0) === 0 &&
        amount !== undefined && Number.isFinite(amount) && amount !== 0;
    }).length,
    multiLinkedLineCount: transaction.lines.filter((line) => (line.linkedTransactions?.length ?? 0) > 1).length,
    missingLinkedAmountCount: transaction.lines.reduce(
      (count, line) => count + (line.linkedTransactions ?? []).filter(() => positiveAmount(line.sourceAmount) === undefined).length,
      0
    ),
    billLinkedAmountTotal: linkedAmountTotal(transaction, "Bill"),
    vendorCreditLinkedAmountTotal: linkedAmountTotal(transaction, "VendorCredit"),
    invoiceLinkedAmountTotal: linkedAmountTotal(transaction, "Invoice"),
    creditMemoLinkedAmountTotal: linkedAmountTotal(transaction, "CreditMemo"),
    otherLinkedAmountTotal: linkedAmountTotal(transaction, "other"),
    missingLinkedTransactionIds: [],
    memoIndicatesVoid: transaction.memo !== undefined && /\bvoid(?:ed)?\b/i.test(transaction.memo)
  };
}

function linkedAmountTotal(
  transaction: NormalizedQuickBooksLedgerTransaction,
  requestedType: "Bill" | "CreditMemo" | "Invoice" | "VendorCredit" | "other"
): string {
  const total = transaction.lines.reduce((sum, line) => {
    const linked = line.linkedTransactions ?? [];
    if (linked.length !== 1 || line.sourceAmount === undefined) return sum;
    const amount = Math.abs(Number(line.sourceAmount));
    if (!Number.isFinite(amount)) return sum;
    const type = linked[0]?.sourceTransactionType ?? "Unknown";
    const matches = requestedType === "other"
      ? type !== "Bill" && type !== "VendorCredit"
      : type === requestedType;
    return matches ? sum + amount : sum;
  }, 0);
  return total.toFixed(2);
}

function reportedQuickBooksOpenAmount(
  documentType: ImportedDocumentType,
  normalized: NormalizedQuickBooksLedgerTransaction,
  originalAmount: string
): string | undefined {
  const value = documentType === "customer_payment"
    ? normalized.unappliedAmount
    : documentType === "invoice"
      ? normalized.openAmount
      : documentType === "bill_payment"
        ? normalized.unappliedAmount ?? normalized.openAmount
        : normalized.openAmount ?? normalized.unappliedAmount;
  if (value === undefined) {
    if (documentType === "invoice" || documentType === "customer_payment") {
      const requiredField = documentType === "invoice" ? "Balance" : "UnappliedAmt";
      throw new Error(
        `QuickBooks ${normalized.sourceTransactionType} ${normalized.sourceTransactionId} is missing authoritative ${requiredField}; refusing to import an unreliable A/R balance`
      );
    }
    return undefined;
  }
  const amount = Math.abs(Number(value));
  const original = Number(originalAmount);
  if (!Number.isFinite(amount) || amount < 0 || amount > original) {
    throw new Error(
      `QuickBooks ${normalized.sourceTransactionType} ${normalized.sourceTransactionId} reported open amount ${value} outside its original amount ${originalAmount}`
    );
  }
  return amount.toFixed(2);
}

function commercialLineAmounts(
  amountValue: string,
  quantityValue: string | undefined,
  unitAmountValue: string | undefined
): { readonly quantity: string; readonly unitAmount: string; readonly discountAmount: string; readonly taxAmount: string } {
  const amount = Number(amountValue);
  const quantity = Number(quantityValue);
  const unitAmount = Number(unitAmountValue);
  if (Number.isFinite(quantity) && quantity > 0 && Number.isFinite(unitAmount) && unitAmount >= 0) {
    const gross = quantity * unitAmount;
    return {
      quantity: quantity.toFixed(2),
      unitAmount: unitAmount.toFixed(2),
      discountAmount: Math.max(gross - amount, 0).toFixed(2),
      taxAmount: Math.max(amount - gross, 0).toFixed(2)
    };
  }
  return { quantity: "1.00", unitAmount: amount.toFixed(2), discountAmount: "0.00", taxAmount: "0.00" };
}

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 24)}`;
}

async function insertLifecycleEvent(client: PostgresQueryClient, input: {
  readonly eventId: string;
  readonly tenantId: string;
  readonly companyId: string;
  readonly sourceId: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly idempotencyKey: string;
  readonly payload: JsonValue;
}): Promise<void> {
  const payload = JSON.stringify(input.payload);
  await client.query(
    `insert into "erp_financials"."financial_lifecycle_events" (
      "event_id", "tenant_id", "company_id", "source_id", "aggregate_type", "aggregate_id",
      "event_type", "actor_ref", "request_id", "correlation_id", "reason_code",
      "occurred_at", "recorded_at", "idempotency_key", "payload_checksum", "payload"
    ) values ($1,$2,$3,$4,'quickbooks_import',$5,$6,'system:quickbooks-import',$7,$7,
      'quickbooks_historical_import',$8,$9,$10,$11,$12::jsonb)
    on conflict ("tenant_id", "company_id", "source_id", "idempotency_key") do nothing`,
    [
      input.eventId,
      input.tenantId,
      input.companyId,
      input.sourceId,
      input.aggregateId,
      input.eventType,
      input.idempotencyKey,
      input.occurredAt,
      input.recordedAt,
      input.idempotencyKey,
      createHash("sha256").update(payload).digest("hex"),
      payload
    ]
  );
}
