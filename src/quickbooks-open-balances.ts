import type { PostgresQueryClient } from "./postgres-storage.js";

/** Restore the provider snapshot minus native applications, in bounded batches.
 * Imported applications are already reflected in the provider snapshot. Native
 * applications may cross sources and must remain deducted on replay. The caller
 * owns the transaction and cancellation checks; this helper never commits. */
export async function restoreQuickBooksOpenBalances(input: {
  client: PostgresQueryClient; tenantId: string; companyId: string; sourceId: string; importedAt: string;
  balances: readonly { documentId: string; openAmount: string }[];
}): Promise<void> {
  const balances = new Map<string, string>();
  for (const row of input.balances) {
    const prior = balances.get(row.documentId);
    if (prior !== undefined && prior !== row.openAmount) throw Error("Conflicting provider open balances for one document");
    balances.set(row.documentId, row.openAmount);
  }
  const rows = [...balances].map(([document_id, open_amount]) => ({ document_id, open_amount }));
  for (let offset = 0; offset < rows.length; offset += 1_000) {
    await input.client.query(`with incoming as materialized (
  select * from jsonb_to_recordset($4::jsonb) as x(document_id text, open_amount numeric)
), native_applications as materialized (
  select a.subledger_application_id, a.source_document_id, a.target_document_id, a.applied_amount,
    coalesce(to_jsonb(a)->>'source_document_source_id',a.source_id) source_scope,
    coalesce(a.target_document_source_id,a.source_id) target_scope
  from erp_financials.subledger_applications a
  join erp_financials.financial_lifecycle_events e on e.tenant_id=a.tenant_id and e.company_id=a.company_id
    and e.source_id=a.source_id and e.event_id=a.applied_event_id
  where a.tenant_id=$1 and a.company_id=$2 and a.status='applied'
    and e.event_type='subledger_application.applied'
), native_legs as (
  select source_document_id document_id, applied_amount from native_applications where source_scope=$3
  union all
  select target_document_id, applied_amount from native_applications where target_scope=$3
    and (source_scope is distinct from $3 or source_document_id is distinct from target_document_id)
), native_totals as (
  select n.document_id, sum(n.applied_amount) applied_amount from native_legs n
  join incoming i on i.document_id=n.document_id group by n.document_id
), restored as (
  select i.document_id, i.open_amount-coalesce(n.applied_amount,0) open_amount
  from incoming i left join native_totals n on n.document_id=i.document_id
)
update erp_financials.subledger_documents d
set open_amount=r.open_amount,
  status=case when r.open_amount=0 then 'settled'
    when r.open_amount=d.original_amount then 'open' else 'partially_applied' end,
  version=d.version+1, updated_at=$5
from restored r where d.tenant_id=$1 and d.company_id=$2 and d.source_id=$3
  and d.subledger_document_id=r.document_id and d.open_amount is distinct from r.open_amount`,
    [input.tenantId, input.companyId, input.sourceId, JSON.stringify(rows.slice(offset, offset + 1_000)), input.importedAt]);
  }
}
