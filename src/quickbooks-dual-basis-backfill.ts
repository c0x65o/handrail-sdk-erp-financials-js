import type { CustomerPaymentCorrectionDependency } from "./customer-payment-correction-replay.js";
import { createHash } from "node:crypto";

import { assertNoCredentialKeys, createDimensionHash } from "./canonical-model.js";
import type {
  Account,
  AccountingTransaction,
  DecimalString,
  DimensionRef,
  ImportBatch,
  IsoCurrencyCode,
  IsoDate,
  IsoDateTime,
  LedgerPosting,
  SafeSourcePayloadRef
} from "./canonical-model.js";
import type { ReportAccountingMethod } from "./sdk-read-models.js";

export const QUICKBOOKS_DUAL_BASIS_BACKFILL_METHODS = ["accrual", "cash"] as const;
export const MAX_QUICKBOOKS_BACKFILL_LEDGER_ROWS = 50_000;

export type QuickBooksBackfillLedgerRow = {
  readonly accountSourceId: string;
  readonly transactionId: string;
  readonly transactionType: string;
  readonly transactionDate: IsoDate;
  readonly debitAmount: DecimalString;
  readonly creditAmount: DecimalString;
  readonly documentNumber?: string;
  readonly description?: string;
  readonly partySourceId?: string;
  readonly itemSourceId?: string;
  readonly dimensionRefs?: readonly DimensionRef[];
};

export type QuickBooksBackfillReportRequest = {
  readonly reportName: "general_ledger";
  readonly accountingBasis: ReportAccountingMethod;
  readonly periodStart: IsoDate;
  readonly periodEnd: IsoDate;
  readonly requestedAt: IsoDateTime;
};

export type QuickBooksBackfillReportResponse = {
  readonly reportName: "general_ledger";
  readonly accountingBasis: ReportAccountingMethod;
  readonly supportStatus: "supported";
  readonly currencyCode: IsoCurrencyCode;
  readonly generatedAt: IsoDateTime;
  readonly providerReportRef: SafeSourcePayloadRef;
  readonly ledgerRows: readonly QuickBooksBackfillLedgerRow[];
  /** Provider totals are parity evidence only and are deliberately ignored by materialization. */
  readonly totals?: readonly { readonly totalKey: string; readonly amount: DecimalString }[];
};

export type QuickBooksDualBasisBackfillProvider = {
  generalLedgerReport(request: QuickBooksBackfillReportRequest): Promise<QuickBooksBackfillReportResponse>;
};

/** Structural subset of handrail-sdk-quickbooks-node; no runtime dependency is required. */
export type HandrailQuickBooksProviderReportsClient = {
  readonly providerReports: {
    generalLedger(request: {
      readonly accountingBasis: ReportAccountingMethod;
      readonly periodStart: IsoDate;
      readonly periodEnd: IsoDate;
    }): Promise<{
      readonly ok: true;
      readonly reportName: string;
      readonly supportStatus: "supported" | "unsupported";
      readonly accountingBasis: ReportAccountingMethod;
      readonly currencyCode?: string;
      readonly generatedAt?: string;
      readonly providerReportRef?: { readonly sourcePayloadRef: SafeSourcePayloadRef };
      readonly totals: readonly { readonly totalKey: string; readonly amount: string }[];
      readonly ledgerRows?: readonly {
        readonly accountSourceId: string;
        readonly transactionId: string;
        readonly transactionType: string;
        readonly transactionDate: string;
        readonly debitAmount: string;
        readonly creditAmount: string;
        readonly documentNumber?: string;
        readonly description?: string;
      }[];
    }>;
  };
};

export function createHandrailQuickBooksBackfillProvider(
  client: HandrailQuickBooksProviderReportsClient
): QuickBooksDualBasisBackfillProvider {
  return {
    async generalLedgerReport(request) {
      const response = await client.providerReports.generalLedger({
        accountingBasis: request.accountingBasis,
        periodStart: request.periodStart,
        periodEnd: request.periodEnd
      });
      assertNoCredentialKeys(response);
      if (response.reportName !== "general_ledger" || response.supportStatus !== "supported") {
        throw new Error("QuickBooks detailed General Ledger report is unavailable");
      }
      if (response.accountingBasis !== request.accountingBasis) throw new Error("QuickBooks General Ledger basis mismatch");
      if (response.currencyCode === undefined || response.generatedAt === undefined || response.providerReportRef === undefined || response.ledgerRows === undefined) {
        throw new Error("QuickBooks General Ledger response is missing currency, generation, provenance, or detailed rows");
      }
      return {
        reportName: "general_ledger",
        accountingBasis: response.accountingBasis,
        supportStatus: "supported",
        currencyCode: response.currencyCode,
        generatedAt: response.generatedAt,
        providerReportRef: response.providerReportRef.sourcePayloadRef,
        ledgerRows: response.ledgerRows.map((row) => ({
          ...row,
          transactionDate: row.transactionDate,
          debitAmount: row.debitAmount,
          creditAmount: row.creditAmount
        })),
        totals: response.totals.map((total) => ({ totalKey: total.totalKey, amount: total.amount }))
      };
    }
  };
}

