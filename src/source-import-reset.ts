import { lockCustomerPaymentCorrectionSource } from "./customer-payment-correction.js";
import type { PostgresQueryClient } from "./postgres-storage.js";

/**
 * Scope for retiring one external import source without changing its identity
 * or the reporting-book configuration that refers to it.
 */
export type ResetSourceImportStateInput = {
  readonly tenantId: string;
  readonly companyId: string;
  readonly sourceId: string;
};

/**
 * Fixed, bounded operational counts. No deleted row, provider payload,
 * connection reference, cursor, or financial amount is returned.
 */
export type SanitizedSourceResetCounts = {
  readonly reportSnapshotLinesDeleted: number;
  readonly reportSnapshotTotalsDeleted: number;
  readonly reportSnapshotsDeleted: number;
  readonly freshnessRowsDeleted: number;
  readonly rollupBucketsDeleted: number;
  readonly financialOutboxEventsDeleted: number;
  readonly bankReconciliationMatchesDeleted: number;
  readonly bankStatementLinesDeleted: number;
  readonly invoiceVoidsDeleted: number;
  readonly deliveryEventsDeleted: number;
  readonly invoiceDraftLinesDeleted: number;
  readonly invoiceDraftsDeleted: number;
  readonly billPaymentDisbursementsDeleted: number;
  readonly subledgerApplicationsDeleted: number;
  readonly subledgerDocumentLinesDeleted: number;
  readonly subledgerDocumentsDeleted: number;
  readonly journalEntryLinksDeleted: number;
  readonly paymentApplicationsDeleted: number;
  readonly matchDecisionsDeleted: number;
  readonly matchCandidatesDeleted: number;
  readonly ledgerPostingsDeleted: number;
  readonly transactionLinesDeleted: number;
  readonly transactionsDeleted: number;
  readonly importBatchesDeleted: number;
  readonly syncCheckpointsDeleted: number;
  readonly lifecycleEventsDeleted: number;
  readonly accountsRetired: number;
  readonly partiesRetired: number;
  readonly itemsRetired: number;
  readonly dimensionsRetired: number;
  readonly sourceSyncStateCleared: number;
  readonly countsCapped: boolean;
};

/** Largest value exposed for any one count. */
export const SOURCE_RESET_COUNT_LIMIT = 1_000_000;

type ResetCountKey = Exclude<keyof SanitizedSourceResetCounts, "countsCapped">;

type ScopeRow = {
  readonly source_system: string;
  readonly provider_environment: string;
  readonly binding_count: number | string;
};

type TransactionIdRow = { readonly transaction_id: string };

/**
 * Atomically removes package-owned runtime state for one external import
 * source. The supplied client MUST already be inside an explicit transaction;
 * the function verifies that boundary before it mutates anything.
 *
 * Source/company identity, reporting books, source bindings, account mappings,
 * posting rules, fiscal controls, and their lifecycle evidence are preserved.
 * Master records are retired so stable reporting-book mappings remain valid
 * and a subsequent import can reactivate the same canonical identities.
 */
