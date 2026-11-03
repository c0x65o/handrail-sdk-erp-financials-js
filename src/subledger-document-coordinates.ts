import type { PostgresQueryClient } from './postgres-storage.js';
import { ErpFinancialsError } from './sdk-errors.js';

export type SubledgerDocumentCoordinate = { readonly sourceId: string; readonly documentId: string };
/** Coordinate-aware locking only. Callers must separately authorize settlement,
 * validate book membership and retain independent approval before writing. */
export async function lockSubledgerDocumentCoordinates(
  client: PostgresQueryClient,
  scope: { readonly tenantId: string; readonly companyId: string },
  source: SubledgerDocumentCoordinate,
  target: SubledgerDocumentCoordinate,
): Promise<readonly [Record<string, unknown>, Record<string, unknown>]> {
  if (![scope.tenantId, scope.companyId, source.sourceId, source.documentId, target.sourceId, target.documentId].every(value => typeof value === 'string' && value.trim().length > 0))
    throw new ErpFinancialsError('invalid_input', 'Complete document source coordinates are required');
  if (source.sourceId === target.sourceId && source.documentId === target.documentId)
    throw new ErpFinancialsError('invalid_input', 'Subledger application source and target documents must differ');
  const result = await client.query(`select *, document_date::text as document_date, due_date::text as due_date,
    to_jsonb(subledger_documents)->>'recognition_date' as recognition_date
    from erp_financials.subledger_documents where tenant_id=$1 and company_id=$2
      and ((source_id=$3 and subledger_document_id=$4) or (source_id=$5 and subledger_document_id=$6))
    order by source_id,subledger_document_id for update`,
  [scope.tenantId, scope.companyId, source.sourceId, source.documentId, target.sourceId, target.documentId]);
  const find = (coordinate: SubledgerDocumentCoordinate) => result.rows.filter(row =>
    row.tenant_id === scope.tenantId && row.company_id === scope.companyId &&
    row.source_id === coordinate.sourceId && row.subledger_document_id === coordinate.documentId);
  const sources = find(source), targets = find(target);
  const sourceRow = sources[0], targetRow = targets[0];
  if (sources.length !== 1 || targets.length !== 1 || sourceRow === undefined || targetRow === undefined)
    throw new ErpFinancialsError('missing_document', 'Both subledger application documents must exist at the exact source coordinates');
  return [sourceRow, targetRow];
}
