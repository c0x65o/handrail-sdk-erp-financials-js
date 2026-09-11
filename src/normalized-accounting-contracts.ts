import type {
  AccountClassification,
  AccountingBasis,
  AccountingSourceSystem,
  CursorKind,
  DecimalString,
  ImportBatchId,
  ImportBatchMode,
  ImportBatchStatus,
  IsoCurrencyCode,
  IsoDate,
  IsoDateTime,
  ItemType,
  JsonValue,
  PartyType,
  ProviderEnvironment,
  ReconciliationStatus,
  SafeSourcePayloadRef,
  SourceId,
  SyncCheckpointId,
  SyncCheckpointStatus,
  TenantId
} from "./canonical-model.js";
import type { SourceRecordDisposition } from "./source-record-dispositions.js";

export type NormalizedAccountingSyncMode = "full" | "incremental" | "backfill" | "reprocess";

export type NormalizedAccountingResourceCounts = Readonly<Record<string, number>>;

export type NormalizedAccountingSyncIssueSeverity = "info" | "warning" | "error";

export type NormalizedAccountingSyncIssue = {
  readonly code: string;
  readonly message: string;
  readonly severity: NormalizedAccountingSyncIssueSeverity;
  readonly resourceType?: string;
  readonly resourceId?: string;
  readonly sourcePayloadRef?: SafeSourcePayloadRef;
};

export type NormalizedAccountingSyncIssueSummary = {
  readonly count: number;
  readonly items?: readonly NormalizedAccountingSyncIssue[];
};

export type NormalizedAccountingSyncCursor = {
  readonly cursorKind: CursorKind;
  readonly cursorValue: string;
  readonly sourceObject?: string;
};

export type NormalizedAccountingSyncIdempotencyKeys = {
  readonly syncRequestKey: string;
  readonly importBatchId: ImportBatchId;
  readonly checkpointId: SyncCheckpointId;
  readonly resourceSetKey?: string;
};

export type NormalizedAccountingSourceIdentity = {
  readonly tenantId: TenantId;
  readonly sourceId: SourceId;
  readonly sourceSystem: AccountingSourceSystem;
  readonly providerEnvironment: ProviderEnvironment;
  readonly sourceCompanyRef: string;
};

export type NormalizedQuickBooksProviderEnvironment = Extract<ProviderEnvironment, "sandbox" | "production">;

export type NormalizedQuickBooksSourceIdentity = Omit<
  NormalizedAccountingSourceIdentity,
  "sourceSystem" | "providerEnvironment" | "sourceCompanyRef"
> & {
  readonly sourceSystem: "quickbooks";
  readonly providerEnvironment: NormalizedQuickBooksProviderEnvironment;
  readonly realmId: string;
  readonly sourceCompanyRef: string;
};

export type NormalizedQuickBooksServiceEnvironment = "local" | "dev" | "staging" | "production";

export type NormalizedQuickBooksServiceHealthStatus = "ready" | "degraded" | "unavailable";

export type NormalizedQuickBooksServiceAvailability = "available" | "degraded" | "unavailable";

export type NormalizedQuickBooksServiceHealthCapabilityStatus = "ready" | "degraded" | "unavailable";

export type NormalizedQuickBooksServiceHealthCapability = {
  readonly status: NormalizedQuickBooksServiceHealthCapabilityStatus;
  readonly available: boolean;
  readonly message?: string;
};

export type NormalizedQuickBooksServiceHealthCapabilities = {
  readonly fullSync: NormalizedQuickBooksServiceHealthCapability;
  readonly incrementalSync: NormalizedQuickBooksServiceHealthCapability;
  readonly providerReports: NormalizedQuickBooksServiceHealthCapability;
  readonly sandbox: NormalizedQuickBooksServiceHealthCapability;
  readonly replay: NormalizedQuickBooksServiceHealthCapability;
};

export type NormalizedQuickBooksServiceHealthCheckpointStatus =
  | SyncCheckpointStatus
  | "missing"
  | "unknown";

export type NormalizedQuickBooksServiceHealthCheckpoint = {
  readonly checkpointId?: SyncCheckpointId;
  readonly status: NormalizedQuickBooksServiceHealthCheckpointStatus;
  readonly sourceObject?: string;
  readonly cursorKind?: CursorKind;
  readonly cursorValue?: string;
  readonly sourceFreshThrough?: IsoDateTime;
  readonly importedThrough?: IsoDateTime;
  readonly freshThrough?: IsoDateTime;
  readonly latestSourceUpdatedAt?: IsoDateTime;
};

export type NormalizedQuickBooksServiceHealthIssueSeverity = "info" | "warning" | "error";

