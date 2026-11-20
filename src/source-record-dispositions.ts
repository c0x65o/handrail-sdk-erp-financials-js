import { createHash } from "node:crypto";

import { assertNoCredentialKeys, assertSafeSourcePayloadRef } from "./canonical-model.js";
import type { SafeSourcePayloadRef } from "./canonical-model.js";
import type {
  NormalizedAccountingSyncIssue,
  NormalizedAccountingSyncIssueSummary
} from "./normalized-accounting-contracts.js";

const MAX_DISPOSITION_REASON_LENGTH = 128;
const MAX_SOURCE_IDENTITY_LENGTH = 256;
const MAX_SOURCE_PAYLOAD_REF_BYTES = 512;
const DISPOSITION_REASON_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u;
const DISPOSITION_BATCH_WARNING_CODE = "source_record_disposition_batch";
const DISPOSITION_BATCH_RESOURCE_TYPE = "SourceRecordDispositionBatch";
const SENSITIVE_REF_PATTERN =
  /access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization|bearer|api[_-]?key|password|credential/i;
const ALLOWED_DISPOSITION_FIELDS = [
  "disposition",
  "providerObjectId",
  "providerObjectType",
  "rawPayloadProvenance",
  "reason"
] as const;

export type SourceRecordDispositionKind = "skipped" | "voided";

/**
 * Provider-neutral evidence that one source record was explicitly excluded
 * from canonical financial projection. The original provider field names are
 * normalized at the SDK boundary and do not escape this contract.
 */
export type SourceRecordDisposition = {
  readonly disposition: SourceRecordDispositionKind;
  readonly reason: string;
  readonly sourceRecordType: string;
  readonly sourceRecordId: string;
  readonly sourcePayloadRef: SafeSourcePayloadRef;
};

export type SourceDispositionResourceMap = {
  readonly accounts?: readonly unknown[];
  readonly classes?: readonly unknown[];
  readonly items?: readonly unknown[];
  readonly ledger_entries?: readonly unknown[];
  readonly locations?: readonly unknown[];
  readonly parties?: readonly unknown[];
  readonly transactions?: readonly unknown[];
  readonly transaction_lines?: readonly unknown[];
};

export type ConsumeSourceRecordDispositionsInput = {
  readonly importBatchId: string;
  readonly nestedDispositions: unknown;
  readonly normalizedResources: SourceDispositionResourceMap;
  readonly rootDispositions: unknown;
  readonly skippedCount: number;
};

export type ConsumedSourceRecordDispositions = {
  readonly dispositions: readonly SourceRecordDisposition[];
  readonly normalizedResources: SourceDispositionResourceMap;
};

export type CompactSourceRecordDispositionWarningSummaryInput = {
  readonly dispositions: readonly SourceRecordDisposition[] | undefined;
  readonly maximumBytes?: number;
  readonly warningSummary: NormalizedAccountingSyncIssueSummary;
};

/**
 * Bounds an import-batch warning summary without separating a source-record
 * disposition from the identity and safe payload provenance that authorize it.
 * Non-disposition warnings are retained on a best-effort basis; disposition
 * evidence is reconstructed first and fails closed when it cannot fit.
 */
export function compactSourceRecordDispositionWarningSummary(
  input: CompactSourceRecordDispositionWarningSummaryInput
): NormalizedAccountingSyncIssueSummary {
  const maximumBytes = input.maximumBytes ?? 3_600;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0 || maximumBytes > 4_096) {
    throw new Error("Source record disposition warning-summary maximumBytes must be between 1 and 4096.");
  }

  const dispositions = input.dispositions ?? [];
  assertSourceRecordDispositionAdvisories(input.warningSummary, dispositions);

  const individualDispositionItems: NormalizedAccountingSyncIssue[] = dispositions.map((disposition) => ({
    code: "source_record_disposition",
    message: disposition.reason,
    severity: "warning" as const,
    resourceType: disposition.sourceRecordType,
    resourceId: disposition.sourceRecordId,
    sourcePayloadRef: disposition.sourcePayloadRef
  }));
  let items = individualDispositionItems;
  let compacted: NormalizedAccountingSyncIssueSummary = {
    count: input.warningSummary.count,
    ...(items.length === 0 ? {} : { items })
  };
  if (serializedBytes(compacted) > maximumBytes) {
    items = [sourceRecordDispositionBatchWarning(dispositions)];
    compacted = {
      count: input.warningSummary.count,
      items
    };
    if (serializedBytes(compacted) > maximumBytes) {
      throw new Error("Source record disposition warning-summary provenance exceeds the canonical JSON boundary.");
    }
  }

  for (const item of input.warningSummary.items ?? []) {
    if (item.code === "source_record_disposition" || item.code === DISPOSITION_BATCH_WARNING_CODE) continue;
    const candidate: NormalizedAccountingSyncIssueSummary = {
      count: input.warningSummary.count,
      items: [...items, item]
    };
    if (serializedBytes(candidate) <= maximumBytes) items.push(item);
  }

  return {
    count: input.warningSummary.count,
    ...(items.length === 0 ? {} : { items })
  };
}

