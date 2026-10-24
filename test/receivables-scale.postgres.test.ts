import { readFile } from "node:fs/promises";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { createErpFinancialsSdk, createPostgresTransactionRunner, migratePostgresSchema } from "../src/index.js";

const enabled = process.env.ERP_FINANCIALS_RUN_SCALE_TESTS === "1";
// This is an opt-in measurement, not a production latency promise. All bulk SQL
// is disposable fixture construction with the latest constraints/triggers on.
it.skipIf(!enabled)("measures million-invoice aging and register controls with concurrent native invoices", async () => {
  const root = process.env.ERP_FINANCIALS_EPHEMERAL_ROOT, value = process.env.ERP_FINANCIALS_TEST_DATABASE_URL;
  if (!value || !root) throw Error("Disposable PostgreSQL harness required");
  const url = new URL(value), socket = url.searchParams.get("host");
  if (!socket?.startsWith(`${root}/epg-`) || url.pathname !== "/erp_financials_test_correction") throw Error("Refusing non-disposable benchmark target");
  const invoices = Number(process.env.ERP_FINANCIALS_SCALE_INVOICES ?? "1000000");
  if (!Number.isSafeInteger(invoices) || invoices < 10_000 || invoices > 1_000_000 || invoices % 4 !== 0) throw Error("Invalid fixture size");
  const pool = new Pool({ connectionString: value, max: 10, statement_timeout: 180_000 });
  try {
    const proof = required((await pool.query<{ directory: string; address: unknown; listen: string; version: string }>("select current_setting('data_directory') directory,inet_server_addr() address,current_setting('listen_addresses') listen,version() version")).rows[0]);
    expect(proof.directory).toBe(`${socket}/data`); expect(proof.address).toBeNull(); expect(proof.listen).toBe("");
    const runner = createPostgresTransactionRunner(pool);
    await migratePostgresSchema(runner, { appliedByRef: "test:receivables-scale" });
    await pool.query(`
      insert into erp_financials.accounting_companies values ('ar_company','ar_tenant','AR','AR','USD',1,'test','native_erp','ar');
      insert into erp_financials.accounting_sources (source_id,tenant_id,source_system,provider_environment,connection_ref,status)
        values ('ar_source','ar_tenant','native_erp','test','test:ar','active');
      insert into erp_financials.company_sources values ('ar_binding','ar_tenant','ar_company','ar_source',now());
      insert into erp_financials.accounts (account_id,tenant_id,source_id,source_account_id,account_number,name,type,classification,active)
        select id,'ar_tenant','ar_source',id,num,id,kind,kind,true from (values ('ar','1200','asset'),('cash','1000','asset'),('income','4000','income')) a(id,num,kind);
      insert into erp_financials.parties (party_id,tenant_id,source_id,source_party_id,party_type,display_name,active)
        select 'customer_'||lpad(n::text,5,'0'),'ar_tenant','ar_source',n::text,'customer','Customer '||n,true from generate_series(0,9999) n;
      insert into erp_financials.import_batches (import_batch_id,tenant_id,source_id,mode,status,started_at,completed_at,source_object_counts)
        values ('ar_batch','ar_tenant','ar_source','initial','completed',now(),now(),'{}');
    `);
    const scope = { tenantId: "ar_tenant", companyId: "ar_company", bookId: "ar_book", writeSourceId: "ar_source", currencyCode: "USD" };
    const sdk = createErpFinancialsSdk({ ...scope, database: runner });
    const operation = { actorRef: "scale:preparer", approverRef: "scale:approver", requestId: "scale:setup", correlationId: "scale:ar", reasonCode: "scale-test", occurredAt: "2026-08-31T00:00:00Z" };
    await sdk.books.define({ operation, bookId: scope.bookId, name: "AR", baseCurrencyCode: "USD" });
    await sdk.books.bindSource({ operation, bookId: scope.bookId, sourceId: scope.writeSourceId, sourceRole: "active" });
    await sdk.commands.fiscalPeriods.define({ operation, fiscalYear: 2026, periodNumber: 8, periodStart: "2026-08-01", periodEnd: "2026-08-31" });
    const seedStarted = performance.now();
    for (let start = 1; start <= invoices; start += 10_000) {
      await runner.transaction(async client => {
        const end = Math.min(invoices,start+9999);
        await client.query(`create temporary table fixture on commit drop as
          select n,kind,'ar_'||kind||'_'||n id,'customer_'||lpad((n%10000)::text,5,'0') party,
            date '2026-01-01'+(n%243)::int d,(n%10000+100)*4*(case when kind='invoice' then 1 else 0.5 end)::numeric/100 amount
          from generate_series($1::int,$2::int) n cross join (values ('invoice'),('customer_payment')) k(kind)
          where kind='invoice' or n%4=0`,[start,end]);
        await client.query(`insert into erp_financials.transactions
          (transaction_id,tenant_id,source_id,source_transaction_id,source_transaction_type,transaction_date,posted_at,updated_at,currency_code,status,party_id)
          select id,'ar_tenant','ar_source',id,'Subledger:'||kind,d,timestamptz '2026-09-06',timestamptz '2026-09-06','USD','posted',party from fixture`);
        if(start===1) await client.query("analyze erp_financials.transactions");
        await client.query(`insert into erp_financials.ledger_postings
          (posting_id,tenant_id,source_id,source_posting_id,transaction_id,account_id,posting_date,accounting_basis,debit_amount,credit_amount,net_amount,currency_code,dimension_hash,dimension_refs,import_batch_id)
          select id||'_'||side,'ar_tenant','ar_source',id||'_'||side,id,
            case when kind='invoice' then case when side=0 then 'ar' else 'income' end else case when side=0 then 'cash' else 'ar' end end,
            d,'accrual',case when side=0 then amount else 0 end,case when side=1 then amount else 0 end,
            amount*case when side=0 then 1 else -1 end,'USD',repeat('0',64),'[]','ar_batch'
          from fixture cross join generate_series(0,1) side`);
        await client.query(`insert into erp_financials.financial_lifecycle_events
          (event_id,tenant_id,company_id,source_id,aggregate_type,aggregate_id,event_type,actor_ref,request_id,correlation_id,reason_code,occurred_at,recorded_at,idempotency_key,payload_checksum,payload)
          select id||'_event','ar_tenant','ar_company','ar_source','subledger_document',id,'scale_fixture_import','scale:preparer',id,'scale:ar','scale-test',d::timestamptz,timestamptz '2026-09-06',id,encode(sha256(convert_to('{}','UTF8')),'hex'),'{}' from fixture`);
        await client.query(`insert into erp_financials.subledger_documents
          (subledger_document_id,tenant_id,company_id,source_id,document_type,transaction_id,party_id,document_number,document_date,due_date,currency_code,original_amount,open_amount,status,version,idempotency_key,lifecycle_event_id,metadata,created_at,updated_at)
          select id,'ar_tenant','ar_company','ar_source',kind,id,party,id,d,case when kind='invoice' then d+30 else null end,'USD',amount,amount,'open',1,id,id||'_event','{}',timestamptz '2026-09-06',timestamptz '2026-09-06' from fixture`);
        await client.query(`insert into erp_financials.financial_lifecycle_events
          (event_id,tenant_id,company_id,source_id,aggregate_type,aggregate_id,event_type,actor_ref,request_id,correlation_id,reason_code,occurred_at,recorded_at,idempotency_key,payload_checksum,payload)
          select 'ar_app_'||n||'_event','ar_tenant','ar_company','ar_source','subledger_application','ar_app_'||n,'payment_applied','scale:preparer','app_'||n,'scale:ar','scale-test',(d+5)::timestamptz,timestamptz '2026-09-06','app_'||n,
            encode(sha256(convert_to(jsonb_build_object('applicationDate',(d+5)::text)::text,'UTF8')),'hex'),jsonb_build_object('applicationDate',(d+5)::text)
          from fixture where kind='customer_payment'`);
        // Two immutable delivery attempts on every fifth invoice: latest
        // success/failure must affect only presentation, never summary balances.
        await client.query(`create temporary table delivery_fixture on commit drop as
          select id, id||'_delivery_'||attempt delivery_id,d+attempt delivery_date,
            case when attempt=1 then 'sent' when n%10=0 then 'failed' else 'delivered' end delivery_status
          from fixture cross join generate_series(1,2) attempt where kind='invoice' and n%5=0`);
        await client.query(`insert into erp_financials.financial_lifecycle_events
          (event_id,tenant_id,company_id,source_id,aggregate_type,aggregate_id,event_type,actor_ref,request_id,correlation_id,reason_code,occurred_at,recorded_at,idempotency_key,payload_checksum,payload)
          select delivery_id||'_event','ar_tenant','ar_company','ar_source','invoice',id,'invoice.delivery_'||delivery_status,'scale:preparer',delivery_id,'scale:ar','scale-test',delivery_date::timestamptz,timestamptz '2026-09-06',delivery_id,
            encode(sha256(convert_to(jsonb_build_object('channel','email','deliveryStatus',delivery_status)::text,'UTF8')),'hex'),jsonb_build_object('channel','email','deliveryStatus',delivery_status) from delivery_fixture`);
        await client.query(`insert into erp_financials.subledger_document_delivery_events
          (delivery_event_id,tenant_id,company_id,source_id,subledger_document_id,delivery_status,channel,lifecycle_event_id,occurred_at)
          select delivery_id,'ar_tenant','ar_company','ar_source',id,delivery_status,'email',delivery_id||'_event',delivery_date::timestamptz from delivery_fixture`);
        if(start===1) await client.query("analyze erp_financials.subledger_documents; analyze erp_financials.financial_lifecycle_events");
        await client.query(`insert into erp_financials.subledger_applications
          (subledger_application_id,tenant_id,company_id,source_id,application_type,source_document_id,target_document_id,applied_amount,currency_code,application_date,status,version,idempotency_key,applied_event_id,created_at,updated_at)
          select 'ar_app_'||n,'ar_tenant','ar_company','ar_source','customer_payment_to_invoice',id,'ar_invoice_'||n,amount/2,'USD',d+5,'applied',1,'app_'||n,'ar_app_'||n||'_event',timestamptz '2026-09-06',timestamptz '2026-09-06' from fixture where kind='customer_payment'`);
      });
      if((start+9999)%100_000===0 || invoices===10_000) console.log("RECEIVABLES_SEED",start+9999,performance.now()-seedStarted);
    }
    const seedMs=performance.now()-seedStarted;
    await pool.query("analyze");
    const counts=(await pool.query<{documents:string;applications:string;postings:string;deliveries:string}>(`select (select count(*)::text from erp_financials.subledger_documents) documents,(select count(*)::text from erp_financials.subledger_applications) applications,(select count(*)::text from erp_financials.ledger_postings) postings,(select count(*)::text from erp_financials.subledger_document_delivery_events) deliveries`)).rows[0];
    expect(counts).toEqual({documents:String(invoices*1.25),applications:String(invoices/4),postings:String(invoices*2.5),deliveries:String(Math.floor(invoices/5)*2)});
    const captured=new Map<string,{sql:string;values:readonly unknown[]}>();
    const measured=createErpFinancialsSdk({...scope,database:{transaction:work=>runner.transaction(client=>work({query:(sql,values)=>{
      const name=sql.includes("aging_rows as materialized")?"aging":sql.includes("register_rows as")?"register":undefined;
      if(name)captured.set(name,{sql,values:values??[]}); return client.query(sql,values);
    }}))}});
    const expected=oracle(invoices,242), historical=oracle(invoices,180);
    const agingRequest={kind:"receivables" as const,asOfDate:"2026-08-31",limit:50};
    const registerRequest={asOfDate:"2026-08-31",limit:50};
    const timings:Record<string,number[]>={};
    async function time<T>(name:string,work:()=>Promise<T>):Promise<T>{const started=performance.now();const result=await work();(timings[name]??=[]).push(performance.now()-started);return result;}
    let agingCursor:string|undefined,registerCursor:string|undefined;
    for(let i=0;i<3;i++){
      const first=await time("agingFirst",()=>measured.queries.getAgingPage(agingRequest));
      expect(first.totals).toEqual(totals(expected.buckets));expect(first.partyCount).toBe("10000");expect(first.rows).toHaveLength(50);
      checkRows(first.rows,expected.parties);agingCursor=required(first.nextCursor);
      const next=await time("agingNext",()=>measured.queries.getAgingPage({...agingRequest,cursor:required(agingCursor)}));
      expect(next.totals).toEqual(first.totals);checkRows(next.rows,expected.parties);
      expect(new Set([...first.rows,...next.rows].map(row=>row.partyId)).size).toBe(100);
      const register=await time("registerFirst",()=>measured.queries.getInvoiceRegister(registerRequest));
      expect(register.summary).toEqual(expected.register);expect(register.items).toHaveLength(50);registerCursor=required(register.nextCursor);
      for(const row of register.items){const n=Number(row.invoiceId.split('_').at(-1)),gross=BigInt((n%10000+100)*4);expect(row.openAmount).toBe(money(gross-(n%4===0?gross/4n:0n)));expect(row.customerName).toBe(`Customer ${String(n%10000)}`);expect(row.status).toBe(n%243+30<242?"overdue":n%4===0?"partial":n%10===5?"sent":"open");}
      const registerNext=await time("registerNext",()=>measured.queries.getInvoiceRegister({...registerRequest,cursor:required(registerCursor)}));
      expect(registerNext.summary).toEqual(register.summary);expect(new Set([...register.items,...registerNext.items].map(row=>row.invoiceId)).size).toBe(100);
      console.log("RECEIVABLES_READ_PROGRESS",i,JSON.stringify(timings));
    }
    const ledger=await time("generalLedgerSummary",()=>sdk.queries.getGeneralLedgerSummary({periodStart:"2026-01-01",periodEnd:"2026-08-31"}));
    expect(ledger).toMatchObject({postingCount:invoices*2.5,totalDebits:money(expected.gross+expected.receipts),totalCredits:money(expected.gross+expected.receipts),difference:"0.00"});
    const accountControls=(await pool.query<{account_id:string;net:string}>("select account_id,sum(net_amount)::text net from erp_financials.ledger_postings group by account_id")).rows;
    expect(Object.fromEntries(accountControls.map(row=>[row.account_id,money(cents(row.net))]))).toEqual({ar:money(expected.gross-expected.receipts),cash:money(expected.receipts),income:money(-expected.gross)});
    const mainPlans=new Map(captured);
    const history=await time("historicalAging",()=>measured.queries.getAgingPage({...agingRequest,asOfDate:"2026-06-30"}));
    expect(history.totals).toEqual(totals(historical.buckets));checkRows(history.rows,historical.parties);
    mainPlans.set("historicalAging",required(captured.get("aging")));
    const plans:Record<string,unknown>={};
    for(const [name,query]of mainPlans){plans[name]=(await pool.query(`explain (analyze,buffers,format json) ${query.sql}`,[...query.values])).rows;}

    const registerPlan=plans.register as Array<{"QUERY PLAN":Array<{Plan:Record<string,unknown>}>}>;
    const deliveryScans:Record<string,unknown>[]=[];
    const inspectPlan=(node:Record<string,unknown>):void=>{if(node["Relation Name"]==="subledger_document_delivery_events")deliveryScans.push(node);for(const child of (node.Plans??[]) as Record<string,unknown>[])inspectPlan(child);};
    inspectPlan(required(required(registerPlan[0])["QUERY PLAN"][0]).Plan);
    expect(deliveryScans.length).toBeGreaterThan(0);
    for(const scan of deliveryScans)expect(Number(scan["Actual Loops"])).toBeLessThanOrEqual(registerRequest.limit+1);

    const writes=200,writers=4,readers=4,postingMs:number[]=[],readMs:number[]=[],locks:number[]=[];
    const memorySamples:{pssKiB:number;rssKiB:number;processes:number}[]=[];
    const postmaster=Number((await readFile(`${proof.directory}/postmaster.pid`,"utf8")).split('\n')[0]);
    let done=false,writeMs=0;
    const sampling=new AbortController(),contentionStarted=performance.now();
    const sampler=(async()=>{while(!sampling.signal.aborted){
      locks.push(Number(required((await pool.query<{n:string}>("select count(*)::text n from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and wait_event_type='Lock'")).rows[0]).n));
      memorySamples.push(await postgresMemory(postmaster));await delay(200);
    }})();
    const writeWork=Promise.all(Array.from({length:writers},async(_,worker)=>{for(let n=worker;n<writes;n+=writers){const key=`native-scale-${String(n)}`,started=performance.now();
      await sdk.commands.invoices.create({operation:{...operation,requestId:key},idempotencyKey:key,date:"2026-08-31",dueDate:"2026-08-31",customerId:"customer_00001",receivableAccount:{accountId:"ar"},revenueLines:[{accountId:"income",amount:"0.01"}]});postingMs.push(performance.now()-started);
    }})).finally(()=>{done=true;writeMs=performance.now()-contentionStarted;});
    const readWork=Promise.all(Array.from({length:readers},async(_,reader)=>{let reads=0;do{const started=performance.now();
      if(reader%2===0){const page=await measured.queries.getAgingPage(agingRequest);const delta=cents(page.totals.total)-expected.buckets.reduce((a,b)=>a+b,0n);expect(delta>=0n&&delta<=BigInt(writes)).toBe(true);const buckets=[...expected.buckets];buckets[0]=required(buckets[0])+delta;expect(page.totals).toEqual(totals(buckets));expect(page.partyCount).toBe("10000");}
      else{const page=await measured.queries.getInvoiceRegister(registerRequest);const delta=Number(page.summary.counts.all)-invoices;expect(delta).toBeGreaterThanOrEqual(0);expect(delta).toBeLessThanOrEqual(writes);expect(page.summary.outstandingAmount).toBe(money(cents(expected.register.outstandingAmount)+BigInt(delta)));expect(page.summary.overdueAmount).toBe(expected.register.overdueAmount);}
      readMs.push(performance.now()-started);reads++;
    }while(!done||reads<2);}));
    try{const results=await Promise.allSettled([writeWork,readWork]);for(const result of results)if(result.status==="rejected")throw result.reason;}finally{sampling.abort();await sampler;}
    const contentionMs=performance.now()-contentionStarted;
    const final=await sdk.queries.getAgingPage(agingRequest);expect(final.totals.total).toBe(money(expected.buckets.reduce((a,b)=>a+b,0n)+BigInt(writes)));
    await expect(sdk.queries.getAgingPage({...agingRequest,cursor:required(agingCursor)})).rejects.toMatchObject({code:"optimistic_concurrency_conflict"});
    await expect(sdk.queries.getInvoiceRegister({...registerRequest,cursor:required(registerCursor)})).rejects.toMatchObject({code:"optimistic_concurrency_conflict"});
    const settings=(await pool.query("select name,setting,unit from pg_settings where name=any($1::text[])",[["shared_buffers","work_mem","max_parallel_workers_per_gather","effective_cache_size","fsync","jit"]])).rows;
    console.log("RECEIVABLES_SCALE",JSON.stringify({workload:{invoices,receipts:invoices/4,applications:invoices/4,deliveryEvents:Math.floor(invoices/5)*2,postings:invoices*2.5,customers:10000,dates:243,tenantCount:1,companyCount:1,sources:1,currency:"USD",pageSize:50,writes,writers,readers,fixture:"Every fourth invoice has a half-value receipt on its date, half applied five days later; due date +30. Current register includes later applications; historical aging excludes them. Every fifth invoice has two delivery attempts; latest failed for n%10=0 and delivered otherwise."},hardware:{cpu:os.cpus()[0]?.model,logicalCpus:os.cpus().length,hostMemoryBytes:os.totalmem(),node:process.version,cgroupMemoryMax:await optionalFile('/sys/fs/cgroup/memory.max'),cgroupCpuMax:await optionalFile('/sys/fs/cgroup/cpu.max')},database:{version:proof.version,settings},seedMs,timings,contention:{durationMs:contentionMs,writerDurationMs:writeMs,postingMs,readMs,invoicesPerSecond:writes*1000/writeMs,samples:locks.length,lockWaitSamples:locks.filter(n=>n>0).length,maxWaiters:Math.max(0,...locks)},controls:{ledger,accountControls,aging:totals(expected.buckets),historical:totals(historical.buckets),register:expected.register,final:final.totals},memory:{nodeMaxRssKiB:process.resourceUsage().maxRSS,after:process.memoryUsage(),postgresPeakSampledPssKiB:Math.max(0,...memorySamples.map(s=>s.pssKiB)),postgresPeakSummedRssKiB:Math.max(0,...memorySamples.map(s=>s.rssKiB)),postgresMaxProcesses:Math.max(0,...memorySamples.map(s=>s.processes))},plans,limitations:["Synthetic one-tenant/source USD workload, not production or soak acceptance.","Fixture directly inserts canonical history with constraints and triggers enabled; concurrent writes use public native commands. No draft, void, unapplication, credit or write-off history in bulk fixture; those require separate lifecycle tests.","Memory sampled during contention only. PostgreSQL PSS sums postmaster and descendants; summed RSS double-counts shared pages. Short-lived workers can escape samples.","Pool 10; 4 writers and 4 readers; 200 invoice writes. All tables analyzed before measurement. No latency assertion or production sizing conclusion."]}));
  }finally{await pool.end();}
},3_600_000);

