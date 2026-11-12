import { createHash } from "node:crypto";

import type {
  Account,
  AccountClassification,
  AccountingBasis,
  AccountingCompany,
  AccountingDimension,
  AccountingSource,
  AccountingSourceSystem,
  AccountingTransaction,
  DecimalString,
  DimensionRef,
  ImportBatch,
  IsoCurrencyCode,
  IsoDate,
  IsoDateTime,
  Item,
  JsonValue,
  LedgerPosting,
  Party,
  ProviderEnvironment,
  SafeSourcePayloadRef,
  SourceId,
  SyncCheckpoint,
  TenantId,
  TransactionLine
} from "./canonical-model.js";
import type {
  NormalizedAccountingImportBatchMetadata,
  NormalizedAccountingReconciliationEvidence,
  NormalizedAccountingSyncCheckpointMetadata,
  NormalizedQuickBooksClassResource,
  NormalizedQuickBooksCustomerResource,
  NormalizedQuickBooksDepartmentResource,
  NormalizedQuickBooksDimensionRef,
  NormalizedQuickBooksDimensionResource,
  NormalizedQuickBooksItemResource,
  NormalizedQuickBooksLedgerPostingResource,
  NormalizedQuickBooksLedgerTransaction,
  NormalizedQuickBooksPartyResource,
  NormalizedQuickBooksPartyRef,
  NormalizedQuickBooksProviderReportRef,
  NormalizedQuickBooksResourceEnvelope,
  NormalizedQuickBooksSourceIdentity,
  NormalizedQuickBooksVendorResource
} from "./normalized-accounting-contracts.js";
import { assertLedgerPostingAmounts, assertSafeSourcePayloadRef, createDimensionHash } from "./canonical-model.js";

export type CanonicalAccountingFactSet = {
  readonly company: AccountingCompany;
  readonly source: AccountingSource;
  readonly importBatch: ImportBatch;
  readonly checkpoint: SyncCheckpoint;
  readonly accounts: readonly Account[];
  readonly parties: readonly Party[];
  readonly items: readonly Item[];
  readonly dimensions: readonly AccountingDimension[];
  readonly transactions: readonly AccountingTransaction[];
  readonly transactionLines: readonly TransactionLine[];
  readonly postings: readonly LedgerPosting[];
};

export type SourceAdapterContext = {
  readonly tenantId: TenantId;
  readonly companyId: string;
  readonly sourceId: SourceId;
  readonly sourceSystem: AccountingSourceSystem;
  readonly providerEnvironment: ProviderEnvironment;
  readonly sourceCompanyRef: string;
  readonly connectionRef: string;
  readonly importBatchId: string;
  readonly checkpointId: string;
  readonly accountingBasis: AccountingBasis;
  readonly defaultCurrencyCode: IsoCurrencyCode;
  readonly importedAt: IsoDateTime;
  readonly freshThrough?: IsoDateTime;
  readonly latestSourceUpdatedAt?: IsoDateTime;
};

export type SourceAdapter<Input> = {
  readonly sourceSystem: AccountingSourceSystem;
  map(input: Input): CanonicalAccountingFactSet;
};

export type NativeLedgerAccount = {
  readonly sourceAccountId: string;
  readonly parentAccountSourceId?: string;
  readonly name: string;
  readonly classification: AccountClassification;
  readonly accountNumber?: string;
  readonly type?: string;
  readonly subtype?: string;
  readonly active?: boolean;
  readonly currencyCode?: IsoCurrencyCode;
};

export type NativeLedgerLine = {
  readonly sourceLineId?: string;
  readonly sourcePostingId?: string;
  readonly lineNumber: number;
  readonly accountSourceId: string;
  readonly postingDate?: IsoDate;
  readonly debitAmount?: DecimalString;
  readonly creditAmount?: DecimalString;
  readonly amount?: DecimalString;
  readonly partySourceId?: string;
  readonly itemSourceId?: string;
  readonly quantity?: DecimalString;
  readonly unitAmount?: DecimalString;
  readonly description?: string;
  readonly dimensionRefs?: readonly DimensionRef[];
  readonly sourcePayloadRef?: SafeSourcePayloadRef;
};

export type NativeLedgerTransaction = {
  readonly sourceTransactionId: string;
  readonly sourceTransactionType: string;
  readonly transactionDate: IsoDate;
  readonly transactionNumber?: string;
  readonly postedAt?: IsoDateTime;
  readonly updatedAt?: IsoDateTime;
  readonly partySourceId?: string;
  readonly currencyCode?: IsoCurrencyCode;
  readonly exchangeRate?: DecimalString;
  readonly memo?: string;
  readonly sourcePayloadRef?: SafeSourcePayloadRef;
  readonly lines: readonly NativeLedgerLine[];
};

export type NativeLedgerAdapterInput = {
  readonly context: SourceAdapterContext;
  readonly company: {
    readonly legalName: string;
    readonly displayName: string;
    readonly fiscalYearStartMonth?: number;
  };
  readonly accounts: readonly NativeLedgerAccount[];
  readonly transactions: readonly NativeLedgerTransaction[];
  readonly parties?: readonly Party[];
  readonly items?: readonly Item[];
  readonly dimensions?: readonly AccountingDimension[];
};

export type HandrailQuickBooksRuntimeConfigRef = {
  readonly serviceEnvironment: "staging" | "production";
  readonly providerMode: "sandbox" | "production";
  readonly tenantId: TenantId;
};

export type QuickBooksAdapterContext = Omit<
  SourceAdapterContext,
  "sourceSystem" | "providerEnvironment" | "sourceCompanyRef" | "connectionRef"
> & {
  readonly realmId: string;
  readonly providerEnvironment: Extract<ProviderEnvironment, "sandbox" | "production">;
  readonly runtimeConfig?: HandrailQuickBooksRuntimeConfigRef;
};

export type QuickBooksSdkRef = {
  readonly value?: string;
  readonly name?: string;
};

export type QuickBooksSdkAccount = {
  readonly Id: string;
  readonly Name: string;
  readonly ParentRef?: QuickBooksSdkRef;
  readonly AcctNum?: string;
  readonly AccountType: string;
  readonly AccountSubType?: string;
  readonly Classification?: AccountClassification;
  readonly classification?: AccountClassification;
  readonly Active?: boolean;
  readonly CurrencyRef?: QuickBooksSdkRef;
};