export function consumeSourceRecordDispositions(
  input: ConsumeSourceRecordDispositionsInput
): ConsumedSourceRecordDispositions {
  const root = parseDispositionArray(input.rootDispositions, "providerDispositions");
  const nested = parseDispositionArray(input.nestedDispositions, "syncJob.providerDispositions");

  if (root.length > 0 || nested.length > 0) {
    if (root.length === 0 || nested.length === 0 || JSON.stringify(root) !== JSON.stringify(nested)) {
      throw new Error("Source record dispositions must match at the sync envelope root and nested sync job.");
    }
  }

  const dispositions = root.length > 0 ? root : nested;
  if (!Number.isSafeInteger(input.skippedCount) || input.skippedCount < 0) {
    throw new Error("Source record disposition sync batch skipped count is malformed.");
  }

  const seen = new Set<string>();
  for (const disposition of dispositions) {
    const key = dispositionIdentity(disposition);
    if (seen.has(key)) {
      throw new Error(`Duplicate source record disposition for ${key}.`);
    }
    seen.add(key);
    assertDispositionProvenance(disposition, input.importBatchId);
  }

  // A $0 QuickBooks bill payment that applies vendor credits to a refund deposit
  // has no ledger effect, but it is how QuickBooks closes those open items. It
  // stays in the import as an ordinary $0 bill payment (not a disposal) so the
  // subledger settles the credit against the deposit exactly as QuickBooks does.
  const settlementBearing = dispositions.filter(isSettlementBearingDisposition);
  assertSettlementBearingRecords(input.normalizedResources, settlementBearing);
  const disposed = settlementBearing.length === 0 ? dispositions
    : dispositions.filter((disposition) => !isSettlementBearingDisposition(disposition));
  const normalizedResources = excludeDisposedZeroEffectRecords(input.normalizedResources, disposed);
  assertNoCredentialKeys(disposed);
  return { dispositions: disposed, normalizedResources };
}

/**
 * Provider zero-effect reasons for records that carry no ledger posting but do
 * settle subledger items (QuickBooks links on a $0 bill payment).
 */
export const SETTLEMENT_BEARING_DISPOSITION_REASONS: ReadonlySet<string> = new Set([
  "zero_cash_deposit_vendor_credit_offset"
]);

export function isSettlementBearingDisposition(
  disposition: Pick<SourceRecordDisposition, "reason" | "sourceRecordType">
): boolean {
  return disposition.sourceRecordType === "BillPayment" && SETTLEMENT_BEARING_DISPOSITION_REASONS.has(disposition.reason);
}

/** Fail closed: exactly one $0 header, no ledger rows. */
function assertSettlementBearingRecords(
  resources: SourceDispositionResourceMap,
  dispositions: readonly SourceRecordDisposition[]
): void {
  for (const disposition of dispositions) {
    const key = dispositionIdentity(disposition);
    const matches = (resources.transactions ?? []).filter((value) => sourceRecordIdentity(value) === key);
    if (matches.length !== 1) {
      throw new Error(`Settlement-bearing source record ${key} must match exactly one normalized transaction header.`);
    }
    assertExplicitZeroEffect(matches[0], key);
    if ((resources.ledger_entries ?? []).some((posting) => childSourceRecordIdentity(posting) === key)) {
      throw new Error(`Settlement-bearing source record ${key} has normalized posting data.`);
    }
  }
}