export async function resetSourceImportState(
  client: PostgresQueryClient,
  input: ResetSourceImportStateInput
): Promise<SanitizedSourceResetCounts> {
  assertResetInput(input);
  await assertExplicitTransaction(client);
  // Serialize with imports, corrections and collection guards before row locks.
  await lockCustomerPaymentCorrectionSource(client, input.tenantId, input.sourceId);

  const scope = await client.query<ScopeRow>(
    `select source."source_system", source."provider_environment",
       (select count(*)::int
        from "erp_financials"."company_sources" all_bindings
        where all_bindings."tenant_id" = source."tenant_id"
          and all_bindings."source_id" = source."source_id") as "binding_count"
from "erp_financials"."accounting_sources" source
join "erp_financials"."company_sources" binding
  on binding."tenant_id" = source."tenant_id" and binding."source_id" = source."source_id"
where source."tenant_id" = $1 and binding."company_id" = $2 and source."source_id" = $3
for update of source, binding`,
    [input.tenantId, input.companyId, input.sourceId]
  );
  const scopeRow = scope.rows[0];
  if (scopeRow === undefined) {
    throw new Error("resetSourceImportState source is not bound to the requested tenant and company");
  }
  if (Number(scopeRow.binding_count) !== 1) {
    throw new Error("resetSourceImportState refuses a source shared by more than one company");
  }
  if (scopeRow.source_system === "native_erp" || scopeRow.provider_environment === "native") {
    throw new Error("resetSourceImportState refuses native ERP sources");
  }

  await client.query(
    `select pg_advisory_xact_lock(hashtextextended($1, 0)),
       set_config('erp_financials.source_import_reset_tenant_id', $2, true),
       set_config('erp_financials.source_import_reset_company_id', $3, true),
       set_config('erp_financials.source_import_reset_source_id', $4, true)`,
    [JSON.stringify([input.tenantId, input.companyId, input.sourceId]), input.tenantId, input.companyId, input.sourceId]
  );

  const rawCounts = new Map<ResetCountKey, number>();
  const remove = async (key: ResetCountKey, table: string, companyScoped = true): Promise<void> => {
    const companyPredicate = companyScoped ? ` and "company_id" = $2` : "";
    const parameters = companyScoped
      ? [input.tenantId, input.companyId, input.sourceId]
      : [input.tenantId, input.sourceId];
    const sourceParameter = companyScoped ? 3 : 2;
    const result = await client.query(
      `delete from "erp_financials"."${table}"
where "tenant_id" = $1${companyPredicate} and "source_id" = $${String(sourceParameter)}`,
      parameters
    );
    rawCounts.set(key, result.rowCount ?? 0);
  };

  await remove("reportSnapshotLinesDeleted", "report_snapshot_lines");
  await remove("reportSnapshotTotalsDeleted", "report_snapshot_totals");
  await remove("reportSnapshotsDeleted", "report_snapshots");
  await remove("freshnessRowsDeleted", "report_freshness");
  await remove("rollupBucketsDeleted", "rollup_buckets");
  await remove("financialOutboxEventsDeleted", "financial_outbox");
  await remove("bankReconciliationMatchesDeleted", "bank_reconciliation_matches");
  await remove("bankStatementLinesDeleted", "bank_statement_lines");
  await remove("invoiceVoidsDeleted", "invoice_voids");
  await remove("deliveryEventsDeleted", "subledger_document_delivery_events");
  await remove("invoiceDraftLinesDeleted", "invoice_draft_lines");
  await remove("invoiceDraftsDeleted", "invoice_drafts");
  await remove("billPaymentDisbursementsDeleted", "bill_payment_disbursements");
  await remove("subledgerApplicationsDeleted", "subledger_applications");
  await remove("subledgerDocumentLinesDeleted", "subledger_document_lines");
  await remove("subledgerDocumentsDeleted", "subledger_documents");
  await remove("journalEntryLinksDeleted", "journal_entry_links");
  await remove("paymentApplicationsDeleted", "payment_applications", false);
  await remove("matchDecisionsDeleted", "transaction_match_decisions", false);
  await remove("matchCandidatesDeleted", "transaction_match_candidates", false);
  await remove("ledgerPostingsDeleted", "ledger_postings", false);
  await remove("transactionLinesDeleted", "transaction_lines", false);
  await remove("transactionsDeleted", "transactions", false);
  await remove("importBatchesDeleted", "import_batches", false);
  await remove("syncCheckpointsDeleted", "sync_checkpoints", false);

  const lifecycleResult = await client.query(
    `with recursive "preserved_events" ("event_id") as (
  select controls."last_event_id"
  from "erp_financials"."accounting_book_controls" controls
  where controls."tenant_id" = $1 and controls."company_id" = $2 and controls."source_id" = $3
  union
  select periods."close_event_id"
  from "erp_financials"."fiscal_periods" periods
  where periods."tenant_id" = $1 and periods."company_id" = $2 and periods."source_id" = $3
    and periods."close_event_id" is not null
  union
  select periods."reopen_event_id"
  from "erp_financials"."fiscal_periods" periods
  where periods."tenant_id" = $1 and periods."company_id" = $2 and periods."source_id" = $3
    and periods."reopen_event_id" is not null
  union
  select event."prior_event_id"
  from "erp_financials"."financial_lifecycle_events" event
  join "preserved_events" preserved on preserved."event_id" = event."event_id"
  where event."tenant_id" = $1 and event."company_id" = $2 and event."source_id" = $3
    and event."prior_event_id" is not null
)
delete from "erp_financials"."financial_lifecycle_events" event
where event."tenant_id" = $1 and event."company_id" = $2 and event."source_id" = $3
  and not exists (select 1 from "preserved_events" preserved where preserved."event_id" = event."event_id")`,
    [input.tenantId, input.companyId, input.sourceId]
  );
  rawCounts.set("lifecycleEventsDeleted", lifecycleResult.rowCount ?? 0);

  await retire(rawCounts, client, "accountsRetired", "accounts", input);
  await retire(rawCounts, client, "partiesRetired", "parties", input);
  await retire(rawCounts, client, "itemsRetired", "items", input);
  await retire(rawCounts, client, "dimensionsRetired", "accounting_dimensions", input);

  const sourceResult = await client.query(
    `update "erp_financials"."accounting_sources"
set "import_batch_id" = null, "checkpoint_id" = null, "latest_synced_at" = null, "status" = 'pending'
where "tenant_id" = $1 and "source_id" = $2
  and ("import_batch_id" is not null or "checkpoint_id" is not null
    or "latest_synced_at" is not null or "status" <> 'pending')`,
    [input.tenantId, input.sourceId]
  );
  rawCounts.set("sourceSyncStateCleared", sourceResult.rowCount ?? 0);

  await client.query(
    `select set_config('erp_financials.source_import_reset_tenant_id', '', true),
       set_config('erp_financials.source_import_reset_company_id', '', true),
       set_config('erp_financials.source_import_reset_source_id', '', true)`
  );

  return sanitizeCounts(rawCounts);
}