export type NormalizedQuickBooksServiceHealthIssue = {
  readonly code: string;
  readonly severity: NormalizedQuickBooksServiceHealthIssueSeverity;
  readonly message: string;
};

export type NormalizedQuickBooksServiceHealthProbeRequest = {
  readonly sourceIdentity: NormalizedQuickBooksSourceIdentity;
  readonly providerMode?: NormalizedQuickBooksProviderEnvironment;
  readonly serviceEnvironment?: NormalizedQuickBooksServiceEnvironment;
  readonly checkpointId?: SyncCheckpointId;
  readonly requestedAt?: IsoDateTime;
};

export type NormalizedQuickBooksServiceHealthProbeResponseEnvelope = {
  readonly sourceIdentity: NormalizedQuickBooksSourceIdentity;
  readonly providerEnvironment: NormalizedQuickBooksProviderEnvironment;
  readonly providerMode: NormalizedQuickBooksProviderEnvironment;
  readonly serviceEnvironment?: NormalizedQuickBooksServiceEnvironment;
  readonly status: NormalizedQuickBooksServiceHealthStatus;
  readonly serviceAvailability: NormalizedQuickBooksServiceAvailability;
  readonly capabilities: NormalizedQuickBooksServiceHealthCapabilities;
  readonly checkpoint: NormalizedQuickBooksServiceHealthCheckpoint;
  readonly requestedAt?: IsoDateTime;
  readonly checkedAt?: IsoDateTime;
  readonly message?: string;
  readonly issues?: readonly NormalizedQuickBooksServiceHealthIssue[];
};

export type NormalizedAccountingImportBatchMetadata = {
  readonly importBatchId: ImportBatchId;
  readonly syncMode: NormalizedAccountingSyncMode;
  readonly mode?: ImportBatchMode;
  readonly status?: ImportBatchStatus;
  readonly startedAt?: IsoDateTime;
  readonly completedAt?: IsoDateTime;
  readonly sourceObjectCounts?: JsonValue;
  readonly warningSummary?: JsonValue;
  readonly errorSummary?: JsonValue;
};

export type NormalizedAccountingSyncCheckpointMetadata = {
  readonly checkpointId: SyncCheckpointId;
  readonly sourceObject: string;
  readonly cursorKind: CursorKind;
  readonly cursorValue: string;
  readonly sourceFreshThrough?: IsoDateTime;
  readonly importedThrough?: IsoDateTime;
  readonly freshThrough?: IsoDateTime;
  readonly latestSourceUpdatedAt?: IsoDateTime;
  readonly status?: SyncCheckpointStatus;
};

export type NormalizedAccountingSyncEnvelopeFields<Mode extends NormalizedAccountingSyncMode = NormalizedAccountingSyncMode> = {
  readonly syncMode: Mode;
  readonly importBatchId: ImportBatchId;
  readonly checkpointId: SyncCheckpointId;
  readonly cursorKind: CursorKind;
  readonly cursorValue: string;
  readonly freshThrough?: IsoDateTime;
  readonly latestSourceUpdatedAt?: IsoDateTime;
  readonly resourceCounts: NormalizedAccountingResourceCounts;
  readonly warningSummary?: NormalizedAccountingSyncIssueSummary;
  readonly errorSummary?: NormalizedAccountingSyncIssueSummary;
  readonly recordDispositions?: readonly SourceRecordDisposition[];
  readonly idempotencyKey: string;
  readonly idempotencyKeys: NormalizedAccountingSyncIdempotencyKeys;
};

export type NormalizedAccountingBackfillWindow = {
  readonly sourceUpdatedFrom?: IsoDateTime;
  readonly sourceUpdatedTo?: IsoDateTime;
  readonly transactionDateFrom?: IsoDate;
  readonly transactionDateTo?: IsoDate;
};

export type NormalizedAccountingPageRequest = NormalizedAccountingSyncCursor & {
  readonly pageSize?: number;
};

export type NormalizedAccountingPageResponse = {
  readonly hasMore: boolean;
  readonly nextCursor?: NormalizedAccountingSyncCursor;
  readonly previousCursor?: NormalizedAccountingSyncCursor;
  readonly pageSize?: number;
  readonly pageResourceCounts: NormalizedAccountingResourceCounts;
};

export type NormalizedAccountingSyncRequestEnvelope<
  Identity extends NormalizedAccountingSourceIdentity = NormalizedAccountingSourceIdentity,
  Mode extends NormalizedAccountingSyncMode = NormalizedAccountingSyncMode
