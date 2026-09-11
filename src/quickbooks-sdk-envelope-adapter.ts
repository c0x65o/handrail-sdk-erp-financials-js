import { assertNoCredentialKeys } from "./canonical-model.js";
import type {
  AccountingBasis,
  ImportBatchStatus,
  IsoCurrencyCode,
  IsoDateTime,
  JsonValue,
  SafeSourcePayloadRef
} from "./canonical-model.js";
import type {
  NormalizedAccountingSyncIssue,
  NormalizedAccountingSyncIssueSummary,
  NormalizedAccountingSyncResourceAction,
  NormalizedQuickBooksAccountResource,
  NormalizedQuickBooksClassResource,
  NormalizedQuickBooksCompanyInfoResource,
  NormalizedQuickBooksDepartmentResource,
  NormalizedQuickBooksFullSyncResponseEnvelope,
  NormalizedQuickBooksIncrementalSyncResponseEnvelope,
  NormalizedQuickBooksItemResource,
  NormalizedQuickBooksLedgerLine,
  NormalizedQuickBooksLedgerPosting,
  NormalizedQuickBooksLedgerTransaction,
  NormalizedQuickBooksLedgerTransactionResource,
  NormalizedQuickBooksPartyResource,
  NormalizedQuickBooksProviderEnvironment,
  NormalizedQuickBooksResourceEnvelope,
  NormalizedQuickBooksResourceSet,
  NormalizedQuickBooksSourceIdentity
} from "./normalized-accounting-contracts.js";
import { consumeSourceRecordDispositions } from "./source-record-dispositions.js";
import type { SourceRecordDisposition } from "./source-record-dispositions.js";

const QUICKBOOKS_SDK_SYNC_CONTRACT_ID = "handrail.quickbooks.normalized-sync-envelope.v1";
const MAX_SOURCE_REF_BYTES = 512;
const SAFE_SOURCE_REF_PATTERN = /^(?:raw|checkpoint|provider):\/\//;
const SECRET_VALUE_PATTERN =
  /access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization|bearer|api[_-]?key|password|credential/i;

export type HandrailQuickBooksSdkNormalizedResourceFamily =
  | "accounts"
  | "classes"
  | "items"
  | "ledger_entries"
  | "locations"
  | "parties"
  | "transactions"
  | "transaction_lines";

export type HandrailQuickBooksSdkNormalizedResourceMap = {
  readonly accounts?: readonly unknown[];
  readonly classes?: readonly unknown[];
  readonly items?: readonly unknown[];
  readonly ledger_entries?: readonly unknown[];
  readonly locations?: readonly unknown[];
  readonly parties?: readonly unknown[];
  readonly transactions?: readonly unknown[];
  readonly transaction_lines?: readonly unknown[];
};

export type HandrailQuickBooksSdkDeltaCounts = {
  readonly skippedCount: number;
  readonly changedCount: number;
  readonly insertedCount: number;
  readonly failedCount: number;
  readonly retryPendingCount?: number;
  readonly unchangedCount?: number;
  readonly updatedCount?: number;
};

export type HandrailQuickBooksSdkNormalizationWarning = {
  readonly code: string;
  readonly objectType: string;
  readonly transactionId: string;
  readonly message: string;
};

export type HandrailQuickBooksSdkCompletenessResourceFamily =
  | "accounts"
  | "ledger_entries"
  | "transactions"
  | "transaction_lines";

export type HandrailQuickBooksSdkNormalizedResourceCompleteness = {
  readonly resourceFamily: HandrailQuickBooksSdkCompletenessResourceFamily;
  readonly complete: boolean;
  readonly status: "complete" | "incomplete" | "unknown";
  readonly normalizedRecordCount: number;
  readonly reason?: string;
};

export type HandrailQuickBooksSdkNormalizedCompletenessMap = Partial<
  Record<HandrailQuickBooksSdkCompletenessResourceFamily, HandrailQuickBooksSdkNormalizedResourceCompleteness>
>;

export type HandrailQuickBooksSdkNormalizedSyncEnvelope = {
  readonly contractId: typeof QUICKBOOKS_SDK_SYNC_CONTRACT_ID;
  readonly syncMode: "full" | "incremental";
  readonly tenantId: string;
  readonly companyId: string;
  readonly importBatchId: string;
  readonly jobId: string;
  readonly status: string;
  readonly normalizedResourceCounts: Partial<Record<HandrailQuickBooksSdkNormalizedResourceFamily, number>>;
  readonly normalizedResources?: HandrailQuickBooksSdkNormalizedResourceMap;
  readonly normalizedCompleteness?: HandrailQuickBooksSdkNormalizedCompletenessMap;
  readonly normalizationWarnings?: readonly HandrailQuickBooksSdkNormalizationWarning[];
  readonly providerDispositions?: readonly unknown[];
  readonly deltaCounts: HandrailQuickBooksSdkDeltaCounts;
  readonly audit: {
    readonly checkpointId?: string;
    readonly importBatchId?: string;
    readonly jobId?: string;
    readonly realmId?: string;
    readonly sourcePayloadRef?: string;
    readonly sourcePayloadRefs?: readonly string[];
  };
  readonly importVolume: {
    readonly entityCounts: Partial<Record<HandrailQuickBooksSdkNormalizedResourceFamily, number>>;
  };
  readonly importBatch?: {
    readonly completedAt?: string;
    readonly realmId?: string;
    readonly startedAt?: string;
    readonly status?: string;
  };
  readonly checkpoint?: {
    readonly checkpointId: string;
    readonly checkpointRef?: string;
    readonly completedAt?: string;
    readonly cursorRefs?: readonly string[];
    readonly entity?: string;
    readonly providerUpdatedAtWatermark?: string;
    readonly startedAt?: string;
    readonly status?: string;
    readonly syncJobRefs?: readonly string[];
  };
  readonly syncJob: {
    readonly completedAt?: string;
    readonly startedAt: string;
    readonly audit?: {
      readonly sourcePayloadRef?: string;
    };
    readonly providerDispositions?: readonly unknown[];
  };
};

export type HandrailQuickBooksSdkFullSyncEnvelope = HandrailQuickBooksSdkNormalizedSyncEnvelope & {
  readonly syncMode: "full";
};

export type HandrailQuickBooksSdkIncrementalSyncEnvelope = HandrailQuickBooksSdkNormalizedSyncEnvelope & {
  readonly syncMode: "incremental";
};

export type HandrailQuickBooksSdkEnvelopeAdapterOptions = {
  readonly sourceId: string;
  readonly accountingBasis: AccountingBasis;
  readonly currencyCode: IsoCurrencyCode;
  readonly companyDisplayName?: string;
  readonly idempotencyKey?: string;
  readonly importedAt?: IsoDateTime;
  readonly providerEnvironment?: NormalizedQuickBooksProviderEnvironment;
  readonly realmId?: string;
  readonly tenantId?: string;
};

export type HandrailQuickBooksSdkEnvelopeEvidence = {
  readonly sdkContractId: typeof QUICKBOOKS_SDK_SYNC_CONTRACT_ID;
  readonly sdkSyncJobId: string;
  readonly deltaCounts: HandrailQuickBooksSdkDeltaCounts;
  readonly normalizedCompleteness?: HandrailQuickBooksSdkNormalizedCompletenessMap;
  readonly normalizationWarnings?: readonly HandrailQuickBooksSdkNormalizationWarning[];
  readonly recordDispositions?: readonly SourceRecordDisposition[];
};

export type HandrailQuickBooksSdkAdaptedFullSyncEnvelope =
  NormalizedQuickBooksFullSyncResponseEnvelope & HandrailQuickBooksSdkEnvelopeEvidence;

export type HandrailQuickBooksSdkAdaptedIncrementalSyncEnvelope =
  NormalizedQuickBooksIncrementalSyncResponseEnvelope & HandrailQuickBooksSdkEnvelopeEvidence;