export type QuickBooksBasisBackfillProjection = {
  readonly accountingBasis: ReportAccountingMethod;
  readonly importBatch: ImportBatch;
  readonly transactions: readonly AccountingTransaction[];
  readonly postings: readonly LedgerPosting[];
  readonly providerReportRef: SafeSourcePayloadRef;
};

export type QuickBooksDualBasisBackfillPersistence = {
  /** Atomically replaces only SDK-owned backfill facts in this exact range for both bases. */
  replaceDualBasisRange(input: {
    readonly tenantId: string;
    readonly companyId: string;
    readonly sourceId: string;
    readonly periodStart: IsoDate;
    readonly periodEnd: IsoDate;
    readonly projections: readonly [QuickBooksBasisBackfillProjection, QuickBooksBasisBackfillProjection];
  }): Promise<{ readonly importBatches: number; readonly transactions: number; readonly postings: number; readonly snapshotsMarkedStale: number; readonly correctionDependencies?: readonly CustomerPaymentCorrectionDependency[] }>;
};

export type QuickBooksDualBasisBackfillInput = {
  readonly tenantId: string;
  readonly companyId: string;
  readonly sourceId: string;
  readonly currencyCode: IsoCurrencyCode;
  readonly periodStart: IsoDate;
  readonly periodEnd: IsoDate;
  readonly requestedAt: IsoDateTime;
  readonly accounts: readonly Account[];
  readonly partyIdsBySourceId?: Readonly<Record<string, string>>;
  readonly itemIdsBySourceId?: Readonly<Record<string, string>>;
};

export type QuickBooksDualBasisBackfillResult = {
  readonly periodStart: IsoDate;
  readonly periodEnd: IsoDate;
  readonly projections: readonly [QuickBooksBasisBackfillProjection, QuickBooksBasisBackfillProjection];
  readonly persistence: Awaited<ReturnType<QuickBooksDualBasisBackfillPersistence["replaceDualBasisRange"]>>;
};

export function createQuickBooksDualBasisBackfillWorker(options: {
  readonly provider: QuickBooksDualBasisBackfillProvider;
  readonly persistence: QuickBooksDualBasisBackfillPersistence;
}) {
  return {
    async backfill(input: QuickBooksDualBasisBackfillInput): Promise<QuickBooksDualBasisBackfillResult> {
      assertBackfillInput(input);
      const reports = await Promise.all(QUICKBOOKS_DUAL_BASIS_BACKFILL_METHODS.map((accountingBasis) =>
        options.provider.generalLedgerReport({
          reportName: "general_ledger",
          accountingBasis,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          requestedAt: input.requestedAt
        })
      ));
      const projections = reports.map((report) => materializeQuickBooksBasisBackfill(input, report)) as unknown as
        readonly [QuickBooksBasisBackfillProjection, QuickBooksBasisBackfillProjection];
      const persistence = await options.persistence.replaceDualBasisRange({
        tenantId: input.tenantId,
        companyId: input.companyId,
        sourceId: input.sourceId,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        projections
      });
      return { periodStart: input.periodStart, periodEnd: input.periodEnd, projections, persistence };
    }
  };
}

