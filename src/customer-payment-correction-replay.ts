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
  readonly reason: "payment_correction_requires_provider_reconciliation" | "imported_application_correction_requires_provider_reconciliation";
};
export type CustomerPaymentCorrectionReplayState = {
  readonly providerType?: string;
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
  const imported = await client.query<{
    event_id: string; document_id: string; transaction_ids: string[]; provider_type: string;
    provider_id: string; prior_version: string;
  }>(`select e.event_id,d.subledger_document_id as document_id,
      array(select t.transaction_id from erp_financials.transactions t where t.tenant_id=d.tenant_id and t.source_id=d.source_id
        and (t.transaction_id=d.transaction_id
          or (t.source_payload_ref->>'sourceObjectType'=d.metadata->>'sourceTransactionType' and t.source_payload_ref->>'sourceObjectId'=d.metadata->>'sourceTransactionId')
          or (t.source_transaction_type='QuickBooksGeneralLedger:'||(d.metadata->>'sourceTransactionType')
            and t.source_transaction_id in ('cash:'||(d.metadata->>'sourceTransactionType')||':'||(d.metadata->>'sourceTransactionId')||':'||t.transaction_date::text,
              'accrual:'||(d.metadata->>'sourceTransactionType')||':'||(d.metadata->>'sourceTransactionId')||':'||t.transaction_date::text)))) as transaction_ids,
      d.metadata->>'sourceTransactionType' as provider_type,d.metadata->>'sourceTransactionId' as provider_id,
      e.payload->>'priorVersion' as prior_version
    from erp_financials.financial_lifecycle_events e
    join erp_financials.subledger_applications a on a.tenant_id=e.tenant_id and a.company_id=e.company_id
      and a.source_id=e.source_id and a.ended_event_id=e.event_id
    join erp_financials.subledger_documents d on d.tenant_id=a.tenant_id and d.company_id=a.company_id
      and d.source_id=a.source_id and (d.subledger_document_id in (a.source_document_id,a.target_document_id)
        or exists(select 1 from erp_financials.subledger_applications sibling
          where sibling.tenant_id=a.tenant_id and sibling.company_id=a.company_id and sibling.source_id=a.source_id
            and sibling.source_document_id=a.source_document_id and sibling.target_document_source_id is null
            and sibling.target_document_id=d.subledger_document_id))
    where e.tenant_id=$1 and e.source_id=$2 and e.payload ? 'importedCorrection'
    order by e.event_id,d.subledger_document_id`,[tenantId,sourceId]);
  const retained: CustomerPaymentCorrectionReplayState[] = imported.rows.map(row => ({
    providerType: row.provider_type,
    dependency: { code:"provider_dependency",correctionId:row.event_id,paymentId:row.document_id,
      sourceTransactionId:row.provider_id,correctedSourceVersion:row.prior_version,
      reason:"imported_application_correction_requires_provider_reconciliation" },
    transactionIds:row.transaction_ids,reopenedInvoiceIds:[row.document_id]
  }));
  return [...retained,...result.rows.map(row => ({
    dependency: { code: "provider_dependency" as const, correctionId: row.correction_id, paymentId: row.payment_id,
      sourceTransactionId: row.evidence.sourceTransactionId, correctedSourceVersion: row.source_version,
      reason: "payment_correction_requires_provider_reconciliation" as const },
    transactionIds: [...row.evidence.transactionIds, ...row.result.reversalTransactionIds],
    reopenedInvoiceIds: row.result.reopenedInvoiceIds
  }))];
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
  return {
    facts: { ...facts,
      transactions: facts.transactions.filter(row => !blocked.has(row.transactionId)),
      transactionLines: facts.transactionLines.filter(row => !blocked.has(row.transactionId)),
      postings: facts.postings.filter(row => !blocked.has(row.transactionId) &&
        !state.some(s => row.sourcePayloadRef?.sourceObjectType === (s.providerType ?? "Payment") && row.sourcePayloadRef.sourceObjectId === s.dependency.sourceTransactionId)) },
    correctionDependencies: state.map(row => row.dependency)
  };
}

export function correctedTransactionIds(state: readonly CustomerPaymentCorrectionReplayState[], transactions: CanonicalAccountingFactSet["transactions"]): Set<string> {
  const blocked = new Set(state.flatMap(row => row.transactionIds));
  for (const transaction of transactions) {
    if (state.some(row => {
      const type = row.providerType ?? "Payment", id = row.dependency.sourceTransactionId;
      return (transaction.sourceTransactionType === `QuickBooksGeneralLedger:${type}` &&
        ["accrual","cash"].some(basis => transaction.sourceTransactionId === `${basis}:${type}:${id}:${transaction.transactionDate}`))
        || (transaction.sourceTransactionType === type && transaction.sourceTransactionId === id)
        || (transaction.sourcePayloadRef?.sourceObjectType === type && transaction.sourcePayloadRef.sourceObjectId === id);
    })) blocked.add(transaction.transactionId);
  }
  return blocked;
}