export function adaptHandrailQuickBooksSdkSyncEnvelope(
  response: HandrailQuickBooksSdkNormalizedSyncEnvelope,
  options: HandrailQuickBooksSdkEnvelopeAdapterOptions
): HandrailQuickBooksSdkAdaptedFullSyncEnvelope | HandrailQuickBooksSdkAdaptedIncrementalSyncEnvelope {
  return response.syncMode === "full"
    ? adaptHandrailQuickBooksSdkFullSyncEnvelope(response as HandrailQuickBooksSdkFullSyncEnvelope, options)
    : adaptHandrailQuickBooksSdkIncrementalSyncEnvelope(
        response as HandrailQuickBooksSdkIncrementalSyncEnvelope,
        options
      );
}

export function adaptHandrailQuickBooksSdkFullSyncEnvelope(
  response: HandrailQuickBooksSdkFullSyncEnvelope,
  options: HandrailQuickBooksSdkEnvelopeAdapterOptions
): HandrailQuickBooksSdkAdaptedFullSyncEnvelope {
  const context = prepareAdapterContext(response, options);
  const mapped = mapSdkResources(response, context);
  const common = adaptedEnvelopeFields(response, context, mapped.resources, mapped.recordDispositions);
  const adapted: HandrailQuickBooksSdkAdaptedFullSyncEnvelope = {
    ...common,
    syncMode: "full",
    cursorKind: "full_scan"
  };
  assertNoCredentialKeys(adapted);
  return adapted;
}

export function adaptHandrailQuickBooksSdkIncrementalSyncEnvelope(
  response: HandrailQuickBooksSdkIncrementalSyncEnvelope,
  options: HandrailQuickBooksSdkEnvelopeAdapterOptions
): HandrailQuickBooksSdkAdaptedIncrementalSyncEnvelope {
  const context = prepareAdapterContext(response, options);
  const mapped = mapSdkResources(response, context);
  const common = adaptedEnvelopeFields(response, context, mapped.resources, mapped.recordDispositions);
  const adapted: HandrailQuickBooksSdkAdaptedIncrementalSyncEnvelope = {
    ...common,
    syncMode: "incremental",
    cursorKind: "updated_since"
  };
  assertNoCredentialKeys(adapted);
  return adapted;
}

type AdapterContext = {
  readonly accountingBasis: AccountingBasis;
  readonly checkpointId: string;
  readonly companyDisplayName: string;
  readonly currencyCode: IsoCurrencyCode;
  readonly importBatchId: string;
  readonly importedAt: IsoDateTime;
  readonly idempotencyKey?: string;
  readonly providerEnvironment: NormalizedQuickBooksProviderEnvironment;
  readonly realmId: string;
  readonly sourceId: string;
  readonly sourceIdentity: NormalizedQuickBooksSourceIdentity;
  readonly syncAction?: NormalizedAccountingSyncResourceAction;
  readonly tenantId: string;
};

function prepareAdapterContext(
  response: HandrailQuickBooksSdkNormalizedSyncEnvelope,
  options: HandrailQuickBooksSdkEnvelopeAdapterOptions
): AdapterContext {
  const contractId = (response as { readonly contractId: string }).contractId;
  if (contractId !== QUICKBOOKS_SDK_SYNC_CONTRACT_ID) {
    throw new Error(`Unsupported QuickBooks SDK sync contract: ${contractId}`);
  }
  assertSdkEnvelopeNoCredentials(response);
  const normalizedResources = response.normalizedResources;
  if (normalizedResources === undefined) {
    throw new Error("QuickBooks SDK sync envelope does not include normalizedResources.");
  }

  const sample = firstNormalizedResource(normalizedResources);
  const sampleRecord = sample === undefined ? undefined : record(sample, "normalized resource");
  const tenantId = options.tenantId ?? response.tenantId;
  if (tenantId !== response.tenantId) {
    throw new Error(`QuickBooks SDK tenantId ${response.tenantId} does not match adapter tenantId ${tenantId}.`);
  }
  const realmId =
    options.realmId ??
    optionalString(sampleRecord, "realmId") ??
    response.audit.realmId ??
    response.importBatch?.realmId ??
    response.companyId;
  const providerEnvironment = readProviderEnvironment(
    options.providerEnvironment ?? optionalString(sampleRecord, "providerEnvironment")
  );
  const importedAt =
    options.importedAt ??
    response.importBatch?.completedAt ??
    response.syncJob.completedAt ??
    response.importBatch?.startedAt ??
    response.syncJob.startedAt;
  if (importedAt.length === 0) {
    throw new Error("QuickBooks SDK sync envelope does not include an import timestamp.");
  }
  const checkpointId = response.checkpoint?.checkpointId ?? response.audit.checkpointId ??
    `quickbooks_${response.syncMode}_${response.importBatchId}`;
  const sourceIdentity: NormalizedQuickBooksSourceIdentity = {
    tenantId,
    sourceId: options.sourceId,
    sourceSystem: "quickbooks",
    providerEnvironment,
    realmId,
    sourceCompanyRef: realmId
  };
  const context: AdapterContext = {
    accountingBasis: options.accountingBasis,
    checkpointId,
    companyDisplayName: options.companyDisplayName ?? response.companyId,
    currencyCode: options.currencyCode,
    importBatchId: response.importBatchId,
    importedAt,
    ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
    providerEnvironment,
    realmId,
    sourceId: options.sourceId,
    sourceIdentity,
    ...(response.syncMode === "incremental" ? { syncAction: "changed" as const } : {}),
    tenantId
  };

  validateNormalizedResourceIdentity(normalizedResources, context);
  return context;
}

type AdaptedQuickBooksResourceSet = NormalizedQuickBooksResourceSet & {
  readonly importBatch: NonNullable<NormalizedQuickBooksResourceSet["importBatch"]>;
  readonly checkpoint: NonNullable<NormalizedQuickBooksResourceSet["checkpoint"]>;
};

function mapSdkResources(
  response: HandrailQuickBooksSdkNormalizedSyncEnvelope,
  context: AdapterContext
): { readonly resources: AdaptedQuickBooksResourceSet; readonly recordDispositions: readonly SourceRecordDisposition[] } {
  const normalizedResources = response.normalizedResources;
  if (normalizedResources === undefined) {
    throw new Error("QuickBooks SDK sync envelope does not include normalizedResources.");
  }
  const consumed = consumeSourceRecordDispositions({
    importBatchId: response.importBatchId,
    rootDispositions: response.providerDispositions,
    nestedDispositions: response.syncJob.providerDispositions,
    normalizedResources,
    skippedCount: response.deltaCounts.skippedCount
  });
  const input = consumed.normalizedResources;
  const latestSourceUpdatedAt = latestResourceUpdatedAt(input);
  const checkpoint = {
    checkpointId: context.checkpointId,
    sourceObject: response.checkpoint?.entity ?? `quickbooks_${response.syncMode}_sync`,
    cursorKind: response.syncMode === "full" ? "full_scan" as const : "updated_since" as const,
    cursorValue:
      response.checkpoint?.providerUpdatedAtWatermark ??
      response.checkpoint?.completedAt ??
      response.importBatch?.completedAt ??
      latestSourceUpdatedAt ??
      context.importedAt,
    ...(response.checkpoint?.completedAt === undefined
      ? {}
      : { freshThrough: response.checkpoint.completedAt }),
    ...(latestSourceUpdatedAt === undefined ? {} : { latestSourceUpdatedAt }),
    status: checkpointStatus(response.status)
  };
  const issueSummary = sdkWarningSummary(response, consumed.dispositions);
  const importBatch = {
    importBatchId: response.importBatchId,
    syncMode: response.syncMode,
    mode: response.syncMode === "full" ? "initial" as const : "delta" as const,
    status: importBatchStatus(response.status, issueSummary),
    startedAt: response.importBatch?.startedAt ?? response.syncJob.startedAt,
    ...(response.importBatch?.completedAt === undefined && response.syncJob.completedAt === undefined
      ? {}
      : { completedAt: response.importBatch?.completedAt ?? response.syncJob.completedAt }),
    sourceObjectCounts: normalizeResourceCounts(response.normalizedResourceCounts),
    ...(issueSummary === undefined ? {} : { warningSummary: issueSummary as JsonValue })
  };
  const ledgerTransactions = ledgerTransactionResources(
    context,
    input.ledger_entries ?? [],
    input.transactions ?? [],
    input.transaction_lines ?? []
  );

  const resources: AdaptedQuickBooksResourceSet = {
    identity: context.sourceIdentity,
    importBatch,
    checkpoint,
    companyInfo: companyInfoResource(context, latestSourceUpdatedAt),
    accounts: (input.accounts ?? []).map((value, index) => accountResource(context, value, index)),
    ledgerTransactions,
    operationalDocuments: operationalDocumentResources(
      context,
      input.transactions ?? [],
      input.transaction_lines ?? [],
      ledgerTransactions
    ),
    parties: (input.parties ?? []).map((value, index) => partyResource(context, value, index)),
    items: (input.items ?? []).map((value, index) => itemResource(context, value, index)),
    classes: (input.classes ?? []).map((value, index) => classResource(context, value, index)),
    departments: (input.locations ?? []).map((value, index) => departmentResource(context, value, index))
  };
  return { resources, recordDispositions: consumed.dispositions };
}

