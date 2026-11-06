import { afterAll,beforeEach,describe,it,expect } from 'vitest';
import { Pool } from 'pg';
import { createPostgresStorageAdapter,persistCanonicalFacts,persistQuickBooksSubledgerResources,createPostgresQuickBooksDualBasisBackfillPersistence,migratePostgresSchema,createAttestedSettlementCorrection } from '@handrail/erp-financials';
import { createErpFinancialsSdk } from '@handrail/erp-financials/sdk';
import type { ErpFinancialsTransactionRunner,AttestedSettlementRequest } from '@handrail/erp-financials';
import { importedCreditFixture,scope,now,operation,required } from './support/imported-credit-fixture.js';
const url=process.env.ERP_FINANCIALS_TEST_DATABASE_URL;
if(url&&!new URL(url).pathname.includes('test')) throw Error('Isolated database required');
(url?describe.sequential:describe.skip)('attested settlement real PostgreSQL',()=>{
 const pool=new Pool({connectionString:url,max:4});
 const runner:ErpFinancialsTransactionRunner={async transaction(work){const c=await pool.connect();try{await c.query('begin');await c.query("set local statement_timeout='15s'");const value=await work({query:async(sql,params)=>c.query(sql,params?[...params]:[])});await c.query('commit');return value;}catch(e){await c.query('rollback');throw e;}finally{c.release();}}};
 beforeEach(async()=>{await pool.query<Record<string,unknown>>('drop schema if exists erp_financials cascade');});
 afterAll(async()=>{await pool.query<Record<string,unknown>>('drop schema if exists erp_financials cascade');await pool.end();});
 async function setup(){
  await migratePostgresSchema(runner,{appliedByRef:'test'});
  const original=importedCreditFixture();
  const f={...original,resources:{...original.resources,operationalDocuments:required(original.resources.operationalDocuments).map(r=>({...r,resource:{...r.resource,
    ...(r.resource.sourceTransactionId==='synthetic-prior-invoice'?{totalAmount:'273.47',lines:r.resource.lines.map(l=>({...l,sourceAmount:'273.47'}))}:{}),
    ...(r.resource.sourceTransactionId==='synthetic-credit'?{unappliedAmount:'57.25',lines:r.resource.lines.map(l=>({...l,sourceAmount:'273.47'}))}:{})
  }}))}};
  await runner.transaction(async client=>{await persistCanonicalFacts(createPostgresStorageAdapter(client),f.facts);await persistQuickBooksSubledgerResources({client,...f,companyId:scope.companyId,importedAt:now});});
  await createPostgresQuickBooksDualBasisBackfillPersistence(runner).replaceDualBasisRange({...f.projectionInput,projections:f.projections});
  const sdk=createErpFinancialsSdk({database:runner,...scope,writeSourceId:scope.sourceId,bookId:'book',currencyCode:'USD',now:()=>now});
  await sdk.books.define({operation,bookId:'book',name:'Book',baseCurrencyCode:'USD'});
  await sdk.books.bindSource({operation,bookId:'book',sourceId:scope.sourceId,sourceRole:'active',effectiveFrom:'2025-01-01'});
  await sdk.commands.fiscalPeriods.define({operation,fiscalYear:2025,periodNumber:7,periodStart:'2025-07-01',periodEnd:'2025-07-31'});
  const ar=required(f.facts.accounts.find(a=>a.sourceAccountId==='ar')).accountId,uf=required(f.facts.accounts.find(a=>a.sourceAccountId==='undeposited')).accountId;
  const journal=await sdk.commands.journalEntries.postAdjustment({operation,idempotencyKey:'offset',date:'2025-07-04',lines:[{accountId:ar,debit:'27.56'},{accountId:uf,credit:'27.56'}]});
  const document=async(id:string)=>required((await pool.query<Record<string,unknown>>(`select * from erp_financials.subledger_documents where metadata->>'sourceTransactionId'=$1`,[id])).rows[0]);
  const stale=await document('synthetic-phantom'),replacement=await document('synthetic-credit'),invoice=await document('synthetic-invoice');
  const app=required((await pool.query<Record<string,unknown>>('select * from erp_financials.subledger_applications where source_document_id=$1',[stale.subledger_document_id])).rows[0]);
  const request:AttestedSettlementRequest={paymentId:String(stale.subledger_document_id),replacementPaymentId:String(replacement.subledger_document_id),invoiceId:String(invoice.subledger_document_id),applicationId:String(app.subledger_application_id),offsetTransactionId:journal.transactionId,amount:'27.56',date:'2025-07-05',idempotencyKey:'correction',expectedVersions:{payment:Number(stale.version),replacement:Number(replacement.version),invoice:Number(invoice.version),application:Number(app.version)},attestation:{approvedBy:'owner',authorizationRefs:['p-t95u','p-t94u'],evidenceSha256:'a'.repeat(64),erroneousReceiptNeverProcessed:true,acceptUnchangedCashHistory:true,providerDeletionVerified:false},operation};
  let authorized=true;
  const make=(database=runner,companyId=scope.companyId)=>createAttestedSettlementCorrection({...scope,companyId,nativeSourceId:scope.sourceId,bookId:'book',currencyCode:'USD',database,now:()=>now,authorize:()=>{if(!authorized)throw Error('Active admin required');return Promise.resolve({partyId:String(stale.party_id),evidence:{owner:'owner',journal:journal.transactionId}});}});
  const service=make();
  const state=async()=>(await pool.query<Record<string,unknown>>(`select 'documents' as kind,to_jsonb(d) as data from erp_financials.subledger_documents d union all select 'apps',to_jsonb(a) from erp_financials.subledger_applications a union all select 'events',to_jsonb(e) from erp_financials.financial_lifecycle_events e order by 1,2`)).rows;
  const ledger=async()=>(await pool.query<Record<string,unknown>>('select * from erp_financials.ledger_postings order by posting_id')).rows;
  return {f,service,make,request,document,state,ledger,setAuthorized:(v:boolean)=>{authorized=v;}};
 }
 it('atomically swaps settlement, writes durable receipt, leaves every GL row unchanged and replays safely',async()=>{
  const f=await setup(),before=await f.ledger(),old=await f.state();const preview=await f.service.preview(f.request);expect(await f.state()).toEqual(old);
  const input={...f.request,confirmation:preview.confirmation},receipt=await f.service.execute(input);
  expect(receipt.replayed).toBe(false);expect(await f.document('synthetic-credit')).toMatchObject({open_amount:'29.69'});expect(await f.document('synthetic-phantom')).toMatchObject({open_amount:'0',status:'voided'});expect(await f.document('synthetic-invoice')).toMatchObject({open_amount:'0.00',status:'settled'});expect(await f.ledger()).toEqual(before);
  const committed=await f.state();expect(await f.service.execute({...input,operation:{...operation,requestId:'retry'}})).toMatchObject({receiptId:receipt.receiptId,replayed:true});expect(await f.state()).toEqual(committed);
  await expect(f.service.execute({...input,idempotencyKey:'different'})).rejects.toThrow('already bound');
  await runner.transaction(async client=>{const result=await persistCanonicalFacts(createPostgresStorageAdapter(client),f.f.facts);expect(result.correctionDependencies).toHaveLength(3);await persistQuickBooksSubledgerResources({client,...f.f,companyId:scope.companyId,importedAt:now,replaceMissingDocuments:true});});
  await createPostgresQuickBooksDualBasisBackfillPersistence(runner).replaceDualBasisRange({...f.f.projectionInput,projections:f.f.projections});
  expect(await f.document('synthetic-credit')).toMatchObject({open_amount:'29.69'});expect(await f.document('synthetic-phantom')).toMatchObject({status:'voided'});expect(await f.document('synthetic-invoice')).toMatchObject({open_amount:'0.00'});expect(await f.ledger()).toEqual(before);
  await expect(pool.query<Record<string,unknown>>("update erp_financials.subledger_documents set status='settled' where subledger_document_id=$1",[f.request.paymentId])).rejects.toThrow('immutable');
  await expect(pool.query<Record<string,unknown>>("update erp_financials.subledger_applications set status='applied',version=version+1 where subledger_application_id=$1",[f.request.applicationId])).rejects.toThrow('immutable');
 });
 it('serializes concurrent duplicate execution to one receipt',async()=>{const f=await setup(),p=await f.service.preview(f.request);const settled=await Promise.allSettled([f.service.execute({...f.request,confirmation:p.confirmation}),f.service.execute({...f.request,confirmation:p.confirmation})]);const results=settled.map(r=>{if(r.status==="rejected")throw r.reason;return r.value;});expect(new Set(results.map(r=>r.receiptId)).size).toBe(1);expect(results.map(r=>r.replayed).sort()).toEqual([false,true]);});
 it('rolls back every settlement/event on a partial write failure',async()=>{const f=await setup(),p=await f.service.preview(f.request),before=await f.state();const broken=f.make({transaction:work=>runner.transaction(client=>work({query:async(sql,params)=>{if(sql.includes('insert into erp_financials.subledger_applications'))throw Error('injected application failure');return client.query(sql,params);}}))});await expect(broken.execute({...f.request,confirmation:p.confirmation})).rejects.toThrow('injected');expect(await f.state()).toEqual(before);});
 it('rejects stale preview, stale version, wrong company, revoked admin and closed period without changes',async()=>{const f=await setup(),before=await f.state();await expect(f.service.execute({...f.request,confirmation:'invalid'})).rejects.toThrow('preview');await expect(f.service.preview({...f.request,expectedVersions:{...f.request.expectedVersions,payment:999}})).rejects.toThrow('Reload');await expect(f.make(runner,'other').preview(f.request)).rejects.toThrow();f.setAuthorized(false);await expect(f.service.preview(f.request)).rejects.toThrow('admin');f.setAuthorized(true);expect(await f.state()).toEqual(before);await pool.query<Record<string,unknown>>("update erp_financials.fiscal_periods set status='closing'");await expect(f.service.preview(f.request)).rejects.toThrow('closing');});
 it('rejects unposted journal and duplicate journal claim',async()=>{const f=await setup();await expect(f.service.preview({...f.request,offsetTransactionId:'missing'})).rejects.toThrow('journal');const p=await f.service.preview(f.request);await f.service.execute({...f.request,confirmation:p.confirmation});await expect(f.service.preview(f.request)).rejects.toThrow();});
});
