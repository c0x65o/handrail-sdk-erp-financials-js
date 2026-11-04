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
  it('reports source-qualified cash before application and after dated release', async () => {
    const { sdk, command, customerId } = await fixture();
    const funding = (asOfDate: string) => sdk.queries.getVendorFundingDocuments({vendorId:customerId,asOfDate});
    expect((await funding('2025-07-31')).items).toHaveLength(0);
    expect((await funding('2025-08-01')).items).toEqual([expect.objectContaining({documentId:command.sourceDocumentId,availableAmount:'27.56',documentType:'bill_payment'})]);
    const applied = await sdk.commands.paymentApplications.apply({...command,amount:'10.01'});
    expect((await funding('2025-08-02')).items[0]?.availableAmount).toBe('17.55');
    await sdk.commands.paymentApplications.unapply({operation,applicationId:applied.applicationId,expectedVersion:applied.version,effectiveDate:'2025-08-03'});
    expect((await funding('2025-08-02')).items[0]?.availableAmount).toBe('17.55');
    expect((await funding('2025-08-03')).items[0]?.availableAmount).toBe('27.56');
    expect((await sdk.queries.getVendorFundingDocuments({vendorId:'other',asOfDate:'2025-08-03'})).items).toHaveLength(0);
  });
  it('reconciles vendor liability through journal refunds and dated reversals without double counting funding', async () => {
    const { sdk, command, customerId, sourceId, historicalCustomerId } = await fixture();
    const statement = (asOfDate: string) => sdk.queries.getVendorLiabilityStatement({vendorId:customerId,sourceId,asOfDate});
    expect((await statement('2025-07-31')).netLiabilityAmount).toBe('0.00');
    expect((await statement('2025-08-01')).netLiabilityAmount).toBe('-27.56');
    expect((await sdk.queries.getVendorLiabilityStatement({vendorId:historicalCustomerId,sourceId:scope.sourceId,asOfDate:'2025-08-01'})).netLiabilityAmount).toBe('27.56');
    const refund = await sdk.commands.journalEntries.post({operation,idempotencyKey:'vendor-refund',date:'2025-08-04',origin:{module:'Manual',reference:'Vendor refund'},
      lines:[{accountKey:'cash',debit:'10.01',partyId:customerId},{accountKey:'ar',credit:'10.01',partyId:customerId}]});
    expect((await statement('2025-08-03')).netLiabilityAmount).toBe('-27.56');
    const refunded = await statement('2025-08-04');
    expect(refunded.netLiabilityAmount).toBe('-17.55');
    expect(refunded.items.filter(r=>r.transactionId===refund.transactionId)).toHaveLength(2);
    // Funding remains a separate operational control, never subtracted a second time.
    expect((await sdk.queries.getVendorFundingDocuments({vendorId:customerId,asOfDate:'2025-08-04'})).items[0]?.availableAmount).toBe('27.56');
    await sdk.commands.journalEntries.reverse({operation,originalTransactionId:refund.transactionId,idempotencyKey:'vendor-refund-reversal',date:'2025-08-05'});
    expect((await statement('2025-08-04')).netLiabilityAmount).toBe('-17.55');
    expect((await statement('2025-08-05')).netLiabilityAmount).toBe('-27.56');
    await sdk.commands.paymentApplications.apply(command);
    const native = await statement('2025-08-05');
    const historical = await sdk.queries.getVendorLiabilityStatement({vendorId:historicalCustomerId,sourceId:scope.sourceId,asOfDate:'2025-08-05'});
    expect(Number(native.netLiabilityAmount)+Number(historical.netLiabilityAmount)).toBe(0);
    await expect(sdk.queries.getVendorLiabilityStatement({vendorId:customerId,sourceId:'other',asOfDate:'2025-08-05'})).rejects.toBeDefined();
  });

});