> = NormalizedAccountingSyncEnvelopeFields<Mode> & {
  readonly sourceIdentity: Identity;
  readonly requestedAt?: IsoDateTime;
  readonly requestedResourceTypes?: readonly string[];
  readonly page?: NormalizedAccountingPageRequest;
};

export type NormalizedAccountingFullSyncRequestEnvelope<
  Identity extends NormalizedAccountingSourceIdentity = NormalizedAccountingSourceIdentity
> = NormalizedAccountingSyncRequestEnvelope<Identity, "full"> & {
  readonly cursorKind: "full_scan";
};

export type NormalizedAccountingIncrementalSyncRequestEnvelope<
  Identity extends NormalizedAccountingSourceIdentity = NormalizedAccountingSourceIdentity
> = NormalizedAccountingSyncRequestEnvelope<Identity, "incremental"> & {
  readonly cursorKind: Extract<CursorKind, "updated_since" | "high_watermark">;
};

export type NormalizedAccountingBackfillSyncRequestEnvelope<
  Identity extends NormalizedAccountingSourceIdentity = NormalizedAccountingSourceIdentity
> = NormalizedAccountingSyncRequestEnvelope<Identity, "backfill"> & {
  readonly backfillWindow?: NormalizedAccountingBackfillWindow;
};

export type NormalizedAccountingReprocessSyncRequestEnvelope<
  Identity extends NormalizedAccountingSourceIdentity = NormalizedAccountingSourceIdentity
> = NormalizedAccountingSyncRequestEnvelope<Identity, "reprocess"> & {
  readonly reprocessImportBatchId?: ImportBatchId;
  readonly reprocessCheckpointId?: SyncCheckpointId;
  readonly resourceIds?: readonly string[];
};

export type NormalizedAccountingPaginationRequestEnvelope<
  Identity extends NormalizedAccountingSourceIdentity = NormalizedAccountingSourceIdentity,
  Mode extends NormalizedAccountingSyncMode = NormalizedAccountingSyncMode
> = NormalizedAccountingSyncRequestEnvelope<Identity, Mode> & {
  readonly cursorKind: "page_token";
  readonly page: NormalizedAccountingPageRequest & {
    readonly cursorKind: "page_token";
  };
};

export type NormalizedAccountingCheckpointResumeRequestEnvelope<
  Identity extends NormalizedAccountingSourceIdentity = NormalizedAccountingSourceIdentity,
  Mode extends Exclude<NormalizedAccountingSyncMode, "full"> = Exclude<NormalizedAccountingSyncMode, "full">
> = NormalizedAccountingSyncRequestEnvelope<Identity, Mode> & {
  readonly resumeFromCheckpointId: SyncCheckpointId;
};

export type NormalizedAccountingSyncResponseStatus =
  | "accepted"
  | ImportBatchStatus;

export type NormalizedAccountingSyncResponseEnvelope<
  Identity extends NormalizedAccountingSourceIdentity = NormalizedAccountingSourceIdentity,
  Resources = unknown,
  Mode extends NormalizedAccountingSyncMode = NormalizedAccountingSyncMode
> = NormalizedAccountingSyncEnvelopeFields<Mode> & {
  readonly sourceIdentity: Identity;
  readonly providerEnvironment: Identity["providerEnvironment"];
  readonly status: NormalizedAccountingSyncResponseStatus;
  readonly sourceFreshThrough?: IsoDateTime;
  readonly importedThrough?: IsoDateTime;
  readonly importBatch?: NormalizedAccountingImportBatchMetadata;
  readonly checkpoint?: NormalizedAccountingSyncCheckpointMetadata;
  readonly resources: Resources;
  readonly pagination?: NormalizedAccountingPageResponse;
  readonly acceptedAt?: IsoDateTime;
  readonly completedAt?: IsoDateTime;
};

export type NormalizedAccountingFullSyncResponseEnvelope<
  Identity extends NormalizedAccountingSourceIdentity = NormalizedAccountingSourceIdentity,
  Resources = unknown
> = NormalizedAccountingSyncResponseEnvelope<Identity, Resources, "full"> & {
  readonly cursorKind: "full_scan";
};

export type NormalizedAccountingIncrementalSyncResponseEnvelope<
  Identity extends NormalizedAccountingSourceIdentity = NormalizedAccountingSourceIdentity,
  Resources = unknown
> = NormalizedAccountingSyncResponseEnvelope<Identity, Resources, "incremental"> & {
  readonly cursorKind: Extract<CursorKind, "updated_since" | "high_watermark">;
};

export type NormalizedAccountingBackfillSyncResponseEnvelope<
  Identity extends NormalizedAccountingSourceIdentity = NormalizedAccountingSourceIdentity,
  Resources = unknown
