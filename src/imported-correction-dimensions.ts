import type { DimensionRef, LedgerPosting } from './canonical-model.js';
import type { PostgresQueryClient } from './postgres-storage.js';
import { ErpFinancialsError } from './sdk-errors.js';

export type ImportedDimensionMapping = { readonly historicalDimensionId: string; readonly nativeDimensionId: string };
/** Resolve explicit review decisions at exact source coordinates; names never authorize a mapping. */
export async function importedCorrectionDimensions(client: PostgresQueryClient,
  scope: { tenantId: string; historicalSourceId: string; nativeSourceId: string },
  postings: readonly LedgerPosting[], mappings: readonly ImportedDimensionMapping[] = [],
): Promise<(refs: readonly DimensionRef[]) => readonly DimensionRef[]> {
  const fail = (): never => { throw new ErpFinancialsError('invalid_input', 'Imported correction requires exact active dimension mappings of the same kind'); };
  const dimensions = (await client.query(`select * from erp_financials.accounting_dimensions
    where tenant_id=$1 and source_id=any($2::text[]) order by source_id,dimension_id for share`,
    [scope.tenantId, [scope.historicalSourceId, scope.nativeSourceId]])).rows;
  const resolve = (ref: DimensionRef) => {
    const matches = dimensions.filter(d => d.source_id === scope.historicalSourceId && d.dimension_kind === ref.dimensionKind
      && (ref.dimensionId === undefined || d.dimension_id === ref.dimensionId)
      && (ref.sourceDimensionId === undefined || d.source_dimension_id === ref.sourceDimensionId));
    if ((!ref.dimensionId && !ref.sourceDimensionId) || matches.length !== 1) return fail();
    return String(matches[0]?.dimension_id);
  };
  const required = new Set(postings.flatMap(p => p.dimensionRefs.map(resolve)));
  const decisions = new Map(mappings.map(m => [m.historicalDimensionId,m.nativeDimensionId]));
  if (decisions.size !== mappings.length || decisions.size !== required.size || [...required].some(id => !decisions.has(id))) fail();
  const resolved = new Map<string, DimensionRef>();
  for (const [oldId, newId] of decisions) {
    const old = dimensions.find(d => d.source_id === scope.historicalSourceId && d.dimension_id === oldId);
    const next = dimensions.find(d => d.source_id === scope.nativeSourceId && d.dimension_id === newId);
    if (!old || !next || next.active !== true || next.dimension_kind !== old.dimension_kind) return fail();
    resolved.set(oldId, { dimensionId:newId,dimensionKind:String(next.dimension_kind),sourceDimensionId:String(next.source_dimension_id),name:String(next.name) });
  }
  return refs => refs.map(ref => resolved.get(resolve(ref)) ?? fail());
}