export function assertSourceRecordDispositionsExcluded(
  resources: {
    readonly accounts?: readonly unknown[];
    readonly classes?: readonly unknown[];
    readonly departments?: readonly unknown[];
    readonly items?: readonly unknown[];
    readonly journalEntries?: readonly unknown[];
    readonly ledgerPostings?: readonly unknown[];
    readonly ledgerTransactions?: readonly unknown[];
    readonly operationalDocuments?: readonly unknown[];
    readonly parties?: readonly unknown[];
  },
  dispositions: readonly SourceRecordDisposition[] | undefined,
  importBatchId?: string
): void {
  if (dispositions === undefined) return;
  const parsed = dispositions.map((value, index) => parseNormalizedDisposition(value, `recordDispositions[${String(index)}]`));
  const identities = new Set<string>();

  for (const disposition of parsed) {
    const key = dispositionIdentity(disposition);
    if (identities.has(key)) throw new Error(`Duplicate source record disposition for ${key}.`);
    identities.add(key);
    assertSafeSourcePayloadRef(disposition.sourcePayloadRef);
    if (importBatchId !== undefined) assertDispositionProvenance(disposition, importBatchId);

    for (const family of Object.values(resources)) {
      if (!Array.isArray(family)) continue;
      for (const value of family) {
        if (canonicalResourceContainsDisposition(value, disposition)) {
          throw new Error(`Disposed source record ${key} is still present in canonical projection input.`);
        }
      }
    }
  }
}

export function assertSourceRecordDispositionAdvisories(
  warningSummary: unknown,
  dispositions: readonly SourceRecordDisposition[] | undefined
): void {
  if (dispositions === undefined || dispositions.length === 0) return;
  const summary = requiredRecord(warningSummary, "warningSummary");
  if (!Array.isArray(summary.items)) {
    throw new Error("Disposed source records require warning-summary reconciliation evidence.");
  }
  const summaryItems: readonly unknown[] = summary.items;
  const everyDispositionHasAdvisory = dispositions.every((disposition) => {
    const match = summaryItems.some((value) => {
      const item = optionalRecord(value);
      const sourcePayloadRef = optionalRecord(item.sourcePayloadRef);
      return item.code === "source_record_disposition" &&
        item.resourceType === disposition.sourceRecordType &&
        item.resourceId === disposition.sourceRecordId &&
        typeof item.message === "string" &&
        item.message.includes(disposition.reason) &&
        sourcePayloadRef.sourceObjectType === disposition.sourceRecordType &&
        sourcePayloadRef.sourceObjectId === disposition.sourceRecordId &&
        sourcePayloadRef.storageRef === disposition.sourcePayloadRef.storageRef;
    });
    return match;
  });
  if (everyDispositionHasAdvisory) return;

  const expectedBatchWarning = sourceRecordDispositionBatchWarning(dispositions);
  const batchMatch = summaryItems.some((value) => {
    const item = optionalRecord(value);
    return item.code === expectedBatchWarning.code &&
      item.message === expectedBatchWarning.message &&
      item.severity === expectedBatchWarning.severity &&
      item.resourceType === expectedBatchWarning.resourceType &&
      item.resourceId === expectedBatchWarning.resourceId;
  });
  if (!batchMatch) {
    throw new Error("Disposed source record is missing matching warning-summary reconciliation evidence.");
  }
}

function sourceRecordDispositionBatchWarning(
  dispositions: readonly SourceRecordDisposition[]
): NormalizedAccountingSyncIssue {
  const digest = sourceRecordDispositionBatchDigest(dispositions);
  return {
    code: DISPOSITION_BATCH_WARNING_CODE,
    message: `${String(dispositions.length)} source record dispositions committed by sha256:${digest}.`,
    severity: "warning",
    resourceType: DISPOSITION_BATCH_RESOURCE_TYPE,
    resourceId: `sha256:${digest}`
  };
}

function sourceRecordDispositionBatchDigest(dispositions: readonly SourceRecordDisposition[]): string {
  const records = dispositions.map((disposition) => [
    disposition.sourceRecordType,
    disposition.sourceRecordId,
    disposition.disposition,
    disposition.reason,
    disposition.sourcePayloadRef.sourceObjectType,
    disposition.sourcePayloadRef.sourceObjectId,
    disposition.sourcePayloadRef.storageRef
  ]).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return createHash("sha256").update(JSON.stringify(records), "utf8").digest("hex");
}