> = NormalizedAccountingSyncResponseEnvelope<Identity, Resources, "backfill">;

export type NormalizedAccountingReprocessSyncResponseEnvelope<
  Identity extends NormalizedAccountingSourceIdentity = NormalizedAccountingSourceIdentity,
  Resources = unknown
> = NormalizedAccountingSyncResponseEnvelope<Identity, Resources, "reprocess">;

export type NormalizedAccountingPaginationResponseEnvelope<
  Identity extends NormalizedAccountingSourceIdentity = NormalizedAccountingSourceIdentity,
  Resources = unknown,
  Mode extends NormalizedAccountingSyncMode = NormalizedAccountingSyncMode
> = NormalizedAccountingSyncResponseEnvelope<Identity, Resources, Mode> & {
  readonly cursorKind: "page_token";
  readonly pagination: NormalizedAccountingPageResponse;
};

export type NormalizedAccountingSafeSourceRef = SafeSourcePayloadRef;

export type NormalizedAccountingSyncResourceAction = "changed" | "deleted" | "voided" | "skipped";

export type NormalizedQuickBooksRef = {
  readonly sourceObjectId: string;
  readonly displayName?: string;
  readonly sourcePayloadRef?: NormalizedAccountingSafeSourceRef;
};

export type NormalizedQuickBooksPartyRef = NormalizedQuickBooksRef & {
  readonly partyType: PartyType;
};

export type NormalizedQuickBooksCustomerRef = NormalizedQuickBooksPartyRef & {
  readonly partyType: "customer";
};

export type NormalizedQuickBooksVendorRef = NormalizedQuickBooksPartyRef & {
  readonly partyType: "vendor";
};

export type NormalizedQuickBooksItemRef = NormalizedQuickBooksRef & {
  readonly itemType?: ItemType;
};

export type NormalizedQuickBooksDimensionRef = NormalizedQuickBooksRef & {
  readonly dimensionKind: "class" | "department" | (string & {});
};

export type NormalizedQuickBooksClassRef = NormalizedQuickBooksDimensionRef & {
  readonly dimensionKind: "class";
};

export type NormalizedQuickBooksDepartmentRef = NormalizedQuickBooksDimensionRef & {
  readonly dimensionKind: "department";
};

export type NormalizedQuickBooksCompanyInfo = {
  readonly companyName?: string;
  readonly legalName?: string;
  readonly baseCurrencyCode?: IsoCurrencyCode;
  readonly fiscalYearStartMonth?: number;
};

export type NormalizedQuickBooksAccount = {
  readonly sourceAccountId: string;
  readonly name: string;
  readonly accountNumber?: string;
  readonly accountType: string;
  readonly accountSubType?: string;
  readonly classification?: AccountClassification;
  readonly parentAccountRef?: NormalizedQuickBooksRef;
  readonly active?: boolean;
  readonly currencyCode?: IsoCurrencyCode;
  readonly sourceUpdatedAt?: IsoDateTime;
  readonly sourcePayloadRef?: NormalizedAccountingSafeSourceRef;
};

export type NormalizedQuickBooksParty = NormalizedQuickBooksPartyRef & {
  readonly active?: boolean;
  readonly sourceUpdatedAt?: IsoDateTime;
};

export type NormalizedQuickBooksItem = NormalizedQuickBooksItemRef & {
  readonly name: string;
  readonly incomeAccountRef?: NormalizedQuickBooksRef;
  readonly expenseAccountRef?: NormalizedQuickBooksRef;
  readonly assetAccountRef?: NormalizedQuickBooksRef;
  readonly active?: boolean;
  readonly sourceUpdatedAt?: IsoDateTime;
};

export type NormalizedQuickBooksDimension = NormalizedQuickBooksDimensionRef & {
  readonly name: string;
  readonly parentDimensionRef?: NormalizedQuickBooksDimensionRef;
  readonly active?: boolean;
  readonly sourceUpdatedAt?: IsoDateTime;
};

export type NormalizedQuickBooksLedgerPosting = {
  readonly sourcePostingId: string;
  readonly accountRef: NormalizedQuickBooksRef;
  readonly postingDate: IsoDate;
  readonly accountingBasis: AccountingBasis;
  readonly debitAmount?: DecimalString;
  readonly creditAmount?: DecimalString;
  readonly netAmount?: DecimalString;
  readonly currencyCode?: IsoCurrencyCode;
  readonly partyRef?: NormalizedQuickBooksPartyRef;
  readonly itemRef?: NormalizedQuickBooksItemRef;
  readonly dimensionRefs?: readonly NormalizedQuickBooksDimensionRef[];
  readonly sourcePayloadRef?: NormalizedAccountingSafeSourceRef;
};