function required<T>(value:T|undefined):T{if(value===undefined)throw Error("Missing fixture value");return value;}
function money(value:bigint):string{const abs=value<0n?-value:value;return `${value<0n?"-":""}${String(abs/100n)}.${String(abs%100n).padStart(2,"0")}`;}
function cents(value:string):bigint{const negative=value.startsWith('-'),[whole,fraction=""]=value.replace(/^-/u,'').split('.');if(!/^0*$/u.test(fraction.slice(2)))throw Error("Fractional cent in fixture control");return(BigInt(required(whole))*100n+BigInt(fraction.padEnd(2,"0").slice(0,2)))*(negative?-1n:1n);}
const keys=["current","days1To30","days31To60","days61To90","daysOver90"] as const;
function totals(buckets:readonly bigint[]){return {...Object.fromEntries(keys.map((key,i)=>[key,money(required(buckets[i]))])),total:money(buckets.reduce((a,b)=>a+b,0n))};}
function oracle(invoices:number,asOf:number){
  const parties=new Map<string,bigint[]>(),buckets=Array<bigint>(5).fill(0n);let outstanding=0n,overdue=0n,overdueCount=0,age=0,grossTotal=0n,receipts=0n;
  function add(party:string,date:number,amount:bigint){const days=asOf-date,idx=days<=0?0:days<=30?1:days<=60?2:days<=90?3:4;const row=parties.get(party)??Array<bigint>(5).fill(0n);row[idx]=required(row[idx])+amount;parties.set(party,row);buckets[idx]=required(buckets[idx])+amount;}
  for(let n=1;n<=invoices;n++){const day=n%243,gross=BigInt((n%10000+100)*4),payment=n%4===0?gross/2n:0n,applied=payment/2n,open=gross-applied,party=`customer_${String(n%10000).padStart(5,'0')}`;
    grossTotal+=gross;receipts+=payment;outstanding+=open;if(day+30<asOf){overdue+=open;overdueCount++;}age+=Math.max(0,asOf-day);
    if(day<=asOf){const historicApplied=day+5<=asOf?applied:0n;add(party,day+30,gross-historicApplied);if(payment>0n)add(party,day,-payment+historicApplied);}
  }
  return {gross:grossTotal,receipts,parties,buckets,register:{counts:{all:String(invoices),draft:"0",open:String(invoices-overdueCount),overdue:String(overdueCount),paid:"0",voided:"0"},outstandingAmount:money(outstanding),overdueAmount:money(overdue),draftAmount:"0.00",averageOpenAgeDays:String(Math.round(age/invoices))}};
}
function checkRows(rows:readonly {partyId:string}[],parties:Map<string,bigint[]>){for(const row of rows)expect(row).toMatchObject(totals(required(parties.get(row.partyId))));}
async function optionalFile(path:string):Promise<string>{try{return(await readFile(path,"utf8")).trim();}catch{return "unavailable";}}
async function postgresMemory(root:number){const pending=[root],seen=new Set<number>();let pssKiB=0,rssKiB=0;while(pending.length){const pid=required(pending.pop());if(seen.has(pid))continue;seen.add(pid);try{const data=await readFile(`/proc/${String(pid)}/smaps_rollup`,"utf8");pssKiB+=Number(/^Pss:\s+(\d+)/mu.exec(data)?.[1]??0);rssKiB+=Number(/^Rss:\s+(\d+)/mu.exec(data)?.[1]??0);const children=(await readFile(`/proc/${String(pid)}/task/${String(pid)}/children`,"utf8")).trim();if(children)pending.push(...children.split(/\s+/u).map(Number));}catch{/* A backend may exit between samples. */}}return {pssKiB,rssKiB,processes:seen.size};}
