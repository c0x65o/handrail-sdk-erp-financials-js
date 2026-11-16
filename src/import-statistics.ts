import type { PostgresQueryClient } from "./postgres-storage.js";

/** Autovacuum cannot see a first import's uncommitted rows. Refresh statistics
 * inside that transaction so cached trigger/FK plans do not keep scanning tables
 * they originally planned as empty. Relations come only from SDK code. No data,
 * constraints, triggers, or transaction boundaries are changed. */
export function createImportStatisticsRefresh(
  client: PostgresQueryClient,
  qualifiedRelations: readonly string[],
  expectedRows: number
): (processedRows: number, finished?: boolean) => Promise<void> {
  let next = 1_000;
  let last = 0;
  return async (processedRows, finished = false) => {
    if (expectedRows < 1_000 || processedRows === last || (processedRows < next && !finished)) return;
    await client.query(`analyze ${qualifiedRelations.join(", ")}`);
    last = processedRows;
    while (next <= processedRows) next *= 4;
  };
}
