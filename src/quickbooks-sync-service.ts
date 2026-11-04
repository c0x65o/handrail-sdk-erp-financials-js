import {
  assertNoCredentialKeys,
  assertSafeSourcePayloadRef
} from "./canonical-model.js";
import { sanitizeQuickBooksProviderReportAccountTotals } from "./quickbooks-provider-report-parity.js";
import type {
  DecimalString,
  ImportBatchStatus,
  IsoDateTime,
  JsonValue,
  ReconciliationStatus,
  SafeSourcePayloadRef
} from "./canonical-model.js";
import type {
  NormalizedAccountingImportBatchMetadata,
  NormalizedAccountingReconciliationEvidence,
  NormalizedAccountingReconciliationTotal,
  NormalizedAccountingResourceCounts,
  NormalizedAccountingSyncCheckpointMetadata,
  NormalizedQuickBooksCheckpointResumeRequestEnvelope,
  NormalizedQuickBooksBalanceSheetReportRequestEnvelope,
  NormalizedQuickBooksBalanceSheetReportResponseEnvelope,
  NormalizedQuickBooksCashFlowParityReportRequestEnvelope,
  NormalizedQuickBooksCashFlowParityReportResponseEnvelope,
  NormalizedQuickBooksFullSyncRequestEnvelope,
  NormalizedQuickBooksFullSyncResponseEnvelope,
  NormalizedQuickBooksIncrementalSyncRequestEnvelope,
  NormalizedQuickBooksIncrementalSyncResponseEnvelope,
  NormalizedQuickBooksCanonicalReportTotal,
  NormalizedQuickBooksProfitAndLossReportRequestEnvelope,
  NormalizedQuickBooksProfitAndLossReportResponseEnvelope,
  NormalizedQuickBooksProviderReportName,
  NormalizedQuickBooksProviderReportRef,
  NormalizedQuickBooksProviderReportRequestEnvelope,
  NormalizedQuickBooksProviderReportResponseEnvelope,
  NormalizedQuickBooksProviderReportResult,
  NormalizedQuickBooksProviderReportTotal,
  NormalizedQuickBooksResourceEnvelope,
  NormalizedQuickBooksResourceSet,
  NormalizedQuickBooksServiceAvailability,
  NormalizedQuickBooksServiceEnvironment,
  NormalizedQuickBooksServiceHealthCapabilities,
  NormalizedQuickBooksServiceHealthCapability,
  NormalizedQuickBooksServiceHealthCapabilityStatus,
  NormalizedQuickBooksServiceHealthCheckpoint,
  NormalizedQuickBooksServiceHealthIssue,
  NormalizedQuickBooksServiceHealthProbeRequest,
  NormalizedQuickBooksServiceHealthProbeResponseEnvelope,
  NormalizedQuickBooksServiceHealthStatus,
  NormalizedQuickBooksSourceIdentity,
  NormalizedQuickBooksSyncResourceSet,
  NormalizedQuickBooksTrialBalanceReportRequestEnvelope,
  NormalizedQuickBooksTrialBalanceReportResponseEnvelope
} from "./normalized-accounting-contracts.js";
import {
  assertSourceRecordDispositionAdvisories,
  assertSourceRecordDispositionsExcluded
} from "./source-record-dispositions.js";

export type HandrailQuickBooksIncrementalSyncRequest =
  NormalizedQuickBooksIncrementalSyncRequestEnvelope & {
    readonly resumeFromCheckpointId?: NormalizedQuickBooksCheckpointResumeRequestEnvelope<"incremental">["resumeFromCheckpointId"];
  };

export type HandrailQuickBooksFullSyncProvider = (
  request: NormalizedQuickBooksFullSyncRequestEnvelope
) => NormalizedQuickBooksResourceSet | Promise<NormalizedQuickBooksResourceSet>;

export type HandrailQuickBooksIncrementalSyncProvider = (
  request: HandrailQuickBooksIncrementalSyncRequest
) => NormalizedQuickBooksSyncResourceSet | Promise<NormalizedQuickBooksSyncResourceSet>;

export type HandrailQuickBooksProviderReportProvider = (
  request: NormalizedQuickBooksProviderReportRequestEnvelope
) => NormalizedQuickBooksProviderReportResult | Promise<NormalizedQuickBooksProviderReportResult>;

export type NormalizedQuickBooksServiceHealthProbeEvidence = {
  readonly status: NormalizedQuickBooksServiceHealthStatus;
  readonly serviceAvailability?: NormalizedQuickBooksServiceAvailability;
  readonly providerMode?: NormalizedQuickBooksSourceIdentity["providerEnvironment"];
  readonly serviceEnvironment?: NormalizedQuickBooksServiceEnvironment;
  readonly capabilities?: Partial<NormalizedQuickBooksServiceHealthCapabilities>;
  readonly checkpoint?: NormalizedQuickBooksServiceHealthCheckpoint;
  readonly checkedAt?: IsoDateTime;
  readonly message?: string;
  readonly issues?: readonly NormalizedQuickBooksServiceHealthIssue[];
};

export type HandrailQuickBooksServiceHealthProvider = (
  request: NormalizedQuickBooksServiceHealthProbeRequest
) => NormalizedQuickBooksServiceHealthProbeEvidence | Promise<NormalizedQuickBooksServiceHealthProbeEvidence>;

export type NormalizedQuickBooksProviderReportReconciliationEvidenceInput = {
  readonly providerReport: NormalizedQuickBooksProviderReportResponseEnvelope;
  readonly canonicalTotals: readonly NormalizedQuickBooksCanonicalReportTotal[];
  readonly toleranceAmount?: DecimalString;
  readonly generatedAt?: IsoDateTime;
};

export type HandrailQuickBooksFullSyncServiceHandler = {
  serviceHealth(request: NormalizedQuickBooksServiceHealthProbeRequest): Promise<NormalizedQuickBooksServiceHealthProbeResponseEnvelope>;
  fullSync(request: NormalizedQuickBooksFullSyncRequestEnvelope): Promise<NormalizedQuickBooksFullSyncResponseEnvelope>;
  incrementalSync(request: HandrailQuickBooksIncrementalSyncRequest): Promise<NormalizedQuickBooksIncrementalSyncResponseEnvelope>;
  providerReport(request: NormalizedQuickBooksProviderReportRequestEnvelope): Promise<NormalizedQuickBooksProviderReportResponseEnvelope>;
  profitAndLossReport(
    request: NormalizedQuickBooksProfitAndLossReportRequestEnvelope
  ): Promise<NormalizedQuickBooksProfitAndLossReportResponseEnvelope>;
  balanceSheetReport(
    request: NormalizedQuickBooksBalanceSheetReportRequestEnvelope
  ): Promise<NormalizedQuickBooksBalanceSheetReportResponseEnvelope>;
  trialBalanceReport(
    request: NormalizedQuickBooksTrialBalanceReportRequestEnvelope
  ): Promise<NormalizedQuickBooksTrialBalanceReportResponseEnvelope>;
  cashFlowParityReport(
    request: NormalizedQuickBooksCashFlowParityReportRequestEnvelope
  ): Promise<NormalizedQuickBooksCashFlowParityReportResponseEnvelope>;
};

export type HandrailQuickBooksFullSyncServiceOptions = {
  readonly loadFullSyncResources: HandrailQuickBooksFullSyncProvider;
  readonly loadIncrementalSyncResources?: HandrailQuickBooksIncrementalSyncProvider;
  readonly loadProviderReport?: HandrailQuickBooksProviderReportProvider;
  /** Opt in only when the provider supplies the complete, reconciled cash-flow totals contract. */
  readonly loadCashFlowProviderReport?: HandrailQuickBooksProviderReportProvider;
  readonly loadServiceHealth?: HandrailQuickBooksServiceHealthProvider;
};

export type HandrailQuickBooksSyncClientTransport = {
  readonly serviceHealth?: HandrailQuickBooksFullSyncServiceHandler["serviceHealth"];
  readonly fullSync: HandrailQuickBooksFullSyncServiceHandler["fullSync"];
  readonly incrementalSync?: HandrailQuickBooksFullSyncServiceHandler["incrementalSync"];
  readonly providerReport?: HandrailQuickBooksFullSyncServiceHandler["providerReport"];
  readonly profitAndLossReport?: HandrailQuickBooksFullSyncServiceHandler["profitAndLossReport"];
  readonly balanceSheetReport?: HandrailQuickBooksFullSyncServiceHandler["balanceSheetReport"];
  readonly trialBalanceReport?: HandrailQuickBooksFullSyncServiceHandler["trialBalanceReport"];
  readonly cashFlowParityReport?: HandrailQuickBooksFullSyncServiceHandler["cashFlowParityReport"];
};

export class HandrailQuickBooksSyncClient {
  readonly #transport: HandrailQuickBooksSyncClientTransport;

  constructor(transport: HandrailQuickBooksSyncClientTransport) {
    this.#transport = transport;
  }