export type QuickBooksSdkJournalEntryLineDetail = {
  readonly PostingType: "Debit" | "Credit";
  readonly AccountRef: QuickBooksSdkRef;
  readonly Entity?: { readonly EntityRef?: QuickBooksSdkRef };
  readonly ClassRef?: QuickBooksSdkRef;
  readonly DepartmentRef?: QuickBooksSdkRef;
};

export type QuickBooksSdkJournalEntryLine = {
  readonly Id?: string;
  readonly LineNum?: number;
  readonly Description?: string;
  readonly Amount: number | DecimalString;
  readonly DetailType?: string;
  readonly JournalEntryLineDetail: QuickBooksSdkJournalEntryLineDetail;
  readonly sourcePayloadRef?: SafeSourcePayloadRef;
};

export type QuickBooksSdkJournalEntry = {
  readonly Id: string;
  readonly TxnDate: IsoDate;
  readonly DocNumber?: string;
  readonly PrivateNote?: string;
  readonly CurrencyRef?: QuickBooksSdkRef;
  readonly MetaData?: {
    readonly LastUpdatedTime?: IsoDateTime;
  };
  readonly Line: readonly QuickBooksSdkJournalEntryLine[];
  readonly sourcePayloadRef?: SafeSourcePayloadRef;
};

export type QuickBooksSdkCompanyInfo = {
  readonly CompanyName?: string;
  readonly LegalName?: string;
  readonly FiscalYearStartMonth?: number;
};

export type QuickBooksJournalEntryAdapterInput = {
  readonly context: QuickBooksAdapterContext;
  readonly companyInfo: QuickBooksSdkCompanyInfo;
  readonly accounts: readonly QuickBooksSdkAccount[];
  readonly journalEntries: readonly QuickBooksSdkJournalEntry[];
};

export type HandrailQuickBooksNormalizedResource<ResourceType extends string, Resource> = NormalizedQuickBooksResourceEnvelope<
  ResourceType,
  Resource
>;

export type HandrailQuickBooksCompanyInfoResource = HandrailQuickBooksNormalizedResource<"CompanyInfo", QuickBooksSdkCompanyInfo>;

export type HandrailQuickBooksAccountResource = HandrailQuickBooksNormalizedResource<"Account", QuickBooksSdkAccount>;

export type HandrailQuickBooksJournalEntryResource = HandrailQuickBooksNormalizedResource<"JournalEntry", QuickBooksSdkJournalEntry> & {
  readonly lineSourcePayloadRefs?: Readonly<Record<string, SafeSourcePayloadRef>>;
};

export type HandrailQuickBooksLedgerTransactionResource = HandrailQuickBooksNormalizedResource<
  "LedgerTransaction",
  NormalizedQuickBooksLedgerTransaction
>;

export type HandrailQuickBooksSdkResourceSet = {
  readonly identity?: NormalizedQuickBooksSourceIdentity;
  readonly importBatch?: NormalizedAccountingImportBatchMetadata;
  readonly checkpoint?: NormalizedAccountingSyncCheckpointMetadata;
  readonly companyInfo: HandrailQuickBooksCompanyInfoResource;
  readonly accounts: readonly HandrailQuickBooksAccountResource[];
  readonly journalEntries: readonly HandrailQuickBooksJournalEntryResource[];
  readonly ledgerTransactions?: readonly HandrailQuickBooksLedgerTransactionResource[];
  /** Provider documents retained for subledger semantics; never used as a second ledger feed. */
  readonly operationalDocuments?: readonly HandrailQuickBooksLedgerTransactionResource[];
  readonly ledgerPostings?: readonly NormalizedQuickBooksLedgerPostingResource[];
  readonly parties?: readonly NormalizedQuickBooksPartyResource[];
  readonly customers?: readonly NormalizedQuickBooksCustomerResource[];
  readonly vendors?: readonly NormalizedQuickBooksVendorResource[];
  readonly items?: readonly NormalizedQuickBooksItemResource[];
  readonly classes?: readonly NormalizedQuickBooksClassResource[];
  readonly departments?: readonly NormalizedQuickBooksDepartmentResource[];
  readonly dimensions?: readonly NormalizedQuickBooksDimensionResource[];
  readonly providerReports?: readonly NormalizedQuickBooksProviderReportRef[];
  readonly reconciliationEvidence?: readonly NormalizedAccountingReconciliationEvidence[];
};

export type HandrailQuickBooksSdkResourcesAdapterInput = {
  readonly context: QuickBooksAdapterContext;
  readonly resources: HandrailQuickBooksSdkResourceSet;
};

type NormalizedLedgerInput = {
  readonly context: SourceAdapterContext;
  readonly company: {
    readonly legalName: string;
    readonly displayName: string;
    readonly fiscalYearStartMonth?: number;
  };
  readonly accounts: readonly NativeLedgerAccount[];
  readonly transactions: readonly NativeLedgerTransaction[];
  readonly parties?: readonly Party[];
  readonly items?: readonly Item[];
  readonly dimensions?: readonly AccountingDimension[];
};

export const nativeLedgerSourceAdapter: SourceAdapter<NativeLedgerAdapterInput> = {
  sourceSystem: "native_erp",
  map: mapNativeLedgerToCanonicalFacts
};

export const quickBooksJournalEntrySourceAdapter: SourceAdapter<QuickBooksJournalEntryAdapterInput> = {
  sourceSystem: "quickbooks",
  map: mapQuickBooksJournalEntriesToCanonicalFacts
};

export const handrailQuickBooksSdkResourcesSourceAdapter: SourceAdapter<HandrailQuickBooksSdkResourcesAdapterInput> = {
  sourceSystem: "quickbooks",
  map: mapHandrailQuickBooksSdkResourcesToCanonicalFacts
};

export function mapNativeLedgerToCanonicalFacts(input: NativeLedgerAdapterInput): CanonicalAccountingFactSet {
  return mapNormalizedLedgerToCanonicalFacts(input);
}