export type NormalizedQuickBooksLinkedTransaction = {
  readonly sourceTransactionId: string;
  readonly sourceTransactionType?: string;
  readonly sourceLineId?: string;
};

export type NormalizedQuickBooksLedgerLine = {
  readonly sourceLineId?: string;
  readonly lineNumber: number;
  /** QuickBooks Line.DetailType, retained so provider-only subtotal/group rows
   * can be distinguished from commercial document detail. */
  readonly detailType?: string;
  readonly description?: string;
  readonly amount?: DecimalString;
  /** Provider document-line amount before ledger polarity/offset derivation. */
  readonly sourceAmount?: DecimalString;
  readonly sourceQuantity?: DecimalString;
  readonly sourceUnitAmount?: DecimalString;
  readonly taxCode?: string;
  readonly quantity?: DecimalString;
  readonly unitAmount?: DecimalString;
  readonly accountRef?: NormalizedQuickBooksRef;
  readonly partyRef?: NormalizedQuickBooksPartyRef;
  readonly itemRef?: NormalizedQuickBooksItemRef;
  readonly dimensionRefs?: readonly NormalizedQuickBooksDimensionRef[];
  readonly linkedTransactions?: readonly NormalizedQuickBooksLinkedTransaction[];
  readonly postings: readonly NormalizedQuickBooksLedgerPosting[];
  readonly sourcePayloadRef?: NormalizedAccountingSafeSourceRef;
};

export type NormalizedQuickBooksLedgerTransaction = {
  readonly totalTax?: DecimalString;
  readonly taxCalculation?: string;
  readonly sourceTransactionId: string;
  readonly sourceTransactionType: string;
  readonly transactionDate: IsoDate;
  readonly transactionNumber?: string;
  readonly dueDate?: IsoDate;
  readonly totalAmount?: DecimalString;
  readonly openAmount?: DecimalString;
  readonly unappliedAmount?: DecimalString;
  readonly emailStatus?: string;
  readonly printStatus?: string;
  readonly postedAt?: IsoDateTime;
  readonly sourceUpdatedAt?: IsoDateTime;
  readonly sourceRevision?: string;
  readonly partyRef?: NormalizedQuickBooksPartyRef;
  readonly currencyCode?: IsoCurrencyCode;
  readonly exchangeRate?: DecimalString;
  readonly memo?: string;
  readonly lines: readonly NormalizedQuickBooksLedgerLine[];
  readonly sourcePayloadRef?: NormalizedAccountingSafeSourceRef;
};

export type NormalizedQuickBooksLedgerEntry = NormalizedQuickBooksLedgerTransaction & {
  readonly sourceTransactionType: "JournalEntry";
};

export type NormalizedQuickBooksProviderReportRef = {
  readonly provider: "quickbooks";
  readonly providerEnvironment: NormalizedQuickBooksProviderEnvironment;
  readonly realmId: string;
  readonly reportName: NormalizedQuickBooksProviderReportName;
  readonly accountingBasis?: AccountingBasis;
  readonly periodStart?: IsoDate;
  readonly periodEnd?: IsoDate;
  readonly sourceUpdatedAt?: IsoDateTime;
  readonly sourcePayloadRef: NormalizedAccountingSafeSourceRef;
};

export type NormalizedQuickBooksProviderReportName =
  | "profit_and_loss"
  | "balance_sheet"
  | "trial_balance"
  | "cash_flow";

export type NormalizedQuickBooksProviderReportSupportStatus =
  | "supported"
  | "unsupported";

export type NormalizedQuickBooksProviderReportUnsupportedReason =
  | "quickbooks_cash_flow_parity_report_not_supported"
  | "quickbooks_provider_report_unavailable";

export type NormalizedQuickBooksProviderReportTotal = {
  readonly totalKey: string;
  readonly label?: string;
  readonly amount: DecimalString;
  readonly currencyCode?: IsoCurrencyCode;
  readonly sourceUpdatedAt?: IsoDateTime;
  readonly drilldownRef?: NormalizedAccountingSafeSourceRef;
};

/**
 * Per-account amount reported by the provider (QuickBooks) for account-level
 * reconciliation. `amount` is the signed net balance (debits positive,
 * credits negative) as presented by the provider report.
 */
export type NormalizedQuickBooksProviderReportAccountTotal = {
  readonly accountSourceId: string;
  readonly label?: string;
  readonly amount: DecimalString;
  readonly currencyCode?: IsoCurrencyCode;
};