function operationalDocumentResources(
  context: AdapterContext,
  transactionValues: readonly unknown[],
  transactionLineValues: readonly unknown[],
  ledgerTransactions: readonly NormalizedQuickBooksLedgerTransactionResource[]
): readonly NormalizedQuickBooksLedgerTransactionResource[] {
  const ledgerByKey = new Map(ledgerTransactions.map((resource) => [
    `${resource.resource.sourceTransactionType}:${resource.resource.sourceTransactionId}`,
    resource
  ]));
  const linesByKey = new Map<string, Record<string, unknown>[]>();
  transactionLineValues.forEach((value, index) => {
    const line = record(value, `normalizedResources.transaction_lines[${String(index)}]`);
    const metadata = providerMetadata(line, `normalizedResources.transaction_lines[${String(index)}]`);
    const transactionId = requiredString(line, "transactionId", `QuickBooks transaction line ${metadata.sourceObjectId}`);
    const key = `${metadata.sourceObject}:${transactionId}`;
    linesByKey.set(key, [...(linesByKey.get(key) ?? []), line]);
  });

  return transactionValues.map((value, index) => {
    const header = record(value, `normalizedResources.transactions[${String(index)}]`);
    const metadata = providerMetadata(header, `normalizedResources.transactions[${String(index)}]`);
    const key = `${metadata.sourceObject}:${metadata.sourceObjectId}`;
    const ledger = ledgerByKey.get(key);
    const operationalLines = linesByKey.get(key) ?? [];
    // The provider GL is authoritative for journal polarity, but it is a
    // lossy representation of commercial documents. Prefer the normalized
    // transaction lines for subledger projection whenever the connector has
    // supplied them; retain the GL-shaped resource only as a compatibility
    // fallback for header-only provider records.
    if (operationalLines.length === 0 && ledger !== undefined) return ledger;

    const sourcePayloadRef = safeSourcePayloadRef(
      context,
      metadata.sourceObject,
      metadata.sourceObjectId,
      metadata.sourceUpdatedAt,
      metadata.sourcePayloadRef
    );
    const transactionDate = optionalString(header, "transactionDate") ?? metadata.importedAt.slice(0, 10);
    const partyRef = normalizedPartyReference(optionalReference(header.party), quickBooksPartyType(metadata.sourceObject));
    const currencyCode = optionalReference(header.currency)?.value ?? context.currencyCode;
    const transactionNumber = optionalString(header, "documentNumber");
    const dueDate = optionalString(header, "dueDate");
    const totalAmount = optionalNumber(header, "amount");
    const openAmount = optionalNumber(header, "balance");
    const unappliedAmount = optionalNumber(header, "unappliedAmount");
    const emailStatus = optionalString(header, "emailStatus");
    const printStatus = optionalString(header, "printStatus");
    const memo = optionalString(header, "privateNote");
    const syncAction = resourceAction(header, context);
    const resource: NormalizedQuickBooksLedgerTransaction = {
      sourceTransactionId: metadata.sourceObjectId,
      sourceTransactionType: metadata.sourceObject,
      transactionDate,
      ...(transactionNumber === undefined ? {} : { transactionNumber }),
      ...(dueDate === undefined ? {} : { dueDate }),
      ...(totalAmount === undefined ? {} : { totalAmount: decimalFromNumber(totalAmount) }),
      ...(optionalNumber(header, "totalTax") === undefined ? {} : { totalTax: decimalFromNumber(optionalNumber(header, "totalTax")!) }),
      ...(optionalString(header, "taxCalculation") === undefined ? {} : { taxCalculation: optionalString(header, "taxCalculation")! }),
      ...(openAmount === undefined ? {} : { openAmount: decimalFromNumber(openAmount) }),
      ...(unappliedAmount === undefined ? {} : { unappliedAmount: decimalFromNumber(unappliedAmount) }),
      ...(emailStatus === undefined ? {} : { emailStatus }),
      ...(printStatus === undefined ? {} : { printStatus }),
      ...(memo === undefined ? {} : { memo }),
      ...(metadata.sourceUpdatedAt === undefined ? {} : { sourceUpdatedAt: metadata.sourceUpdatedAt }),
      ...(partyRef === undefined ? {} : { partyRef }),
      currencyCode,
      lines: operationalLines
        .sort((left, right) => (optionalNumber(left, "lineOrder") ?? 0) - (optionalNumber(right, "lineOrder") ?? 0))
        .map((line, lineIndex) => operationalDocumentLine(
          context,
          line,
          metadata,
          lineIndex,
          optionalReference(header.party)
        )),
      sourcePayloadRef
    };
    return resourceEnvelope(
      context,
      "LedgerTransaction",
      metadata.sourceObjectId,
      resource,
      metadata.sourceUpdatedAt,
      sourcePayloadRef,
      syncAction
    );
  });
}

function operationalDocumentLine(
  context: AdapterContext,
  input: Record<string, unknown>,
  transactionMetadata: ProviderMetadata,
  lineIndex: number,
  transactionParty: { readonly value: string; readonly name?: string } | undefined
): NormalizedQuickBooksLedgerLine {
  const metadata = providerMetadata(input, `QuickBooks transaction line ${String(lineIndex + 1)}`);
  const lineId = requiredString(input, "lineId", `QuickBooks transaction line ${metadata.sourceObjectId}`);
  const amount = optionalNumber(input, "amount");
  const quantity = optionalNumber(input, "quantity");
  const unitAmount = optionalNumber(input, "unitAmount");
  const accountRef = normalizedReference(optionalReference(input.account));
  const lineParty = optionalReference(input.party);
  const partyRef = normalizedPartyReference(
    lineParty,
    quickBooksOperationalLinePartyType(metadata.sourceObject, lineParty, transactionParty)
  );
  const itemRef = normalizedReference(optionalReference(input.item));
  const taxCode = optionalReference(input.taxCode)?.value;
  const detailType = optionalString(input, "detailType");
  const description = optionalString(input, "description");
  const linkedTransactions = normalizedQuickBooksLinkedTransactions(input.linkedTransactions);
  const dimensionRefs = [
    normalizedDimensionReference(optionalReference(input.classRef), "class"),
    normalizedDimensionReference(optionalReference(input.department), "department")
  ].filter((value) => value !== undefined);
  const sourcePayloadRef = safeSourcePayloadRef(
    context,
    `${metadata.sourceObject}Line`,
    `${transactionMetadata.sourceObjectId}:${lineId}`,
    metadata.sourceUpdatedAt,
    metadata.sourcePayloadRef
  );
  return {
    sourceLineId: lineId,
    lineNumber: optionalNumber(input, "lineOrder") ?? lineIndex + 1,
    ...(detailType === undefined ? {} : { detailType }),
    ...(description === undefined ? {} : { description }),
    amount: decimalFromNumber(amount ?? 0),
    ...(amount === undefined ? {} : { sourceAmount: decimalFromNumber(amount) }),
    ...(quantity === undefined ? {} : { sourceQuantity: commercialDecimalFromNumber(quantity) }),
    ...(unitAmount === undefined ? {} : { sourceUnitAmount: commercialDecimalFromNumber(unitAmount) }),
    ...(taxCode === undefined ? {} : { taxCode }),
    ...(accountRef === undefined ? {} : { accountRef }),
    ...(partyRef === undefined ? {} : { partyRef }),
    ...(itemRef === undefined ? {} : { itemRef }),
    dimensionRefs,
    ...(linkedTransactions.length === 0 ? {} : { linkedTransactions }),
    postings: [],
    sourcePayloadRef
  };
}