async function assertExplicitTransaction(client: PostgresQueryClient): Promise<void> {
  const first = await client.query<TransactionIdRow>(`select txid_current()::text as "transaction_id"`);
  const second = await client.query<TransactionIdRow>(`select txid_current()::text as "transaction_id"`);
  if (first.rows[0]?.transaction_id === undefined || first.rows[0].transaction_id !== second.rows[0]?.transaction_id) {
    throw new Error("resetSourceImportState requires an explicit transaction client");
  }
}

async function retire(
  counts: Map<ResetCountKey, number>,
  client: PostgresQueryClient,
  key: ResetCountKey,
  table: string,
  input: ResetSourceImportStateInput
): Promise<void> {
  const result = await client.query(
    `update "erp_financials"."${table}" set "active" = false
where "tenant_id" = $1 and "source_id" = $2 and "active" = true`,
    [input.tenantId, input.sourceId]
  );
  counts.set(key, result.rowCount ?? 0);
}

function assertResetInput(input: ResetSourceImportStateInput): void {
  if (input.tenantId.trim() === "" || input.companyId.trim() === "" || input.sourceId.trim() === "") {
    throw new Error("resetSourceImportState requires tenantId, companyId, and sourceId");
  }
}

function sanitizeCounts(rawCounts: ReadonlyMap<ResetCountKey, number>): SanitizedSourceResetCounts {
  let countsCapped = false;
  const count = (key: ResetCountKey): number => {
    const raw = rawCounts.get(key) ?? 0;
    const safe = Number.isSafeInteger(raw) && raw > 0 ? raw : 0;
    if (safe > SOURCE_RESET_COUNT_LIMIT) countsCapped = true;
    return Math.min(safe, SOURCE_RESET_COUNT_LIMIT);
  };
  const result = {
    reportSnapshotLinesDeleted: count("reportSnapshotLinesDeleted"),
    reportSnapshotTotalsDeleted: count("reportSnapshotTotalsDeleted"),
    reportSnapshotsDeleted: count("reportSnapshotsDeleted"),
    freshnessRowsDeleted: count("freshnessRowsDeleted"),
    rollupBucketsDeleted: count("rollupBucketsDeleted"),
    financialOutboxEventsDeleted: count("financialOutboxEventsDeleted"),
    bankReconciliationMatchesDeleted: count("bankReconciliationMatchesDeleted"),
    bankStatementLinesDeleted: count("bankStatementLinesDeleted"),
    invoiceVoidsDeleted: count("invoiceVoidsDeleted"),
    deliveryEventsDeleted: count("deliveryEventsDeleted"),
    invoiceDraftLinesDeleted: count("invoiceDraftLinesDeleted"),
    invoiceDraftsDeleted: count("invoiceDraftsDeleted"),
    billPaymentDisbursementsDeleted: count("billPaymentDisbursementsDeleted"),
    subledgerApplicationsDeleted: count("subledgerApplicationsDeleted"),
    subledgerDocumentLinesDeleted: count("subledgerDocumentLinesDeleted"),
    subledgerDocumentsDeleted: count("subledgerDocumentsDeleted"),
    journalEntryLinksDeleted: count("journalEntryLinksDeleted"),
    paymentApplicationsDeleted: count("paymentApplicationsDeleted"),
    matchDecisionsDeleted: count("matchDecisionsDeleted"),
    matchCandidatesDeleted: count("matchCandidatesDeleted"),
    ledgerPostingsDeleted: count("ledgerPostingsDeleted"),
    transactionLinesDeleted: count("transactionLinesDeleted"),
    transactionsDeleted: count("transactionsDeleted"),
    importBatchesDeleted: count("importBatchesDeleted"),
    syncCheckpointsDeleted: count("syncCheckpointsDeleted"),
    lifecycleEventsDeleted: count("lifecycleEventsDeleted"),
    accountsRetired: count("accountsRetired"),
    partiesRetired: count("partiesRetired"),
    itemsRetired: count("itemsRetired"),
    dimensionsRetired: count("dimensionsRetired"),
    sourceSyncStateCleared: count("sourceSyncStateCleared"),
    countsCapped
  } satisfies SanitizedSourceResetCounts;
  return result;
}