export function mapHandrailQuickBooksSdkResourcesToCanonicalFacts(
  input: HandrailQuickBooksSdkResourcesAdapterInput
): CanonicalAccountingFactSet {
  // The ledger-resource mapper also handles legacy JournalEntry resources and
  // preserves normalized reference families when a batch has no postings.
  return mapHandrailQuickBooksSdkLedgerResourcesToCanonicalFacts(input);
}

export function mapHandrailQuickBooksSdkResourcesToJournalEntryInput(
  input: HandrailQuickBooksSdkResourcesAdapterInput
): QuickBooksJournalEntryAdapterInput {
  assertQuickBooksResourceContext(input.context, input.resources.companyInfo);
  assertQuickBooksResourceId(input.resources.companyInfo, input.context.realmId);

  return {
    context: input.context,
    companyInfo: input.resources.companyInfo.resource,
    accounts: input.resources.accounts.map((accountResource) => {
      assertQuickBooksResourceContext(input.context, accountResource);
      assertQuickBooksResourceId(accountResource, accountResource.resource.Id);
      return accountResource.resource;
    }),
    journalEntries: input.resources.journalEntries.map((journalEntryResource): QuickBooksSdkJournalEntry => {
      assertQuickBooksResourceContext(input.context, journalEntryResource);
      assertQuickBooksResourceId(journalEntryResource, journalEntryResource.resource.Id);
      const sourceUpdatedAt = journalEntryResource.resource.MetaData?.LastUpdatedTime ?? journalEntryResource.sourceUpdatedAt;
      const lineSourcePayloadRefs: Readonly<Record<string, SafeSourcePayloadRef>> = journalEntryResource.lineSourcePayloadRefs ?? {};
      const lines = journalEntryResource.resource.Line.map((line, index): QuickBooksSdkJournalEntryLine => {
        const lineSourceId = quickBooksJournalEntryLineSourceId(line, index);
        const sourcePayloadRef = line.sourcePayloadRef ?? lineSourcePayloadRefs[lineSourceId];
        return {
          ...line,
          ...(sourcePayloadRef === undefined ? {} : { sourcePayloadRef: checkedSourcePayloadRef(sourcePayloadRef) })
        };
      });

      return {
        ...journalEntryResource.resource,
        ...(sourceUpdatedAt === undefined
          ? {}
          : {
              MetaData: {
                ...(journalEntryResource.resource.MetaData ?? {}),
                LastUpdatedTime: sourceUpdatedAt
              }
            }),
        ...(journalEntryResource.sourcePayloadRef === undefined
          ? {}
          : { sourcePayloadRef: checkedSourcePayloadRef(journalEntryResource.sourcePayloadRef) }),
        Line: lines
      };
    })
  };
}

export function mapQuickBooksJournalEntriesToCanonicalFacts(input: QuickBooksJournalEntryAdapterInput): CanonicalAccountingFactSet {
  const context: SourceAdapterContext = {
    ...input.context,
    sourceSystem: "quickbooks",
    sourceCompanyRef: input.context.realmId,
    connectionRef: quickBooksConnectionRef(input.context)
  };
  const transactions = input.journalEntries.map((journalEntry) => quickBooksJournalEntryToNativeTransaction(context, journalEntry));

  return mapNormalizedLedgerToCanonicalFacts({
    context,
    company: {
      legalName: input.companyInfo.LegalName ?? input.companyInfo.CompanyName ?? input.context.realmId,
      displayName: input.companyInfo.CompanyName ?? input.companyInfo.LegalName ?? input.context.realmId,
      ...(input.companyInfo.FiscalYearStartMonth === undefined ? {} : { fiscalYearStartMonth: input.companyInfo.FiscalYearStartMonth })
    },
    accounts: input.accounts.map(quickBooksAccountToNativeAccount),
    transactions
  });
}

function mapHandrailQuickBooksSdkLedgerResourcesToCanonicalFacts(
  input: HandrailQuickBooksSdkResourcesAdapterInput
): CanonicalAccountingFactSet {
  assertQuickBooksResourceContext(input.context, input.resources.companyInfo);
  assertQuickBooksResourceId(input.resources.companyInfo, input.context.realmId);

  const context: SourceAdapterContext = {
    ...input.context,
    sourceSystem: "quickbooks",
    sourceCompanyRef: input.context.realmId,
    connectionRef: quickBooksConnectionRef(input.context)
  };
  const ledgerTransactions = input.resources.ledgerTransactions ?? [];
  const ledgerTransactionKeys = new Set(
    ledgerTransactions.map((resource) => `${resource.resource.sourceTransactionType}:${resource.resource.sourceTransactionId}`)
  );
  const journalTransactions = input.resources.journalEntries
    .filter((resource) => !ledgerTransactionKeys.has(`JournalEntry:${resource.resource.Id}`))
    .map((resource) => {
      assertQuickBooksResourceContext(input.context, resource);
      assertQuickBooksResourceId(resource, resource.resource.Id);
      return quickBooksJournalEntryToNativeTransaction(context, resource.resource);
    });
  const parties = normalizedQuickBooksPartiesToCanonicalParties(context, [
    ...(input.resources.parties ?? []),
    ...(input.resources.customers ?? []),
    ...(input.resources.vendors ?? [])
  ]);
  const partyReferenceTransactions = [
    ...ledgerTransactions,
    ...(input.resources.operationalDocuments ?? [])
  ];

  return mapNormalizedLedgerToCanonicalFacts({
    context,
    company: {
      legalName: input.resources.companyInfo.resource.LegalName ?? input.resources.companyInfo.resource.CompanyName ?? input.context.realmId,
      displayName: input.resources.companyInfo.resource.CompanyName ?? input.resources.companyInfo.resource.LegalName ?? input.context.realmId,
      ...(input.resources.companyInfo.resource.FiscalYearStartMonth === undefined
        ? {}
        : { fiscalYearStartMonth: input.resources.companyInfo.resource.FiscalYearStartMonth })
    },
    accounts: input.resources.accounts.map((accountResource) => {
      assertQuickBooksResourceContext(input.context, accountResource);
      assertQuickBooksResourceId(accountResource, accountResource.resource.Id);
      return quickBooksAccountToNativeAccount(accountResource.resource);
    }),
    transactions: [
      ...ledgerTransactions.map((resource) => normalizedQuickBooksLedgerTransactionToNativeTransaction(input.context, resource)),
      ...journalTransactions
    ],
    parties: [
      ...parties,
      ...normalizedQuickBooksReferencedPartiesToCanonicalParties(context, partyReferenceTransactions, parties)
    ],
    items: normalizedQuickBooksItemsToCanonicalItems(context, input.resources.items ?? []),
    dimensions: normalizedQuickBooksDimensionsToCanonicalDimensions(context, [
      ...(input.resources.dimensions ?? []),
      ...(input.resources.classes ?? []),
      ...(input.resources.departments ?? [])
    ])
  });
}

