import { describe, expect, it } from "vitest";

import {
  adaptHandrailQuickBooksSdkFullSyncEnvelope,
  adaptHandrailQuickBooksSdkIncrementalSyncEnvelope,
  buildCoreErpPersistenceEvidence,
  compactSourceRecordDispositionWarningSummary,
  createQuickBooksFullSyncWorker,
  createQuickBooksIncrementalSyncWorker,
  consumeSourceRecordDispositions,
  ERP_FINANCIALS_NORMALIZED_QUICKBOOKS_SYNC_FIXTURES,
  mapNormalizedQuickBooksFullSyncResponseToCanonicalFacts,
  mapNormalizedQuickBooksIncrementalSyncResponseToCanonicalFacts
} from "../src/index.js";
import type {
  HandrailQuickBooksSdkFullSyncEnvelope,
  HandrailQuickBooksSdkIncrementalSyncEnvelope,
  HandrailQuickBooksSdkNormalizedSyncEnvelope
} from "../src/index.js";

const sourceRecordType = "SyntheticRecordKind";
const sourceRecordId = "record:arbitrary/-9007199254740993?revision=alpha";
const importBatchId = "batch_disposition_contract";

describe("provider-neutral source record dispositions", () => {
  it("compacts non-authoritative warnings before disposition identity and provenance", () => {
    const dispositions = Array.from({ length: 9 }, (_, index) => {
      const type = index === 4 || index === 5 ? "BillPayment" : index < 4 ? "Purchase" : "Payment";
      const id = String(2_600 + index);
      return {
        disposition: "skipped" as const,
        reason: index === 4 ? "zero_cash_deposit_vendor_credit_offset" : "zero_effect_voided",
        sourceRecordType: type,
        sourceRecordId: id,
        sourcePayloadRef: {
          sourceObjectType: type,
          sourceObjectId: id,
          storageRef: `raw://batch-with-a-production-length-correlation-0123456789/objects/${type}/sync-jobs/sync_20260826001022_1234567890123456/records/${id}`
        }
      };
    });
    const warningSummary = {
      count: 14,
      items: [
        ...Array.from({ length: 5 }, (_, index) => ({
          code: "source_window_record_excluded",
          message: `Source-window warning ${String(index + 1)}`,
          severity: "warning" as const,
          resourceType: "Bill",
          resourceId: String(index + 1)
        })),
        ...dispositions.map((disposition) => ({
          code: "source_record_disposition",
          message: `Source record was explicitly excluded from canonical financial projection: ${disposition.reason}.`,
          severity: "warning" as const,
          resourceType: disposition.sourceRecordType,
          resourceId: disposition.sourceRecordId,
          sourcePayloadRef: disposition.sourcePayloadRef
        }))
      ]
    };

    const compacted = compactSourceRecordDispositionWarningSummary({
      dispositions,
      maximumBytes: 3_600,
      warningSummary
    });

    expect(Buffer.byteLength(JSON.stringify(compacted), "utf8")).toBeLessThanOrEqual(3_600);
    expect(compacted.count).toBe(14);
    const compactedDispositions = compacted.items?.filter((item) => item.code === "source_record_disposition");
    expect(compactedDispositions).toHaveLength(9);
    for (const disposition of dispositions) {
      expect(compactedDispositions).toContainEqual(expect.objectContaining({
        message: disposition.reason,
        resourceType: disposition.sourceRecordType,
        resourceId: disposition.sourceRecordId,
        sourcePayloadRef: disposition.sourcePayloadRef
      }));
    }
    const summarized = compactSourceRecordDispositionWarningSummary({
      dispositions,
      maximumBytes: 1_000,
      warningSummary
    });
    expect(summarized.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "source_record_disposition_batch" })
    ]));
    expect(() => compactSourceRecordDispositionWarningSummary({
      dispositions,
      maximumBytes: 100,
      warningSummary
    })).toThrow("provenance exceeds the canonical JSON boundary");
  });

  it("commits a high-cardinality disposition batch inside the canonical JSON boundary", () => {
    const objectTypes = [
      "Bill",
      "Invoice",
      "Invoice",
      "Invoice",
      "Purchase",
      "Purchase",
      "Purchase",
      "Payment",
      "Payment",
      "Payment",
      "BillPayment",
      "BillPayment",
      "Deposit"
    ] as const;
    const dispositions = objectTypes.map((type, index) => {
      const id = index === 0 ? "3544" : `arbitrary-${String(10_000 + index)}`;
      const reason = index % 3 === 0 ? "zero_effect_empty_transaction" : "zero_effect_voided";
      return {
        disposition: index % 3 === 0 ? "skipped" as const : "voided" as const,
        reason,
        sourceRecordType: type,
        sourceRecordId: id,
        sourcePayloadRef: {
          sourceObjectType: type,
          sourceObjectId: id,
          storageRef: `raw://${importBatchId}/objects/${type}/sync-jobs/sync_20260826031444_4521003d84321dab/records/${id}`
        }
      };
    });
    const warningSummary = {
      count: 18,
      items: [
        ...Array.from({ length: 5 }, (_, index) => ({
          code: "quickbooks_normalization_warning",
          message: `Provider warning ${String(index + 1)}`,
          severity: "warning" as const,
          resourceType: "Bill",
          resourceId: String(3_544 + index)
        })),
        ...dispositions.map((disposition) => ({
          code: "source_record_disposition",
          message: disposition.reason,
          severity: "warning" as const,
          resourceType: disposition.sourceRecordType,
          resourceId: disposition.sourceRecordId,
          sourcePayloadRef: disposition.sourcePayloadRef
        }))
      ]
    };

    expect(Buffer.byteLength(JSON.stringify(warningSummary), "utf8")).toBeGreaterThan(3_600);
    const compacted = compactSourceRecordDispositionWarningSummary({
      dispositions,
      maximumBytes: 3_600,
      warningSummary
    });
    expect(Buffer.byteLength(JSON.stringify(compacted), "utf8")).toBeLessThanOrEqual(3_600);
    expect(compacted.count).toBe(18);
    const batchWarning = compacted.items?.find((item) => item.code === "source_record_disposition_batch");
    expect(batchWarning).toMatchObject({
      code: "source_record_disposition_batch",
      resourceType: "SourceRecordDispositionBatch"
    });
    expect(batchWarning?.message).toMatch(/^13 source record dispositions committed by sha256:[a-f0-9]{64}\.$/u);
    expect(batchWarning?.resourceId).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(compacted.items?.filter((item) => item.code === "source_record_disposition")).toHaveLength(0);

    const full = adaptHandrailQuickBooksSdkFullSyncEnvelope(dispositionEnvelope("full"), adapterOptions());
    if (!full.importBatch || !full.resources.importBatch) throw new Error("Fixture must include import batches");
    const boundedEnvelope = {
      ...full,
      recordDispositions: dispositions,
      warningSummary: compacted,
      importBatch: { ...full.importBatch, warningSummary: compacted },
      resources: {
        ...full.resources,
        importBatch: { ...full.resources.importBatch, warningSummary: compacted }
      }
    };
    expect(() => mapNormalizedQuickBooksFullSyncResponseToCanonicalFacts(boundedEnvelope, {
      companyId: "company_disposition_contract",
      accountingBasis: "accrual",
      currencyCode: "USD"
    })).not.toThrow();

    const reversed = compactSourceRecordDispositionWarningSummary({
      dispositions: [...dispositions].reverse(),
      maximumBytes: 3_600,
      warningSummary: {
        ...warningSummary,
        items: [...warningSummary.items].reverse()
      }
    });
    expect(reversed.items?.find((item) => item.code === "source_record_disposition_batch")?.resourceId)
      .toBe(compacted.items?.find((item) => item.code === "source_record_disposition_batch")?.resourceId);
  });

  it("applies the same arbitrary-ID contract to full and incremental envelopes and retries deterministically", () => {
    const full = adaptHandrailQuickBooksSdkFullSyncEnvelope(
      dispositionEnvelope("full"),
      adapterOptions()
    );
    const incremental = adaptHandrailQuickBooksSdkIncrementalSyncEnvelope(
      dispositionEnvelope("incremental"),
      adapterOptions()
    );
    const fullRetry = adaptHandrailQuickBooksSdkFullSyncEnvelope(
      dispositionEnvelope("full"),
      adapterOptions()
    );

    expect(full.recordDispositions).toEqual(incremental.recordDispositions);
    expect(fullRetry.recordDispositions).toEqual(full.recordDispositions);
    expect(fullRetry.idempotencyKeys).toEqual(full.idempotencyKeys);
    expect(full.recordDispositions).toEqual([
      {
        disposition: "skipped",
        reason: "zero_effect_declared",
        sourceRecordType,
        sourceRecordId,
        sourcePayloadRef: {
          sourceObjectType: sourceRecordType,
          sourceObjectId: sourceRecordId,
          storageRef: dispositionStorageRef()
        }
      }
    ]);
    expect(full.resources.operationalDocuments).toEqual([]);
    expect(full.resources.ledgerTransactions).toEqual([]);
    expect(full.resourceCounts.transactions).toBe(1);
    expect(full.deltaCounts.skippedCount).toBe(1);
    expect(full.warningSummary?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "source_record_disposition",
        resourceType: sourceRecordType,
        resourceId: sourceRecordId
      })
    ]));
    expect(full.warningSummary?.items?.find((item) => item.code === "source_record_disposition")?.sourcePayloadRef)
      .toEqual(expect.objectContaining({ storageRef: dispositionStorageRef() }));

    const fullFacts = mapNormalizedQuickBooksFullSyncResponseToCanonicalFacts(full, {
      companyId: "company_disposition_contract",
      accountingBasis: "accrual",
      currencyCode: "USD"
    });
    const incrementalFacts = mapNormalizedQuickBooksIncrementalSyncResponseToCanonicalFacts(incremental, {
      companyId: "company_disposition_contract",
      accountingBasis: "accrual",
      currencyCode: "USD"
    });
    expect(fullFacts.facts.transactions).toEqual([]);
    expect(incrementalFacts.facts.transactions).toEqual([]);
    expect(fullFacts.facts.importBatch.warningSummary).toEqual(incrementalFacts.facts.importBatch.warningSummary);
    if (full.recordDispositions === undefined) throw new Error("Expected disposition evidence.");
    const evidence = buildCoreErpPersistenceEvidence({
      facts: fullFacts.facts,
      persistence: {
        tenantId: fullFacts.facts.company.tenantId,
        companyId: fullFacts.facts.company.companyId,
        sourceId: fullFacts.facts.source.sourceId,
        importBatchId: fullFacts.facts.importBatch.importBatchId,
        checkpointId: fullFacts.facts.checkpoint.checkpointId,
        companies: 1,
        sources: 1,
        importBatches: 1,
        checkpoints: 1,
        accounts: 0,
        parties: 0,
        items: 0,
        dimensions: 0,
        transactions: 0,
        transactionLines: 0,
        postings: 0
      },
      recordDispositions: full.recordDispositions
    });
    expect(evidence.recordDispositions?.records).toEqual(full.recordDispositions);
    expect(evidence.sourceReferences.refs).toContainEqual(
      expect.objectContaining({ storageRef: dispositionStorageRef() })
    );
  });

  it("leaves non-disposed normalized records untouched for existing fail-closed projection", () => {
    const resources = normalizedResources(37);
    const consumed = consumeSourceRecordDispositions({
      importBatchId,
      rootDispositions: undefined,
      nestedDispositions: undefined,
      normalizedResources: resources,
      skippedCount: 0
    });

    expect(consumed.dispositions).toEqual([]);
    expect(consumed.normalizedResources).toBe(resources);
    expect(consumed.normalizedResources.transactions).toHaveLength(1);
  });

  it("preserves a producer-owned zero skipped count without reclassifying batch accounting", () => {
    const consumed = consumeSourceRecordDispositions({ ...strictInput(), skippedCount: 0 });
    expect(consumed.dispositions).toHaveLength(1);
    expect(consumed.normalizedResources.transactions).toEqual([]);
  });

  it("rejects disposition/data contradictions before either sync worker writes", async () => {
    const full = adaptHandrailQuickBooksSdkFullSyncEnvelope(dispositionEnvelope("full"), adapterOptions());
    const incremental = adaptHandrailQuickBooksSdkIncrementalSyncEnvelope(
      dispositionEnvelope("incremental"),
      adapterOptions()
    );
    const contradictoryResource = {
      resourceId: sourceRecordId,
      resource: { sourceTransactionType: sourceRecordType, sourceTransactionId: sourceRecordId }
    };
    const persistence = new NoWriteOnRejectedDisposition();
    const fullWorker = createQuickBooksFullSyncWorker({
      quickBooksClient: {
        fullSync: () => Promise.resolve({
          ...full,
          resources: { ...full.resources, operationalDocuments: [contradictoryResource] }
        } as unknown as typeof full)
      },
      persistence,
      companyId: "company_disposition_contract"
    });
    const incrementalWorker = createQuickBooksIncrementalSyncWorker({
      quickBooksClient: {
        incrementalSync: () => Promise.resolve({
          ...incremental,
          resources: { ...incremental.resources, operationalDocuments: [contradictoryResource] }
        } as unknown as typeof incremental)
      },
      persistence,
      companyId: "company_disposition_contract"
    });

    await expect(fullWorker.fullSync(ERP_FINANCIALS_NORMALIZED_QUICKBOOKS_SYNC_FIXTURES.fullSync.request))
      .rejects.toThrow(/still present in canonical projection input/);
    await expect(incrementalWorker.incrementalSync(
      ERP_FINANCIALS_NORMALIZED_QUICKBOOKS_SYNC_FIXTURES.checkpointReplay.request
    )).rejects.toThrow(/still present in canonical projection input/);
    expect(persistence.calls).toBe(0);
  });

  it.each([
    {
      name: "a non-zero transaction",
      mutate: (input: StrictInput) => ({ ...input, normalizedResources: normalizedResources(0.01) }),
      message: /explicit zero normalized amount/
    },
    {
      name: "a missing transaction amount",
      mutate: (input: StrictInput) => ({
        ...input,
        normalizedResources: {
          ...input.normalizedResources,
          transactions: [{ ...transactionHeader(), amount: undefined }]
        }
      }),
      message: /explicit zero normalized amount/
    },
    {
      name: "normalized line-item data",
      mutate: (input: StrictInput) => ({
        ...input,
        normalizedResources: {
          ...input.normalizedResources,
          transaction_lines: [{ sourceObject: sourceRecordType, transactionId: sourceRecordId, amount: 0 }]
        }
      }),
      message: /line-item data/
    },
    {
      name: "normalized posting data",
      mutate: (input: StrictInput) => ({
        ...input,
        normalizedResources: {
          ...input.normalizedResources,
          ledger_entries: [{ sourceObject: sourceRecordType, transactionId: sourceRecordId, amount: 0 }]
        }
      }),
      message: /posting data/
    },
    {
      name: "a root and nested mismatch",
      mutate: (input: StrictInput) => ({ ...input, nestedDispositions: [] }),
      message: /must match/
    },
    {
      name: "an unknown disposition",
      mutate: (input: StrictInput) => ({
        ...input,
        rootDispositions: [{ ...providerDisposition(), disposition: "ignored" }],
        nestedDispositions: [{ ...providerDisposition(), disposition: "ignored" }]
      }),
      message: /must be skipped or voided/
    },
    {
      name: "a non-zero-effect reason",
      mutate: (input: StrictInput) => ({
        ...input,
        rootDispositions: [{ ...providerDisposition(), reason: "provider_special_case" }],
        nestedDispositions: [{ ...providerDisposition(), reason: "provider_special_case" }]
      }),
      message: /zero-effect reason code/
    },
    {
      name: "an unmatched source identity",
      mutate: (input: StrictInput) => ({
        ...input,
        rootDispositions: [{ ...providerDisposition(), providerObjectId: "different-arbitrary-id" }],
        nestedDispositions: [{ ...providerDisposition(), providerObjectId: "different-arbitrary-id" }]
      }),
      message: /provenance does not match|exactly one normalized transaction/
    },
    {
      name: "contradictory batch accounting",
      mutate: (input: StrictInput) => ({ ...input, skippedCount: -1 }),
      message: /skipped count is malformed/
    },
    {
      name: "mismatched provenance",
      mutate: (input: StrictInput) => {
        const disposition = {
          ...providerDisposition(),
          rawPayloadProvenance: { sourcePayloadRef: "raw://another-batch/objects/Other/records/other" }
        };
        return { ...input, rootDispositions: [disposition], nestedDispositions: [disposition] };
      },
      message: /provenance does not match/
    },
    {
      name: "credential-like provenance",
      mutate: (input: StrictInput) => {
        const disposition = {
          ...providerDisposition(),
          rawPayloadProvenance: {
            sourcePayloadRef:
              `raw://${importBatchId}/objects/${sourceRecordType}/access_token/records/${encodeURIComponent(sourceRecordId)}`
          }
        };
        return { ...input, rootDispositions: [disposition], nestedDispositions: [disposition] };
      },
      message: /credential-like material/
    },
    {
      name: "duplicate dispositions",
      mutate: (input: StrictInput) => ({
        ...input,
        rootDispositions: [providerDisposition(), providerDisposition()],
        nestedDispositions: [providerDisposition(), providerDisposition()],
        skippedCount: 2
      }),
      message: /Duplicate source record disposition/
    },
    {
      name: "unknown disposition fields",
      mutate: (input: StrictInput) => {
        const disposition = { ...providerDisposition(), inferred: true };
        return { ...input, rootDispositions: [disposition], nestedDispositions: [disposition] };
      },
      message: /missing or unknown disposition fields/
    }
  ])("fails closed for $name", ({ mutate, message }) => {
    expect(() => consumeSourceRecordDispositions(mutate(strictInput()))).toThrow(message);
  });
});

