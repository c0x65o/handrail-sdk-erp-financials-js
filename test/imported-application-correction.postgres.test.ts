import { required } from "./support/imported-credit-fixture.js";
import { Pool, type PoolClient } from "pg";
import {
  ERP_FINANCIALS_NORMALIZED_QUICKBOOKS_SYNC_FIXTURES,
  createCompanySourceBinding, createErpFinancialsSdk, createPostgresStorageAdapter,
  mapNormalizedQuickBooksFullSyncResponseToCanonicalFacts, migratePostgresSchema,
  persistCanonicalFacts, persistQuickBooksSubledgerResources,
  type HandrailQuickBooksLedgerTransactionResource, type PostgresQueryClient,
} from "@handrail/erp-financials";
import { afterAll, beforeAll, expect, it } from "vitest";

const url = process.env.ERP_FINANCIALS_TEST_DATABASE_URL;
if (url && !new URL(url).pathname.includes("test")) throw Error("Requires isolated test database");
const pool = new Pool({ connectionString:url,max:1 });
let connection: PoolClient | undefined;
const client: PostgresQueryClient = { async query(statement,values) {
  const result = await required(connection).query(statement,values ? [...values] : []);
  return {rows:result.rows,rowCount:result.rowCount ?? 0};
} };
beforeAll(async () => { if(url) { connection=await pool.connect(); await migratePostgresSchema({transaction:work=>work(client)},{appliedByRef:"imported-correction-test"}); } });
afterAll(async () => { connection?.release(); await pool.end(); });

