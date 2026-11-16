import { expect, it } from "vitest";
import { createImportStatisticsRefresh } from "../src/import-statistics.js";

it("bounds refreshes geometrically, finishes each large phase, and leaves small imports alone", async () => {
  const calls: string[] = [];
  const client = { query(sql: string) { calls.push(sql); return Promise.resolve({ rows: [], rowCount: 0 }); } };
  const refresh = createImportStatisticsRefresh(client, ['"erp_financials"."transactions"'], 73_286);
  for (let n = 0; n <= 73_286; n++) await refresh(n);
  await refresh(73_286, true);
  await refresh(73_286, true);
  expect(calls).toHaveLength(5); // 1k, 4k, 16k, 64k, finish.
  expect(new Set(calls)).toEqual(new Set(['analyze "erp_financials"."transactions"']));
  await createImportStatisticsRefresh(client, ['"erp_financials"."transactions"'], 999)(999, true);
  expect(calls).toHaveLength(5);
});

it("propagates refresh failures without committing or hiding importer errors", async () => {
  const refresh = createImportStatisticsRefresh({ query() { return Promise.reject(Error("cancelled")); } }, ['"erp_financials"."transactions"'], 1_000);
  await expect(refresh(1_000)).rejects.toThrow("cancelled");
});