type StrictInput = Parameters<typeof consumeSourceRecordDispositions>[0];

function strictInput(): StrictInput {
  return {
    importBatchId,
    rootDispositions: [providerDisposition()],
    nestedDispositions: [providerDisposition()],
    normalizedResources: normalizedResources(0),
    skippedCount: 1
  };
}

function providerDisposition() {
  return {
    disposition: "skipped",
    reason: "zero_effect_declared",
    providerObjectType: sourceRecordType,
    providerObjectId: sourceRecordId,
    rawPayloadProvenance: { sourcePayloadRef: dispositionStorageRef() }
  };
}

function dispositionStorageRef(): string {
  return `raw://${importBatchId}/objects/${sourceRecordType}/records/${encodeURIComponent(sourceRecordId)}`;
}

function normalizedResources(amount: number) {
  return { transactions: [{ ...transactionHeader(), amount }] };
}

function transactionHeader() {
  return {
    id: sourceRecordId,
    sourceObject: sourceRecordType,
    sourceObjectId: sourceRecordId,
    tenantId: "tenant_disposition_contract",
    realmId: "realm_disposition_contract",
    companyId: "realm_disposition_contract",
    provider: "intuit",
    providerEnvironment: "sandbox",
    source: "quickbooks_accounting_api",
    importBatchId,
    jobId: "job_disposition_contract",
    importedAt: "2026-08-25T15:00:00.000Z",
    syncedAt: "2026-08-25T15:00:00.000Z",
    transactionType: "synthetic"
  };
}