function adaptedEnvelopeFields(
  response: HandrailQuickBooksSdkNormalizedSyncEnvelope,
  context: AdapterContext,
  resources: AdaptedQuickBooksResourceSet,
  recordDispositions: readonly SourceRecordDisposition[]
) {
  const warningSummary = sdkWarningSummary(response, recordDispositions);
  const resourceCounts = normalizeResourceCounts(response.normalizedResourceCounts);
  const idempotencyKey = `quickbooks-sdk:${context.tenantId}:${response.importBatchId}`;
  const status = importBatchStatus(response.status, warningSummary);
  const completedAt = resources.importBatch.completedAt;
  const latestSourceUpdatedAt = resources.checkpoint.latestSourceUpdatedAt;
  const freshThrough = resources.checkpoint.freshThrough;

  return {
    sourceIdentity: context.sourceIdentity,
    providerEnvironment: context.providerEnvironment,
    importBatchId: response.importBatchId,
    checkpointId: context.checkpointId,
    cursorValue: resources.checkpoint.cursorValue,
    ...(freshThrough === undefined ? {} : { sourceFreshThrough: freshThrough, freshThrough }),
    ...(completedAt === undefined ? {} : { importedThrough: completedAt, completedAt }),
    ...(latestSourceUpdatedAt === undefined ? {} : { latestSourceUpdatedAt }),
    resourceCounts,
    ...(warningSummary === undefined ? {} : { warningSummary }),
    ...(response.status === "failed" || response.status === "cancelled"
      ? {
          errorSummary: {
            count: 1,
            items: [{ code: "quickbooks_sync_failed", message: "QuickBooks SDK sync failed.", severity: "error" as const }]
          }
        }
      : {}),
    idempotencyKey: context.idempotencyKey ?? idempotencyKey,
    idempotencyKeys: {
      syncRequestKey: context.idempotencyKey ?? idempotencyKey,
      importBatchId: response.importBatchId,
      checkpointId: context.checkpointId,
      resourceSetKey: `${context.idempotencyKey ?? idempotencyKey}:resources`
    },
    status,
    importBatch: resources.importBatch,
    checkpoint: resources.checkpoint,
    resources,
    sdkContractId: QUICKBOOKS_SDK_SYNC_CONTRACT_ID as typeof QUICKBOOKS_SDK_SYNC_CONTRACT_ID,
    sdkSyncJobId: response.jobId,
    deltaCounts: response.deltaCounts,
    ...(recordDispositions.length === 0 ? {} : { recordDispositions }),
    ...(response.normalizedCompleteness === undefined
      ? {}
      : { normalizedCompleteness: response.normalizedCompleteness }),
    ...(response.normalizationWarnings === undefined || response.normalizationWarnings.length === 0
      ? {}
      : { normalizationWarnings: response.normalizationWarnings })
  };
}

function companyInfoResource(
  context: AdapterContext,
  sourceUpdatedAt: string | undefined
): NormalizedQuickBooksCompanyInfoResource {
  return resourceEnvelope(
    context,
    "CompanyInfo",
    context.realmId,
    {
      companyName: context.companyDisplayName,
      legalName: context.companyDisplayName,
      baseCurrencyCode: context.currencyCode
    },
    sourceUpdatedAt,
    safeSourcePayloadRef(context, "CompanyInfo", context.realmId, sourceUpdatedAt)
  );
}

function accountResource(
  context: AdapterContext,
  value: unknown,
  index: number
): NormalizedQuickBooksAccountResource {
  const input = record(value, `normalizedResources.accounts[${String(index)}]`);
  const metadata = providerMetadata(input, `normalizedResources.accounts[${String(index)}]`);
  const accountType = requiredString(input, "accountType", `QuickBooks account ${metadata.sourceObjectId}`);
  const parentRef = optionalReference(input.parentRef);
  const parentAccountId = optionalString(input, "parentAccountId")?.trim() || undefined;
  const parentAccountName = optionalString(input, "parentAccountName");
  if (parentRef !== undefined && parentAccountId !== undefined && parentRef.value.trim() !== parentAccountId) {
    throw new Error(
      `QuickBooks account ${metadata.sourceObjectId} has conflicting parentRef.value and parentAccountId values.`
    );
  }
  const resolvedParentAccountId = parentRef?.value.trim() || parentAccountId;
  const resolvedParentAccountName = parentRef?.name ?? parentAccountName;
  const subAccount = optionalBoolean(input, "subAccount");
  if (subAccount === true && resolvedParentAccountId === undefined) {
    throw new Error(`QuickBooks sub-account ${metadata.sourceObjectId} is missing a stable parent account id.`);
  }
  if (subAccount === false && resolvedParentAccountId !== undefined) {
    throw new Error(`QuickBooks account ${metadata.sourceObjectId} has a parent account id but is marked as a root account.`);
  }
  if (resolvedParentAccountId === metadata.sourceObjectId) {
    throw new Error(`QuickBooks account ${metadata.sourceObjectId} cannot be its own parent.`);
  }
  const currency = optionalReference(input.currency);
  const classification = normalizedAccountClassification(optionalString(input, "classification"));
  const accountSubType = optionalString(input, "accountSubType");
  const active = optionalBoolean(input, "active");
  const sourcePayloadRef = safeSourcePayloadRef(
    context,
    "Account",
    metadata.sourceObjectId,
    metadata.sourceUpdatedAt,
    metadata.sourcePayloadRef
  );

  return resourceEnvelope(
    context,
    "Account",
    metadata.sourceObjectId,
    {
      sourceAccountId: metadata.sourceObjectId,
      name: requiredString(input, "name", `QuickBooks account ${metadata.sourceObjectId}`),
      accountType,
      ...(accountSubType === undefined ? {} : { accountSubType }),
      ...(classification === undefined ? {} : { classification }),
      ...(resolvedParentAccountId === undefined
        ? {}
        : {
            parentAccountRef: {
              sourceObjectId: resolvedParentAccountId,
              ...(resolvedParentAccountName === undefined ? {} : { displayName: resolvedParentAccountName })
            }
          }),
      ...(active === undefined ? {} : { active }),
      ...(currency?.value === undefined ? {} : { currencyCode: currency.value }),
      ...(metadata.sourceUpdatedAt === undefined ? {} : { sourceUpdatedAt: metadata.sourceUpdatedAt }),
      sourcePayloadRef
    },
    metadata.sourceUpdatedAt,
    sourcePayloadRef,
    resourceAction(input, context)
  );
}

function partyResource(
  context: AdapterContext,
  value: unknown,
  index: number
): NormalizedQuickBooksPartyResource {
  const input = record(value, `normalizedResources.parties[${String(index)}]`);
  const metadata = providerMetadata(input, `normalizedResources.parties[${String(index)}]`);
  const partyType = requiredString(input, "partyType", `QuickBooks party ${metadata.sourceObjectId}`);
  if (partyType !== "customer" && partyType !== "vendor") {
    throw new Error(`QuickBooks party ${metadata.sourceObjectId} has unsupported partyType ${partyType}.`);
  }
  const sourcePayloadRef = safeSourcePayloadRef(
    context,
    metadata.sourceObject,
    metadata.sourceObjectId,
    metadata.sourceUpdatedAt,
    metadata.sourcePayloadRef
  );
  const active = optionalBoolean(input, "active");
  return resourceEnvelope(
    context,
    "Party",
    metadata.sourceObjectId,
    {
      sourceObjectId: metadata.sourceObjectId,
      displayName: requiredString(input, "displayName", `QuickBooks party ${metadata.sourceObjectId}`),
      partyType,
      ...(active === undefined ? {} : { active }),
      ...(metadata.sourceUpdatedAt === undefined ? {} : { sourceUpdatedAt: metadata.sourceUpdatedAt }),
      sourcePayloadRef
    },
    metadata.sourceUpdatedAt,
    sourcePayloadRef,
    resourceAction(input, context)
  );
}