export function materializeQuickBooksBasisBackfill(
  input: QuickBooksDualBasisBackfillInput,
  report: QuickBooksBackfillReportResponse
): QuickBooksBasisBackfillProjection {
  assertNoCredentialKeys(report);
  if (report.currencyCode !== input.currencyCode) throw new Error("QuickBooks backfill currency does not match the reporting source");
  if (report.ledgerRows.length > MAX_QUICKBOOKS_BACKFILL_LEDGER_ROWS) throw new Error("QuickBooks backfill ledger row limit exceeded");
  const accounts = new Map(input.accounts.filter((account) => account.tenantId === input.tenantId && account.sourceId === input.sourceId).map((account) => [account.sourceAccountId, account]));
  const importBatchId = stableId("qbo_basis_batch", input.tenantId, input.sourceId, report.accountingBasis, input.periodStart, input.periodEnd);
  const grouped = new Map<string, QuickBooksBackfillLedgerRow[]>();
  for (const row of report.ledgerRows) {
    if (row.transactionDate < input.periodStart || row.transactionDate > input.periodEnd) throw new Error("QuickBooks backfill row falls outside the requested period");
    if (!accounts.has(row.accountSourceId)) throw new Error(`QuickBooks backfill account ${row.accountSourceId} is not mapped`);
    const key = [row.transactionType, row.transactionId, row.transactionDate].join("\u0000");
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  const transactions: AccountingTransaction[] = [];
  const postings: LedgerPosting[] = [];
  for (const [groupKey, rows] of grouped) {
    const debit = rows.reduce((sum, row) => sum + moneyMinor(row.debitAmount), 0n);
    const credit = rows.reduce((sum, row) => sum + moneyMinor(row.creditAmount), 0n);
    if (debit === 0n || debit !== credit) throw new Error(`QuickBooks backfill transaction ${groupKey.replaceAll("\u0000", ":")} is not balanced`);
    const first = rows[0];
    if (first === undefined) throw new Error("QuickBooks backfill transaction group is empty");
    const transactionId = stableId("qbo_basis_transaction", input.tenantId, input.sourceId, report.accountingBasis, groupKey);
    // The report reference is provenance for the snapshot, not the object's
    // revision. Preserve both, without inventing an object sourceUpdatedAt.
    const sourcePayloadRef: SafeSourcePayloadRef = {
      sourceObjectType: first.transactionType,
      sourceObjectId: first.transactionId,
      preview: { providerReportRef: report.providerReportRef }
    };
    // Preserve a transaction party only when every detailed row identifies the
    // same mapped party. Never infer it from amounts, dates or document numbers.
    const rowPartyIds = rows.map(row => row.partySourceId === undefined ? undefined : input.partyIdsBySourceId?.[row.partySourceId]);
    const partyId = rowPartyIds[0];
    const transactionPartyId = partyId !== undefined && rowPartyIds.every(id => id === partyId) ? partyId : undefined;
    transactions.push({
      tenantId: input.tenantId,
      sourceId: input.sourceId,
      transactionId,
      sourceTransactionId: `${report.accountingBasis}:${first.transactionType}:${first.transactionId}:${first.transactionDate}`,
      sourceTransactionType: `QuickBooksGeneralLedger:${first.transactionType}`,
      ...(first.documentNumber === undefined ? {} : { transactionNumber: first.documentNumber }),
      transactionDate: first.transactionDate,
      ...(transactionPartyId === undefined ? {} : { partyId: transactionPartyId }),
      postedAt: report.generatedAt,
      updatedAt: report.generatedAt,
      currencyCode: report.currencyCode,
      status: "posted",
      sourcePayloadRef
    });
    rows.forEach((row, index) => {
      const account = accounts.get(row.accountSourceId);
      if (account === undefined) throw new Error(`QuickBooks backfill account ${row.accountSourceId} is not mapped`);
      const partyId = row.partySourceId === undefined ? undefined : input.partyIdsBySourceId?.[row.partySourceId];
      const itemId = row.itemSourceId === undefined ? undefined : input.itemIdsBySourceId?.[row.itemSourceId];
      const dimensionRefs = row.dimensionRefs ?? [];
      const sourcePostingId = `general-ledger:${row.transactionType}:${row.transactionId}:${row.transactionDate}:${String(index + 1)}`;
      postings.push({
        tenantId: input.tenantId,
        sourceId: input.sourceId,
        postingId: stableId("qbo_basis_posting", input.tenantId, input.sourceId, report.accountingBasis, sourcePostingId),
        sourcePostingId,
        transactionId,
        accountId: account.accountId,
        ...(partyId === undefined ? {} : { partyId }),
        ...(itemId === undefined ? {} : { itemId }),
        postingDate: row.transactionDate,
        accountingBasis: report.accountingBasis,
        debitAmount: minorMoney(moneyMinor(row.debitAmount)),
        creditAmount: minorMoney(moneyMinor(row.creditAmount)),
        netAmount: minorMoney(moneyMinor(row.debitAmount) - moneyMinor(row.creditAmount)),
        currencyCode: report.currencyCode,
        dimensionHash: createDimensionHash(dimensionRefs),
        dimensionRefs,
        sourcePayloadRef,
        importBatchId
      });
    });
  }
  return {
    accountingBasis: report.accountingBasis,
    importBatch: { tenantId: input.tenantId, sourceId: input.sourceId, importBatchId, mode: "backfill", status: "completed", startedAt: input.requestedAt, completedAt: report.generatedAt, sourceObjectCounts: { postings: postings.length, transactions: transactions.length } },
    transactions,
    postings,
    providerReportRef: report.providerReportRef
  };
}

function assertBackfillInput(input: QuickBooksDualBasisBackfillInput): void {
  assertNoCredentialKeys(input);
  if (input.periodStart > input.periodEnd) throw new Error("QuickBooks backfill periodStart must not follow periodEnd");
}

function stableId(prefix: string, ...parts: readonly string[]): string {
  return `${prefix}_${createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 24)}`;
}

function moneyMinor(value: DecimalString): bigint {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/u.exec(value);
  if (match === null) throw new Error(`QuickBooks backfill amount ${value} must be nonnegative money`);
  const whole = match[1];
  if (whole === undefined) throw new Error(`QuickBooks backfill amount ${value} must be nonnegative money`);
  return BigInt(whole) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
}

function minorMoney(value: bigint): DecimalString {
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  return `${sign}${(absolute / 100n).toString()}.${(absolute % 100n).toString().padStart(2, "0")}`;
}