export type NormalizedQuickBooksCanonicalReportTotal = {
  readonly totalKey: string;
  readonly amount: DecimalString;
  readonly currencyCode?: IsoCurrencyCode;
};

export type NormalizedQuickBooksProviderReportRequestEnvelope = {
  readonly sourceIdentity: NormalizedQuickBooksSourceIdentity;
  readonly reportName: NormalizedQuickBooksProviderReportName;
  readonly accountingBasis: AccountingBasis;
  readonly currencyCode?: IsoCurrencyCode;
  readonly importBatchId?: ImportBatchId;
  readonly checkpointId?: SyncCheckpointId;
  readonly sourceFreshThrough?: IsoDateTime;
  readonly importedThrough?: IsoDateTime;
  readonly latestSourceUpdatedAt?: IsoDateTime;
  readonly periodStart?: IsoDate;
  readonly periodEnd?: IsoDate;
  readonly asOfDate?: IsoDate;
  readonly requestedAt?: IsoDateTime;
  readonly idempotencyKey?: string;
};

export type NormalizedQuickBooksProfitAndLossReportRequestEnvelope =
  NormalizedQuickBooksProviderReportRequestEnvelope & {
    readonly reportName: "profit_and_loss";
    readonly periodStart: IsoDate;
    readonly periodEnd: IsoDate;
  };

export type NormalizedQuickBooksBalanceSheetReportRequestEnvelope =
  NormalizedQuickBooksProviderReportRequestEnvelope & {
    readonly reportName: "balance_sheet";
    readonly asOfDate: IsoDate;
  };

export type NormalizedQuickBooksTrialBalanceReportRequestEnvelope =
  NormalizedQuickBooksProviderReportRequestEnvelope & {
    readonly reportName: "trial_balance";
    readonly periodStart: IsoDate;
    readonly periodEnd: IsoDate;
  };

export type NormalizedQuickBooksCashFlowParityReportRequestEnvelope =
  NormalizedQuickBooksProviderReportRequestEnvelope & {
    readonly reportName: "cash_flow";
    readonly periodStart: IsoDate;
    readonly periodEnd: IsoDate;
  };

export type NormalizedQuickBooksProviderReportResult = {
  readonly providerReportRef: NormalizedQuickBooksProviderReportRef;
  readonly importBatchId?: ImportBatchId;
  readonly checkpointId?: SyncCheckpointId;
  readonly sourceFreshThrough?: IsoDateTime;
  readonly importedThrough?: IsoDateTime;
  readonly latestSourceUpdatedAt?: IsoDateTime;
  readonly sourceUpdatedAt?: IsoDateTime;
  readonly generatedAt?: IsoDateTime;
  readonly totals: readonly NormalizedQuickBooksProviderReportTotal[];
  readonly accountTotals?: readonly NormalizedQuickBooksProviderReportAccountTotal[];
};

export type NormalizedQuickBooksProviderReportResponseEnvelope = {
  readonly sourceIdentity: NormalizedQuickBooksSourceIdentity;
  readonly providerEnvironment: NormalizedQuickBooksProviderEnvironment;
  readonly reportName: NormalizedQuickBooksProviderReportName;
  readonly supportStatus: NormalizedQuickBooksProviderReportSupportStatus;
  readonly unsupportedReason?: NormalizedQuickBooksProviderReportUnsupportedReason;
  readonly accountingBasis: AccountingBasis;
  readonly currencyCode?: IsoCurrencyCode;
  readonly importBatchId?: ImportBatchId;
  readonly checkpointId?: SyncCheckpointId;
  readonly sourceFreshThrough?: IsoDateTime;
  readonly importedThrough?: IsoDateTime;
  readonly latestSourceUpdatedAt?: IsoDateTime;
  readonly periodStart?: IsoDate;
  readonly periodEnd?: IsoDate;
  readonly asOfDate?: IsoDate;
  readonly requestedAt?: IsoDateTime;
  readonly providerReportRef?: NormalizedQuickBooksProviderReportRef;
  readonly sourceUpdatedAt?: IsoDateTime;
  readonly generatedAt?: IsoDateTime;
  readonly totals: readonly NormalizedQuickBooksProviderReportTotal[];
  readonly accountTotals?: readonly NormalizedQuickBooksProviderReportAccountTotal[];
};

export type NormalizedQuickBooksProfitAndLossReportResponseEnvelope =
  NormalizedQuickBooksProviderReportResponseEnvelope & {
    readonly reportName: "profit_and_loss";
    readonly supportStatus: "supported";
    readonly providerReportRef: NormalizedQuickBooksProviderReportRef;
  };

