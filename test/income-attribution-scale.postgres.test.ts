import { readFile } from "node:fs/promises";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { createErpFinancialsSdk, createPostgresTransactionRunner, migratePostgresSchema } from "../src/index.js";

// Explicit isolated workload, not a release acceptance threshold. A smaller
// fixture is available for harness validation; only the default is million-scale.
const enabled = process.env.ERP_FINANCIALS_RUN_SCALE_TESTS === "1";
it.skipIf(!enabled)("measures bounded income attribution with mixed revenue and COGS and concurrent posting", async () => {
  const root = process.env.ERP_FINANCIALS_EPHEMERAL_ROOT, value = process.env.ERP_FINANCIALS_TEST_DATABASE_URL;
  if (!value || !root) throw Error("Disposable PostgreSQL harness required");
  const url = new URL(value), socket = url.searchParams.get("host");
  if (!socket?.startsWith(`${root}/epg-`) || url.pathname !== "/erp_financials_test_correction") throw Error("Refusing non-disposable benchmark target");
  const journals = Number(process.env.ERP_FINANCIALS_SCALE_JOURNALS ?? "1000000");
  if (!Number.isSafeInteger(journals) || journals < 10_000 || journals > 1_000_000) throw Error("Invalid fixture size");
  const pool = new Pool({ connectionString: value, max: 10 });
  try {
    const proof = required((await pool.query<{ directory: string; address: unknown; listen: string; version: string }>("select current_setting('data_directory') directory,inet_server_addr() address,current_setting('listen_addresses') listen,version() version")).rows[0]);
    expect(proof.directory).toBe(`${socket}/data`); expect(proof.address).toBeNull(); expect(proof.listen).toBe("");
    const runner = createPostgresTransactionRunner(pool);
    await migratePostgresSchema(runner, { appliedByRef: "test:mixed-scale", targetVersion: 33 });
    await pool.query(`
      insert into erp_financials.accounting_companies values ('mixed_company','mixed_tenant','Mixed','Mixed','USD',1,'test','native_erp','mixed');
      insert into erp_financials.accounting_sources (source_id,tenant_id,source_system,provider_environment,connection_ref,status)
        select source,'mixed_tenant','native_erp','test','test:'||source,'active' from unnest(array['mixed_history','mixed_current']) source;
      insert into erp_financials.company_sources
        select 'binding-'||source_id,tenant_id,'mixed_company',source_id,now() from erp_financials.accounting_sources;
      insert into erp_financials.accounts (account_id,tenant_id,source_id,source_account_id,account_number,name,type,classification,active)
        select source_id||'-'||side||'-'||n,tenant_id,source_id,side||'-'||n,
          (case when side='debit' then 1000 else 4000 end+n)::text,side||' '||n,
          case when side='debit' and n%2=0 then 'cost_of_goods_sold' when side='credit' and n%2=1 then 'income' else 'asset' end,
          case when side='debit' and n%2=0 then 'cost_of_goods_sold' when side='credit' and n%2=1 then 'income' else 'asset' end,true
        from erp_financials.accounting_sources cross join generate_series(0,49) n cross join (values ('debit'),('credit')) sides(side);
      insert into erp_financials.import_batches (import_batch_id,tenant_id,source_id,mode,status,started_at,completed_at,source_object_counts)
        select 'batch-'||source_id,tenant_id,source_id,'initial','completed',now(),now(),'{}' from erp_financials.accounting_sources;
    `);
    const scope = { tenantId: "mixed_tenant", companyId: "mixed_company", bookId: "mixed_book", writeSourceId: "mixed_current", currencyCode: "USD" };
    const sdk = createErpFinancialsSdk({ ...scope, database: runner });
    const operation = { actorRef: "mixed:preparer", approverRef: "mixed:approver", requestId: "mixed:setup", correlationId: "mixed:scale", reasonCode: "scale-test", occurredAt: "2026-08-31T00:00:00Z" };
    await sdk.books.define({ operation, bookId: scope.bookId, name: "Mixed", baseCurrencyCode: "USD" });
    await sdk.books.bindSource({ operation, bookId: scope.bookId, sourceId: "mixed_history", sourceRole: "historical", effectiveThrough: "2023-12-31" });
    await sdk.books.bindSource({ operation, bookId: scope.bookId, sourceId: "mixed_current", sourceRole: "active", effectiveFrom: "2024-01-01" });
    await sdk.commands.fiscalPeriods.define({ operation, fiscalYear: 2026, periodNumber: 8, periodStart: "2026-08-01", periodEnd: "2026-08-31" });
    // Independent integer fixture oracle: no SDK totals or million-row response
    // is used to establish expected controls. Dates cover 2021-09 through 2026-08.
    const month = oracle(), wholeOracle = oracle();
    for (let n = 1; n <= journals; n++) {
      addOracle(wholeOracle,n);
      if (n % 1826 >= 1795) addOracle(month,n);
    }
    const monthCount=month.count;
    const seedStarted = performance.now(), batch = 50_000;
    for (let start = 1; start <= journals; start += batch) {
      await runner.transaction(async client => {
        const end = Math.min(journals, start + batch - 1);
        await client.query(`insert into erp_financials.transactions
          (transaction_id,tenant_id,source_id,source_transaction_id,source_transaction_type,transaction_date,posted_at,updated_at,currency_code,status)
          select 'mixed_j_'||n,'mixed_tenant',case when d<'2024-01-01' then 'mixed_history' else 'mixed_current' end,n::text,
            (array['Invoice','Payment','Bill','JournalEntry'])[n%4+1],d,timestamptz '2026-08-31T00:00:00Z',timestamptz '2026-08-31T00:00:00Z','USD','posted'
          from (select n,date '2021-09-01'+(n%1826)::int d from generate_series($1::int,$2::int) n) fixture`, [start, end]);
        if (start === 1) await client.query("analyze erp_financials.transactions");
        await client.query(`insert into erp_financials.ledger_postings
          (posting_id,tenant_id,source_id,source_posting_id,transaction_id,account_id,posting_date,accounting_basis,debit_amount,credit_amount,net_amount,currency_code,dimension_hash,dimension_refs,import_batch_id)
          select 'mixed_p_'||n||'_'||side,'mixed_tenant',source,n||'_'||side,'mixed_j_'||n,
            source||'-'||case when side=0 then 'debit' else 'credit' end||'-'||n%50,d,'accrual',
            case when side=0 then cents::numeric/100 else 0 end,case when side=1 then cents::numeric/100 else 0 end,
            cents::numeric/100*case when side=0 then 1 else -1 end,'USD',repeat('0',64),case when (side=0 and n%2=0) or (side=1 and n%2=1) then
              case when n%50=0 then jsonb_build_array(jsonb_build_object('dimensionKind','blu_order','sourceDimensionId','conflict-a'),jsonb_build_object('dimensionKind','blu_order','sourceDimensionId','conflict-b'))
                when n%20=0 then '[]'::jsonb
                else jsonb_build_array(jsonb_build_object('dimensionKind','blu_order','sourceDimensionId','order-'||(n/2%10000)::text)) end
              else '[]'::jsonb end,'batch-'||source
          from (select n,d,case when n%2=0 then n%10000/3+1 else n%10000+1 end cents,case when d<'2024-01-01' then 'mixed_history' else 'mixed_current' end source
            from (select n,date '2021-09-01'+(n%1826)::int d from generate_series($1::int,$2::int) n) dates) fixture cross join generate_series(0,1) side`, [start, end]);
      });
      if (Math.min(journals, start + batch - 1) % 250_000 === 0) console.log("MIXED_SCALE_SEED_PROGRESS", start + batch - 1, performance.now() - seedStarted);
    }
    const seedMs = performance.now() - seedStarted, upgradeStarted = performance.now();
    await migratePostgresSchema(runner, { appliedByRef: "test:mixed-scale-upgrade" });
    const upgradeMs = performance.now() - upgradeStarted;
    // State the statistics policy rather than silently comparing with the prior
    // single-month fixture's pre-ANALYZE binding table.
    await pool.query("analyze erp_financials.transactions; analyze erp_financials.ledger_postings; analyze erp_financials.reporting_book_sources; analyze erp_financials.accounts; analyze erp_financials.fiscal_periods");
    let captured: { sql: string; values: readonly unknown[] } | undefined;
    const measured = createErpFinancialsSdk({ ...scope, database: { transaction: work => runner.transaction(client => work({ query: (sql, values) => {
      if (sql.startsWith("with classified as materialized")) captured = { sql, values: values ?? [] };
      return client.query(sql, values);
    } })) } });
    const request = { periodStart: "2026-08-01", periodEnd: "2026-08-31", dimensionKind: "blu_order", limit: 50 };
    const firstMs: number[] = [], nextMs: number[] = [];
    let baselineCursor: string | undefined;
    for (let i = 0; i < 3; i++) {
      let started = performance.now();
      const first = await measured.queries.getIncomeAttribution(request); firstMs.push(performance.now() - started);
      expect(first.summary).toEqual(oracleTotals(month)); expect(first.groupCount).toBe(String(month.groups.size));
      expect(first.coverage.assigned).toEqual(oracleTotals(month.assigned));
      expect(first.coverage.unassigned).toEqual(oracleTotals(month.unassigned));
      expect(first.coverage.ambiguous).toEqual(oracleTotals(month.ambiguous));
      expect(first.items).toHaveLength(50); baselineCursor = first.nextCursor;
      started = performance.now();
      const next = await measured.queries.getIncomeAttribution({ ...request, cursor: required(first.nextCursor) }); nextMs.push(performance.now() - started);
      expect(next.summary).toEqual(first.summary); expect(next.items.length).toBeGreaterThan(0); expect(next.items.length).toBeLessThanOrEqual(50);
      expect(new Set([...first.items, ...next.items].map(item => item.key)).size).toBe(first.items.length+next.items.length);
    }
    const monthQuery = required(captured);
    const wholeStarted = performance.now(), whole = await measured.queries.getIncomeAttribution({ ...request, periodStart: "2021-09-01" });
    const wholeMs = performance.now() - wholeStarted;
    expect(whole.summary).toEqual(oracleTotals(wholeOracle)); expect(whole.groupCount).toBe(String(wholeOracle.groups.size));

    const selectionMs: Record<string, number> = {};
    for (const attributionStatus of ["unassigned", "ambiguous"] as const) {
      const started = performance.now(), page = await measured.queries.getIncomeAttribution({ ...request, attributionStatus });
      selectionMs[attributionStatus] = performance.now() - started;
      expect(page.summary).toEqual(oracleTotals(month));
      expect(page.matched).toEqual({ ...oracleTotals(month[attributionStatus]), groupCount: String([...month.groups].filter(key => key.includes(`:${attributionStatus}:`)).length) });
      expect(page.items.every(item => item.status === attributionStatus)).toBe(true);
    }
    for (const sort of ["cost_desc", "income_desc"] as const) {
      const started = performance.now(), page = await measured.queries.getIncomeAttribution({ ...request, sort });
      const next = await measured.queries.getIncomeAttribution({ ...request, sort, cursor: required(page.nextCursor) });
      selectionMs[`${sort}_two_pages`] = performance.now() - started;
      const actual = [...page.items, ...next.items], field = sort === "cost_desc" ? "cost" : "income";
      const expected = [...month.byGroup.values()].map(group => group[field]).sort((a, b) => a > b ? -1 : a < b ? 1 : 0).slice(0, actual.length).map(money);
      expect(actual.map(item => sort === "cost_desc" ? item.costOfGoodsSold : item.income)).toEqual(expected);
      expect(new Set(actual.map(item => item.key)).size).toBe(actual.length);
      expect(page.matched).toEqual({ ...oracleTotals(month), groupCount: String(month.groups.size) }); expect(next.matched).toEqual(page.matched);
    }

    const nativeWrites = 400, writerCount = 4, readerCount = 4;
    const postingMs: number[] = [], readMs: number[] = [], lockSamples: number[] = [];
    let writersDone = false, writerDurationMs = 0;
    const sampling = new AbortController();
    const memoryBefore = process.memoryUsage(), contentionStarted = performance.now();
    const sampler = (async () => {
      while (!sampling.signal.aborted) {
        const row = required((await pool.query<{ n: string }>("select count(*)::text n from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and wait_event_type='Lock'")).rows[0]);
        lockSamples.push(Number(row.n)); await delay(50);
      }
    })();
    const writers = Promise.all(Array.from({ length: writerCount }, async (_, worker) => {
      for (let index = worker; index < nativeWrites; index += writerCount) {
        const key = `mixed-native-${String(index)}`, started = performance.now();
        await sdk.commands.journalEntries.post({ operation: { ...operation, requestId: key }, idempotencyKey: key,
          date: "2026-08-31", origin: { module: "Manual", reference: key }, lines: [{ accountId: "mixed_current-debit-1", debit: "0.01" }, { accountId: "mixed_current-credit-1", credit: "0.01", dimensionRefs: [{ dimensionKind: "blu_order", sourceDimensionId: key }] }] });
        postingMs.push(performance.now() - started);
      }
    })).finally(() => { writersDone = true; writerDurationMs = performance.now() - contentionStarted; });
    const readers = Promise.all(Array.from({ length: readerCount }, async () => {
      let reads = 0;
      do {
        const started = performance.now(), page = await measured.queries.getIncomeAttribution(request); readMs.push(performance.now() - started);
        const delta = Number(page.summary.postingCount) - monthCount;
        expect(delta).toBeGreaterThanOrEqual(0); expect(delta).toBeLessThanOrEqual(nativeWrites);
        expect(page.summary).toEqual(oracleTotals({count:month.count+delta,income:month.income+BigInt(delta),cost:month.cost}));
        expect(page.coverage.assigned).toEqual(oracleTotals({count:month.assigned.count+delta,income:month.assigned.income+BigInt(delta),cost:month.assigned.cost}));
        expect(page.coverage.unassigned).toEqual(oracleTotals(month.unassigned)); expect(page.coverage.ambiguous).toEqual(oracleTotals(month.ambiguous));
        expect(page.groupCount).toBe(String(month.groups.size+delta));
        reads++;
      } while (!writersDone || reads < 3);
    }));
    try {
      const results = await Promise.allSettled([writers, readers]);
      for (const result of results) if (result.status === "rejected") throw result.reason;
    } finally { sampling.abort(); await sampler; }
    const contentionMs = performance.now() - contentionStarted;
    const final = await sdk.queries.getIncomeAttribution(request);
    expect(final.summary).toEqual(oracleTotals({count:month.count+nativeWrites,income:month.income+BigInt(nativeWrites),cost:month.cost}));
    await expect(sdk.queries.getIncomeAttribution({ ...request, cursor: required(baselineCursor) })).rejects.toMatchObject({ code: "optimistic_concurrency_conflict" });
    const statement=await sdk.queries.getFinancialStatement({ ...request, reportName: "profit_and_loss" });
    const {postingCount:_postingCount,...statementTotals}=final.summary;void _postingCount;
    expect(statementTotals).toEqual(statement.totals);
    const key="mixed-native-0";
    await sdk.commands.journalEntries.post({ operation: { ...operation, requestId: key }, idempotencyKey: key, date: "2026-08-31", origin: { module: "Manual", reference: key }, lines: [{ accountId: "mixed_current-debit-1", debit: "0.01" }, { accountId: "mixed_current-credit-1", credit: "0.01",dimensionRefs:[{dimensionKind:"blu_order",sourceDimensionId:key}]}] });
    expect((await sdk.queries.getIncomeAttribution(request)).summary).toEqual(final.summary);
    const plan = (await pool.query(`explain (analyze,buffers,format json) ${monthQuery.sql}`, [...monthQuery.values])).rows;
    const memoryClient = await pool.connect();
    let backendMemory: string;
    try {
      const pid = required((await memoryClient.query<{ pid: number }>("select pg_backend_pid() pid")).rows[0]).pid;
      backendMemory = (await readFile(`/proc/${String(pid)}/status`, "utf8")).split("\n").filter(line => /^Vm(RSS|HWM|Size):/.test(line)).join("\n");
    } finally { memoryClient.release(); }
    const settings = (await pool.query("select name,setting,unit from pg_settings where name=any($1::text[])", [["shared_buffers", "work_mem", "max_parallel_workers_per_gather", "effective_cache_size", "fsync", "jit"]])).rows;
    console.log("INCOME_ATTRIBUTION_SCALE", JSON.stringify({ workload: { journals, ledgerPostings: journals * 2, sources: 2, accounts: 200, dates: 1826, tenantCount: 1, companyCount: 1, currency: "USD", importedBasis: "accrual", monthCount, pageSize: 50, nativeWrites, writerCount, readerCount, dimensionKind: "blu_order", orderIdentityPoolPerSource: 10000, attributionMix: "n%50 ambiguous; otherwise n%20 unassigned; otherwise assigned; even n COGS, odd n revenue" },
      hardware: { cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, hostMemoryBytes: os.totalmem(), node: process.version }, database: { version: proof.version, settings },
      seedMs, upgradeMs, firstMs, nextMs, wholeMs, selectionMs, contention: { durationMs: contentionMs, writerDurationMs, postingMs, readMs, postingTransactionsPerSecond: nativeWrites * 1000 / writerDurationMs, completedReads: readMs.length, readsPerSecond: readMs.length * 1000 / contentionMs,
        sampledLockWaitCount: lockSamples.filter(n => n > 0).length, samples: lockSamples.length, maxConcurrentLockWaiters: Math.max(0, ...lockSamples) },
      money: { month: oracleTotals(month), whole: oracleTotals(wholeOracle), finalMonth: final.summary }, memory: { before: memoryBefore, after: process.memoryUsage(), nodeMaxRssKiB: process.resourceUsage().maxRSS, sampledBackend: backendMemory }, plan,
      limitations: ["Synthetic five-year distribution, one tenant/company, USD. Not production data or sustained soak acceptance.", "Four writers each post100 two-line native journals; sampled lock waiters omit waits between50ms samples.", "Statistics analyzed on report-relevant tables before measurement; not comparable to an un-analyzed metadata baseline.", "Read throughput includes completion after writers stop; posting throughput uses writer duration. Backend RSS is one sampled process, not total server memory."] }));
  } finally { await pool.end(); }
}, 900_000);

