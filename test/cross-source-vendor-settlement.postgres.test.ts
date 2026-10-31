import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createPostgresStorageAdapter, createCompanySourceBinding, persistCanonicalFacts, persistQuickBooksSubledgerResources,
  createPostgresQuickBooksDualBasisBackfillPersistence, migratePostgresSchema, materializeQuickBooksBasisBackfill,
  mapHandrailQuickBooksSdkResourcesToCanonicalFacts } from '@handrail/erp-financials';
import { createErpFinancialsSdk } from '@handrail/erp-financials/sdk';
import type { ErpFinancialsTransactionRunner } from '@handrail/erp-financials';
import { importedCreditFixture, scope, now, operation, required } from './support/imported-credit-fixture.js';

const url = process.env.ERP_FINANCIALS_TEST_DATABASE_URL;
if (url && !new URL(url).pathname.includes('test')) throw Error('Requires isolated test database');
const suite = url ? describe.sequential : describe.skip;
suite('reviewed native bill payment → historical vendor bill settlement', () => {
  const pool = new Pool({ connectionString: url, max: 2 });
  const runner: ErpFinancialsTransactionRunner = { async transaction(work) {
    const client = await pool.connect();
    try { await client.query('begin'); await client.query("set local statement_timeout='15s'");
      const result = await work({ query: async(sql, params) => client.query(sql, params ? [...params] : []) });
      await client.query('commit'); return result;
    } catch(error) { await client.query('rollback'); throw error; } finally { client.release(); }
  } };
  beforeEach(async() => { await pool.query('drop schema if exists erp_financials cascade'); });
  afterAll(async() => { await pool.end(); });
  async function fixture(targetVersion?: number, signed = false, contraType = 'Expense') {
    await migratePostgresSchema(runner, { appliedByRef: 'test:cross-source', ...(targetVersion ? { targetVersion } : {}) });
    const original = importedCreditFixture();
    const invoice = required(original.resources.operationalDocuments?.[0]);
    const billLines = signed ? [{ ...required(invoice.resource.lines[0]), sourceAmount: '30.01' }, { ...required(invoice.resource.lines[0]), sourceLineId: 'contra-line', lineNumber: 2, sourceAmount: '-2.45', accountRef: { sourceObjectId: 'contra' } }] : invoice.resource.lines;
    const documents = [{ ...invoice, resource: { ...invoice.resource, sourceTransactionType: 'Bill', lines: billLines, partyRef: { ...required(invoice.resource.partyRef), partyType: 'vendor' as const }, openAmount: '27.56' } }];
    const resources = { ...original.resources, accounts: [...original.resources.accounts, ...(signed ? [{ ...required(original.resources.accounts[1]), resourceId: 'contra', resource: { Id: 'contra', Name: 'Contra expense', AccountType: contraType, Active: true } }] : [])].map(a => ({ ...a, resource: { ...a.resource, AccountType: a.resourceId === 'ar' ? 'AccountsPayable' : a.resourceId === 'revenue' ? 'Expense' : a.resource.AccountType } })), operationalDocuments: documents, ledgerTransactions: documents.map(row => ({ ...row, resource: { ...row.resource, lines: [] } })) };
    const facts = mapHandrailQuickBooksSdkResourcesToCanonicalFacts({ resources, context: { ...scope, realmId: 'synthetic-realm', providerEnvironment: 'sandbox',
      accountingBasis: 'accrual', defaultCurrencyCode: 'USD', importBatchId: 'cross-source-batch', checkpointId: 'cross-source-checkpoint', importedAt: now } });
    const replay = () => runner.transaction(async client => {
      await persistCanonicalFacts(createPostgresStorageAdapter(client), facts);
      return persistQuickBooksSubledgerResources({ client, facts, resources, companyId: scope.companyId, importedAt: now });
    });
    await replay();
    const projectionInput = { ...original.projectionInput, accounts: facts.accounts, partyIdsBySourceId: Object.fromEntries(facts.parties.map(p => [p.sourcePartyId,p.partyId])) };
    const projections = (['accrual','cash'] as const).map(accountingBasis => materializeQuickBooksBasisBackfill(projectionInput, {
      reportName: 'general_ledger', accountingBasis, supportStatus: 'supported', currencyCode: 'USD', generatedAt: now,
      providerReportRef: { sourceObjectType: 'quickbooks_report_general_ledger', sourceObjectId: `test:${accountingBasis}` }, totals: [],
      ledgerRows: accountingBasis === 'cash' ? [] : [
        { accountSourceId: 'ar', debitAmount: '0.00', creditAmount: '27.56' },
        { accountSourceId: 'revenue', debitAmount: signed ? '30.01' : '27.56', creditAmount: '0.00' },
        ...(signed ? [{ accountSourceId: 'contra', debitAmount: '0.00', creditAmount: '2.45' }] : [])
      ].map(row => ({ ...row, transactionId: 'synthetic-invoice', transactionType: 'Bill', transactionDate: '2025-07-01', documentNumber: '1396', partySourceId: 'synthetic-customer' }))
    }));
    await createPostgresQuickBooksDualBasisBackfillPersistence(runner).replaceDualBasisRange({ ...projectionInput, projections: [required(projections[0]), required(projections[1])] });
    const sourceId = 'native-cutover-source', bookId = 'cutover-book';
    await runner.transaction(async client => {
      const storage = createPostgresStorageAdapter(client);
      await storage.upsertAccountingSource({ tenantId: scope.tenantId, sourceId, sourceSystem: 'native_erp', providerEnvironment: 'native', connectionRef: sourceId, status: 'active' });
      await storage.upsertCompanySourceBinding(createCompanySourceBinding({ tenantId: scope.tenantId, companyId: scope.companyId, sourceId, createdAt: now }));
    });
    const sdk = createErpFinancialsSdk({ database: runner, tenantId: scope.tenantId, companyId: scope.companyId, writeSourceId: sourceId, bookId,
      currencyCode: 'USD', postingPolicy: 'legacy_unrestricted', now: () => '2025-08-10T12:00:00.000Z' });
    await sdk.books.define({ operation, bookId, name: 'Cutover', baseCurrencyCode: 'USD' });
    await sdk.books.bindSource({ operation, bookId, sourceId: scope.sourceId, sourceRole: 'historical', effectiveThrough: '2025-07-31' });
    await sdk.books.bindSource({ operation, bookId, sourceId, sourceRole: 'active', effectiveFrom: '2025-08-01' });
    const customerId = 'native-customer';
    await sdk.commands.parties.ensureActive({ operation, partyId: customerId, sourcePartyId: 'synthetic-customer', partyType: 'vendor', displayName: 'Synthetic customer' });
    const accounts: Record<string, string> = {};
    for (const [key, classification, type] of [['cash','asset','Bank'], ['ar','liability','AccountsPayable'], ['revenue','expense','Expense'], ['contra','expense','Expense']] as const) {
      const result = await sdk.commands.accounts.upsertTree({ operation: { ...operation, requestId: `account:${key}` }, parent: { accountKey: key, name: key, classification, type } });
      accounts[key] = required(result.accounts[0]).accountId;
    }
    const receipt = await sdk.commands.billPayments.record({ operation, idempotencyKey: 'native-payment', date: '2025-08-01', vendorId: customerId,
      amount: '27.56', cashAccount: { accountKey: 'cash' }, payableAccount: { accountKey: 'ar' } });
    const target = required((await pool.query<{ subledger_document_id: string; version: number }>("select subledger_document_id,version from erp_financials.subledger_documents where document_type='vendor_bill'")).rows[0]);
    const command = { operation, idempotencyKey: 'cross-source-application', applicationType: 'bill_payment_to_bill' as const,
      sourceDocumentId: receipt.documentId, targetDocumentId: target.subledger_document_id, amount: '27.56', applicationDate: '2025-08-02',
      expectedSourceVersion: receipt.version, expectedTargetVersion: target.version,
      crossSource: { targetSourceId: scope.sourceId, nativePartyId: customerId, historicalPartyId: required(facts.parties[0]).partyId,
        reviewRef: 'approved-review:1', accountMappings: facts.accounts.filter(a => ['ar','revenue','contra'].includes(a.sourceAccountId)).map(a => ({ historicalAccountId: a.accountId, nativeAccountId: required(accounts[a.sourceAccountId]) })) } };
    return { sdk, command, replay, accounts, customerId, historicalCustomerId: required(facts.parties[0]).partyId, sourceId };
  }
  it('upgrades schema51 without rewriting retained bill, payment, or journal facts', async () => {
    const { sdk, command } = await fixture(51);
    const facts = async () => (await pool.query<{kind:string;fact:unknown}>(`select 'document' kind,to_jsonb(d) fact from erp_financials.subledger_documents d
      union all select 'posting',to_jsonb(p) from erp_financials.ledger_postings p
      union all select 'transaction',to_jsonb(t) from erp_financials.transactions t order by kind,fact`)).rows;
    const before = await facts();
    const upgrade = await migratePostgresSchema(runner, { appliedByRef: 'test:vendor-upgrade' });
    expect(upgrade.applied.map(row => [row.fromVersion, row.toVersion])).toEqual([[51,52]]);
    expect(await facts()).toEqual(before);
    await sdk.commands.paymentApplications.apply(command);
    expect((await sdk.queries.getOperationalDocument(command.targetDocumentId)).openAmount).toBe('0.00');
  });
  it('settles exact installments, keeps cash and accrual distinct, and reverses on the chosen date', async () => {
    const { sdk, command, replay, historicalCustomerId, sourceId } = await fixture();
    const summary = (asOfDate: string) => sdk.queries.getVendorBillSummary({ vendorId: historicalCustomerId, asOfDate,
      periodStart: '2025-08-01', periodEnd: asOfDate });
    const first = await sdk.commands.paymentApplications.apply({ ...command, amount: '10.01' });
    expect((await summary('2025-08-01')).outstandingAmount).toBe('27.56');
    expect((await summary('2025-08-02')).outstandingAmount).toBe('17.55');
    const second = { ...command, idempotencyKey: 'vendor-second', amount: '17.55',
      expectedSourceVersion: command.expectedSourceVersion + 1, expectedTargetVersion: command.expectedTargetVersion + 1 };
    const last = await sdk.commands.paymentApplications.apply(second);
    expect((await sdk.commands.paymentApplications.apply(second)).status).toBe('already_applied');
    expect((await summary('2025-08-02')).outstandingAmount).toBe('0.00');
    expect((await summary('2025-08-02')).paidInPeriodAmount).toBe('27.56');
    expect((await sdk.queries.getVendorBillRegister({ vendorId: historicalCustomerId, asOfDate: '2025-08-02' })).summary.outstandingAmount).toBe('0.00');
    const expense = async (date: string) => (await pool.query<{amount:string}>(`select coalesce(sum(p.debit_amount-p.credit_amount),0)::text amount
      from erp_financials.ledger_postings p join erp_financials.accounts a using(tenant_id,source_id,account_id)
      where p.source_id=$1 and a.classification='expense' and p.accounting_basis='cash' and p.posting_date<=$2`, [sourceId,date])).rows[0];
    expect(await expense('2025-08-01')).toEqual({ amount: '0' });
    expect(await expense('2025-08-02')).toEqual({ amount: '27.56' });
    expect((await pool.query(`select count(*)::int n from erp_financials.ledger_postings p join erp_financials.transactions t using(tenant_id,source_id,transaction_id)
      where t.source_transaction_type='Subledger:cross_source_vendor_settlement' and p.accounting_basis='accrual'`)).rows).toEqual([{ n:0 }]);
    await replay();
    expect((await summary('2025-08-02')).outstandingAmount).toBe('0.00');
    const undo = { operation, applicationId: first.applicationId, expectedVersion: first.version, effectiveDate: '2025-08-03' };
    await sdk.commands.paymentApplications.unapply(undo);
    await sdk.commands.paymentApplications.unapply(undo);
    expect((await summary('2025-08-02')).outstandingAmount).toBe('0.00');
    expect((await summary('2025-08-03')).outstandingAmount).toBe('10.01');
    expect(await expense('2025-08-03')).toEqual({ amount: '17.55' });
    await sdk.commands.paymentApplications.unapply({ ...undo, applicationId: last.applicationId });
    expect((await sdk.queries.getOperationalDocument(command.sourceDocumentId)).openAmount).toBe('27.56');
    expect(await expense('2025-08-03')).toEqual({ amount: '0.00' });
  });
  it('rejects self approval, wrong parties/mappings, stale versions and forged hold edits without posting', async () => {
    const { sdk, command } = await fixture();
    for (const invalid of [
      { ...command, operation: { ...operation, approverRef: operation.actorRef } },
      { ...command, crossSource: { ...command.crossSource, historicalPartyId: 'foreign-vendor' } },
      { ...command, crossSource: { ...command.crossSource, accountMappings: command.crossSource.accountMappings.slice(1) } },
      { ...command, expectedTargetVersion: command.expectedTargetVersion + 1 },
      { ...command, applicationDate: '2025-07-31' }
    ]) await expect(sdk.commands.paymentApplications.apply(invalid)).rejects.toThrow();
    await expect(pool.query('update erp_financials.subledger_documents set payment_hold=true where subledger_document_id=$1', [command.targetDocumentId])).rejects.toThrow('versioned lifecycle');
    expect((await pool.query('select count(*)::int n from erp_financials.subledger_applications')).rows).toEqual([{ n:0 }]);
  });
  it('keeps retained vendor facts immutable and refuses early undo or changed replay', async () => {
    const { sdk, command } = await fixture();
    const result = await sdk.commands.paymentApplications.apply(command);
    await expect(sdk.commands.paymentApplications.apply({ ...command, crossSource: { ...command.crossSource, reviewRef: 'changed' } })).rejects.toThrow();
    await expect(sdk.commands.paymentApplications.unapply({ operation, applicationId: result.applicationId, expectedVersion: result.version, effectiveDate: '2025-08-01' })).rejects.toThrow('cannot precede');
    await expect(pool.query('update erp_financials.subledger_documents set original_amount=original_amount+1 where subledger_document_id=$1', [command.targetDocumentId])).rejects.toThrow();
    await expect(pool.query("update erp_financials.ledger_postings set debit_amount=debit_amount+1 where source_id=$1 and debit_amount>0", [scope.sourceId])).rejects.toThrow();
    expect((await sdk.queries.getOperationalDocument(command.targetDocumentId)).openAmount).toBe('0.00');
  });
  it('settles signed imported bill installments with exact contra cents and dated reversal, without rewriting provider facts', async () => {
    const { sdk, command, replay, sourceId, accounts } = await fixture(undefined, true);
    const originalFacts = async () => (await pool.query<{kind:string;fact:unknown}>(`select 'posting' kind,to_jsonb(p) fact from erp_financials.ledger_postings p where source_id=$1
      union all select 'transaction',to_jsonb(t) from erp_financials.transactions t where source_id=$1 order by kind,fact`, [scope.sourceId])).rows;
    const before = await originalFacts();
    const cash = async (date: string) => (await pool.query<{account_id:string; net:string}>(`select p.account_id,sum(p.debit_amount-p.credit_amount)::text net
      from erp_financials.ledger_postings p join erp_financials.transactions t using(tenant_id,source_id,transaction_id)
      where p.source_id=$1 and p.accounting_basis='cash' and t.source_transaction_type='Subledger:cross_source_vendor_settlement'
        and p.posting_date<=$2 group by p.account_id order by p.account_id`, [sourceId,date])).rows;
    const firstCommand = { ...command, amount: '10.01' };
    const first = await sdk.commands.paymentApplications.apply(firstCommand);
    expect((await sdk.commands.paymentApplications.apply(firstCommand)).status).toBe('already_applied');
    expect(await cash('2025-08-01')).toEqual([]);
    expect(await cash('2025-08-02')).toEqual(expect.arrayContaining([
      { account_id: accounts.ar, net: '-10.01' }, { account_id: accounts.revenue, net: '10.90' }, { account_id: accounts.contra, net: '-0.89' }
    ]));
    const second = await sdk.commands.paymentApplications.apply({ ...command, idempotencyKey:'signed-final', amount:'17.55',
      expectedSourceVersion:command.expectedSourceVersion+1, expectedTargetVersion:command.expectedTargetVersion+1 });
    expect(await cash('2025-08-02')).toEqual(expect.arrayContaining([
      { account_id: accounts.ar, net:'-27.56' }, { account_id: accounts.revenue, net:'30.01' }, { account_id: accounts.contra, net:'-2.45' }
    ]));
    await replay();
    expect(await originalFacts()).toEqual(before);
    await sdk.commands.paymentApplications.unapply({ operation, applicationId:first.applicationId, expectedVersion:first.version, effectiveDate:'2025-08-03' });
    expect(await cash('2025-08-03')).toEqual(expect.arrayContaining([
      { account_id: accounts.ar, net:'-17.55' }, { account_id: accounts.revenue, net:'19.11' }, { account_id: accounts.contra, net:'-1.56' }
    ]));
    expect((await sdk.queries.getOperationalDocument(command.targetDocumentId)).openAmount).toBe('10.01');
    await sdk.commands.paymentApplications.unapply({ operation, applicationId:second.applicationId, expectedVersion:second.version, effectiveDate:'2025-08-04' });
    expect((await cash('2025-08-04')).every(row => row.net==='0.00')).toBe(true);
    expect((await sdk.queries.getOperationalDocument(command.sourceDocumentId)).openAmount).toBe('27.56');
    expect(await originalFacts()).toEqual(before);
  });

  it('rejects incomplete signed-journal mappings without consuming payment or bill balances', async () => {
    const { sdk, command } = await fixture(undefined, true);
    const incomplete = { ...command, crossSource: { ...command.crossSource, accountMappings:command.crossSource.accountMappings.slice(1) } };
    await expect(sdk.commands.paymentApplications.apply(incomplete)).rejects.toThrow('cover exactly');
    expect((await sdk.queries.getOperationalDocument(command.sourceDocumentId)).openAmount).toBe('27.56');
    expect((await sdk.queries.getOperationalDocument(command.targetDocumentId)).openAmount).toBe('27.56');
    expect((await pool.query('select count(*)::int n from erp_financials.subledger_applications')).rows).toEqual([{ n:0 }]);
  });
  it('does not interpret a tax liability as a supported negative expense', async () => {
    const { sdk, command } = await fixture(undefined, true, 'OtherCurrentLiability');
    await expect(sdk.commands.paymentApplications.apply(command)).rejects.toThrow('classification');
    expect((await sdk.queries.getOperationalDocument(command.sourceDocumentId)).openAmount).toBe('27.56');
    expect((await sdk.queries.getOperationalDocument(command.targetDocumentId)).openAmount).toBe('27.56');
    expect((await pool.query('select count(*)::int n from erp_financials.subledger_applications')).rows).toEqual([{ n:0 }]);
  });

});
