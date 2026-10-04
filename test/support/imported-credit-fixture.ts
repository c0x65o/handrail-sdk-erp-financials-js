// Synthetic normalized resources: no historical record IDs or hand-written accounting rows.
import {
  mapHandrailQuickBooksSdkResourcesToCanonicalFacts, materializeQuickBooksBasisBackfill
} from '@handrail/erp-financials';
import type { HandrailQuickBooksSdkResourceSet, QuickBooksBackfillLedgerRow } from '@handrail/erp-financials';

export function required<T>(value:T|undefined):T { if(value===undefined) throw Error('Missing synthetic fixture value'); return value; }

export const scope = {tenantId:'credit_test_tenant', companyId:'credit_test_company', sourceId:'credit_test_source'};
export const now = '2025-07-05T12:00:00.000Z';
export const operation = {actorRef:'user:preparer', approverRef:'user:controller', requestId:'synthetic:request',
  correlationId:'synthetic:correlation', reasonCode:'synthetic_correction', reasonDetail:'Remove phantom receipt', occurredAt:now};
const envelope = {sourceSystem:'quickbooks' as const,tenantId:scope.tenantId, realmId:'synthetic-realm', providerEnvironment:'sandbox' as const, fetchedAt:now};
const partyRef = {sourceObjectId:'synthetic-customer',displayName:'Synthetic Customer',partyType:'customer' as const};
const definitions = [
  {id:'synthetic-invoice', type:'Invoice', number:'1396', date:'2025-07-01', amount:'27.56', remaining:'0.00'},
  {id:'synthetic-prior-invoice', type:'Invoice', number:'PRIOR', date:'2025-07-01', amount:'245.91', remaining:'0.00'},
  {id:'synthetic-phantom', type:'Payment', number:'PHANTOM', date:'2025-07-03', amount:'27.56', remaining:'0.00', target:'synthetic-invoice', applied:'27.56'},
  {id:'synthetic-credit', type:'Payment', number:'CREDIT', date:'2025-07-02', amount:'330.72', remaining:'84.81', target:'synthetic-prior-invoice', applied:'245.91'}
];
export function importedCreditFixture() {
  const operationalDocuments = definitions.map(d=>({...envelope, resourceType:'LedgerTransaction' as const, resourceId:d.id, resource:{
    sourceTransactionId:d.id, sourceTransactionType:d.type, transactionNumber:d.number, transactionDate:d.date,
    currencyCode:'USD', sourceUpdatedAt:now, totalAmount:d.amount, partyRef,
    ...(d.type==='Invoice'?{openAmount:d.remaining}:{unappliedAmount:d.remaining}),
    lines:[{sourceLineId:`${d.id}:line`,lineNumber:1,sourceAmount:d.applied ?? d.amount,
      accountRef:{sourceObjectId:d.type==='Invoice'?'revenue':d.id==='synthetic-phantom'?'undeposited':'bank'},
      linkedTransactions:d.target?[{sourceTransactionId:d.target,sourceTransactionType:'Invoice',amount:d.applied}]:[],postings:[]}]
  }}));
  const resources: HandrailQuickBooksSdkResourceSet = {
    companyInfo:{...envelope,resourceType:'CompanyInfo',resourceId:'synthetic-realm',resource:{CompanyName:'Synthetic Company'}},
    accounts:[['ar','Accounts Receivable','AccountsReceivable'],['revenue','Revenue','Income'],['bank','Bank','Bank'],['undeposited','Undeposited Funds','OtherCurrentAsset']].map(([id,name,type])=>({
      ...envelope,resourceType:'Account',resourceId:required(id),resource:{Id:required(id),Name:required(name),AccountType:required(type),Active:true}
    })), journalEntries:[], operationalDocuments,
    // Header-only normalized ledger resources. Detailed journals arrive by basis import.
    ledgerTransactions:operationalDocuments.map(r=>({...r,resource:{...r.resource,lines:[]}}))
  };
  const facts = mapHandrailQuickBooksSdkResourcesToCanonicalFacts({resources,context:{...scope,realmId:'synthetic-realm',providerEnvironment:'sandbox',
    accountingBasis:'accrual',defaultCurrencyCode:'USD',importBatchId:'synthetic-batch',checkpointId:'synthetic-checkpoint',importedAt:now}});
  const projectionInput = {...scope,currencyCode:'USD',periodStart:'2025-07-01',periodEnd:'2025-07-31',requestedAt:now,
    accounts:facts.accounts,partyIdsBySourceId:Object.fromEntries(facts.parties.map(p=>[p.sourcePartyId,p.partyId]))};
  function rows(basis:'accrual'|'cash'):QuickBooksBackfillLedgerRow[] {
    return definitions.flatMap(d=> {
      if(basis==='cash' && d.type==='Invoice') return [];
      const journal = d.type==='Invoice' ? [['ar',d.amount,'0.00'],['revenue','0.00',d.amount]] :
        basis==='accrual' ? [[d.id==='synthetic-phantom'?'undeposited':'bank',d.amount,'0.00'],['ar','0.00',d.amount]] :
        d.id==='synthetic-phantom' ? [['undeposited',d.amount,'0.00'],['revenue','0.00',d.amount]] :
        [['bank',d.amount,'0.00'],['revenue','0.00','245.91'],['ar','0.00','84.81']];
      return journal.map(([accountSourceId,debitAmount,creditAmount])=>({accountSourceId:required(accountSourceId),debitAmount:required(debitAmount),creditAmount:required(creditAmount),
        transactionId:d.id,transactionType:d.type,transactionDate:d.date,documentNumber:d.number,partySourceId:partyRef.sourceObjectId}));
    });
  }
  const projections = (['accrual','cash'] as const).map(accountingBasis=>materializeQuickBooksBasisBackfill(projectionInput,{
    reportName:'general_ledger',accountingBasis,supportStatus:'supported',currencyCode:'USD',generatedAt:now,
    providerReportRef:{sourceObjectType:'quickbooks_report_general_ledger',sourceObjectId:`synthetic:${accountingBasis}`},totals:[],ledgerRows:rows(accountingBasis)
  }));
  return {resources,facts,projections:[required(projections[0]),required(projections[1])] as const,projectionInput};
}