function quickBooksJournalEntryToNativeTransaction(
  context: SourceAdapterContext,
  journalEntry: QuickBooksSdkJournalEntry
): NativeLedgerTransaction {
  const sourceUpdatedAt = journalEntry.MetaData?.LastUpdatedTime ?? context.latestSourceUpdatedAt;
  return {
    sourceTransactionId: journalEntry.Id,
    sourceTransactionType: "JournalEntry",
    transactionDate: journalEntry.TxnDate,
    ...(journalEntry.DocNumber === undefined ? {} : { transactionNumber: journalEntry.DocNumber }),
    ...(sourceUpdatedAt === undefined ? {} : { updatedAt: sourceUpdatedAt }),
    currencyCode: journalEntry.CurrencyRef?.value ?? context.defaultCurrencyCode,
    ...(journalEntry.PrivateNote === undefined ? {} : { memo: journalEntry.PrivateNote }),
    sourcePayloadRef:
      journalEntry.sourcePayloadRef ??
      quickBooksPayloadRef({
        context,
        sourceObjectType: "JournalEntry",
        sourceObjectId: journalEntry.Id,
        ...(sourceUpdatedAt === undefined ? {} : { sourceUpdatedAt }),
        preview: {
          realmId: context.sourceCompanyRef,
          docNumber: journalEntry.DocNumber ?? null,
          txnDate: journalEntry.TxnDate
        }
      }),
    lines: journalEntry.Line.map((line, index): NativeLedgerLine => {
      const accountSourceId = requiredRefValue(line.JournalEntryLineDetail.AccountRef, "JournalEntryLine.AccountRef");
      const lineNumber = line.LineNum ?? index + 1;
      const lineSourceId = quickBooksJournalEntryLineSourceId(line, index);
      const amount = decimalFromNumber(line.Amount);
      const dimensionRefs = quickBooksDimensionRefs(line.JournalEntryLineDetail);
      return {
        sourceLineId: lineSourceId,
        lineNumber,
        accountSourceId,
        ...(line.JournalEntryLineDetail.PostingType === "Debit" ? { debitAmount: amount } : { creditAmount: amount }),
        ...(line.Description === undefined ? {} : { description: line.Description }),
        ...(dimensionRefs.length === 0 ? {} : { dimensionRefs }),
        sourcePayloadRef:
          line.sourcePayloadRef ??
          quickBooksPayloadRef({
            context,
            sourceObjectType: "JournalEntryLine",
            sourceObjectId: `${journalEntry.Id}:${lineSourceId}`,
            ...(sourceUpdatedAt === undefined ? {} : { sourceUpdatedAt }),
            preview: {
              realmId: context.sourceCompanyRef,
              journalEntryId: journalEntry.Id,
              lineId: lineSourceId,
              postingType: line.JournalEntryLineDetail.PostingType
            }
          })
      };
    })
  };
}

