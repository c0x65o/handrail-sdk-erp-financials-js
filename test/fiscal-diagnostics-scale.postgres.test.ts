import { readFile } from "node:fs/promises";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { createErpFinancialsSdk, createPostgresTransactionRunner, migratePostgresSchema } from "../src/index.js";

// Explicit, expensive benchmark. Run through the disposable PostgreSQL harness.
const enabled = process.env.ERP_FINANCIALS_RUN_SCALE_TESTS === "1";
it.skipIf(!enabled)("measures fiscal diagnostics against one million journals", async () => {
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
    const period = await sdk.commands.fiscalPeriods.define({ operation, fiscalYear: 2026, periodNumber: 8, periodStart: "2026-08-01", periodEnd: "2026-08-31" });
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
    let diagnosticSql = ""; let diagnosticValues: readonly unknown[] = [];
    const measured = createErpFinancialsSdk({ ...scope, database: { transaction: work => runner.transaction(client => work({ query: async (sql, values) => {
      if (sql.startsWith("with fiscal_close_period")) { diagnosticSql = sql; diagnosticValues = values ?? []; }
      return client.query(sql, values);
    } })) } });
    const memoryBefore = process.memoryUsage();
    const timings: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      const result = await measured.queries.getFiscalCloseDiagnostics("scale_source", period.fiscalPeriodId);
      timings.push(performance.now() - start);
      expect(result).toMatchObject({ postingCount: "2000000", postedTransactionCount: "1000000", postingGroupCount: "1000000", unbalancedPostingGroupCount: "0", draftTransactionCount: "0", draftInvoiceCount: "0" });
    }
    const concurrentStart = performance.now();
    await Promise.all(Array.from({ length: 4 }, () => measured.queries.getFiscalCloseDiagnostics("scale_source", period.fiscalPeriodId)));
    const concurrentMs = performance.now() - concurrentStart;
    const client = await pool.connect();
    let plan: unknown; let backendMemory = "";
    try {
      plan = (await client.query<Record<string, unknown>>(`explain (analyze,buffers,format json) ${diagnosticSql}`, [...diagnosticValues])).rows;
      const pid = (await client.query<{ pid: number }>("select pg_backend_pid() pid")).rows[0]?.pid;
      if (pid === undefined) throw new Error("Missing benchmark backend PID");
      backendMemory = (await readFile(`/proc/${String(pid)}/status`, "utf8")).split("\n").filter(line => /^Vm(RSS|HWM|Size):/.test(line)).join("\n");
    } finally { client.release(); }
    const reviewStart = performance.now();
    const reviewed = await sdk.queries.getCanonicalFiscalCloseReadiness(scope.writeSourceId, period.fiscalPeriodId, []);
    const reviewMs = performance.now() - reviewStart;
    await sdk.commands.fiscalPeriods.define({ operation, fiscalYear: 2026, periodNumber: 9, periodStart: "2026-09-01", periodEnd: "2026-09-30" });
    const postLatencies: number[] = [], postingMemoryBefore = process.memoryUsage(), postingBenchmarkStart = performance.now();
    const nativeCommands = 100, nativeConcurrency = 4;
    for (let start = 0; start < nativeCommands; start += nativeConcurrency) {
      await Promise.all(Array.from({ length: nativeConcurrency }, async (_, offset) => {
        const started = performance.now();
        await sdk.commands.deposits.record({ operation, idempotencyKey: `scale:native:${String(start + offset)}`, date: "2026-09-12", amount: "1.00",
          bankAccount: { accountId: "scale_cash" }, clearingAccount: { accountId: "scale_income" } });
        postLatencies.push(performance.now() - started);
      }));
    }
    const postingBenchmarkMs = performance.now() - postingBenchmarkStart;
    const sortedLatencies = [...postLatencies].sort((a, b) => a - b);
    const nativePosting = { commands: nativeCommands, concurrency: nativeConcurrency, durationMs: postingBenchmarkMs,
      commandsPerSecond: nativeCommands * 1000 / postingBenchmarkMs, p50Ms: sortedLatencies[49], p95Ms: sortedLatencies[94],
      latenciesMs: postLatencies, memoryBefore: postingMemoryBefore, memoryAfter: process.memoryUsage(),
      note: "100 native deposit commands in batches of four on one source, in the following period; includes source-lock contention. A warm small burst, not sustained throughput." };
    expect((await sdk.queries.getCanonicalFiscalCloseReadiness(scope.writeSourceId, period.fiscalPeriodId, [])).approvalToken).toBe(reviewed.approvalToken);
    const closeStart = performance.now();
    const closeCommand = { operation, fiscalPeriodId: period.fiscalPeriodId, expectedVersion: 1,
      idempotencyKey: "scale:close", expectedApprovalToken: reviewed.approvalToken, bookId: scope.bookId, bankAccountIds: [] };
    // This isolates source-wide certificate aggregation. It does not validate
    // bank-statement scale or endorse an empty production bank policy.
    let entered!: () => void;
    const sourceLocked = new Promise<void>(resolve => { entered = resolve; });
    const closingSdk = createErpFinancialsSdk({ ...scope, database: { transaction: work => runner.transaction(client => work({ query: async <Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) => {
      const result = await client.query<Row>(sql, values);
      if (sql.includes("pg_advisory_xact_lock") && values?.[0] === "payment-correction:scale_tenant:scale_source") entered();
      return result;
    } })) } });
    const closing = closingSdk.commands.fiscalPeriods.closeCanonical(closeCommand);
    await Promise.race([sourceLocked, closing.then(() => { throw new Error("Close did not expose source lock boundary"); })]);
    const postingStart = performance.now();
    const blockedPost = sdk.commands.deposits.record({ operation, idempotencyKey: "scale:close-racing-post", date: "2026-08-20", amount: "1.00",
      bankAccount: { accountId: "scale_cash" }, clearingAccount: { accountId: "scale_income" } }).then(
      () => ({ status: "posted", ms: performance.now() - postingStart }),
      (error: unknown) => ({ status: error && typeof error === "object" && "code" in error ? error.code : "unknown", ms: performance.now() - postingStart })
    );
    let blocked = false;
    for (let i = 0; i < 200 && !blocked; i++) {
      blocked = (await pool.query("select 1 from pg_stat_activity where datname=current_database() and cardinality(pg_blocking_pids(pid))>0")).rows.length > 0;
      if (!blocked) await new Promise(resolve => setTimeout(resolve, 10));
    }
    const closed = await closing;
    const closeMs = performance.now() - closeStart;
    const competingPost = await blockedPost;
    expect(blocked).toBe(true); expect(competingPost.status).toBe("fiscal_period_closed");
    const totalsStart = performance.now();
    const totals = await sdk.fiscalCloseCertificates.totals({ certificateId: closed.certificateId });
    const totalsMs = performance.now() - totalsStart;
    expect(totals.items).toHaveLength(2); expect(totals.nextCursor).toBeUndefined();
    const cashTotal = totals.items.find(row => row.accountId === "scale_cash");
    if (!cashTotal) throw new Error("Missing cash control total");
    expect(cashTotal.openingNet).toMatch(/^0(?:\.0+)?$/);
    expect(cashTotal.debitAmount).toMatch(/^50005000(?:\.0+)?$/);
    expect(cashTotal.creditAmount).toMatch(/^0(?:\.0+)?$/);
    expect(cashTotal.closingNet).toMatch(/^50005000(?:\.0+)?$/);
    expect(cashTotal.postingCount).toBe("1000000");
    expect(cashTotal.historicalPostingCount).toBe("1000000");
    const replayStart = performance.now();
    expect((await sdk.commands.fiscalPeriods.closeCanonical(closeCommand)).outcome).toBe("already_closed");
    const replayMs = performance.now() - replayStart;
    const rowCounts = (await pool.query<Record<string, unknown>>("select (select count(*)::text from erp_financials.transactions) transactions,(select count(*)::text from erp_financials.ledger_postings) postings,(select count(*)::text from erp_financials.subledger_documents where document_type='deposit' and document_date='2026-09-12') native_deposits")).rows[0];
    expect(rowCounts?.native_deposits).toBe("100");
    const settings = (await pool.query<Record<string, unknown>>("select name,setting,unit from pg_settings where name=any($1::text[])", [["shared_buffers", "work_mem", "max_parallel_workers_per_gather", "effective_cache_size", "fsync"]])).rows;
    const relationBytes = (await pool.query<Record<string, unknown>>("select pg_total_relation_size('erp_financials.transactions')::text transactions,pg_total_relation_size('erp_financials.ledger_postings')::text postings")).rows[0];
    console.log("FISCAL_DIAGNOSTICS_SCALE", JSON.stringify({
      workload: { journals, ledgerPostings: journals * 2, sources: 1, bases: 1, currencies: 1, dates: 31, accounts: 2, warmRuns: 5, concurrentReaders: 4, note: "Synthetic SQL seed; measures diagnostics, certificate capture and one competing rejected post. Native posting is measured separately as a small following-period burst; does not measure bank reconciliation scale or a representative business workload." },
      hardware: { cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, hostMemoryBytes: os.totalmem(), platform: os.platform(), release: os.release(), node: process.version },
      nativePosting,
      certificate: { reviewMs, closeMs, totalsMs, replayMs, competingPost, observedDatabaseBlocking: blocked, accountTotals: totals.items.length, bankChecks: 0, includesDeferredDatabaseValidation: true },
      database: { version: proof.version, settings, relationBytes, rowCounts }, seedMs, upgradeMs, queryMs: timings, concurrentMs, concurrentQueriesPerSecond: 4000 / concurrentMs,
      memory: { before: memoryBefore, after: process.memoryUsage(), nodeMaxRssKiB: process.resourceUsage().maxRSS, postgresDiagnosticBackend: backendMemory }, plan
    }));
  } finally { await pool.end(); }
}, 900_000);