function itemResource(
  context: AdapterContext,
  value: unknown,
  index: number
): NormalizedQuickBooksItemResource {
  const input = record(value, `normalizedResources.items[${String(index)}]`);
  const metadata = providerMetadata(input, `normalizedResources.items[${String(index)}]`);
  const sourcePayloadRef = safeSourcePayloadRef(
    context,
    "Item",
    metadata.sourceObjectId,
    metadata.sourceUpdatedAt,
    metadata.sourcePayloadRef
  );
  const incomeAccountRef = normalizedReference(optionalReference(input.incomeAccountRef));
  const expenseAccountRef = normalizedReference(optionalReference(input.expenseAccountRef));
  const assetAccountRef = normalizedReference(optionalReference(input.assetAccountRef));
  const itemType = normalizedItemType(optionalString(input, "itemType"));
  return resourceEnvelope(
    context,
    "Item",
    metadata.sourceObjectId,
    {
      sourceObjectId: metadata.sourceObjectId,
      name: requiredString(input, "name", `QuickBooks item ${metadata.sourceObjectId}`),
      ...(itemType === undefined ? {} : { itemType }),
      ...(incomeAccountRef === undefined ? {} : { incomeAccountRef }),
      ...(expenseAccountRef === undefined ? {} : { expenseAccountRef }),
      ...(assetAccountRef === undefined ? {} : { assetAccountRef }),
      active: optionalBoolean(input, "active") ?? optionalString(input, "status") !== "inactive",
      ...(metadata.sourceUpdatedAt === undefined ? {} : { sourceUpdatedAt: metadata.sourceUpdatedAt })
    },
    metadata.sourceUpdatedAt,
    sourcePayloadRef,
    resourceAction(input, context)
  );
}

function classResource(
  context: AdapterContext,
  value: unknown,
  index: number
): NormalizedQuickBooksClassResource {
  const input = record(value, `normalizedResources.classes[${String(index)}]`);
  const metadata = providerMetadata(input, `normalizedResources.classes[${String(index)}]`);
  return dimensionResource(context, input, metadata, "Class", "class");
}

function departmentResource(
  context: AdapterContext,
  value: unknown,
  index: number
): NormalizedQuickBooksDepartmentResource {
  const input = record(value, `normalizedResources.locations[${String(index)}]`);
  const metadata = providerMetadata(input, `normalizedResources.locations[${String(index)}]`);
  return dimensionResource(context, input, metadata, "Department", "department");
}

function dimensionResource<ResourceType extends "Class" | "Department", Kind extends "class" | "department">(
  context: AdapterContext,
  input: Record<string, unknown>,
  metadata: ProviderMetadata,
  resourceType: ResourceType,
  dimensionKind: Kind
): NormalizedQuickBooksResourceEnvelope<ResourceType, {
  readonly sourceObjectId: string;
  readonly dimensionKind: Kind;
  readonly name: string;
  readonly parentDimensionRef?: {
    readonly sourceObjectId: string;
    readonly displayName?: string;
    readonly dimensionKind: Kind;
  };
  readonly active: boolean;
  readonly sourceUpdatedAt?: string;
}> {
  const parentRef = optionalReference(input.parentRef);
  const sourcePayloadRef = safeSourcePayloadRef(
    context,
    resourceType,
    metadata.sourceObjectId,
    metadata.sourceUpdatedAt,
    metadata.sourcePayloadRef
  );
  return resourceEnvelope(
    context,
    resourceType,
    metadata.sourceObjectId,
    {
      sourceObjectId: metadata.sourceObjectId,
      dimensionKind,
      name: requiredString(input, "name", `QuickBooks ${dimensionKind} ${metadata.sourceObjectId}`),
      ...(parentRef === undefined
        ? {}
        : {
            parentDimensionRef: {
              sourceObjectId: parentRef.value,
              ...(parentRef.name === undefined ? {} : { displayName: parentRef.name }),
              dimensionKind
            }
          }),
      active: optionalBoolean(input, "active") ?? optionalString(input, "status") !== "inactive",
      ...(metadata.sourceUpdatedAt === undefined ? {} : { sourceUpdatedAt: metadata.sourceUpdatedAt })
    },
    metadata.sourceUpdatedAt,
    sourcePayloadRef,
    resourceAction(input, context)
  );
}

function ledgerTransactionResources(
  context: AdapterContext,
  values: readonly unknown[],
  transactionValues: readonly unknown[],
  transactionLineValues: readonly unknown[]
): readonly NormalizedQuickBooksLedgerTransactionResource[] {
  const transactionHeaders = new Map<string, Record<string, unknown>>();
  transactionValues.forEach((value, index) => {
    const input = record(value, `normalizedResources.transactions[${String(index)}]`);
    const metadata = providerMetadata(input, `normalizedResources.transactions[${String(index)}]`);
    transactionHeaders.set(`${metadata.sourceObject}:${metadata.sourceObjectId}`, input);
  });
  const transactionLines = new Map<string, Record<string, unknown>>();
  transactionLineValues.forEach((value, index) => {
    const input = record(value, `normalizedResources.transaction_lines[${String(index)}]`);
    const metadata = providerMetadata(input, `normalizedResources.transaction_lines[${String(index)}]`);
    const transactionId = requiredString(input, "transactionId", `QuickBooks transaction line ${metadata.sourceObjectId}`);
    const lineId = requiredString(input, "lineId", `QuickBooks transaction line ${metadata.sourceObjectId}`);
    transactionLines.set(`${metadata.sourceObject}:${transactionId}:${lineId}`, input);
  });
  const grouped = new Map<string, Array<{ readonly input: Record<string, unknown>; readonly metadata: ProviderMetadata }>>();
  values.forEach((value, index) => {
    const input = record(value, `normalizedResources.ledger_entries[${String(index)}]`);
    const metadata = providerMetadata(input, `normalizedResources.ledger_entries[${String(index)}]`);
    // QuickBooks includes zero-value detail/subtotal rows in the normalized
    // ledger feed. They carry source context but have no accounting effect and
    // cannot form a valid single-sided canonical posting.
    if (requiredFiniteNumber(input, "amount", `QuickBooks ledger entry ${metadata.sourceObjectId}`) === 0) {
      return;
    }
    const transactionId = requiredString(input, "transactionId", `QuickBooks ledger entry ${metadata.sourceObjectId}`);
    const key = `${metadata.sourceObject}:${transactionId}`;
    grouped.set(key, [...(grouped.get(key) ?? []), { input, metadata }]);
  });

  return [...grouped.entries()].map(([key, entries]) =>
    ledgerTransactionResource(context, entries, transactionHeaders.get(key), transactionLines)
  );
}