function mapNormalizedLedgerToCanonicalFacts(input: NormalizedLedgerInput): CanonicalAccountingFactSet {
  const accounts = input.accounts.map((account): Account => accountFromNative(input.context, account));
  const accountIdBySourceId = new Map(accounts.map((account) => [account.sourceAccountId, account.accountId]));
  const transactions = input.transactions.map((transaction): AccountingTransaction => {
    const sourcePayloadRef = transaction.sourcePayloadRef ?? defaultPayloadRef(transaction.sourceTransactionType, transaction.sourceTransactionId, transaction.updatedAt);
    assertSafeSourcePayloadRef(sourcePayloadRef);
    return {
      tenantId: input.context.tenantId,
      sourceId: input.context.sourceId,
      transactionId: canonicalRecordId(input.context, "transaction", transaction.sourceTransactionId),
      sourceTransactionId: transaction.sourceTransactionId,
      sourceTransactionType: transaction.sourceTransactionType,
      ...(transaction.transactionNumber === undefined ? {} : { transactionNumber: transaction.transactionNumber }),
      transactionDate: transaction.transactionDate,
      ...(transaction.postedAt === undefined ? {} : { postedAt: transaction.postedAt }),
      ...(transaction.updatedAt === undefined ? {} : { updatedAt: transaction.updatedAt }),
      ...(transaction.partySourceId === undefined
        ? {}
        : { partyId: canonicalRecordId(input.context, "party", transaction.partySourceId) }),
      currencyCode: transaction.currencyCode ?? input.context.defaultCurrencyCode,
      ...(transaction.exchangeRate === undefined ? {} : { exchangeRate: transaction.exchangeRate }),
      status: "posted",
      ...(transaction.memo === undefined ? {} : { memo: transaction.memo }),
      sourcePayloadRef
    };
  });
  const transactionIdBySourceId = new Map(transactions.map((transaction) => [transaction.sourceTransactionId, transaction.transactionId]));
  const transactionLines = input.transactions.flatMap((transaction): TransactionLine[] =>
    transaction.lines.map((line): TransactionLine => {
      const transactionId = requiredMapValue(transactionIdBySourceId, transaction.sourceTransactionId, "transaction");
      const amounts = lineAmounts(line);
      const transactionLineId = canonicalRecordId(
        input.context,
        "transaction_line",
        nativeLineSourceKey(transaction, line)
      );
      return {
        tenantId: input.context.tenantId,
        sourceId: input.context.sourceId,
        transactionLineId,
        transactionId,
        lineNumber: line.lineNumber,
        accountId: requiredMapValue(accountIdBySourceId, line.accountSourceId, "account"),
        ...(line.partySourceId === undefined ? {} : { partyId: canonicalRecordId(input.context, "party", line.partySourceId) }),
        ...(line.itemSourceId === undefined ? {} : { itemId: canonicalRecordId(input.context, "item", line.itemSourceId) }),
        amount: formatMinor(amounts.debitMinor - amounts.creditMinor),
        ...(line.quantity === undefined ? {} : { quantity: line.quantity }),
        ...(line.unitAmount === undefined ? {} : { unitAmount: line.unitAmount }),
        ...(line.description === undefined ? {} : { description: line.description }),
        dimensionRefs: line.dimensionRefs ?? []
      };
    })
  );
  const lineIdBySourceKey = new Map(
    input.transactions.flatMap((transaction) =>
      transaction.lines.map((line) => [
        nativeLineSourceKey(transaction, line),
        canonicalRecordId(input.context, "transaction_line", nativeLineSourceKey(transaction, line))
      ])
    )
  );
  const postings = input.transactions.flatMap((transaction): LedgerPosting[] =>
    transaction.lines.map((line): LedgerPosting => {
      const sourceLineId = line.sourceLineId ?? String(line.lineNumber);
      const sourcePostingId = line.sourcePostingId ?? `${transaction.sourceTransactionId}:${sourceLineId}`;
      const amounts = lineAmounts(line);
      const sourcePayloadRef = line.sourcePayloadRef ?? defaultPayloadRef(`${transaction.sourceTransactionType}Line`, sourcePostingId, transaction.updatedAt);
      assertSafeSourcePayloadRef(sourcePayloadRef);
      const posting: LedgerPosting = {
        tenantId: input.context.tenantId,
        sourceId: input.context.sourceId,
        postingId: canonicalRecordId(input.context, "posting", sourcePostingId),
        sourcePostingId,
        transactionId: requiredMapValue(transactionIdBySourceId, transaction.sourceTransactionId, "transaction"),
        transactionLineId: requiredMapValue(lineIdBySourceKey, sourcePostingId, "transaction line"),
        accountId: requiredMapValue(accountIdBySourceId, line.accountSourceId, "account"),
        ...(line.partySourceId === undefined ? {} : { partyId: canonicalRecordId(input.context, "party", line.partySourceId) }),
        ...(line.itemSourceId === undefined ? {} : { itemId: canonicalRecordId(input.context, "item", line.itemSourceId) }),
        postingDate: line.postingDate ?? transaction.transactionDate,
        accountingBasis: input.context.accountingBasis,
        debitAmount: formatMinor(amounts.debitMinor),
        creditAmount: formatMinor(amounts.creditMinor),
        netAmount: formatMinor(amounts.debitMinor - amounts.creditMinor),
        currencyCode: transaction.currencyCode ?? input.context.defaultCurrencyCode,
        dimensionHash: createDimensionHash(line.dimensionRefs ?? []),
        dimensionRefs: line.dimensionRefs ?? [],
        sourcePayloadRef,
        importBatchId: input.context.importBatchId,
        checkpointId: input.context.checkpointId
      };
      assertLedgerPostingAmounts(posting);
      return posting;
    })
  );

  return {
    company: {
      tenantId: input.context.tenantId,
      companyId: input.context.companyId,
      legalName: input.company.legalName,
      displayName: input.company.displayName,
      baseCurrencyCode: input.context.defaultCurrencyCode,
      fiscalYearStartMonth: input.company.fiscalYearStartMonth ?? 1,
      providerEnvironment: input.context.providerEnvironment,
      sourceSystem: input.context.sourceSystem,
      sourceCompanyRef: input.context.sourceCompanyRef
    },
    source: {
      tenantId: input.context.tenantId,
      sourceId: input.context.sourceId,
      sourceSystem: input.context.sourceSystem,
      providerEnvironment: input.context.providerEnvironment,
      connectionRef: input.context.connectionRef,
      importBatchId: input.context.importBatchId,
      checkpointId: input.context.checkpointId,
      latestSyncedAt: input.context.importedAt,
      status: "active"
    },
    importBatch: {
      tenantId: input.context.tenantId,
      sourceId: input.context.sourceId,
      importBatchId: input.context.importBatchId,
      mode: "delta",
      status: "completed",
      startedAt: input.context.importedAt,
      completedAt: input.context.importedAt,
      sourceObjectCounts: sourceObjectCounts(input.accounts.length, input.transactions.length, postings.length)
    },
    checkpoint: {
      tenantId: input.context.tenantId,
      sourceId: input.context.sourceId,
      checkpointId: input.context.checkpointId,
      sourceObject: "ledger_postings",
      cursorKind: "updated_since",
      cursorValue: input.context.latestSourceUpdatedAt ?? input.context.importedAt,
      freshThrough: input.context.freshThrough ?? input.context.importedAt,
      latestSourceUpdatedAt: input.context.latestSourceUpdatedAt ?? input.context.importedAt,
      status: "current"
    },
    accounts,
    parties: input.parties ?? [],
    items: input.items ?? [],
    dimensions: input.dimensions ?? [],
    transactions,
    transactionLines,
    postings
  };
}

