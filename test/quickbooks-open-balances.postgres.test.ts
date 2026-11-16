import { Pool } from "pg";
import { expect, it } from "vitest";
import { restoreQuickBooksOpenBalances } from "../src/quickbooks-open-balances.js";
import type { PostgresQueryClient } from "../src/postgres-storage.js";

const url = process.env.ERP_FINANCIALS_TEST_DATABASE_URL;
it.skipIf(!url)("batches a large provider snapshot while retaining native overlays, exact signs and atomic rollback", async () => {
  if (!url || !new URL(url).pathname.includes("test")) throw Error("Disposable test database required");
  const pool = new Pool({ connectionString: url, max: 1 });
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query(`create schema erp_financials;
      create table erp_financials.subledger_documents (
        subledger_document_id text primary key,tenant_id text,company_id text,source_id text,
        original_amount numeric,open_amount numeric,status text,version int,updated_at timestamptz);
      create table erp_financials.financial_lifecycle_events (
        event_id text primary key,tenant_id text,company_id text,source_id text,event_type text);
      create table erp_financials.subledger_applications (
        subledger_application_id text primary key,tenant_id text,company_id text,source_id text,
        source_document_id text,source_document_source_id text,target_document_id text,target_document_source_id text,
        applied_amount numeric,status text,applied_event_id text);
      insert into erp_financials.subledger_documents
        select n::text,'tenant','company','provider',100,100,'open',1,'2026-01-01' from generate_series(1,35001) n;
      insert into erp_financials.financial_lifecycle_events
        select n::text,'tenant','company','provider','quickbooks_application_imported' from generate_series(1,47000) n;
      insert into erp_financials.subledger_applications
        select n::text,'tenant','company','provider','1',null,'2',null,99,'applied',n::text from generate_series(1,47000) n;
      insert into erp_financials.financial_lifecycle_events values
        ('native','tenant','company','provider','subledger_application.applied'),
        ('local','tenant','company','local','subledger_application.applied'),
        ('wrong-company','tenant','other-company','provider','subledger_application.applied');
      insert into erp_financials.subledger_applications values
        ('native','tenant','company','provider','1',null,'2',null,20,'applied','native'),
        ('local','tenant','company','local','local-credit',null,'2','provider',10,'applied','local'),
        ('local-source','tenant','company','local','3','provider','local-invoice',null,5,'applied','local'),
        ('self','tenant','company','provider','4',null,'4',null,5,'applied','native'),
        ('negative','tenant','company','provider','6',null,'unrelated',null,5,'applied','native'),
        ('voided','tenant','company','provider','1',null,'2',null,50,'voided','native'),
        ('wrong-company','tenant','other-company','provider','1',null,'2',null,50,'applied','wrong-company');
      analyze erp_financials.subledger_documents,erp_financials.subledger_applications,erp_financials.financial_lifecycle_events`);
    const balances = Array.from({ length: 35001 }, (_, i) => ({ documentId: String(i + 1), openAmount: i === 5 ? "-10.00" : i < 4 ? "80.00" : i === 4 ? "0.00" : "100.00" }));
    let calls = 0;
    const client: PostgresQueryClient = { query: async (sql, params) => { calls++; return c.query(sql, params ? [...params] : undefined); } };
    const run = (queryClient = client) => restoreQuickBooksOpenBalances({ client: queryClient, tenantId: "tenant", companyId: "company",
      sourceId: "provider", importedAt: "2026-02-01T00:00:00Z", balances });
    const started = performance.now();
    await run();
    console.log("BATCHED_OPEN_BALANCE_FIXTURE", JSON.stringify({ documents: balances.length, applications: 47007, queries: calls, milliseconds: Math.round(performance.now() - started) }));
    expect(calls).toBe(36);
    const rows = (await c.query<{subledger_document_id:string;open_amount:string;status:string;version:number}>("select subledger_document_id,open_amount::text,status,version from erp_financials.subledger_documents where subledger_document_id in ('1','2','3','4','5','6','7') order by subledger_document_id")).rows;
    expect(rows.map(r => [r.subledger_document_id, Number(r.open_amount), r.status, r.version])).toEqual([
      ['1',60,'partially_applied',2],['2',50,'partially_applied',2],['3',75,'partially_applied',2],
      ['4',75,'partially_applied',2],['5',0,'settled',2],['6',-15,'partially_applied',2],['7',100,'open',1],
    ]);
    await run();
    expect((await c.query<{version:number}>("select max(version) version from erp_financials.subledger_documents")).rows[0]?.version).toBe(2);
    // A caller cancellation between batches propagates without a hidden commit.
    let cancelledCalls = 0;
    await expect(run({ query: async (sql, params) => {
      if (++cancelledCalls === 2) throw Error("cancelled");
      return c.query(sql, params ? [...params] : undefined);
    } })).rejects.toThrow("cancelled");
    await c.query("rollback");
    expect((await c.query<{relation:string|null}>("select to_regclass('erp_financials.subledger_documents') relation")).rows[0]?.relation).toBeNull();
  } finally { await c.query("rollback"); c.release(); await pool.end(); }
}, 60_000);

it("rejects conflicting snapshot balances before issuing any write", async () => {
  let calls = 0;
  await expect(restoreQuickBooksOpenBalances({ client: { query: () => { calls++; return Promise.resolve({ rows: [], rowCount: 0 }); } },
    tenantId: "tenant", companyId: "company", sourceId: "provider", importedAt: "2026-02-01T00:00:00Z",
    balances: [{ documentId: "invoice", openAmount: "1.00" }, { documentId: "invoice", openAmount: "2.00" }],
  })).rejects.toThrow("Conflicting provider open balances");
  expect(calls).toBe(0);
});
