import { lockCustomerPaymentCorrectionSource } from "./customer-payment-correction.js";
import type { PostgresQueryClient } from "./postgres-storage.js";
import type { CanonicalAccountingFactSet } from "./source-adapters.js";

/** A retained local correction is NOT evidence that the provider deleted an object. */
export type CustomerPaymentCorrectionDependency = {
  readonly code: "provider_dependency";
  readonly correctionId: string;
  readonly paymentId: string;
  readonly sourceTransactionId: string;
  readonly correctedSourceVersion: string;
  readonly reason: "payment_correction_requires_provider_reconciliation";
};
export type CustomerPaymentCorrectionReplayState = {
  readonly dependency: CustomerPaymentCorrectionDependency;
  readonly transactionIds: readonly string[];
  readonly reopenedInvoiceIds: readonly string[];
};

export async function loadCustomerPaymentCorrectionReplayState(
  client: PostgresQueryClient, tenantId: string, sourceId: string
): Promise<readonly CustomerPaymentCorrectionReplayState[]> {
  await lockCustomerPaymentCorrectionSource(client, tenantId, sourceId);
  const result = await client.query<{
    correction_id: string; payment_id: string; source_version: string;
    evidence: { sourceTransactionId: string; transactionIds: string[] };
    result: { reversalTransactionIds: string[]; reopenedInvoiceIds: string[] };
  }>(`select c.correction_id,c.payment_id,c.source_version,e.evidence,c.result
    from erp_financials.customer_payment_corrections c
    join erp_financials.imported_customer_payment_evidence e using(tenant_id,company_id,source_id,payment_id)
    where c.tenant_id=$1 and c.source_id=$2 order by c.correction_id`, [tenantId, sourceId]);
  return result.rows.map(row => ({
    dependency: { code: "provider_dependency", correctionId: row.correction_id, paymentId: row.payment_id,
      sourceTransactionId: row.evidence.sourceTransactionId, correctedSourceVersion: row.source_version,
      reason: "payment_correction_requires_provider_reconciliation" },
    transactionIds: [...row.evidence.transactionIds, ...row.result.reversalTransactionIds],
    reopenedInvoiceIds: row.result.reopenedInvoiceIds
  }));
}

export type CustomerPaymentCorrectionImportPlan = {
  readonly facts: CanonicalAccountingFactSet;
  readonly correctionDependencies: readonly CustomerPaymentCorrectionDependency[];
};

/**
 * Run on the SAME explicit transaction client as fact and subledger persistence.
 * Discard incoming projections of corrected Payment identities, including newly
 * assigned basis transaction IDs and their children. Keep original provenance
 * and compensation intact. No timestamp is promoted to a provider revision.
 */
export async function prepareCustomerPaymentCorrectionImport(
  client: PostgresQueryClient, facts: CanonicalAccountingFactSet
): Promise<CustomerPaymentCorrectionImportPlan> {
  const state = await loadCustomerPaymentCorrectionReplayState(client, facts.company.tenantId, facts.source.sourceId);
  const blocked = correctedTransactionIds(state, facts.transactions);
  const providerIds = new Set(state.map(row => row.dependency.sourceTransactionId));
  return {
    facts: { ...facts,
      transactions: facts.transactions.filter(row => !blocked.has(row.transactionId)),
      transactionLines: facts.transactionLines.filter(row => !blocked.has(row.transactionId)),
      postings: facts.postings.filter(row => !blocked.has(row.transactionId) &&
        !(row.sourcePayloadRef?.sourceObjectType === "Payment" && providerIds.has(row.sourcePayloadRef.sourceObjectId))) },
    correctionDependencies: state.map(row => row.dependency)
  };
}

export function correctedTransactionIds(state: readonly CustomerPaymentCorrectionReplayState[], transactions: CanonicalAccountingFactSet["transactions"]): Set<string> {
  const blocked = new Set(state.flatMap(row => row.transactionIds));
  const providerIds = new Set(state.map(row => row.dependency.sourceTransactionId));
  for (const transaction of transactions) {
    const legacyBasisIdentity = transaction.sourceTransactionType === "QuickBooksGeneralLedger:Payment" &&
      [...providerIds].some(id => ["accrual", "cash"].some(basis => transaction.sourceTransactionId === `${basis}:Payment:${id}:${transaction.transactionDate}`));
    if (legacyBasisIdentity || (transaction.sourceTransactionType === "Payment" && providerIds.has(transaction.sourceTransactionId)) ||
        (transaction.sourcePayloadRef?.sourceObjectType === "Payment" && providerIds.has(transaction.sourcePayloadRef.sourceObjectId))) {
      blocked.add(transaction.transactionId);
    }
  }
  return blocked;
}