function parseDispositionArray(value: unknown, path: string): readonly SourceRecordDisposition[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${path} must be an array when present.`);
  return value.map((entry, index) => parseProviderDisposition(entry, `${path}[${String(index)}]`));
}

function parseProviderDisposition(value: unknown, path: string): SourceRecordDisposition {
  const input = requiredRecord(value, path);
  assertExactKeys(input, ALLOWED_DISPOSITION_FIELDS, path);
  const provenance = requiredRecord(input.rawPayloadProvenance, `${path}.rawPayloadProvenance`);
  assertExactKeys(provenance, ["sourcePayloadRef"], `${path}.rawPayloadProvenance`);

  return buildDisposition({
    disposition: input.disposition,
    reason: input.reason,
    sourceRecordType: input.providerObjectType,
    sourceRecordId: input.providerObjectId,
    storageRef: provenance.sourcePayloadRef,
    path
  });
}

function parseNormalizedDisposition(value: unknown, path: string): SourceRecordDisposition {
  const input = requiredRecord(value, path);
  assertExactKeys(
    input,
    ["disposition", "reason", "sourcePayloadRef", "sourceRecordId", "sourceRecordType"],
    path
  );
  const sourcePayloadRef = requiredRecord(input.sourcePayloadRef, `${path}.sourcePayloadRef`);
  assertExactKeys(
    sourcePayloadRef,
    ["sourceObjectId", "sourceObjectType", "storageRef"],
    `${path}.sourcePayloadRef`
  );
  const parsed = buildDisposition({
    disposition: input.disposition,
    reason: input.reason,
    sourceRecordType: input.sourceRecordType,
    sourceRecordId: input.sourceRecordId,
    storageRef: sourcePayloadRef.storageRef,
    path
  });
  if (
    parsed.sourcePayloadRef.sourceObjectType !== sourcePayloadRef.sourceObjectType ||
    parsed.sourcePayloadRef.sourceObjectId !== sourcePayloadRef.sourceObjectId ||
    parsed.sourcePayloadRef.storageRef !== sourcePayloadRef.storageRef
  ) {
    throw new Error(`${path}.sourcePayloadRef must contain only source identity and storageRef provenance.`);
  }
  return parsed;
}

function buildDisposition(input: {
  readonly disposition: unknown;
  readonly path: string;
  readonly reason: unknown;
  readonly sourceRecordId: unknown;
  readonly sourceRecordType: unknown;
  readonly storageRef: unknown;
}): SourceRecordDisposition {
  if (input.disposition !== "skipped" && input.disposition !== "voided") {
    throw new Error(`${input.path}.disposition must be skipped or voided.`);
  }
  const reason = boundedString(input.reason, `${input.path}.reason`, MAX_DISPOSITION_REASON_LENGTH);
  if (!DISPOSITION_REASON_PATTERN.test(reason) || !reason.split("_").includes("zero")) {
    throw new Error(`${input.path}.reason must be a canonical zero-effect reason code.`);
  }
  const sourceRecordType = boundedString(
    input.sourceRecordType,
    `${input.path}.source record type`,
    MAX_SOURCE_IDENTITY_LENGTH
  );
  const sourceRecordId = boundedString(
    input.sourceRecordId,
    `${input.path}.source record id`,
    MAX_SOURCE_IDENTITY_LENGTH
  );
  const storageRef = boundedString(
    input.storageRef,
    `${input.path}.sourcePayloadRef`,
    MAX_SOURCE_PAYLOAD_REF_BYTES
  );
  if (!storageRef.startsWith("raw://")) {
    throw new Error(`${input.path}.sourcePayloadRef must be a raw:// provenance reference.`);
  }
  if (SENSITIVE_REF_PATTERN.test(storageRef)) {
    throw new Error(`${input.path}.sourcePayloadRef contains credential-like material.`);
  }
  const sourcePayloadRef: SafeSourcePayloadRef = {
    sourceObjectType: sourceRecordType,
    sourceObjectId: sourceRecordId,
    storageRef
  };
  assertSafeSourcePayloadRef(sourcePayloadRef);
  return {
    disposition: input.disposition,
    reason,
    sourceRecordType,
    sourceRecordId,
    sourcePayloadRef
  };
}

function assertDispositionProvenance(disposition: SourceRecordDisposition, importBatchId: string): void {
  const storageRef = disposition.sourcePayloadRef.storageRef;
  if (storageRef === undefined) throw new Error("Source record disposition is missing storage provenance.");
  let url: URL;
  try {
    url = new URL(storageRef);
  } catch {
    throw new Error("Source record disposition sourcePayloadRef is malformed.");
  }
  if (url.username.length > 0 || url.password.length > 0 || url.search.length > 0 || url.hash.length > 0) {
    throw new Error("Source record disposition sourcePayloadRef contains unsafe URL components.");
  }
  const components = [url.hostname, ...url.pathname.split("/").filter(Boolean)].map((value) =>
    decodeURIComponent(value)
  );
  for (const required of [importBatchId, disposition.sourceRecordType, disposition.sourceRecordId]) {
    if (!components.includes(required)) {
      throw new Error("Source record disposition provenance does not match its batch and source identity.");
    }
  }
}