export type NormalizedQuickBooksBalanceSheetReportResponseEnvelope =
  NormalizedQuickBooksProviderReportResponseEnvelope & {
    readonly reportName: "balance_sheet";
    readonly supportStatus: "supported";
    readonly providerReportRef: NormalizedQuickBooksProviderReportRef;
  };

export type NormalizedQuickBooksTrialBalanceReportResponseEnvelope =
  NormalizedQuickBooksProviderReportResponseEnvelope & {
    readonly reportName: "trial_balance";
    readonly supportStatus: "supported";
    readonly providerReportRef: NormalizedQuickBooksProviderReportRef;
  };

export type NormalizedQuickBooksCashFlowParityReportResponseEnvelope =
  NormalizedQuickBooksProviderReportResponseEnvelope & {
    readonly reportName: "cash_flow";
    readonly supportStatus: "unsupported";
    readonly unsupportedReason: NormalizedQuickBooksProviderReportUnsupportedReason;
  };

export type NormalizedAccountingReconciliationEvidence = {
  readonly provider: AccountingSourceSystem;
  readonly providerReportRef: NormalizedQuickBooksProviderReportRef;
  readonly reconciliationStatus: ReconciliationStatus;
  readonly reconciliationDifference: DecimalString;
  readonly toleranceAmount?: DecimalString;
  readonly sourceUpdatedAt?: IsoDateTime;
  readonly generatedAt?: IsoDateTime;
  readonly totals: readonly NormalizedAccountingReconciliationTotal[];
};

export type NormalizedAccountingReconciliationTotal = {
  readonly totalKey: string;
  readonly canonicalAmount: DecimalString;
  readonly providerAmount: DecimalString;
  readonly difference: DecimalString;
  readonly status: "matched" | "mismatched" | "missing";
  readonly drilldownRef?: NormalizedAccountingSafeSourceRef;
};

export type NormalizedQuickBooksResourceEnvelope<ResourceType extends string, Resource> = {
  readonly sourceSystem: "quickbooks";
  readonly tenantId?: TenantId;
  readonly sourceId?: SourceId;
  readonly providerEnvironment: NormalizedQuickBooksProviderEnvironment;
  readonly realmId: string;
  readonly resourceType: ResourceType;
  readonly resourceId: string;
  readonly importBatchId?: ImportBatchId;
  readonly checkpointId?: SyncCheckpointId;
  readonly sourceUpdatedAt?: IsoDateTime;
  readonly sourceRevision?: string;
  readonly syncAction?: NormalizedAccountingSyncResourceAction;
  readonly sourcePayloadRef?: NormalizedAccountingSafeSourceRef;
  readonly resource: Resource;
};

export type NormalizedQuickBooksCompanyInfoResource = NormalizedQuickBooksResourceEnvelope<
  "CompanyInfo",
  NormalizedQuickBooksCompanyInfo
>;

export type NormalizedQuickBooksAccountResource = NormalizedQuickBooksResourceEnvelope<"Account", NormalizedQuickBooksAccount>;

export type NormalizedQuickBooksLedgerEntryResource = NormalizedQuickBooksResourceEnvelope<
  "JournalEntry",
  NormalizedQuickBooksLedgerEntry
>;

export type NormalizedQuickBooksLedgerTransactionResource = NormalizedQuickBooksResourceEnvelope<
  "LedgerTransaction",
  NormalizedQuickBooksLedgerTransaction
>;

export type NormalizedQuickBooksLedgerPostingResource = NormalizedQuickBooksResourceEnvelope<
  "LedgerPosting",
  NormalizedQuickBooksLedgerPosting
>;

export type NormalizedQuickBooksPartyResource = NormalizedQuickBooksResourceEnvelope<"Party", NormalizedQuickBooksParty>;

export type NormalizedQuickBooksCustomerResource = NormalizedQuickBooksResourceEnvelope<"Customer", NormalizedQuickBooksParty>;

export type NormalizedQuickBooksVendorResource = NormalizedQuickBooksResourceEnvelope<"Vendor", NormalizedQuickBooksParty>;

export type NormalizedQuickBooksItemResource = NormalizedQuickBooksResourceEnvelope<"Item", NormalizedQuickBooksItem>;

export type NormalizedQuickBooksClassResource = NormalizedQuickBooksResourceEnvelope<"Class", NormalizedQuickBooksDimension>;

export type NormalizedQuickBooksDepartmentResource = NormalizedQuickBooksResourceEnvelope<"Department", NormalizedQuickBooksDimension>;

