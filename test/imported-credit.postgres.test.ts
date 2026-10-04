import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { setTimeout } from 'node:timers/promises';
import { Pool } from 'pg';
// Intentionally consume the built public package, including its /sdk facade.
import { createPostgresStorageAdapter, persistCanonicalFacts, persistQuickBooksSubledgerResources,
  createPostgresQuickBooksDualBasisBackfillPersistence, migratePostgresSchema, persistImportedCustomerPaymentEvidence,
  lockCustomerPaymentCorrectionSource, createFiscalCloseEvidenceChecksum, createFinancialActionCommandChecksum, createTransferReversalApprovalChecksum } from '@handrail/erp-financials';
import { createErpFinancialsSdk } from '@handrail/erp-financials/sdk';
import type { ErpFinancialsTransactionRunner, CustomerPaymentCorrectionGuard, CustomerPaymentCorrectionRequest, FinancialApprovalPolicy, FinancialAction, FinancialOperationContext, AdministratorFinancialGuard } from '@handrail/erp-financials';
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
    const makeSdk=(database=runner,financialApprovalPolicy?:FinancialApprovalPolicy)=>createErpFinancialsSdk({database,...scope,writeSourceId:scope.sourceId,bookId:'synthetic-book',currencyCode:'USD',now:()=>now,customerPaymentCorrectionGuard:guard,...(financialApprovalPolicy ? {financialApprovalPolicy} : {})});
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
  async function administratorFixture() {
    const f = await fixture();
    // Synthetic server session and app-owned persistence, never request claims.
    const sessionActor = operation.actorRef;
    await pool.query<Record<string, unknown>>(`create table credit_test_app.membership(actor text primary key, tenant text, company text, active boolean, administrator boolean);
      create table credit_test_app.admin_confirmation(ref text primary key, policy text, actor text, tenant text, company text, source text, book text, action text, request text, checksum text, confirmed boolean);
      `);
    await pool.query<Record<string, unknown>>('insert into credit_test_app.membership values($1,$2,$3,true,true)', [sessionActor,scope.tenantId,scope.companyId]);
    const guard: AdministratorFinancialGuard = async input => {
      const member = required((await input.client.query('select * from credit_test_app.membership where actor=$1 for share', [sessionActor])).rows[0]);
      const receipt = (await input.client.query(`select * from credit_test_app.admin_confirmation where ref=$1 and policy='administrator_direct'
        and actor=$2 and tenant=$3 and company=$4 and source=$5 and book=$6 and action=$7 and request=$8 and checksum=$9 and confirmed for share`,
        [input.command.operation.administratorConfirmation?.confirmationRef,sessionActor,input.tenantId,input.companyId,input.sourceId,input.bookId,input.action,input.command.operation.requestId,input.commandChecksum])).rows[0];
      return {tenantId:String(member.tenant),companyId:String(member.company),sourceId:scope.sourceId,bookId:'synthetic-book',
        actorRef:sessionActor,requestId:input.command.operation.requestId,action:input.action,commandChecksum:input.commandChecksum,
        active:member.active===true,administrator:member.administrator===true,confirmed:receipt!==undefined};
    };
    const policy: FinancialApprovalPolicy = {mode:'administrator_direct', actions:[
      'customerPayments.voidAndUnapply','bankReconciliation.ignore','bankReconciliation.unignore','bankReconciliation.unmatch',
      'journalEntries.postAdjustment','journalEntries.reverse','paymentApplications.unapply','fiscalPeriods.setPostingLockDate','transfers.reverse','invoices.voidDraft'
    ],guard};
    const admin = f.makeSdk(runner,policy);
    const adminOperation = {...operation,approverRef:sessionActor};
    async function confirm<I extends {readonly operation:FinancialOperationContext}>(action:FinancialAction, command:I):Promise<I> {
      const commandChecksum = createFinancialActionCommandChecksum({...scope,bookId:'synthetic-book',currencyCode:'USD'},action,command);
      const confirmationRef = `confirmation:${action}:${command.operation.requestId}`;
      await pool.query<Record<string, unknown>>(`insert into credit_test_app.admin_confirmation values($1,'administrator_direct',$2,$3,$4,$5,$6,$7,$8,$9,true)`,
        [confirmationRef,sessionActor,scope.tenantId,scope.companyId,scope.sourceId,'synthetic-book',action,command.operation.requestId,commandChecksum]);
      return {...command,operation:{...command.operation,administratorConfirmation:{confirmationRef,commandChecksum}}};
    }
    async function correction() {
      const request = {...f.request,operation:adminOperation};
      const preview = await admin.commands.customerPayments.previewVoidAndUnapply(request);
      // Existing correction evidence guard still binds the exact immutable preview.
      await pool.query<Record<string, unknown>>(`insert into credit_test_app.approval values('confirmation:correction',$1,$2,$3,'synthetic-book',$4::jsonb,$5,true)`,
        [scope.tenantId,scope.companyId,scope.sourceId,JSON.stringify(request),preview.confirmation]);
      return confirm('customerPayments.voidAndUnapply',{...request,confirmation:preview.confirmation,approvalRef:'confirmation:correction'});
    }
    async function bankLine() {
      const account=required((await pool.query<Record<string, unknown>>("select account_id from erp_financials.accounts where source_account_id='bank'")).rows[0]);
      return admin.bankReconciliation.ingest({operation,externalLineId:'synthetic:admin-line',bankAccountId:String(account.account_id),postedDate:'2025-07-04',amount:'12.00'});
    }
    return {...f,admin,policy,guard,adminOperation,confirm,correction,bankLine};
  }

  it('administrator direct correction confirms the real actor, replays concurrently once and retains accounting parity',async()=>{
    const f=await administratorFixture();const command=await f.correction();
    const results=await Promise.all([f.admin.commands.customerPayments.voidAndUnapply(command),f.admin.commands.customerPayments.voidAndUnapply(command)]);
    expect(results.map(r=>r.status).sort()).toEqual(['already_voided','voided']);
    expect(results[0].reversalTransactionIds).toEqual(results[1].reversalTransactionIds);
    expect((await pool.query<Record<string, unknown>>('select * from erp_financials.customer_payment_corrections')).rows).toHaveLength(1);
    const events=(await pool.query<Record<string, unknown>>(`select actor_ref,approver_ref,payload->'financialApproval' as audit from erp_financials.financial_lifecycle_events where payload ? 'financialApproval'`)).rows;
    expect(events.length).toBeGreaterThan(4);
    for(const event of events) {
      expect(event.actor_ref).toBe(operation.actorRef);expect(event.approver_ref).toBe(operation.actorRef);
      expect(event.audit).toMatchObject({policy:'administrator_direct',actorRef:operation.actorRef,action:'customerPayments.voidAndUnapply'});
    }
    await f.sdk.commands.paymentApplications.apply(await f.applyInput());
    for(const basis of ['cash','accrual']) expect((await f.balances()).filter(r=>r.accounting_basis===basis)).toEqual([
      {accounting_basis:basis,source_account_id:'ar',net:'-57.25'},{accounting_basis:basis,source_account_id:'bank',net:'330.72'},
      {accounting_basis:basis,source_account_id:'revenue',net:'-273.47'},{accounting_basis:basis,source_account_id:'undeposited',net:'0.00'}]);
    const state=await dbState();await f.admin.commands.customerPayments.voidAndUnapply(command);expect(await dbState()).toEqual(state);
    await expect(async()=>f.sdk.commands.customerPayments.voidAndUnapply(command)).rejects.toMatchObject({code:'authorization_context_invalid'});
  });
  it('administrator ignore/reopen is versioned, audit truthful, concurrent ignore exactly once; default and unlisted actions stay independent',async()=>{
    const f=await administratorFixture(); const line=await f.bankLine();
    const command=await f.confirm('bankReconciliation.ignore',{operation:{...f.adminOperation,occurredAt:'2025-07-03T00:00:00.000Z'},bankStatementLineId:line.bankStatementLineId,expectedVersion:1});
    const initial=await dbState();
    await expect(f.sdk.bankReconciliation.ignore(command)).rejects.toMatchObject({code:'authorization_context_invalid'});
    await expect(f.makeSdk(runner,{...f.policy,actions:[]}).bankReconciliation.ignore(command)).rejects.toMatchObject({code:'authorization_context_invalid'});
    expect(await dbState()).toEqual(initial);
    const results=await Promise.all([f.admin.bankReconciliation.ignore(command),f.admin.bankReconciliation.ignore(command)]);
    expect(results[0]).toEqual(results[1]);expect(results[0]).toMatchObject({status:'ignored',version:2});
    expect((await pool.query<Record<string, unknown>>("select * from erp_financials.financial_lifecycle_events where event_type='bank_statement_line.ignored'")).rows).toHaveLength(1);
    const recorded=required((await pool.query<{recorded_at:Date}>("select recorded_at from erp_financials.financial_lifecycle_events where event_type='financial_action.administrator_confirmed'")).rows[0]);
    expect(recorded.recorded_at.toISOString()).toBe(now);
    const state=await dbState();await f.admin.bankReconciliation.ignore(command);expect(await dbState()).toEqual(state);
    const reopen=await f.confirm('bankReconciliation.unignore',{...command,expectedVersion:2,operation:{...f.adminOperation,requestId:'admin:reopen'}});
    expect(await f.admin.bankReconciliation.unignore(reopen)).toMatchObject({status:'unmatched',version:3});
    await expect(f.admin.bankReconciliation.ignore(command)).rejects.toMatchObject({code:'idempotency_conflict'});
  });
  it('administrator policy supports nested native adjustment/reversal, transfer approval and fiscal controls',async()=>{
    const f=await administratorFixture();
    const accounts=(await pool.query<{account_id:string;source_account_id:string}>('select account_id,source_account_id from erp_financials.accounts')).rows;
    const bank=required(accounts.find(a=>a.source_account_id==='bank')).account_id;
    const clearing=required(accounts.find(a=>a.source_account_id==='undeposited')).account_id;
    const operationWithoutApprover={actorRef:operation.actorRef,requestId:'admin:adjustment',correlationId:operation.correlationId,reasonCode:operation.reasonCode,reasonDetail:operation.reasonDetail,occurredAt:now};
    const adjustment=await f.confirm('journalEntries.postAdjustment',{operation:operationWithoutApprover,idempotencyKey:'admin:adjustment',date:'2025-07-04',lines:[{accountId:bank,debit:'5.00'},{accountId:clearing,credit:'5.00'}]});
    const posted=await f.admin.commands.journalEntries.postAdjustment(adjustment);
    const reversal=await f.confirm('journalEntries.reverse',{operation:{...operationWithoutApprover,requestId:'admin:reverse'},idempotencyKey:'admin:reverse',originalTransactionId:posted.transactionId,date:'2025-07-04'});
    await f.admin.commands.journalEntries.reverse(reversal);
    const transfer=await f.sdk.commands.transfers.record({operation,idempotencyKey:'admin:transfer',date:'2025-07-04',amount:'7.00',fromAccount:{accountId:bank},toAccount:{accountId:clearing}});
    const reverse={operation:{...operationWithoutApprover,requestId:'admin:transfer-reverse'},idempotencyKey:'admin:transfer-reverse',transferId:transfer.documentId,date:'2025-07-04'};
    const approval={approvalRef:'admin:transfer-confirmation',operationChecksum:createTransferReversalApprovalChecksum({...scope,bookId:'synthetic-book',currencyCode:'USD'},reverse)};
    const approved=await f.confirm('transfers.reverse',{...reverse,approval});
    expect(await f.admin.commands.transfers.reverse(approved)).toMatchObject({status:'reversed'});
    expect(await f.admin.commands.transfers.reverse(approved)).toMatchObject({status:'already_reversed'});
    const fiscal=await f.confirm('fiscalPeriods.setPostingLockDate',{operation:{...operationWithoutApprover,requestId:'admin:fiscal'},expectedVersion:0,postingLockDate:'2025-07-31'});
    await f.admin.commands.fiscalPeriods.setPostingLockDate(fiscal);
    const audit=(await pool.query<Record<string, unknown>>("select approver_ref,payload from erp_financials.financial_lifecycle_events where event_type='financial_action.administrator_confirmed'")).rows;
    expect(audit).toHaveLength(4);expect(audit.every(r=>r.approver_ref===null)).toBe(true);
  });
  it('administrator execution rolls back authorization, history and accounting with its caller transaction',async()=>{
    const f=await administratorFixture();const command=await f.correction();const state=await dbState();
    await expect(runner.transaction(async client=>{
      await f.makeSdk({transaction:work=>work(client)},f.policy).commands.customerPayments.voidAndUnapply(command);
      throw Error('synthetic caller rollback');
    })).rejects.toThrow('synthetic caller rollback');
    expect(await dbState()).toEqual(state);
  });

  it.each(['nonadmin','inactive','othercompany','otheractor','missing-confirmation','changed-command','untrusted-guard','missing-guard','wrong-action','old-pending'])('denies administrator correction without writes: %s',async kind=>{
    const f=await administratorFixture();let command=await f.correction();let admin=f.admin;
    if(kind==='nonadmin') await pool.query<Record<string, unknown>>('update credit_test_app.membership set administrator=false');
    if(kind==='inactive') await pool.query<Record<string, unknown>>('update credit_test_app.membership set active=false');
    if(kind==='othercompany') await pool.query<Record<string, unknown>>("update credit_test_app.membership set company='other-company'");
    if(kind==='otheractor') command={...command,operation:{...command.operation,actorRef:'untrusted:actor',approverRef:'untrusted:actor'}};
    if(kind==='missing-confirmation') command={...command,operation:f.adminOperation};
    if(kind==='changed-command') command={...command,date:'2025-07-05'};
    if(kind==='untrusted-guard') admin=f.makeSdk(runner,{...f.policy,guard:(()=>Promise.resolve({authorized:true})) as unknown as AdministratorFinancialGuard});
    if(kind==='missing-guard') admin=f.makeSdk(runner,{mode:'administrator_direct',actions:['customerPayments.voidAndUnapply']} as unknown as FinancialApprovalPolicy);
    if(kind==='wrong-action') await pool.query<Record<string, unknown>>("update credit_test_app.admin_confirmation set action='bankReconciliation.ignore'");
    if(kind==='old-pending') await pool.query<Record<string, unknown>>("update credit_test_app.admin_confirmation set policy='independent',confirmed=false");
    const state=await dbState();await expect(admin.commands.customerPayments.voidAndUnapply(command)).rejects.toMatchObject({code:'authorization_context_invalid'});expect(await dbState()).toEqual(state);
  });
  it.each(['application','authority','deposit','refund','fiscal'])('administrator correction retains stale and safety checks: %s',async kind=>{
    const f=await administratorFixture();const command=await f.correction();
    if(kind==='application') await pool.query<Record<string, unknown>>("update erp_financials.subledger_applications set status='voided',version=version+1,ended_event_id=applied_event_id");
    if(kind==='authority') await pool.query<Record<string, unknown>>("update credit_test_app.authority set version='changed'");
    if(kind==='deposit') await pool.query<Record<string, unknown>>('update credit_test_app.authority set deposited=true');
    if(kind==='refund') await pool.query<Record<string, unknown>>('update credit_test_app.authority set refunded=true');
    if(kind==='fiscal') await f.sdk.commands.fiscalPeriods.setPostingLockDate({operation,expectedVersion:0,postingLockDate:'2025-07-31'});
    const state=await dbState();await expect(f.admin.commands.customerPayments.voidAndUnapply(command)).rejects.toThrow();expect(await dbState()).toEqual(state);
  });
  it('administrator bank ignore rejects stale versions and cross-company lines without writes',async()=>{
    const f=await administratorFixture();const line=await f.bankLine();
    const command=await f.confirm('bankReconciliation.ignore',{operation:f.adminOperation,bankStatementLineId:line.bankStatementLineId,expectedVersion:2});
    const state=await dbState();await expect(f.admin.bankReconciliation.ignore(command)).rejects.toMatchObject({code:'reconciliation_conflict'});expect(await dbState()).toEqual(state);
    const outsider=createErpFinancialsSdk({database:runner,...scope,companyId:'other-company',writeSourceId:scope.sourceId,bookId:'synthetic-book',currencyCode:'USD',financialApprovalPolicy:f.policy});
    await expect(outsider.bankReconciliation.ignore(command)).rejects.toMatchObject({code:'authorization_context_invalid'});expect(await dbState()).toEqual(state);
  });

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
