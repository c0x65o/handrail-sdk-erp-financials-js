import { readFile } from "node:fs/promises";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { createErpFinancialsSdk, createPostgresStorageAdapter, createPostgresTransactionRunner, migratePostgresSchema, type CashFlowSummary } from "../src/index.js";

const enabled = process.env.ERP_FINANCIALS_RUN_SCALE_TESTS === "1";
// This is an opt-in measurement, not a production latency promise. All bulk SQL
// is disposable fixture construction with the latest constraints/triggers on.
it.skipIf(!enabled)("measures cash-flow summaries over million-entry mixed history with concurrent native receipts", async () => {
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
    await migratePostgresSchema(runner, { appliedByRef: "test:cash-flow-scale" });
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
          select id,'ar_tenant','ar_company','ar_source',kind,id,party,id,d,case when kind='invoice' then d+30 else null end,'USD',amount,amount,'open',1,id,id||'_event',case when kind='customer_payment' then '{"cashFlowActivity":"operating"}'::jsonb else '{}'::jsonb end,timestamptz '2026-09-06',timestamptz '2026-09-06' from fixture`);
        await client.query(`insert into erp_financials.financial_lifecycle_events
          (event_id,tenant_id,company_id,source_id,aggregate_type,aggregate_id,event_type,actor_ref,request_id,correlation_id,reason_code,occurred_at,recorded_at,idempotency_key,payload_checksum,payload)
          select 'ar_app_'||n||'_event','ar_tenant','ar_company','ar_source','subledger_application','ar_app_'||n,'payment_applied','scale:preparer','app_'||n,'scale:ar','scale-test',(d+5)::timestamptz,timestamptz '2026-09-06','app_'||n,
            encode(sha256(convert_to(jsonb_build_object('applicationDate',(d+5)::text)::text,'UTF8')),'hex'),jsonb_build_object('applicationDate',(d+5)::text)
          from fixture where kind='customer_payment'`);
        if(start===1) await client.query("analyze erp_financials.subledger_documents; analyze erp_financials.financial_lifecycle_events");
        await client.query(`insert into erp_financials.subledger_applications
          (subledger_application_id,tenant_id,company_id,source_id,application_type,source_document_id,target_document_id,applied_amount,currency_code,application_date,status,version,idempotency_key,applied_event_id,created_at,updated_at)
          select 'ar_app_'||n,'ar_tenant','ar_company','ar_source','customer_payment_to_invoice',id,'ar_invoice_'||n,amount/2,'USD',d+5,'applied',1,'app_'||n,'ar_app_'||n||'_event',timestamptz '2026-09-06',timestamptz '2026-09-06' from fixture where kind='customer_payment'`);
      });
      if((start+9999)%100_000===0 || invoices===10_000) console.log("CASH_FLOW_SEED",start+9999,performance.now()-seedStarted);
    }
    const bulkSeedMs=performance.now()-seedStarted;
    const bills=Number(process.env.ERP_FINANCIALS_SCALE_BILLS??"1000");
    if(!Number.isSafeInteger(bills)||bills<1||bills>10_000)throw Error("Invalid native bill workload");
    const ids:Record<string,string>={};
    for(const [key,classification] of [["supplies","expense"],["equipment","asset"],["payable","liability"]] as const){
      ids[key]=required((await sdk.commands.accounts.upsertTree({operation:{...operation,requestId:`scale:${key}`},parent:{accountKey:key,sourceAccountId:key,name:key,classification,type:classification,active:true}})).accounts[0]).accountId;
    }
    await createPostgresStorageAdapter(pool).upsertParties([{partyId:"cash_flow_vendor",tenantId:scope.tenantId,sourceId:scope.writeSourceId,sourcePartyId:"cash_flow_vendor",partyType:"vendor",displayName:"Cash flow benchmark vendor",active:true}]);
    type Flow={date:string;operating:bigint;investing:bigint;financing:bigint};
    const flows:Flow[]=[];let correctedBills=0,voidedBills=0,correctedReceipts=0,refunds=0;
    const nativeStarted=performance.now();
    for(let n=1;n<=bills;n++){
      const bill=await sdk.commands.vendorBills.create({operation,idempotencyKey:`cf:bill:${String(n)}`,date:"2026-08-15",dueDate:"2026-08-31",vendorId:"cash_flow_vendor",payableAccount:{accountId:required(ids.payable)},expenseLines:[{accountId:required(ids.equipment),amount:"100.01"},{accountId:required(ids.supplies),amount:"100.02"}]});
      const payment=await sdk.commands.billPayments.recordAndApply({operation,idempotencyKey:`cf:payment:${String(n)}`,date:"2026-08-20",vendorId:"cash_flow_vendor",amount:"100.01",paymentMethod:"ach",payableAccount:{accountId:required(ids.payable)},cashAccount:{accountId:"cash"},allocations:[{billId:bill.documentId,amount:"100.01",expectedBillVersion:1}]});
      const corrected=n%19===0,op=corrected?4001n:5001n,invest=corrected?6000n:5000n;
      if(corrected){await sdk.commands.cashFlow.correctPurpose({operation,documentId:payment.billPaymentId,expectedRevision:0,idempotencyKey:`cf:purpose:${String(n)}`,operating:money(op),investing:money(invest),financing:"0.00"});correctedBills++;}
      flows.push({date:"2026-08-20",operating:-op,investing:-invest,financing:0n});
      if(n%10===0){await sdk.commands.billPayments.voidAndUnapply({operation,billPaymentId:payment.billPaymentId,expectedVersion:payment.version,idempotencyKey:`cf:void:${String(n)}`,date:"2026-08-28"});flows.push({date:"2026-08-28",operating:op,investing:invest,financing:0n});voidedBills++;}
      if(n%100===0)console.log("CASH_FLOW_NATIVE_BILLS",n,performance.now()-nativeStarted);
    }
    const nativeReceipts=Math.max(10,Math.floor(bills/10));
    for(let n=1;n<=nativeReceipts;n++){
      const payment=await sdk.commands.customerPayments.record({operation,idempotencyKey:`cf:receipt:${String(n)}`,date:"2026-08-16",customerId:"customer_00001",amount:"25.01",cashFlowActivity:"operating",cashAccount:{accountId:"cash"},receivableAccount:{accountId:"ar"}});
      const financing=n%5===0;
      if(financing){await sdk.commands.cashFlow.correctPurpose({operation,documentId:payment.documentId,expectedRevision:0,idempotencyKey:`cf:receipt-purpose:${String(n)}`,operating:"0.00",investing:"0.00",financing:"25.01"});correctedReceipts++;}
      flows.push({date:"2026-08-16",operating:financing?0n:2501n,investing:0n,financing:financing?2501n:0n});
      if(n%3===0){await sdk.commands.customerPayments.returnCash({operation,paymentId:payment.documentId,expectedVersion:1,customerId:"customer_00001",date:"2026-08-25",amount:"10.01",returnKind:"refund",releases:[],idempotencyKey:`cf:refund:${String(n)}`,externalReturnRef:`fixture:cf:refund:${String(n)}`});flows.push({date:"2026-08-25",operating:financing?0n:-1001n,investing:0n,financing:financing?-1001n:0n});refunds++;}
    }
    const nativeSeedMs=performance.now()-nativeStarted;
    await pool.query("analyze");
    const counts=required((await pool.query<Record<string,string>>(`select (select count(*)::text from erp_financials.transactions) transactions,(select count(*)::text from erp_financials.subledger_documents) documents,(select count(*)::text from erp_financials.ledger_postings) postings,(select count(*)::text from erp_financials.subledger_applications) applications,(select count(*)::text from erp_financials.bill_payment_disbursements) bill_payments,(select count(*)::text from erp_financials.cash_flow_purpose_corrections) corrections`)).rows[0]);
    // Independent integer oracle, constant memory for million-row bulk history.
    const bulkByDay=Array<bigint>(243).fill(0n),bulkCounts=Array<number>(243).fill(0);
    for(let n=4;n<=invoices;n+=4){const day=n%243;bulkByDay[day]=required(bulkByDay[day])+BigInt((n%10000+100)*2);bulkCounts[day]=required(bulkCounts[day])+1;}
    const baseline=(periodStart:string,periodEnd:string)=>{
      let beginning=0n,ending=0n,operating=0n,investing=0n,financing=0n,transactions=0;
      for(let day=0;day<243;day++){const date=new Date(Date.UTC(2026,0,1+day)).toISOString().slice(0,10),amount=required(bulkByDay[day]);if(date<periodStart)beginning+=amount;if(date<=periodEnd)ending+=amount;if(date>=periodStart&&date<=periodEnd){operating+=amount;transactions+=required(bulkCounts[day]);}}
      for(const flow of flows){const total=flow.operating+flow.investing+flow.financing;if(flow.date<periodStart)beginning+=total;if(flow.date<=periodEnd)ending+=total;if(flow.date>=periodStart&&flow.date<=periodEnd){operating+=flow.operating;investing+=flow.investing;financing+=flow.financing;transactions++;}}
      return {supportStatus:"supported" as const,beginningCash:money(beginning),endingCash:money(ending),operating:money(operating),investing:money(investing),financing:money(financing),unclassified:"0.00",netCashFlow:money(ending-beginning),cashTransactionCount:String(transactions),unclassifiedTransactionCount:"0",unbalancedTransactionCount:"0"};
    };
    const roles=[{bookAccountKey:"ar_source:cash",role:"cash"},{bookAccountKey:`ar_source:${required(ids.supplies)}`,role:"operating"},{bookAccountKey:`ar_source:${required(ids.equipment)}`,role:"investing"}] as const;
    let captured:{sql:string;values:readonly unknown[]}|undefined;
    const rowCounts:number[]=[],queryMs:number[]=[];
    const measured=createErpFinancialsSdk({...scope,database:{transaction:work=>runner.transaction(client=>work({query:async<Row extends Record<string,unknown>>(sql:string,values?:readonly unknown[])=>{
      const started=performance.now(),result=await client.query<Row>(sql,values);
      if(sql.startsWith("with recursive book as")){captured={sql,values:values??[]};rowCounts.push(result.rows.length);queryMs.push(performance.now()-started);}
      return result;
    }}))}});
    const timings:Record<string,number[]>={},plans:Record<string,unknown>={},results:Record<string,CashFlowSummary>={};
    const memorySamples:{pssKiB:number;rssKiB:number;processes:number}[]=[],locks:number[]=[];
    const postmaster=Number((await readFile(`${proof.directory}/postmaster.pid`,"utf8")).split('\n')[0]);
    for(const [name,periodStart,periodEnd] of [["whole","2026-01-01","2026-08-31"],["month","2026-08-01","2026-08-31"],["beforeReturns","2026-08-01","2026-08-24"]]){
      for(let repeat=0;repeat<2;repeat++){
        const started=performance.now(),result=await measured.queries.getCashFlowSummary({periodStart:required(periodStart),periodEnd:required(periodEnd),accountRoles:roles});
        (timings[required(name)]??=[]).push(performance.now()-started);expect(result).toMatchObject(baseline(required(periodStart),required(periodEnd)));results[required(name)]=result;
      }
      const query=required(captured);plans[required(name)]=(await pool.query(`explain (analyze,buffers,format json) ${query.sql}`,[...query.values])).rows;
      memorySamples.push(await postgresMemory(postmaster));console.log("CASH_FLOW_READ",name,JSON.stringify(timings[required(name)]));
    }
    const writes=200,writers=4,readers=4,postingMs:number[]=[],readMs:number[]=[];
    const request={periodStart:"2026-08-01",periodEnd:"2026-08-31",accountRoles:roles},before=baseline(request.periodStart,request.periodEnd);
    let done=false,writeMs=0;
    const sampling=new AbortController(),contentionStarted=performance.now();
    const sampler=(async()=>{while(!sampling.signal.aborted){
      locks.push(Number(required((await pool.query<{n:string}>("select count(*)::text n from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and wait_event_type='Lock'")).rows[0]).n));memorySamples.push(await postgresMemory(postmaster));await delay(200);
    }})();
    const writeWork=Promise.all(Array.from({length:writers},async(_,worker)=>{for(let n=worker;n<writes;n+=writers){const key=`cf:concurrent:${String(n)}`,started=performance.now();
      await sdk.commands.customerPayments.record({operation:{...operation,requestId:key},idempotencyKey:key,date:"2026-08-31",customerId:"customer_00001",amount:"0.01",cashFlowActivity:"operating",receivableAccount:{accountId:"ar"},cashAccount:{accountId:"cash"}});postingMs.push(performance.now()-started);
    }})).finally(()=>{done=true;writeMs=performance.now()-contentionStarted;});
    const readWork=Promise.all(Array.from({length:readers},async()=>{let reads=0;do{
      const started=performance.now(),result=await measured.queries.getCashFlowSummary(request),delta=BigInt(result.cashTransactionCount)-BigInt(before.cashTransactionCount);
      expect(delta>=0n&&delta<=BigInt(writes)).toBe(true);expect(result).toMatchObject({...before,cashTransactionCount:String(BigInt(before.cashTransactionCount)+delta),operating:money(cents(before.operating)+delta),endingCash:money(cents(before.endingCash)+delta),netCashFlow:money(cents(before.netCashFlow)+delta)});
      readMs.push(performance.now()-started);reads++;
    }while(!done||reads<2);}));
    try{const outcomes=await Promise.allSettled([writeWork,readWork]);for(const result of outcomes)if(result.status==="rejected")throw result.reason;}finally{sampling.abort();await sampler;}
    const durationMs=performance.now()-contentionStarted,final=await sdk.queries.getCashFlowSummary(request);
    expect(final.operating).toBe(money(cents(before.operating)+BigInt(writes)));expect(final.endingCash).toBe(money(cents(before.endingCash)+BigInt(writes)));expect(rowCounts.every(count=>count===1)).toBe(true);
    const settings=(await pool.query("select name,setting,unit from pg_settings where name=any($1::text[])",[["shared_buffers","work_mem","max_parallel_workers_per_gather","effective_cache_size","fsync","jit"]])).rows;
    console.log("CASH_FLOW_SCALE",JSON.stringify({workload:{invoices,bulkReceipts:invoices/4,bulkApplications:invoices/4,nativeBills:bills,nativeBillPayments:bills,voidedBills,correctedBills,nativeReceipts,refunds,correctedReceipts,writes,writers,readers,customers:10000,dates:243,tenantCount:1,sources:1,currency:"USD",accountingBasis:"accrual"},counts,hardware:{cpu:os.cpus()[0]?.model,logicalCpus:os.cpus().length,hostMemoryBytes:os.totalmem(),node:process.version,cgroupMemoryMax:await optionalFile('/sys/fs/cgroup/memory.max'),cgroupCpuMax:await optionalFile('/sys/fs/cgroup/cpu.max')},database:{version:proof.version,settings},bulkSeedMs,nativeSeedMs,timings,queryMs,returnedRowCounts:rowCounts,contention:{durationMs,writerDurationMs:writeMs,postingMs,readMs,receiptsPerSecond:writes*1000/writeMs,maxWaiters:Math.max(0,...locks),lockSamples:locks.length},controls:{results,final},memory:{nodeMaxRssKiB:process.resourceUsage().maxRSS,after:process.memoryUsage(),postgresPeakSampledPssKiB:Math.max(0,...memorySamples.map(s=>s.pssKiB)),postgresPeakSummedRssKiB:Math.max(0,...memorySamples.map(s=>s.rssKiB))},plans,limitations:["Synthetic one-source USD accrual workload, not production data, multiple tenants or sustained soak.","Bulk native-shaped invoice/receipt/application history is inserted as disposable SQL fixture with constraints/triggers enabled; it is not a million public API commands or a migration rehearsal.","Bill clearing/partial allocation/voids, explicit cash purpose corrections, receipt/refund workflows and concurrent writes use actual public SDK commands.","PSS sampled after read windows and during contention; short-lived workers can escape samples. Summed RSS double-counts shared pages. Memory sampling excludes bulk seed.","No production latency promise or sizing acceptance threshold has been established."]}));
  }finally{await pool.end();}
},3_600_000);

function required<T>(value:T|undefined):T{if(value===undefined)throw Error("Missing fixture value");return value;}
function money(value:bigint):string{const abs=value<0n?-value:value;return `${value<0n?"-":""}${String(abs/100n)}.${String(abs%100n).padStart(2,"0")}`;}
function cents(value:string):bigint{const negative=value.startsWith('-'),[whole,fraction=""]=value.replace(/^-/u,'').split('.');if(!/^0*$/u.test(fraction.slice(2)))throw Error("Fractional cent in fixture control");return(BigInt(required(whole))*100n+BigInt(fraction.padEnd(2,"0").slice(0,2)))*(negative?-1n:1n);}
async function optionalFile(path:string):Promise<string>{try{return(await readFile(path,"utf8")).trim();}catch{return "unavailable";}}
async function postgresMemory(root:number){const pending=[root],seen=new Set<number>();let pssKiB=0,rssKiB=0;while(pending.length){const pid=required(pending.pop());if(seen.has(pid))continue;seen.add(pid);try{const data=await readFile(`/proc/${String(pid)}/smaps_rollup`,"utf8");pssKiB+=Number(/^Pss:\s+(\d+)/mu.exec(data)?.[1]??0);rssKiB+=Number(/^Rss:\s+(\d+)/mu.exec(data)?.[1]??0);const children=(await readFile(`/proc/${String(pid)}/task/${String(pid)}/children`,"utf8")).trim();if(children)pending.push(...children.split(/\s+/u).map(Number));}catch{/* A backend may exit between samples. */}}return {pssKiB,rssKiB,processes:seen.size};}