export type NormalizedQuickBooksDimensionResource = NormalizedQuickBooksResourceEnvelope<"Dimension", NormalizedQuickBooksDimension>;

export type NormalizedQuickBooksResourceSet = {
  readonly identity: NormalizedQuickBooksSourceIdentity;
  readonly importBatch?: NormalizedAccountingImportBatchMetadata;
  readonly checkpoint?: NormalizedAccountingSyncCheckpointMetadata;
  readonly companyInfo: NormalizedQuickBooksCompanyInfoResource;
  readonly accounts: readonly NormalizedQuickBooksAccountResource[];
  readonly journalEntries?: readonly NormalizedQuickBooksLedgerEntryResource[];
  readonly ledgerTransactions?: readonly NormalizedQuickBooksLedgerTransactionResource[];
  /** Commercial documents, including records that do not emit provider ledger rows. */
  readonly operationalDocuments?: readonly NormalizedQuickBooksLedgerTransactionResource[];
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

export type NormalizedQuickBooksSyncResourceSet = Omit<NormalizedQuickBooksResourceSet, "companyInfo" | "accounts"> & {
  readonly companyInfo?: NormalizedQuickBooksCompanyInfoResource;
  readonly accounts?: readonly NormalizedQuickBooksAccountResource[];
};

export type NormalizedQuickBooksSyncRequestEnvelope<
  Mode extends NormalizedAccountingSyncMode = NormalizedAccountingSyncMode
> = NormalizedAccountingSyncRequestEnvelope<NormalizedQuickBooksSourceIdentity, Mode>;

export type NormalizedQuickBooksFullSyncRequestEnvelope =
  NormalizedAccountingFullSyncRequestEnvelope<NormalizedQuickBooksSourceIdentity>;

export type NormalizedQuickBooksIncrementalSyncRequestEnvelope =
  NormalizedAccountingIncrementalSyncRequestEnvelope<NormalizedQuickBooksSourceIdentity>;

export type NormalizedQuickBooksBackfillSyncRequestEnvelope =
  NormalizedAccountingBackfillSyncRequestEnvelope<NormalizedQuickBooksSourceIdentity>;

export type NormalizedQuickBooksReprocessSyncRequestEnvelope =
  NormalizedAccountingReprocessSyncRequestEnvelope<NormalizedQuickBooksSourceIdentity>;

export type NormalizedQuickBooksPaginationRequestEnvelope<
  Mode extends NormalizedAccountingSyncMode = NormalizedAccountingSyncMode
> = NormalizedAccountingPaginationRequestEnvelope<NormalizedQuickBooksSourceIdentity, Mode>;

export type NormalizedQuickBooksCheckpointResumeRequestEnvelope<
  Mode extends Exclude<NormalizedAccountingSyncMode, "full"> = Exclude<NormalizedAccountingSyncMode, "full">
> = NormalizedAccountingCheckpointResumeRequestEnvelope<NormalizedQuickBooksSourceIdentity, Mode>;

export type NormalizedQuickBooksSyncResponseEnvelope<
  Resources = NormalizedQuickBooksSyncResourceSet,
  Mode extends NormalizedAccountingSyncMode = NormalizedAccountingSyncMode
> = NormalizedAccountingSyncResponseEnvelope<NormalizedQuickBooksSourceIdentity, Resources, Mode>;

export type NormalizedQuickBooksFullSyncResponseEnvelope =
  NormalizedAccountingFullSyncResponseEnvelope<NormalizedQuickBooksSourceIdentity, NormalizedQuickBooksResourceSet>;

export type NormalizedQuickBooksIncrementalSyncResponseEnvelope =
  NormalizedAccountingIncrementalSyncResponseEnvelope<NormalizedQuickBooksSourceIdentity, NormalizedQuickBooksSyncResourceSet>;

export type NormalizedQuickBooksBackfillSyncResponseEnvelope =
  NormalizedAccountingBackfillSyncResponseEnvelope<NormalizedQuickBooksSourceIdentity, NormalizedQuickBooksSyncResourceSet>;

export type NormalizedQuickBooksReprocessSyncResponseEnvelope =
  NormalizedAccountingReprocessSyncResponseEnvelope<NormalizedQuickBooksSourceIdentity, NormalizedQuickBooksSyncResourceSet>;

export type NormalizedQuickBooksPaginationResponseEnvelope<
  Mode extends NormalizedAccountingSyncMode = NormalizedAccountingSyncMode
> = NormalizedAccountingPaginationResponseEnvelope<NormalizedQuickBooksSourceIdentity, NormalizedQuickBooksSyncResourceSet, Mode>;