it.skipIf(!url).each([
  { label:"dimensional partial release", billAmount:"100.00", billOpen:"0.00", expense:"100.00", contra:"0.00", cashExpense:"100.00", cashContra:"0.00" },
  { label:"dimensional", billAmount:"100.00", billOpen:"0.00", expense:"100.00", contra:"0.00", cashExpense:"100.00", cashContra:"0.00" },
  { label:"partial release", billAmount:"100.00", billOpen:"0.00", expense:"100.00", contra:"0.00", cashExpense:"100.00", cashContra:"0.00" },
  { label:"partial release explicit coordinates", billAmount:"100.00", billOpen:"0.00", expense:"100.00", contra:"0.00", cashExpense:"100.00", cashContra:"0.00" },
  { label:"residual payment", billAmount:"100.00", billOpen:"0.00", expense:"100.00", contra:"0.00", cashExpense:"100.00", cashContra:"0.00" },
  { label:"split residual", billAmount:"100.00", billOpen:"0.00", expense:"100.00", contra:"0.00", cashExpense:"100.00", cashContra:"0.00" },
  { label:"full plain", billAmount:"100.00", billOpen:"0.00", expense:"100.00", contra:"0.00", cashExpense:"100.00", cashContra:"0.00" },
  { label:"partial plain", billAmount:"200.00", billOpen:"100.00", expense:"200.00", contra:"0.00", cashExpense:"100.00", cashContra:"0.00" },
  { label:"full signed", billAmount:"100.00", billOpen:"0.00", expense:"150.00", contra:"50.00", cashExpense:"150.00", cashContra:"50.00" },
  { label:"partial signed", billAmount:"200.00", billOpen:"100.00", expense:"300.00", contra:"100.00", cashExpense:"150.00", cashContra:"50.00" },
  { label:"split payment", billAmount:"100.00", billOpen:"0.00", expense:"100.00", contra:"0.00", cashExpense:"100.00", cashContra:"0.00" },
  { label:"full tax", billAmount:"100.00", billOpen:"0.00", expense:"80.00", contra:"0.00", cashExpense:"80.00", cashContra:"0.00", component:"tax" },
  { label:"partial tax", billAmount:"200.00", billOpen:"100.00", expense:"160.00", contra:"0.00", cashExpense:"80.00", cashContra:"0.00", component:"tax" },
  { label:"full withholding", billAmount:"100.00", billOpen:"0.00", expense:"120.00", contra:"0.00", cashExpense:"120.00", cashContra:"0.00", component:"liability" },
  { label:"split tax", billAmount:"100.00", billOpen:"0.00", expense:"80.00", contra:"0.00", cashExpense:"80.00", cashContra:"0.00", component:"tax" },
  { label:"multiple payments", billAmount:"200.00", billOpen:"0.00", expense:"200.00", contra:"0.00", cashExpense:"100.00", cashContra:"0.00" },
])("corrects $label imported settlement through the active source, preserves history, and fences provider replay", async scenario => {
  await client.query("begin");
  try {
  const split = scenario.label.startsWith("split ");
  const residual = scenario.label.includes("residual");
  const originalOpen = residual ? "25.00" : "0.00";
  const paymentAmount = residual ? (split ? "225.00" : "125.00") : (split ? "200.00" : "100.00");
  const companyId = "imported-bill-payment-contract";
  const { facts, adapterInput } = mapNormalizedQuickBooksFullSyncResponseToCanonicalFacts(
    ERP_FINANCIALS_NORMALIZED_QUICKBOOKS_SYNC_FIXTURES.fullSync.response, { companyId });
  const vendor = required(facts.parties.find(party => party.partyType === "vendor"));
  const envelope = required(adapterInput.resources.accounts[0]);
  const resource = (id: string, type: string, date: string,
    lines: HandrailQuickBooksLedgerTransactionResource["resource"]["lines"]): HandrailQuickBooksLedgerTransactionResource => ({
    ...envelope, resourceId: id, resourceType: "LedgerTransaction", resource: {
      sourceTransactionId: id, sourceTransactionType: type, transactionDate: date,
      currencyCode: "USD", totalAmount: type === "Bill" ? scenario.billAmount : paymentAmount, openAmount: type === "Bill" ? scenario.billOpen : originalOpen, unappliedAmount: type === "Bill" ? "0.00" : originalOpen,
      partyRef: { sourceObjectId: vendor.sourcePartyId, partyType: "vendor" }, lines,
    },
  });
  const documents = [
    resource("historical-bill", "Bill", "2026-01-10", [{ lineNumber: 1, sourceLineId: "1", postings: [], sourceAmount: scenario.billAmount, accountRef: { sourceObjectId: "79" } }]),
    resource("historical-payment", "BillPayment", "2026-01-20", [{ lineNumber: 1, sourceLineId: "1", postings: [], sourceAmount: "100.00",
      linkedTransactions: [{ sourceTransactionId: "historical-bill", sourceTransactionType: "Bill" }] }]),
  ];
  if (split) {
    documents.push(resource("other-bill", "Bill", "2026-01-11", [{lineNumber:1,sourceLineId:"1",postings:[],sourceAmount:"100.00",accountRef:{sourceObjectId:"79"}}]));
    documents[1] = {...required(documents[1]), resource:{...required(documents[1]).resource, lines:[...required(documents[1]).resource.lines,{lineNumber:2,sourceLineId:"2",postings:[],sourceAmount:"100.00",linkedTransactions:[{sourceTransactionId:"other-bill",sourceTransactionType:"Bill"}]}]}};
  }
  const multiple = scenario.label === "multiple payments";
  const correctedOpen = multiple ? "100.00" : scenario.billAmount;
  if (multiple) documents.push(resource("other-payment", "BillPayment", "2026-01-21", [{ lineNumber:1,sourceLineId:"1",postings:[],sourceAmount:"100.00",
    linkedTransactions:[{sourceTransactionId:"historical-bill",sourceTransactionType:"Bill"}] }]));
  const imported = { ...facts, transactionLines: [], postings: [], transactions: documents.map(document => ({
    ...required(facts.transactions[0]), transactionId: document.resourceId, sourceTransactionId: document.resourceId,
    sourceTransactionType: document.resource.sourceTransactionType, transactionDate: document.resource.transactionDate, partyId: vendor.partyId,
  })) };
  const operation = { actorRef: "requester", approverRef: "independent-reviewer", requestId: "imported-payment-contract",
    correlationId: "imported-payment-contract", reasonCode: "application-correction", occurredAt: "2026-02-03T12:00:00.000Z" };
  const storage = createPostgresStorageAdapter(client);
  await persistCanonicalFacts(storage, imported);
  if (scenario.label.includes("explicit coordinates")) await client.query(`
    create function erp_financials.test_explicit_coordinates() returns trigger language plpgsql as $$
    begin new.target_document_source_id:=new.source_id; return new; end $$;
    create trigger aaa_test_explicit_coordinates before insert on erp_financials.subledger_applications
      for each row execute function erp_financials.test_explicit_coordinates();`);
  const importedResult = await persistQuickBooksSubledgerResources({ client, companyId, importedAt: operation.occurredAt,
    facts: imported, resources: { ...adapterInput.resources, operationalDocuments: documents } });
  expect(importedResult.unresolvedApplications).toEqual([]);
  expect(importedResult.applications).toBe(multiple || split ? 2 : 1);
  const historicalSnapshot = async () => (await client.query(`select a.subledger_application_id, a.application_type, a.status, a.version,
    a.applied_amount::text as amount, source.document_type as source_type, source.open_amount::text as source_open,
    target.document_type as target_type, target.open_amount::text as target_open
    from erp_financials.subledger_applications a
    join erp_financials.subledger_documents source on source.subledger_document_id=a.source_document_id
    join erp_financials.subledger_documents target on target.subledger_document_id=a.target_document_id
    where a.tenant_id=$1 and a.company_id=$2 and a.source_id=$3 and source.metadata->>'sourceTransactionId'='historical-payment' and target.metadata->>'sourceTransactionId'='historical-bill'`, [facts.company.tenantId, companyId, facts.source.sourceId])).rows;
  const before = await historicalSnapshot();
  expect(before).toHaveLength(1);
  expect(before[0]).toMatchObject({ application_type: "bill_payment_to_bill", status: "applied", version: 1,
    amount: "100.00", source_type: "bill_payment", source_open: originalOpen, target_type: "vendor_bill", target_open: scenario.billOpen });

  const sourceId = "native-bill-payment-source", bookId = "imported-bill-payment-book";
  await storage.upsertAccountingSource({ tenantId: facts.company.tenantId, sourceId, sourceSystem: "native_erp",
    providerEnvironment: "native", connectionRef: sourceId, status: "active" });
  await storage.upsertCompanySourceBinding(createCompanySourceBinding({ tenantId: facts.company.tenantId, companyId, sourceId, createdAt: operation.occurredAt }));
  const sdk = createErpFinancialsSdk({ database: { transaction: work => work(client) }, tenantId: facts.company.tenantId,
    companyId, bookId, writeSourceId: sourceId, currencyCode: "USD", postingPolicy: "legacy_unrestricted", financialApprovalPolicy: { mode: "independent" } });
  await sdk.books.define({ operation, bookId, name: "Imported payment correction contract", baseCurrencyCode: "USD" });
  await sdk.books.bindSource({ operation, bookId, sourceId: facts.source.sourceId, sourceRole: "historical", effectiveThrough: "2026-01-31" });
  await sdk.books.bindSource({ operation, bookId, sourceId, sourceRole: "active", effectiveFrom: "2026-02-01" });
  const vendorId = "native-vendor";
  await sdk.commands.parties.ensureActive({ operation, partyId: vendorId, sourcePartyId: "vendor_1", partyType: "vendor", displayName: "Native reviewed vendor" });
  for (const parent of [
    { accountKey: "cash", name: "Bank", classification: "asset" as const, type: "Bank" },
    { accountKey: "ap", name: "Accounts payable", classification: "liability" as const, type: "AccountsPayable" },
    { accountKey: "expense", name: "Expense", classification: "expense" as const, type: "Expense" },
  ]) await sdk.commands.accounts.upsertTree({ operation: { ...operation, requestId: parent.accountKey }, parent });
  const bill = await sdk.commands.vendorBills.create({ operation, idempotencyKey: "native-control-bill", date: "2026-02-01",
    dueDate: "2026-02-28", vendorId, payableAccount: { accountKey: "ap" }, expenseLines: [{ accountKey: "expense", amount: "100.00" }] });
  const payment = await sdk.commands.billPayments.recordAndApply({ operation, idempotencyKey: "native-control-payment", date: "2026-02-02",
    vendorId, amount: "100.00", cashAccount: { accountKey: "cash" }, payableAccount: { accountKey: "ap" }, paymentMethod: "ach",
    allocations: [{ billId: bill.documentId, amount: "100.00", expectedBillVersion: bill.version }] });
  const review = await sdk.queries.getBillPaymentCorrectionReview({ sourceId, paymentId: payment.billPaymentId, limit: 10 });
  expect(review.items).toHaveLength(1);
  await sdk.commands.paymentApplications.unapply({ operation, applicationId: required(review.items[0]).applicationId,
    expectedVersion: required(review.items[0]).version, effectiveDate: "2026-02-03" });
  expect((await sdk.queries.getBillPaymentCorrectionReview({ sourceId, paymentId: payment.billPaymentId, limit: 10 })).payment)
    .toMatchObject({ amount: "100.00", unappliedAmount: "100.00", status: "cleared" });
  expect(await sdk.queries.getVendorBill(bill.documentId)).toMatchObject({ openAmount: "100.00" });

  const applicationId = String(required(before[0]).subledger_application_id);
  const eventCount = async () => (await client.query("select count(*)::int as count from erp_financials.financial_lifecycle_events")).rows;
  const eventsBefore = await eventCount();
  // Desired upstream regression: this source-qualified historical correction
  // resolves, retains original import facts, and reopens both balances to 100.
  await expect(sdk.commands.paymentApplications.unapply({ operation, applicationId, expectedVersion: 1, effectiveDate: "2026-02-03" }))
    .rejects.toMatchObject({ code: "missing_document", message: `Subledger application ${applicationId} does not exist in this scope` });
  expect(await historicalSnapshot()).toEqual(before);
  expect(await eventCount()).toEqual(eventsBefore);
  // A historical writer can find the application, but the cash correction must
  // still respect the historical source's closed reporting-book window.
  const historical = createErpFinancialsSdk({ database: { transaction: work => work(client) }, tenantId: facts.company.tenantId,
    companyId, bookId, writeSourceId: facts.source.sourceId, currencyCode: "USD", postingPolicy: "legacy_unrestricted",
    financialApprovalPolicy: { mode: "independent" } });
  const expenseAccountId = "imported-expense-account", payableAccountId = "imported-payable-account";
  await storage.upsertAccounts([
    { ...required(facts.accounts[0]), accountId: expenseAccountId, sourceAccountId: "expense-fixture", name: "Imported expense", classification: "expense", type: "Expense" },
    { ...required(facts.accounts[0]), accountId: payableAccountId, sourceAccountId: "ap-fixture", name: "Imported payable", classification: "liability", type: "AccountsPayable" },
  ]);
  const { transactionLineId: _lineId, ...posting } = required(facts.postings[0]); void _lineId;
  await storage.upsertLedgerPostings([
    { ...posting, postingId: "imported-bill-expense", sourcePostingId: "imported-bill-expense", transactionId: "historical-bill", accountId: expenseAccountId, postingDate: "2026-01-10", partyId: vendor.partyId, debitAmount: scenario.billAmount, creditAmount: "0.00", netAmount: scenario.billAmount },
    { ...posting, postingId: "imported-bill-payable", sourcePostingId: "imported-bill-payable", transactionId: "historical-bill", accountId: payableAccountId, postingDate: "2026-01-10", partyId: vendor.partyId, debitAmount: "0.00", creditAmount: scenario.billAmount, netAmount: `-${scenario.billAmount}` },
  ]);
  await client.query("savepoint historical_writer_window");
  await expect(historical.commands.paymentApplications.unapply({ operation, applicationId, expectedVersion: 1, effectiveDate: "2026-02-03" }))
    .rejects.toMatchObject({ message: `posting date 2026-02-03 is outside every reporting-book window for source ${facts.source.sourceId}` });
  await client.query("rollback to savepoint historical_writer_window");
  await client.query("release savepoint historical_writer_window");
  expect(await historicalSnapshot()).toEqual(before);
  expect(await eventCount()).toEqual(eventsBefore);
  const corrections = await client.query(`select posting_id from erp_financials.ledger_postings
    where tenant_id=$1 and source_id=$2 and accounting_basis='cash' and posting_date='2026-02-03'`,
    [facts.company.tenantId, facts.source.sourceId]);
  expect(corrections.rows).toEqual([]);
  // Exact imported accrual and cash provenance, separate from the canonical headers.
  await storage.upsertTransactions([
    { ...required(imported.transactions[0]),transactionId:"bill-accrual",sourceTransactionId:"bill-accrual",partyId:vendor.partyId,
      sourcePayloadRef:{sourceObjectType:"Bill",sourceObjectId:"historical-bill"} },
    { ...required(imported.transactions[1]),transactionId:"payment-cash",sourceTransactionId:"payment-cash",partyId:vendor.partyId,
      sourcePayloadRef:{sourceObjectType:"BillPayment",sourceObjectId:"historical-payment"} },
  ]);
  const bankId="historical-bank";
  await storage.upsertAccounts([{ ...required(facts.accounts[0]),accountId:bankId,sourceAccountId:bankId,type:"Bank",classification:"asset",name:"Historical bank" }]);
  const originalJournal = [
    { ...posting,postingId:"bill-basis-expense",sourcePostingId:"bill-basis-expense",transactionId:"bill-accrual",accountId:expenseAccountId,postingDate:"2026-01-10",partyId:vendor.partyId,debitAmount:scenario.expense,creditAmount:"0.00",netAmount:scenario.expense,accountingBasis:"accrual" as const },
    { ...posting,postingId:"bill-basis-payable",sourcePostingId:"bill-basis-payable",transactionId:"bill-accrual",accountId:payableAccountId,postingDate:"2026-01-10",partyId:vendor.partyId,debitAmount:"0.00",creditAmount:scenario.billAmount,netAmount:`-${scenario.billAmount}`,accountingBasis:"accrual" as const },
    { ...posting,postingId:"payment-cash-expense",sourcePostingId:"payment-cash-expense",transactionId:"payment-cash",accountId:expenseAccountId,postingDate:"2026-01-20",partyId:vendor.partyId,debitAmount:scenario.cashExpense,creditAmount:"0.00",netAmount:scenario.cashExpense,accountingBasis:"cash" as const },
    { ...posting,postingId:"payment-cash-bank",sourcePostingId:"payment-cash-bank",transactionId:"payment-cash",accountId:bankId,postingDate:"2026-01-20",partyId:vendor.partyId,debitAmount:"0.00",creditAmount:"100.00",netAmount:"-100.00",accountingBasis:"cash" as const },
  ];
  if(scenario.contra !== "0.00") originalJournal.push(
    { ...required(originalJournal[0]),postingId:"bill-basis-contra",sourcePostingId:"bill-basis-contra",debitAmount:"0.00",creditAmount:scenario.contra,netAmount:`-${scenario.contra}` },
    { ...required(originalJournal[2]),postingId:"payment-cash-contra",sourcePostingId:"payment-cash-contra",debitAmount:"0.00",creditAmount:scenario.cashContra,netAmount:`-${scenario.cashContra}` },
  );
  const componentType = scenario.component === "tax" ? "OtherCurrentAsset" : "OtherCurrentLiability";
  const componentClass = scenario.component === "tax" ? "asset" : "liability";
  if (scenario.component) {
    await storage.upsertAccounts([{...required(facts.accounts[0]),accountId:"imported-component",sourceAccountId:"component",name:"Reviewed component",classification:componentClass,type:componentType}]);
    await sdk.commands.accounts.upsertTree({operation:{...operation,requestId:"component"},parent:{accountKey:"component",name:"Reviewed component",classification:componentClass,type:componentType}});
    const amount = scenario.billAmount === "200.00" ? "40.00" : "20.00";
    const amounts = (value:string) => scenario.component === "tax" ? {debitAmount:value,creditAmount:"0.00",netAmount:value} : {debitAmount:"0.00",creditAmount:value,netAmount:`-${value}`};
    originalJournal.push({...required(originalJournal[0]),postingId:"bill-component",sourcePostingId:"bill-component",accountId:"imported-component",...amounts(amount)},
      {...required(originalJournal[2]),postingId:"cash-component",sourcePostingId:"cash-component",accountId:"imported-component",...amounts("20.00")});
  }
  if(split) {
    await storage.upsertTransactions([{...required(imported.transactions[0]),transactionId:"other-bill-accrual",sourceTransactionId:"other-bill-accrual",partyId:vendor.partyId,sourcePayloadRef:{sourceObjectType:"Bill",sourceObjectId:"other-bill"}}]);
    originalJournal.push(...originalJournal.filter(p=>p.transactionId==="bill-accrual").map(p=>({...p,postingId:`other-${p.postingId}`,sourcePostingId:`other-${p.postingId}`,transactionId:"other-bill-accrual",postingDate:"2026-01-11"})));
    originalJournal.push({...required(originalJournal[2]),postingId:"other-payment-expense",sourcePostingId:"other-payment-expense"});
    if (scenario.component) originalJournal.push({...required(originalJournal.find(p=>p.postingId==="cash-component")),postingId:"other-cash-component",sourcePostingId:"other-cash-component"});
    Object.assign(required(originalJournal[3]),{creditAmount:"200.00",netAmount:"-200.00"});
  }
  if (residual) {
    Object.assign(required(originalJournal[3]),{creditAmount:paymentAmount,netAmount:`-${paymentAmount}`});
    originalJournal.push({...required(originalJournal[2]),postingId:"payment-residual",sourcePostingId:"payment-residual",accountId:payableAccountId,debitAmount:"25.00",creditAmount:"0.00",netAmount:"25.00"});
  }
  if (scenario.label.startsWith("dimensional")) {
    await storage.upsertDimensions([
      {tenantId:facts.company.tenantId,sourceId:facts.source.sourceId,dimensionId:"historical-class",dimensionKind:"class",sourceDimensionId:"old-class",name:"Original class",active:true},
      {tenantId:facts.company.tenantId,sourceId,dimensionId:"native-class",dimensionKind:"class",sourceDimensionId:"new-class",name:"Mapped class",active:true},
    ]);
    for (const line of originalJournal.filter(p => p.accountId === expenseAccountId)) {
      Object.assign(line,{dimensionRefs:[{dimensionId:"historical-class",dimensionKind:"class",sourceDimensionId:"old-class",name:"Original class"}]});
    }
  }
  await storage.upsertLedgerPostings(originalJournal);
  const nativeAccounts=(await client.query(`select account_id,type from erp_financials.accounts where tenant_id=$1 and source_id=$2`,[facts.company.tenantId,sourceId])).rows;
  const importedCorrection={...(scenario.label.startsWith("dimensional") ? {dimensionMappings:[{historicalDimensionId:"historical-class",nativeDimensionId:"native-class"}]} : {}),applicationSourceId:facts.source.sourceId,reviewRef:"review:original-payment",historicalPartyId:vendor.partyId,nativePartyId:vendorId,
    accountMappings:[{historicalAccountId:expenseAccountId,nativeAccountId:String(required(nativeAccounts.find(a=>a.type==='Expense')).account_id)},
      {historicalAccountId:payableAccountId,nativeAccountId:String(required(nativeAccounts.find(a=>a.type==='AccountsPayable')).account_id)}]};
  if (scenario.component) importedCorrection.accountMappings.push({historicalAccountId:"imported-component",nativeAccountId:String(required(nativeAccounts.find(a=>a.type===componentType)).account_id)});
  const command={operation,applicationId,expectedVersion:1,effectiveDate:"2026-02-03",importedCorrection};
  if (scenario.label.startsWith("dimensional")) {
    await expect(sdk.commands.paymentApplications.unapply({...command,importedCorrection:{...importedCorrection,dimensionMappings:[]}})).rejects.toThrow("dimension mappings");
    await expect(sdk.commands.paymentApplications.unapply({...command,importedCorrection:{...importedCorrection,dimensionMappings:[{historicalDimensionId:"historical-class",nativeDimensionId:"wrong-class"}]}})).rejects.toThrow("dimension mappings");
  }
  for (const invalid of [
    {...command,operation:{...operation,approverRef:operation.actorRef}},
    {...command,effectiveDate:"2026-01-19"},
    {...command,importedCorrection:{...importedCorrection,nativePartyId:"unreviewed-vendor"}},
    {...command,importedCorrection:{...importedCorrection,accountMappings:[]}},
    {...command,expectedVersion:2},
  ]) await expect(sdk.commands.paymentApplications.unapply(invalid)).rejects.toThrow();
  if (scenario.component) {
    await expect(sdk.commands.paymentApplications.unapply({...command,importedCorrection:{...importedCorrection,accountMappings:importedCorrection.accountMappings.filter(m=>m.historicalAccountId!=="imported-component")}})).rejects.toThrow("cover exactly");
    await client.query("savepoint incompatible_component");
    await client.query("update erp_financials.accounts set type='Bank' where source_id=$1 and account_id=$2",[sourceId,required(importedCorrection.accountMappings.find(m=>m.historicalAccountId==="imported-component")).nativeAccountId]);
    await expect(sdk.commands.paymentApplications.unapply(command)).rejects.toThrow("mapping changes classification");
    await client.query("rollback to savepoint incompatible_component");
    await client.query("release savepoint incompatible_component");
  }
  if(scenario.label === "full plain") {
  await client.query("savepoint duplicated_expense_evidence");
  const expense=required(originalJournal[0]), cashExpense=required(originalJournal[2]);
  await storage.upsertLedgerPostings([
    {...expense,debitAmount:"50.00",netAmount:"50.00"},
    {...expense,postingId:"duplicate-accrual-expense",sourcePostingId:"duplicate-accrual-expense",debitAmount:"50.00",netAmount:"50.00"},
    {...cashExpense,debitAmount:"50.00",netAmount:"50.00"},
    {...cashExpense,postingId:"duplicate-cash-expense",sourcePostingId:"duplicate-cash-expense",debitAmount:"40.00",netAmount:"40.00"},
  ]);
  await expect(sdk.commands.paymentApplications.unapply(command)).rejects.toThrow("exact original payment cash recognition journal");
  await client.query("rollback to savepoint duplicated_expense_evidence");
  await client.query("release savepoint duplicated_expense_evidence");
  }
  await client.query("savepoint cash_rounding_mismatch");
  await client.query("update erp_financials.ledger_postings set debit_amount=debit_amount+0.01,net_amount=net_amount+0.01 where posting_id=$1",[required(originalJournal[2]).postingId]);
  await expect(sdk.commands.paymentApplications.unapply(command)).rejects.toThrow("exact original payment cash recognition journal");
  await client.query("rollback to savepoint cash_rounding_mismatch");
  await client.query("release savepoint cash_rounding_mismatch");
  if (residual) {
    await client.query("savepoint wrong_residual");
    await client.query("update erp_financials.ledger_postings set account_id=$1 where posting_id='payment-residual'",[expenseAccountId]);
    await expect(sdk.commands.paymentApplications.unapply(command)).rejects.toThrow("exact original payment cash recognition journal");
    await client.query("rollback to savepoint wrong_residual");
    await client.query("release savepoint wrong_residual");
  }
  const historicalFacts=async()=>(await client.query(`select to_jsonb(p) as fact from erp_financials.ledger_postings p where tenant_id=$1 and source_id=$2 order by posting_id`,[facts.company.tenantId,facts.source.sourceId])).rows;
  const journalBefore=await historicalFacts();
  const peerFacts = async () => (await client.query(`select to_jsonb(a) as application from erp_financials.subledger_applications a
    where tenant_id=$1 and company_id=$2 and source_id=$3 and subledger_application_id<>$4 order by subledger_application_id`,
    [facts.company.tenantId,companyId,facts.source.sourceId,applicationId])).rows;
  const peersBefore = await peerFacts();
  if (scenario.label.includes("partial release")) {
    const rootSnapshot=async () => (await historicalSnapshot()).filter(row => row.subledger_application_id === applicationId);
    const partialCommand={...command,amount:"25.00"};
    const first=await sdk.commands.paymentApplications.unapply(partialCommand);
    expect(first.releasedAmount).toBe("25.00");
    expect(first.retainedApplication?.appliedAmount).toBe("75.00");
    expect(await rootSnapshot()).toMatchObject([{amount:"100.00",source_open:"25.00",target_open:"25.00",status:"unapplied"}]);
    expect(await sdk.commands.paymentApplications.unapply(partialCommand)).toEqual(first);
    await expect(sdk.commands.paymentApplications.unapply({...partialCommand,amount:"26.00"})).rejects.toThrow();
    const second=await sdk.commands.paymentApplications.unapply({...command,applicationId:required(first.retainedApplication).applicationId,amount:"25.00",effectiveDate:"2026-02-04"});
    expect(second.retainedApplication?.appliedAmount).toBe("50.00");
    expect(await rootSnapshot()).toMatchObject([{source_open:"50.00",target_open:"50.00"}]);
    await sdk.commands.paymentApplications.unapply({...command,applicationId:required(second.retainedApplication).applicationId,effectiveDate:"2026-02-05"});
    expect(await rootSnapshot()).toMatchObject([{source_open:"100.00",target_open:"100.00"}]);
    expect(await historicalFacts()).toEqual(journalBefore);
    expect(await sdk.commands.paymentApplications.unapply(partialCommand)).toEqual(first);
    if (scenario.label.startsWith("dimensional")) {
      const refs=(await client.query(`select dimension_refs from erp_financials.ledger_postings where source_id=$1 and dimension_refs <> '[]'::jsonb`,[sourceId])).rows;
      expect(refs.length).toBeGreaterThan(0);
      expect(refs.every(p => JSON.stringify(p.dimension_refs).includes("native-class") && !JSON.stringify(p.dimension_refs).includes("historical-class"))).toBe(true);
    }
    return;
  }
  const ended=await sdk.commands.paymentApplications.unapply(command);
  expect(await peerFacts()).toEqual(peersBefore);
  expect(ended.status).toBe("unapplied");
  expect(await historicalSnapshot()).toMatchObject([{status:"unapplied",version:2,amount:"100.00",source_open:residual?"125.00":"100.00",target_open:correctedOpen}]);
  expect(await historicalFacts()).toEqual(journalBefore);
  const nativeReversals=async()=>(await client.query(`select p.posting_id,p.posting_date::text,p.debit_amount::text,p.credit_amount::text,a.type,p.accounting_basis
    from erp_financials.ledger_postings p join erp_financials.accounts a using(tenant_id,source_id,account_id)
    join erp_financials.transactions t using(tenant_id,source_id,transaction_id)
    where p.source_id=$1 and t.source_transaction_id=$2 order by a.type,p.credit_amount`,[sourceId,`cross-source-settlement:${applicationId}:reverse`])).rows;
  const reverse=await nativeReversals();
  expect(reverse).toMatchObject([
    {posting_date:"2026-02-03",debit_amount:"100.00",credit_amount:"0.00",type:"AccountsPayable",accounting_basis:"cash"},
    ... (scenario.cashContra !== "0.00" ? [{posting_date:"2026-02-03",debit_amount:scenario.cashContra,credit_amount:"0.00",type:"Expense",accounting_basis:"cash"}] : []),
    {posting_date:"2026-02-03",debit_amount:"0.00",credit_amount:scenario.cashExpense,type:"Expense",accounting_basis:"cash"},
    ...(scenario.component ? [{posting_date:"2026-02-03",debit_amount:scenario.component==="tax"?"0.00":"20.00",credit_amount:scenario.component==="tax"?"20.00":"0.00",type:componentType,accounting_basis:"cash"}] : []),
  ]);
  expect(await sdk.commands.paymentApplications.unapply(command)).toEqual(ended);
  await expect(sdk.commands.paymentApplications.unapply({...command,effectiveDate:"2026-02-04"})).rejects.toThrow();
  await expect(sdk.commands.paymentApplications.unapply({...command,importedCorrection:{...importedCorrection,reviewRef:"different-review"}})).rejects.toThrow();
  const historicBills=await sdk.queries.listVendorBills({asOfDate:"2026-02-02",vendorId:vendor.partyId});
  expect(historicBills.items).toHaveLength(split ? 2 : 1);
  expect(historicBills.items[0]?.openAmount).toBe(scenario.billOpen);
  expect((await sdk.queries.listVendorBills({asOfDate:"2026-02-03",vendorId:vendor.partyId})).items.map(b=>b.openAmount)).toContain(correctedOpen);
  for (const changed of [false,true]) {
    const result=await persistCanonicalFacts(storage,{...imported,transactions:imported.transactions.map(t=>({...t,...(changed?{status:"void" as const}:{})})),postings:originalJournal.map(p=>({...p,...(changed?{debitAmount:p.debitAmount==="100.00"?"90.00":"0.00",creditAmount:p.creditAmount==="100.00"?"90.00":"0.00",netAmount:p.netAmount==="100.00"?"90.00":"-90.00"}:{})}))});
    expect(result.correctionDependencies).toHaveLength(split ? 3 : 2);
    const replayPromise=persistQuickBooksSubledgerResources({client,companyId,importedAt:operation.occurredAt,facts:imported,
      replaceMissingDocuments:true,resources:{...adapterInput.resources,operationalDocuments:documents.map(d=>({...d,...(changed?{syncAction:"deleted" as const}:{})}))}});
    if (multiple) await expect(replayPromise).rejects.toThrow("Provider links to a locally corrected imported bill require explicit reconciliation");
    else expect((await replayPromise).correctionDependencies).toHaveLength(split ? 3 : 2);
    expect(await historicalSnapshot()).toMatchObject([{status:"unapplied",version:2,source_open:residual?"125.00":"100.00",target_open:correctedOpen}]);
    expect(await peerFacts()).toEqual(peersBefore);
    expect(await historicalFacts()).toEqual(journalBefore);
    expect(await nativeReversals()).toEqual(reverse);
  }
  if(split) {
    const sibling = required((await client.query(`select subledger_application_id from erp_financials.subledger_applications where source_id=$1 and subledger_application_id<>$2`,[facts.source.sourceId,applicationId])).rows[0]);
    const second = {...command,applicationId:String(sibling.subledger_application_id),effectiveDate:"2026-02-04"};
    expect((await sdk.commands.paymentApplications.unapply(second)).status).toBe("unapplied");
    expect(await historicalSnapshot()).toMatchObject([{source_open:paymentAmount,target_open:"100.00"}]);
    expect(await sdk.commands.paymentApplications.unapply(second)).toMatchObject({status:"unapplied"});
    expect(await historicalFacts()).toEqual(journalBefore);
  }
  } finally { await client.query("rollback"); }
});