function ledgerTransactionResource(
  context: AdapterContext,
  entries: readonly { readonly input: Record<string, unknown>; readonly metadata: ProviderMetadata }[],
  header: Record<string, unknown> | undefined,
  transactionLines: ReadonlyMap<string, Record<string, unknown>>
): NormalizedQuickBooksLedgerTransactionResource {
  const first = entries[0];
  if (first === undefined) {
    throw new Error("Cannot adapt an empty QuickBooks ledger transaction.");
  }
  const transactionId = requiredString(first.input, "transactionId", `QuickBooks ledger entry ${first.metadata.sourceObjectId}`);
  const transactionDate = optionalString(first.input, "transactionDate") ?? first.metadata.importedAt.slice(0, 10);
  const transactionNumber = optionalString(header, "documentNumber") ?? optionalString(first.input, "documentNumber");
  const postedAt = optionalString(first.input, "postedAt");
  const partyRef = normalizedPartyReference(
    optionalReference(header?.party ?? first.input.party),
    quickBooksPartyType(first.metadata.sourceObject)
  );
  const dueDate = optionalString(header, "dueDate");
  const totalAmount = optionalNumber(header, "amount");
  const openAmount = optionalNumber(header, "balance");
  const unappliedAmount = optionalNumber(header, "unappliedAmount");
  const emailStatus = optionalString(header, "emailStatus");
  const printStatus = optionalString(header, "printStatus");
  const groupedLines = new Map<string, typeof entries[number][] >();
  for (const entry of entries) {
    const lineId = requiredString(entry.input, "lineId", `QuickBooks ledger entry ${entry.metadata.sourceObjectId}`);
    groupedLines.set(lineId, [...(groupedLines.get(lineId) ?? []), entry]);
  }
  const sourcePayloadRef = safeSourcePayloadRef(
    context,
    first.metadata.sourceObject,
    transactionId,
    first.metadata.sourceUpdatedAt,
    first.metadata.sourcePayloadRef
  );
  const transaction: NormalizedQuickBooksLedgerTransaction = {
    sourceTransactionId: transactionId,
    sourceTransactionType: first.metadata.sourceObject,
    transactionDate,
    ...(transactionNumber === undefined ? {} : { transactionNumber }),
    ...(dueDate === undefined ? {} : { dueDate }),
    ...(totalAmount === undefined ? {} : { totalAmount: decimalFromNumber(totalAmount) }),
      ...(optionalNumber(header, "totalTax") === undefined ? {} : { totalTax: decimalFromNumber(optionalNumber(header, "totalTax")!) }),
      ...(optionalString(header, "taxCalculation") === undefined ? {} : { taxCalculation: optionalString(header, "taxCalculation")! }),
    ...(openAmount === undefined ? {} : { openAmount: decimalFromNumber(openAmount) }),
    ...(unappliedAmount === undefined ? {} : { unappliedAmount: decimalFromNumber(unappliedAmount) }),
    ...(emailStatus === undefined ? {} : { emailStatus }),
    ...(printStatus === undefined ? {} : { printStatus }),
    ...(postedAt === undefined ? {} : { postedAt }),
    ...(first.metadata.sourceUpdatedAt === undefined ? {} : { sourceUpdatedAt: first.metadata.sourceUpdatedAt }),
    ...(partyRef === undefined ? {} : { partyRef }),
    currencyCode: optionalReference(first.input.currency)?.value ?? context.currencyCode,
    lines: [...groupedLines.values()].map((lineEntries, index) =>
      ledgerLine(context, lineEntries, index, transactionLines)
    ),
    sourcePayloadRef
  };

  return resourceEnvelope(
    context,
    "LedgerTransaction",
    transactionId,
    transaction,
    first.metadata.sourceUpdatedAt,
    sourcePayloadRef,
    combinedResourceAction(entries.map((entry) => resourceAction(entry.input, context)), context)
  );
}

function ledgerLine(
  context: AdapterContext,
  entries: readonly { readonly input: Record<string, unknown>; readonly metadata: ProviderMetadata }[],
  lineIndex: number,
  transactionLines: ReadonlyMap<string, Record<string, unknown>>
): NormalizedQuickBooksLedgerLine {
  const first = entries[0];
  if (first === undefined) {
    throw new Error("Cannot adapt an empty QuickBooks ledger line.");
  }
  const lineId = requiredString(first.input, "lineId", `QuickBooks ledger entry ${first.metadata.sourceObjectId}`);
  const transactionId = requiredString(first.input, "transactionId", `QuickBooks ledger entry ${first.metadata.sourceObjectId}`);
  const normalizedLine = normalizedTransactionLine(
    transactionLines,
    first.metadata.sourceObject,
    transactionId,
    lineId
  );
  const linkedTransactions = normalizedQuickBooksLinkedTransactions(normalizedLine?.linkedTransactions);
  const sourceAmount = optionalNumber(normalizedLine, "amount");
  const sourceQuantity = optionalNumber(normalizedLine, "quantity");
  const sourceUnitAmount = optionalNumber(normalizedLine, "unitAmount");
  const taxCode = optionalReference(normalizedLine?.taxCode)?.value;
  const postings = entries.map((entry, index) => ledgerPosting(context, entry.input, entry.metadata, index));
  const amount = postings.reduce(
    (sum, posting) => sum + Number(posting.debitAmount ?? "0") - Number(posting.creditAmount ?? "0"),
    0
  );
  const sourcePayloadRef = safeSourcePayloadRef(
    context,
    `${first.metadata.sourceObject}Line`,
    `${transactionId}:${lineId}`,
    first.metadata.sourceUpdatedAt,
    first.metadata.sourcePayloadRef
  );
  const firstPosting = postings[0];
  const description = optionalString(first.input, "description");
  return {
    sourceLineId: lineId,
    lineNumber: lineIndex + 1,
    ...(description === undefined ? {} : { description }),
    amount: decimalFromNumber(amount),
    ...(sourceAmount === undefined ? {} : { sourceAmount: decimalFromNumber(sourceAmount) }),
    ...(sourceQuantity === undefined ? {} : { sourceQuantity: commercialDecimalFromNumber(sourceQuantity) }),
    ...(sourceUnitAmount === undefined ? {} : { sourceUnitAmount: commercialDecimalFromNumber(sourceUnitAmount) }),
    ...(taxCode === undefined ? {} : { taxCode }),
    ...(firstPosting === undefined ? {} : { accountRef: firstPosting.accountRef }),
    ...(firstPosting?.partyRef === undefined ? {} : { partyRef: firstPosting.partyRef }),
    ...(firstPosting?.itemRef === undefined ? {} : { itemRef: firstPosting.itemRef }),
    dimensionRefs: firstPosting?.dimensionRefs ?? [],
    ...(linkedTransactions.length === 0 ? {} : { linkedTransactions }),
    postings,
    sourcePayloadRef
  };
}

function normalizedTransactionLine(
  transactionLines: ReadonlyMap<string, Record<string, unknown>>,
  sourceObject: string,
  transactionId: string,
  ledgerLineId: string
): Record<string, unknown> | undefined {
  const exact = transactionLines.get(`${sourceObject}:${transactionId}:${ledgerLineId}`);
  if (exact !== undefined) return exact;

  const derivedPrefix = sourceObject === "Payment"
    ? "derived-ar-"
    : sourceObject === "BillPayment"
      ? "derived-ap-"
      : undefined;
  if (derivedPrefix === undefined || !ledgerLineId.startsWith(derivedPrefix)) return undefined;

  const sourceLineId = ledgerLineId.slice(derivedPrefix.length);
  if (sourceLineId.length === 0 || sourceLineId === "offset" || sourceLineId === "unapplied") return undefined;
  return transactionLines.get(`${sourceObject}:${transactionId}:${sourceLineId}`);
}

