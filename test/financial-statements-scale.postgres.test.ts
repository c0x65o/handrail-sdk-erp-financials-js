import { readFile } from "node:fs/promises";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { createErpFinancialsSdk, createPostgresTransactionRunner, migratePostgresSchema, withPostgresAccountingAccess, installPostgresAccountingHostGuards } from "../src/index.js";

// Explicit isolated workload, not a release acceptance threshold. A smaller
// fixture is available for harness validation; only the default is million-scale.
const enabled = process.env.ERP_FINANCIALS_RUN_SCALE_TESTS === "1";
it.skipIf(!enabled)("measures coherent statement batches over multi-year postings and concurrent native journals", async () => {
  const root = process.env.ERP_FINANCIALS_EPHEMERAL_ROOT, value = process.env.ERP_FINANCIALS_TEST_DATABASE_URL;
  if (!value || !root) throw Error("Disposable PostgreSQL harness required");
  const url = new URL(value), socket = url.searchParams.get("host");
  if (!socket?.startsWith(`${root}/epg-`) || url.pathname !== "/erp_financials_test_correction") throw Error("Refusing non-disposable benchmark target");
  const journals = Number(process.env.ERP_FINANCIALS_SCALE_JOURNALS ?? "1000000");
  if (!Number.isSafeInteger(journals) || journals < 10_000 || journals > 1_000_000) throw Error("Invalid fixture size");
  const pool = new Pool({ connectionString: value, max: 10, statement_timeout: 30_000 });
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
          case when side='debit' then 'asset' else 'income' end,case when side='debit' then 'asset' else 'income' end,true
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
    const monthTotals = Array<bigint>(12).fill(0n); let wholeCents = 0n;
    for (let n = 1; n <= journals; n++) {
      const cents = BigInt(n % 10000 + 1); wholeCents += cents;
      const day = new Date(Date.UTC(2021,8,1) + (n % 1826) * 86400000);
      if (day.getUTCFullYear() === 2026) monthTotals[day.getUTCMonth()] = required(monthTotals[day.getUTCMonth()]) + cents;
    }
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
            case when side=0 then (n%10000+1)::numeric/100 else 0 end,case when side=1 then (n%10000+1)::numeric/100 else 0 end,
            (n%10000+1)::numeric/100*case when side=0 then 1 else -1 end,'USD',repeat('0',64),'[]','batch-'||source
          from (select n,d,case when d<'2024-01-01' then 'mixed_history' else 'mixed_current' end source
            from (select n,date '2021-09-01'+(n%1826)::int d from generate_series($1::int,$2::int) n) dates) fixture cross join generate_series(0,1) side`, [start, end]);
      });
      if (Math.min(journals, start + batch - 1) % 250_000 === 0) console.log("STATEMENT_SCALE_SEED_PROGRESS", start + batch - 1, performance.now() - seedStarted);
    }
    const seedMs = performance.now() - seedStarted, upgradeStarted = performance.now();
    await migratePostgresSchema(runner, { appliedByRef: "test:mixed-scale-upgrade" });
    const upgradeMs = performance.now() - upgradeStarted;
    // Model the current host boundary: ordinary reports enter the accounting
    // gate, while each native posting shares its transaction with a guarded
    // operational receipt. No financial amount is stored in the host table.
    await pool.query('create table public.scale_operation_receipts(id bigint generated always as identity primary key)');
    await runner.transaction(client => installPostgresAccountingHostGuards(client, {
      acknowledgeDatabaseWideMaintenance: true, relations: [{ schema: 'public', table: 'scale_operation_receipts' }],
    }));
    const guarded = withPostgresAccountingAccess(runner);
    const guardedReads = createErpFinancialsSdk({ ...scope, database: guarded });
    const guardedWriter = createErpFinancialsSdk({ ...scope, database: { transaction: work => guarded.transaction(async client => {
      const result = await work(client);
      await client.query('insert into public.scale_operation_receipts default values');
      return result;
    }) } });

    // State the statistics policy rather than silently comparing with the prior
    // single-month fixture's pre-ANALYZE binding table.
    await pool.query("analyze erp_financials.transactions; analyze erp_financials.ledger_postings; analyze erp_financials.reporting_book_sources; analyze erp_financials.accounts; analyze erp_financials.fiscal_periods");
    const statements = Array.from({length:12},(_,month)=>({reportName:"profit_and_loss" as const,
      periodStart:`2026-${String(month+1).padStart(2,"0")}-01`,periodEnd:new Date(Date.UTC(2026,month+1,0)).toISOString().slice(0,10)}));
    const request = { statements: [...statements,
      {reportName:"balance_sheet" as const,periodStart:"2026-01-01",periodEnd:"2026-08-31"},
      {reportName:"trial_balance" as const,periodStart:"2026-01-01",periodEnd:"2026-08-31"},
    ] };
    let captured: {sql:string;values:readonly unknown[]}|undefined;
    const measured=createErpFinancialsSdk({...scope,database:{transaction:work=>guarded.transaction(client=>work({query:(sql,values)=>{
      if(sql.includes("/* financial_statement_snapshot */"))captured={sql,values:values??[]};
      return client.query(sql,values);
    }}))}});
    const check=(batch:Awaited<ReturnType<typeof sdk.queries.getFinancialStatements>>, maxDelta:bigint)=>{
      expect(batch).toHaveLength(14);
      const delta=minor(required(batch[7]).totals.netIncome)-required(monthTotals[7]);
      expect(delta>=0n&&delta<=maxDelta).toBe(true);
      for(let month=0;month<12;month++){
        const amount=money(required(monthTotals[month])+(month===7?delta:0n));
        expect(required(batch[month]).totals).toEqual({income:amount,costOfGoodsSold:"0.00",grossProfit:amount,expenses:"0.00",netIncome:amount});
      }
      const total=money(wholeCents+delta);
      expect(required(batch[12]).totals).toEqual({assets:total,liabilities:"0.00",equity:total,difference:"0.00"});
      expect(required(batch[13]).totals).toEqual({debits:total,credits:total,difference:"0.00"});
      return delta;
    };
    const postmaster=Number((await readFile(`${proof.directory}/postmaster.pid`,"utf8")).split("\n")[0]);
    const memorySamples:{pssKiB:number;rssKiB:number;processes:number}[]=[];
    const batchMs:number[]=[];
    for(let i=0;i<3;i++){const start=performance.now();const result=await measured.queries.getFinancialStatements(request);batchMs.push(performance.now()-start);expect(check(result,0n)).toBe(0n);memorySamples.push(await postgresMemory(postmaster));}
    const nativeWrites=400,writerCount=4,readerCount=4,postingMs:number[]=[],readMs:number[]=[],lockSamples:number[]=[];
    let done=false,writerDurationMs=0;
    const sampling=new AbortController(),memoryBefore=process.memoryUsage(),started=performance.now();
    const sampler=(async()=>{while(!sampling.signal.aborted){const row=required((await pool.query<{n:string}>("select count(*)::text n from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and wait_event_type='Lock'")).rows[0]);lockSamples.push(Number(row.n));memorySamples.push(await postgresMemory(postmaster));await delay(200);}})();
    const writers=Promise.all(Array.from({length:writerCount},async(_,worker)=>{
      for(let n=worker;n<nativeWrites;n+=writerCount){const key=`statement-native-${String(n)}`,start=performance.now();
        await guardedWriter.commands.journalEntries.post({operation:{...operation,requestId:key},idempotencyKey:key,date:"2026-08-31",origin:{module:"Manual",reference:key},lines:[{accountId:"mixed_current-debit-0",debit:"0.01"},{accountId:"mixed_current-credit-0",credit:"0.01"}]});postingMs.push(performance.now()-start);}
    })).finally(()=>{done=true;writerDurationMs=performance.now()-started;});
    const readers=Promise.all(Array.from({length:readerCount},async()=>{let count=0;do{const start=performance.now();const result=await measured.queries.getFinancialStatements(request);readMs.push(performance.now()-start);check(result,BigInt(nativeWrites));count++;}while(!done||count<2);}));
    try{const outcomes=await Promise.allSettled([writers,readers]);for(const outcome of outcomes)if(outcome.status==='rejected')throw outcome.reason;}finally{sampling.abort();await sampler;}
    const contentionMs=performance.now()-started;
    expect(check(await guardedReads.queries.getFinancialStatements(request),BigInt(nativeWrites))).toBe(BigInt(nativeWrites));
    expect((await pool.query<{count:string}>('select count(*)::text count from public.scale_operation_receipts')).rows[0]?.count).toBe(String(nativeWrites));
    const query=required(captured),plan=(await pool.query(`explain (analyze,buffers,format json) ${query.sql}`,[...query.values])).rows;
    const memoryClient=await pool.connect();let sampledBackend:string;
    try{const pid=required((await memoryClient.query<{pid:number}>("select pg_backend_pid() pid")).rows[0]).pid;sampledBackend=(await readFile(`/proc/${String(pid)}/status`,"utf8")).split("\n").filter(line=>/^Vm(RSS|HWM|Size):/.test(line)).join("\n");}finally{memoryClient.release();}
    const settings=(await pool.query("select name,setting,unit from pg_settings where name=any($1::text[])",[["shared_buffers","work_mem","max_parallel_workers_per_gather","effective_cache_size","fsync","jit"]])).rows;
    console.log("FINANCIAL_STATEMENTS_SCALE",JSON.stringify({workload:{journals,ledgerPostings:journals*2,accounts:200,sources:2,dates:1826,tenantCount:1,companyCount:1,currency:"USD",basis:"accrual",statementWindows:14,nativeWrites,writerCount,readerCount,accountingAccessGuards:true,transactionalHostReceipts:nativeWrites,hostWriteGuards:true},hardware:{cpu:os.cpus()[0]?.model,logicalCpus:os.cpus().length,hostMemoryBytes:os.totalmem(),node:process.version,cgroupMemoryMax:await optionalFile('/sys/fs/cgroup/memory.max'),cgroupCpuMax:await optionalFile('/sys/fs/cgroup/cpu.max')},database:{version:proof.version,settings},seedMs,upgradeMs,batchMs,contention:{durationMs:contentionMs,writerDurationMs,postingMs,readMs,postingTransactionsPerSecond:nativeWrites*1000/writerDurationMs,lockSamples:lockSamples.length,maxConcurrentLockWaiters:Math.max(0,...lockSamples)},controls:{monthly:monthTotals.map(money),whole:money(wholeCents),nativeAdded:money(BigInt(nativeWrites))},memory:{before:memoryBefore,after:process.memoryUsage(),nodeMaxRssKiB:process.resourceUsage().maxRSS,sampledBackend,postgresPeakSampledPssKiB:Math.max(0,...memorySamples.map(sample=>sample.pssKiB)),postgresPeakSummedRssKiB:Math.max(0,...memorySamples.map(sample=>sample.rssKiB))},plan,limitations:["Synthetic five-year two-source USD accrual distribution with200accounts; not production sizing or sustained soak acceptance.","Bulk imported historical journals;400nativepennyjournals during reads. Counts and exact controls checked from independent integer oracle.","PSS samples include only this disposable server tree during report reads/concurrency; short-lived workers may escape samples. Summed RSS double-counts shared pages. Lock samples omit waits between200ms samples.","Twelve monthly P&Ls plus balance sheet and trial balance atAugust31; no documents/subledger workload in this fixture."]}));
  }finally{await pool.end();}
},300_000);
function required<T>(value:T|undefined):T{if(value===undefined)throw Error("Expected fixture value");return value;}
function money(cents:bigint):string{return `${String(cents/100n)}.${String(cents%100n).padStart(2,"0")}`;}
function minor(value:string|undefined):bigint{if(!value||!/^\d+\.\d{2}$/.test(value))throw Error("Invalid exact fixture amount");return BigInt(value.replace('.',''));}

async function optionalFile(path:string):Promise<string>{try{return(await readFile(path,"utf8")).trim();}catch{return "unavailable";}}
async function postgresMemory(root:number){const pending=[root],seen=new Set<number>();let pssKiB=0,rssKiB=0;while(pending.length){const pid=required(pending.pop());if(seen.has(pid))continue;seen.add(pid);try{const data=await readFile(`/proc/${String(pid)}/smaps_rollup`,"utf8");pssKiB+=Number(/^Pss:\s+(\d+)/mu.exec(data)?.[1]??0);rssKiB+=Number(/^Rss:\s+(\d+)/mu.exec(data)?.[1]??0);const children=(await readFile(`/proc/${String(pid)}/task/${String(pid)}/children`,"utf8")).trim();if(children)pending.push(...children.split(/\s+/u).map(Number));}catch{/* A backend may exit between samples. */}}return {pssKiB,rssKiB,processes:seen.size};}
