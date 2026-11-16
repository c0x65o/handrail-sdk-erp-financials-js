import { Pool } from "pg";
import { expect, it } from "vitest";
import { createImportStatisticsRefresh } from "../src/import-statistics.js";

const url = process.env.ERP_FINANCIALS_TEST_DATABASE_URL;
it.skipIf(!url)("refreshes an empty-table cached FK lookup plan during an atomic large import", async () => {
  if (!url || !new URL(url).pathname.includes("test")) throw Error("Disposable test database required");
  const pool = new Pool({ connectionString: url, max: 1 });
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query(`create schema import_statistics_fixture;
      create table import_statistics_fixture.events (id text primary key,tenant_id text,company_id text,source_id text,payload text);
      create unique index events_scope on import_statistics_fixture.events(tenant_id,company_id,source_id,id);
      analyze import_statistics_fixture.events;
      set local plan_cache_mode=force_generic_plan;
      prepare event_guard(text,text,text,text) as select 1 from import_statistics_fixture.events
        where tenant_id=$1 and company_id=$2 and source_id=$3 and id=$4 for key share;
      execute event_guard('tenant','company','source','missing');
      insert into import_statistics_fixture.events
        select n::text,'tenant','company','source',repeat(md5(n::text),32) from generate_series(1,100000) n`);
    type Plan = { Plan: { "Shared Hit Blocks": number }; "Execution Time": number };
    const explain = async () => (await c.query<{ "QUERY PLAN": Plan[] }>(`explain (analyze,buffers,format json) execute event_guard('tenant','company','source','99999')`)).rows[0]?.["QUERY PLAN"][0] as Plan;
    const before = await explain();
    const refresh = createImportStatisticsRefresh(c, ['import_statistics_fixture.events'], 100_000);
    await refresh(100_000, true);
    const after = await explain();
    console.log("UNCOMMITTED_IMPORT_PLAN", JSON.stringify({ before, after }));
    expect(before.Plan["Shared Hit Blocks"]).toBeGreaterThan(1_000);
    expect(after.Plan["Shared Hit Blocks"]).toBeLessThan(20);
    expect((await c.query<{ n: number }>("select count(*)::int as n from import_statistics_fixture.events")).rows[0]?.n).toBe(100_000);
    // Statistics maintenance does not commit the importer or expose its rows.
    await c.query("rollback");
    expect((await c.query<{ relation: string | null }>("select to_regclass('import_statistics_fixture.events') as relation")).rows[0]?.relation).toBeNull();
  } finally { await c.query("rollback"); c.release(); await pool.end(); }
}, 60_000);