function ledgerPosting(
  context: AdapterContext,
  input: Record<string, unknown>,
  metadata: ProviderMetadata,
  index: number
): NormalizedQuickBooksLedgerPosting {
  const postingType = requiredString(input, "postingType", `QuickBooks ledger entry ${metadata.sourceObjectId}`);
  if (postingType !== "Debit" && postingType !== "Credit") {
    throw new Error(
      `QuickBooks ledger entry ${metadata.sourceObjectId} has invalid postingType ${postingType}; expected Debit or Credit.`
    );
  }
  const amount = requiredFiniteNumber(input, "amount", `QuickBooks ledger entry ${metadata.sourceObjectId}`);
  const account = optionalReference(input.account);
  if (account === undefined) {
    throw new Error(`QuickBooks ledger entry ${metadata.sourceObjectId} is missing account.value.`);
  }
  const transactionDate = optionalString(input, "transactionDate") ?? metadata.importedAt.slice(0, 10);
  const partyRef = normalizedPartyReference(optionalReference(input.party), "other");
  const itemRef = normalizedReference(optionalReference(input.item));
  const dimensionRefs = [
    normalizedDimensionReference(optionalReference(input.classRef), "class"),
    normalizedDimensionReference(optionalReference(input.department), "department")
  ].filter((value) => value !== undefined);
  const sourcePayloadRef = safeSourcePayloadRef(
    context,
    `${metadata.sourceObject}Posting`,
    metadata.sourceObjectId || `${requiredString(input, "transactionId", "QuickBooks ledger entry")}:${String(index + 1)}`,
    metadata.sourceUpdatedAt,
    metadata.sourcePayloadRef
  );
  const absoluteAmount = decimalFromNumber(Math.abs(amount));
  // QuickBooks represents reversing detail rows as a negative amount on the
  // nominal posting side. Canonical postings are nonnegative, so retain the
  // signed accounting effect by moving a negative amount to the opposite side.
  const effectivePostingType = amount < 0
    ? postingType === "Debit" ? "Credit" : "Debit"
    : postingType;

  return {
    sourcePostingId: metadata.id,
    accountRef: { sourceObjectId: account.value, ...(account.name === undefined ? {} : { displayName: account.name }) },
    postingDate: transactionDate,
    accountingBasis: context.accountingBasis,
    ...(effectivePostingType === "Debit" ? { debitAmount: absoluteAmount } : { creditAmount: absoluteAmount }),
    currencyCode: optionalReference(input.currency)?.value ?? context.currencyCode,
    ...(partyRef === undefined ? {} : { partyRef }),
    ...(itemRef === undefined ? {} : { itemRef }),
    dimensionRefs,
    sourcePayloadRef
  };
}

function resourceEnvelope<ResourceType extends string, Resource>(
  context: AdapterContext,
  resourceType: ResourceType,
  resourceId: string,
  resource: Resource,
  sourceUpdatedAt: string | undefined,
  sourcePayloadRef: SafeSourcePayloadRef,
  syncAction = context.syncAction
): NormalizedQuickBooksResourceEnvelope<ResourceType, Resource> {
  return {
    sourceSystem: "quickbooks",
    tenantId: context.tenantId,
    sourceId: context.sourceId,
    providerEnvironment: context.providerEnvironment,
    realmId: context.realmId,
    resourceType,
    resourceId,
    importBatchId: context.importBatchId,
    checkpointId: context.checkpointId,
    ...(sourceUpdatedAt === undefined ? {} : { sourceUpdatedAt }),
    ...(syncAction === undefined ? {} : { syncAction }),
    sourcePayloadRef,
    resource
  };
}

type ProviderMetadata = {
  readonly id: string;
  readonly sourceObject: string;
  readonly sourceObjectId: string;
  readonly importedAt: string;
  readonly sourceUpdatedAt?: string;
  readonly sourcePayloadRef?: string;
};

function providerMetadata(input: Record<string, unknown>, label: string): ProviderMetadata {
  const audit = optionalRecord(input.audit);
  const sourceUpdatedAt = optionalString(input, "sourceUpdatedAt");
  const sourcePayloadRef = optionalString(audit, "sourcePayloadRef");
  return {
    id: requiredString(input, "id", label),
    sourceObject: requiredString(input, "sourceObject", label),
    sourceObjectId: requiredString(input, "sourceObjectId", label),
    importedAt: requiredString(input, "importedAt", label),
    ...(sourceUpdatedAt === undefined ? {} : { sourceUpdatedAt }),
    ...(sourcePayloadRef === undefined ? {} : { sourcePayloadRef })
  };
}

function validateNormalizedResourceIdentity(
  resources: HandrailQuickBooksSdkNormalizedResourceMap,
  context: AdapterContext
): void {
  for (const [family, values] of Object.entries(resources)) {
    for (const [index, value] of values.entries()) {
      const input = record(value, `normalizedResources.${family}[${String(index)}]`);
      const tenantId = requiredString(input, "tenantId", `normalizedResources.${family}[${String(index)}]`);
      const realmId = requiredString(input, "realmId", `normalizedResources.${family}[${String(index)}]`);
      const providerEnvironment = requiredString(
        input,
        "providerEnvironment",
        `normalizedResources.${family}[${String(index)}]`
      );
      const importBatchId = requiredString(
        input,
        "importBatchId",
        `normalizedResources.${family}[${String(index)}]`
      );
      if (tenantId !== context.tenantId || realmId !== context.realmId || providerEnvironment !== context.providerEnvironment) {
        throw new Error(
          `QuickBooks ${family} resource identity does not match tenant ${context.tenantId}, realm ${context.realmId}, and provider environment ${context.providerEnvironment}.`
        );
      }
      if (importBatchId !== context.importBatchId) {
        throw new Error(
          `QuickBooks ${family} resource import batch ${importBatchId} does not match envelope import batch ${context.importBatchId}.`
        );
      }
      if (requiredString(input, "provider", `normalizedResources.${family}[${String(index)}]`) !== "intuit") {
        throw new Error(`QuickBooks ${family} resource provider must be intuit.`);
      }
      if (requiredString(input, "source", `normalizedResources.${family}[${String(index)}]`) !== "quickbooks_accounting_api") {
        throw new Error(`QuickBooks ${family} resource source must be quickbooks_accounting_api.`);
      }
    }
  }
}

function sdkWarningSummary(
  response: HandrailQuickBooksSdkNormalizedSyncEnvelope,
  recordDispositions: readonly SourceRecordDisposition[] = []
): NormalizedAccountingSyncIssueSummary | undefined {
  const issues: NormalizedAccountingSyncIssue[] = (response.normalizationWarnings ?? []).map((warning) => ({
    code: warning.code,
    message: warning.message,
    severity: "warning",
    resourceType: warning.objectType,
    resourceId: warning.transactionId
  }));
  const completeness = response.normalizedCompleteness;
  if (completeness !== undefined) {
    for (const [family, value] of Object.entries(completeness)) {
      const item = optionalRecord(value);
      const status = optionalString(item, "status");
      const complete = item.complete;
      if (status === "complete" || complete === true) {
        continue;
      }
      const reason = optionalString(item, "reason") ?? "QuickBooks normalized resource completeness is not confirmed.";
      issues.push({
        code: `quickbooks_normalized_${family}_${status ?? "unknown"}`,
        message: reason,
        severity: status === "incomplete" || complete === false ? "warning" : "info",
        resourceType: family
      });
    }
  }
  for (const disposition of recordDispositions) {
    issues.push({
      code: "source_record_disposition",
      message: `Source record was explicitly excluded from canonical financial projection: ${disposition.reason}.`,
      severity: "warning",
      resourceType: disposition.sourceRecordType,
      resourceId: disposition.sourceRecordId,
      sourcePayloadRef: disposition.sourcePayloadRef
    });
  }
  return issues.length === 0 ? undefined : { count: issues.length, items: issues };
}

function assertSdkEnvelopeNoCredentials(response: HandrailQuickBooksSdkNormalizedSyncEnvelope): void {
  const envelope = { ...response };
  const syncJob = { ...response.syncJob };
  delete envelope.providerDispositions;
  delete syncJob.providerDispositions;
  assertNoCredentialKeys({ ...envelope, syncJob });
}

function importBatchStatus(
  status: string,
  warningSummary: NormalizedAccountingSyncIssueSummary | undefined
): ImportBatchStatus {
  if (status === "failed" || status === "cancelled") {
    return "failed";
  }
  if (status === "succeeded" || status === "completed") {
    return warningSummary === undefined ? "completed" : "completed_with_warnings";
  }
  return "running";
}

function checkpointStatus(status: string): "current" | "stale" | "error" {
  if (status === "failed" || status === "cancelled") {
    return "error";
  }
  return status === "succeeded" || status === "completed" ? "current" : "stale";
}