function normalizedQuickBooksLedgerTransactionToNativeTransaction(
  context: QuickBooksAdapterContext,
  resource: HandrailQuickBooksLedgerTransactionResource
): NativeLedgerTransaction {
  assertQuickBooksResourceContext(context, resource);
  assertQuickBooksResourceId(resource, resource.resource.sourceTransactionId);
  const transaction = resource.resource;
  const sourceUpdatedAt = transaction.sourceUpdatedAt ?? resource.sourceUpdatedAt ?? context.latestSourceUpdatedAt;
  // One provider line can expand into several posting-backed canonical lines.
  // Their database ordinal must be unique even though provider line provenance
  // remains shared; keep existing ordinals when no expansion is needed.
  const hasExpandedLines = transaction.lines.some((line) => line.postings.length > 1);
  let canonicalLineNumber = 0;

  return {
    sourceTransactionId: transaction.sourceTransactionId,
    sourceTransactionType: transaction.sourceTransactionType,
    transactionDate: transaction.transactionDate,
    ...(transaction.transactionNumber === undefined ? {} : { transactionNumber: transaction.transactionNumber }),
    ...(transaction.postedAt === undefined ? {} : { postedAt: transaction.postedAt }),
    ...(sourceUpdatedAt === undefined ? {} : { updatedAt: sourceUpdatedAt }),
    ...(transaction.partyRef === undefined ? {} : { partySourceId: transaction.partyRef.sourceObjectId }),
    currencyCode: transaction.currencyCode ?? context.defaultCurrencyCode,
    ...(transaction.exchangeRate === undefined ? {} : { exchangeRate: transaction.exchangeRate }),
    ...(transaction.memo === undefined ? {} : { memo: transaction.memo }),
    sourcePayloadRef:
      transaction.sourcePayloadRef ??
      resource.sourcePayloadRef ??
      quickBooksPayloadRef({
        context: {
          ...context,
          sourceSystem: "quickbooks",
          sourceCompanyRef: context.realmId,
          connectionRef: quickBooksConnectionRef(context)
        },
        sourceObjectType: transaction.sourceTransactionType,
        sourceObjectId: transaction.sourceTransactionId,
        ...(sourceUpdatedAt === undefined ? {} : { sourceUpdatedAt }),
        preview: {
          realmId: context.realmId,
          resourceType: transaction.sourceTransactionType,
          resourceId: transaction.sourceTransactionId,
          transactionDate: transaction.transactionDate
        }
      }),
    lines: transaction.lines.flatMap((line, lineIndex): NativeLedgerLine[] => {
      if (line.postings.length === 0) {
        throw new Error(
          `Normalized QuickBooks ${transaction.sourceTransactionType} line ${line.sourceLineId ?? String(line.lineNumber)} must include at least one posting`
        );
      }

      return line.postings.map((posting, postingIndex): NativeLedgerLine => {
        const dimensionRefs = normalizedQuickBooksDimensionRefs(posting.dimensionRefs ?? line.dimensionRefs);
        const partySourceId = posting.partyRef?.sourceObjectId ?? line.partyRef?.sourceObjectId ?? transaction.partyRef?.sourceObjectId;
        const itemSourceId = posting.itemRef?.sourceObjectId ?? line.itemRef?.sourceObjectId;
        const sourcePayloadRef = posting.sourcePayloadRef ?? line.sourcePayloadRef;
        const sourcePostingId = posting.sourcePostingId;
        return {
          sourceLineId: line.sourceLineId ?? `${String(lineIndex + 1)}:${String(postingIndex + 1)}`,
          sourcePostingId,
          lineNumber: hasExpandedLines ? ++canonicalLineNumber : line.lineNumber,
          accountSourceId: posting.accountRef.sourceObjectId,
          postingDate: posting.postingDate,
          ...nativeAmountsFromNormalizedPosting(posting, line),
          ...(partySourceId === undefined ? {} : { partySourceId }),
          ...(itemSourceId === undefined ? {} : { itemSourceId }),
          ...(line.quantity === undefined ? {} : { quantity: line.quantity }),
          ...(line.unitAmount === undefined ? {} : { unitAmount: line.unitAmount }),
          ...(line.description === undefined ? {} : { description: line.description }),
          ...(dimensionRefs.length === 0 ? {} : { dimensionRefs }),
          ...(sourcePayloadRef === undefined ? {} : { sourcePayloadRef })
        };
      });
    })
  };
}

function accountFromNative(context: SourceAdapterContext, account: NativeLedgerAccount): Account {
  return {
    tenantId: context.tenantId,
    sourceId: context.sourceId,
    accountId: canonicalRecordId(context, "account", account.sourceAccountId),
    sourceAccountId: account.sourceAccountId,
    ...(account.parentAccountSourceId === undefined
      ? {}
      : { parentAccountId: canonicalRecordId(context, "account", account.parentAccountSourceId) }),
    ...(account.accountNumber === undefined ? {} : { accountNumber: account.accountNumber }),
    name: account.name,
    type: account.type ?? account.classification,
    ...(account.subtype === undefined ? {} : { subtype: account.subtype }),
    classification: account.classification,
    ...(account.currencyCode === undefined ? {} : { currencyCode: account.currencyCode }),
    active: account.active ?? true
  };
}

function quickBooksAccountToNativeAccount(account: QuickBooksSdkAccount): NativeLedgerAccount {
  return {
    sourceAccountId: account.Id,
    ...(account.ParentRef?.value === undefined ? {} : { parentAccountSourceId: account.ParentRef.value }),
    name: account.Name,
    classification: quickBooksAccountClassification(account.AccountType, account.AccountSubType, account.Classification ?? account.classification),
    ...(account.AcctNum === undefined ? {} : { accountNumber: account.AcctNum }),
    type: account.AccountType,
    ...(account.AccountSubType === undefined ? {} : { subtype: account.AccountSubType }),
    active: account.Active ?? true,
    ...(account.CurrencyRef?.value === undefined ? {} : { currencyCode: account.CurrencyRef.value })
  };
}

function nativeLineSourceKey(transaction: NativeLedgerTransaction, line: NativeLedgerLine): string {
  return line.sourcePostingId ?? `${transaction.sourceTransactionId}:${line.sourceLineId ?? String(line.lineNumber)}`;
}

function nativeAmountsFromNormalizedPosting(
  posting: NormalizedQuickBooksLedgerPostingResource["resource"],
  line: NormalizedQuickBooksLedgerTransaction["lines"][number]
): Pick<NativeLedgerLine, "amount" | "creditAmount" | "debitAmount"> {
  if (posting.debitAmount !== undefined || posting.creditAmount !== undefined) {
    return {
      ...(posting.debitAmount === undefined ? {} : { debitAmount: posting.debitAmount }),
      ...(posting.creditAmount === undefined ? {} : { creditAmount: posting.creditAmount })
    };
  }
  if (posting.netAmount !== undefined) {
    return { amount: posting.netAmount };
  }
  if (line.amount !== undefined) {
    return { amount: line.amount };
  }
  throw new Error(`Normalized QuickBooks posting ${posting.sourcePostingId} must include debitAmount, creditAmount, netAmount, or line amount`);
}

