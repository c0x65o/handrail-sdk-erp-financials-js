import { readFile } from "node:fs/promises";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { createErpFinancialsSdk, createPostgresTransactionRunner, migratePostgresSchema } from "../src/index.js";

// Explicit, expensive benchmark. Run through the disposable PostgreSQL harness.
const enabled = process.env.ERP_FINANCIALS_RUN_SCALE_TESTS === "1";
it.skipIf(!enabled)("measures exact account-register and chart pages against one million journals", async () => {
  const root = process.env.ERP_FINANCIALS_EPHEMERAL_ROOT;
  const value = process.env.ERP_FINANCIALS_TEST_DATABASE_URL;
  if (!value || !root) throw Error("Disposable PostgreSQL harness required");
  const url = new URL(value), socket = url.searchParams.get("host");
  if (!socket?.startsWith(`${root}/epg-`) || url.pathname !== "/erp_financials_test_correction") throw Error("Refusing non-disposable benchmark target");
  const pool = new Pool({ connectionString: value, max: 6 });
  try {
    const proof = (await pool.query<Record<string, unknown>>("select current_setting('data_directory') directory,inet_server_addr() address,current_setting('listen_addresses') listen,version() version")).rows[0];
    if (!proof) throw new Error("Missing isolation proof");
    expect(proof.directory).toBe(`${socket}/data`); expect(proof.address).toBeNull(); expect(proof.listen).toBe("");
    const runner = createPostgresTransactionRunner(pool);
    await migratePostgresSchema(runner, { appliedByRef: "test:fiscal-scale", targetVersion: 33 });
    await pool.query(`
      insert into erp_financials.accounting_companies values ('scale_company','scale_tenant','Scale','Scale','USD',1,'test','native_erp','scale');
      insert into erp_financials.accounting_sources (source_id,tenant_id,source_system,provider_environment,connection_ref,status)
        values ('scale_source','scale_tenant','native_erp','test','test:scale','active');
      insert into erp_financials.company_sources values ('scale_binding','scale_tenant','scale_company','scale_source',now());
      insert into erp_financials.accounts (account_id,tenant_id,source_id,source_account_id,name,type,classification,active) values
        ('scale_cash','scale_tenant','scale_source','cash','Cash','asset','asset',true),
        ('scale_income','scale_tenant','scale_source','income','Income','income','income',true);
      insert into erp_financials.import_batches (import_batch_id,tenant_id,source_id,mode,status,started_at,completed_at,source_object_counts)
        values ('scale_batch','scale_tenant','scale_source','initial','completed',now(),now(),'{}');
    `);
    const scope = { tenantId: "scale_tenant", companyId: "scale_company", bookId: "scale_book", writeSourceId: "scale_source", currencyCode: "USD" };
    const sdk = createErpFinancialsSdk({ ...scope, database: runner });
    const operation = { actorRef: "scale:preparer", approverRef: "scale:approver", requestId: "scale:request", correlationId: "scale:correlation", reasonCode: "scale-test", occurredAt: "2026-08-31T00:00:00Z" };
    await sdk.books.define({ operation, bookId: scope.bookId, name: "Scale", baseCurrencyCode: "USD" });
    await sdk.books.bindSource({ operation, bookId: scope.bookId, sourceId: scope.writeSourceId, sourceRole: "active" });
    await sdk.commands.fiscalPeriods.define({ operation, fiscalYear: 2026, periodNumber: 8, periodStart: "2026-08-01", periodEnd: "2026-08-31" });
    const journals = 1_000_000, batch = 50_000, seedStart = performance.now();
    for (let start = 1; start <= journals; start += batch) {
      await runner.transaction(async client => {
        await client.query(`insert into erp_financials.transactions
          (transaction_id,tenant_id,source_id,source_transaction_id,source_transaction_type,transaction_date,posted_at,updated_at,currency_code,status)
          select 'scale_j_'||n,'scale_tenant','scale_source',n::text,'JournalEntry',date '2026-08-01'+(n%31)::int,
            timestamptz '2026-08-31T00:00:00Z',timestamptz '2026-08-31T00:00:00Z','USD','posted'
          from generate_series($1::int,$2::int) n`, [start, start + batch - 1]);
        if (start === 1) {
          const explain = () => client.query("explain (format json) select 1 from only erp_financials.transactions x where tenant_id=$1 and source_id=$2 and transaction_id=$3 for key share of x", [scope.tenantId, scope.writeSourceId, "scale_j_1"]);
          const before = await explain();
          await client.query("analyze erp_financials.transactions");
          console.log("SCALE_SEED_PARENT_PLAN", JSON.stringify({ before: before.rows, after: (await explain()).rows }));
        }
        await client.query(`insert into erp_financials.ledger_postings
          (posting_id,tenant_id,source_id,source_posting_id,transaction_id,account_id,posting_date,accounting_basis,
           debit_amount,credit_amount,net_amount,currency_code,dimension_hash,dimension_refs,import_batch_id)
          select 'scale_p_'||n||'_'||side,'scale_tenant','scale_source',n||'_'||side,'scale_j_'||n,
            case when side=0 then 'scale_cash' else 'scale_income' end,date '2026-08-01'+(n%31)::int,'accrual',
            case when side=0 then (n%10000+1)::numeric/100 else 0 end,
            case when side=1 then (n%10000+1)::numeric/100 else 0 end,
            (n%10000+1)::numeric/100*case when side=0 then 1 else -1 end,
            'USD',repeat('0',64),'[]','scale_batch'
          from generate_series($1::int,$2::int) n cross join generate_series(0,1) side`, [start, start + batch - 1]);
      });
      if ((start + batch - 1) % 250_000 === 0) console.log("SCALE_SEED_PROGRESS", start + batch - 1, performance.now() - seedStart);
    }
    const seedMs = performance.now() - seedStart;
    const upgradeStart = performance.now();
    const upgrade = await migratePostgresSchema(runner, { appliedByRef: "test:fiscal-scale-upgrade" });
    const upgradeMs = performance.now() - upgradeStart;
    expect(upgrade.applied.map(item => [item.fromVersion, item.toVersion])).toEqual([[33, 34], [34, 35], [35, 36], [36, 37], [37, 38]]);
    await pool.query("analyze erp_financials.transactions; analyze erp_financials.ledger_postings; analyze erp_financials.fiscal_periods");
    const queries: { sql: string; values: readonly unknown[] }[] = [];
    const journalQueries: { sql: string; values: readonly unknown[] }[] = [];
    let chartQuery: { sql: string; values: readonly unknown[] } | undefined;
    const measured = createErpFinancialsSdk({ ...scope, database: { transaction: work => runner.transaction(client => work({ query: async (sql, values) => {
      if (sql.startsWith("with recursive effective_accounts")) queries.push({ sql, values: values ?? [] });
      if (sql.startsWith("with journal_posted")) journalQueries.push({ sql, values: values ?? [] });
      if (sql.startsWith("with recursive definitions")) chartQuery = { sql, values: values ?? [] };
      return client.query(sql, values);
    } })) } });
    const request = { accountKey: "scale_source:scale_cash", periodStart: "2026-08-01", periodEnd: "2026-08-31", limit: 50 };
    const memoryBefore = process.memoryUsage(), firstMs: number[] = [], nextMs: number[] = [], deepMs: number[] = [];
    const start = performance.now();
    const first = await measured.queries.getAccountRegister(request);
    firstMs.push(performance.now() - start);
    expect(first).toMatchObject({ openingNet: "0.00", closingNet: "50005000.00", debitAmount: "50005000.00", creditAmount: "0.00", postingCount: "1000000" });
    expect(first.items).toHaveLength(50);
    const firstQuery = requiredValue(queries.at(-1));
    const deepBoundary = requiredValue((await pool.query<{ date: string; id: string }>(`select posting_date::text date,posting_id id from erp_financials.ledger_postings
      where tenant_id=$1 and source_id=$2 and account_id='scale_cash' and accounting_basis='accrual'
      order by posting_date,posting_id offset 750000 limit 1`, [scope.tenantId,scope.writeSourceId])).rows[0]);
    // Fixture checkpoint for a deep keyset position. The SDK still calculates the
    // entire prefix from database facts; no client-supplied balance is trusted.
    const cursorFields = JSON.parse(Buffer.from(requiredValue(first.nextCursor), "base64url").toString("utf8")) as Record<string, unknown>;
    const deepCursor = Buffer.from(JSON.stringify({ ...cursorFields, ...deepBoundary })).toString("base64url");
    for (let i = 0; i < 4; i++) {
      let started = performance.now();
      expect((await measured.queries.getAccountRegister(request)).closingNet).toBe(first.closingNet);
      firstMs.push(performance.now() - started);
      started = performance.now();
      const next = await measured.queries.getAccountRegister({ ...request, cursor: requiredValue(first.nextCursor) });
      nextMs.push(performance.now() - started);
      expect(next.items).toHaveLength(50);
      expect(requiredValue(next.items[0]).postingId).not.toBe(requiredValue(first.items[0]).postingId);
      started = performance.now();
      const deep = await measured.queries.getAccountRegister({ ...request, cursor: deepCursor });
      deepMs.push(performance.now() - started);
      expect(deep.items).toHaveLength(50);
      const last = requiredValue(deep.items.at(-1));
      const expected = requiredValue((await pool.query<{ amount: string }>(`select round(sum(net_amount),2)::text amount from erp_financials.ledger_postings
        where tenant_id=$1 and source_id=$2 and account_id='scale_cash' and accounting_basis='accrual'
          and (posting_date,posting_id)<=($3::date,$4::text)`, [scope.tenantId,scope.writeSourceId,last.postingDate,last.postingId])).rows[0]);
      expect(last.runningNet).toBe(expected.amount);
    }
    const deepQuery = requiredValue(queries.at(-1));
    const mid = await measured.queries.getAccountRegister({ ...request, periodStart: "2026-08-15" });
    const controls = requiredValue((await pool.query<{ opening: string; debit: string }>(`select round(sum(net_amount) filter(where posting_date<'2026-08-15'),2)::text opening,
      round(sum(net_amount) filter(where posting_date>='2026-08-15'),2)::text debit from erp_financials.ledger_postings
      where tenant_id=$1 and source_id=$2 and account_id='scale_cash' and accounting_basis='accrual'`, [scope.tenantId,scope.writeSourceId])).rows[0]);
    expect(mid.openingNet).toBe(controls.opening); expect(mid.debitAmount).toBe(controls.debit);
    const concurrentStart = performance.now();
    const concurrent = await Promise.all(Array.from({ length: 4 }, () => measured.queries.getAccountRegister(request)));
    const concurrentMs = performance.now() - concurrentStart;
    for (const page of concurrent) expect(page.closingNet).toBe(first.closingNet);
    const chartRequest = { periodStart: "2026-08-15", periodEnd: "2026-08-31", limit: 1 };
    const chartFirstMs: number[] = [], chartNextMs: number[] = [];
    const chartMemoryBefore = process.memoryUsage();
    for (let i = 0; i < 5; i++) {
      let started = performance.now();
      const chart = await measured.queries.getAccountChart(chartRequest);
      chartFirstMs.push(performance.now() - started);
      expect(chart.items).toHaveLength(1);
      expect(chart.summary).toMatchObject({ accountCount: "2", trialDebit: "50005000.00", trialCredit: "50005000.00",
        openingNet: "0.00", closingNet: "0.00", debitAmount: controls.debit, creditAmount: controls.debit });
      expect(requiredValue(chart.items[0]).direct).toMatchObject({ openingNet: controls.opening, closingNet: "50005000.00", debitAmount: controls.debit, creditAmount: "0.00" });
      expect(requiredValue(chart.items[0]).inclusive).toEqual(requiredValue(chart.items[0]).direct);
      started = performance.now();
      const next = await measured.queries.getAccountChart({ ...chartRequest, cursor: requiredValue(chart.nextCursor) });
      chartNextMs.push(performance.now() - started);
      expect(next.items).toHaveLength(1); expect(next.nextCursor).toBeUndefined(); expect(next.summary).toEqual(chart.summary);
      expect(requiredValue(next.items[0]).direct.closingNet).toBe("-50005000.00");
    }
    const chartConcurrentStart = performance.now();
    const chartConcurrent = await Promise.all(Array.from({ length: 4 }, () => measured.queries.getAccountChart(chartRequest)));
    const chartConcurrentMs = performance.now() - chartConcurrentStart;
    for (const page of chartConcurrent) expect(page.summary.trialDebit).toBe("50005000.00");
    const chart: Record<string, unknown> = { firstMs: chartFirstMs, nextMs: chartNextMs, concurrentMs: chartConcurrentMs,
      concurrentQueriesPerSecond: 4000/chartConcurrentMs, memoryBefore: chartMemoryBefore, memoryAfter: process.memoryUsage(),
      note: "Whole-book direct summary and classification totals, bounded account pages and inclusive metadata rollups; two accounts in this corpus, not a large hierarchy benchmark." };
    const journalRequest = { periodStart: "2026-08-01", periodEnd: "2026-08-31", limit: 50 };
    const journalFirstMs: number[] = [], journalNextMs: number[] = [], journalDetailMs: number[] = [];
    const journalMemoryBefore = process.memoryUsage();
    let journalFirstQuery: { sql: string; values: readonly unknown[] } | undefined, journalDetailQuery: { sql: string; values: readonly unknown[] } | undefined;
    for (let i = 0; i < 3; i++) {
      let started = performance.now();
      const page = await measured.queries.getJournalRegister(journalRequest);
      journalFirstMs.push(performance.now() - started);
      journalFirstQuery ??= journalQueries.at(-1);
      expect(page.summary).toEqual({ journalCount: "1000000", postingCount: "2000000", debitAmount: "50005000.00", creditAmount: "50005000.00" });
      expect(page.items).toHaveLength(50); expect(page.matched).toEqual(page.summary);
      started = performance.now();
      const next = await measured.queries.getJournalRegister({ ...journalRequest, cursor: requiredValue(page.nextCursor) });
      journalNextMs.push(performance.now() - started);
      expect(next.summary).toEqual(page.summary); expect(new Set([...page.items, ...next.items].map(item => item.transactionId)).size).toBe(100);
      const header = requiredValue(page.items[0]);
      started = performance.now();
      const detail = await measured.queries.getJournalPostingPage({ ...journalRequest, sourceId: scope.writeSourceId, transactionId: header.transactionId, limit: 1 });
      journalDetailMs.push(performance.now() - started); journalDetailQuery ??= journalQueries.at(-1);
      expect(detail.journal).toEqual(header); expect(detail.items).toHaveLength(1); expect(detail.nextCursor).toBeDefined();
    }
    const journalConcurrentStart = performance.now();
    const journalConcurrent = await Promise.all(Array.from({ length: 4 }, () => measured.queries.getJournalRegister(journalRequest)));
    const journalConcurrentMs = performance.now() - journalConcurrentStart;
    for (const page of journalConcurrent) expect(page.summary.journalCount).toBe("1000000");
    const journal: Record<string, unknown> = { firstMs: journalFirstMs, nextMs: journalNextMs, detailMs: journalDetailMs,
      concurrentMs: journalConcurrentMs, concurrentQueriesPerSecond: 4000/journalConcurrentMs,
      memoryBefore: journalMemoryBefore, memoryAfter: process.memoryUsage(),
      note: "Imported-style facts without native events or line records; real native provenance and reversal tested in PostgreSQL integration suite. Whole-window database aggregation; not sustained native posting load." };
    const originGroups = [
      { id: "invoices", originModules: ["Invoicing"], transactionTypeContains: ["invoice"] },
      { id: "payments", originModules: ["Payments"], transactionTypeContains: ["payment"] },
      { id: "ap", originModules: ["AP"], transactionTypeContains: ["bill", "payable"] },
      { id: "receiving", originModules: ["Receiving"], transactionTypeContains: ["receipt"] },
      { id: "payroll", originModules: ["Payroll"], transactionTypeContains: ["payroll"] },
      { id: "inventory", originModules: ["Inventory"], transactionTypeContains: ["inventory"] },
      { id: "manual", originModules: ["Manual"], transactionTypeContains: ["journal"] },
    ];
    const groupedRequest = { ...journalRequest, originGroups, originGroupId: "manual" };
    const groupedFirstMs: number[] = [], groupedNextMs: number[] = [];
    let groupedQuery: { sql: string; values: readonly unknown[] } | undefined;
    const groupedMemoryBefore = process.memoryUsage();
    for (let i=0; i<3; i++) {
      let started = performance.now(); const page = await measured.queries.getJournalRegister(groupedRequest);
      groupedFirstMs.push(performance.now()-started); groupedQuery ??= journalQueries.at(-1);
      expect(page.summary.journalCount).toBe("1000000"); expect(page.matched).toEqual(page.summary);
      expect(page.originGroups?.find(group => group.id === "manual")?.journalCount).toBe("1000000");
      expect(page.originGroups?.find(group => group.id === "unclassified")?.journalCount).toBe("0");
      expect(page.items).toHaveLength(50); expect(page.items.every(item => item.originGroupId === "manual")).toBe(true);
      started=performance.now(); const next = await measured.queries.getJournalRegister({ ...groupedRequest, cursor: requiredValue(page.nextCursor) });
      groupedNextMs.push(performance.now()-started); expect(next.originGroups).toEqual(page.originGroups);
    }
    const groupedConcurrentStart=performance.now();
    const groupedConcurrent=await Promise.all(Array.from({length:4},()=>measured.queries.getJournalRegister(groupedRequest)));
    const groupedConcurrentMs=performance.now()-groupedConcurrentStart;
    for(const page of groupedConcurrent) expect(page.matched.journalCount).toBe("1000000");
    const exactStart=performance.now(); const exact=await measured.queries.getJournalRegister({...journalRequest,reference:"scale_j_500000",limit:2});
    const exactMs=performance.now()-exactStart; expect(exact.matched.journalCount).toBe("1"); expect(exact.items[0]?.transactionId).toBe("scale_j_500000");
    journal.originGroups={ firstMs:groupedFirstMs,nextMs:groupedNextMs,concurrentMs:groupedConcurrentMs,concurrentQueriesPerSecond:4000/groupedConcurrentMs,
      exactReferenceMs:exactMs,memoryBefore:groupedMemoryBefore,memoryAfter:process.memoryUsage(),note:"Seven ordered groups; one million imported JournalEntry facts match the last type rule. Includes exact reference filter; not many-source or sustained mixed-workload proof." };
    const plans: unknown[] = [];
    const client = await pool.connect();
    let backendMemory = "";
    try {
      for (const query of [firstQuery, deepQuery]) {
        const explained = (await client.query<{ "QUERY PLAN": { Plan: PlanNode }[] }>(`explain (analyze,buffers,format json) ${query.sql}`, [...query.values])).rows;
        plans.push(explained);
        const root = requiredValue(requiredValue(explained[0])["QUERY PLAN"][0]).Plan;
        const pagePlan = requiredValue(flattenPlan(root).find(node => node["Subplan Name"] === "CTE page"));
        const postingScans = flattenPlan(pagePlan).filter(node => node["Relation Name"] === "ledger_postings");
        expect(postingScans.length).toBeGreaterThan(0);
        for (const scan of postingScans) {
          expect(scan["Index Name"]).toBe("ledger_postings_bank_activity_idx");
          expect(scan["Actual Rows"]).toBeLessThanOrEqual(51);
        }
      }
      const journalPlan = (await client.query<{ "QUERY PLAN": { Plan: PlanNode }[] }>(`explain (analyze,buffers,format json) ${requiredValue(journalFirstQuery).sql}`, [...requiredValue(journalFirstQuery).values])).rows;
      journal.plan = journalPlan;
      const journalRoot = requiredValue(requiredValue(journalPlan[0])["QUERY PLAN"][0]).Plan;
      const headerScans = flattenPlan(journalRoot).filter(node => node["Relation Name"] === "transactions");
      expect(headerScans.length).toBeGreaterThan(0);
      for (const scan of headerScans) expect(Number(scan["Actual Rows"])*Number(scan["Actual Loops"])).toBeLessThanOrEqual(51);
      journal.originGroupPlan = (await client.query(`explain (analyze,buffers,format json) ${requiredValue(groupedQuery).sql}`, [...requiredValue(groupedQuery).values])).rows;
      const detailPlan = (await client.query<{ "QUERY PLAN": { Plan: PlanNode }[] }>(`explain (analyze,buffers,format json) ${requiredValue(journalDetailQuery).sql}`, [...requiredValue(journalDetailQuery).values])).rows;
      journal.detailPlan = detailPlan;
      const detailRoot = requiredValue(requiredValue(detailPlan[0])["QUERY PLAN"][0]).Plan;
      const detailScans = flattenPlan(detailRoot).filter(node => node["Relation Name"] === "ledger_postings");
      expect(detailScans.length).toBeGreaterThan(0);
      for (const scan of detailScans) { expect(scan["Index Name"]).toBe("ledger_postings_transaction_read_idx"); expect(scan["Actual Rows"]).toBeLessThanOrEqual(2); }
      const capturedChart = requiredValue(chartQuery);
      chart.plan = (await client.query(`explain (analyze,buffers,format json) ${capturedChart.sql}`, [...capturedChart.values])).rows;
      const pid = requiredValue((await client.query<{ pid: number }>("select pg_backend_pid() pid")).rows[0]).pid;
      backendMemory = (await readFile(`/proc/${String(pid)}/status`, "utf8")).split("\n").filter(line => /^Vm(RSS|HWM|Size):/.test(line)).join("\n");
    } finally { client.release(); }
    // Isolated diagnostic, after the comparable baseline measurements. Small
    // binding tables may never reach auto-analyze thresholds; report the effect
    // explicitly rather than silently measuring only ideal planner statistics.
    await pool.query("analyze erp_financials.reporting_book_sources");
    const afterMetadataAnalyzeMs: number[] = [];
    for (let i=0; i<3; i++) {
      const started=performance.now(), page=await measured.queries.getJournalRegister(groupedRequest);
      afterMetadataAnalyzeMs.push(performance.now()-started);
      expect(page.summary.journalCount).toBe("1000000"); expect(page.matched).toEqual(page.summary);
    }
    journal.afterMetadataAnalyze={ groupedFirstMs: afterMetadataAnalyzeMs,
      note: "Diagnostic only: ANALYZE of the disposable reporting_book_sources table after baseline measurement. Not a production setting, runtime command or deployment prerequisite." };
    journal.afterMetadataAnalyzePlan=(await pool.query(`explain (analyze,buffers,format json) ${requiredValue(groupedQuery).sql}`, [...requiredValue(groupedQuery).values])).rows;
    const settings = (await pool.query("select name,setting,unit from pg_settings where name=any($1::text[])", [["shared_buffers", "work_mem", "max_parallel_workers_per_gather", "effective_cache_size", "fsync"]])).rows;
    console.log("ACCOUNT_REGISTER_SCALE", JSON.stringify({
      workload: { journals, ledgerPostings: journals*2, accountPostings: journals, sources: 1, bases: 1, currencies: 1, dates: 31, accounts: 2, pageSize: 50,
        deepCheckpointOffset: 750000, warmRuns: 4, concurrentReaders: 4, note: "Synthetic posted journal corpus; bounded first/next/deep pages and exact summaries. Deep cursor uses a fixture-selected posting boundary. Does not measure sustained load, many accounts/sources or browser latency." },
      hardware: { cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, hostMemoryBytes: os.totalmem(), platform: os.platform(), node: process.version },
      journal, chart, database: { version: proof.version, settings }, seedMs, upgradeMs, firstMs, nextMs, deepMs, concurrentMs, concurrentQueriesPerSecond: 4000/concurrentMs,
      money: { opening: first.openingNet, closing: first.closingNet, midmonthOpening: mid.openingNet, midmonthDebit: mid.debitAmount },
      memory: { before: memoryBefore, after: process.memoryUsage(), nodeMaxRssKiB: process.resourceUsage().maxRSS, postgresBackend: backendMemory }, plans
    }));
  } finally { await pool.end(); }
}, 900_000);

function requiredValue<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing scale fixture value");
  return value;
}

type PlanNode = { readonly Plans?: readonly PlanNode[]; readonly [key: string]: unknown };
function flattenPlan(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flattenPlan)];
}
