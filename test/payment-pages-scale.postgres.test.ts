import { readFile } from "node:fs/promises";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { createErpFinancialsSdk, createPostgresTransactionRunner, migratePostgresSchema } from "../src/index.js";

// Opt-in disposable workload. 250,000 payments produce 1,000,000 ledger entries.
// Small default validates the harness; it is explicitly not million-entry proof.
const enabled=process.env.ERP_FINANCIALS_RUN_SCALE_TESTS==="1";
it.skipIf(!enabled)("measures payment pages against growing applications and concurrent native payments",async()=>{
 const root=process.env.ERP_FINANCIALS_EPHEMERAL_ROOT,value=process.env.ERP_FINANCIALS_TEST_DATABASE_URL;
 if(!root||!value)throw Error("Disposable PostgreSQL harness required");
 const url=new URL(value),socket=url.searchParams.get("host");
 if(!socket?.startsWith(`${root}/epg-`)||url.pathname!=="/erp_financials_test_correction")throw Error("Refusing non-disposable benchmark target");
 const payments=Number(process.env.ERP_FINANCIALS_SCALE_PAYMENTS??"10000");
 if(!Number.isSafeInteger(payments)||payments<10000||payments>250000||payments%10000!==0)throw Error("Invalid fixture size");
 const pool=new Pool({connectionString:value,max:10,statement_timeout:30000});
 try{
  const proof=required((await pool.query<{directory:string;address:unknown;listen:string;version:string}>("select current_setting('data_directory') directory,inet_server_addr() address,current_setting('listen_addresses') listen,version() version")).rows[0]);
  expect(proof.directory).toBe(`${socket}/data`);expect(proof.address).toBeNull();expect(proof.listen).toBe("");
    const runner = createPostgresTransactionRunner(pool);
    await migratePostgresSchema(runner, { appliedByRef: "test:payment-pages-scale" });
    await pool.query(`
      insert into erp_financials.accounting_companies values ('pay_company','pay_tenant','Payments','Payments','USD',1,'test','native_erp','payment-pages');
      insert into erp_financials.accounting_sources (source_id,tenant_id,source_system,provider_environment,connection_ref,status)
        values ('pay_source','pay_tenant','native_erp','test','test:payment-pages','active');
      insert into erp_financials.company_sources values ('pay_binding','pay_tenant','pay_company','pay_source',now());
      insert into erp_financials.accounts (account_id,tenant_id,source_id,source_account_id,account_number,name,type,classification,active)
        select id,'pay_tenant','pay_source',id,num,id,kind,kind,true from (values ('ap','2000','liability'),('cash','1000','asset'),('expense','5000','expense')) a(id,num,kind);
      insert into erp_financials.parties (party_id,tenant_id,source_id,source_party_id,party_type,display_name,active)
        select 'vendor_'||lpad(n::text,5,'0'),'pay_tenant','pay_source',n::text,'vendor','Vendor '||n,true from generate_series(0,9999) n;
      insert into erp_financials.import_batches (import_batch_id,tenant_id,source_id,mode,status,started_at,completed_at,source_object_counts)
        values ('pay_batch','pay_tenant','pay_source','initial','completed',now(),now(),'{}');
    `);
    const scope = { tenantId: "pay_tenant", companyId: "pay_company", bookId: "pay_book", writeSourceId: "pay_source", currencyCode: "USD" };
    const sdk = createErpFinancialsSdk({ ...scope, database: runner });
    const operation = { actorRef: "scale:preparer", approverRef: "scale:approver", requestId: "scale:setup", correlationId: "scale:payment-pages", reasonCode: "scale-test", occurredAt: "2026-08-31T00:00:00Z" };
    await sdk.books.define({ operation, bookId: scope.bookId, name: "Payments", baseCurrencyCode: "USD" });
    await sdk.books.bindSource({ operation, bookId: scope.bookId, sourceId: scope.writeSourceId, sourceRole: "active" });
    await sdk.commands.fiscalPeriods.define({ operation, fiscalYear: 2026, periodNumber: 8, periodStart: "2026-08-01", periodEnd: "2026-08-31" });
    const seedStarted = performance.now();
    for (let start = 1; start <= payments; start += 10_000) {
      await runner.transaction(async client => {
        const end = Math.min(payments,start+9999);
        await client.query(`create temporary table fixture on commit drop as
          select n,kind,'pay_'||kind||'_'||n id,'vendor_'||lpad((n%10000)::text,5,'0') party,
            date '2026-01-01'+(n%243)::int d,(n%10000+100)*4*(case when kind='vendor_bill' then 1 else 0.5 end)::numeric/100 amount
          from generate_series($1::int,$2::int) n cross join (values ('vendor_bill'),('bill_payment')) k(kind)
          `,[start,end]);
        await client.query(`insert into erp_financials.transactions
          (transaction_id,tenant_id,source_id,source_transaction_id,source_transaction_type,transaction_date,posted_at,updated_at,currency_code,status,party_id)
          select id,'pay_tenant','pay_source',id,'Subledger:'||kind,d,timestamptz '2026-09-06',timestamptz '2026-09-06','USD','posted',party from fixture`);
        if(start===1) await client.query("analyze erp_financials.transactions");
        await client.query(`insert into erp_financials.ledger_postings
          (posting_id,tenant_id,source_id,source_posting_id,transaction_id,account_id,posting_date,accounting_basis,debit_amount,credit_amount,net_amount,currency_code,dimension_hash,dimension_refs,import_batch_id)
          select id||'_'||side,'pay_tenant','pay_source',id||'_'||side,id,
            case when kind='vendor_bill' then case when side=0 then 'expense' else 'ap' end else case when side=0 then 'ap' else 'cash' end end,
            d,'accrual',case when side=0 then amount else 0 end,case when side=1 then amount else 0 end,
            amount*case when side=0 then 1 else -1 end,'USD',repeat('0',64),'[]','pay_batch'
          from fixture cross join generate_series(0,1) side`);
        await client.query(`insert into erp_financials.financial_lifecycle_events
          (event_id,tenant_id,company_id,source_id,aggregate_type,aggregate_id,event_type,actor_ref,request_id,correlation_id,reason_code,occurred_at,recorded_at,idempotency_key,payload_checksum,payload)
          select id||'_event','pay_tenant','pay_company','pay_source','subledger_document',id,'scale_fixture_import','scale:preparer',id,'scale:payment-pages','scale-test',d::timestamptz,timestamptz '2026-09-06',id,encode(sha256(convert_to('{}','UTF8')),'hex'),'{}' from fixture`);
        await client.query(`insert into erp_financials.subledger_documents
          (subledger_document_id,tenant_id,company_id,source_id,document_type,transaction_id,party_id,document_number,document_date,due_date,currency_code,original_amount,open_amount,status,version,idempotency_key,lifecycle_event_id,metadata,created_at,updated_at)
          select id,'pay_tenant','pay_company','pay_source',kind,id,party,id,d,case when kind='vendor_bill' then d+30 else null end,'USD',amount,amount,'open',1,id,id||'_event','{}',timestamptz '2026-09-06',timestamptz '2026-09-06' from fixture`);
        await client.query(`insert into erp_financials.financial_lifecycle_events
          (event_id,tenant_id,company_id,source_id,aggregate_type,aggregate_id,event_type,actor_ref,request_id,correlation_id,reason_code,occurred_at,recorded_at,idempotency_key,payload_checksum,payload)
          select 'pay_app_'||n||'_event','pay_tenant','pay_company','pay_source','subledger_application','pay_app_'||n,'payment_applied','scale:preparer','app_'||n,'scale:payment-pages','scale-test',(d+5)::timestamptz,timestamptz '2026-09-06','app_'||n,
            encode(sha256(convert_to(jsonb_build_object('applicationDate',(d+5)::text)::text,'UTF8')),'hex'),jsonb_build_object('applicationDate',(d+5)::text)
          from fixture where kind='bill_payment'`);
        if(start===1) await client.query("analyze erp_financials.subledger_documents; analyze erp_financials.financial_lifecycle_events");
        await client.query(`insert into erp_financials.subledger_applications
          (subledger_application_id,tenant_id,company_id,source_id,application_type,source_document_id,target_document_id,applied_amount,currency_code,application_date,status,version,idempotency_key,applied_event_id,created_at,updated_at)
          select 'pay_app_'||n,'pay_tenant','pay_company','pay_source','bill_payment_to_bill',id,'pay_vendor_bill_'||n,amount/2,'USD',d+5,'applied',1,'app_'||n,'pay_app_'||n||'_event',timestamptz '2026-09-06',timestamptz '2026-09-06' from fixture where kind='bill_payment'`);
      });
      if((start+9999)%100_000===0 || payments===10_000) console.log("PAYMENT_PAGE_SEED",start+9999,performance.now()-seedStarted);
    }

  const seedMs=performance.now()-seedStarted;await pool.query("analyze");
  const counts=required((await pool.query<{documents:string;applications:string;postings:string}>(`select
   (select count(*)::text from erp_financials.subledger_documents) documents,
   (select count(*)::text from erp_financials.subledger_applications) applications,
   (select count(*)::text from erp_financials.ledger_postings) postings`)).rows[0]);
  expect(counts).toEqual({documents:String(payments*2),applications:String(payments),postings:String(payments*4)});
  let captured:{sql:string;values:readonly unknown[]}|undefined;
  const measured=createErpFinancialsSdk({...scope,database:{transaction:work=>runner.transaction(client=>work({query:(sql,values)=>{
   if(sql.includes("payment_page as materialized"))captured={sql,values:values??[]};return client.query(sql,values);
  }}))}});
  const timings:Record<string,number[]>={},plans:Record<string,unknown>={};
  async function time<T>(name:string,work:()=>Promise<T>){const start=performance.now(),result=await work();(timings[name]??=[]).push(performance.now()-start);return result;}
  type PlanNode={"Node Type":string;"Relation Name"?:string;"Subplan Name"?:string;"Actual Rows":number;"Actual Loops":number;Plans?:PlanNode[]};
  async function plan(name:string,bounded:boolean){
   const query=required(captured),result=required((await pool.query<{"QUERY PLAN":{Plan:PlanNode}[]}>(`explain (analyze,buffers,format json) ${query.sql}`,[...query.values])).rows[0]);plans[name]=result;
   const pages:PlanNode[]=[],applications:PlanNode[]=[],documents:PlanNode[]=[];
   function walk(node:PlanNode){if(node["Subplan Name"]==='CTE payment_page')pages.push(node);if(node["Relation Name"]==='subledger_applications')applications.push(node);if(node["Relation Name"]==='subledger_documents')documents.push(node);node.Plans?.forEach(walk);}
   function hasApplications(node:PlanNode):boolean{return node["Relation Name"]==='subledger_applications'||(node.Plans??[]).some(hasApplications);}
   walk(required(result["QUERY PLAN"][0]).Plan);expect(documents.reduce((n,node)=>n+node["Actual Rows"]*node["Actual Loops"],0)).toBeLessThanOrEqual(51);expect(pages).toHaveLength(1);expect(pages[0]?.["Actual Rows"]).toBeLessThanOrEqual(51);
   if(bounded){expect(pages.some(hasApplications)).toBe(false);expect(applications).toHaveLength(1);expect(applications[0]?.["Actual Loops"]).toBeLessThanOrEqual(51);}
  }
  const sorted=Array.from({length:payments},(_,i)=>i+1).sort((a,b)=>b%243-a%243||(`pay_bill_payment_${String(b)}`<`pay_bill_payment_${String(a)}`?-1:1));
  function check(items:readonly {paymentId:string;amount:string;matchedApplicationCount:number}[],offset:number){
   expect(items.map(item=>item.paymentId)).toEqual(sorted.slice(offset,offset+50).map(n=>`pay_bill_payment_${String(n)}`));
   for(const item of items){const n=Number(item.paymentId.split('_').at(-1));expect(item.amount).toBe(money(BigInt((n%10000+100)*2)));expect(item.matchedApplicationCount).toBe(1);}
  }
  for(let run=0;run<3;run++){
   const first=await time("billFirst",()=>measured.queries.listBillPayments({limit:50}));check(first.items,0);
   if(run===0)await plan("billFirst",true);
   const next=await time("billNext",()=>measured.queries.listBillPayments({limit:50,cursor:required(first.nextCursor)}));check(next.items,50);
   const general=await time("generalFirst",()=>measured.queries.listPayments({paymentType:"bill_payment",limit:50}));check(general.items,0);
   if(run===0)await plan("generalFirst",true);
   const generalNext=await time("generalNext",()=>measured.queries.listPayments({paymentType:"bill_payment",limit:50,cursor:required(general.nextCursor)}));check(generalNext.items,50);
   const filtered=await time("generalPartial",()=>measured.queries.listPayments({paymentType:"bill_payment",status:"partial",limit:50}));check(filtered.items,0);
   if(run===0)await plan("generalPartial",true);
  }
  const vendor=await time("vendor",()=>measured.queries.listBillPayments({vendorId:"vendor_00001",limit:50}));
  expect(vendor.items).toHaveLength(payments/10000);expect(vendor.items.every(item=>item.vendorId==='vendor_00001')).toBe(true);await plan("vendor",true);
  let expectedCents=0n;for(let n=1;n<=payments;n++)expectedCents+=BigInt((n%10000+100)*6);
  const ledger=await sdk.queries.getGeneralLedgerSummary({periodStart:"2026-01-01",periodEnd:"2026-08-31"});
  expect(ledger).toMatchObject({postingCount:payments*4,totalDebits:money(expectedCents),totalCredits:money(expectedCents),difference:"0.00"});
  // Real native disbursements exercise the other UNION branch and duplicate suppression.
  const nativeBill=await sdk.commands.vendorBills.create({operation,idempotencyKey:"native:bill",date:"2026-08-31",dueDate:"2026-08-31",vendorId:"vendor_00001",payableAccount:{accountId:"ap"},expenseLines:[{accountId:"expense",amount:"100.00"}]});
  const nativePayment={operation,date:"2026-08-31" as const,vendorId:"vendor_00001",amount:"0.01",paymentMethod:"ach" as const,payableAccount:{accountId:"ap"},cashAccount:{accountId:"cash"},allocations:[{billId:nativeBill.documentId,amount:"0.01",expectedBillVersion:1}]};
  const scheduled=await sdk.commands.billPayments.schedule({...nativePayment,idempotencyKey:"native:scheduled"});
  expect((await sdk.queries.listBillPayments({status:"scheduled",limit:1})).items[0]?.paymentId).toBe(scheduled.billPaymentId);
  const cleared=await sdk.commands.billPayments.recordAndApply({...nativePayment,idempotencyKey:"native:cleared"});
  const mixed=await sdk.queries.listBillPayments({limit:50});
  expect(mixed.items.filter(item=>item.paymentId===cleared.billPaymentId)).toHaveLength(1);
  expect(mixed.items.find(item=>item.paymentId===cleared.billPaymentId)).toMatchObject({status:"cleared",applicationStatus:"applied",matchedApplicationCount:1});
  const writes=40,writeMs:number[]=[],readMs:number[]=[],waiters:number[]=[];const posting=new AbortController();
  const contentionStart=performance.now(),samples: {pssKiB:number;rssKiB:number;processes:number}[]=[];
  const postmaster=Number((await readFile(`${proof.directory}/postmaster.pid`,"utf8")).split('\n')[0]);
  const work=Promise.all(Array.from({length:4},async(_,worker)=>{for(let n=worker;n<writes;n+=4){
   const started=performance.now();await sdk.commands.billPayments.record({operation:{...operation,requestId:`native:payment:${String(n)}`},idempotencyKey:`native:payment:${String(n)}`,date:"2026-08-31",vendorId:"vendor_00001",amount:"0.01",payableAccount:{accountId:"ap"},cashAccount:{accountId:"cash"}});writeMs.push(performance.now()-started);
  }})).finally(()=>{posting.abort();});
  const reads=Promise.all(Array.from({length:2},async()=>{do{const started=performance.now();const page=await sdk.queries.listBillPayments({limit:50});expect(page.items).toHaveLength(50);expect(new Set(page.items.map(item=>item.paymentId)).size).toBe(50);readMs.push(performance.now()-started);}while(!posting.signal.aborted);}));
  const sampling=(async()=>{do{waiters.push(Number(required((await pool.query<{n:string}>("select count(*)::text n from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and wait_event_type='Lock'")).rows[0]).n));samples.push(await postgresMemory(postmaster));await new Promise(resolve=>setTimeout(resolve,50));}while(!posting.signal.aborted);})();
  const outcomes=await Promise.allSettled([work,reads,sampling]);for(const outcome of outcomes)if(outcome.status==='rejected')throw outcome.reason;
  const durationMs=performance.now()-contentionStart;
  const final=await sdk.queries.getGeneralLedgerSummary({periodStart:"2026-01-01",periodEnd:"2026-08-31"});
  expect(final).toMatchObject({postingCount:payments*4+4+writes*2,totalDebits:money(expectedCents+10001n+BigInt(writes)),totalCredits:money(expectedCents+10001n+BigInt(writes)),difference:"0.00"});
  const settings=(await pool.query("select name,setting,unit from pg_settings where name=any($1::text[])",[["shared_buffers","work_mem","max_parallel_workers_per_gather","effective_cache_size","fsync","jit"]])).rows;
  console.log("PAYMENT_PAGE_SCALE",JSON.stringify({counts,seedMs,timings,plans,ledger,final,workload:{payments,bills:payments,vendors:10000,dates:243,pageSize:50,sourceCount:1,currency:"USD",writers:4,readers:2,writes,scheduled:1,cleared:1},contention:{durationMs,writeMs,readMs,paymentsPerSecond:writes*1000/durationMs,maxLockWaiters:Math.max(0,...waiters),lockWaitSamples:waiters.filter(n=>n>0).length,samples:waiters.length},hardware:{cpu:os.cpus()[0]?.model,logicalCpus:os.cpus().length,hostMemoryBytes:os.totalmem(),node:process.version,cgroupMemoryMax:await optionalFile('/sys/fs/cgroup/memory.max'),cgroupCpuMax:await optionalFile('/sys/fs/cgroup/cpu.max')},database:{version:proof.version,settings},memory:{nodeMaxRssKiB:process.resourceUsage().maxRSS,node:process.memoryUsage(),postgresPeakPssKiB:Math.max(0,...samples.map(s=>s.pssKiB)),postgresPeakSummedRssKiB:Math.max(0,...samples.map(s=>s.rssKiB)),postgresMaxProcesses:Math.max(0,...samples.map(s=>s.processes))},limitations:["Synthetic single-source USD; bulk fixture uses SQL with current constraints/triggers enabled. Native concurrent payment writes use the public API.","No latency SLO, soak or production sizing claim. Cold/repeated samples share a fresh local database and OS caches.","Every historical bill has a half-value payment, half of that payment applied five days later. No historical refunds or voids; separate lifecycle tests cover those cases.","Memory sampling covers contention; summed RSS double-counts shared pages. Document-only payments dominate; one scheduled native disbursement exercises mixed membership."]}));
 }finally{await pool.end();}
},240000);
function required<T>(value:T|undefined):T{if(value===undefined)throw Error("Missing fixture value");return value;}
function money(value:bigint):string{const abs=value<0n?-value:value;return `${value<0n?"-":""}${String(abs/100n)}.${String(abs%100n).padStart(2,"0")}`;}
async function optionalFile(path:string):Promise<string>{try{return(await readFile(path,"utf8")).trim();}catch{return "unavailable";}}
async function postgresMemory(root:number){const pending=[root],seen=new Set<number>();let pssKiB=0,rssKiB=0;while(pending.length){const pid=required(pending.pop());if(seen.has(pid))continue;seen.add(pid);try{const data=await readFile(`/proc/${String(pid)}/smaps_rollup`,"utf8");pssKiB+=Number(/^Pss:\s+(\d+)/mu.exec(data)?.[1]??0);rssKiB+=Number(/^Rss:\s+(\d+)/mu.exec(data)?.[1]??0);const children=(await readFile(`/proc/${String(pid)}/task/${String(pid)}/children`,"utf8")).trim();if(children)pending.push(...children.split(/\s+/u).map(Number));}catch{/* A backend may exit between samples. */}}return {pssKiB,rssKiB,processes:seen.size};}