function required<T>(value: T | undefined): T { if (value === undefined) throw Error("Expected fixture value"); return value; }
function money(cents: bigint): string { const abs=cents<0n?-cents:cents;return `${cents<0n?"-":""}${String(abs/100n)}.${String(abs%100n).padStart(2,"0")}`; }
type Control={count:number;income:bigint;cost:bigint};
function control():Control{return {count:0,income:0n,cost:0n};}
function oracle(){return {...control(),assigned:control(),unassigned:control(),ambiguous:control(),groups:new Set<string>(),byGroup:new Map<string,Control>()};}
function addOracle(target:ReturnType<typeof oracle>,n:number){
  const cost=n%2===0,cents=BigInt(cost?Math.floor((n%10000)/3)+1:n%10000+1);
  const status=n%50===0?"ambiguous":n%20===0?"unassigned":"assigned";
  for(const value of [target,target[status]]){value.count++;if(cost)value.cost+=cents;else value.income+=cents;}
  const day=new Date(Date.UTC(2021,8,1)+(n%1826)*86400000).toISOString().slice(0,10);
  const source=day<"2024-01-01"?"mixed_history":"mixed_current";
  const key=`${source}:${status}:${status==="assigned"?String(Math.floor(n/2)%10000):""}`;
  target.groups.add(key); const group=target.byGroup.get(key)??control();group.count++;if(cost)group.cost+=cents;else group.income+=cents;target.byGroup.set(key,group);
}
function oracleTotals(value:Control){return {postingCount:String(value.count),income:money(value.income),costOfGoodsSold:money(value.cost),expenses:"0.00",grossProfit:money(value.income-value.cost),netIncome:money(value.income-value.cost)};}

