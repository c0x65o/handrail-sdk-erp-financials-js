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
suite('reviewed native receipt → historical invoice settlement', () => {
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
  async function fixture() {
    await migratePostgresSchema(runner, { appliedByRef: 'test:cross-source' });
    const original = importedCreditFixture();
    const invoice = required(original.resources.operationalDocuments?.[0]);
    const documents = [{ ...invoice, resource: { ...invoice.resource, openAmount: '27.56' } }];
    const resources = { ...original.resources, operationalDocuments: documents, ledgerTransactions: documents.map(row => ({ ...row, resource: { ...row.resource, lines: [] } })) };
    const facts = mapHandrailQuickBooksSdkResourcesToCanonicalFacts({ resources, context: { ...scope, realmId: 'synthetic-realm', providerEnvironment: 'sandbox',
      accountingBasis: 'accrual', defaultCurrencyCode: 'USD', importBatchId: 'cross-source-batch', checkpointId: 'cross-source-checkpoint', importedAt: now } });
    const replay = () => runner.transaction(async client => {
      await persistCanonicalFacts(createPostgresStorageAdapter(client), facts);
      return persistQuickBooksSubledgerResources({ client, facts, resources, companyId: scope.companyId, importedAt: now });
    });
    await replay();
    const projections = (['accrual','cash'] as const).map(accountingBasis => materializeQuickBooksBasisBackfill(original.projectionInput, {
      reportName: 'general_ledger', accountingBasis, supportStatus: 'supported', currencyCode: 'USD', generatedAt: now,
      providerReportRef: { sourceObjectType: 'quickbooks_report_general_ledger', sourceObjectId: `test:${accountingBasis}` }, totals: [],
      ledgerRows: accountingBasis === 'cash' ? [] : [
        { accountSourceId: 'ar', debitAmount: '27.56', creditAmount: '0.00' },
        { accountSourceId: 'revenue', debitAmount: '0.00', creditAmount: '27.56' }
      ].map(row => ({ ...row, transactionId: 'synthetic-invoice', transactionType: 'Invoice', transactionDate: '2025-07-01', documentNumber: '1396', partySourceId: 'synthetic-customer' }))
    }));
    await createPostgresQuickBooksDualBasisBackfillPersistence(runner).replaceDualBasisRange({ ...original.projectionInput, projections: [required(projections[0]), required(projections[1])] });
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
    await sdk.commands.parties.ensureActive({ operation, partyId: customerId, sourcePartyId: 'synthetic-customer', partyType: 'customer', displayName: 'Synthetic customer' });
    const accounts: Record<string, string> = {};
    for (const [key, classification, type] of [['cash','asset','Bank'], ['ar','asset','AccountsReceivable'], ['revenue','income','Income']] as const) {
      const result = await sdk.commands.accounts.upsertTree({ operation: { ...operation, requestId: `account:${key}` }, parent: { accountKey: key, name: key, classification, type } });
      accounts[key] = required(result.accounts[0]).accountId;
    }
    const receipt = await sdk.commands.customerPayments.record({ operation, idempotencyKey: 'native-payment', date: '2025-08-01', customerId,
      amount: '27.56', cashAccount: { accountKey: 'cash' }, receivableAccount: { accountKey: 'ar' } });
    const target = required((await pool.query<{ subledger_document_id: string; version: number }>("select subledger_document_id,version from erp_financials.subledger_documents where document_type='invoice'")).rows[0]);
    const command = { operation, idempotencyKey: 'cross-source-application', applicationType: 'customer_payment_to_invoice' as const,
      sourceDocumentId: receipt.documentId, targetDocumentId: target.subledger_document_id, amount: '27.56', applicationDate: '2025-08-02',
      expectedSourceVersion: receipt.version, expectedTargetVersion: target.version,
      crossSource: { targetSourceId: scope.sourceId, nativePartyId: customerId, historicalPartyId: required(facts.parties[0]).partyId,
        reviewRef: 'approved-review:1', accountMappings: facts.accounts.filter(a => ['ar','revenue'].includes(a.sourceAccountId)).map(a => ({ historicalAccountId: a.accountId, nativeAccountId: required(accounts[a.sourceAccountId]) })) } };
    return { sdk, command, replay, customerId, historicalCustomerId: required(facts.parties[0]).partyId, sourceId };
  }
  it('settles once in the active window, preserves dated balances on replay and exactly reverses', async() => {
    const { sdk, command, replay, customerId, historicalCustomerId, sourceId } = await fixture();
    const result = await sdk.commands.paymentApplications.apply(command);
    expect(result.status).toBe('applied');
    expect((await sdk.commands.paymentApplications.apply(command)).status).toBe('already_applied');
    for (const id of [customerId, historicalCustomerId]) {
      expect((await sdk.queries.getCustomerStatement({ customerId: id, asOfDate: '2025-08-02' })).balance?.netReceivableAmount).toBe('0.00');
    }
    expect((await sdk.queries.getCustomerStatement({ customerId, asOfDate: '2025-08-01' })).balance?.unappliedCashAmount).toBe('27.56');
    expect((await sdk.queries.getCustomerStatement({ customerId: historicalCustomerId, asOfDate: '2025-08-01' })).balance?.invoiceOutstandingAmount).toBe('27.56');
    const journals = async() => (await pool.query<Record<string, unknown>>(`select p.source_id,p.posting_date::text,a.classification,p.debit_amount::text,p.credit_amount::text
      from erp_financials.ledger_postings p join erp_financials.transactions t using(tenant_id,source_id,transaction_id)
      join erp_financials.accounts a using(tenant_id,source_id,account_id)
      where t.source_transaction_type='Subledger:cross_source_customer_settlement' order by p.posting_date,a.classification`)).rows;
    expect(await journals()).toEqual([
      { source_id: sourceId, posting_date: '2025-08-02', classification: 'asset', debit_amount: '27.56', credit_amount: '0.00' },
      { source_id: sourceId, posting_date: '2025-08-02', classification: 'income', debit_amount: '0.00', credit_amount: '27.56' }
    ]);
    expect(await sdk.queries.getReceivableCollectionPositions({ requests: [{ sourceId: scope.sourceId, customerId: historicalCustomerId,
      collectionRef: "historical-invoice", invoiceId: command.targetDocumentId }] })).toMatchObject([{ openInvoiceAmount: "0.00", appliedCashAmount: "27.56" }]);
    const historicalInvoice = await sdk.queries.getInvoice(command.targetDocumentId);
    expect(historicalInvoice).toMatchObject({ openAmount: "0.00", settlement: { cashAppliedAmount: "27.56" } });
    const summaries = await sdk.queries.getInvoiceSummariesByIds({ customerId: historicalCustomerId, invoiceIds: [command.targetDocumentId] });
    expect(summaries).toMatchObject([{ openAmount: "0.00", settlement: { cashAppliedAmount: "27.56" } }]);
    expect(await sdk.queries.getInvoiceReceiptPage(command.targetDocumentId)).toMatchObject({ totalAppliedAmount: "27.56", totalApplicationCount: 1 });
    expect(await sdk.queries.getReceivableCollectionCoverageHistory({ requests: [{ sourceId: scope.sourceId, customerId: historicalCustomerId,
      collectionRef: "historical-invoice", invoiceId: command.targetDocumentId }] })).toMatchObject([{ firstCoveredOn: "2025-08-02" }]);
    await replay();
    expect((await sdk.queries.getCustomerStatement({ customerId: historicalCustomerId, asOfDate: '2025-08-02' })).balance?.netReceivableAmount).toBe('0.00');
    await expect(sdk.commands.paymentApplications.apply({ ...command, crossSource: { ...command.crossSource, reviewRef: 'different' } })).rejects.toThrow();
    const end = { operation, applicationId: result.applicationId, expectedVersion: result.version, effectiveDate: '2025-08-03' };
    await expect(sdk.commands.paymentApplications.unapply({ ...end, effectiveDate: '2025-08-01' })).rejects.toThrow('cannot precede');
    await sdk.commands.paymentApplications.unapply(end);
    await sdk.commands.paymentApplications.unapply(end);
    expect((await journals()).length).toBe(4);
    expect((await pool.query("select sum(debit_amount-credit_amount)::text as net from erp_financials.ledger_postings p join erp_financials.transactions t using(tenant_id,source_id,transaction_id) where t.source_transaction_type='Subledger:cross_source_customer_settlement'")).rows[0]).toEqual({ net: '0.00' });
    expect((await sdk.queries.getCustomerStatement({ customerId, asOfDate: '2025-08-03' })).balance?.unappliedCashAmount).toBe('27.56');
    expect((await sdk.queries.getCustomerStatement({ customerId: historicalCustomerId, asOfDate: '2025-08-03' })).balance?.invoiceOutstandingAmount).toBe('27.56');
  });
  it('serializes undo with a historical-source collection reader', async() => {
    const { sdk, command, historicalCustomerId } = await fixture();
    const result = await sdk.commands.paymentApplications.apply(command);
    let release!: () => void, entered!: () => void;
    const holding = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const guard = sdk.queries.withLockedReceivableCollectionPositions({ requests: [{ sourceId: scope.sourceId,
      customerId: historicalCustomerId, collectionRef: 'historical-invoice', invoiceId: command.targetDocumentId }] }, async ({ positions }) => {
      expect(positions[0]?.openInvoiceAmount).toBe('0.00'); entered(); await holding;
    });
    await ready;
    let finished = false;
    const undo = sdk.commands.paymentApplications.unapply({ operation, applicationId: result.applicationId,
      expectedVersion: result.version, effectiveDate: '2025-08-03' }).then(value => { finished = true; return value; });
    try { await new Promise(resolve => setTimeout(resolve, 80)); expect(finished).toBe(false); }
    finally { release(); }
    await guard; await undo;
    expect((await sdk.queries.getOperationalDocument(command.targetDocumentId)).openAmount).toBe('27.56');
  });
  it('rejects unreviewed, mismapped, foreign identity and stale allocations atomically', async() => {
    const { sdk, command } = await fixture();
    for (const invalid of [
      { ...command, operation: { ...operation, approverRef: operation.actorRef } },
      { ...command, crossSource: { ...command.crossSource, historicalPartyId: 'foreign-party' } },
      { ...command, crossSource: { ...command.crossSource, accountMappings: command.crossSource.accountMappings.slice(1) } },
      { ...command, expectedTargetVersion: command.expectedTargetVersion + 1 },
      { ...command, applicationDate: '2025-07-31' }
    ]) await expect(sdk.commands.paymentApplications.apply(invalid)).rejects.toThrow();
    expect((await pool.query('select count(*)::int as n from erp_financials.subledger_applications')).rows).toEqual([{ n: 0 }]);
  });
  it('allocates installments without losing cents and blocks provider rewrites after settlement', async() => {
    const { sdk, command, replay, historicalCustomerId } = await fixture();
    const first = await sdk.commands.paymentApplications.apply({ ...command, amount: '10.01' });
    const next = { ...command, idempotencyKey: 'second-installment', amount: '17.55',
      expectedSourceVersion: command.expectedSourceVersion + 1, expectedTargetVersion: command.expectedTargetVersion + 1 };
    await sdk.commands.paymentApplications.apply(next);
    expect((await sdk.queries.listPaymentApplications({ targetDocumentId: command.targetDocumentId })).items).toHaveLength(2);
    expect((await sdk.queries.getPaymentApplication(first.applicationId)).targetDocumentSourceId).toBe(scope.sourceId);
    await replay();
    expect((await sdk.queries.getCustomerStatement({ customerId: historicalCustomerId, asOfDate: '2025-08-02' })).balance?.invoiceOutstandingAmount).toBe('0.00');
    await expect(pool.query("update erp_financials.subledger_documents set original_amount=original_amount+1 where subledger_document_id=$1", [command.targetDocumentId])).rejects.toThrow();
    await expect(pool.query("update erp_financials.ledger_postings set debit_amount=debit_amount+1 where source_id=$1 and debit_amount>0", [scope.sourceId])).rejects.toThrow();
    await sdk.commands.paymentApplications.unapply({ operation, applicationId: first.applicationId, expectedVersion: first.version, effectiveDate: '2025-08-03' });
    await replay();
    expect((await sdk.queries.getCustomerStatement({ customerId: historicalCustomerId, asOfDate: '2025-08-03' })).balance?.invoiceOutstandingAmount).toBe('10.01');
    const net = (await pool.query<Record<string, unknown>>("select sum(p.credit_amount-p.debit_amount)::text as amount from erp_financials.ledger_postings p join erp_financials.accounts a using(tenant_id,source_id,account_id) where p.source_id=$1 and p.accounting_basis='cash' and a.classification='income'", ['native-cutover-source'])).rows[0];
    expect(net).toEqual({ amount: '17.55' });
  });

});