  serviceHealth(request: NormalizedQuickBooksServiceHealthProbeRequest): Promise<NormalizedQuickBooksServiceHealthProbeResponseEnvelope> {
    return requireTransportMethod(this.#transport.serviceHealth, "serviceHealth")(request);
  }

  fullSync(request: NormalizedQuickBooksFullSyncRequestEnvelope): Promise<NormalizedQuickBooksFullSyncResponseEnvelope> {
    return this.#transport.fullSync(request);
  }

  incrementalSync(request: HandrailQuickBooksIncrementalSyncRequest): Promise<NormalizedQuickBooksIncrementalSyncResponseEnvelope> {
    return requireTransportMethod(this.#transport.incrementalSync, "incrementalSync")(request);
  }

  providerReport(request: NormalizedQuickBooksProviderReportRequestEnvelope): Promise<NormalizedQuickBooksProviderReportResponseEnvelope> {
    return requireTransportMethod(this.#transport.providerReport, "providerReport")(request);
  }

  profitAndLossReport(
    request: NormalizedQuickBooksProfitAndLossReportRequestEnvelope
  ): Promise<NormalizedQuickBooksProfitAndLossReportResponseEnvelope> {
    return requireTransportMethod(this.#transport.profitAndLossReport, "profitAndLossReport")(request);
  }

  balanceSheetReport(
    request: NormalizedQuickBooksBalanceSheetReportRequestEnvelope
  ): Promise<NormalizedQuickBooksBalanceSheetReportResponseEnvelope> {
    return requireTransportMethod(this.#transport.balanceSheetReport, "balanceSheetReport")(request);
  }

  trialBalanceReport(
    request: NormalizedQuickBooksTrialBalanceReportRequestEnvelope
  ): Promise<NormalizedQuickBooksTrialBalanceReportResponseEnvelope> {
    return requireTransportMethod(this.#transport.trialBalanceReport, "trialBalanceReport")(request);
  }

  cashFlowParityReport(
    request: NormalizedQuickBooksCashFlowParityReportRequestEnvelope
  ): Promise<NormalizedQuickBooksCashFlowParityReportResponseEnvelope> {
    return requireTransportMethod(this.#transport.cashFlowParityReport, "cashFlowParityReport")(request);
  }
}

export function createHandrailQuickBooksFullSyncServiceHandler(
  options: HandrailQuickBooksFullSyncServiceOptions
): HandrailQuickBooksFullSyncServiceHandler {
  return {
    async serviceHealth(request) {
      validateServiceHealthProbeRequest(request);
      const evidence =
        options.loadServiceHealth === undefined ? defaultServiceHealthProbeEvidence(options, request) : await options.loadServiceHealth(request);
      return buildQuickBooksServiceHealthProbeResponse(request, evidence);
    },
    async fullSync(request) {
      validateFullSyncRequest(request);
      const providerResources = await options.loadFullSyncResources(request);
      return buildNormalizedQuickBooksFullSyncResponse(request, providerResources);
    },
    async incrementalSync(request) {
      validateIncrementalSyncRequest(request);
      if (options.loadIncrementalSyncResources === undefined) {
        throw new Error("QuickBooks incremental sync resource loader is required for incrementalSync");
      }
      const providerResources = await options.loadIncrementalSyncResources(request);
      return buildNormalizedQuickBooksIncrementalSyncResponse(request, providerResources);
    },
    async providerReport(request) {
      return loadNormalizedQuickBooksProviderReport(options, request);
    },
    async profitAndLossReport(request) {
      validateReportName(request, "profit_and_loss");
      return (await loadNormalizedQuickBooksProviderReport(options, request)) as NormalizedQuickBooksProfitAndLossReportResponseEnvelope;
    },
    async balanceSheetReport(request) {
      validateReportName(request, "balance_sheet");
      return (await loadNormalizedQuickBooksProviderReport(options, request)) as NormalizedQuickBooksBalanceSheetReportResponseEnvelope;
    },
    async trialBalanceReport(request) {
      validateReportName(request, "trial_balance");
      return (await loadNormalizedQuickBooksProviderReport(options, request)) as NormalizedQuickBooksTrialBalanceReportResponseEnvelope;
    },
    async cashFlowParityReport(request) {
      validateReportName(request, "cash_flow");
      return await loadNormalizedQuickBooksProviderReport(options, request) as NormalizedQuickBooksCashFlowParityReportResponseEnvelope;
    }
  };
}

export function createHandrailQuickBooksSyncClient(
  transport: HandrailQuickBooksSyncClientTransport
): HandrailQuickBooksSyncClient {
  return new HandrailQuickBooksSyncClient(transport);
}

export function buildQuickBooksServiceHealthProbeResponse(
  request: NormalizedQuickBooksServiceHealthProbeRequest,
  evidence: NormalizedQuickBooksServiceHealthProbeEvidence
): NormalizedQuickBooksServiceHealthProbeResponseEnvelope {
  validateServiceHealthProbeRequest(request);
  assertNoCredentialKeys(evidence);

  const providerMode = evidence.providerMode ?? request.providerMode ?? request.sourceIdentity.providerEnvironment;
  if (providerMode !== request.sourceIdentity.providerEnvironment) {
    throw new Error(
      `QuickBooks service health providerMode ${providerMode} does not match source providerEnvironment ${request.sourceIdentity.providerEnvironment}`
    );
  }

  const status = evidence.status;
  const response: NormalizedQuickBooksServiceHealthProbeResponseEnvelope = {
    sourceIdentity: request.sourceIdentity,
    providerEnvironment: request.sourceIdentity.providerEnvironment,
    providerMode,
    ...(evidence.serviceEnvironment === undefined && request.serviceEnvironment === undefined
      ? {}
      : { serviceEnvironment: evidence.serviceEnvironment ?? request.serviceEnvironment }),
    status,
    serviceAvailability: evidence.serviceAvailability ?? serviceAvailabilityForHealthStatus(status),
    capabilities: normalizeServiceHealthCapabilities(evidence.capabilities, status, providerMode),
    checkpoint: normalizeServiceHealthCheckpoint(evidence.checkpoint, request),
    ...(request.requestedAt === undefined ? {} : { requestedAt: request.requestedAt }),
    ...(evidence.checkedAt === undefined ? {} : { checkedAt: evidence.checkedAt }),
    ...(evidence.message === undefined ? {} : { message: evidence.message }),
    ...(evidence.issues === undefined ? {} : { issues: sanitizeServiceHealthIssues(evidence.issues) })
  };
  assertNoCredentialKeys(response);
  return response;
}

function requireTransportMethod<Method extends (...args: never[]) => unknown>(
  method: Method | undefined,
  methodName: string
): Method {
  if (method === undefined) {
    throw new Error(`QuickBooks sync client transport does not implement ${methodName}`);
  }
  return method;
}

export function buildNormalizedQuickBooksFullSyncResponse(
  request: NormalizedQuickBooksFullSyncRequestEnvelope,
  providerResources: NormalizedQuickBooksResourceSet
): NormalizedQuickBooksFullSyncResponseEnvelope {
  validateFullSyncRequest(request);
  assertNoCredentialKeys(providerResources);

  const resources = sanitizeQuickBooksResourceSet(providerResources);
  validateResourceSetIdentity(request.sourceIdentity, resources);
  assertSourceRecordDispositionsExcluded(resources, request.recordDispositions, request.importBatchId);
  assertSourceRecordDispositionAdvisories(request.warningSummary, request.recordDispositions);

  const resourceCounts = countQuickBooksResources(resources);
  const importBatch = normalizeFullSyncImportBatch(request, resources.importBatch, resourceCounts);
  const checkpoint = normalizeInitialFullSyncCheckpoint(request, resources.checkpoint);
  const status: ImportBatchStatus = importBatch.status ?? "completed";

  return {
    sourceIdentity: request.sourceIdentity,
    providerEnvironment: request.sourceIdentity.providerEnvironment,
    syncMode: "full",
    importBatchId: importBatch.importBatchId,
    checkpointId: checkpoint.checkpointId,
    cursorKind: "full_scan",
    cursorValue: checkpoint.cursorValue,
    ...(checkpoint.sourceFreshThrough === undefined ? {} : { sourceFreshThrough: checkpoint.sourceFreshThrough }),
    ...(checkpoint.importedThrough === undefined ? {} : { importedThrough: checkpoint.importedThrough }),
    ...(checkpoint.freshThrough === undefined ? {} : { freshThrough: checkpoint.freshThrough }),
    ...(checkpoint.latestSourceUpdatedAt === undefined ? {} : { latestSourceUpdatedAt: checkpoint.latestSourceUpdatedAt }),
    resourceCounts,
    ...(request.warningSummary === undefined ? {} : { warningSummary: request.warningSummary }),
    ...(request.errorSummary === undefined ? {} : { errorSummary: request.errorSummary }),
    ...(request.recordDispositions === undefined ? {} : { recordDispositions: request.recordDispositions }),
    idempotencyKey: request.idempotencyKey,
    idempotencyKeys: {
      ...request.idempotencyKeys,
      importBatchId: importBatch.importBatchId,
      checkpointId: checkpoint.checkpointId
    },
    status,
    importBatch,
    checkpoint,
    resources: {
      ...resources,
      importBatch,
      checkpoint
    },
    ...(importBatch.completedAt === undefined ? {} : { completedAt: importBatch.completedAt })
  };
}

export function buildNormalizedQuickBooksIncrementalSyncResponse(
  request: HandrailQuickBooksIncrementalSyncRequest,
  providerResources: NormalizedQuickBooksSyncResourceSet
): NormalizedQuickBooksIncrementalSyncResponseEnvelope {
  validateIncrementalSyncRequest(request);
  assertNoCredentialKeys(providerResources);

  const resources = sanitizeQuickBooksSyncResourceSet(providerResources);
  validateResourceSetIdentity(request.sourceIdentity, resources);
  assertSourceRecordDispositionsExcluded(resources, request.recordDispositions, request.importBatchId);
  assertSourceRecordDispositionAdvisories(request.warningSummary, request.recordDispositions);

  const resourceCounts = countQuickBooksResources(resources);
  const importBatch = normalizeIncrementalSyncImportBatch(request, resources.importBatch, resourceCounts);
  const latestSourceUpdatedAt = resources.checkpoint?.latestSourceUpdatedAt ?? latestQuickBooksResourceUpdatedAt(resources);
  const checkpoint = normalizeIncrementalSyncCheckpoint(request, resources.checkpoint, latestSourceUpdatedAt);
  const status: ImportBatchStatus = importBatch.status ?? "completed";

  return {
    sourceIdentity: request.sourceIdentity,
    providerEnvironment: request.sourceIdentity.providerEnvironment,
    syncMode: "incremental",
    importBatchId: importBatch.importBatchId,
    checkpointId: checkpoint.checkpointId,
    cursorKind: request.cursorKind,
    cursorValue: checkpoint.cursorValue,
    ...(checkpoint.sourceFreshThrough === undefined ? {} : { sourceFreshThrough: checkpoint.sourceFreshThrough }),
    ...(checkpoint.importedThrough === undefined ? {} : { importedThrough: checkpoint.importedThrough }),
    ...(checkpoint.freshThrough === undefined ? {} : { freshThrough: checkpoint.freshThrough }),
    ...(checkpoint.latestSourceUpdatedAt === undefined ? {} : { latestSourceUpdatedAt: checkpoint.latestSourceUpdatedAt }),
    resourceCounts,
    ...(request.warningSummary === undefined ? {} : { warningSummary: request.warningSummary }),
    ...(request.errorSummary === undefined ? {} : { errorSummary: request.errorSummary }),
    ...(request.recordDispositions === undefined ? {} : { recordDispositions: request.recordDispositions }),
    idempotencyKey: request.idempotencyKey,
    idempotencyKeys: {
      ...request.idempotencyKeys,
      importBatchId: importBatch.importBatchId,
      checkpointId: checkpoint.checkpointId
    },
    status,
    importBatch,
    checkpoint,
    resources: {
      ...resources,
      importBatch,
      checkpoint
    },
    ...(importBatch.completedAt === undefined ? {} : { completedAt: importBatch.completedAt })
  };
}

export function buildNormalizedQuickBooksProviderReportResponse(
  request: NormalizedQuickBooksProviderReportRequestEnvelope,
  providerReport: NormalizedQuickBooksProviderReportResult
): NormalizedQuickBooksProviderReportResponseEnvelope {
  validateProviderReportRequest(request);
  assertNoCredentialKeys(providerReport);

  const providerReportRef = sanitizeProviderReportRef(providerReport.providerReportRef);
  validateProviderReportRef(request, providerReportRef);
  const totals = sanitizeProviderReportTotals(providerReport.totals);
  if (request.reportName === "cash_flow") validateCashFlowTotals(totals, request.currencyCode);
  const accountTotals =
    providerReport.accountTotals === undefined
      ? undefined
      : sanitizeQuickBooksProviderReportAccountTotals(providerReport.accountTotals);
  const latestSourceUpdatedAt =
    providerReport.latestSourceUpdatedAt ??
    providerReport.sourceUpdatedAt ??
    providerReportRef.sourceUpdatedAt ??
    providerReportRef.sourcePayloadRef.sourceUpdatedAt;
  const sourceFreshThrough = providerReport.sourceFreshThrough ?? latestSourceUpdatedAt ?? request.sourceFreshThrough;
  const importedThrough = providerReport.importedThrough ?? request.importedThrough ?? sourceFreshThrough;
  const importBatchId = providerReport.importBatchId ?? request.importBatchId;
  const checkpointId = providerReport.checkpointId ?? request.checkpointId;

  return {
    sourceIdentity: request.sourceIdentity,
    providerEnvironment: request.sourceIdentity.providerEnvironment,
    reportName: request.reportName,
    supportStatus: "supported",
    accountingBasis: request.accountingBasis,
    ...(request.currencyCode === undefined ? {} : { currencyCode: request.currencyCode }),
    ...(importBatchId === undefined ? {} : { importBatchId }),
    ...(checkpointId === undefined ? {} : { checkpointId }),
    ...(sourceFreshThrough === undefined ? {} : { sourceFreshThrough }),
    ...(importedThrough === undefined ? {} : { importedThrough }),
    ...(latestSourceUpdatedAt === undefined ? {} : { latestSourceUpdatedAt }),
    ...(request.periodStart === undefined ? {} : { periodStart: request.periodStart }),
    ...(request.periodEnd === undefined ? {} : { periodEnd: request.periodEnd }),
    ...(request.asOfDate === undefined ? {} : { asOfDate: request.asOfDate }),
    ...(request.requestedAt === undefined ? {} : { requestedAt: request.requestedAt }),
    providerReportRef,
    ...(latestSourceUpdatedAt === undefined ? {} : { sourceUpdatedAt: latestSourceUpdatedAt }),
    ...(providerReport.generatedAt === undefined ? {} : { generatedAt: providerReport.generatedAt }),
    totals,
    ...(accountTotals === undefined ? {} : { accountTotals })
  };
}

export function buildUnsupportedQuickBooksCashFlowParityReportResponse(
  request: NormalizedQuickBooksCashFlowParityReportRequestEnvelope | NormalizedQuickBooksProviderReportRequestEnvelope
): NormalizedQuickBooksCashFlowParityReportResponseEnvelope {
  validateProviderReportRequest(request);
  validateReportName(request, "cash_flow");

  return {
    sourceIdentity: request.sourceIdentity,
    providerEnvironment: request.sourceIdentity.providerEnvironment,
    reportName: "cash_flow",
    supportStatus: "unsupported",
    unsupportedReason: "quickbooks_cash_flow_parity_report_not_supported",
    accountingBasis: request.accountingBasis,
    ...(request.currencyCode === undefined ? {} : { currencyCode: request.currencyCode }),
    ...(request.importBatchId === undefined ? {} : { importBatchId: request.importBatchId }),
    ...(request.checkpointId === undefined ? {} : { checkpointId: request.checkpointId }),
    ...(request.sourceFreshThrough === undefined ? {} : { sourceFreshThrough: request.sourceFreshThrough }),
    ...(request.importedThrough === undefined ? {} : { importedThrough: request.importedThrough }),
    ...(request.latestSourceUpdatedAt === undefined ? {} : { latestSourceUpdatedAt: request.latestSourceUpdatedAt }),
    ...(request.periodStart === undefined ? {} : { periodStart: request.periodStart }),
    ...(request.periodEnd === undefined ? {} : { periodEnd: request.periodEnd }),
    ...(request.asOfDate === undefined ? {} : { asOfDate: request.asOfDate }),
    ...(request.requestedAt === undefined ? {} : { requestedAt: request.requestedAt }),
    totals: []
  };
}

export function buildUnavailableQuickBooksProviderReportResponse(
  request: NormalizedQuickBooksProviderReportRequestEnvelope
): NormalizedQuickBooksProviderReportResponseEnvelope {
  validateProviderReportRequest(request);

  return {
    sourceIdentity: request.sourceIdentity,
    providerEnvironment: request.sourceIdentity.providerEnvironment,
    reportName: request.reportName,
    supportStatus: "unsupported",
    unsupportedReason: "quickbooks_provider_report_unavailable",
    accountingBasis: request.accountingBasis,
    ...(request.currencyCode === undefined ? {} : { currencyCode: request.currencyCode }),
    ...(request.importBatchId === undefined ? {} : { importBatchId: request.importBatchId }),
    ...(request.checkpointId === undefined ? {} : { checkpointId: request.checkpointId }),
    ...(request.sourceFreshThrough === undefined ? {} : { sourceFreshThrough: request.sourceFreshThrough }),
    ...(request.importedThrough === undefined ? {} : { importedThrough: request.importedThrough }),
    ...(request.latestSourceUpdatedAt === undefined ? {} : { latestSourceUpdatedAt: request.latestSourceUpdatedAt }),
    ...(request.periodStart === undefined ? {} : { periodStart: request.periodStart }),
    ...(request.periodEnd === undefined ? {} : { periodEnd: request.periodEnd }),
    ...(request.asOfDate === undefined ? {} : { asOfDate: request.asOfDate }),
    ...(request.requestedAt === undefined ? {} : { requestedAt: request.requestedAt }),
    totals: []
  };
}

export function buildQuickBooksProviderReportReconciliationEvidence(
  input: NormalizedQuickBooksProviderReportReconciliationEvidenceInput
): NormalizedAccountingReconciliationEvidence {
  assertNoCredentialKeys(input);
  if (input.providerReport.supportStatus !== "supported" || input.providerReport.providerReportRef === undefined) {
    throw new Error(`QuickBooks reconciliation evidence requires a supported provider report, received ${input.providerReport.reportName}`);
  }

  const providerReportRef = sanitizeProviderReportRef(input.providerReport.providerReportRef);
  if (providerReportRef.reportName !== input.providerReport.reportName) {
    throw new Error(
      `QuickBooks provider report ref reportName ${providerReportRef.reportName} does not match response ${input.providerReport.reportName}`
    );
  }

  const toleranceAmount = input.toleranceAmount ?? "0.00";
  const toleranceMinor = parseMoney(toleranceAmount);
  if (toleranceMinor < 0n) {
    throw new Error("QuickBooks reconciliation evidence toleranceAmount must be nonnegative");
  }

  const providerTotals = providerTotalsByKey(sanitizeProviderReportTotals(input.providerReport.totals));
  const canonicalTotals = sanitizeCanonicalReportTotals(input.canonicalTotals);
  const totals = canonicalTotals.map((canonicalTotal): NormalizedAccountingReconciliationTotal => {
    const providerTotal = providerTotals.get(canonicalTotal.totalKey);
    if (
      providerTotal?.currencyCode !== undefined &&
      canonicalTotal.currencyCode !== undefined &&
      providerTotal.currencyCode !== canonicalTotal.currencyCode
    ) {
      throw new Error(
        `QuickBooks reconciliation evidence currency mismatch for ${canonicalTotal.totalKey}: provider ${providerTotal.currencyCode}, canonical ${canonicalTotal.currencyCode}`
      );
    }

    const providerAmount = providerTotal?.amount ?? "0.00";
    const differenceMinor = parseMoney(providerAmount) - parseMoney(canonicalTotal.amount);
    const status =
      providerTotal === undefined ? "missing" : absolute(differenceMinor) <= toleranceMinor ? "matched" : "mismatched";

    return {
      totalKey: canonicalTotal.totalKey,
      canonicalAmount: canonicalTotal.amount,
      providerAmount,
      difference: formatMoney(differenceMinor),
      status,
      ...(providerTotal?.drilldownRef === undefined ? {} : { drilldownRef: sanitizeSourcePayloadRef(providerTotal.drilldownRef) })
    };
  });
  const reconciliationDifference = formatMoney(largestAbsoluteDifference(totals));
  const reconciliationStatus: ReconciliationStatus = totals.every((total) => total.status === "matched") ? "balanced" : "out_of_balance";
  const sourceUpdatedAt =
    input.providerReport.latestSourceUpdatedAt ??
    input.providerReport.sourceUpdatedAt ??
    providerReportRef.sourceUpdatedAt ??
    providerReportRef.sourcePayloadRef.sourceUpdatedAt;
  const generatedAt = input.generatedAt ?? input.providerReport.generatedAt;
  const evidence: NormalizedAccountingReconciliationEvidence = {
    provider: "quickbooks",
    providerReportRef,
    reconciliationStatus,
    reconciliationDifference,
    toleranceAmount,
    ...(sourceUpdatedAt === undefined ? {} : { sourceUpdatedAt }),
    ...(generatedAt === undefined ? {} : { generatedAt }),
    totals
  };
  assertNoCredentialKeys(evidence);
  return evidence;
}

export function buildQuickBooksProfitAndLossReconciliationEvidence(
  input: Omit<NormalizedQuickBooksProviderReportReconciliationEvidenceInput, "providerReport"> & {
    readonly providerReport: NormalizedQuickBooksProfitAndLossReportResponseEnvelope;
  }
): NormalizedAccountingReconciliationEvidence {
  validateEvidenceReportName(input.providerReport, "profit_and_loss");
  return buildQuickBooksProviderReportReconciliationEvidence(input);
}

export function buildQuickBooksBalanceSheetReconciliationEvidence(
  input: Omit<NormalizedQuickBooksProviderReportReconciliationEvidenceInput, "providerReport"> & {
    readonly providerReport: NormalizedQuickBooksBalanceSheetReportResponseEnvelope;
  }
): NormalizedAccountingReconciliationEvidence {
  validateEvidenceReportName(input.providerReport, "balance_sheet");
  return buildQuickBooksProviderReportReconciliationEvidence(input);
}

export function buildQuickBooksTrialBalanceReconciliationEvidence(
  input: Omit<NormalizedQuickBooksProviderReportReconciliationEvidenceInput, "providerReport"> & {
    readonly providerReport: NormalizedQuickBooksTrialBalanceReportResponseEnvelope;
  }
): NormalizedAccountingReconciliationEvidence {
  validateEvidenceReportName(input.providerReport, "trial_balance");
  return buildQuickBooksProviderReportReconciliationEvidence(input);
}

async function loadNormalizedQuickBooksProviderReport(
  options: HandrailQuickBooksFullSyncServiceOptions,
  request: NormalizedQuickBooksProviderReportRequestEnvelope
): Promise<NormalizedQuickBooksProviderReportResponseEnvelope> {
  validateProviderReportRequest(request);
  if (request.reportName === "cash_flow") {
    if (!options.loadCashFlowProviderReport) return buildUnsupportedQuickBooksCashFlowParityReportResponse(request);
    return buildNormalizedQuickBooksProviderReportResponse(request, await options.loadCashFlowProviderReport(request));
  }
  if (options.loadProviderReport === undefined) {
    throw new Error("QuickBooks provider report loader is required for supported provider reports");
  }

  const providerReport = await options.loadProviderReport(request);
  return buildNormalizedQuickBooksProviderReportResponse(request, providerReport);
}

function validateServiceHealthProbeRequest(request: NormalizedQuickBooksServiceHealthProbeRequest): void {
  assertNoCredentialKeys(request);
  validateQuickBooksSourceIdentity(request.sourceIdentity);
  if (request.providerMode !== undefined && request.providerMode !== request.sourceIdentity.providerEnvironment) {
    throw new Error(
      `QuickBooks service health providerMode ${request.providerMode} does not match source providerEnvironment ${request.sourceIdentity.providerEnvironment}`
    );
  }
}

function defaultServiceHealthProbeEvidence(
  options: HandrailQuickBooksFullSyncServiceOptions,
  request: NormalizedQuickBooksServiceHealthProbeRequest
): NormalizedQuickBooksServiceHealthProbeEvidence {
  const incrementalAvailable = options.loadIncrementalSyncResources !== undefined;
  const providerReportsAvailable = options.loadProviderReport !== undefined;
  const status: NormalizedQuickBooksServiceHealthStatus =
    incrementalAvailable && providerReportsAvailable ? "ready" : "degraded";

  return {
    status,
    serviceAvailability: "available",
    providerMode: request.sourceIdentity.providerEnvironment,
    ...(request.serviceEnvironment === undefined ? {} : { serviceEnvironment: request.serviceEnvironment }),
    capabilities: {
      fullSync: serviceHealthCapability("ready", "Full sync endpoint is configured."),
      incrementalSync: serviceHealthCapability(
        incrementalAvailable ? "ready" : "degraded",
        incrementalAvailable ? "Incremental sync endpoint is configured." : "Incremental sync loader is not configured."
      ),
      providerReports: serviceHealthCapability(
        providerReportsAvailable ? "ready" : "degraded",
        providerReportsAvailable ? "Provider report endpoint is configured." : "Provider report loader is not configured."
      ),
      sandbox: serviceHealthCapability(
        request.sourceIdentity.providerEnvironment === "sandbox" ? "ready" : "unavailable",
        request.sourceIdentity.providerEnvironment === "sandbox"
          ? "Sandbox provider mode is active."
          : "Sandbox provider mode is not active for this source."
      ),
      replay: serviceHealthCapability(
        request.sourceIdentity.providerEnvironment === "sandbox" ? "ready" : "degraded",
        request.sourceIdentity.providerEnvironment === "sandbox"
          ? "Replay fixtures are available for sandbox preflight."
          : "Replay fixtures are limited to sandbox provider mode."
      )
    },
    checkpoint: {
      ...(request.checkpointId === undefined ? {} : { checkpointId: request.checkpointId }),
      status: request.checkpointId === undefined ? "unknown" : "current"
    }
  };
}

function serviceAvailabilityForHealthStatus(
  status: NormalizedQuickBooksServiceHealthStatus
): NormalizedQuickBooksServiceAvailability {
  switch (status) {
    case "ready":
      return "available";
    case "degraded":
      return "degraded";
    case "unavailable":
      return "unavailable";
    default:
      status satisfies never;
      throw new Error("Unsupported QuickBooks service health status");
  }
}

function normalizeServiceHealthCapabilities(
  capabilities: Partial<NormalizedQuickBooksServiceHealthCapabilities> | undefined,
  status: NormalizedQuickBooksServiceHealthStatus,
  providerMode: NormalizedQuickBooksSourceIdentity["providerEnvironment"]
): NormalizedQuickBooksServiceHealthCapabilities {
  const defaultStatus = serviceHealthCapabilityStatusForHealthStatus(status);

  return {
    fullSync: normalizeServiceHealthCapability(capabilities?.fullSync, defaultStatus),
    incrementalSync: normalizeServiceHealthCapability(capabilities?.incrementalSync, defaultStatus),
    providerReports: normalizeServiceHealthCapability(capabilities?.providerReports, defaultStatus),
    sandbox: normalizeServiceHealthCapability(
      capabilities?.sandbox,
      providerMode === "sandbox" && defaultStatus !== "unavailable" ? "ready" : "unavailable"
    ),
    replay: normalizeServiceHealthCapability(
      capabilities?.replay,
      providerMode === "sandbox" && defaultStatus !== "unavailable" ? defaultStatus : "unavailable"
    )
  };
}

function normalizeServiceHealthCapability(
  capability: NormalizedQuickBooksServiceHealthCapability | undefined,
  fallbackStatus: NormalizedQuickBooksServiceHealthCapabilityStatus
): NormalizedQuickBooksServiceHealthCapability {
  const status = capability?.status ?? fallbackStatus;
  const normalized: NormalizedQuickBooksServiceHealthCapability = {
    status,
    available: capability?.available ?? status !== "unavailable",
    ...(capability?.message === undefined ? {} : { message: capability.message })
  };
  assertNoCredentialKeys(normalized);
  return normalized;
}

function serviceHealthCapability(
  status: NormalizedQuickBooksServiceHealthCapabilityStatus,
  message: string
): NormalizedQuickBooksServiceHealthCapability {
  return {
    status,
    available: status !== "unavailable",
    message
  };
}

function serviceHealthCapabilityStatusForHealthStatus(
  status: NormalizedQuickBooksServiceHealthStatus
): NormalizedQuickBooksServiceHealthCapabilityStatus {
  switch (status) {
    case "ready":
      return "ready";
    case "degraded":
      return "degraded";
    case "unavailable":
      return "unavailable";
    default:
      status satisfies never;
      throw new Error("Unsupported QuickBooks service health status");
  }
}

function normalizeServiceHealthCheckpoint(
  checkpoint: NormalizedQuickBooksServiceHealthCheckpoint | undefined,
  request: NormalizedQuickBooksServiceHealthProbeRequest
): NormalizedQuickBooksServiceHealthCheckpoint {
  const normalized: NormalizedQuickBooksServiceHealthCheckpoint =
    checkpoint === undefined
      ? {
          ...(request.checkpointId === undefined ? {} : { checkpointId: request.checkpointId }),
          status: request.checkpointId === undefined ? "unknown" : "unknown"
        }
      : {
          ...(checkpoint.checkpointId === undefined && request.checkpointId === undefined
            ? {}
            : { checkpointId: checkpoint.checkpointId ?? request.checkpointId }),
          status: checkpoint.status,
          ...(checkpoint.sourceObject === undefined ? {} : { sourceObject: checkpoint.sourceObject }),
          ...(checkpoint.cursorKind === undefined ? {} : { cursorKind: checkpoint.cursorKind }),
          ...(checkpoint.cursorValue === undefined ? {} : { cursorValue: checkpoint.cursorValue }),
          ...(checkpoint.sourceFreshThrough === undefined ? {} : { sourceFreshThrough: checkpoint.sourceFreshThrough }),
          ...(checkpoint.importedThrough === undefined ? {} : { importedThrough: checkpoint.importedThrough }),
          ...(checkpoint.freshThrough === undefined ? {} : { freshThrough: checkpoint.freshThrough }),
          ...(checkpoint.latestSourceUpdatedAt === undefined ? {} : { latestSourceUpdatedAt: checkpoint.latestSourceUpdatedAt })
        };
  assertNoCredentialKeys(normalized);
  return normalized;
}

function sanitizeServiceHealthIssues(
  issues: readonly NormalizedQuickBooksServiceHealthIssue[]
): readonly NormalizedQuickBooksServiceHealthIssue[] {
  return issues.map((issue): NormalizedQuickBooksServiceHealthIssue => {
    const sanitized = {
      code: issue.code,
      severity: issue.severity,
      message: issue.message
    };
    assertNoCredentialKeys(sanitized);
    return sanitized;
  });
}

function validateFullSyncRequest(request: NormalizedQuickBooksFullSyncRequestEnvelope): void {
  assertNoCredentialKeys(request);
  validateQuickBooksSourceIdentity(request.sourceIdentity);
  const syncMode: string = request.syncMode;
  if (syncMode !== "full") {
    throw new Error(`QuickBooks full sync requires syncMode full, received ${syncMode}`);
  }
  const cursorKind: string = request.cursorKind;
  if (cursorKind !== "full_scan") {
    throw new Error(`QuickBooks full sync requires cursorKind full_scan, received ${cursorKind}`);
  }
  if (request.idempotencyKeys.importBatchId !== request.importBatchId) {
    throw new Error("QuickBooks full sync request importBatchId does not match idempotencyKeys.importBatchId");
  }
  if (request.idempotencyKeys.checkpointId !== request.checkpointId) {
    throw new Error("QuickBooks full sync request checkpointId does not match idempotencyKeys.checkpointId");
  }
}

function validateIncrementalSyncRequest(request: HandrailQuickBooksIncrementalSyncRequest): void {
  assertNoCredentialKeys(request);
  validateQuickBooksSourceIdentity(request.sourceIdentity);
  const syncMode: string = request.syncMode;
  if (syncMode !== "incremental") {
    throw new Error(`QuickBooks incremental sync requires syncMode incremental, received ${syncMode}`);
  }
  const cursorKind: string = request.cursorKind;
  if (cursorKind !== "updated_since" && cursorKind !== "high_watermark") {
    throw new Error(`QuickBooks incremental sync requires cursorKind updated_since or high_watermark, received ${cursorKind}`);
  }
  if (request.idempotencyKeys.importBatchId !== request.importBatchId) {
    throw new Error("QuickBooks incremental sync request importBatchId does not match idempotencyKeys.importBatchId");
  }
  if (request.idempotencyKeys.checkpointId !== request.checkpointId) {
    throw new Error("QuickBooks incremental sync request checkpointId does not match idempotencyKeys.checkpointId");
  }
  const resumeCheckpointId = "resumeFromCheckpointId" in request ? request.resumeFromCheckpointId : undefined;
  if (resumeCheckpointId !== undefined && resumeCheckpointId.length === 0) {
    throw new Error("QuickBooks incremental sync resumeFromCheckpointId is required when provided");
  }
}

function validateProviderReportRequest(request: NormalizedQuickBooksProviderReportRequestEnvelope): void {
  assertNoCredentialKeys(request);
  validateQuickBooksSourceIdentity(request.sourceIdentity);

  switch (request.reportName) {
    case "profit_and_loss":
    case "trial_balance":
    case "cash_flow":
      if (request.periodStart === undefined || request.periodEnd === undefined) {
        throw new Error(`QuickBooks ${request.reportName} report requires periodStart and periodEnd`);
      }
      break;
    case "balance_sheet":
      if (request.asOfDate === undefined) {
        throw new Error("QuickBooks balance_sheet report requires asOfDate");
      }
      break;
    default:
      request.reportName satisfies never;
      throw new Error("Unsupported QuickBooks provider report");
  }
}

function validateReportName(
  request: NormalizedQuickBooksProviderReportRequestEnvelope,
  expected: NormalizedQuickBooksProviderReportName
): void {
  if (request.reportName !== expected) {
    throw new Error(`QuickBooks provider report helper expected ${expected}, received ${request.reportName}`);
  }
}

function validateQuickBooksSourceIdentity(identity: NormalizedQuickBooksSourceIdentity): void {
  const sourceSystem: string = identity.sourceSystem;
  if (sourceSystem !== "quickbooks") {
    throw new Error(`QuickBooks sync requires sourceSystem quickbooks, received ${sourceSystem}`);
  }
  const providerEnvironment: string = identity.providerEnvironment;
  if (providerEnvironment !== "sandbox" && providerEnvironment !== "production") {
    throw new Error(`QuickBooks sync requires providerEnvironment sandbox or production, received ${providerEnvironment}`);
  }
  if (identity.realmId.length === 0) {
    throw new Error("QuickBooks sync requires realmId");
  }
  if (identity.sourceCompanyRef !== identity.realmId) {
    throw new Error(`QuickBooks sourceCompanyRef ${identity.sourceCompanyRef} does not match realmId ${identity.realmId}`);
  }
}

function validateResourceSetIdentity(
  expected: NormalizedQuickBooksSourceIdentity,
  resources: NormalizedQuickBooksSyncResourceSet
): void {
  validateQuickBooksSourceIdentity(resources.identity);
  if (resources.identity.tenantId !== expected.tenantId) {
    throw new Error(`QuickBooks resource tenantId ${resources.identity.tenantId} does not match request ${expected.tenantId}`);
  }
  if (resources.identity.sourceId !== expected.sourceId) {
    throw new Error(`QuickBooks resource sourceId ${resources.identity.sourceId} does not match request ${expected.sourceId}`);
  }
  if (resources.identity.providerEnvironment !== expected.providerEnvironment) {
    throw new Error(
      `QuickBooks resource providerEnvironment ${resources.identity.providerEnvironment} does not match request ${expected.providerEnvironment}`
    );
  }
  if (resources.identity.realmId !== expected.realmId) {
    throw new Error(`QuickBooks resource realmId ${resources.identity.realmId} does not match request ${expected.realmId}`);
  }

  for (const resource of allResourceEnvelopes(resources)) {
    const sourceSystem: string = resource.sourceSystem;
    if (sourceSystem !== "quickbooks") {
      throw new Error(`QuickBooks ${resource.resourceType} resource sourceSystem must be quickbooks`);
    }
    if (resource.providerEnvironment !== expected.providerEnvironment) {
      throw new Error(
        `QuickBooks ${resource.resourceType} providerEnvironment ${resource.providerEnvironment} does not match request ${expected.providerEnvironment}`
      );
    }
    if (resource.realmId !== expected.realmId) {
      throw new Error(`QuickBooks ${resource.resourceType} realmId ${resource.realmId} does not match request ${expected.realmId}`);
    }
    if (resource.tenantId !== undefined && resource.tenantId !== expected.tenantId) {
      throw new Error(`QuickBooks ${resource.resourceType} tenantId ${resource.tenantId} does not match request ${expected.tenantId}`);
    }
    if (resource.sourceId !== undefined && resource.sourceId !== expected.sourceId) {
      throw new Error(`QuickBooks ${resource.resourceType} sourceId ${resource.sourceId} does not match request ${expected.sourceId}`);
    }
    if (resource.resourceId.length === 0) {
      throw new Error(`QuickBooks ${resource.resourceType} resourceId is required`);
    }
  }

  validateUniqueResourceIdentities(resources);
}

function sanitizeQuickBooksResourceSet(resources: NormalizedQuickBooksResourceSet): NormalizedQuickBooksResourceSet {
  return {
    identity: resources.identity,
    ...(resources.importBatch === undefined ? {} : { importBatch: resources.importBatch }),
    ...(resources.checkpoint === undefined ? {} : { checkpoint: resources.checkpoint }),
    companyInfo: sanitizeResourceEnvelope(resources.companyInfo),
    accounts: resources.accounts.map(sanitizeResourceEnvelope),
    ...(resources.journalEntries === undefined ? {} : { journalEntries: resources.journalEntries.map(sanitizeResourceEnvelope) }),
    ...(resources.ledgerTransactions === undefined ? {} : { ledgerTransactions: resources.ledgerTransactions.map(sanitizeResourceEnvelope) }),
    ...(resources.ledgerPostings === undefined ? {} : { ledgerPostings: resources.ledgerPostings.map(sanitizeResourceEnvelope) }),
    ...(resources.parties === undefined ? {} : { parties: resources.parties.map(sanitizeResourceEnvelope) }),
    ...(resources.customers === undefined ? {} : { customers: resources.customers.map(sanitizeResourceEnvelope) }),
    ...(resources.vendors === undefined ? {} : { vendors: resources.vendors.map(sanitizeResourceEnvelope) }),
    ...(resources.items === undefined ? {} : { items: resources.items.map(sanitizeResourceEnvelope) }),
    ...(resources.classes === undefined ? {} : { classes: resources.classes.map(sanitizeResourceEnvelope) }),
    ...(resources.departments === undefined ? {} : { departments: resources.departments.map(sanitizeResourceEnvelope) }),
    ...(resources.dimensions === undefined ? {} : { dimensions: resources.dimensions.map(sanitizeResourceEnvelope) }),
    ...(resources.providerReports === undefined
      ? {}
      : {
          providerReports: resources.providerReports.map((report) => ({
            ...report,
            sourcePayloadRef: sanitizeSourcePayloadRef(report.sourcePayloadRef)
          }))
        }),
    ...(resources.reconciliationEvidence === undefined ? {} : { reconciliationEvidence: resources.reconciliationEvidence })
  };
}

function sanitizeQuickBooksSyncResourceSet(resources: NormalizedQuickBooksSyncResourceSet): NormalizedQuickBooksSyncResourceSet {
  return {
    identity: resources.identity,
    ...(resources.importBatch === undefined ? {} : { importBatch: resources.importBatch }),
    ...(resources.checkpoint === undefined ? {} : { checkpoint: resources.checkpoint }),
    ...(resources.companyInfo === undefined ? {} : { companyInfo: sanitizeResourceEnvelope(resources.companyInfo) }),
    ...(resources.accounts === undefined ? {} : { accounts: resources.accounts.map(sanitizeResourceEnvelope) }),
    ...(resources.journalEntries === undefined ? {} : { journalEntries: resources.journalEntries.map(sanitizeResourceEnvelope) }),
    ...(resources.ledgerTransactions === undefined ? {} : { ledgerTransactions: resources.ledgerTransactions.map(sanitizeResourceEnvelope) }),
    ...(resources.ledgerPostings === undefined ? {} : { ledgerPostings: resources.ledgerPostings.map(sanitizeResourceEnvelope) }),
    ...(resources.parties === undefined ? {} : { parties: resources.parties.map(sanitizeResourceEnvelope) }),
    ...(resources.customers === undefined ? {} : { customers: resources.customers.map(sanitizeResourceEnvelope) }),
    ...(resources.vendors === undefined ? {} : { vendors: resources.vendors.map(sanitizeResourceEnvelope) }),
    ...(resources.items === undefined ? {} : { items: resources.items.map(sanitizeResourceEnvelope) }),
    ...(resources.classes === undefined ? {} : { classes: resources.classes.map(sanitizeResourceEnvelope) }),
    ...(resources.departments === undefined ? {} : { departments: resources.departments.map(sanitizeResourceEnvelope) }),
    ...(resources.dimensions === undefined ? {} : { dimensions: resources.dimensions.map(sanitizeResourceEnvelope) }),
    ...(resources.providerReports === undefined
      ? {}
      : {
          providerReports: resources.providerReports.map((report) => ({
            ...report,
            sourcePayloadRef: sanitizeSourcePayloadRef(report.sourcePayloadRef)
          }))
        }),
    ...(resources.reconciliationEvidence === undefined ? {} : { reconciliationEvidence: resources.reconciliationEvidence })
  };
}

const MAX_PROVIDER_REPORT_TOTALS = 50;

function sanitizeProviderReportRef(ref: NormalizedQuickBooksProviderReportRef): NormalizedQuickBooksProviderReportRef {
  return {
    provider: ref.provider,
    providerEnvironment: ref.providerEnvironment,
    realmId: ref.realmId,
    reportName: ref.reportName,
    ...(ref.accountingBasis === undefined ? {} : { accountingBasis: ref.accountingBasis }),
    ...(ref.periodStart === undefined ? {} : { periodStart: ref.periodStart }),
    ...(ref.periodEnd === undefined ? {} : { periodEnd: ref.periodEnd }),
    ...(ref.sourceUpdatedAt === undefined ? {} : { sourceUpdatedAt: ref.sourceUpdatedAt }),
    sourcePayloadRef: sanitizeSourcePayloadRef(ref.sourcePayloadRef)
  };
}

function validateProviderReportRef(
  request: NormalizedQuickBooksProviderReportRequestEnvelope,
  ref: NormalizedQuickBooksProviderReportRef
): void {
  if (ref.providerEnvironment !== request.sourceIdentity.providerEnvironment) {
    throw new Error(
      `QuickBooks provider report ref providerEnvironment ${ref.providerEnvironment} does not match request ${request.sourceIdentity.providerEnvironment}`
    );
  }
  if (ref.realmId !== request.sourceIdentity.realmId) {
    throw new Error(`QuickBooks provider report ref realmId ${ref.realmId} does not match request ${request.sourceIdentity.realmId}`);
  }
  if (ref.reportName !== request.reportName) {
    throw new Error(`QuickBooks provider report ref reportName ${ref.reportName} does not match request ${request.reportName}`);
  }
  if (ref.accountingBasis !== undefined && ref.accountingBasis !== request.accountingBasis) {
    throw new Error(
      `QuickBooks provider report ref accountingBasis ${ref.accountingBasis} does not match request ${request.accountingBasis}`
    );
  }
}

function sanitizeProviderReportTotals(
  totals: readonly NormalizedQuickBooksProviderReportTotal[]
): readonly NormalizedQuickBooksProviderReportTotal[] {
  if (totals.length > MAX_PROVIDER_REPORT_TOTALS) {
    throw new Error(`QuickBooks provider report totals must be bounded to ${String(MAX_PROVIDER_REPORT_TOTALS)} entries or fewer`);
  }

  return totals.map((total): NormalizedQuickBooksProviderReportTotal => {
    if (total.totalKey.length === 0) {
      throw new Error("QuickBooks provider report totalKey is required");
    }

    return {
      totalKey: total.totalKey,
      ...(total.label === undefined ? {} : { label: total.label }),
      amount: total.amount,
      ...(total.currencyCode === undefined ? {} : { currencyCode: total.currencyCode }),
      ...(total.sourceUpdatedAt === undefined ? {} : { sourceUpdatedAt: total.sourceUpdatedAt }),
      ...(total.drilldownRef === undefined ? {} : { drilldownRef: sanitizeSourcePayloadRef(total.drilldownRef) })
    };
  });
}

function sanitizeCanonicalReportTotals(
  totals: readonly NormalizedQuickBooksCanonicalReportTotal[]
): readonly NormalizedQuickBooksCanonicalReportTotal[] {
  if (totals.length > MAX_PROVIDER_REPORT_TOTALS) {
    throw new Error(`QuickBooks reconciliation evidence totals must be bounded to ${String(MAX_PROVIDER_REPORT_TOTALS)} entries or fewer`);
  }

  const seen = new Set<string>();
  return totals.map((total): NormalizedQuickBooksCanonicalReportTotal => {
    if (total.totalKey.length === 0) {
      throw new Error("QuickBooks reconciliation evidence canonical totalKey is required");
    }
    if (seen.has(total.totalKey)) {
      throw new Error(`QuickBooks reconciliation evidence duplicate canonical totalKey ${total.totalKey}`);
    }
    seen.add(total.totalKey);
    return {
      totalKey: total.totalKey,
      amount: total.amount,
      ...(total.currencyCode === undefined ? {} : { currencyCode: total.currencyCode })
    };
  });
}

function providerTotalsByKey(
  totals: readonly NormalizedQuickBooksProviderReportTotal[]
): ReadonlyMap<string, NormalizedQuickBooksProviderReportTotal> {
  const mapped = new Map<string, NormalizedQuickBooksProviderReportTotal>();
  for (const total of totals) {
    if (mapped.has(total.totalKey)) {
      throw new Error(`QuickBooks provider report returned duplicate totalKey ${total.totalKey}`);
    }
    mapped.set(total.totalKey, total);
  }
  return mapped;
}

function validateEvidenceReportName(
  providerReport: NormalizedQuickBooksProviderReportResponseEnvelope,
  expected: NormalizedQuickBooksProviderReportName
): void {
  if (providerReport.reportName !== expected) {
    throw new Error(`QuickBooks reconciliation evidence helper expected ${expected}, received ${providerReport.reportName}`);
  }
}

function sanitizeResourceEnvelope<ResourceType extends string, Resource>(
  envelope: NormalizedQuickBooksResourceEnvelope<ResourceType, Resource>
): NormalizedQuickBooksResourceEnvelope<ResourceType, Resource> {
  return {
    sourceSystem: envelope.sourceSystem,
    ...(envelope.tenantId === undefined ? {} : { tenantId: envelope.tenantId }),
    ...(envelope.sourceId === undefined ? {} : { sourceId: envelope.sourceId }),
    providerEnvironment: envelope.providerEnvironment,
    realmId: envelope.realmId,
    resourceType: envelope.resourceType,
    resourceId: envelope.resourceId,
    ...(envelope.importBatchId === undefined ? {} : { importBatchId: envelope.importBatchId }),
    ...(envelope.checkpointId === undefined ? {} : { checkpointId: envelope.checkpointId }),
    ...(envelope.sourceUpdatedAt === undefined ? {} : { sourceUpdatedAt: envelope.sourceUpdatedAt }),
    ...(envelope.sourceRevision === undefined ? {} : { sourceRevision: envelope.sourceRevision }),
    ...(envelope.syncAction === undefined ? {} : { syncAction: envelope.syncAction }),
    ...(envelope.sourcePayloadRef === undefined ? {} : { sourcePayloadRef: sanitizeSourcePayloadRef(envelope.sourcePayloadRef) }),
    resource: sanitizeJsonLike(envelope.resource) as Resource
  };
}

function sanitizeSourcePayloadRef(sourcePayloadRef: SafeSourcePayloadRef): SafeSourcePayloadRef {
  const sanitized: SafeSourcePayloadRef = {
    sourceObjectType: sourcePayloadRef.sourceObjectType,
    sourceObjectId: sourcePayloadRef.sourceObjectId,
    ...(sourcePayloadRef.sourceUpdatedAt === undefined ? {} : { sourceUpdatedAt: sourcePayloadRef.sourceUpdatedAt }),
    ...(sourcePayloadRef.storageRef === undefined ? {} : { storageRef: sourcePayloadRef.storageRef }),
    ...(sourcePayloadRef.checksum === undefined ? {} : { checksum: sourcePayloadRef.checksum }),
    ...(sourcePayloadRef.byteLength === undefined ? {} : { byteLength: sourcePayloadRef.byteLength }),
    ...(sourcePayloadRef.preview === undefined ? {} : { preview: boundedPreview(sourcePayloadRef.preview) })
  };
  assertSafeSourcePayloadRef(sanitized);
  return sanitized;
}

function boundedPreview(preview: JsonValue): JsonValue {
  const sanitized = sanitizeJsonLike(preview) as JsonValue;
  const serialized = JSON.stringify(sanitized);
  if (Buffer.byteLength(serialized, "utf8") <= 1024) {
    return sanitized;
  }

  return {
    truncated: true,
    byteLength: Buffer.byteLength(serialized, "utf8")
  };
}

function sanitizeJsonLike(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeJsonLike);
  }
  if (value !== null && typeof value === "object") {
    if (isSourcePayloadRefLike(value)) {
      return sanitizeSourcePayloadRef(value);
    }
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitizeJsonLike(entry)]));
  }
  return value;
}

function isSourcePayloadRefLike(value: object): value is SafeSourcePayloadRef {
  const candidate = value as Partial<SafeSourcePayloadRef>;
  return typeof candidate.sourceObjectType === "string" && typeof candidate.sourceObjectId === "string";
}

function largestAbsoluteDifference(totals: readonly NormalizedAccountingReconciliationTotal[]): bigint {
  return totals.reduce((largest, total) => {
    const difference = absolute(parseMoney(total.difference));
    return difference > largest ? difference : largest;
  }, 0n);
}

function parseMoney(value: DecimalString): bigint {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (match === null || match[2] === undefined) {
    throw new Error(`Decimal value must have at most two fractional digits: ${value}`);
  }
  const sign = match[1] === "-" ? -1n : 1n;
  const whole = BigInt(match[2]);
  const fraction = BigInt((match[3] ?? "").padEnd(2, "0"));
  return sign * (whole * 100n + fraction);
}

function formatMoney(value: bigint): DecimalString {
  const sign = value < 0n ? "-" : "";
  const absoluteValue = value < 0n ? -value : value;
  const whole = absoluteValue / 100n;
  const fraction = absoluteValue % 100n;
  return `${sign}${whole.toString()}.${fraction.toString().padStart(2, "0")}`;
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function normalizeFullSyncImportBatch(
  request: NormalizedQuickBooksFullSyncRequestEnvelope,
  importBatch: NormalizedAccountingImportBatchMetadata | undefined,
  resourceCounts: NormalizedAccountingResourceCounts
): NormalizedAccountingImportBatchMetadata {
  if (importBatch !== undefined && importBatch.importBatchId !== request.importBatchId) {
    throw new Error(`QuickBooks importBatchId ${importBatch.importBatchId} does not match request ${request.importBatchId}`);
  }
  if (importBatch !== undefined && importBatch.syncMode !== "full") {
    throw new Error(`QuickBooks full sync importBatch syncMode must be full, received ${importBatch.syncMode}`);
  }

  return {
    importBatchId: request.importBatchId,
    syncMode: "full",
    mode: importBatch?.mode ?? "initial",
    status: importBatch?.status ?? "completed",
    ...(importBatch?.startedAt === undefined ? {} : { startedAt: importBatch.startedAt }),
    ...(importBatch?.completedAt === undefined ? {} : { completedAt: importBatch.completedAt }),
    sourceObjectCounts: resourceCounts,
    ...(importBatch?.warningSummary === undefined ? {} : { warningSummary: importBatch.warningSummary }),
    ...(importBatch?.errorSummary === undefined ? {} : { errorSummary: importBatch.errorSummary })
  };
}

function normalizeInitialFullSyncCheckpoint(
  request: NormalizedQuickBooksFullSyncRequestEnvelope,
  checkpoint: NormalizedAccountingSyncCheckpointMetadata | undefined
): NormalizedAccountingSyncCheckpointMetadata {
  if (checkpoint !== undefined && checkpoint.checkpointId !== request.checkpointId) {
    throw new Error(`QuickBooks checkpointId ${checkpoint.checkpointId} does not match request ${request.checkpointId}`);
  }
  if (checkpoint !== undefined && checkpoint.cursorKind !== "full_scan") {
    throw new Error(`QuickBooks full sync checkpoint cursorKind must be full_scan, received ${checkpoint.cursorKind}`);
  }

  return {
    checkpointId: request.checkpointId,
    sourceObject: checkpoint?.sourceObject ?? "quickbooks_full_sync",
    cursorKind: "full_scan",
    cursorValue: checkpoint?.cursorValue ?? request.cursorValue,
    ...syncFreshnessBoundaryFields(checkpoint),
    ...(checkpoint?.latestSourceUpdatedAt === undefined ? {} : { latestSourceUpdatedAt: checkpoint.latestSourceUpdatedAt }),
    status: checkpoint?.status ?? "current"
  };
}

function syncFreshnessBoundaryFields(
  checkpoint: NormalizedAccountingSyncCheckpointMetadata | undefined
): Pick<NormalizedAccountingSyncCheckpointMetadata, "sourceFreshThrough" | "importedThrough" | "freshThrough"> {
  const sourceFreshThrough = checkpoint?.sourceFreshThrough ?? checkpoint?.freshThrough;
  const importedThrough = checkpoint?.importedThrough ?? sourceFreshThrough;

  return {
    ...(sourceFreshThrough === undefined
      ? {}
      : {
          sourceFreshThrough,
          freshThrough: sourceFreshThrough
        }),
    ...(importedThrough === undefined ? {} : { importedThrough })
  };
}

function normalizeIncrementalSyncImportBatch(
  request: HandrailQuickBooksIncrementalSyncRequest,
  importBatch: NormalizedAccountingImportBatchMetadata | undefined,
  resourceCounts: NormalizedAccountingResourceCounts
): NormalizedAccountingImportBatchMetadata {
  if (importBatch !== undefined && importBatch.importBatchId !== request.importBatchId) {
    throw new Error(`QuickBooks importBatchId ${importBatch.importBatchId} does not match request ${request.importBatchId}`);
  }
  if (importBatch !== undefined && importBatch.syncMode !== "incremental") {
    throw new Error(`QuickBooks incremental sync importBatch syncMode must be incremental, received ${importBatch.syncMode}`);
  }

  return {
    importBatchId: request.importBatchId,
    syncMode: "incremental",
    mode: importBatch?.mode ?? "delta",
    status: importBatch?.status ?? "completed",
    ...(importBatch?.startedAt === undefined ? {} : { startedAt: importBatch.startedAt }),
    ...(importBatch?.completedAt === undefined ? {} : { completedAt: importBatch.completedAt }),
    sourceObjectCounts: resourceCounts,
    ...(importBatch?.warningSummary === undefined ? {} : { warningSummary: importBatch.warningSummary }),
    ...(importBatch?.errorSummary === undefined ? {} : { errorSummary: importBatch.errorSummary })
  };
}

function normalizeIncrementalSyncCheckpoint(
  request: HandrailQuickBooksIncrementalSyncRequest,
  checkpoint: NormalizedAccountingSyncCheckpointMetadata | undefined,
  latestSourceUpdatedAt: string | undefined
): NormalizedAccountingSyncCheckpointMetadata {
  if (checkpoint !== undefined && checkpoint.checkpointId !== request.checkpointId) {
    throw new Error(`QuickBooks checkpointId ${checkpoint.checkpointId} does not match request ${request.checkpointId}`);
  }
  if (checkpoint !== undefined && checkpoint.cursorKind !== request.cursorKind) {
    throw new Error(`QuickBooks incremental sync checkpoint cursorKind must be ${request.cursorKind}, received ${checkpoint.cursorKind}`);
  }

  const sourceFreshThrough = checkpoint?.sourceFreshThrough ?? checkpoint?.freshThrough ?? latestSourceUpdatedAt ?? request.requestedAt;
  const importedThrough = checkpoint?.importedThrough ?? sourceFreshThrough;

  return {
    checkpointId: request.checkpointId,
    sourceObject: checkpoint?.sourceObject ?? "quickbooks_cdc",
    cursorKind: request.cursorKind,
    cursorValue: checkpoint?.cursorValue ?? latestSourceUpdatedAt ?? request.cursorValue,
    ...(sourceFreshThrough === undefined
      ? {}
      : {
          sourceFreshThrough,
          freshThrough: sourceFreshThrough
        }),
    ...(importedThrough === undefined ? {} : { importedThrough }),
    ...(latestSourceUpdatedAt === undefined ? {} : { latestSourceUpdatedAt }),
    status: checkpoint?.status ?? "current"
  };
}

function countQuickBooksResources(resources: NormalizedQuickBooksSyncResourceSet): NormalizedAccountingResourceCounts {
  const journalEntries = resources.journalEntries?.length ?? 0;
  const ledgerTransactions = resources.ledgerTransactions?.length ?? 0;
  const actionCounts = countQuickBooksSyncActions(resources);
  const baseCounts: NormalizedAccountingResourceCounts = {
    companyInfo: resources.companyInfo === undefined ? 0 : 1,
    accounts: resources.accounts?.length ?? 0,
    journalEntries,
    ledgerEntries: journalEntries + ledgerTransactions,
    ledgerTransactions,
    ledgerPostings: resources.ledgerPostings?.length ?? ledgerTransactionPostingCount(resources),
    parties: resources.parties?.length ?? 0,
    customers: resources.customers?.length ?? 0,
    vendors: resources.vendors?.length ?? 0,
    items: resources.items?.length ?? 0,
    classes: resources.classes?.length ?? 0,
    departments: resources.departments?.length ?? 0,
    dimensions: resources.dimensions?.length ?? 0,
    providerReports: resources.providerReports?.length ?? 0,
    reconciliationEvidence: resources.reconciliationEvidence?.length ?? 0
  };

  return Object.values(actionCounts).some((count) => count > 0) ? { ...baseCounts, ...actionCounts } : baseCounts;
}

function countQuickBooksSyncActions(resources: NormalizedQuickBooksSyncResourceSet): NormalizedAccountingResourceCounts {
  return allResourceEnvelopes(resources).reduce(
    (counts, resource) => {
      switch (resource.syncAction) {
        case "changed":
          return { ...counts, changedResources: counts.changedResources + 1 };
        case "deleted":
          return { ...counts, deletedResources: counts.deletedResources + 1 };
        case "voided":
          return { ...counts, voidedResources: counts.voidedResources + 1 };
        case "skipped":
          return { ...counts, skippedResources: counts.skippedResources + 1 };
        case undefined:
          return counts;
        default:
          resource.syncAction satisfies never;
          return counts;
      }
    },
    {
      changedResources: 0,
      deletedResources: 0,
      voidedResources: 0,
      skippedResources: 0
    }
  );
}

function ledgerTransactionPostingCount(resources: NormalizedQuickBooksSyncResourceSet): number {
  const journalEntryPostings = (resources.journalEntries ?? []).reduce(
    (count, journalEntry) => count + journalEntry.resource.lines.reduce((lineCount, line) => lineCount + line.postings.length, 0),
    0
  );
  const ledgerTransactionPostings = (resources.ledgerTransactions ?? []).reduce(
    (count, transaction) => count + transaction.resource.lines.reduce((lineCount, line) => lineCount + line.postings.length, 0),
    0
  );
  return journalEntryPostings + ledgerTransactionPostings;
}

function latestQuickBooksResourceUpdatedAt(resources: NormalizedQuickBooksSyncResourceSet): string | undefined {
  const timestamps = allResourceEnvelopes(resources).flatMap((resource) => [
    resource.sourceUpdatedAt,
    resource.sourcePayloadRef?.sourceUpdatedAt
  ]);
  return timestamps
    .filter((timestamp): timestamp is string => timestamp !== undefined)
    .sort()
    .at(-1);
}

function validateUniqueResourceIdentities(resources: NormalizedQuickBooksSyncResourceSet): void {
  const seen = new Set<string>();
  for (const resource of allResourceEnvelopes(resources)) {
    const identityKey = `${resource.resourceType}:${resource.resourceId}`;
    if (seen.has(identityKey)) {
      throw new Error(`QuickBooks incremental sync returned duplicate resource identity ${identityKey}`);
    }
    seen.add(identityKey);
  }
}

function allResourceEnvelopes(resources: NormalizedQuickBooksSyncResourceSet): readonly NormalizedQuickBooksResourceEnvelope<string, unknown>[] {
  return [
    ...(resources.companyInfo === undefined ? [] : [resources.companyInfo]),
    ...(resources.accounts ?? []),
    ...(resources.journalEntries ?? []),
    ...(resources.ledgerTransactions ?? []),
    ...(resources.ledgerPostings ?? []),
    ...(resources.parties ?? []),
    ...(resources.customers ?? []),
    ...(resources.vendors ?? []),
    ...(resources.items ?? []),
    ...(resources.classes ?? []),
    ...(resources.departments ?? []),
    ...(resources.dimensions ?? [])
  ];
}

/** Exact public provider contract; never infer missing sections as zero. */
function validateCashFlowTotals(totals: readonly NormalizedQuickBooksProviderReportTotal[], currencyCode?: string): void {
  const required = ["net_income", "net_operating_cash", "net_investing_cash", "net_financing_cash", "net_cash_flow", "cash_beginning", "cash_ending"];
  const amounts = new Map<string, bigint>();
  for (const total of totals) {
    if (!required.includes(total.totalKey) || amounts.has(total.totalKey)) throw new Error("Cash-flow totals require unique stable keys");
    if (currencyCode !== undefined && total.currencyCode !== undefined && total.currencyCode !== currencyCode) throw new Error("Cash-flow total currency does not match request");
    amounts.set(total.totalKey, parseMoney(total.amount));
  }
  if (required.some(key => !amounts.has(key))) throw new Error("Cash-flow totals contract is incomplete");
  const value = (key: string) => { const amount = amounts.get(key); if (amount === undefined) throw new Error("Missing cash-flow total"); return amount; };
  if (value("net_operating_cash") + value("net_investing_cash") + value("net_financing_cash") !== value("net_cash_flow")
    || value("cash_beginning") + value("net_cash_flow") !== value("cash_ending")) throw new Error("Cash-flow totals do not reconcile");
}