function resourceAction(
  input: Record<string, unknown>,
  context: AdapterContext
): NormalizedAccountingSyncResourceAction | undefined {
  const value = optionalString(input, "syncAction");
  if (value === undefined) {
    return context.syncAction;
  }
  if (value === "changed" || value === "deleted" || value === "voided" || value === "skipped") {
    return value;
  }
  throw new Error(`Unsupported QuickBooks syncAction ${value}.`);
}

function combinedResourceAction(
  actions: readonly (NormalizedAccountingSyncResourceAction | undefined)[],
  context: AdapterContext
): NormalizedAccountingSyncResourceAction | undefined {
  for (const action of ["deleted", "voided", "changed", "skipped"] as const) {
    if (actions.includes(action)) {
      return action;
    }
  }
  return context.syncAction;
}

function safeSourcePayloadRef(
  context: AdapterContext,
  sourceObjectType: string,
  sourceObjectId: string,
  sourceUpdatedAt?: string,
  candidate?: string
): SafeSourcePayloadRef {
  const storageRef = safeStorageRef(candidate) ??
    `provider://quickbooks/${context.providerEnvironment}/realm/${context.realmId}/${sourceObjectType}/${sourceObjectId}`;
  return {
    sourceObjectType,
    sourceObjectId,
    ...(sourceUpdatedAt === undefined ? {} : { sourceUpdatedAt }),
    storageRef,
    preview: {
      checkpointId: context.checkpointId,
      importBatchId: context.importBatchId,
      providerEnvironment: context.providerEnvironment,
      realmId: context.realmId
    }
  };
}

function safeStorageRef(value: string | undefined): string | undefined {
  if (
    value === undefined ||
    !SAFE_SOURCE_REF_PATTERN.test(value) ||
    SECRET_VALUE_PATTERN.test(value) ||
    Buffer.byteLength(value, "utf8") > MAX_SOURCE_REF_BYTES
  ) {
    return undefined;
  }
  return value;
}

function normalizedReference(
  value: { readonly value: string; readonly name?: string } | undefined
): { readonly sourceObjectId: string; readonly displayName?: string } | undefined {
  return value === undefined
    ? undefined
    : { sourceObjectId: value.value, ...(value.name === undefined ? {} : { displayName: value.name }) };
}

function normalizedPartyReference(
  value: { readonly value: string; readonly name?: string } | undefined,
  partyType: "customer" | "vendor" | "employee" | "other"
) {
  const ref = normalizedReference(value);
  return ref === undefined ? undefined : { ...ref, partyType };
}

function normalizedDimensionReference(
  value: { readonly value: string; readonly name?: string } | undefined,
  dimensionKind: "class" | "department"
) {
  const ref = normalizedReference(value);
  return ref === undefined ? undefined : { ...ref, dimensionKind };
}

function optionalReference(value: unknown): { readonly value: string; readonly name?: string } | undefined {
  const input = optionalRecord(value);
  const refValue = optionalString(input, "value");
  if (refValue === undefined) {
    return undefined;
  }
  const name = optionalString(input, "name");
  return { value: refValue, ...(name === undefined ? {} : { name }) };
}

function normalizedItemType(value: string | undefined): "inventory" | "service" | "product" | "other" | undefined {
  switch (value?.trim().toLowerCase()) {
    case "inventory":
      return "inventory";
    case "service":
      return "service";
    case "noninventory":
    case "product":
      return "product";
    case "group":
    case "category":
      return "other";
    default:
      return undefined;
  }
}

function normalizedAccountClassification(
  value: string | undefined
): "asset" | "liability" | "equity" | "income" | "expense" | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized === "asset" || normalized === "liability" || normalized === "equity" ||
    normalized === "income" || normalized === "expense"
    ? normalized
    : undefined;
}

function quickBooksPartyType(sourceObject: string): "customer" | "vendor" | "other" {
  if (["Invoice", "Payment", "CreditMemo", "RefundReceipt", "SalesReceipt"].includes(sourceObject)) {
    return "customer";
  }
  if (["Bill", "BillPayment", "Purchase", "VendorCredit"].includes(sourceObject)) {
    return "vendor";
  }
  return "other";
}

function quickBooksOperationalLinePartyType(
  sourceObject: string,
  lineParty: { readonly value: string } | undefined,
  transactionParty: { readonly value: string } | undefined
): "customer" | "vendor" | "other" {
  if (
    ["Bill", "Purchase", "VendorCredit"].includes(sourceObject) &&
    lineParty !== undefined &&
    lineParty.value !== transactionParty?.value
  ) {
    // QuickBooks uses CustomerRef on payable expense lines to preserve the
    // customer/job allocation. The normalized connector exposes that value as
    // the line party, while the transaction party remains the vendor.
    return "customer";
  }
  return quickBooksPartyType(sourceObject);
}

function firstNormalizedResource(resources: HandrailQuickBooksSdkNormalizedResourceMap): unknown {
  return Object.values(resources).find((values) => values.length > 0)?.[0];
}

function latestResourceUpdatedAt(resources: HandrailQuickBooksSdkNormalizedResourceMap): string | undefined {
  return Object.values(resources)
    .flatMap((values) => values)
    .map((value) => optionalString(optionalRecord(value), "sourceUpdatedAt"))
    .filter((value): value is string => value !== undefined)
    .sort()
    .at(-1);
}

function normalizeResourceCounts(
  counts: Partial<Record<HandrailQuickBooksSdkNormalizedResourceFamily, number>>
): Readonly<Record<string, number>> {
  return Object.fromEntries(
    Object.entries(counts).filter((entry): entry is [string, number] => Number.isFinite(entry[1]))
  );
}

function readProviderEnvironment(value: string | undefined): NormalizedQuickBooksProviderEnvironment {
  if (value === "sandbox" || value === "production") {
    return value;
  }
  throw new Error("QuickBooks provider environment must be sandbox or production.");
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function optionalRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requiredString(input: Record<string, unknown>, key: string, label: string): string {
  const value = optionalString(input, key);
  if (value === undefined) {
    throw new Error(`${label} is missing ${key}.`);
  }
  return value;
}

function optionalString(input: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = input?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalBoolean(input: Record<string, unknown>, key: string): boolean | undefined {
  const value = input[key];
  return typeof value === "boolean" ? value : undefined;
}

function optionalNumber(input: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = input?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizedQuickBooksLinkedTransactions(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const linked = optionalRecord(candidate);
    const sourceTransactionId = optionalString(linked, "transactionId");
    if (sourceTransactionId === undefined) return [];
    const sourceTransactionType = optionalString(linked, "transactionType");
    const sourceLineId = optionalString(linked, "transactionLineId");
    return [{
      sourceTransactionId,
      ...(sourceTransactionType === undefined ? {} : { sourceTransactionType }),
      ...(sourceLineId === undefined ? {} : { sourceLineId })
    }];
  });
}

function requiredFiniteNumber(input: Record<string, unknown>, key: string, label: string): number {
  const value = input[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} is missing finite ${key}.`);
  }
  return value;
}

function decimalFromNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error("QuickBooks amount must be finite.");
  }
  return value.toFixed(2);
}

function commercialDecimalFromNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error("QuickBooks commercial value must be finite.");
  // toFixed introduces binary-float noise at high precision (e.g. 215999.9568).
  // Expand the number's shortest decimal representation without further arithmetic.
  const [coefficient, exponent = "0"] = String(value).split("e");
  const negative = coefficient!.startsWith("-");
  const [whole, fraction = ""] = (negative ? coefficient!.slice(1) : coefficient!).split(".");
  const digits = whole! + fraction;
  const point = whole!.length + Number(exponent);
  const expanded = point <= 0 ? `0.${"0".repeat(-point)}${digits}`
    : point >= digits.length ? digits + "0".repeat(point - digits.length)
    : `${digits.slice(0, point)}.${digits.slice(point)}`;
  const [integer, decimal = ""] = expanded.split(".");
  const precise = decimal.replace(/0+$/, "");
  if (precise.length > 12) throw new Error("QuickBooks commercial precision exceeds twelve decimal places.");
  return `${negative ? "-" : ""}${integer}.${precise.padEnd(2, "0")}`;
}