function normalizedQuickBooksPartiesToCanonicalParties(
  context: SourceAdapterContext,
  resources: readonly (NormalizedQuickBooksPartyResource | NormalizedQuickBooksCustomerResource | NormalizedQuickBooksVendorResource)[]
): readonly Party[] {
  const seen = new Set<string>();
  const parties: Party[] = [];
  for (const resource of resources) {
    const party = resource.resource;
    const key = `${party.partyType}:${party.sourceObjectId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    parties.push({
      tenantId: context.tenantId,
      sourceId: context.sourceId,
      partyId: canonicalRecordId(context, "party", party.sourceObjectId),
      sourcePartyId: party.sourceObjectId,
      partyType: party.partyType,
      displayName: party.displayName ?? party.sourceObjectId,
      active: party.active ?? true
    });
  }
  return parties;
}

function normalizedQuickBooksReferencedPartiesToCanonicalParties(
  context: SourceAdapterContext,
  transactions: readonly HandrailQuickBooksLedgerTransactionResource[],
  importedParties: readonly Party[]
): readonly Party[] {
  const seen = new Set(importedParties.map((party) => party.sourcePartyId));
  const parties: Party[] = [];
  const addReference = (reference: NormalizedQuickBooksPartyRef | undefined): void => {
    if (reference === undefined || seen.has(reference.sourceObjectId)) {
      return;
    }
    seen.add(reference.sourceObjectId);
    parties.push({
      tenantId: context.tenantId,
      sourceId: context.sourceId,
      partyId: canonicalRecordId(context, "party", reference.sourceObjectId),
      sourcePartyId: reference.sourceObjectId,
      partyType: reference.partyType,
      displayName: reference.displayName ?? reference.sourceObjectId,
      // QuickBooks may reference historical employees or inactive entities that
      // are absent from the Customer/Vendor master resources. Preserve the
      // reference without presenting the derived party as an active master.
      active: false
    });
  };

  for (const transaction of transactions) {
    addReference(transaction.resource.partyRef);
    for (const line of transaction.resource.lines) {
      addReference(line.partyRef);
      for (const posting of line.postings) {
        addReference(posting.partyRef);
      }
    }
  }

  return parties;
}

function normalizedQuickBooksItemsToCanonicalItems(
  context: SourceAdapterContext,
  resources: readonly NormalizedQuickBooksItemResource[]
): readonly Item[] {
  return resources.map((resource): Item => {
    const item = resource.resource;
    return {
      tenantId: context.tenantId,
      sourceId: context.sourceId,
      itemId: canonicalRecordId(context, "item", item.sourceObjectId),
      sourceItemId: item.sourceObjectId,
      itemType: item.itemType ?? "other",
      name: item.name,
      ...(item.incomeAccountRef === undefined ? {} : { incomeAccountId: canonicalRecordId(context, "account", item.incomeAccountRef.sourceObjectId) }),
      ...(item.expenseAccountRef === undefined ? {} : { expenseAccountId: canonicalRecordId(context, "account", item.expenseAccountRef.sourceObjectId) }),
      ...(item.assetAccountRef === undefined ? {} : { assetAccountId: canonicalRecordId(context, "account", item.assetAccountRef.sourceObjectId) }),
      active: item.active ?? true
    };
  });
}

function normalizedQuickBooksDimensionsToCanonicalDimensions(
  context: SourceAdapterContext,
  resources: readonly (NormalizedQuickBooksDimensionResource | NormalizedQuickBooksClassResource | NormalizedQuickBooksDepartmentResource)[]
): readonly AccountingDimension[] {
  const seen = new Set<string>();
  const dimensions: AccountingDimension[] = [];
  for (const resource of resources) {
    const dimension = resource.resource;
    const key = `${dimension.dimensionKind}:${dimension.sourceObjectId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    dimensions.push({
      tenantId: context.tenantId,
      sourceId: context.sourceId,
      dimensionId: canonicalRecordId(context, "dimension", key),
      dimensionKind: dimension.dimensionKind,
      sourceDimensionId: dimension.sourceObjectId,
      name: dimension.name,
      ...(dimension.parentDimensionRef === undefined
        ? {}
        : { parentDimensionId: canonicalRecordId(context, "dimension", `${dimension.parentDimensionRef.dimensionKind}:${dimension.parentDimensionRef.sourceObjectId}`) }),
      active: dimension.active ?? true
    });
  }
  return dimensions;
}

const QUICKBOOKS_COGS_ACCOUNT_SUBTYPES = new Set([
  "costofgoodssold",
  "equipmentrentalcos",
  "othercostsofservicecos",
  "shippingfreightdeliverycos",
  "suppliesmaterialscogs"
]);

const QUICKBOOKS_ACCOUNT_CLASSIFICATIONS: ReadonlySet<AccountClassification> = new Set([
  "asset",
  "cost_of_goods_sold",
  "equity",
  "expense",
  "income",
  "liability",
  "other_expense",
  "other_income"
]);

function quickBooksAccountClassification(
  accountType: string,
  accountSubType: string | undefined,
  classification: AccountClassification | undefined
): AccountClassification {
  const normalized = normalizeQuickBooksAccountKind(accountType);
  const normalizedSubType = accountSubType === undefined ? undefined : normalizeQuickBooksAccountKind(accountSubType);
  if (normalized === "costofgoodssold" || normalizedSubType !== undefined && QUICKBOOKS_COGS_ACCOUNT_SUBTYPES.has(normalizedSubType)) {
    return "cost_of_goods_sold";
  }

  if (classification !== undefined && QUICKBOOKS_ACCOUNT_CLASSIFICATIONS.has(classification)) {
    return classification;
  }

  if (["bank", "accountsreceivable", "othercurrentasset", "fixedasset", "otherasset"].includes(normalized)) {
    return "asset";
  }
  if (["accountspayable", "creditcard", "longtermliability", "othercurrentliability"].includes(normalized)) {
    return "liability";
  }
  if (normalized === "equity") {
    return "equity";
  }
  if (normalized === "income") {
    return "income";
  }
  if (normalized === "otherincome") {
    return "other_income";
  }
  if (normalized === "otherexpense") {
    return "other_expense";
  }
  return "expense";
}

function normalizeQuickBooksAccountKind(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

function normalizedQuickBooksDimensionRefs(refs: readonly NormalizedQuickBooksDimensionRef[] | undefined): DimensionRef[] {
  return (refs ?? []).map((ref) => ({
    dimensionKind: ref.dimensionKind,
    sourceDimensionId: ref.sourceObjectId,
    ...(ref.displayName === undefined ? {} : { name: ref.displayName })
  }));
}

function quickBooksDimensionRefs(detail: QuickBooksSdkJournalEntryLineDetail): DimensionRef[] {
  const refs: DimensionRef[] = [];
  appendQuickBooksDimensionRef(refs, "class", detail.ClassRef);
  appendQuickBooksDimensionRef(refs, "department", detail.DepartmentRef);
  return refs;
}

function assertQuickBooksResourceContext(
  context: QuickBooksAdapterContext,
  resource: HandrailQuickBooksNormalizedResource<string, unknown>
): void {
  if (resource.providerEnvironment !== context.providerEnvironment) {
    throw new Error(
      `QuickBooks ${resource.resourceType} providerEnvironment ${resource.providerEnvironment} does not match context ${context.providerEnvironment}`
    );
  }
  if (resource.realmId !== context.realmId) {
    throw new Error(`QuickBooks ${resource.resourceType} realmId ${resource.realmId} does not match context ${context.realmId}`);
  }
  if (resource.sourcePayloadRef !== undefined) {
    assertSafeSourcePayloadRef(resource.sourcePayloadRef);
  }
}

function assertQuickBooksResourceId(resource: HandrailQuickBooksNormalizedResource<string, unknown>, expectedResourceId: string): void {
  if (resource.resourceId !== expectedResourceId) {
    throw new Error(`QuickBooks ${resource.resourceType} resourceId ${resource.resourceId} does not match ${expectedResourceId}`);
  }
}

function checkedSourcePayloadRef(sourcePayloadRef: SafeSourcePayloadRef): SafeSourcePayloadRef {
  assertSafeSourcePayloadRef(sourcePayloadRef);
  return sourcePayloadRef;
}

function quickBooksJournalEntryLineSourceId(line: Pick<QuickBooksSdkJournalEntryLine, "Id" | "LineNum">, index: number): string {
  return line.Id ?? String(line.LineNum ?? index + 1);
}

function appendQuickBooksDimensionRef(refs: DimensionRef[], dimensionKind: string, ref: QuickBooksSdkRef | undefined): void {
  if (ref?.value === undefined) {
    return;
  }
  refs.push({
    dimensionKind,
    sourceDimensionId: ref.value,
    ...(ref.name === undefined ? {} : { name: ref.name })
  });
}

function quickBooksPayloadRef(input: {
  readonly context: SourceAdapterContext;
  readonly sourceObjectType: string;
  readonly sourceObjectId: string;
  readonly sourceUpdatedAt?: IsoDateTime;
  readonly preview: JsonValue;
}): SafeSourcePayloadRef {
  const ref: SafeSourcePayloadRef = {
    sourceObjectType: input.sourceObjectType,
    sourceObjectId: input.sourceObjectId,
    ...(input.sourceUpdatedAt === undefined ? {} : { sourceUpdatedAt: input.sourceUpdatedAt }),
    storageRef: `quickbooks://${input.context.providerEnvironment}/realm/${input.context.sourceCompanyRef}/${input.sourceObjectType}/${input.sourceObjectId}`,
    preview: input.preview
  };
  assertSafeSourcePayloadRef(ref);
  return ref;
}

function defaultPayloadRef(sourceObjectType: string, sourceObjectId: string, sourceUpdatedAt: IsoDateTime | undefined): SafeSourcePayloadRef {
  return {
    sourceObjectType,
    sourceObjectId,
    ...(sourceUpdatedAt === undefined ? {} : { sourceUpdatedAt })
  };
}

function quickBooksConnectionRef(context: QuickBooksAdapterContext): string {
  const serviceEnvironment = context.runtimeConfig?.serviceEnvironment ?? "production";
  return `handrail-quickbooks-sdk:${serviceEnvironment}:${context.providerEnvironment}:realm:${context.realmId}`;
}

function requiredRefValue(ref: QuickBooksSdkRef, fieldName: string): string {
  if (ref.value === undefined || ref.value.length === 0) {
    throw new Error(`${fieldName} is required`);
  }
  return ref.value;
}

function requiredMapValue(map: ReadonlyMap<string, string>, key: string, label: string): string {
  const value = map.get(key);
  if (value === undefined) {
    throw new Error(`Unknown ${label} source id: ${key}`);
  }
  return value;
}

function lineAmounts(line: NativeLedgerLine): { readonly debitMinor: bigint; readonly creditMinor: bigint } {
  if (line.debitAmount !== undefined || line.creditAmount !== undefined) {
    const debitMinor = parseMoney(line.debitAmount ?? "0.00");
    const creditMinor = parseMoney(line.creditAmount ?? "0.00");
    if (debitMinor < 0n || creditMinor < 0n) {
      throw new Error("debitAmount and creditAmount must be nonnegative");
    }
    return { debitMinor, creditMinor };
  }

  if (line.amount === undefined) {
    throw new Error("Native ledger line requires amount or debit/credit amounts");
  }

  const amountMinor = parseMoney(line.amount);
  return amountMinor >= 0n ? { debitMinor: amountMinor, creditMinor: 0n } : { debitMinor: 0n, creditMinor: -amountMinor };
}

function parseMoney(value: DecimalString): bigint {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new Error(`Decimal value must have at most two fractional digits: ${value}`);
  }
  const sign = match[1] === "-" ? -1n : 1n;
  const whole = BigInt(match[2]);
  const fraction = BigInt((match[3] ?? "").padEnd(2, "0"));
  return sign * (whole * 100n + fraction);
}

function formatMinor(value: bigint): DecimalString {
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  const whole = absolute / 100n;
  const fraction = absolute % 100n;
  return `${sign}${whole.toString()}.${fraction.toString().padStart(2, "0")}`;
}

function decimalFromNumber(value: number | DecimalString): DecimalString {
  if (typeof value === "string") {
    return value;
  }
  if (!Number.isFinite(value)) {
    throw new Error("QuickBooks amount must be finite");
  }
  return value.toFixed(2);
}

function canonicalRecordId(context: SourceAdapterContext, kind: string, sourceObjectId: string): string {
  const digest = createHash("sha256")
    .update([context.tenantId, context.sourceId, context.sourceSystem, context.providerEnvironment, kind, sourceObjectId].join(":"))
    .digest("hex")
    .slice(0, 16);
  return `${kind}_${digest}`;
}

function sourceObjectCounts(accounts: number, transactions: number, postings: number): JsonValue {
  return {
    accounts,
    transactions,
    postings
  };
}
