import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { setTimeout } from 'node:timers/promises';
import { Pool } from 'pg';
// Intentionally consume the built public package, including its /sdk facade.
import { createPostgresStorageAdapter, persistCanonicalFacts, persistQuickBooksSubledgerResources,
  createPostgresQuickBooksDualBasisBackfillPersistence, migratePostgresSchema, persistImportedCustomerPaymentEvidence,
  lockCustomerPaymentCorrectionSource, createFiscalCloseEvidenceChecksum } from '@handrail/erp-financials';
import { createErpFinancialsSdk } from '@handrail/erp-financials/sdk';
import type { ErpFinancialsTransactionRunner, CustomerPaymentCorrectionGuard, CustomerPaymentCorrectionRequest } from '@handrail/erp-financials';
import { importedCreditFixture, scope, now, operation, required } from './support/imported-credit-fixture.js';

const url = process.env.ERP_FINANCIALS_TEST_DATABASE_URL;
if(url && !new URL(url).pathname.includes('test')) throw Error('Requires isolated test database');
const suite = url ? describe.sequential : describe.skip;
suite('importer-generated imported credit public package PostgreSQL',()=>{
  const pool=new Pool({connectionString:url,max:6});
  const runner:ErpFinancialsTransactionRunner={async transaction(work){
    const c=await pool.connect();try {await c.query('begin');await c.query("set local statement_timeout='15s'");
      const result=await work({query:async(sql,params)=>c.query(sql,params?[...params]:[])});await c.query('commit');return result;
    }catch(e){await c.query('rollback');throw e;}finally{c.release();}
  }};
  beforeEach(async()=>{await pool.query<Record<string, unknown>>('drop schema if exists erp_financials cascade; drop schema if exists credit_test_app cascade');});
  afterAll(async()=>{await pool.query<Record<string, unknown>>('drop schema if exists erp_financials cascade; drop schema if exists credit_test_app cascade');await pool.end();});
  async function dbState() {
    const tables=await pool.query<{table_schema:string;table_name:string}>(`select table_schema,table_name from information_schema.tables where table_schema in ('erp_financials','credit_test_app') and table_type='BASE TABLE' order by 1,2`);
    const state:unknown[]=[];
    for(const r of tables.rows) {
      if(!/^[a-z_]+$/.test(r.table_schema+r.table_name)) throw Error('Unexpected test table');
      state.push({table:r.table_name,rows:(await pool.query<Record<string,unknown>>(`select to_jsonb(t) as row from "${r.table_schema}"."${r.table_name}" t order by to_jsonb(t)::text`)).rows});
    }
    return state;
  }
  async function waitForBlockedWriter() {
    for(let attempt=0;attempt<200;attempt++) {
      if((await pool.query("select 1 from pg_locks where locktype='advisory' and not granted")).rows.length) return;
      await setTimeout(5);
    }
    throw Error('Expected writer to wait for transaction lock');
  }
  async function fixture() {
    await migratePostgresSchema(runner,{appliedByRef:'synthetic:credit'});
    const f=importedCreditFixture();
    await runner.transaction(async client=>{
      await persistCanonicalFacts(createPostgresStorageAdapter(client),f.facts);
      await persistQuickBooksSubledgerResources({client,...f,companyId:scope.companyId,importedAt:now});
    });
    await createPostgresQuickBooksDualBasisBackfillPersistence(runner).replaceDualBasisRange({...f.projectionInput,projections:f.projections});
    await pool.query<Record<string, unknown>>(`create schema credit_test_app;
      create table credit_test_app.authority (id text primary key, authorized boolean not null, version text not null, deposited boolean not null, reconciled boolean not null, refunded boolean not null);
      insert into credit_test_app.authority values('correction',true,'v1',false,false,false);
      create table credit_test_app.approval (id text primary key, tenant_id text, company_id text, source_id text, book_id text, request jsonb, confirmation text, approved boolean not null);`);
    const guard:CustomerPaymentCorrectionGuard=async input=>{
      const a=required((await input.client.query("select * from credit_test_app.authority where id='correction' for update")).rows[0]);
      let authorized=a.authorized===true;
      if(input.phase==='confirm') {
        const approved=await input.client.query(`select * from credit_test_app.approval where id=$1 and tenant_id=$2 and company_id=$3 and source_id=$4 and book_id=$5 and request=$6::jsonb and confirmation=$7 and approved for update`,
          [input.approvalRef,input.tenantId,input.companyId,input.sourceId,input.bookId,JSON.stringify(input.request),input.confirmation]);
        authorized=authorized && approved.rows.length===1;
      }
      return {authorized,complete:true,version:String(a.version),deposited:a.deposited===true,reconciled:a.reconciled===true,refunded:a.refunded===true};
    };
    const makeSdk=(database=runner)=>createErpFinancialsSdk({database,...scope,writeSourceId:scope.sourceId,bookId:'synthetic-book',currencyCode:'USD',now:()=>now,customerPaymentCorrectionGuard:guard});
    const sdk=makeSdk();
    await sdk.books.define({operation,bookId:'synthetic-book',name:'Synthetic',baseCurrencyCode:'USD'});
    await sdk.books.bindSource({operation,bookId:'synthetic-book',sourceId:scope.sourceId,sourceRole:'active',effectiveFrom:'2025-01-01'});
    const period=await sdk.commands.fiscalPeriods.define({operation,fiscalYear:2025,periodNumber:7,periodStart:'2025-07-01',periodEnd:'2025-07-31'});
    const document=async(id:string)=> required((await pool.query<Record<string, unknown>>(`select * from erp_financials.subledger_documents where metadata->>'sourceTransactionId'=$1`,[id])).rows[0]);
    const phantom=await document('synthetic-phantom');
    const evidence={paymentId:String(phantom.subledger_document_id),sourceVersion:now,sourceTransactionId:'synthetic-phantom',bookId:'synthetic-book',
      transactionIds:[String(phantom.transaction_id),...f.projections.flatMap(p=>p.transactions.filter(t=>t.sourcePayloadRef?.sourceObjectId==='synthetic-phantom').map(t=>t.transactionId))],provenanceRef:'synthetic:complete-normalized-import'};
    await runner.transaction(c=>persistImportedCustomerPaymentEvidence(c,scope,evidence));
    const request:CustomerPaymentCorrectionRequest={paymentId:evidence.paymentId,date:'2025-07-04',idempotencyKey:'synthetic:correct',operation};
    const approve=async(approvedRequest=request)=>{
      const preview=await sdk.commands.customerPayments.previewVoidAndUnapply(approvedRequest);
      await pool.query<Record<string, unknown>>(`insert into credit_test_app.approval values('approval:independent',$1,$2,$3,'synthetic-book',$4::jsonb,$5,true)
        on conflict(id) do update set request=excluded.request,confirmation=excluded.confirmation,approved=true`,[scope.tenantId,scope.companyId,scope.sourceId,JSON.stringify(approvedRequest),preview.confirmation]);
      return {...approvedRequest,confirmation:preview.confirmation,approvalRef:'approval:independent'};
    };
    const applyInput=async()=>{const credit=await document('synthetic-credit'),invoice=await document('synthetic-invoice');return {
      operation,idempotencyKey:'synthetic:apply',applicationType:'customer_payment_to_invoice' as const,sourceDocumentId:String(credit.subledger_document_id),targetDocumentId:String(invoice.subledger_document_id),
      amount:'27.56',applicationDate:'2025-07-04',expectedSourceVersion:Number(credit.version),expectedTargetVersion:Number(invoice.version)
    };};
    const balances=async()=> (await pool.query<Record<string, unknown>>(`select p.accounting_basis,a.source_account_id,sum(p.net_amount)::text as net from erp_financials.ledger_postings p join erp_financials.accounts a using(tenant_id,source_id,account_id) group by 1,2 order by 1,2`)).rows;
    return {...f,sdk,makeSdk,document,approve,applyInput,balances,request,evidence,period};
  }
  it('corrects phantom then applies 27.56 from imported PAYMENT 330.72 / remaining 84.81',async()=>{
    const f=await fixture(); const input=await f.approve();
    const result=await f.sdk.commands.customerPayments.voidAndUnapply(input);
    expect(result.reversalTransactionIds).toHaveLength(2);
    expect(await f.document('synthetic-invoice')).toMatchObject({open_amount:'27.56',status:'open'});
    expect(await f.document('synthetic-credit')).toMatchObject({original_amount:'330.72',open_amount:'84.81',document_type:'customer_payment'});
    expect(await f.balances()).toEqual(expect.arrayContaining([{accounting_basis:'accrual',source_account_id:'ar',net:'-57.25'},
      {accounting_basis:'accrual',source_account_id:'undeposited',net:'0.00'},{accounting_basis:'cash',source_account_id:'undeposited',net:'0.00'}]));
    const apply=await f.applyInput();await f.sdk.commands.paymentApplications.apply(apply);
    expect(await f.document('synthetic-invoice')).toMatchObject({open_amount:'0.00',status:'settled'});
    expect(await f.document('synthetic-credit')).toMatchObject({open_amount:'57.25',status:'partially_applied'});
    for(const basis of ['cash','accrual']) expect((await f.balances()).filter(r=>r.accounting_basis===basis)).toEqual([
      {accounting_basis:basis,source_account_id:'ar',net:'-57.25'},{accounting_basis:basis,source_account_id:'bank',net:'330.72'},
      {accounting_basis:basis,source_account_id:'revenue',net:'-273.47'},{accounting_basis:basis,source_account_id:'undeposited',net:'0.00'}]);
    const state=await dbState();
    expect(await f.sdk.commands.paymentApplications.apply(apply)).toMatchObject({status:'already_applied'});
    expect(await f.sdk.commands.customerPayments.voidAndUnapply(input)).toMatchObject({status:'already_voided'});
    expect(await dbState()).toEqual(state);
  });
  it('accepts older importer basis headers with exact identity and unanimous posting parties',async()=>{
    const f=await fixture();
    await pool.query<Record<string, unknown>>("update erp_financials.transactions set party_id=null where source_transaction_type like 'QuickBooksGeneralLedger:%'");
    await runner.transaction(c=>persistImportedCustomerPaymentEvidence(c,scope,f.evidence));
    await f.sdk.commands.customerPayments.voidAndUnapply(await f.approve());
    await f.sdk.commands.paymentApplications.apply(await f.applyInput());
    expect(await f.document('synthetic-credit')).toMatchObject({open_amount:'57.25'});
  });

  it.each(['self','missing'])('requires independent approval even for preview: %s',async(kind)=>{
    const f=await fixture();const before=await dbState();
    const noApprover={actorRef:operation.actorRef,requestId:operation.requestId,correlationId:operation.correlationId,reasonCode:operation.reasonCode,reasonDetail:operation.reasonDetail,occurredAt:operation.occurredAt};
    await expect(async()=>f.sdk.commands.customerPayments.previewVoidAndUnapply({...f.request,operation:kind==='self'?{...operation,approverRef:operation.actorRef}:noApprover}))
      .rejects.toMatchObject({code:'authorization_context_invalid'});
    expect(await dbState()).toEqual(before);
  });

  it.each(['authorization','approval','approver','scope','version','deposited','reconciled','refunded'])('locks and enforces real app-owned %s evidence',async(kind)=>{
    const f=await fixture();const input=await f.approve();
    if(kind==='authorization') await pool.query<Record<string, unknown>>("update credit_test_app.authority set authorized=false");
    if(kind==='approval') await pool.query<Record<string, unknown>>("update credit_test_app.approval set approved=false");
    if(kind==='approver') await pool.query<Record<string, unknown>>(`update credit_test_app.approval set request=jsonb_set(request,'{operation,approverRef}','"user:someone-else"')`);
    if(kind==='scope') await pool.query<Record<string, unknown>>("update credit_test_app.approval set company_id='wrong-company'");
    if(kind==='version') await pool.query<Record<string, unknown>>("update credit_test_app.authority set version='v2'");
    if(['deposited','reconciled','refunded'].includes(kind)) await pool.query<Record<string, unknown>>(`update credit_test_app.authority set ${kind}=true`);
    const before=await dbState();
    await expect(f.sdk.commands.customerPayments.voidAndUnapply(input)).rejects.toThrow();
    expect(await dbState()).toEqual(before);
  });

  it.each(['source','target'])('rejects stale application %s version with complete rollback',async(kind)=>{
    const f=await fixture();await f.sdk.commands.customerPayments.voidAndUnapply(await f.approve());
    const input=await f.applyInput();const before=await dbState();
    await expect(f.sdk.commands.paymentApplications.apply({...input,...(kind==='source'?{expectedSourceVersion:input.expectedSourceVersion+1}:{expectedTargetVersion:input.expectedTargetVersion+1})})).rejects.toThrow();
    expect(await dbState()).toEqual(before);
  });

  it.each(['missing','foreign','incomplete','duplicate','party','currency','reversed'])('fails closed on %s invoice basis provenance',async(kind)=>{
    const f=await fixture();await f.sdk.commands.customerPayments.voidAndUnapply(await f.approve());
    const tx=required(f.projections[0].transactions.find(t=>t.sourcePayloadRef?.sourceObjectId==='synthetic-invoice'));
    if(kind==='missing') await pool.query<Record<string, unknown>>("update erp_financials.transactions set source_payload_ref='{}' where transaction_id=$1",[tx.transactionId]);
    if(kind==='foreign') await pool.query<Record<string, unknown>>(`update erp_financials.transactions set source_payload_ref=jsonb_set(source_payload_ref,'{sourceObjectId}','"another-invoice"') where transaction_id=$1`,[tx.transactionId]);
    if(kind==='incomplete') await pool.query<Record<string, unknown>>('delete from erp_financials.ledger_postings where transaction_id=$1 and debit_amount>0',[tx.transactionId]);
    if(kind==='party') await pool.query<Record<string, unknown>>('update erp_financials.ledger_postings set party_id=null where transaction_id=$1',[tx.transactionId]);
    if(kind==='currency') await pool.query<Record<string, unknown>>("update erp_financials.transactions set currency_code='EUR' where transaction_id=$1",[tx.transactionId]);
    if(kind==='duplicate') await runner.transaction(async client=>{
      const storage=createPostgresStorageAdapter(client);
      await storage.upsertTransactions([{...tx,transactionId:'duplicate-basis',sourceTransactionId:'duplicate-basis'}]);
      await storage.upsertLedgerPostings(f.projections[0].postings.filter(p=>p.transactionId===tx.transactionId).map(p=>({...p,postingId:`duplicate:${p.postingId}`,sourcePostingId:`duplicate:${p.sourcePostingId}`,transactionId:'duplicate-basis'})));
    });
    if(kind==='reversed') await pool.query<Record<string, unknown>>(`insert into erp_financials.journal_entry_links(journal_entry_link_id,tenant_id,company_id,source_id,original_transaction_id,related_transaction_id,link_type,lifecycle_event_id,created_at)
      select 'synthetic:reversed',$1,$2,$3,$4,reversal_transaction_id,'reversal',lifecycle_event_id,$5 from
      (select result->'reversalTransactionIds'->>0 as reversal_transaction_id,lifecycle_event_id from erp_financials.customer_payment_corrections) c`,[scope.tenantId,scope.companyId,scope.sourceId,tx.transactionId,now]);
    const before=await dbState();await expect(f.sdk.commands.paymentApplications.apply(await f.applyInput())).rejects.toThrow();
    expect(await dbState()).toEqual(before);
  });

  it.each(['correction','application'])('rejects a closed period for %s',async(phase)=>{
    const f=await fixture();const input=await f.approve();
    if(phase==='application') await f.sdk.commands.customerPayments.voidAndUnapply(input);
    const closing=await f.sdk.commands.fiscalPeriods.beginClose({operation,fiscalPeriodId:f.period.fiscalPeriodId,expectedVersion:f.period.version});
    const evidence={trialBalanceSnapshotId:'synthetic:tb',reconciliationRefs:['synthetic:reconciliation'],checklistRef:'synthetic:checklist',postingMaxUpdatedAt:now};
    await f.sdk.commands.fiscalPeriods.close({operation,fiscalPeriodId:f.period.fiscalPeriodId,expectedVersion:closing.version,evidence:{...evidence,evidenceChecksum:createFiscalCloseEvidenceChecksum(evidence)}});
    const before=await dbState();
    await expect(phase==='correction'?f.sdk.commands.customerPayments.voidAndUnapply(input):f.sdk.commands.paymentApplications.apply(await f.applyInput())).rejects.toThrow();
    expect(await dbState()).toEqual(before);
  });

  it('serializes two conflicting existing-credit applications and preserves exact balances',async()=>{
    const f=await fixture();await f.sdk.commands.customerPayments.voidAndUnapply(await f.approve());const input=await f.applyInput();
    const results=await Promise.allSettled([f.sdk.commands.paymentApplications.apply(input),f.sdk.commands.paymentApplications.apply({...input,idempotencyKey:'synthetic:competing'})]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
    expect(await f.document('synthetic-credit')).toMatchObject({open_amount:'57.25'});
  });

  it('holds the correction lock through commit and revalidates a waiting application',async()=>{
    const f=await fixture();const input=await f.approve();const apply=await f.applyInput();
    let entered!:()=>void;const ready=new Promise<void>(r=>{entered=r;});let release!:()=>void;const held=new Promise<void>(r=>{release=r;});
    const correction=runner.transaction(async client=>{
      const txSdk=f.makeSdk({transaction:work=>work(client)});
      const result=await txSdk.commands.customerPayments.voidAndUnapply(input);entered();await held;return result;
    });
    await ready;
    const waiting=f.sdk.commands.paymentApplications.apply(apply);
    // The waiting application was built against the settled invoice's old version.
    try {await waitForBlockedWriter();} finally {release();} await correction;await expect(waiting).rejects.toMatchObject({code:'optimistic_concurrency_conflict'});
    expect(await f.document('synthetic-credit')).toMatchObject({open_amount:'84.81'});
  });

  it.each([false,true])('supports same-transaction approval prerequisites (caller rollback=%s)',async(rollback)=>{
    const f=await fixture();const input=await f.approve();await pool.query<Record<string, unknown>>('delete from credit_test_app.approval');
    const before=await dbState();
    const work=()=>runner.transaction(async client=>{
      await lockCustomerPaymentCorrectionSource(client,scope.tenantId,scope.sourceId);
      await client.query(`insert into credit_test_app.approval values($1,$2,$3,$4,'synthetic-book',$5::jsonb,$6,true)`,[input.approvalRef,scope.tenantId,scope.companyId,scope.sourceId,JSON.stringify(f.request),input.confirmation]);
      const txSdk=f.makeSdk({transaction:work=>work(client)});
      await txSdk.commands.customerPayments.voidAndUnapply(input);
      const docs=(await client.query('select * from erp_financials.subledger_documents')).rows;
      const credit=required(docs.find(d=>(d.metadata as {sourceTransactionId:string}).sourceTransactionId==='synthetic-credit'));
      const invoice=required(docs.find(d=>(d.metadata as {sourceTransactionId:string}).sourceTransactionId==='synthetic-invoice'));
      await txSdk.commands.paymentApplications.apply({operation,idempotencyKey:'synthetic:apply',applicationType:'customer_payment_to_invoice',sourceDocumentId:String(credit.subledger_document_id),targetDocumentId:String(invoice.subledger_document_id),amount:'27.56',applicationDate:'2025-07-04',expectedSourceVersion:Number(credit.version),expectedTargetVersion:Number(invoice.version)});
      if(rollback) throw Error('injected caller rollback');
    });
    if(rollback) {await expect(work()).rejects.toThrow('injected caller rollback');expect(await dbState()).toEqual(before);}
    else {await work();expect(await f.document('synthetic-credit')).toMatchObject({open_amount:'57.25'});}
  });

  it('preserves canonical provenance and reverses only the native cash recognition on unapply',async()=>{
    const f=await fixture();await f.sdk.commands.customerPayments.voidAndUnapply(await f.approve());const before=await f.balances();
    const applied=await f.sdk.commands.paymentApplications.apply(await f.applyInput());
    const projections=(await pool.query<Record<string, unknown>>("select p.*,t.source_transaction_type from erp_financials.ledger_postings p join erp_financials.transactions t using(tenant_id,source_id,transaction_id) where source_posting_id like 'cash-application:%'")).rows;
    expect(projections).toHaveLength(2);
    for(const p of projections) expect(p).toMatchObject({accounting_basis:'cash',source_transaction_type:'Invoice',source_payload_ref:{sourceObjectType:'Invoice',sourceObjectId:'synthetic-invoice'}});
    await f.sdk.commands.paymentApplications.unapply({operation,applicationId:applied.applicationId,expectedVersion:applied.version,effectiveDate:'2025-07-04'});
    expect(await f.balances()).toEqual(before);expect(await f.document('synthetic-credit')).toMatchObject({open_amount:'84.81'});
  });

  it('retains both invoice basis facts and native applications through omitted full/range replays',async()=>{
    const f=await fixture();await f.sdk.commands.customerPayments.voidAndUnapply(await f.approve());await f.sdk.commands.paymentApplications.apply(await f.applyInput());
    const before=await f.balances();
    const result=await createPostgresQuickBooksDualBasisBackfillPersistence(runner).replaceDualBasisRange({...f.projectionInput,projections:[
      {...f.projections[0],transactions:[],postings:[]},{...f.projections[1],transactions:[],postings:[]}
    ]});
    expect(result.correctionDependencies).toHaveLength(1);
    await runner.transaction(client=>createPostgresStorageAdapter(client).deleteLedgerFactsOutsideImportBatch({
      tenantId:scope.tenantId,sourceId:scope.sourceId,importBatchId:'synthetic-omitted-full-snapshot'
    }));
    // Only the corrected payment and affected invoice are protected. Unrelated
    // provider records are deliberately outside this lifetime fence.
    const invoiceTx=required(f.projections[0].transactions.find(t=>t.sourcePayloadRef?.sourceObjectId==='synthetic-invoice'));
    expect((await pool.query<Record<string, unknown>>('select * from erp_financials.ledger_postings where transaction_id=$1',[invoiceTx.transactionId])).rows).toHaveLength(2);
    expect((await pool.query<Record<string, unknown>>("select * from erp_financials.ledger_postings where source_posting_id like 'cash-application:%'")).rows).toHaveLength(2);
    expect(before).toEqual(expect.arrayContaining([{accounting_basis:'accrual',source_account_id:'ar',net:'-57.25'}]));
  });

  it.each(['missing-cash','already-recognized'])('refuses imported credit with %s accounting evidence',async(kind)=>{
    const f=await fixture();await f.sdk.commands.customerPayments.voidAndUnapply(await f.approve());
    const tx=required(f.projections[1].transactions.find(t=>t.sourcePayloadRef?.sourceObjectId==='synthetic-credit'));
    if(kind==='missing-cash') await pool.query<Record<string,unknown>>('delete from erp_financials.ledger_postings where transaction_id=$1',[tx.transactionId]);
    else await pool.query<Record<string,unknown>>(`update erp_financials.ledger_postings set account_id=(select account_id from erp_financials.accounts where source_account_id='revenue')
      where transaction_id=$1 and account_id=(select account_id from erp_financials.accounts where source_account_id='ar')`,[tx.transactionId]);
    const before=await dbState();await expect(f.sdk.commands.paymentApplications.apply(await f.applyInput())).rejects.toThrow();expect(await dbState()).toEqual(before);
  });

  it.each(['application','correction'])('serializes competing application/correction of existing credit: %s wins',async(winner)=>{
    const f=await fixture();await f.sdk.commands.customerPayments.voidAndUnapply(await f.approve());
    const credit=await f.document('synthetic-credit');
    await runner.transaction(c=>persistImportedCustomerPaymentEvidence(c,scope,{...f.evidence,paymentId:String(credit.subledger_document_id),sourceTransactionId:'synthetic-credit',
      transactionIds:[String(credit.transaction_id),...f.projections.flatMap(p=>p.transactions.filter(t=>t.sourcePayloadRef?.sourceObjectId==='synthetic-credit').map(t=>t.transactionId))]}));
    const request={...f.request,paymentId:String(credit.subledger_document_id),idempotencyKey:'synthetic:correct-credit'};
    const input=await f.approve(request);const apply=await f.applyInput();
    let entered!:()=>void;const ready=new Promise<void>(r=>{entered=r;});let release!:()=>void;const held=new Promise<void>(r=>{release=r;});
    const first=runner.transaction(async client=>{
      const txSdk=f.makeSdk({transaction:work=>work(client)});
      if(winner==='application') await txSdk.commands.paymentApplications.apply(apply);else await txSdk.commands.customerPayments.voidAndUnapply(input);
      entered();await held;
    });
    await ready;
    const second=winner==='application'?f.sdk.commands.customerPayments.voidAndUnapply(input):f.sdk.commands.paymentApplications.apply(apply);
    try {await waitForBlockedWriter();} finally {release();}
    await first;await expect(second).rejects.toThrow();
    expect(await f.document('synthetic-credit')).toMatchObject(winner==='application'?{open_amount:'57.25',status:'partially_applied'}:{open_amount:'0',status:'voided'});
  });

  it('replays both public import paths after application without resetting balances or cash recognition',async()=>{
    const f=await fixture();const input=await f.approve();await f.sdk.commands.customerPayments.voidAndUnapply(input);
    await f.sdk.commands.paymentApplications.apply(await f.applyInput());const before=await f.balances();
    await runner.transaction(async client=>{
      const result=await persistCanonicalFacts(createPostgresStorageAdapter(client),f.facts);
      expect(result.correctionDependencies).toHaveLength(1);
      const subledger=await persistQuickBooksSubledgerResources({client,...f,companyId:scope.companyId,importedAt:now,replaceMissingDocuments:true});
      expect(subledger.correctionDependencies).toHaveLength(1);
    });
    await createPostgresQuickBooksDualBasisBackfillPersistence(runner).replaceDualBasisRange({...f.projectionInput,projections:f.projections});
    expect(await f.balances()).toEqual(before);
    expect(await f.document('synthetic-credit')).toMatchObject({open_amount:'57.25'});
    expect(await f.document('synthetic-invoice')).toMatchObject({open_amount:'0.00'});
    expect(await f.sdk.commands.customerPayments.voidAndUnapply(input)).toMatchObject({status:'already_voided'});
  });

});