function excludeDisposedZeroEffectRecords(
  resources: SourceDispositionResourceMap,
  dispositions: readonly SourceRecordDisposition[]
): SourceDispositionResourceMap {
  if (dispositions.length === 0) return resources;
  const disposedKeys = new Set(dispositions.map(dispositionIdentity));
  const transactions = resources.transactions ?? [];

  for (const disposition of dispositions) {
    const key = dispositionIdentity(disposition);
    const matches = transactions.filter((value) => sourceRecordIdentity(value) === key);
    if (matches.length !== 1) {
      throw new Error(`Disposed source record ${key} must match exactly one normalized transaction header.`);
    }
    assertExplicitZeroEffect(matches[0], key);

    for (const line of resources.transaction_lines ?? []) {
      if (childSourceRecordIdentity(line) === key) {
        throw new Error(`Disposed source record ${key} has normalized line-item data.`);
      }
    }
    for (const posting of resources.ledger_entries ?? []) {
      if (childSourceRecordIdentity(posting) === key) {
        throw new Error(`Disposed source record ${key} has normalized posting data.`);
      }
    }
    for (const [family, values] of Object.entries(resources)) {
      if (family === "transactions" || family === "transaction_lines" || family === "ledger_entries") continue;
      if (values.some((value) => sourceRecordIdentity(value) === key)) {
        throw new Error(`Disposed source record ${key} has normalized ${family} data.`);
      }
    }
  }

  return {
    ...resources,
    transactions: transactions.filter((value) => {
      const identity = sourceRecordIdentity(value);
      return identity === undefined || !disposedKeys.has(identity);
    })
  };
}

function assertExplicitZeroEffect(value: unknown, identity: string): void {
  const input = requiredRecord(value, `normalized transaction ${identity}`);
  if (typeof input.amount !== "number" || !Number.isFinite(input.amount) || input.amount !== 0) {
    throw new Error(`Disposed source record ${identity} must have an explicit zero normalized amount.`);
  }
  for (const field of ["balance", "unappliedAmount"] as const) {
    if (input[field] === undefined) continue;
    if (typeof input[field] !== "number" || !Number.isFinite(input[field]) || input[field] !== 0) {
      throw new Error(`Disposed source record ${identity} has non-zero or malformed normalized ${field}.`);
    }
  }
}

function sourceRecordIdentity(value: unknown): string | undefined {
  const input = optionalRecord(value);
  const type = optionalNonEmptyString(input.sourceObject);
  const id = optionalNonEmptyString(input.sourceObjectId);
  return type === undefined || id === undefined ? undefined : `${type}\u0000${id}`;
}

function childSourceRecordIdentity(value: unknown): string | undefined {
  const input = optionalRecord(value);
  const type = optionalNonEmptyString(input.sourceObject);
  const id = optionalNonEmptyString(input.transactionId);
  return type === undefined || id === undefined ? undefined : `${type}\u0000${id}`;
}

function canonicalResourceContainsDisposition(value: unknown, disposition: SourceRecordDisposition): boolean {
  const envelope = optionalRecord(value);
  const resource = optionalRecord(envelope.resource);
  if (
    optionalNonEmptyString(resource.sourceTransactionType) === disposition.sourceRecordType &&
    optionalNonEmptyString(resource.sourceTransactionId) === disposition.sourceRecordId
  ) {
    return true;
  }
  if (
    optionalNonEmptyString(resource.sourceJournalEntryType) === disposition.sourceRecordType &&
    optionalNonEmptyString(resource.sourceJournalEntryId) === disposition.sourceRecordId
  ) {
    return true;
  }
  return false;
}

function dispositionIdentity(disposition: SourceRecordDisposition): string {
  return `${disposition.sourceRecordType}\u0000${disposition.sourceRecordId}`;
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function requiredRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function optionalRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function boundedString(value: unknown, path: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim() || value.length > maxLength) {
    throw new Error(`${path} must be a bounded non-empty string without surrounding whitespace.`);
  }
  return value;
}

function optionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function assertExactKeys(
  input: Record<string, unknown>,
  expected: readonly string[],
  path: string
): void {
  const actual = Object.keys(input).sort();
  const sortedExpected = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(sortedExpected)) {
    throw new Error(`${path} contains missing or unknown disposition fields.`);
  }
}