function dispositionEnvelope(mode: "full"): HandrailQuickBooksSdkFullSyncEnvelope;
function dispositionEnvelope(mode: "incremental"): HandrailQuickBooksSdkIncrementalSyncEnvelope;
function dispositionEnvelope(mode: "full" | "incremental"): HandrailQuickBooksSdkNormalizedSyncEnvelope {
  const disposition = providerDisposition();
  return {
    contractId: "handrail.quickbooks.normalized-sync-envelope.v1",
    syncMode: mode,
    tenantId: "tenant_disposition_contract",
    companyId: "realm_disposition_contract",
    importBatchId,
    jobId: "job_disposition_contract",
    status: "succeeded",
    normalizedResourceCounts: { transactions: 1 },
    normalizedResources: normalizedResources(0),
    providerDispositions: [disposition],
    deltaCounts: {
      skippedCount: 1,
      changedCount: mode === "incremental" ? 1 : 0,
      insertedCount: mode === "full" ? 1 : 0,
      failedCount: 0
    },
    audit: {
      checkpointId: `checkpoint_disposition_${mode}`,
      importBatchId,
      jobId: "job_disposition_contract",
      realmId: "realm_disposition_contract",
      sourcePayloadRef: `raw://${importBatchId}`
    },
    importVolume: { entityCounts: { transactions: 1 } },
    importBatch: {
      startedAt: "2026-08-25T15:00:00.000Z",
      completedAt: "2026-08-25T15:01:00.000Z",
      realmId: "realm_disposition_contract",
      status: "succeeded"
    },
    checkpoint: {
      checkpointId: `checkpoint_disposition_${mode}`,
      completedAt: "2026-08-25T15:01:00.000Z",
      providerUpdatedAtWatermark: "2026-08-25T15:00:00.000Z",
      status: "succeeded"
    },
    syncJob: {
      startedAt: "2026-08-25T15:00:00.000Z",
      completedAt: "2026-08-25T15:01:00.000Z",
      providerDispositions: [disposition],
      audit: { sourcePayloadRef: `raw://${importBatchId}/sync-jobs/job_disposition_contract` }
    }
  };
}

function adapterOptions() {
  return {
    sourceId: "source_disposition_contract",
    accountingBasis: "accrual" as const,
    currencyCode: "USD",
    companyDisplayName: "Disposition Contract Company"
  };
}

class NoWriteOnRejectedDisposition {
  calls = 0;

  persist(): Promise<never> {
    this.calls += 1;
    return Promise.reject(new Error("Persistence must not be reached for a rejected disposition."));
  }
}
