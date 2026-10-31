import {retainJournalAccountPolicy} from "./journal-account-policy.js";
import { correctCashFlowPurpose, type CorrectCashFlowPurposeInput, type CorrectCashFlowPurposeResult } from "./cash-flow-purpose.js";
import { normalizeInvoiceComponents, invoiceComponentJournalLines, invoiceComponentRequirements, assertInvoiceComponentPolicy, type InvoicePostingComponents } from "./invoice-components.js";
import { normalizeInvoiceAccountPolicy, type InvoiceAccountPolicy } from "./invoice-account-policy.js";
import { getBillPaymentCorrectionReview } from "./sdk-read-models.js";
import { scopedRecordId } from "./scoped-record-id.js";
import { assertFinancialApproval, runFinancialAction, type FinancialApprovalPolicy, copyFinancialOperation } from "./financial-approval-policy.js";
import { createCustomerPaymentCorrectionService, lockCustomerPaymentCorrectionSource, type CustomerPaymentCorrectionGuard } from "./customer-payment-correction.js";
import { createHash } from "node:crypto";

import { assertValidAccountHierarchy } from "./account-hierarchy.js";
import { assertNoCredentialKeys, createDimensionHash } from "./canonical-model.js";
import { ACCOUNT_HIERARCHY_CHANGED_STALE_REASON } from "./rollup-jobs.js";
import { createPostgresStorageAdapter } from "./postgres-storage.js";
import { appendFinancialLifecycleEvent, assertFinancialOperationContext } from "./financial-lifecycle.js";
import { assertPostingDateAllowed, createFiscalPeriodService } from "./fiscal-periods.js";
import { ErpFinancialsError } from "./sdk-errors.js";
import { appendFinancialOutboxEvent, FINANCIAL_OUTBOX_MAX_PAYLOAD_BYTES } from "./financial-outbox.js";
import { normalizeCommercialDocumentLine } from "./commercial-lines.js";
import { projectCashBasisApplication } from "./accounting-basis-projection.js";

import type {
  Account,
  AccountClassification,
  AccountId,
  AccountingBasis,
  AccountingTransaction,
  DecimalString,
  DimensionRef,
  ImportBatch,
  IsoCurrencyCode,
  IsoDate,
  IsoDateTime,
  JsonValue,
  LedgerPosting,
  SafeSourcePayloadRef,
  TransactionLine
} from "./canonical-model.js";
import type { PostgresQueryClient } from "./postgres-storage.js";
import type { FinancialOperationContext } from "./financial-lifecycle.js";
import type { FiscalPeriodService } from "./fiscal-periods.js";
import type { ErpFinancialsErrorCode, ErpFinancialsErrorDetails } from "./sdk-errors.js";
import type { CommercialDocumentLineInput, NormalizedCommercialDocumentLine } from "./commercial-lines.js";
import type { CashBasisApplicationType, ManualJournalAccountingPolicy } from "./accounting-basis-projection.js";

export const JOURNAL_ENTRY_POSTED_STALE_REASON = "journal_entry_posted";

const ACCOUNT_CLASSIFICATIONS: ReadonlySet<string> = new Set([
  "asset",
  "liability",
  "equity",
  "income",
  "cost_of_goods_sold",
  "expense",
  "other_income",
  "other_expense"
]);
const ACCOUNTING_BASES: ReadonlySet<string> = new Set(["accrual", "cash", "modified_cash"]);

export type ErpFinancialsTransactionRunner = {
  transaction<Result>(operation: (client: PostgresQueryClient) => Promise<Result>): Promise<Result>;
};

export type ErpFinancialsPostgresTransactionClient = PostgresQueryClient & {
  /** A failed connection must not be returned to the pool for reuse. */
  release(error?: Error | boolean): void;
  /** Optional for custom clients; standard node-postgres clients expose both. */
  on?(event: "error", listener: (error: Error) => void): unknown;
  off?(event: "error", listener: (error: Error) => void): unknown;
};

export type ErpFinancialsPostgresPool = {
  connect(): Promise<ErpFinancialsPostgresTransactionClient>;
};

export type ErpFinancialsDatabase = ErpFinancialsTransactionRunner | ErpFinancialsPostgresPool;

export type CreateErpFinancialsInput = {
  readonly invoiceAccountPolicy?: InvoiceAccountPolicy;
  readonly financialApprovalPolicy?: FinancialApprovalPolicy;
  readonly customerPaymentCorrectionGuard?: CustomerPaymentCorrectionGuard;
  readonly database: ErpFinancialsDatabase;
  readonly tenantId: string;
  readonly companyId: string;
  readonly sourceId: string;
  readonly bookId?: string;
  readonly currencyCode: IsoCurrencyCode;
  /**
   * V1 deliberately supports one base currency per service scope. Foreign
   * currency needs explicit exchange-rate, revaluation, and realized-gain/loss
   * behavior and is rejected until that complete contract is available.
   */
  readonly currencyPolicy?: "single_currency";
  readonly accountingBasis?: AccountingBasis;
  readonly postingPolicy?: "enforce_fiscal_periods" | "legacy_unrestricted";
  readonly now?: () => IsoDateTime;
};

export type ErpFinancialsAccountReference =
  | { readonly accountKey: string; readonly accountId?: never }
  | { readonly accountId: AccountId; readonly accountKey?: never };

export type ErpFinancialsAccountDefinition = ErpFinancialsAccountReference & {
  readonly sourceAccountId?: string;
  readonly accountNumber?: string;
  readonly name: string;
  readonly classification: AccountClassification;
  readonly type?: string;
  readonly subtype?: string;
  readonly active?: boolean;
  readonly currencyCode?: IsoCurrencyCode;
};

export type ErpFinancialsAccountTreeNode = ErpFinancialsAccountDefinition & {
  readonly children?: readonly ErpFinancialsAccountTreeNode[];
};

export type UpsertAccountTreeInput = {
  readonly operation: FinancialOperationContext;
  readonly parent: ErpFinancialsAccountDefinition;
  readonly children?: readonly ErpFinancialsAccountTreeNode[];
  readonly staleReason?: string;
};

export type UpsertAccountTreeResult = {
  readonly accounts: readonly Account[];
  readonly accountsWritten: number;
  readonly snapshotsMarkedStale: number;
  readonly lifecycleEventId: string;
};

type JournalEntryLineCommon = ErpFinancialsAccountReference & {
  readonly lineId?: string;
  readonly description?: string;
  readonly partyId?: string;
  readonly itemId?: string;
  readonly dimensionRefs?: readonly DimensionRef[];
};

export type PostJournalEntryLineInput = JournalEntryLineCommon &
  (
    | { readonly debit: DecimalString; readonly credit?: never }
    | { readonly credit: DecimalString; readonly debit?: never }
  );

export type JournalEntryOrigin = {
  readonly module: string;
  readonly reference?: string;
};

export type PostJournalEntryInput = {
  readonly operation: FinancialOperationContext;
  readonly idempotencyKey: string;
  readonly date: IsoDate;
  readonly transactionNumber?: string;
  readonly memo?: string;
  readonly origin?: JournalEntryOrigin;
  readonly postedAt?: IsoDateTime;
  readonly currencyCode?: IsoCurrencyCode;
  readonly accountingBasis?: AccountingBasis;
  /** Manual journals are never converted by inference. Mirroring must be explicitly requested. */
  readonly accountingPolicy?: ManualJournalAccountingPolicy;
  readonly adjustment?: boolean;
  readonly lines: readonly PostJournalEntryLineInput[];
  readonly staleReason?: string;
};

export type JournalEntryWriteCounts = {
  readonly importBatches: number;
  readonly transactions: number;
  readonly transactionLines: number;
  readonly postings: number;
};

export type PostJournalEntryResult = {
  readonly status: "posted" | "already_posted";
  readonly transactionId: string;
  readonly transactionLineIds: readonly string[];
  readonly postingIds: readonly string[];
  readonly importBatchId: string;
  readonly snapshotsMarkedStale: number;
  readonly writeCounts: JournalEntryWriteCounts;
  readonly lifecycleEventId: string;
};

export type ReverseJournalEntryInput = {
  readonly originalTransactionId: string;
  readonly idempotencyKey: string;
  readonly date: IsoDate;
  readonly memo?: string;
  readonly operation: FinancialOperationContext;
};

export type ReplaceJournalEntryInput = ReverseJournalEntryInput & {
  readonly replacement: Omit<PostJournalEntryInput, "operation" | "adjustment">;
};

export type JournalEntryLifecycleResult = {
  readonly outcome: "reversed" | "voided" | "corrected" | "replaced";
  readonly originalTransactionId: string;
  readonly reversal: PostJournalEntryResult;
  readonly replacement?: PostJournalEntryResult;
  readonly journalEntryLinkIds: readonly string[];
  readonly lifecycleEventIds: readonly string[];
};

export type SubledgerDocumentType =
  | "invoice"
  | "customer_payment"
  | "credit_memo"
  | "refund"
  | "vendor_bill"
  | "bill_payment"
  | "write_off"
  | "deposit"
  | "transfer"
  | "sales_receipt"
  | "purchase"
  | "vendor_credit";

export type SubledgerAmountLine = ErpFinancialsAccountReference & CommercialDocumentLineInput & InvoicePostingComponents;

type SubledgerDocumentInputCommon = {
  readonly operation: FinancialOperationContext;
  readonly idempotencyKey: string;
  readonly date: IsoDate;
  readonly documentNumber?: string;
  readonly currencyCode?: IsoCurrencyCode;
  readonly memo?: string;
};

export type CreateInvoiceInput = SubledgerDocumentInputCommon & {
  /** Accrual recognition date. Defaults to the contractual date for existing callers. */
  readonly recognitionDate?: IsoDate;
  readonly customerId: string;
  readonly dueDate: IsoDate;
  readonly receivableAccount: ErpFinancialsAccountReference;
  readonly revenueLines: readonly SubledgerAmountLine[];
};

/** Restates native invoice recognition while retaining its identity and applications. */
export type CorrectInvoiceDatesInput = {
  /** Defaults to documentDate for one-date invoices. Required once dates differ. */
  readonly recognitionDate?: IsoDate;
  readonly operation: FinancialOperationContext;
  readonly invoiceId: string;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly documentDate: IsoDate;
  readonly dueDate: IsoDate;
};
export type CorrectInvoiceDatesResult = {
  /** Present when recognition differs from the contractual document date. */
  readonly recognitionDate?: IsoDate;
  readonly invoiceId: string;
  readonly version: number;
  readonly documentDate: IsoDate;
  readonly dueDate: IsoDate;
  readonly originalTransactionId: string;
  readonly reversalTransactionId?: string;
  readonly replacementTransactionId?: string;
  readonly lifecycleEventId: string;
};

export type RecordCustomerPaymentInput = SubledgerDocumentInputCommon & {
  /** Immutable host collection identity (for example an order); never a balance. */
  readonly collectionRef?: string;
  /** Explicit economic purpose of this cash receipt, independent of invoicing.
   * Retained for cash-flow reporting and inherited by native cash returns. */
  readonly cashFlowActivity?: "operating" | "investing" | "financing";
  readonly customerId: string;
  readonly amount: DecimalString;
  readonly cashAccount: ErpFinancialsAccountReference;
  readonly receivableAccount: ErpFinancialsAccountReference;
  /** Bounded external reconciliation references; never raw provider payloads or credentials. */
  readonly provenance?: CustomerPaymentProvenance;
};

/** Record new cash and allocate it to one invoice in a single atomic command. */
export type RecordAndApplyCustomerPaymentInput = RecordCustomerPaymentInput & {
  readonly invoiceId: string;
  readonly expectedInvoiceVersion: number;
  /** Defaults to the entire receipt. Any excess remains unapplied receipt credit. */
  readonly applicationAmount?: DecimalString;
  /** Defaults to the receipt date. Explicit allocation date must not precede cash receipt or invoice recognition. */
  readonly applicationDate?: IsoDate;
};
/** Immutable command receipt; query current balances separately after replay. */
export type RecordAndApplyCustomerPaymentResult = {
  readonly status: "recorded_and_applied" | "already_recorded_and_applied";
  readonly paymentId: string;
  readonly invoiceId: string;
  readonly applicationId: string;
  readonly paymentTransactionId: string;
  readonly amount: DecimalString;
  readonly lifecycleEventId: string;
};

/** Resolve an uncertain collection without reversing cash. If collection has not
 * committed, permanently retire its exact key/payload so delayed dispatch cannot post.
 * The original actor must authorize retirement; book/source ownership is enforced. */
export type RetireCustomerPaymentCollectionInput = {
  readonly command: RecordAndApplyCustomerPaymentInput;
  readonly operation: FinancialOperationContext;
};
export type RetireCustomerPaymentCollectionResult = RecordAndApplyCustomerPaymentResult | {
  readonly status: "retired" | "already_retired";
  readonly invoiceId: string;
  readonly idempotencyKey: string;
  readonly lifecycleEventId: string;
};

export type ReturnCustomerPaymentCashInput = {
  readonly operation: FinancialOperationContext;
  readonly idempotencyKey: string;
  readonly paymentId: string;
  readonly customerId: string;
  readonly expectedVersion: number;
  readonly date: IsoDate;
  readonly amount: DecimalString;
  /** A captured cash void, never an authorization release. */
  readonly returnKind: "refund" | "void";
  readonly externalReturnRef: string;
  readonly memo?: string;
  /** Use unused receipt credit first; release only the additional refunded amount. */
  readonly releases: readonly { readonly applicationId: string; readonly expectedVersion: number; readonly amount: DecimalString }[];
};
/** Read-only accounting plan validation. This is neither approval nor a reservation. */
export type PreviewCustomerPaymentCashReturnInput = Pick<ReturnCustomerPaymentCashInput,
  "paymentId" | "customerId" | "expectedVersion" | "date" | "amount" | "returnKind" | "releases">;
export type PreviewCustomerPaymentCashReturnResult = {
  readonly paymentId: string;
  readonly paymentVersion: number;
  readonly amount: DecimalString;
  readonly unappliedAmount: DecimalString;
  readonly releasedAmount: DecimalString;
  readonly remainingReturnableAmount: DecimalString;
  readonly releases: PreviewCustomerPaymentCashReturnInput["releases"];
};
export type ReturnCustomerPaymentCashResult = {
  readonly status: "returned" | "already_returned";
  readonly paymentId: string;
  readonly refundDocumentId: string;
  readonly refundTransactionId: string;
  readonly settlementApplicationId: string;
  readonly amount: DecimalString;
  readonly releasedAmount: DecimalString;
  readonly remainingReturnableAmount: DecimalString;
  readonly paymentVersion: number;
  readonly lifecycleEventId: string;
};

export type CustomerPaymentProvenance = {
  readonly externalBankMatch?: {
    readonly externalMatchId: string;
    readonly bankStatementLineId?: string;
    readonly providerReference?: string;
    readonly matchedAt?: IsoDateTime;
  };
  readonly deposit?: {
    readonly depositId: string;
    readonly externalDepositReference?: string;
    readonly depositedAt?: IsoDateTime;
  };
};

type IssueCreditMemoCommon = SubledgerDocumentInputCommon & {
  readonly customerId: string;
  readonly receivableAccount: ErpFinancialsAccountReference;
};

export type IssueCreditMemoInput = IssueCreditMemoCommon &
  (
    | {
        /** Prefer revenueLines so tax, item, dimensions, and account provenance are preserved. */
        readonly amount: DecimalString;
        readonly revenueAccount: ErpFinancialsAccountReference;
        readonly revenueLines?: never;
      }
    | {
        readonly revenueLines: readonly SubledgerAmountLine[];
        readonly amount?: never;
        readonly revenueAccount?: never;
      }
  );

export type IssueRefundInput = SubledgerDocumentInputCommon & {
  readonly customerId: string;
  readonly amount: DecimalString;
  readonly receivableAccount: ErpFinancialsAccountReference;
  readonly cashAccount: ErpFinancialsAccountReference;
  readonly relatedInvoiceId?: string;
  readonly refundMethod?: string;
  readonly lifecycleReference?: string;
};

export type IssuedAdjustmentType = "credit" | "refund" | "write_off";

export type VoidIssuedAdjustmentInput = {
  readonly operation: FinancialOperationContext;
  readonly adjustmentType: IssuedAdjustmentType;
  readonly adjustmentDocumentId: string;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly date: IsoDate;
  readonly memo?: string;
};

export type VoidIssuedCreditMemoInput = Omit<VoidIssuedAdjustmentInput, "adjustmentType">;

export type VoidIssuedRefundInput = Omit<VoidIssuedAdjustmentInput, "adjustmentType">;

type WithoutFinancialOperation<Input> = Input extends unknown ? Omit<Input, "operation"> : never;

export type ReplaceIssuedCreditMemoInput = VoidIssuedCreditMemoInput & {
  readonly replacement: WithoutFinancialOperation<IssueCreditMemoInput>;
};

export type ReplaceIssuedRefundInput = VoidIssuedRefundInput & {
  readonly replacement: WithoutFinancialOperation<IssueRefundInput>;
};

export type ReplaceIssuedAdjustmentInput =
  | (ReplaceIssuedCreditMemoInput & { readonly adjustmentType: "credit" })
  | (ReplaceIssuedRefundInput & { readonly adjustmentType: "refund" })
  | (ReplaceIssuedWriteOffInput & {
      readonly adjustmentType: "write_off";
      readonly adjustmentDocumentId: string;
    });

export type IssuedAdjustmentLifecycleResult = {
  readonly status: "voided" | "already_voided" | "replaced" | "already_replaced";
  readonly outcome: "voided" | "replaced";
  readonly adjustmentType: IssuedAdjustmentType;
  readonly originalAdjustmentDocumentId: string;
  readonly originalTransactionId: string;
  readonly originalVersion: number;
  readonly reversal: PostJournalEntryResult;
  readonly replacement?: SubledgerDocumentResult;
  readonly journalEntryLinkIds: readonly string[];
  readonly lifecycleEventIds: readonly string[];
};

/** Native writes validate, retain, and replay-check per-line customer attribution. */
export const VENDOR_BILL_LINE_CUSTOMERS_SUPPORTED = true;

export type VendorBillExpenseLine = SubledgerAmountLine & {
  /** Canonical active customer party in the bill's tenant/source scope, when assigned. */
  readonly customerId?: string;
};

export type SetVendorBillPaymentHoldInput = {
  readonly operation: FinancialOperationContext;
  readonly vendorBillId: string;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly paymentHold: boolean;
  readonly reason?: string;
};
export type VendorBillPaymentHoldResult = {
  readonly status: "changed" | "already_changed";
  readonly vendorBillId: string;
  readonly version: number;
  readonly paymentHold: boolean;
  readonly paymentHoldReason: string | null;
  readonly lifecycleEventId: string;
};

/** Resolve an uncertain hold/release without reversing any accepted state change. */
export type RetireVendorBillPaymentHoldInput = {
  readonly command: SetVendorBillPaymentHoldInput;
  readonly operation: FinancialOperationContext;
};
export type RetireVendorBillPaymentHoldResult = {
  readonly status: "retired" | "already_retired";
  readonly vendorBillId: string;
  readonly idempotencyKey: string;
  readonly lifecycleEventId: string;
} | {
  readonly status: "already_recorded";
  readonly vendorBillId: string;
  readonly idempotencyKey: string;
  /** Immutable original command receipt; current state is deliberately separate. */
  readonly receipt: VendorBillPaymentHoldResult;
  readonly current: {
    readonly version: number;
    readonly paymentHold: boolean;
    readonly paymentHoldReason: string | null;
  };
};

export type CreateVendorBillInput = SubledgerDocumentInputCommon & {
  readonly vendorId: string;
  readonly dueDate: IsoDate;
  readonly payableAccount: ErpFinancialsAccountReference;
  readonly expenseLines: readonly VendorBillExpenseLine[];
  /** Optional host accounting policy, enforced against locked canonical accounts before posting. */
  readonly accountPolicy?: {
    readonly expenseClassifications: readonly AccountClassification[];
    readonly payableClassifications: readonly AccountClassification[];
  };
};

export type VoidPostedVendorBillInput = {
  readonly operation: FinancialOperationContext;
  readonly vendorBillId: string;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly date: IsoDate;
  readonly memo?: string;
};

export type ReplacePostedVendorBillInput = VoidPostedVendorBillInput & {
  readonly replacement: WithoutFinancialOperation<CreateVendorBillInput>;
};

/** One approved correction, including an explicit complete application release plan.
 * Zero reapplyAmount leaves the released funds/credit available. Source versions
 * are the reviewed versions before any releases, including repeated sources.
 */
export type CorrectPostedVendorBillInput = VoidPostedVendorBillInput & {
  readonly releases: readonly {
    readonly applicationId: string;
    readonly expectedVersion: number;
    readonly expectedSourceVersion: number;
    readonly reapplyAmount: DecimalString;
  }[];
  readonly replacement?: Omit<WithoutFinancialOperation<CreateVendorBillInput>, "idempotencyKey">;
};

/** Immutable completion receipt, not a query for current balances. */
export type CorrectPostedVendorBillResult = {
  readonly status: "corrected" | "already_corrected";
  readonly correction: PostedVendorBillLifecycleResult;
  readonly releasedApplications: readonly SubledgerApplicationResult[];
  readonly applications: readonly SubledgerApplicationResult[];
  readonly replacementPosition?: Pick<SubledgerDocumentResult, "documentId" | "version" | "openAmount" | "documentStatus">;
  readonly lifecycleEventId: string;
};

/** Alias matching issued-document correction terminology used by host applications. */
export type VoidIssuedVendorBillInput = VoidPostedVendorBillInput;

/** Alias matching issued-document correction terminology used by host applications. */
export type ReplaceIssuedVendorBillInput = ReplacePostedVendorBillInput;

export type PostedVendorBillLifecycleResult = {
  readonly status: "voided" | "already_voided" | "replaced" | "already_replaced";
  readonly outcome: "voided" | "replaced";
  readonly originalVendorBillId: string;
  readonly originalTransactionId: string;
  /** The original bill's version after the correction is applied. */
  readonly originalVersion: number;
  readonly reversal: PostJournalEntryResult;
  readonly replacement?: SubledgerDocumentResult;
  readonly journalEntryLinkIds: readonly string[];
  readonly lifecycleEventIds: readonly string[];
};

export type RecordBillPaymentInput = SubledgerDocumentInputCommon & {
  readonly vendorId: string;
  readonly amount: DecimalString;
  readonly payableAccount: ErpFinancialsAccountReference;
  readonly cashAccount: ErpFinancialsAccountReference;
  /** Typed payment rail retained as immutable package-owned provenance. */
  readonly paymentMethod?: BillPaymentMethod;
  /** Provider/check reference kept separate from the accounting document number. */
  readonly reference?: string;
};

export type BillPaymentMethod = "ach" | "card" | "check";

export type BillPaymentAllocationInput = {
  readonly billId: string;
  readonly amount: DecimalString;
  readonly expectedBillVersion: number;
};

export type RecordAndApplyBillPaymentInput = RecordBillPaymentInput & {
  readonly paymentMethod: BillPaymentMethod;
  /** Exact host ordering is retained and used for deterministic application identities. */
  readonly allocations: readonly BillPaymentAllocationInput[];
};

/** Resolve an uncertain immediate record-and-apply attempt. This does not cancel
 * scheduled payments, void posted money or authorize any external provider action. */
export type RetireBillPaymentRecordingInput = {
  readonly command: RecordAndApplyBillPaymentInput;
  readonly operation: FinancialOperationContext;
};
export type RetireBillPaymentRecordingResult = {
  readonly billPaymentId: string;
  readonly idempotencyKey: string;
  readonly lifecycleEventId: string;
} & (
  | { readonly status: "retired" | "already_retired" }
  | { readonly status: "already_recorded"; readonly paymentStatus: "cleared" | "voided";
      readonly paymentTransactionId: string; readonly amount: DecimalString; readonly currencyCode: IsoCurrencyCode;
      readonly applicationIds: readonly string[] }
);

export type ScheduleBillPaymentInput = RecordAndApplyBillPaymentInput;

export type ClearScheduledBillPaymentInput = {
  readonly operation: FinancialOperationContext;
  readonly billPaymentId: string;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
};

export type CancelScheduledBillPaymentInput = ClearScheduledBillPaymentInput;

export type VoidAndUnapplyBillPaymentInput = VoidPostedBillPaymentInput & {
  /** Require the current SDK review snapshot when the host uses reviewed approval. */
  readonly expectedReviewToken?: string;
};

export type ScheduledBillPaymentResult = {
  readonly status: "scheduled" | "already_scheduled";
  readonly billPaymentId: string;
  readonly version: number;
  readonly lifecycleEventId: string;
};

/** Immutable clear receipt. Use queries for current balances/application state. */
export type ClearedBillPaymentResult = {
  readonly status: "cleared" | "already_cleared";
  readonly billPaymentId: string;
  readonly version: number;
  readonly payment: SubledgerDocumentResult;
  readonly applications: readonly SubledgerApplicationResult[];
  readonly lifecycleEventId: string;
};

export type CancelledScheduledBillPaymentResult = {
  readonly status: "voided" | "already_voided";
  readonly billPaymentId: string;
  readonly version: number;
  readonly lifecycleEventId: string;
};

export type VoidAndUnapplyBillPaymentResult = PostedBillPaymentLifecycleResult & {
  readonly endedApplications: readonly SubledgerApplicationResult[];
  /** Version of the package-owned disbursement lifecycle, when present. */
  readonly disbursementVersion?: number;
};

export type VoidPostedBillPaymentInput = {
  readonly operation: FinancialOperationContext;
  readonly billPaymentId: string;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly date: IsoDate;
  readonly memo?: string;
};

/** Alias for hosts that describe an immutable posted payment as issued. */
export type VoidIssuedBillPaymentInput = VoidPostedBillPaymentInput;

export type PostedBillPaymentLifecycleResult = {
  readonly status: "voided" | "already_voided";
  readonly originalBillPaymentId: string;
  readonly originalTransactionId: string;
  /** The original payment's version after the correction is applied. */
  readonly originalVersion: number;
  readonly reversal: PostJournalEntryResult;
  readonly journalEntryLinkIds: readonly string[];
  readonly lifecycleEventIds: readonly string[];
};

export type RecordWriteOffInput = SubledgerDocumentInputCommon & {
  readonly partyId: string;
  readonly amount: DecimalString;
  readonly balanceType: "receivable" | "payable";
  readonly balanceAccount: ErpFinancialsAccountReference;
  readonly writeOffAccount: ErpFinancialsAccountReference;
  readonly relatedInvoiceId?: string;
  readonly reason?: string;
};

export type VoidIssuedWriteOffInput = Omit<VoidIssuedAdjustmentInput, "adjustmentType" | "adjustmentDocumentId"> & {
  readonly writeOffDocumentId: string;
};

export type ReplaceIssuedWriteOffInput = VoidIssuedWriteOffInput & {
  readonly replacement: WithoutFinancialOperation<RecordWriteOffInput>;
};

export type RecordDepositInput = SubledgerDocumentInputCommon & {
  readonly amount: DecimalString;
  readonly bankAccount: ErpFinancialsAccountReference;
  readonly clearingAccount: ErpFinancialsAccountReference;
};

/** Reverse a deposit recorded by this SDK without rewriting its financial identity. */
export type ReverseDepositInput = Omit<ReverseJournalEntryInput, "originalTransactionId"> & {
  readonly depositId: string;
};

export type ReverseDepositResult = {
  readonly status: "reversed" | "already_reversed";
  readonly originalDepositId: string;
  readonly originalTransactionId: string;
  readonly reversal: PostJournalEntryResult;
  /** Present when the original document has a persisted cash-basis journal. */
  readonly cashReversal?: PostJournalEntryResult;
  readonly journalEntryLinkIds: readonly string[];
  readonly lifecycleEventIds: readonly string[];
};

export type RecordTransferInput = SubledgerDocumentInputCommon & {
  readonly amount: DecimalString;
  readonly fromAccount: ErpFinancialsAccountReference;
  readonly toAccount: ErpFinancialsAccountReference;
};

/** Host-authenticated approval of the exact command checksum; never accept this from an untrusted caller. */
export type TransferReversalApproval = {
  readonly approvalRef: string;
  readonly operationChecksum: string;
};

export type TransferReversalApprovalScope = Pick<CreateErpFinancialsInput,
  "tenantId" | "companyId" | "sourceId" | "bookId" | "currencyCode">;

export type ReverseTransferInput = Omit<ReverseJournalEntryInput, "originalTransactionId"> & {
  /** The documentId returned by transfers.record, not its journal transactionId. */
  readonly transferId: string;
  readonly approval: TransferReversalApproval;
};

export type ReverseTransferResult = Omit<ReverseDepositResult, "originalDepositId"> & {
  readonly originalTransferId: string;
};

/** Compute at approval time in the trusted host; a checksum is a binding, not authentication. */
export function createTransferReversalApprovalChecksum(
  scope: TransferReversalApprovalScope,
  input: Omit<ReverseTransferInput, "approval">
): string {
  const operation = input.operation;
  return createHash("sha256").update(JSON.stringify([
    "transfers.reverse:v1", scope.tenantId, scope.companyId, scope.sourceId,
    scope.bookId ?? null, scope.currencyCode, input.transferId, input.idempotencyKey,
    input.date, input.memo ?? null, operation.actorRef, operation.approverRef ?? null,
    operation.requestId, operation.correlationId, operation.reasonCode,
    operation.reasonDetail ?? null, operation.occurredAt
  ])).digest("hex");
}

export type SubledgerDocumentResult = {
  readonly status: "posted" | "already_posted";
  readonly documentId: string;
  readonly documentType: SubledgerDocumentType;
  readonly originalAmount: DecimalString;
  readonly openAmount: DecimalString;
  readonly documentStatus: "open" | "partially_applied" | "settled" | "voided";
  readonly version: number;
  readonly journal: PostJournalEntryResult;
};

export type SubledgerApplicationType =
  | "customer_payment_to_invoice"
  | "bill_payment_to_bill"
  | "credit_to_invoice"
  | "vendor_credit_to_bill"
  | "write_off_to_invoice"
  | "customer_payment_to_refund";

/** Reviewed bridge from an active native payment to a historical invoice or vendor bill.
 * The host must bind reviewRef to its immutable approval receipt. Names/provider IDs
 * are never identity evidence. The operation requires an independent approver. */
export type CrossSourceSettlement = {
  readonly targetSourceId: string;
  readonly nativePartyId: string;
  readonly historicalPartyId: string;
  readonly reviewRef: string;
  readonly accountMappings: readonly { readonly historicalAccountId: string; readonly nativeAccountId: string }[];
};

/** Backward-compatible name for the original customer-only bridge. */
export type CrossSourceCustomerSettlement = CrossSourceSettlement;

export type ApplySubledgerPaymentInput = {
  readonly operation: FinancialOperationContext;
  readonly idempotencyKey: string;
  readonly applicationType: SubledgerApplicationType;
  readonly sourceDocumentId: string;
  readonly targetDocumentId: string;
  readonly amount: DecimalString;
  readonly applicationDate: IsoDate;
  readonly expectedSourceVersion: number;
  readonly expectedTargetVersion: number;
  readonly crossSource?: CrossSourceSettlement;
  readonly match?: {
    readonly matchCandidateId: string;
    readonly matchDecisionId: string;
    readonly method: "automatic" | "manual";
    readonly score: DecimalString;
    readonly evidence?: JsonValue;
  };
};

/** Retire an uncertain native customer receipt allocation without unapplying it. */
export type RetireReceiptApplicationInput = {
  readonly command: ApplySubledgerPaymentInput & { readonly applicationType: "customer_payment_to_invoice" };
  readonly operation: FinancialOperationContext;
};
export type RetireReceiptApplicationResult =
  | { readonly status: "already_recorded"; readonly application: SubledgerApplicationResult }
  | { readonly status: "retired" | "already_retired"; readonly sourceDocumentId: string; readonly targetDocumentId: string; readonly idempotencyKey: string; readonly lifecycleEventId: string };

export type EndSubledgerApplicationInput = {
  readonly operation: FinancialOperationContext;
  readonly applicationId: string;
  /** Accounting date used to enforce fiscal-period and posting-lock policy. */
  readonly effectiveDate: IsoDate;
  readonly expectedVersion: number;
};

export type SettleInvoiceWriteOffInput = Omit<
  RecordWriteOffInput,
  "balanceType" | "partyId" | "relatedInvoiceId"
> & {
  readonly customerId: string;
  readonly invoiceId: string;
  readonly expectedInvoiceVersion: number;
};

export type SettleInvoiceWriteOffResult = {
  readonly status: "settled" | "already_settled";
  readonly writeOffDocumentId: string;
  readonly writeOffTransactionId: string;
  readonly writeOffVersion: number;
  readonly application: SubledgerApplicationResult;
  readonly invoiceId: string;
  readonly invoiceOpenAmount: DecimalString;
  readonly invoiceStatus: "open" | "partially_applied" | "settled";
  readonly invoiceVersion: number;
};

export type SubledgerApplicationResult = {
  readonly status: "applied" | "already_applied" | "unapplied" | "voided";
  readonly applicationId: string;
  readonly version: number;
  readonly sourceDocumentId: string;
  readonly targetDocumentId: string;
  readonly targetDocumentSourceId?: string;
  readonly appliedAmount: DecimalString;
  readonly currencyCode: IsoCurrencyCode;
  readonly matchCandidateId?: string;
  readonly matchDecisionId?: string;
  readonly matchMethod?: "automatic" | "manual";
  readonly matchScore?: DecimalString;
  readonly lifecycleEventId: string;
};

/** Register operational identity once. Existing accounting identity, name and
 * active state remain SDK-owned; this command cannot reactivate a party. */
export type EnsureActivePartyInput = {
  readonly partyId: string;
  readonly sourcePartyId: string;
  readonly partyType: "customer" | "vendor";
  readonly displayName: string;
  readonly operation: FinancialOperationContext;
};
export type EnsureActivePartyResult = { readonly partyId: string };

export type ErpFinancials = {
  readonly parties: { ensureActive(input: EnsureActivePartyInput): Promise<EnsureActivePartyResult> };
  readonly cashFlow: { correctPurpose(input: CorrectCashFlowPurposeInput): Promise<CorrectCashFlowPurposeResult> };
  readonly accounts: {
    upsertTree(input: UpsertAccountTreeInput): Promise<UpsertAccountTreeResult>;
  };
  readonly journalEntries: {
    post(input: PostJournalEntryInput): Promise<PostJournalEntryResult>;
    postAdjustment(input: Omit<PostJournalEntryInput, "adjustment">): Promise<PostJournalEntryResult>;
    reverse(input: ReverseJournalEntryInput): Promise<JournalEntryLifecycleResult>;
    void(input: ReverseJournalEntryInput): Promise<JournalEntryLifecycleResult>;
    correct(input: ReplaceJournalEntryInput): Promise<JournalEntryLifecycleResult>;
    replace(input: ReplaceJournalEntryInput): Promise<JournalEntryLifecycleResult>;
  };
  readonly fiscalPeriods: FiscalPeriodService;
  readonly invoices: {
    create(input: CreateInvoiceInput): Promise<SubledgerDocumentResult>;
    correctDates(input: CorrectInvoiceDatesInput): Promise<CorrectInvoiceDatesResult>;
  };
  readonly customerPayments: { record(input: RecordCustomerPaymentInput): Promise<SubledgerDocumentResult>; recordAndApply(input: RecordAndApplyCustomerPaymentInput): Promise<RecordAndApplyCustomerPaymentResult>; retireCollectionAttempt(input: RetireCustomerPaymentCollectionInput): Promise<RetireCustomerPaymentCollectionResult>; returnCash(input: ReturnCustomerPaymentCashInput): Promise<ReturnCustomerPaymentCashResult>; previewReturnCash(input: PreviewCustomerPaymentCashReturnInput): Promise<PreviewCustomerPaymentCashReturnResult> } & ReturnType<typeof createCustomerPaymentCorrectionService>;
  readonly adjustments: {
    voidIssued(input: VoidIssuedAdjustmentInput): Promise<IssuedAdjustmentLifecycleResult>;
    replaceIssued(input: ReplaceIssuedAdjustmentInput): Promise<IssuedAdjustmentLifecycleResult>;
  };
  readonly credits: {
    issue(input: IssueCreditMemoInput): Promise<SubledgerDocumentResult>;
    voidIssued(input: VoidIssuedCreditMemoInput): Promise<IssuedAdjustmentLifecycleResult>;
    replaceIssued(input: ReplaceIssuedCreditMemoInput): Promise<IssuedAdjustmentLifecycleResult>;
  };
  readonly refunds: {
    issue(input: IssueRefundInput): Promise<SubledgerDocumentResult>;
    voidIssued(input: VoidIssuedRefundInput): Promise<IssuedAdjustmentLifecycleResult>;
    replaceIssued(input: ReplaceIssuedRefundInput): Promise<IssuedAdjustmentLifecycleResult>;
  };
  readonly vendorBills: {
    correctPosted(input: CorrectPostedVendorBillInput): Promise<CorrectPostedVendorBillResult>;
    setPaymentHold(input: SetVendorBillPaymentHoldInput): Promise<VendorBillPaymentHoldResult>;
    retirePaymentHoldAttempt(input: RetireVendorBillPaymentHoldInput): Promise<RetireVendorBillPaymentHoldResult>;
    create(input: CreateVendorBillInput): Promise<SubledgerDocumentResult>;
    voidIssued(input: VoidIssuedVendorBillInput): Promise<PostedVendorBillLifecycleResult>;
    replaceIssued(input: ReplaceIssuedVendorBillInput): Promise<PostedVendorBillLifecycleResult>;
    voidPosted(input: VoidPostedVendorBillInput): Promise<PostedVendorBillLifecycleResult>;
    replacePosted(input: ReplacePostedVendorBillInput): Promise<PostedVendorBillLifecycleResult>;
  };
  readonly billPayments: {
    record(input: RecordBillPaymentInput): Promise<SubledgerDocumentResult>;
    recordAndApply(input: RecordAndApplyBillPaymentInput): Promise<ClearedBillPaymentResult>;
    retireRecordingAttempt(input: RetireBillPaymentRecordingInput): Promise<RetireBillPaymentRecordingResult>;
    schedule(input: ScheduleBillPaymentInput): Promise<ScheduledBillPaymentResult>;
    clear(input: ClearScheduledBillPaymentInput): Promise<ClearedBillPaymentResult>;
    cancel(input: CancelScheduledBillPaymentInput): Promise<CancelledScheduledBillPaymentResult>;
    voidAndUnapply(input: VoidAndUnapplyBillPaymentInput): Promise<VoidAndUnapplyBillPaymentResult>;
    void(input: VoidPostedBillPaymentInput): Promise<PostedBillPaymentLifecycleResult>;
    voidIssued(input: VoidIssuedBillPaymentInput): Promise<PostedBillPaymentLifecycleResult>;
    voidPosted(input: VoidPostedBillPaymentInput): Promise<PostedBillPaymentLifecycleResult>;
  };
  readonly writeOffs: {
    record(input: RecordWriteOffInput): Promise<SubledgerDocumentResult>;
    settleInvoice(input: SettleInvoiceWriteOffInput): Promise<SettleInvoiceWriteOffResult>;
    voidIssued(input: VoidIssuedWriteOffInput): Promise<IssuedAdjustmentLifecycleResult>;
    replaceIssued(input: ReplaceIssuedWriteOffInput): Promise<IssuedAdjustmentLifecycleResult>;
  };
  readonly deposits: {
    record(input: RecordDepositInput): Promise<SubledgerDocumentResult>;
    reverse(input: ReverseDepositInput): Promise<ReverseDepositResult>;
  };
  readonly transfers: {
    record(input: RecordTransferInput): Promise<SubledgerDocumentResult>;
    reverse(input: ReverseTransferInput): Promise<ReverseTransferResult>;
  };
  readonly paymentApplications: {
    apply(input: ApplySubledgerPaymentInput): Promise<SubledgerApplicationResult>;
    retireReceiptAttempt(input: RetireReceiptApplicationInput): Promise<RetireReceiptApplicationResult>;
    unapply(input: EndSubledgerApplicationInput): Promise<SubledgerApplicationResult>;
    void(input: EndSubledgerApplicationInput): Promise<SubledgerApplicationResult>;
  };
};

export class ErpFinancialsValidationError extends ErpFinancialsError {
  constructor(
    message: string,
    code: ErpFinancialsErrorCode = "invalid_input",
    details: ErpFinancialsErrorDetails = {}
  ) {
    super(code, message, { details });
    this.name = "ErpFinancialsValidationError";
    Object.setPrototypeOf(this, ErpFinancialsValidationError.prototype);
  }
}

export class ErpFinancialsIdempotencyConflictError extends ErpFinancialsError {
  readonly idempotencyKey: string;

  constructor(idempotencyKey: string) {
    super(
      "idempotency_conflict",
      `Financial operation idempotency key ${idempotencyKey} is already associated with different content or status`,
      { details: { idempotencyKey } }
    );
    this.name = "ErpFinancialsIdempotencyConflictError";
    this.idempotencyKey = idempotencyKey;
    Object.setPrototypeOf(this, ErpFinancialsIdempotencyConflictError.prototype);
  }
}

type ServiceContext = {
  readonly invoiceAccountPolicy?: InvoiceAccountPolicy;
  readonly financialApprovalPolicy?: FinancialApprovalPolicy;
  readonly customerPaymentCorrectionGuard?: CustomerPaymentCorrectionGuard;
  readonly database: ErpFinancialsTransactionRunner;
  readonly tenantId: string;
  readonly companyId: string;
  readonly sourceId: string;
  readonly bookId?: string;
  readonly currencyCode: IsoCurrencyCode;
  readonly currencyPolicy: "single_currency";
  readonly accountingBasis: AccountingBasis;
  readonly now: () => IsoDateTime;
  readonly postingPolicy: "enforce_fiscal_periods" | "legacy_unrestricted";
};

type NormalizedJournalLine = {
  readonly accountId: AccountId;
  readonly lineId: string;
  readonly lineNumber: number;
  readonly debitMinor: bigint;
  readonly creditMinor: bigint;
  readonly debitAmount: DecimalString;
  readonly creditAmount: DecimalString;
  readonly description?: string;
  readonly partyId?: string;
  readonly itemId?: string;
  readonly dimensionRefs: readonly DimensionRef[];
};

type NormalizedJournalEntry = {
  readonly idempotencyKey: string;
  readonly date: IsoDate;
  readonly transactionNumber?: string;
  readonly memo?: string;
  readonly origin?: JournalEntryOrigin;
  readonly postedAt?: IsoDateTime;
  readonly currencyCode: IsoCurrencyCode;
  readonly accountingBasis: AccountingBasis;
  readonly accountingPolicy: ManualJournalAccountingPolicy;
  readonly lines: readonly NormalizedJournalLine[];
  readonly checksum: string;
  readonly staleReason: string;
  readonly adjustment: boolean;
  readonly sourceTransactionType: string;
  readonly lifecycleAggregateType: string;
  readonly lifecycleEventType: string;
  readonly partyId?: string;
};

type InternalPostJournalEntryInput = PostJournalEntryInput & {
  readonly nativeTransactionType?: string;
  readonly lifecycleAggregateType?: string;
  readonly lifecycleEventType?: string;
  readonly nativePartyId?: string;
};

type ExistingJournalRow = Record<string, unknown> & {
  readonly transaction_id?: unknown;
  readonly status?: unknown;
  readonly source_payload_ref?: unknown;
};

export function createErpFinancials(input: CreateErpFinancialsInput): ErpFinancials {
  const context = serviceContext(input);

  return {
    parties: { ensureActive: command => ensureActiveParty(context, command) },
    accounts: {
      upsertTree(treeInput) {
        return upsertAccountTree(context, treeInput);
      }
    },
    journalEntries: {
      post(journalInput) {
        return journalInput.adjustment ? runFinancialAction(context, "journalEntries.postAdjustment", journalInput, postJournalEntry) : postJournalEntry(context, journalInput);
      },
      postAdjustment(journalInput) {
        return runFinancialAction(context, "journalEntries.postAdjustment", journalInput, (context, command) => postJournalEntry(context, { ...command, adjustment: true }));
      },
      reverse(workflowInput) {
        return runFinancialAction(context, "journalEntries.reverse", workflowInput, (context, workflowInput) => runJournalLifecycleWorkflow(context, "reversed", workflowInput));
      },
      void(workflowInput) {
        return runFinancialAction(context, "journalEntries.void", workflowInput, (context, workflowInput) => runJournalLifecycleWorkflow(context, "voided", workflowInput));
      },
      correct(workflowInput) {
        return runFinancialAction(context, "journalEntries.correct", workflowInput, (context, workflowInput) => runJournalLifecycleWorkflow(context, "corrected", workflowInput));
      },
      replace(workflowInput) {
        return runFinancialAction(context, "journalEntries.replace", workflowInput, (context, workflowInput) => runJournalLifecycleWorkflow(context, "replaced", workflowInput));
      }
    },
    fiscalPeriods: createFiscalPeriodService(context),
    invoices: {
      create: (documentInput) => createInvoice(context, documentInput),
      correctDates: (command) => runFinancialAction(context, "invoices.correctDates", command, correctInvoiceDates)
    },
    cashFlow: { correctPurpose: command => runFinancialAction(context, "cashFlow.correctPurpose", command, correctCashFlowPurpose) },
    customerPayments: { record: (documentInput) => recordCustomerPayment(context, documentInput),
      recordAndApply: (command) => resolveCustomerPaymentCollection(context, command),
      retireCollectionAttempt: ({command, operation}) => resolveCustomerPaymentCollection(context, command, operation),
      previewReturnCash: (command) => previewCustomerPaymentCashReturn(context, command),
      returnCash: (command) => runFinancialAction(context, "customerPayments.returnCash", command, returnCustomerPaymentCash),
      ...createCustomerPaymentCorrectionService(context, (client, journal) => {
        // Keep correction compensation out of the generic journal lifecycle API.
        const correctionJournal: InternalPostJournalEntryInput = {
          ...journal, nativeTransactionType: "Subledger:customer_payment_correction"
        };
        return postJournalEntry({ ...nestedServiceContext(context, client), postingPolicy: "enforce_fiscal_periods" }, correctionJournal);
      }) },
    adjustments: {
      voidIssued: (adjustmentInput) => runFinancialAction(context, "adjustments.voidIssued", adjustmentInput, (context, adjustmentInput) => runIssuedAdjustmentLifecycle(context, "voided", adjustmentInput)),
      replaceIssued: (adjustmentInput) => runFinancialAction(context, "adjustments.replaceIssued", adjustmentInput, (context, adjustmentInput) => runIssuedAdjustmentLifecycle(context, "replaced", adjustmentInput))
    },
    credits: {
      issue: (documentInput) => issueCreditMemo(context, documentInput),
      voidIssued: (adjustmentInput) => runFinancialAction(context, "credits.voidIssued", adjustmentInput, (context, command) => runIssuedAdjustmentLifecycle(
        context, "voided", { ...command, adjustmentType: "credit" }
      )),
      replaceIssued: (adjustmentInput) => runFinancialAction(context, "credits.replaceIssued", adjustmentInput, (context, command) => runIssuedAdjustmentLifecycle(
        context, "replaced", { ...command, adjustmentType: "credit" }
      ))
    },
    refunds: {
      issue: (documentInput) => issueRefund(context, documentInput),
      voidIssued: (adjustmentInput) => runFinancialAction(context, "refunds.voidIssued", adjustmentInput, (context, command) => runIssuedAdjustmentLifecycle(
        context, "voided", { ...command, adjustmentType: "refund" }
      )),
      replaceIssued: (adjustmentInput) => runFinancialAction(context, "refunds.replaceIssued", adjustmentInput, (context, command) => runIssuedAdjustmentLifecycle(
        context, "replaced", { ...command, adjustmentType: "refund" }
      ))
    },
    vendorBills: {
      correctPosted: command => runFinancialAction(context, "vendorBills.correctPosted", command, correctPostedVendorBill),
      setPaymentHold: command => setVendorBillPaymentHold(context, command),
      retirePaymentHoldAttempt: command => retireVendorBillPaymentHoldAttempt(context, command),
      create: (documentInput) => createVendorBill(context, documentInput),
      voidIssued: (workflowInput) => runFinancialAction(context, "vendorBills.voidIssued", workflowInput, (context, workflowInput) => runPostedVendorBillLifecycle(context, "voided", workflowInput)),
      replaceIssued: (workflowInput) => runFinancialAction(context, "vendorBills.replaceIssued", workflowInput, (context, workflowInput) => runPostedVendorBillLifecycle(context, "replaced", workflowInput)),
      voidPosted: (workflowInput) => runFinancialAction(context, "vendorBills.voidIssued", workflowInput, (context, workflowInput) => runPostedVendorBillLifecycle(context, "voided", workflowInput)),
      replacePosted: (workflowInput) => runFinancialAction(context, "vendorBills.replaceIssued", workflowInput, (context, workflowInput) => runPostedVendorBillLifecycle(context, "replaced", workflowInput))
    },
    billPayments: {
      record: (documentInput) => recordBillPayment(context, documentInput),
      recordAndApply: (documentInput) => recordAndApplyBillPayment(context, documentInput),
      retireRecordingAttempt: (input) => retireBillPaymentRecordingAttempt(context, input),
      schedule: (documentInput) => scheduleBillPayment(context, documentInput),
      clear: (workflowInput) => clearScheduledBillPayment(context, workflowInput),
      cancel: (workflowInput) => runFinancialAction(context, "billPayments.cancel", workflowInput, (context, workflowInput) => cancelScheduledBillPayment(context, workflowInput)),
      voidAndUnapply: (workflowInput) => runFinancialAction(context, "billPayments.voidAndUnapply", workflowInput, (context, workflowInput) => voidAndUnapplyBillPayment(context, workflowInput)),
      void: (workflowInput) => runFinancialAction(context, "billPayments.void", workflowInput, (context, workflowInput) => runPostedBillPaymentVoid(context, workflowInput)),
      voidIssued: (workflowInput) => runFinancialAction(context, "billPayments.void", workflowInput, (context, workflowInput) => runPostedBillPaymentVoid(context, workflowInput)),
      voidPosted: (workflowInput) => runFinancialAction(context, "billPayments.void", workflowInput, (context, workflowInput) => runPostedBillPaymentVoid(context, workflowInput))
    },
    writeOffs: {
      record: (documentInput) => recordWriteOff(context, documentInput),
      settleInvoice: (settlementInput) => settleInvoiceWriteOff(context, settlementInput),
      voidIssued: (workflowInput) => runFinancialAction(context, "writeOffs.voidIssued", workflowInput, (context, command) => runIssuedAdjustmentLifecycle(context, "voided", {
        ...command, adjustmentDocumentId: command.writeOffDocumentId, adjustmentType: "write_off"
      })),
      replaceIssued: (workflowInput) => runFinancialAction(context, "writeOffs.replaceIssued", workflowInput, (context, command) => runIssuedAdjustmentLifecycle(context, "replaced", {
        ...command, adjustmentDocumentId: command.writeOffDocumentId, adjustmentType: "write_off"
      }))
    },
    deposits: {
      record: (documentInput) => recordDeposit(context, documentInput),
      reverse: (documentInput) => runFinancialAction(context, "deposits.reverse", documentInput, (context, documentInput) => reverseDeposit(context, documentInput))
    },
    transfers: {
      record: (documentInput) => recordTransfer(context, documentInput),
      reverse: (documentInput) => runFinancialAction(context, "transfers.reverse", documentInput, (context, documentInput) => reverseTransfer(context, documentInput))
    },
    paymentApplications: {
      apply: (applicationInput) => applySubledgerPayment(context, applicationInput),
      retireReceiptAttempt: ({ command, operation }) => applySubledgerPayment(context, command, operation),
      unapply: (applicationInput) => runFinancialAction(context, "paymentApplications.unapply", applicationInput, (context, applicationInput) => endSubledgerApplication(context, applicationInput, "unapplied")),
      void: (applicationInput) => runFinancialAction(context, "paymentApplications.void", applicationInput, (context, applicationInput) => endSubledgerApplication(context, applicationInput, "voided"))
    }
  };
}

export function createPostgresTransactionRunner(
  pool: ErpFinancialsPostgresPool
): ErpFinancialsTransactionRunner {
  return {
    async transaction<Result>(operation: (client: PostgresQueryClient) => Promise<Result>): Promise<Result> {
      const client = await pool.connect();
      let transactionStarted = false, discard = false;
      let connectionFailure: Error | undefined;
      const onConnectionError = (error: Error) => { connectionFailure ??= error; };
      const assertConnection = () => { if (connectionFailure) throw connectionFailure; };
      const observesErrors = typeof client.on === "function" && typeof client.off === "function";
      if (observesErrors) client.on?.("error", onConnectionError);
      try {
        await client.query("begin");
        transactionStarted = true;
        assertConnection();
        const result = await operation(client);
        assertConnection();
        await client.query("commit");
        assertConnection();
        return result;
      } catch (error) {
        if (transactionStarted) {
          try { await client.query("rollback"); } catch { discard = true; }
        } else discard = true;
        // Rollback failure must not hide a command/commit error. Callers recover
        // uncertain commits with their original key; this runner never retries.
        throw error;
      } finally {
        try { if (connectionFailure || discard) client.release(connectionFailure ?? true); else client.release(); }
        finally { if (observesErrors) client.off?.("error", onConnectionError); }
      }
    }
  };
}

async function ensureActiveParty(context: ServiceContext, command: EnsureActivePartyInput): Promise<EnsureActivePartyResult> {
  const input = { ...command, operation: copyFinancialOperation(command.operation) };
  assertFinancialOperationContext(input.operation);
  for (const value of [input.partyId, input.sourcePartyId, input.displayName]) {
    if (typeof value !== "string" || !value.trim() || value.length > 512) {
      throw new ErpFinancialsValidationError("Party identity and display name must be nonempty and at most 512 characters");
    }
  }
  if (!(new Set<string>(["customer", "vendor"])).has(input.partyType)) {
    throw new ErpFinancialsValidationError("Operational party registration requires customer or vendor");
  }
  return context.database.transaction(async client => {
    await assertCompanySourceScope(client, context);
    // The unique source identity serializes concurrent first registration.
    // Never UPDATE on conflict: an importer or accountant may have disabled it.
    const inserted = await client.query(
      `insert into erp_financials.parties
       (party_id,tenant_id,source_id,source_party_id,party_type,display_name,active)
       values ($1,$2,$3,$4,$5,$6,true)
       on conflict (tenant_id,source_id,source_party_id) do nothing returning party_id`,
      [input.partyId, context.tenantId, context.sourceId, input.sourcePartyId, input.partyType, input.displayName]
    );
    const stored = (await client.query<{ party_id: string; party_type: string; active: boolean }>(
      `select party_id,party_type,active from erp_financials.parties
       where tenant_id=$1 and source_id=$2 and source_party_id=$3 for share`,
      [context.tenantId, context.sourceId, input.sourcePartyId]
    )).rows[0];
    if (!stored || stored.party_id !== input.partyId || stored.party_type !== input.partyType) {
      throw new ErpFinancialsError("scope_mismatch", "Operational party identity conflicts with existing accounting identity");
    }
    if (!stored.active) throw new ErpFinancialsError("missing_party", "Accounting party is inactive");
    // FOR SHARE blocks non-key active-state updates through the caller's commit.
    if (inserted.rows.length) {
      await appendFinancialLifecycleEvent(client, {
        tenantId: context.tenantId, companyId: context.companyId, sourceId: context.sourceId,
        aggregateType: "party", aggregateId: input.partyId, eventType: "party.registered",
        idempotencyKey: `party-registration:${createHash("sha256").update(input.sourcePartyId).digest("hex")}`,
        operation: input.operation, recordedAt: context.now(),
        payload: { partyId: input.partyId, sourcePartyId: input.sourcePartyId,
          partyType: input.partyType, displayName: input.displayName }
      });
    }
    return { partyId: stored.party_id };
  });
}

async function upsertAccountTree(
  context: ServiceContext,
  input: UpsertAccountTreeInput
): Promise<UpsertAccountTreeResult> {
  const accounts = flattenAccountTree(context, input);
  assertFinancialOperationContext(input.operation);

  return context.database.transaction(async (client) => {
    await acquireTransactionLock(client, `account-hierarchy:${context.tenantId}:${context.sourceId}`);
    await assertCompanySourceScope(client, context);
    const storage = createPostgresStorageAdapter(client);
    const existingAccounts = await storage.loadAccounts({
      tenantId: context.tenantId,
      sourceId: context.sourceId
    });

    assertAccountIdentitiesAreStable(existingAccounts, accounts);

    const prospectiveAccounts = new Map(existingAccounts.map((account) => [account.accountId, account]));
    for (const account of accounts) {
      prospectiveAccounts.set(account.accountId, account);
    }
    assertValidAccountHierarchy([...prospectiveAccounts.values()]);

    const accountsWritten = await storage.upsertAccounts(accounts);
    const snapshotsMarkedStale = await storage.markReportSnapshotsStaleForAccountHierarchyChanges({
      tenantId: context.tenantId,
      companyId: context.companyId,
      sourceId: context.sourceId,
      staleReason: input.staleReason ?? ACCOUNT_HIERARCHY_CHANGED_STALE_REASON
    });
    const lifecycle = await appendFinancialLifecycleEvent(client, {
      tenantId: context.tenantId,
      companyId: context.companyId,
      sourceId: context.sourceId,
      aggregateType: "account_hierarchy",
      aggregateId: context.sourceId,
      eventType: "account_hierarchy.upserted",
      idempotencyKey: `account-hierarchy:${input.operation.requestId}`,
      operation: input.operation,
      recordedAt: context.now(),
      payload: {
        accountIds: accounts.map((account) => account.accountId),
        accountsWritten,
        snapshotsMarkedStale
      }
    });
    await appendServiceOutboxEvent(client, context, {
      eventType: "account_hierarchy.changed",
      aggregateType: "account_hierarchy",
      aggregateId: context.sourceId,
      idempotencyKey: `account-hierarchy:${input.operation.requestId}`,
      payload: {
        accountIds: accounts.map((account) => account.accountId),
        snapshotsMarkedStale
      }
    });

    return {
      accounts,
      accountsWritten,
      snapshotsMarkedStale,
      lifecycleEventId: lifecycle.eventId
    };
  });
}

async function postJournalEntry(
  context: ServiceContext,
  input: PostJournalEntryInput
): Promise<PostJournalEntryResult> {
  const journal = normalizeJournalEntry(context, input);
  assertFinancialOperationContext(input.operation);
  if (journal.adjustment) {
    assertFinancialApproval(context, input.operation);
  }
  const identities = journalIdentities(context, journal);

  return context.database.transaction(async (client) => {
    await lockCustomerPaymentCorrectionSource(client, context.tenantId, context.sourceId);
    await acquireTransactionLock(
      client,
      `journal-entry:${context.tenantId}:${context.sourceId}:${journal.idempotencyKey}`
    );
    await assertCompanySourceScope(client, context);

    const posted = await executePostJournalEntryInTransaction(client, context, input, journal, identities);
    const mirrored = await executeJournalBasisMirror(client, context, input, journal);
    return mirrored === undefined ? posted : combineJournalResults(posted, mirrored);
  });
}

async function executePostJournalEntryInTransaction(
  client: PostgresQueryClient,
  context: ServiceContext,
  input: PostJournalEntryInput,
  journal: NormalizedJournalEntry,
  identities: ReturnType<typeof journalIdentities>,
  accountRequirements: readonly { readonly accountId: string; readonly classifications: readonly AccountClassification[] }[] = [],
  validateNewPosting?: ()=>void
): Promise<PostJournalEntryResult> {
    const existing = await loadExistingJournal(
      client,
      context,
      journal.idempotencyKey,
      journal.sourceTransactionType
    );
    if (existing !== undefined) {
      if (
        existing.transactionId === identities.transactionId &&
        existing.status === "posted" &&
        sourceRefChecksum(existing.sourcePayloadRef) === journal.checksum
      ) {
        const eventKey = `${journal.lifecycleAggregateType}:${journal.sourceTransactionType}:${journal.idempotencyKey}:posted`;
        const event = (await client.query(
          `select "event_id", "aggregate_type", "aggregate_id", "event_type", "actor_ref", "approver_ref", "reason_code", "reason_detail"
from "erp_financials"."financial_lifecycle_events"
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3 and "idempotency_key" = $4
for key share`,
          [context.tenantId, context.companyId, context.sourceId, eventKey]
        )).rows[0];
        if (!event || event.aggregate_type !== journal.lifecycleAggregateType || event.aggregate_id !== identities.transactionId ||
            event.event_type !== journal.lifecycleEventType || event.actor_ref !== input.operation.actorRef ||
            (event.approver_ref ?? null) !== (input.operation.approverRef ?? null) ||
            event.reason_code !== input.operation.reasonCode || (event.reason_detail ?? null) !== (input.operation.reasonDetail ?? null)) {
          throw new ErpFinancialsIdempotencyConflictError(journal.idempotencyKey);
        }
        return alreadyPostedResult(identities, storedString(event.event_id, "event_id"));
      }
      throw new ErpFinancialsIdempotencyConflictError(journal.idempotencyKey);
    }

    validateNewPosting?.();

    if (context.postingPolicy === "enforce_fiscal_periods") {
      await assertPostingDateAllowed(client, context, journal.date, {
        allowClosingAdjustment: journal.adjustment
      });
    }

    const storage = createPostgresStorageAdapter(client);
    const accountIds = unique(journal.lines.map((line) => line.accountId));
    await assertPostingAccountEligibility(client, context, accountIds);
    if (accountRequirements.length) await client.query(
      `select account_id from erp_financials.accounts where tenant_id=$1 and source_id=$2 and account_id=any($3::text[]) order by account_id for share`,
      [context.tenantId, context.sourceId, [...new Set(accountRequirements.map(item => item.accountId))].sort()]);
    const accounts = await storage.loadAccounts({
      tenantId: context.tenantId,
      sourceId: context.sourceId,
      accountIds
    });
    assertJournalAccounts(accounts, accountIds);
    for (const requirement of accountRequirements) {
      const account = accounts.find(candidate => candidate.accountId === requirement.accountId);
      if (!account || !requirement.classifications.includes(account.classification)) {
        throw new ErpFinancialsValidationError("Account classification does not satisfy the posting policy", "invalid_input", { accountId: requirement.accountId });
      }
    }

    const postedAt = journal.postedAt ?? context.now();
    assertIsoDateTime(postedAt, "postedAt");
    const facts = journalFacts(context, journal, identities, postedAt);

    const writeCounts: JournalEntryWriteCounts = {
      importBatches: await storage.upsertImportBatch(facts.importBatch),
      transactions: await storage.upsertTransactions([facts.transaction]),
      transactionLines: await storage.upsertTransactionLines(facts.transactionLines),
      postings: await storage.upsertLedgerPostings(facts.postings)
    };
    const snapshotsMarkedStale = await storage.markReportSnapshotsStaleForPostingChanges({
      tenantId: context.tenantId,
      companyId: context.companyId,
      sourceId: context.sourceId,
      affectedStart: journal.date,
      affectedEnd: journal.date,
      staleReason: journal.staleReason,
      accountingBasis: journal.accountingBasis,
      currencyCode: journal.currencyCode
    });
    const lifecycle = await appendJournalPostedLifecycleEvent(client, context, input.operation, journal, identities, accountRequirements);
    const ledgerPayload = {
      accountingBasis: journal.accountingBasis,
      currencyCode: journal.currencyCode,
      postingDate: journal.date,
      transactionId: identities.transactionId
    };
    const inlinePayload = { ...ledgerPayload, postingIds: identities.postingIds };
    // Preserve existing small-event payloads. Large journals publish a complete
    // locator plus explicit omission metadata, never a truncated list of facts.
    const payload = Buffer.byteLength(JSON.stringify(inlinePayload), "utf8") <= FINANCIAL_OUTBOX_MAX_PAYLOAD_BYTES
      ? inlinePayload
      : { ...ledgerPayload, postingCount: identities.postingIds.length, postingIdsOmitted: true };
    await appendServiceOutboxEvent(client, context, {
      eventType: "ledger.posted",
      aggregateType: journal.lifecycleAggregateType,
      aggregateId: identities.transactionId,
      idempotencyKey: `ledger-posted:${journal.sourceTransactionType}:${journal.idempotencyKey}`,
      payload
    });

    return {
      status: "posted",
      transactionId: identities.transactionId,
      transactionLineIds: identities.transactionLineIds,
      postingIds: identities.postingIds,
      importBatchId: identities.importBatchId,
      snapshotsMarkedStale,
      writeCounts,
      lifecycleEventId: lifecycle.eventId
    };
}

type SubledgerDocumentWrite = {
  readonly recognitionDate?: IsoDate;
  readonly documentType: SubledgerDocumentType;
  readonly idempotencyKey: string;
  readonly date: IsoDate;
  readonly dueDate?: IsoDate;
  readonly documentNumber?: string;
  readonly partyId?: string;
  readonly currencyCode: IsoCurrencyCode;
  readonly amount: DecimalString;
  readonly documentStartsOpen: boolean;
  readonly metadata: Readonly<Record<string, JsonValue>>;
  readonly journalLines: readonly PostJournalEntryLineInput[];
  readonly documentLines?: readonly NormalizedSubledgerAmountLine[];
  readonly memo?: string;
  readonly operation: FinancialOperationContext;
  readonly accountRequirements?: readonly { readonly accountId: string; readonly classifications: readonly AccountClassification[] }[];
  readonly validateNewPosting?: ()=>void;
};

async function correctInvoiceDates(context: ServiceContext, input: CorrectInvoiceDatesInput): Promise<CorrectInvoiceDatesResult> {
  assertFinancialApproval(context, input.operation);
  assertNonEmpty(input.invoiceId, "invoiceId");
  assertNonEmpty(input.idempotencyKey, "idempotencyKey");
  assertExpectedSubledgerVersion(input.expectedVersion, "expectedVersion");
  assertIsoDate(input.documentDate, "documentDate");
  if (input.recognitionDate !== undefined) assertIsoDate(input.recognitionDate, "recognitionDate");
  assertIsoDate(input.dueDate, "dueDate");
  const explicitRecognitionDate = input.recognitionDate !== undefined;
  const command = { invoiceId: input.invoiceId, expectedVersion: input.expectedVersion,
    idempotencyKey: input.idempotencyKey, documentDate: input.documentDate, dueDate: input.dueDate,
    ...(input.recognitionDate !== undefined && input.recognitionDate !== input.documentDate ? { recognitionDate: input.recognitionDate } : {}),
    operation: copyFinancialOperation(input.operation) };
  const { operation, ...business } = command;
  const checksum = createHash("sha256").update(stableJson(JSON.parse(JSON.stringify({ ...business,
    actorRef: operation.actorRef, approverRef: operation.approverRef,
    reasonCode: operation.reasonCode, reasonDetail: operation.reasonDetail
  })) as JsonValue)).digest("hex");
  const eventKey = `invoice-date-correction:${command.idempotencyKey}:completed`;
  return context.database.transaction(async client => {
    await lockCustomerPaymentCorrectionSource(client, context.tenantId, context.sourceId);
    await acquireTransactionLock(client, `invoice-date-correction:${context.tenantId}:${context.companyId}:${context.sourceId}:${command.idempotencyKey}`);
    await assertCompanySourceScope(client, context);
    const replay = (await client.query(
      `select "event_id", "aggregate_id", "payload" from "erp_financials"."financial_lifecycle_events"
where "tenant_id"=$1 and "company_id"=$2 and "source_id"=$3 and "idempotency_key"=$4`,
      [context.tenantId, context.companyId, context.sourceId, eventKey]
    )).rows[0];
    if (replay) {
      const payload = storedJson(replay.payload) as { commandChecksum?: string; result?: Omit<CorrectInvoiceDatesResult, "lifecycleEventId"> } | null;
      if (replay.aggregate_id !== command.invoiceId || payload?.commandChecksum !== checksum || !payload.result) {
        throw new ErpFinancialsIdempotencyConflictError(command.idempotencyKey);
      }
      return { ...payload.result, lifecycleEventId: storedString(replay.event_id, "event_id") };
    }
    const invoice = (await client.query(
      `select *, "document_date"::text as "document_date", "due_date"::text as "due_date", "recognition_date"::text as "recognition_date" from "erp_financials"."subledger_documents"
where "tenant_id"=$1 and "company_id"=$2 and "source_id"=$3 and "subledger_document_id"=$4 for update`,
      [context.tenantId, context.companyId, context.sourceId, command.invoiceId]
    )).rows[0];
    if (!invoice || invoice.document_type !== "invoice") throw new ErpFinancialsError("missing_document", "Invoice is not in this write source");
    if (invoice.status === "voided" || (await client.query(
      `select 1 from "erp_financials"."invoice_voids" where "tenant_id"=$1 and "company_id"=$2 and "source_id"=$3 and "invoice_document_id"=$4 limit 1`,
      [context.tenantId, context.companyId, context.sourceId, command.invoiceId]
    )).rows.length) throw new ErpFinancialsError("terminal_state_conflict", "A voided invoice cannot be date-corrected");
    const version = storedInteger(invoice.version, "version");
    if (version !== command.expectedVersion) throw new ErpFinancialsError("optimistic_concurrency_conflict", "Invoice changed before correction", { retryable: true });
    const previousDate = storedDate(invoice.document_date, "document_date");
    const previousRecognitionDate = storedDate(invoice.recognition_date ?? invoice.document_date, "recognition_date");
    if (previousRecognitionDate !== previousDate && !explicitRecognitionDate) throw new ErpFinancialsValidationError("An invoice with distinct dates requires an explicit recognitionDate for correction");
    const recognitionDate = command.recognitionDate ?? command.documentDate;
    const previousDueDate = storedOptionalDate(invoice.due_date, "due_date") ?? null;
    const earlierApplication = await client.query(`select 1 from "erp_financials"."subledger_applications"
where "tenant_id"=$1 and "company_id"=$2 and "source_id"=$3 and "target_document_id"=$4 and "application_date"<$5::date limit 1`,
      [context.tenantId,context.companyId,context.sourceId,command.invoiceId,recognitionDate]);
    if (earlierApplication.rows.length) throw new ErpFinancialsValidationError("Recognition cannot follow historical invoice applications; use an explicit economic correction");
    // Corrections always honor both periods, including callers using legacy import policy.
    await assertPostingDateAllowed(client, context, previousRecognitionDate);
    await assertPostingDateAllowed(client, context, recognitionDate);
    const original = await loadPostedJournalForLifecycle(client, context, storedString(invoice.transaction_id, "transaction_id"), [subledgerTransactionType("invoice")], "accrual");
    if (original.accountingBasis !== "accrual" || original.currencyCode !== context.currencyCode) {
      throw new ErpFinancialsError("unsupported_operation", "Invoice correction requires a native accrual invoice in the scope currency");
    }
    let reversalTransactionId: string | undefined;
    let replacementTransactionId: string | undefined;
    if (previousRecognitionDate !== recognitionDate) {
      const nested = { ...nestedServiceContext(context, client), postingPolicy: "enforce_fiscal_periods" as const };
      const common = { operation, accountingBasis: "accrual" as const, currencyCode: original.currencyCode,
        nativeTransactionType: "Subledger:invoice_date_correction", nativePartyId: storedString(invoice.party_id, "party_id"),
        origin: { module: "invoice_date_correction", reference: command.invoiceId } };
      const reversal = await postJournalEntry(nested, { ...common, idempotencyKey: `${eventKey}:reversal`,
        date: previousRecognitionDate, memo: `Invoice date correction: reverse ${command.invoiceId}`, lines: original.lines });
      const replacement = await postJournalEntry(nested, { ...common, idempotencyKey: `${eventKey}:replacement`,
        date: recognitionDate, memo: `Invoice date correction: restate ${command.invoiceId}`,
        lines: original.lines.map(line => {
          const { debit, credit, ...dimensions } = line;
          return { ...dimensions, ...(credit === undefined ? { credit: debit } : { debit: credit }) };
        }) });
      reversalTransactionId = reversal.transactionId;
      replacementTransactionId = replacement.transactionId;
    }
    const result: Omit<CorrectInvoiceDatesResult, "lifecycleEventId"> = {
      invoiceId: command.invoiceId, version: version + 1, documentDate: command.documentDate, dueDate: command.dueDate,
      ...(recognitionDate !== command.documentDate ? { recognitionDate } : {}),
      originalTransactionId: original.transactionId,
      ...(reversalTransactionId !== undefined && replacementTransactionId !== undefined ? { reversalTransactionId, replacementTransactionId } : {})
    };
    const event = await appendFinancialLifecycleEvent(client, {
      tenantId: context.tenantId, companyId: context.companyId, sourceId: context.sourceId,
      aggregateType: "subledger_document", aggregateId: command.invoiceId,
      eventType: "subledger.invoice.dates_corrected", idempotencyKey: eventKey, operation, recordedAt: context.now(),
      payload: { commandChecksum: checksum, expectedVersion: version, previousDate, previousDueDate,
        ...(previousRecognitionDate !== previousDate ? { previousRecognitionDate } : {}), result }
    });
    const updated = await client.query(
      `update "erp_financials"."subledger_documents" set "document_date"=$5, "due_date"=$6, "recognition_date"=$9, "version"="version"+1, "updated_at"=$7
where "tenant_id"=$1 and "company_id"=$2 and "source_id"=$3 and "subledger_document_id"=$4 and "version"=$8 returning "version"`,
      [context.tenantId, context.companyId, context.sourceId, command.invoiceId, command.documentDate, command.dueDate, context.now(), version, recognitionDate === command.documentDate ? null : recognitionDate]
    );
    if (!updated.rows[0]) throw new ErpFinancialsError("optimistic_concurrency_conflict", "Invoice changed before correction", { retryable: true });
    await appendServiceOutboxEvent(client, context, {
      eventType: "subledger.invoice.dates_corrected", aggregateType: "subledger_document", aggregateId: command.invoiceId,
      idempotencyKey: `${eventKey}:outbox`, payload: { ...result, lifecycleEventId: event.eventId }
    });
    return { ...result, lifecycleEventId: event.eventId };
  });
}

async function createInvoice(context: ServiceContext, input: CreateInvoiceInput): Promise<SubledgerDocumentResult> {
  input = structuredClone(input);
  const policy = context.invoiceAccountPolicy;
  const revenueLines = normalizeInvoiceLines(input.revenueLines);
  const amount = sumSubledgerLines(revenueLines, "revenueLines");
  return createSubledgerDocument(context, {
    ...commonSubledgerDocument(context, input, "invoice", amount, true),
    accountRequirements: [
      ...(policy ? [{accountId:resolveAccountId(context,input.receivableAccount),classifications:policy.receivableClassifications},
        ...revenueLines.map(line=>({accountId:resolveAccountId(context,line),classifications:policy.revenueClassifications}))] : []),
      ...revenueLines.flatMap(line=>invoiceComponentRequirements(line,policy,ref=>resolveAccountId(context,ref)))
    ],
    validateNewPosting: ()=>{ for(const line of revenueLines) assertInvoiceComponentPolicy(line,policy,resolveAccountId(context,input.receivableAccount),ref=>resolveAccountId(context,ref)); },
    ...(input.recognitionDate === undefined || input.recognitionDate === input.date ? {} : { recognitionDate: input.recognitionDate }),
    dueDate: input.dueDate,
    partyId: input.customerId,
    journalLines: [
      { ...input.receivableAccount, debit: amount, partyId: input.customerId },
      ...revenueLines.flatMap(line=>invoiceComponentJournalLines(line,input.customerId))
    ],
    documentLines: revenueLines
  });
}

async function recordCustomerPayment(
  context: ServiceContext,
  input: RecordCustomerPaymentInput
): Promise<SubledgerDocumentResult> {
  const amount = normalizedPositiveMoney(input.amount, "amount");
  const provenance = paymentProvenance(input.provenance);
  if (input.cashFlowActivity !== undefined && !["operating", "investing", "financing"].includes(input.cashFlowActivity)) {
    throw new ErpFinancialsValidationError("cashFlowActivity must be operating, investing or financing");
  }
  if (input.collectionRef !== undefined && (typeof input.collectionRef !== "string" || !input.collectionRef.trim() || input.collectionRef.length > 512)) throw new ErpFinancialsValidationError("collectionRef must contain 1–512 characters");
  return createSubledgerDocument(context, {
    ...commonSubledgerDocument(
      context,
      input,
      "customer_payment",
      amount,
      true,
      { ...(provenance === undefined ? {} : { customerPaymentProvenance: provenance }),
        ...(input.cashFlowActivity === undefined ? {} : { cashFlowActivity: input.cashFlowActivity }),
        ...(input.collectionRef === undefined ? {} : { collectionRef: input.collectionRef }) }
    ),
    partyId: input.customerId,
    journalLines: [
      { ...input.cashAccount, debit: amount, partyId: input.customerId },
      { ...input.receivableAccount, credit: amount, partyId: input.customerId }
    ]
  });
}

function resolveCustomerPaymentCollection(context: ServiceContext, input: RecordAndApplyCustomerPaymentInput): Promise<RecordAndApplyCustomerPaymentResult>;
function resolveCustomerPaymentCollection(context: ServiceContext, input: RecordAndApplyCustomerPaymentInput, retirement: FinancialOperationContext): Promise<RetireCustomerPaymentCollectionResult>;
async function resolveCustomerPaymentCollection(context: ServiceContext, input: RecordAndApplyCustomerPaymentInput, retirementInput?: FinancialOperationContext): Promise<RetireCustomerPaymentCollectionResult> {
  const retirement = retirementInput === undefined ? undefined : copyFinancialOperation(retirementInput);
  if (retirement) {
    assertFinancialOperationContext(retirement);
    if (retirement.actorRef !== input.operation.actorRef) throw new ErpFinancialsError("authorization_context_invalid", "Only the original collection actor may retire its unrecorded attempt");
  }
  assertFinancialOperationContext(input.operation);
  assertNonEmpty(input.idempotencyKey, "idempotencyKey");
  assertNonEmpty(input.invoiceId, "invoiceId");
  assertExpectedSubledgerVersion(input.expectedInvoiceVersion, "expectedInvoiceVersion");
  const { applicationAmount: requestedApplicationAmount, applicationDate: requestedApplicationDate, ...receiptInput } = structuredClone(input);
  const applicationDate = requestedApplicationDate ?? receiptInput.date;
  assertIsoDate(receiptInput.date, "date");
  assertIsoDate(applicationDate, "applicationDate");
  if (applicationDate < receiptInput.date) throw new ErpFinancialsValidationError("Application cannot precede cash receipt");
  const amount = normalizedPositiveMoney(receiptInput.amount, "amount");
  const applicationAmount = requestedApplicationAmount === undefined ? amount : normalizedPositiveMoney(requestedApplicationAmount, "applicationAmount");
  if (parsePositiveMoney(applicationAmount, "applicationAmount") > parsePositiveMoney(amount, "amount")) {
    throw new ErpFinancialsValidationError("applicationAmount cannot exceed the receipt amount");
  }
  // Preserve the previous checksum for full-receipt applications, including
  // retries of commands committed before this optional field was introduced.
  const command = { ...receiptInput, amount,
    ...(applicationAmount === amount ? {} : { applicationAmount }),
    ...(applicationDate === receiptInput.date ? {} : { applicationDate }),
    operation: copyFinancialOperation(input.operation) };
  const { operation, ...business } = command;
  const checksum = createHash("sha256").update(stableJson(JSON.parse(JSON.stringify({ ...business,
    bookId: context.bookId ?? null, currencyCode: command.currencyCode ?? context.currencyCode,
    actorRef: operation.actorRef, approverRef: operation.approverRef,
    reasonCode: operation.reasonCode, reasonDetail: operation.reasonDetail
  })) as JsonValue)).digest("hex");
  const retirementChecksum = retirement === undefined ? undefined : createHash("sha256").update(stableJson({
    actorRef: retirement.actorRef, approverRef: retirement.approverRef ?? null,
    reasonCode: retirement.reasonCode, reasonDetail: retirement.reasonDetail ?? null
  })).digest("hex");
  const eventKey = `customer-payment-collection:${command.idempotencyKey}:completed`;
  return context.database.transaction(async client => {
    // Match the application/correction lock order before any cash posting.
    await lockCustomerPaymentCorrectionSource(client, context.tenantId, context.sourceId);
    await acquireTransactionLock(client, `customer-payment-collection:${context.tenantId}:${context.companyId}:${context.sourceId}:${command.idempotencyKey}`);
    await assertCompanySourceScope(client, context);
    const replay = (await client.query(
      `select "event_id", "aggregate_id", "payload" from "erp_financials"."financial_lifecycle_events"
where "tenant_id"=$1 and "company_id"=$2 and "source_id"=$3 and "idempotency_key"=$4`,
      [context.tenantId, context.companyId, context.sourceId, eventKey]
    )).rows[0];
    if (replay) {
      const payload = storedJson(replay.payload) as { commandChecksum?: string; retired?: boolean; invoiceId?: string; retirementChecksum?: string; result?: Omit<RecordAndApplyCustomerPaymentResult, "status" | "lifecycleEventId"> } | null;
      if (payload?.retired === true) {
        if (!retirement || payload.commandChecksum !== checksum || payload.retirementChecksum !== retirementChecksum
          || payload.invoiceId !== command.invoiceId || replay.aggregate_id !== `collection-attempt:${checksum}`) throw new ErpFinancialsIdempotencyConflictError(command.idempotencyKey);
        return {status:"already_retired",invoiceId:command.invoiceId,idempotencyKey:command.idempotencyKey,lifecycleEventId:storedString(replay.event_id,"event_id")};
      }
      if (payload?.commandChecksum !== checksum || !payload.result || replay.aggregate_id !== payload.result.paymentId) {
        throw new ErpFinancialsIdempotencyConflictError(command.idempotencyKey);
      }
      return { ...payload.result, status: "already_recorded_and_applied", lifecycleEventId: storedString(replay.event_id, "event_id") };
    }
    if (retirement) {
      const independent = await client.query(`select subledger_document_id from erp_financials.subledger_documents
        where tenant_id=$1 and company_id=$2 and source_id=$3 and idempotency_key=$4`,
        [context.tenantId,context.companyId,context.sourceId,command.idempotencyKey]);
      if (independent.rows.length) throw new ErpFinancialsIdempotencyConflictError(command.idempotencyKey);
      // A source can serve several books. Verify the target's original native
      // posting provenance; do not infer a book from current caller configuration.
      const target = (await client.query(`select d.party_id, o.book_id
        from erp_financials.subledger_documents d join erp_financials.financial_outbox o
          on o.tenant_id=d.tenant_id and o.company_id=d.company_id and o.source_id=d.source_id
          and o.aggregate_id=d.transaction_id and o.event_type='ledger.posted'
        where d.tenant_id=$1 and d.company_id=$2 and d.source_id=$3 and d.subledger_document_id=$4
          and d.document_type='invoice' for key share of d,o`,
        [context.tenantId,context.companyId,context.sourceId,command.invoiceId])).rows;
      const original=target[0];
      if (target.length!==1 || !original || original.party_id!==command.customerId || storedOptionalString(original.book_id)!==context.bookId) {
        throw new ErpFinancialsError("scope_mismatch", "Collection retirement requires the original customer's native invoice in this book and source");
      }
      if (retirementChecksum===undefined) throw new Error("Collection retirement checksum is missing");
      const lifecycle=await appendFinancialLifecycleEvent(client,{...context,operation:retirement,
        aggregateType:"customer_payment_collection",aggregateId:`collection-attempt:${checksum}`,
        eventType:"customer_payment.collection_retired",idempotencyKey:eventKey,recordedAt:context.now(),
        payload:{commandChecksum:checksum,retired:true,invoiceId:command.invoiceId,retirementChecksum}});
      return {status:"retired",invoiceId:command.invoiceId,idempotencyKey:command.idempotencyKey,lifecycleEventId:lifecycle.eventId};
    }
    const nested = { ...context, database: { transaction: async <T>(work: (client: PostgresQueryClient) => Promise<T>) => work(client) } };
    const payment = await recordCustomerPayment(nested, command);
    // An independently recorded receipt is not a replay of this composite
    // command. Its allocations must use the explicit application API.
    if (payment.status === "already_posted") throw new ErpFinancialsIdempotencyConflictError(command.idempotencyKey);
    const application = await applySubledgerPayment(nested, {
      operation, idempotencyKey: `customer-payment-collection:${command.idempotencyKey}:apply`,
      applicationType: "customer_payment_to_invoice", sourceDocumentId: payment.documentId,
      targetDocumentId: command.invoiceId, amount: applicationAmount, applicationDate,
      expectedSourceVersion: payment.version, expectedTargetVersion: command.expectedInvoiceVersion
    });
    const result = { paymentId: payment.documentId, invoiceId: command.invoiceId, applicationId: application.applicationId,
      paymentTransactionId: payment.journal.transactionId, amount: command.amount };
    const lifecycle = await appendFinancialLifecycleEvent(client, { ...context, operation,
      aggregateType: "customer_payment", aggregateId: payment.documentId, eventType: "customer_payment.recorded_and_applied",
      idempotencyKey: eventKey, recordedAt: context.now(), payload: { commandChecksum: checksum, result } });
    return { ...result, status: "recorded_and_applied", lifecycleEventId: lifecycle.eventId };
  });
}

function normalizeCustomerPaymentCashReturn(input: PreviewCustomerPaymentCashReturnInput): PreviewCustomerPaymentCashReturnInput {
  const releaseInputs: PreviewCustomerPaymentCashReturnInput["releases"] = input.releases;
  assertNonEmpty(input.paymentId, "paymentId");
  assertNonEmpty(input.customerId, "customerId");
  assertExpectedSubledgerVersion(input.expectedVersion, "expectedVersion");
  assertIsoDate(input.date, "date");
  if (!["refund", "void"].includes(input.returnKind) || !Array.isArray(input.releases)) {
    throw new ErpFinancialsValidationError("Return requires refund/void kind and an explicit application release plan");
  }
  const command = { paymentId: input.paymentId, customerId: input.customerId, expectedVersion: input.expectedVersion,
    date: input.date, amount: normalizedPositiveMoney(input.amount, "amount"), returnKind: input.returnKind,
    releases: releaseInputs.map(release => {
      assertNonEmpty(release.applicationId, "applicationId");
      assertExpectedSubledgerVersion(release.expectedVersion, "release.expectedVersion");
      return { applicationId: release.applicationId, expectedVersion: release.expectedVersion,
        amount: normalizedPositiveMoney(release.amount, "release.amount") };
    }).sort((a,b) => a.applicationId.localeCompare(b.applicationId)) };
  if (new Set(command.releases.map(release => release.applicationId)).size !== command.releases.length) {
    throw new ErpFinancialsValidationError("Application release identities must be unique");
  }
  return command;
}

/** Shared by preflight and posting: all amounts and versions come from the same
 * scoped transaction. Locks are released when the caller's transaction ends. */
async function prepareCustomerPaymentCashReturn(client: PostgresQueryClient, context: ServiceContext,
  command: PreviewCustomerPaymentCashReturnInput) {
    const receipt = (await client.query(
      `select *, "document_date"::text as "document_date", "due_date"::text as "due_date" from "erp_financials"."subledger_documents"
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3 and "subledger_document_id" = $4 for update`,
      [context.tenantId, context.companyId, context.sourceId, command.paymentId]
    )).rows[0];
    if (receipt?.document_type !== "customer_payment") throw new ErpFinancialsError("missing_document", "Receipt does not exist in the write source");
    if (receipt.party_id !== command.customerId || receipt.currency_code !== context.currencyCode) {
      throw new ErpFinancialsError("scope_mismatch", "Receipt customer or currency does not match the return");
    }
    if (receipt.status === "voided") throw new ErpFinancialsError("terminal_state_conflict", "Voided receipt cannot be returned");
    if (storedInteger(receipt.version, "version") !== command.expectedVersion) {
      throw new ErpFinancialsError("optimistic_concurrency_conflict", "Receipt changed before cash return", { retryable: true });
    }
    if (command.date < storedDate(receipt.document_date, "document_date")) throw new ErpFinancialsValidationError("Return cannot precede receipt date");
    await assertPostingDateAllowed(client, context, command.date);
    const amount = parsePositiveMoney(command.amount, "amount");
    const priorReturns = (await client.query(
      `select coalesce(sum("applied_amount"), 0)::text as returned from "erp_financials"."subledger_applications"
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3 and "source_document_id" = $4
  and "application_type" = 'customer_payment_to_refund' and "status" = 'applied'`,
      [context.tenantId, context.companyId, context.sourceId, command.paymentId]
    )).rows[0];
    const returned = parsePositiveOrZeroMoney(priorReturns?.returned, "returned");
    const originalAmount = parsePositiveMoney(storedMoney(receipt.original_amount, "original_amount"), "original_amount");
    if (amount > originalAmount - returned) throw new ErpFinancialsValidationError("Return exceeds the remaining recorded receipt");
    if (command.returnKind === "void" && (returned !== 0n || amount !== originalAmount)) {
      throw new ErpFinancialsValidationError("Cash void must return the entire unrefunded receipt");
    }
    const available = parsePositiveOrZeroMoney(receipt.open_amount, "open_amount");
    const requiredRelease = amount > available ? amount - available : 0n;
    const requestedRelease = command.releases.reduce((sum, release) => sum + parsePositiveMoney(release.amount, "release.amount"), 0n);
    if (requestedRelease !== requiredRelease) throw new ErpFinancialsValidationError("Release plan must use available receipt credit first and release exactly the remaining return amount");
    // Native receipts have one cash debit and one receivable credit. Derive
    // refund accounts from their immutable journal, never from caller input.
    const original = await loadPostedJournalForLifecycle(client, context, storedString(receipt.transaction_id, "transaction_id"), [subledgerTransactionType("customer_payment")]);
    if (original.lines.length !== 2 || original.currencyCode !== context.currencyCode) throw new ErpFinancialsError("unsupported_operation", "Receipt cash return requires a native two-account receipt");
    const receivable = original.lines.find((line) => line.debit !== undefined);
    const cash = original.lines.find((line) => line.credit !== undefined);
    if (!receivable || !cash) throw new ErpFinancialsValidationError("Receipt journal has invalid cash/receivable sides");

    const accountIds = [resolveAccountId(context, receivable), resolveAccountId(context, cash)];
    await assertPostingAccountEligibility(client, context, accountIds);
    const accounts = await createPostgresStorageAdapter(client).loadAccounts({ tenantId: context.tenantId, sourceId: context.sourceId, accountIds });
    assertJournalAccounts(accounts, accountIds);
    const applications = new Map<string, Record<string, unknown>>();
    for (const release of command.releases) {
      const application = (await client.query(
        `select *, "application_date"::text as "application_date" from "erp_financials"."subledger_applications"
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3 and "subledger_application_id" = $4 for update`,
        [context.tenantId, context.companyId, context.sourceId, release.applicationId]
      )).rows[0];
      if (application?.source_document_id !== command.paymentId || application.application_type !== "customer_payment_to_invoice" || application.status !== "applied") {
        throw new ErpFinancialsError("scope_mismatch", "Release must identify an active invoice application of this receipt");
      }
      if (application.target_document_source_id != null && application.target_document_source_id !== context.sourceId)
        throw new ErpFinancialsError("unsupported_operation", "Independently unapply the cross-source settlement before returning its receipt cash");
      if (command.date < storedDate(application.application_date, "application_date")) throw new ErpFinancialsValidationError("Return cannot precede its application");
      const applied = parsePositiveMoney(storedMoney(application.applied_amount, "applied_amount"), "applied_amount");
      const released = parsePositiveMoney(release.amount, "release.amount");
      if (released > applied) throw new ErpFinancialsValidationError("Release exceeds original application amount");

      if (storedInteger(application.version, "version") !== release.expectedVersion) {
        throw new ErpFinancialsError("optimistic_concurrency_conflict", "Invoice application changed before cash return", { retryable: true });
      }
      // Validate the same cash-basis projection used when ending this allocation,
      // before an external provider can be asked to return money.
      const targetTransactionId = await loadSubledgerDocumentTransactionId(client, context,
        storedString(application.target_document_id, "target_document_id"));
      const projection = { applicationId: release.applicationId, applicationType: "customer_payment_to_invoice" as const,
        effectiveDate: command.date, targetTransactionId };
      await prepareCashBasisApplicationProjection(client, context, { ...projection, action: "reverse",
        appliedAmount: formatMoney(applied) });
      if (applied > released) await prepareCashBasisApplicationProjection(client, context, { ...projection,
        action: "recognize", appliedAmount: formatMoney(applied - released), sourceDocument: receipt, previewReleasedApplicationId: release.applicationId });
      applications.set(release.applicationId, application);
    }
    return { receipt, amount, originalAmount, returned, available, requestedRelease, receivable, cash, applications };
}

async function previewCustomerPaymentCashReturn(context: ServiceContext, input: PreviewCustomerPaymentCashReturnInput): Promise<PreviewCustomerPaymentCashReturnResult> {
  // Normalize before awaiting, so the caller cannot mutate a pending plan.
  const command = normalizeCustomerPaymentCashReturn(input);
  return context.database.transaction(async client => {
    await lockCustomerPaymentCorrectionSource(client, context.tenantId, context.sourceId);
    await assertCompanySourceScope(client, context);
    const plan = await prepareCustomerPaymentCashReturn(client, context, command);
    return { paymentId: command.paymentId, paymentVersion: storedInteger(plan.receipt.version, "version"),
      amount: command.amount, unappliedAmount: formatMoney(plan.available), releasedAmount: formatMoney(plan.requestedRelease),
      remainingReturnableAmount: formatMoney(plan.originalAmount - plan.returned - plan.amount), releases: command.releases };
  });
}

/** Return recorded cash without cancelling the underlying sale. */
async function returnCustomerPaymentCash(context: ServiceContext, input: ReturnCustomerPaymentCashInput): Promise<ReturnCustomerPaymentCashResult> {
  assertFinancialApproval(context, input.operation);
  assertNonEmpty(input.idempotencyKey, "idempotencyKey");
  assertNonEmpty(input.externalReturnRef, "externalReturnRef");
  const command = { ...normalizeCustomerPaymentCashReturn(input), idempotencyKey: input.idempotencyKey,
    externalReturnRef: input.externalReturnRef, ...(input.memo === undefined ? {} : { memo: input.memo }),
    operation: copyFinancialOperation(input.operation) };
  const { operation, ...business } = command;
  const checksum = createHash("sha256").update(stableJson(JSON.parse(JSON.stringify({ ...business,
    actorRef: operation.actorRef, approverRef: operation.approverRef, occurredAt: operation.occurredAt,
    reasonCode: operation.reasonCode, reasonDetail: operation.reasonDetail
  })) as JsonValue)).digest("hex");
  const eventKey = `customer-payment-return:${command.idempotencyKey}:completed`;
  return context.database.transaction(async (client) => {
    await lockCustomerPaymentCorrectionSource(client, context.tenantId, context.sourceId);
    await acquireTransactionLock(client, `customer-payment-return:${context.tenantId}:${context.companyId}:${context.sourceId}:${command.idempotencyKey}`);
    await assertCompanySourceScope(client, context);
    const replay = (await client.query(
      `select "event_id", "aggregate_id", "payload" from "erp_financials"."financial_lifecycle_events"
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3 and "idempotency_key" = $4`,
      [context.tenantId, context.companyId, context.sourceId, eventKey]
    )).rows[0];
    if (replay !== undefined) {
      const payload = storedJson(replay.payload) as { commandChecksum?: string; result?: Omit<ReturnCustomerPaymentCashResult, "lifecycleEventId"> } | null;
      if (replay.aggregate_id !== command.paymentId || payload?.commandChecksum !== checksum || !payload.result) {
        throw new ErpFinancialsIdempotencyConflictError(command.idempotencyKey);
      }
      return { ...payload.result, status: "already_returned", lifecycleEventId: storedString(replay.event_id, "event_id") };
    }
    const { amount, originalAmount, returned, requestedRelease, receivable, cash, applications } =
      await prepareCustomerPaymentCashReturn(client, context, command);
    const nested = nestedServiceContext(context, client);
    for (const release of command.releases) {
      const application = applications.get(release.applicationId);
      if (!application) throw new Error("Validated cash-return application is missing");
      const applied = parsePositiveMoney(storedMoney(application.applied_amount, "applied_amount"), "applied_amount");
      const released = parsePositiveMoney(release.amount, "release.amount");
      await endSubledgerApplication(nested, { operation, applicationId: release.applicationId,
        expectedVersion: release.expectedVersion, effectiveDate: command.date }, "unapplied");
      if (applied > released) {
        const invoiceId = storedString(application.target_document_id, "target_document_id");
        const [source, target] = await loadSubledgerDocumentsForUpdate(client, context, [command.paymentId, invoiceId]);
        await applySubledgerPayment(nested, { operation, idempotencyKey: `${command.idempotencyKey}:residual:${release.applicationId}`,
          applicationType: "customer_payment_to_invoice", sourceDocumentId: command.paymentId, targetDocumentId: invoiceId,
          amount: formatMoney(applied - released), applicationDate: command.date,
          expectedSourceVersion: storedInteger(source.version, "version"), expectedTargetVersion: storedInteger(target.version, "version") });
      }
    }
    const refund = await createSubledgerDocument(nested, {
      ...commonSubledgerDocument(context, { ...command, idempotencyKey: `customer-payment-return:${command.externalReturnRef}` }, "refund", command.amount, true, {
        customerPaymentReturn: { paymentId: command.paymentId, commandChecksum: checksum, returnKind: command.returnKind, externalReturnRef: command.externalReturnRef }
      }),
      partyId: command.customerId,
      journalLines: [
        { accountId: resolveAccountId(context, receivable), debit: command.amount, partyId: command.customerId },
        { accountId: resolveAccountId(context, cash), credit: command.amount, partyId: command.customerId }
      ]
    });
    const [source, target] = await loadSubledgerDocumentsForUpdate(client, context, [command.paymentId, refund.documentId]);
    const settlement = await applySubledgerPayment(nested, { operation, idempotencyKey: `${command.idempotencyKey}:settlement`,
      applicationType: "customer_payment_to_refund", sourceDocumentId: command.paymentId, targetDocumentId: refund.documentId,
      amount: command.amount, applicationDate: command.date,
      expectedSourceVersion: storedInteger(source.version, "version"), expectedTargetVersion: storedInteger(target.version, "version") });
    const result: Omit<ReturnCustomerPaymentCashResult, "lifecycleEventId"> = {
      status: "returned", paymentId: command.paymentId, refundDocumentId: refund.documentId,
      refundTransactionId: refund.journal.transactionId, settlementApplicationId: settlement.applicationId,
      amount: command.amount, releasedAmount: formatMoney(requestedRelease),
      remainingReturnableAmount: formatMoney(originalAmount - returned - amount), paymentVersion: storedInteger(source.version, "version") + 1
    };
    const lifecycle = await appendFinancialLifecycleEvent(client, { tenantId: context.tenantId, companyId: context.companyId, sourceId: context.sourceId,
      aggregateType: "customer_payment", aggregateId: command.paymentId, eventType: "customer_payment.returned", idempotencyKey: eventKey,
      operation, recordedAt: context.now(), payload: { commandChecksum: checksum, result } });
    await appendServiceOutboxEvent(client, context, { aggregateType: "customer_payment", aggregateId: command.paymentId,
      eventType: "customer_payment.returned", idempotencyKey: `${eventKey}:outbox`, payload: { ...result, lifecycleEventId: lifecycle.eventId } });
    return { ...result, lifecycleEventId: lifecycle.eventId };
  });
}

async function issueCreditMemo(
  context: ServiceContext,
  input: IssueCreditMemoInput
): Promise<SubledgerDocumentResult> {
  const revenueLineInput: readonly SubledgerAmountLine[] | undefined = input.revenueLines;
  const legacyAmount: DecimalString | undefined = input.amount;
  const legacyRevenueAccount: ErpFinancialsAccountReference | undefined = input.revenueAccount;
  const revenueLines = revenueLineInput === undefined
    ? undefined
    : normalizeInvoiceLines(revenueLineInput);
  const amount = revenueLines === undefined && legacyAmount !== undefined
    ? normalizedPositiveMoney(legacyAmount, "amount")
    : revenueLines === undefined
      ? (() => { throw new ErpFinancialsValidationError("Credit memo requires amount or revenueLines"); })()
      : sumSubledgerLines(revenueLines, "revenueLines");
  const revenueJournalLines: readonly PostJournalEntryLineInput[] = revenueLines === undefined
    ? legacyRevenueAccount === undefined
      ? (() => { throw new ErpFinancialsValidationError("Credit memo amount requires revenueAccount"); })()
      : [{ ...legacyRevenueAccount, debit: amount, partyId: input.customerId }]
    : revenueLines.flatMap(line=>invoiceComponentJournalLines(line,input.customerId,true));
  return createSubledgerDocument(context, {
    ...commonSubledgerDocument(context, input, "credit_memo", amount, true),
    accountRequirements: revenueLines?.flatMap(line=>invoiceComponentRequirements(line,context.invoiceAccountPolicy,ref=>resolveAccountId(context,ref))) ?? [],
    validateNewPosting: ()=>{ for(const line of revenueLines ?? []) assertInvoiceComponentPolicy(line,undefined,resolveAccountId(context,input.receivableAccount),ref=>resolveAccountId(context,ref)); },
    partyId: input.customerId,
    journalLines: [
      ...revenueJournalLines,
      { ...input.receivableAccount, credit: amount, partyId: input.customerId }
    ],
    ...(revenueLines === undefined ? {} : { documentLines: revenueLines })
  });
}

async function issueRefund(context: ServiceContext, input: IssueRefundInput): Promise<SubledgerDocumentResult> {
  const amount = normalizedPositiveMoney(input.amount, "amount");
  const refundProvenance = optionalReferenceProvenance({
    relatedInvoiceId: input.relatedInvoiceId,
    refundMethod: input.refundMethod,
    lifecycleReference: input.lifecycleReference
  }, "refund");
  return createSubledgerDocument(context, {
    ...commonSubledgerDocument(
      context,
      input,
      "refund",
      amount,
      false,
      refundProvenance === undefined ? {} : { refundProvenance }
    ),
    partyId: input.customerId,
    journalLines: [
      { ...input.receivableAccount, debit: amount, partyId: input.customerId },
      { ...input.cashAccount, credit: amount, partyId: input.customerId }
    ]
  });
}

function normalizeVendorBillPaymentHold(context: ServiceContext, input: SetVendorBillPaymentHoldInput) {
  const command = structuredClone(input);
  assertFinancialOperationContext(command.operation);
  assertExpectedSubledgerVersion(command.expectedVersion, "expectedVersion");
  assertNonEmpty(command.vendorBillId, "vendorBillId");
  assertNonEmpty(command.idempotencyKey, "idempotencyKey");
  if (typeof command.paymentHold !== "boolean" || (command.reason !== undefined && typeof command.reason !== "string")) {
    throw new ErpFinancialsValidationError("Payment hold and reason are invalid");
  }
  const reason = command.reason?.trim() ?? null;
  if ((command.paymentHold && !reason) || (reason !== null && reason.length > 1000)) {
    throw new ErpFinancialsValidationError("A payment hold requires a reason of at most 1000 characters");
  }
  const operation = copyFinancialOperation(command.operation);
  const checksum = createHash("sha256").update(stableJson({ vendorBillId: command.vendorBillId,
    bookId: context.bookId ?? null, currencyCode: context.currencyCode, expectedVersion: command.expectedVersion, paymentHold: command.paymentHold, reason,
    actorRef: operation.actorRef, approverRef: operation.approverRef ?? null,
    reasonCode: operation.reasonCode, reasonDetail: operation.reasonDetail ?? null })).digest("hex");
  return { command, reason, operation, checksum };
}

async function lockNativeVendorBillForHold(client: PostgresQueryClient, context: ServiceContext, vendorBillId: string) {
  const bill = (await client.query(`select document.*, source.source_system from erp_financials.subledger_documents document
    join erp_financials.accounting_sources source using(tenant_id,source_id)
    where document.tenant_id=$1 and document.company_id=$2 and document.source_id=$3 and document.subledger_document_id=$4
    for update of document`, [context.tenantId, context.companyId, context.sourceId, vendorBillId])).rows[0];
  if (!bill || bill.document_type !== "vendor_bill") throw new ErpFinancialsError("missing_document", "Vendor bill does not exist in the write source");
  if (bill.source_system !== "native_erp") throw new ErpFinancialsError("provider_dependency", "Provider-owned bills require provider payment controls");
  if (bill.currency_code !== context.currencyCode) throw new ErpFinancialsError("scope_mismatch", "Vendor bill currency differs from the command scope");
  const provenance = await client.query(`select book_id from erp_financials.financial_outbox
    where tenant_id=$1 and company_id=$2 and source_id=$3 and aggregate_id=$4 and event_type='ledger.posted' for key share`,
    [context.tenantId, context.companyId, context.sourceId, bill.transaction_id]);
  if (provenance.rows.length !== 1 || storedOptionalString(provenance.rows[0]?.book_id) !== context.bookId) {
    throw new ErpFinancialsError("scope_mismatch", "Vendor bill posting book differs from the command scope");
  }
  return bill;
}

async function setVendorBillPaymentHold(context: ServiceContext, input: SetVendorBillPaymentHoldInput): Promise<VendorBillPaymentHoldResult> {
  const { command, reason, operation, checksum } = normalizeVendorBillPaymentHold(context, input);
  return context.database.transaction(async client => {
    await lockCustomerPaymentCorrectionSource(client, context.tenantId, context.sourceId);
    await acquireTransactionLock(client, `vendor-bill-hold:${context.tenantId}:${context.companyId}:${context.sourceId}:${command.idempotencyKey}`);
    await assertCompanySourceScope(client, context);
    const eventKey = `vendor-bill-hold:${command.idempotencyKey}`;
    const prior = (await client.query(`select payload,event_id,event_type,aggregate_id from erp_financials.financial_lifecycle_events
      where tenant_id=$1 and company_id=$2 and source_id=$3 and idempotency_key=$4`,
      [context.tenantId, context.companyId, context.sourceId, eventKey])).rows[0];
    if (prior) {
      const payload = storedJson(prior.payload) as { commandChecksum?: string; result?: Omit<VendorBillPaymentHoldResult, "status" | "lifecycleEventId"> };
      if (prior.event_type !== "subledger.vendor_bill.payment_hold_changed" || prior.aggregate_id !== command.vendorBillId || payload.commandChecksum !== checksum || !payload.result) throw new ErpFinancialsIdempotencyConflictError(command.idempotencyKey);
      return { ...payload.result, status: "already_changed", lifecycleEventId: storedString(prior.event_id, "event_id") };
    }
    const bill = await lockNativeVendorBillForHold(client, context, command.vendorBillId);
    const version = storedInteger(bill.version, "version");
    if (version !== command.expectedVersion) throw new ErpFinancialsError("optimistic_concurrency_conflict", "Vendor bill changed before payment hold", { retryable: true });
    if (!["open", "partially_applied"].includes(String(bill.status)) || parsePositiveOrZeroMoney(bill.open_amount, "open_amount") === 0n) {
      throw new ErpFinancialsError("terminal_state_conflict", "Only an outstanding bill can change its payment hold");
    }
    if (bill.payment_hold === command.paymentHold) throw new ErpFinancialsError("terminal_state_conflict", "Vendor bill already has this payment hold state");
    const result = { vendorBillId: command.vendorBillId, version: version + 1, paymentHold: command.paymentHold,
      paymentHoldReason: command.paymentHold ? reason : null };
    const event = await appendFinancialLifecycleEvent(client, { tenantId: context.tenantId, companyId: context.companyId, sourceId: context.sourceId,
      aggregateType: "subledger_document", aggregateId: command.vendorBillId, eventType: "subledger.vendor_bill.payment_hold_changed",
      idempotencyKey: eventKey, operation, recordedAt: context.now(), payload: { commandChecksum: checksum, expectedVersion: version,
        previousHold: bill.payment_hold === true, reason, result } });
    await client.query(`update erp_financials.subledger_documents set payment_hold=$5,payment_hold_reason=$6,version=version+1,updated_at=$7
      where tenant_id=$1 and company_id=$2 and source_id=$3 and subledger_document_id=$4`,
      [context.tenantId, context.companyId, context.sourceId, command.vendorBillId, result.paymentHold, result.paymentHoldReason, context.now()]);
    await appendFinancialOutboxEvent(client, { tenantId: context.tenantId, companyId: context.companyId, sourceId: context.sourceId, ...(context.bookId === undefined ? {} : { bookId: context.bookId }),
      eventType: "subledger.vendor_bill.payment_hold_changed", aggregateType: "subledger_document", aggregateId: command.vendorBillId,
      idempotencyKey: eventKey, availableAt: context.now(), payload: { lifecycleEventId: event.eventId, ...result } });
    return { ...result, status: "changed", lifecycleEventId: event.eventId };
  });
}

async function retireVendorBillPaymentHoldAttempt(context: ServiceContext, input: RetireVendorBillPaymentHoldInput): Promise<RetireVendorBillPaymentHoldResult> {
  input = structuredClone(input);
  const { command, checksum } = normalizeVendorBillPaymentHold(context, input.command);
  assertFinancialOperationContext(input.operation);
  const operation = copyFinancialOperation(input.operation);
  if (operation.actorRef !== command.operation.actorRef) throw new ErpFinancialsError("authorization_context_invalid", "Only the original actor may retire a payment hold attempt");
  const retirementChecksum = createHash("sha256").update(stableJson({ actorRef: operation.actorRef, approverRef: operation.approverRef ?? null,
    reasonCode: operation.reasonCode, reasonDetail: operation.reasonDetail ?? null })).digest("hex");
  return context.database.transaction(client => withBillPaymentSavepoint(client, async () => {
    await lockCustomerPaymentCorrectionSource(client, context.tenantId, context.sourceId);
    await acquireTransactionLock(client, `vendor-bill-hold:${context.tenantId}:${context.companyId}:${context.sourceId}:${command.idempotencyKey}`);
    await assertCompanySourceScope(client, context);
    // Use the original event key. Even earlier setPaymentHold implementations
    // reject a retirement (no result), so delayed writers cannot bypass it.
    const eventKey = `vendor-bill-hold:${command.idempotencyKey}`;
    const prior = (await client.query(`select aggregate_type,aggregate_id,event_type,event_id,payload from erp_financials.financial_lifecycle_events
      where tenant_id=$1 and company_id=$2 and source_id=$3 and idempotency_key=$4`,
      [context.tenantId, context.companyId, context.sourceId, eventKey])).rows[0];
    if (prior) {
      const payload = storedJson(prior.payload) as { commandChecksum?: string; retirementChecksum?: string; result?: Omit<VendorBillPaymentHoldResult, "status" | "lifecycleEventId"> };
      if (prior.aggregate_type !== "subledger_document" || prior.aggregate_id !== command.vendorBillId || payload.commandChecksum !== checksum) throw new ErpFinancialsIdempotencyConflictError(command.idempotencyKey);
      if (prior.event_type === "subledger.vendor_bill.payment_hold_retired") {
        if (payload.retirementChecksum !== retirementChecksum || payload.result) throw new ErpFinancialsIdempotencyConflictError(command.idempotencyKey);
        return { status: "already_retired", vendorBillId: command.vendorBillId, idempotencyKey: command.idempotencyKey, lifecycleEventId: storedString(prior.event_id, "event_id") };
      }
      if (prior.event_type !== "subledger.vendor_bill.payment_hold_changed" || !payload.result) throw new ErpFinancialsIdempotencyConflictError(command.idempotencyKey);
      const bill = await lockNativeVendorBillForHold(client, context, command.vendorBillId);
      return { status: "already_recorded", vendorBillId: command.vendorBillId, idempotencyKey: command.idempotencyKey,
        receipt: { ...payload.result, status: "already_changed", lifecycleEventId: storedString(prior.event_id, "event_id") },
        current: { version: storedInteger(bill.version, "version"), paymentHold: bill.payment_hold === true, paymentHoldReason: storedOptionalString(bill.payment_hold_reason) ?? null } };
    }
    // Immutable provenance is required. A later hold, settlement, correction or
    // fiscal close is not grounds to leave the uncertain command executable.
    await lockNativeVendorBillForHold(client, context, command.vendorBillId);
    const event = await appendFinancialLifecycleEvent(client, { ...context, operation, aggregateType: "subledger_document", aggregateId: command.vendorBillId,
      eventType: "subledger.vendor_bill.payment_hold_retired", idempotencyKey: eventKey, recordedAt: context.now(),
      payload: { commandChecksum: checksum, retirementChecksum } });
    return { status: "retired", vendorBillId: command.vendorBillId, idempotencyKey: command.idempotencyKey, lifecycleEventId: event.eventId };
  }));
}


async function createVendorBill(
  context: ServiceContext,
  input: CreateVendorBillInput
): Promise<SubledgerDocumentResult> {
  input = structuredClone(input);
  const expenseLines = normalizeVendorBillLines(input.expenseLines);
  const amount = normalizedPositiveMoney(formatMoney(expenseLines.reduce((sum, line) =>
    sum + (line.amount.startsWith("-") ? -parsePositiveMoney(line.amount.slice(1), "expenseLines.amount")
      : parsePositiveMoney(line.amount, "expenseLines.amount")), 0n)), "net bill total");
  const signed = expenseLines.some(line => line.amount.startsWith("-"));
  const payableAccountId = resolveAccountId(context, input.payableAccount);
  if (signed && expenseLines.some(line => resolveAccountId(context, line) === payableAccountId)) {
    throw new ErpFinancialsValidationError("Signed bill expense accounts must differ from its payable control");
  }
  const policyValue: unknown = input.accountPolicy;
  if (policyValue !== undefined && (policyValue === null || typeof policyValue !== "object")) {
    throw new ErpFinancialsValidationError("Vendor bill account policy must be an object");
  }
  const policy = policyValue as { readonly expenseClassifications?: unknown; readonly payableClassifications?: unknown } | undefined;
  const normalizeClasses = (values: unknown): AccountClassification[] => {
    if (!Array.isArray(values) || !values.length) {
      throw new ErpFinancialsValidationError("Vendor bill account policy requires nonempty supported classifications");
    }
    const entries: readonly unknown[] = values;
    if (entries.some(value => typeof value !== "string" || !ACCOUNT_CLASSIFICATIONS.has(value))) {
      throw new ErpFinancialsValidationError("Vendor bill account policy requires nonempty supported classifications");
    }
    return [...new Set(entries as readonly AccountClassification[])].sort();
  };
  const normalizedPolicy = policy === undefined ? undefined : {
    expenseClassifications: normalizeClasses(policy.expenseClassifications),
    payableClassifications: normalizeClasses(policy.payableClassifications)
  };
  return createSubledgerDocument(context, {
    ...commonSubledgerDocument(context, input, "vendor_bill", amount, true,
      { ...(normalizedPolicy === undefined ? {} : { accountPolicy: normalizedPolicy }),
        ...(signed ? { vendorBillCredit: { amount, payableAccountId } } : {}) }),
    ...(normalizedPolicy === undefined ? {} : { accountRequirements: [
      ...expenseLines.map(line => ({ accountId: resolveAccountId(context, line), classifications: normalizedPolicy.expenseClassifications })),
      { accountId: resolveAccountId(context, input.payableAccount), classifications: normalizedPolicy.payableClassifications }
    ] }),
    dueDate: input.dueDate,
    partyId: input.vendorId,
    journalLines: [
      ...expenseLines.map((line) => ({
        ...accountReferenceOnly(line),
        ...(line.amount.startsWith("-") ? { credit: line.amount.slice(1) } : { debit: line.amount }),
        partyId: input.vendorId,
        ...(line.itemId === undefined ? {} : { itemId: line.itemId }),
        ...(line.description === undefined ? {} : { description: line.description }),
        dimensionRefs: line.dimensionRefs
      })),
      { ...input.payableAccount, credit: amount, partyId: input.vendorId }
    ],
    // Attach attribution after commercial normalization, including signed bill-line normalization.
    documentLines: expenseLines.map((line, index) => {
      const customerId = input.expenseLines[index]?.customerId;
      if (customerId !== undefined && typeof customerId !== "string") {
        throw new ErpFinancialsValidationError(`expenseLines[${String(index)}].customerId must be a string`);
      }
      optionalNonEmpty(customerId, `expenseLines[${String(index)}].customerId`);
      return { ...line, ...(customerId === undefined ? {} : { customerId }) };
    })
  });
}

async function recordBillPayment(
  context: ServiceContext,
  input: RecordBillPaymentInput
): Promise<SubledgerDocumentResult> {
  input = structuredClone(input);
  const write = billPaymentDocumentWrite(context, input);
  return context.database.transaction(client => withBillPaymentSavepoint(client, async () => {
    await lockCustomerPaymentCorrectionSource(client, context.tenantId, context.sourceId);
    await acquireTransactionLock(client, billPaymentInstructionLock(context, input.idempotencyKey));
    await assertBillPaymentRecordingNotRetired(client, context, input.idempotencyKey);
    return createSubledgerDocument(nestedServiceContext(context, client), write);
  }));
}

function billPaymentDocumentWrite(context: ServiceContext, input: RecordBillPaymentInput): SubledgerDocumentWrite {
  const amount = normalizedPositiveMoney(input.amount, "amount");
  const fundingAccountId = resolveAccountId(context, input.cashAccount);
  const payableAccountId = resolveAccountId(context, input.payableAccount);
  if (input.paymentMethod !== undefined) assertBillPaymentMethod(input.paymentMethod);
  optionalNonEmpty(input.reference, "reference");
  return {
    ...commonSubledgerDocument(context, input, "bill_payment", amount, true, {
      billPaymentProvenance: {
        fundingAccountId,
        payableAccountId,
        ...(input.paymentMethod === undefined ? {} : { paymentMethod: input.paymentMethod }),
        ...(input.reference === undefined ? {} : { reference: input.reference })
      }
    }),
    partyId: input.vendorId,
    journalLines: [
      { ...input.payableAccount, debit: amount, partyId: input.vendorId },
      { ...input.cashAccount, credit: amount, partyId: input.vendorId }
    ]
  };
}

type NormalizedBillPaymentInstruction = {
  readonly billPaymentId: string;
  readonly idempotencyKey: string;
  readonly date: IsoDate;
  readonly documentNumber?: string;
  readonly memo?: string;
  readonly vendorId: string;
  readonly currencyCode: IsoCurrencyCode;
  readonly amount: DecimalString;
  readonly paymentMethod: BillPaymentMethod;
  readonly reference?: string;
  readonly fundingAccountId: AccountId;
  readonly payableAccountId: AccountId;
  readonly allocations: readonly BillPaymentAllocationInput[];
  readonly payloadChecksum: string;
};

/** Preserve SDK atomicity even when a host catches a command error inside its
 * own transaction. Nested payment steps use PostgreSQL savepoint shadowing;
 * earlier host work survives, while partial accounting and audit writes do not. */
async function withBillPaymentSavepoint<Result>(client: PostgresQueryClient, work: () => Promise<Result>): Promise<Result> {
  await client.query("savepoint erp_bill_payment_command");
  try {
    const result = await work();
    await client.query("release savepoint erp_bill_payment_command");
    return result;
  } catch (error) {
    await client.query("rollback to savepoint erp_bill_payment_command");
    await client.query("release savepoint erp_bill_payment_command");
    throw error;
  }
}

async function scheduleBillPayment(
  context: ServiceContext,
  input: ScheduleBillPaymentInput
): Promise<ScheduledBillPaymentResult> {
  input = structuredClone(input);
  const instruction = normalizeBillPaymentInstruction(context, input);
  return context.database.transaction(client => withBillPaymentSavepoint(client, async () => {
    await lockCustomerPaymentCorrectionSource(client, context.tenantId, context.sourceId);
    await acquireTransactionLock(client, billPaymentInstructionLock(context, instruction.idempotencyKey));
    await assertCompanySourceScope(client, context);
    const row = await createOrLoadBillPaymentInstruction(client, context, instruction, input.operation);
    return {
      status: row.created ? "scheduled" : "already_scheduled",
      billPaymentId: instruction.billPaymentId,
      version: storedInteger(row.value.version, "bill payment version"),
      lifecycleEventId: storedString(row.value.scheduled_event_id, "scheduled_event_id")
    };
  }));
}

async function recordAndApplyBillPayment(
  context: ServiceContext,
  input: RecordAndApplyBillPaymentInput
): Promise<ClearedBillPaymentResult> {
  input = structuredClone(input);
  const instruction = normalizeBillPaymentInstruction(context, input);
  return context.database.transaction(client => withBillPaymentSavepoint(client, async () => {
    await lockCustomerPaymentCorrectionSource(client, context.tenantId, context.sourceId);
    await acquireTransactionLock(client, billPaymentInstructionLock(context, instruction.idempotencyKey));
    await assertCompanySourceScope(client, context);
    const scheduled = await createOrLoadBillPaymentInstruction(client, context, instruction, input.operation);
    const currentStatus = storedString(scheduled.value.status, "bill payment status");
    if (currentStatus === "voided") {
      throw new ErpFinancialsError("terminal_state_conflict", `Bill payment ${instruction.billPaymentId} is voided`);
    }
    const nestedContext = nestedServiceContext(context, client);
    if (currentStatus === "cleared") {
      const originalOperation = await billPaymentReplayOperation(
        client,
        context,
        scheduled.value.cleared_event_id,
        `bill-payment:${input.idempotencyKey}:cleared`,
        input.operation
      );
      return materializeClearedBillPayment(
        nestedContext,
        instruction,
        originalOperation,
        "already_cleared",
        storedInteger(scheduled.value.version, "bill payment version"),
        storedString(scheduled.value.cleared_event_id, "cleared_event_id")
      );
    }
    return clearBillPaymentInstruction(
      client,
      context,
      nestedContext,
      instruction,
      input.operation,
      storedInteger(scheduled.value.version, "bill payment version"),
      input.idempotencyKey
    );
  }));
}

function billPaymentRecordingRetirementKey(idempotencyKey: string): string {
  return `bill-payment:${idempotencyKey}:recording-retired`;
}

async function assertBillPaymentRecordingNotRetired(client: PostgresQueryClient, context: ServiceContext, key: string): Promise<void> {
  const result = await client.query(`select 1 from erp_financials.financial_lifecycle_events
    where tenant_id=$1 and company_id=$2 and source_id=$3 and idempotency_key=$4`,
  [context.tenantId, context.companyId, context.sourceId, billPaymentRecordingRetirementKey(key)]);
  if (result.rows.length) throw new ErpFinancialsIdempotencyConflictError(key);
}

async function retireBillPaymentRecordingAttempt(context: ServiceContext, input: RetireBillPaymentRecordingInput): Promise<RetireBillPaymentRecordingResult> {
  input = structuredClone(input);
  const { command, operation } = input, instruction = normalizeBillPaymentInstruction(context, command);
  assertFinancialOperationContext(operation);
  if (command.operation.actorRef !== operation.actorRef) throw new ErpFinancialsError("authorization_context_invalid", "Only the original payment actor may retire its recording attempt");
  const audit = (value: FinancialOperationContext) => ({ actorRef: value.actorRef, approverRef: value.approverRef ?? null,
    reasonCode: value.reasonCode, reasonDetail: value.reasonDetail ?? null });
  const checksum = createHash("sha256").update(stableJson({ instructionChecksum: instruction.payloadChecksum, bookId: context.bookId ?? null, ...audit(command.operation) })).digest("hex");
  const retirementChecksum = createHash("sha256").update(stableJson(audit(operation))).digest("hex");
  const key = billPaymentRecordingRetirementKey(command.idempotencyKey);
  return context.database.transaction(client => withBillPaymentSavepoint(client, async () => {
    await lockCustomerPaymentCorrectionSource(client, context.tenantId, context.sourceId);
    await acquireTransactionLock(client, billPaymentInstructionLock(context, instruction.idempotencyKey));
    await assertCompanySourceScope(client, context);
    const retired = (await client.query(`select aggregate_type,aggregate_id,event_type,event_id,payload from erp_financials.financial_lifecycle_events
      where tenant_id=$1 and company_id=$2 and source_id=$3 and idempotency_key=$4`,
    [context.tenantId, context.companyId, context.sourceId, key])).rows[0];
    if (retired) {
      const payload = storedJson(retired.payload) as { commandChecksum?: string; retirementChecksum?: string } | null;
      if (retired.aggregate_type !== "bill_payment" || retired.aggregate_id !== instruction.billPaymentId
        || retired.event_type !== "bill_payment.recording_retired" || payload?.commandChecksum !== checksum || payload.retirementChecksum !== retirementChecksum) {
        throw new ErpFinancialsIdempotencyConflictError(command.idempotencyKey);
      }
      return { status: "already_retired", billPaymentId: instruction.billPaymentId, idempotencyKey: command.idempotencyKey, lifecycleEventId: storedString(retired.event_id, "event_id") };
    }
    const existing = await loadBillPaymentInstructionByIdempotencyKey(client, context, instruction.idempotencyKey);
    if (existing) {
      if (existing.bill_payment_id !== instruction.billPaymentId || existing.payload_checksum !== instruction.payloadChecksum) throw new ErpFinancialsIdempotencyConflictError(command.idempotencyKey);
      await billPaymentReplayOperation(client, context, existing.scheduled_event_id, `bill-payment:${command.idempotencyKey}:scheduled`, command.operation);
      const status = storedString(existing.status, "bill payment status");
      // A separate schedule/clear uses its own command identity. It must be
      // resolved by that lifecycle, never silently cancelled by this API.
      if ((status !== "cleared" && status !== "voided") || !existing.cleared_event_id) throw new ErpFinancialsError("unsupported_operation", "Resolve the scheduled payment through its scheduling lifecycle");
      const originalOperation = await billPaymentReplayOperation(client, context, existing.cleared_event_id,
        `bill-payment:${command.idempotencyKey}:cleared`, command.operation);
      const receipt = await materializeClearedBillPayment(nestedServiceContext(context, client), instruction, originalOperation,
        "already_cleared", storedInteger(existing.version, "version"), storedString(existing.cleared_event_id, "cleared_event_id"));
      const currentPayment = await loadPostedBillPaymentForVoid(client, context, instruction.billPaymentId);
      if (status === "voided" && currentPayment.status !== "voided") throw new ErpFinancialsError("terminal_state_conflict", "Voided instruction disagrees with the payment document");
      // Return the historical identity and current payment state separately.
      // Older direct voids may retain a cleared instruction: never repair history
      // during recovery, and never describe voided money as a new clear.
      return { status: "already_recorded", billPaymentId: instruction.billPaymentId, idempotencyKey: command.idempotencyKey,
        lifecycleEventId: receipt.lifecycleEventId, paymentStatus: currentPayment.status === "voided" ? "voided" : "cleared", paymentTransactionId: receipt.payment.journal.transactionId,
        amount: instruction.amount, currencyCode: instruction.currencyCode, applicationIds: receipt.applications.map(application => application.applicationId) };
    }
    if ((await client.query(`select 1 from erp_financials.subledger_documents where tenant_id=$1 and company_id=$2 and source_id=$3 and idempotency_key=$4`,
      [context.tenantId, context.companyId, context.sourceId, command.idempotencyKey])).rows.length) throw new ErpFinancialsIdempotencyConflictError(command.idempotencyKey);
    // Original native bill provenance is sufficient for retirement. Current
    // open amount, hold, revision and fiscal period must not prevent resolution.
    const bills = (await client.query(`select d.subledger_document_id,d.party_id,d.currency_code,o.book_id
      from erp_financials.subledger_documents d join erp_financials.financial_outbox o
        on o.tenant_id=d.tenant_id and o.company_id=d.company_id and o.source_id=d.source_id
        and o.aggregate_id=d.transaction_id and o.event_type='ledger.posted'
      where d.tenant_id=$1 and d.company_id=$2 and d.source_id=$3 and d.subledger_document_id=any($4::text[])
        and d.document_type='vendor_bill' for key share of d,o`,
    [context.tenantId, context.companyId, context.sourceId, instruction.allocations.map(allocation => allocation.billId)])).rows;
    if (bills.length !== instruction.allocations.length || new Set(bills.map(bill => bill.subledger_document_id)).size !== bills.length
      || bills.some(bill => bill.party_id !== instruction.vendorId || bill.currency_code !== instruction.currencyCode || storedOptionalString(bill.book_id) !== context.bookId)) {
      throw new ErpFinancialsError("scope_mismatch", "Payment retirement requires original native bills for this vendor, currency, book and source");
    }
    const lifecycle = await appendFinancialLifecycleEvent(client, { ...context, operation, aggregateType: "bill_payment", aggregateId: instruction.billPaymentId,
      eventType: "bill_payment.recording_retired", idempotencyKey: key, recordedAt: context.now(),
      payload: { commandChecksum: checksum, retirementChecksum } });
    return { status: "retired", billPaymentId: instruction.billPaymentId, idempotencyKey: command.idempotencyKey, lifecycleEventId: lifecycle.eventId };
  }));
}

async function clearScheduledBillPayment(
  context: ServiceContext,
  input: ClearScheduledBillPaymentInput
): Promise<ClearedBillPaymentResult> {
  input = structuredClone(input);
  assertFinancialOperationContext(input.operation);
  assertNonEmpty(input.billPaymentId, "billPaymentId");
  assertNonEmpty(input.idempotencyKey, "idempotencyKey");
  assertExpectedSubledgerVersion(input.expectedVersion, "expectedVersion");
  return context.database.transaction(client => withBillPaymentSavepoint(client, async () => {
    await lockCustomerPaymentCorrectionSource(client, context.tenantId, context.sourceId);
    await acquireTransactionLock(client, billPaymentLifecycleLock(context, input.billPaymentId));
    await assertCompanySourceScope(client, context);
    const row = await loadBillPaymentInstructionForUpdate(client, context, input.billPaymentId);
    const instruction = billPaymentInstructionFromRow(row);
    const status = storedString(row.status, "bill payment status");
    const nestedContext = nestedServiceContext(context, client);
    if (status === "cleared") {
      const currentVersion = storedInteger(row.version, "bill payment version");
      if (currentVersion !== input.expectedVersion + 1) {
        throw optimisticBillPaymentConflict(input.billPaymentId, input.expectedVersion, currentVersion - 1);
      }
      const originalOperation = await billPaymentReplayOperation(
        client,
        context,
        row.cleared_event_id,
        `bill-payment:${input.idempotencyKey}:cleared`,
        input.operation
      );
      return materializeClearedBillPayment(
        nestedContext,
        instruction,
        originalOperation,
        "already_cleared",
        storedInteger(row.version, "bill payment version"),
        storedString(row.cleared_event_id, "cleared_event_id")
      );
    }
    if (status !== "scheduled") {
      throw new ErpFinancialsError("terminal_state_conflict", `Bill payment ${input.billPaymentId} is ${status}`);
    }
    const version = storedInteger(row.version, "bill payment version");
    if (version !== input.expectedVersion) {
      throw optimisticBillPaymentConflict(input.billPaymentId, input.expectedVersion, version);
    }
    return clearBillPaymentInstruction(
      client,
      context,
      nestedContext,
      instruction,
      input.operation,
      version,
      input.idempotencyKey
    );
  }));
}

async function cancelScheduledBillPayment(
  context: ServiceContext,
  input: CancelScheduledBillPaymentInput
): Promise<CancelledScheduledBillPaymentResult> {
  input = { ...structuredClone(input), operation: copyFinancialOperation(input.operation) };
  assertFinancialApproval(context, input.operation);
  assertNonEmpty(input.billPaymentId, "billPaymentId");
  assertNonEmpty(input.idempotencyKey, "idempotencyKey");
  assertExpectedSubledgerVersion(input.expectedVersion, "expectedVersion");
  return context.database.transaction(client => withBillPaymentSavepoint(client, async () => {
    await lockCustomerPaymentCorrectionSource(client, context.tenantId, context.sourceId);
    await acquireTransactionLock(client, billPaymentLifecycleLock(context, input.billPaymentId));
    await assertCompanySourceScope(client, context);
    const row = await loadBillPaymentInstructionForUpdate(client, context, input.billPaymentId);
    const status = storedString(row.status, "bill payment status");
    if (status === "voided") {
      const currentVersion = storedInteger(row.version, "bill payment version");
      if (currentVersion !== input.expectedVersion + 1) {
        throw optimisticBillPaymentConflict(input.billPaymentId, input.expectedVersion, currentVersion - 1);
      }
      await billPaymentReplayOperation(
        client,
        context,
        row.voided_event_id,
        `bill-payment:${input.idempotencyKey}:cancelled`,
        input.operation
      );
      return {
        status: "already_voided",
        billPaymentId: input.billPaymentId,
        version: currentVersion,
        lifecycleEventId: storedString(row.voided_event_id, "voided_event_id")
      };
    }
    if (status !== "scheduled") {
      throw new ErpFinancialsError("terminal_state_conflict", "Only a scheduled bill payment can be cancelled");
    }
    const version = storedInteger(row.version, "bill payment version");
    if (version !== input.expectedVersion) {
      throw optimisticBillPaymentConflict(input.billPaymentId, input.expectedVersion, version);
    }
    const lifecycle = await appendFinancialLifecycleEvent(client, {
      tenantId: context.tenantId,
      companyId: context.companyId,
      sourceId: context.sourceId,
      aggregateType: "bill_payment",
      aggregateId: input.billPaymentId,
      eventType: "bill_payment.cancelled",
      idempotencyKey: `bill-payment:${input.idempotencyKey}:cancelled`,
      operation: input.operation,
      recordedAt: context.now(),
      priorEventId: storedString(row.scheduled_event_id, "scheduled_event_id"),
      payload: { billPaymentId: input.billPaymentId, priorVersion: version }
    });
    const updated = await client.query(
      `update "erp_financials"."bill_payment_disbursements"
set "status" = 'voided', "version" = "version" + 1, "voided_event_id" = $5, "updated_at" = $6
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3 and "bill_payment_id" = $4
  and "status" = 'scheduled' and "version" = $7
returning "version"`,
      [context.tenantId, context.companyId, context.sourceId, input.billPaymentId, lifecycle.eventId, context.now(), version]
    );
    const updatedRow = updated.rows[0];
    if (updatedRow === undefined) throw optimisticBillPaymentConflict(input.billPaymentId, version, version + 1);
    await appendServiceOutboxEvent(client, context, {
      eventType: "bill_payment.cancelled",
      aggregateType: "bill_payment",
      aggregateId: input.billPaymentId,
      idempotencyKey: `bill-payment:${input.idempotencyKey}:outbox:cancelled`,
      payload: { billPaymentId: input.billPaymentId }
    });
    return {
      status: "voided",
      billPaymentId: input.billPaymentId,
      version: storedInteger(updatedRow.version, "bill payment version"),
      lifecycleEventId: lifecycle.eventId
    };
  }));
}

async function clearBillPaymentInstruction(
  client: PostgresQueryClient,
  context: ServiceContext,
  nestedContext: ServiceContext,
  instruction: NormalizedBillPaymentInstruction,
  operation: FinancialOperationContext,
  expectedVersion: number,
  lifecycleIdempotencyKey: string
): Promise<ClearedBillPaymentResult> {
  await assertBillPaymentBillsForInstruction(client, context, instruction);
  const materialized = await materializeClearedBillPayment(
    nestedContext,
    instruction,
    operation,
    "cleared",
    expectedVersion + 1,
    "pending"
  );
  const lifecycle = await appendFinancialLifecycleEvent(client, {
    tenantId: context.tenantId,
    companyId: context.companyId,
    sourceId: context.sourceId,
    aggregateType: "bill_payment",
    aggregateId: instruction.billPaymentId,
    eventType: "bill_payment.cleared",
    idempotencyKey: `bill-payment:${lifecycleIdempotencyKey}:cleared`,
    operation,
    recordedAt: context.now(),
    priorEventId: await scheduledLifecycleEventId(client, context, instruction.billPaymentId),
    payload: {
      allocations: instruction.allocations,
      amount: instruction.amount,
      billPaymentId: instruction.billPaymentId,
      transactionId: materialized.payment.journal.transactionId
    }
  });
  const updated = await client.query(
    `update "erp_financials"."bill_payment_disbursements"
set "status" = 'cleared', "version" = "version" + 1, "subledger_document_id" = $5,
  "cleared_event_id" = $6, "updated_at" = $7
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3 and "bill_payment_id" = $4
  and "status" = 'scheduled' and "version" = $8
returning "version"`,
    [
      context.tenantId,
      context.companyId,
      context.sourceId,
      instruction.billPaymentId,
      materialized.payment.documentId,
      lifecycle.eventId,
      context.now(),
      expectedVersion
    ]
  );
  const row = updated.rows[0];
  if (row === undefined) throw optimisticBillPaymentConflict(instruction.billPaymentId, expectedVersion, expectedVersion + 1);
  await appendServiceOutboxEvent(client, context, {
    eventType: "bill_payment.cleared",
    aggregateType: "bill_payment",
    aggregateId: instruction.billPaymentId,
    idempotencyKey: `bill-payment:${lifecycleIdempotencyKey}:outbox:cleared`,
    payload: {
      applicationIds: materialized.applications.map((application) => application.applicationId),
      billPaymentId: instruction.billPaymentId,
      transactionId: materialized.payment.journal.transactionId
    }
  });
  return {
    ...materialized,
    version: storedInteger(row.version, "bill payment version"),
    lifecycleEventId: lifecycle.eventId
  };
}

async function materializeClearedBillPayment(
  context: ServiceContext,
  instruction: NormalizedBillPaymentInstruction,
  operation: FinancialOperationContext,
  status: ClearedBillPaymentResult["status"],
  version: number,
  lifecycleEventId: string
): Promise<ClearedBillPaymentResult> {
  const input: RecordBillPaymentInput = {
    operation,
    idempotencyKey: instruction.idempotencyKey,
    date: instruction.date,
    ...(instruction.documentNumber === undefined ? {} : { documentNumber: instruction.documentNumber }),
    ...(instruction.memo === undefined ? {} : { memo: instruction.memo }),
    currencyCode: instruction.currencyCode,
    vendorId: instruction.vendorId,
    amount: instruction.amount,
    paymentMethod: instruction.paymentMethod,
    ...(instruction.reference === undefined ? {} : { reference: instruction.reference }),
    payableAccount: { accountId: instruction.payableAccountId },
    cashAccount: { accountId: instruction.fundingAccountId }
  };
  if (status === "already_cleared") {
    return replayClearedBillPayment(context, instruction, input, version, lifecycleEventId);
  }
  const payment = await recordBillPayment(context, input);
  const applications: SubledgerApplicationResult[] = [];
  for (const [index, allocation] of instruction.allocations.entries()) {
    applications.push(await applySubledgerPayment(context, {
      operation,
      idempotencyKey: billPaymentAllocationIdempotencyKey(instruction, allocation, index),
      applicationType: "bill_payment_to_bill",
      sourceDocumentId: instruction.billPaymentId,
      targetDocumentId: allocation.billId,
      amount: allocation.amount,
      applicationDate: instruction.date,
      expectedSourceVersion: index + 1,
      expectedTargetVersion: allocation.expectedBillVersion
    }));
  }
  const currentPayment = await context.database.transaction(async (client) => {
    const result = await client.query(
      `select *, "document_date"::text as "document_date", "due_date"::text as "due_date" from "erp_financials"."subledger_documents"
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3 and "subledger_document_id" = $4
for key share`,
      [context.tenantId, context.companyId, context.sourceId, instruction.billPaymentId]
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("Cleared bill payment document was not found");
    return documentResult(row, payment.journal);
  });
  return {
    status,
    billPaymentId: instruction.billPaymentId,
    version,
    payment: currentPayment,
    applications,
    lifecycleEventId
  };
}

function billPaymentReceiptPayload(value: unknown): Record<string, unknown> {
  const payload = storedJson(value);
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ErpFinancialsValidationError("Bill payment receipt payload is invalid");
  }
  const result: Record<string, unknown> = Object.fromEntries(Object.entries(payload));
  // Authorization audit is checked by the command policy/replay operation;
  // business evidence is identical under independent and administrator policies.
  delete result.financialApproval;
  return result;
}

/** A successful clear is an immutable receipt, even after applications are released.
 * Reconstruct it only from retained native evidence. Never call posting/application
 * commands here: missing evidence must fail closed, not recreate accounting facts.
 */
async function replayClearedBillPayment(
  context: ServiceContext, instruction: NormalizedBillPaymentInstruction,
  input: RecordBillPaymentInput, version: number, lifecycleEventId: string
): Promise<ClearedBillPaymentResult> {
  return context.database.transaction(async client => {
    const journalInput = subledgerJournalInput(billPaymentDocumentWrite(context, input));
    const journal = normalizeJournalEntry(context, journalInput);
    const identities = journalIdentities(context, journal);
    // Cash movement creates both bases atomically. Neither mirror may be
    // silently recreated by a historical completion lookup.
    for (const retained of [journal, normalizeJournalEntry(context, { ...journalInput,
      idempotencyKey: `${input.idempotencyKey}:accounting-basis:cash`, accountingBasis: "cash" })]) {
      const retainedIds = journalIdentities(context, retained);
      const existing = await loadExistingJournal(client, context, retained.idempotencyKey, retained.sourceTransactionType);
      if (!existing || existing.transactionId !== retainedIds.transactionId || existing.status !== "posted"
        || sourceRefChecksum(existing.sourcePayloadRef) !== retained.checksum) {
        throw new ErpFinancialsIdempotencyConflictError(instruction.idempotencyKey);
      }
      const provenance = (await client.query(`select book_id from erp_financials.financial_outbox
        where tenant_id=$1 and company_id=$2 and source_id=$3 and aggregate_id=$4
          and event_type='ledger.posted' and idempotency_key=$5`,
      [context.tenantId, context.companyId, context.sourceId, retainedIds.transactionId,
        `ledger-posted:${retained.sourceTransactionType}:${retained.idempotencyKey}`])).rows;
      if (provenance.length !== 1 || storedOptionalString(provenance[0]?.book_id) !== context.bookId) {
        throw new ErpFinancialsError("scope_mismatch", "Bill payment receipt requires native posting evidence in this book");
      }
    }
    const payment = (await client.query(`select *, document_date::text as document_date from erp_financials.subledger_documents
      where tenant_id=$1 and company_id=$2 and source_id=$3 and subledger_document_id=$4`,
    [context.tenantId, context.companyId, context.sourceId, instruction.billPaymentId])).rows[0];
    if (!payment || payment.document_type !== "bill_payment" || payment.transaction_id !== identities.transactionId
      || payment.party_id !== instruction.vendorId || payment.currency_code !== instruction.currencyCode
      || payment.idempotency_key !== instruction.idempotencyKey || storedDate(payment.document_date, "document_date") !== instruction.date
      || storedMoney(payment.original_amount, "original_amount") !== instruction.amount) {
      throw new ErpFinancialsIdempotencyConflictError(instruction.idempotencyKey);
    }
    const events = (await client.query(`select * from erp_financials.financial_lifecycle_events
      where tenant_id=$1 and company_id=$2 and source_id=$3 and event_id=any($4::text[])`,
    [context.tenantId, context.companyId, context.sourceId, [lifecycleEventId, payment.lifecycle_event_id]])).rows;
    const posted = events.find(event => event.event_id === payment.lifecycle_event_id);
    const cleared = events.find(event => event.event_id === lifecycleEventId);
    if (!posted || posted.aggregate_type !== "subledger_document" || posted.aggregate_id !== identities.transactionId
      || posted.event_type !== "subledger.bill_payment.posted" || posted.actor_ref !== input.operation.actorRef
      || (posted.approver_ref ?? null) !== (input.operation.approverRef ?? null)
      || posted.reason_code !== input.operation.reasonCode || (posted.reason_detail ?? null) !== (input.operation.reasonDetail ?? null)
      || !cleared || cleared.event_type !== "bill_payment.cleared" || cleared.aggregate_id !== instruction.billPaymentId
      || stableJson(billPaymentReceiptPayload(cleared.payload)) !== stableJson({ allocations: instruction.allocations, amount: instruction.amount,
        billPaymentId: instruction.billPaymentId, transactionId: identities.transactionId })) {
      throw new ErpFinancialsIdempotencyConflictError(instruction.idempotencyKey);
    }
    const applications: SubledgerApplicationResult[] = [];
    for (const [index, allocation] of instruction.allocations.entries()) {
      const key = billPaymentAllocationIdempotencyKey(instruction, allocation, index);
      const applicationId = scopedRecordId(context, "subledger_application", key);
      const row = await loadSubledgerApplicationByIdempotencyKey(client, context, key);
      if (!row || row.currency_code !== instruction.currencyCode) throw new ErpFinancialsIdempotencyConflictError(key);
      const appliedInput: ApplySubledgerPaymentInput = { operation: input.operation, idempotencyKey: key,
        applicationType: "bill_payment_to_bill", sourceDocumentId: instruction.billPaymentId, targetDocumentId: allocation.billId,
        amount: allocation.amount, applicationDate: instruction.date, expectedSourceVersion: index + 1, expectedTargetVersion: allocation.expectedBillVersion };
      assertSameSubledgerApplication(row, appliedInput, allocation.amount, applicationId);
      const event = (await client.query(`select aggregate_type,aggregate_id,event_type,actor_ref,approver_ref,reason_code,reason_detail,payload from erp_financials.financial_lifecycle_events
        where tenant_id=$1 and company_id=$2 and source_id=$3 and event_id=$4`,
      [context.tenantId, context.companyId, context.sourceId, row.applied_event_id])).rows[0];
      let evidence = event ? billPaymentReceiptPayload(event.payload) : {};
      if (evidence.commandVersion === 1 && event) {
        await assertSubledgerApplicationCommandReplay(client, context, row, appliedInput, applicationId,
          subledgerApplicationCommandChecksum(context, appliedInput, allocation.amount), event);
        const { commandVersion, commandChecksum, expectedSourceVersion, expectedTargetVersion, ...businessEvidence } = evidence;
        void commandVersion; void commandChecksum; void expectedSourceVersion; void expectedTargetVersion;
        evidence = businessEvidence;
      }
      // Earlier child events are still provable here: the immutable parent
      // instruction retained the ordered allocations and original bill versions.
      if (!event || event.aggregate_type !== "subledger_application" || event.aggregate_id !== applicationId
        || event.event_type !== "subledger_application.applied" || event.actor_ref !== input.operation.actorRef
        || (event.approver_ref ?? null) !== (input.operation.approverRef ?? null)
        || event.reason_code !== input.operation.reasonCode || (event.reason_detail ?? null) !== (input.operation.reasonDetail ?? null)
        || stableJson(evidence) !== stableJson({ applicationDate: instruction.date, applicationType: "bill_payment_to_bill",
          appliedAmount: allocation.amount, sourceDocumentId: instruction.billPaymentId, targetDocumentId: allocation.billId })) {
        throw new ErpFinancialsIdempotencyConflictError(key);
      }
      applications.push(applicationResult({ ...row, version: 1, ended_event_id: null }, "already_applied"));
    }
    // The instruction requires full allocation in a single transaction. These are
    // the original completion values; current balances belong to query APIs.
    return { status: "already_cleared", billPaymentId: instruction.billPaymentId, version, lifecycleEventId, applications,
      payment: documentResult({ ...payment, version: instruction.allocations.length + 1, open_amount: "0.00", status: "settled" },
        alreadyPostedResult(identities, storedString(posted.event_id, "event_id"))) };
  });
}

async function createOrLoadBillPaymentInstruction(
  client: PostgresQueryClient,
  context: ServiceContext,
  instruction: NormalizedBillPaymentInstruction,
  operation: FinancialOperationContext
): Promise<{ readonly created: boolean; readonly value: Record<string, unknown> }> {
  await assertBillPaymentRecordingNotRetired(client, context, instruction.idempotencyKey);
  const existing = await loadBillPaymentInstructionByIdempotencyKey(client, context, instruction.idempotencyKey);
  if (existing !== undefined) {
    if (
      storedString(existing.bill_payment_id, "bill_payment_id") !== instruction.billPaymentId ||
      storedString(existing.payload_checksum, "payload_checksum") !== instruction.payloadChecksum
    ) {
      throw new ErpFinancialsIdempotencyConflictError(instruction.idempotencyKey);
    }
    await billPaymentReplayOperation(client, context, existing.scheduled_event_id,
      `bill-payment:${instruction.idempotencyKey}:scheduled`, operation);
    return { created: false, value: existing };
  }
  await assertBillPaymentInstructionScope(client, context, instruction);
  const lifecycle = await appendFinancialLifecycleEvent(client, {
    tenantId: context.tenantId,
    companyId: context.companyId,
    sourceId: context.sourceId,
    aggregateType: "bill_payment",
    aggregateId: instruction.billPaymentId,
    eventType: "bill_payment.scheduled",
    idempotencyKey: `bill-payment:${instruction.idempotencyKey}:scheduled`,
    operation,
    recordedAt: context.now(),
    payload: billPaymentInstructionPayload(instruction)
  });
  const inserted = await client.query(
    `insert into "erp_financials"."bill_payment_disbursements" (
  "bill_payment_id", "tenant_id", "company_id", "source_id", "subledger_document_id", "vendor_id",
  "payment_date", "document_number", "memo", "currency_code", "amount", "payment_method", "payment_reference",
  "funding_account_id", "payable_account_id", "allocations", "status", "version", "idempotency_key",
  "payload_checksum", "scheduled_event_id", "cleared_event_id", "voided_event_id", "created_at", "updated_at"
) values ($1, $2, $3, $4, null, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
  'scheduled', 1, $16, $17, $18, null, null, $19, $19)
returning *`,
    [
      instruction.billPaymentId,
      context.tenantId,
      context.companyId,
      context.sourceId,
      instruction.vendorId,
      instruction.date,
      instruction.documentNumber,
      instruction.memo,
      instruction.currencyCode,
      instruction.amount,
      instruction.paymentMethod,
      instruction.reference,
      instruction.fundingAccountId,
      instruction.payableAccountId,
      JSON.stringify(instruction.allocations),
      instruction.idempotencyKey,
      instruction.payloadChecksum,
      lifecycle.eventId,
      context.now()
    ]
  );
  const row = inserted.rows[0];
  if (row === undefined) throw new Error("Bill payment instruction insert did not return its row");
  await appendServiceOutboxEvent(client, context, {
    eventType: "bill_payment.scheduled",
    aggregateType: "bill_payment",
    aggregateId: instruction.billPaymentId,
    idempotencyKey: `bill-payment:${instruction.idempotencyKey}:outbox:scheduled`,
    payload: { billPaymentId: instruction.billPaymentId, paymentDate: instruction.date }
  });
  return { created: true, value: row };
}

function normalizeBillPaymentInstruction(
  context: ServiceContext,
  input: RecordAndApplyBillPaymentInput
): NormalizedBillPaymentInstruction {
  assertFinancialOperationContext(input.operation);
  assertNonEmpty(input.idempotencyKey, "idempotencyKey");
  assertNonEmpty(input.vendorId, "vendorId");
  assertIsoDate(input.date, "date");
  assertBillPaymentMethod(input.paymentMethod);
  optionalNonEmpty(input.reference, "reference");
  optionalNonEmpty(input.documentNumber, "documentNumber");
  optionalNonEmpty(input.memo, "memo");
  const currencyCode = input.currencyCode ?? context.currencyCode;
  assertCurrencyAllowed(context, currencyCode);
  const amount = normalizedPositiveMoney(input.amount, "amount");
  if (input.allocations.length === 0) {
    throw new ErpFinancialsValidationError("allocations must contain at least one bill");
  }
  const seen = new Set<string>();
  let allocatedMinor = 0n;
  const allocations = input.allocations.map((allocation, index): BillPaymentAllocationInput => {
    assertNonEmpty(allocation.billId, `allocations[${String(index)}].billId`);
    if (seen.has(allocation.billId)) {
      throw new ErpFinancialsValidationError("allocations must contain each bill exactly once");
    }
    seen.add(allocation.billId);
    assertExpectedSubledgerVersion(allocation.expectedBillVersion, `allocations[${String(index)}].expectedBillVersion`);
    const normalizedAmount = normalizedPositiveMoney(allocation.amount, `allocations[${String(index)}].amount`);
    allocatedMinor += parsePositiveMoney(normalizedAmount, `allocations[${String(index)}].amount`);
    return { ...allocation, amount: normalizedAmount };
  });
  if (formatMoney(allocatedMinor) !== amount) {
    throw new ErpFinancialsValidationError("The ordered allocation total must equal the bill payment amount");
  }
  const instructionBase = {
    billPaymentId: scopedRecordId(context, "subledger_document", `bill_payment:${input.idempotencyKey}`),
    idempotencyKey: input.idempotencyKey,
    date: input.date,
    ...(input.documentNumber === undefined ? {} : { documentNumber: input.documentNumber }),
    ...(input.memo === undefined ? {} : { memo: input.memo }),
    vendorId: input.vendorId,
    currencyCode,
    amount,
    paymentMethod: input.paymentMethod,
    ...(input.reference === undefined ? {} : { reference: input.reference }),
    fundingAccountId: resolveAccountId(context, input.cashAccount),
    payableAccountId: resolveAccountId(context, input.payableAccount),
    allocations
  };
  if (instructionBase.fundingAccountId === instructionBase.payableAccountId) {
    throw new ErpFinancialsValidationError("Bill payment funding and payable accounts must differ");
  }
  const payload = billPaymentInstructionPayload(instructionBase);
  if (Buffer.byteLength(stableJson(payload), "utf8") > 4096) {
    throw new ErpFinancialsValidationError("Bill payment instruction exceeds 4096 bytes");
  }
  return {
    ...instructionBase,
    payloadChecksum: createHash("sha256").update(stableJson(payload)).digest("hex")
  };
}

function billPaymentInstructionPayload(
  instruction: Omit<NormalizedBillPaymentInstruction, "payloadChecksum">
): JsonValue {
  return {
    allocations: instruction.allocations,
    amount: instruction.amount,
    billPaymentId: instruction.billPaymentId,
    currencyCode: instruction.currencyCode,
    date: instruction.date,
    documentNumber: instruction.documentNumber ?? null,
    fundingAccountId: instruction.fundingAccountId,
    memo: instruction.memo ?? null,
    payableAccountId: instruction.payableAccountId,
    paymentMethod: instruction.paymentMethod,
    reference: instruction.reference ?? null,
    vendorId: instruction.vendorId
  };
}

function assertBillPaymentMethod(value: string): asserts value is BillPaymentMethod {
  if (!new Set<string>(["ach", "card", "check"]).has(value)) {
    throw new ErpFinancialsValidationError(`Unsupported bill payment method ${value}`);
  }
}

async function assertBillPaymentInstructionScope(
  client: PostgresQueryClient,
  context: ServiceContext,
  instruction: NormalizedBillPaymentInstruction
): Promise<void> {
  await assertSubledgerParty(client, context, instruction.vendorId, "bill_payment");
  const storage = createPostgresStorageAdapter(client);
  const accountIds = [instruction.fundingAccountId, instruction.payableAccountId];
  await assertPostingAccountEligibility(client, context, accountIds);
  const accounts = await storage.loadAccounts({ tenantId: context.tenantId, sourceId: context.sourceId, accountIds });
  assertJournalAccounts(accounts, accountIds);
  await assertBillPaymentBillsForInstruction(client, context, instruction);
}

async function assertBillPaymentBillsForInstruction(
  client: PostgresQueryClient,
  context: ServiceContext,
  instruction: NormalizedBillPaymentInstruction
): Promise<void> {
  const billIds = instruction.allocations.map((allocation) => allocation.billId);
  const result = await client.query(
    `select *, "document_date"::text as "document_date", "due_date"::text as "due_date" from "erp_financials"."subledger_documents"
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3
  and "subledger_document_id" = any($4::text[])
order by "subledger_document_id"
for update`,
    [context.tenantId, context.companyId, context.sourceId, [...billIds].sort()]
  );
  const postingEvidence = await client.query(`select aggregate_id,book_id,idempotency_key from erp_financials.financial_outbox
    where tenant_id=$1 and company_id=$2 and source_id=$3 and event_type='ledger.posted' and aggregate_id=any($4::text[]) for key share`,
  [context.tenantId, context.companyId, context.sourceId, result.rows.map(row => storedString(row.transaction_id, "transaction_id"))]);
  const postings = new Map<string, Record<string, unknown>[]>();
  for (const evidence of postingEvidence.rows) {
    const key = storedString(evidence.aggregate_id, "aggregate_id"), existing = postings.get(key) ?? [];
    existing.push(evidence); postings.set(key, existing);
  }
  const byId = new Map(result.rows.map((row) => [storedString(row.subledger_document_id, "bill id"), row]));
  for (const allocation of instruction.allocations) {
    const bill = byId.get(allocation.billId);
    if (bill === undefined) {
      throw new ErpFinancialsError(
        "missing_document",
        `Vendor bill ${allocation.billId} does not exist in the write source`,
        { details: { billId: allocation.billId } }
      );
    }
    if (bill.document_type !== "vendor_bill") {
      throw new ErpFinancialsValidationError(`Allocation target ${allocation.billId} is not a vendor bill`);
    }
    const provenance = (postings.get(storedString(bill.transaction_id, "transaction_id")) ?? []).filter(event =>
      event.idempotency_key === `ledger-posted:${subledgerTransactionType("vendor_bill")}:${storedString(bill.idempotency_key, "idempotency_key")}`);
    if (provenance.length !== 1 || storedOptionalString(provenance[0]?.book_id) !== context.bookId) {
      throw new ErpFinancialsError("scope_mismatch", "Bill payment allocations require native bill posting evidence in this book");
    }
    if (bill.payment_hold === true) throw new ErpFinancialsError("terminal_state_conflict", "Vendor bill is on payment hold");
    if (bill.party_id !== instruction.vendorId) {
      throw new ErpFinancialsValidationError("Every allocation must target the payment vendor", "scope_mismatch", {
        billId: allocation.billId,
        vendorId: instruction.vendorId
      });
    }
    if (bill.currency_code !== instruction.currencyCode) {
      throw new ErpFinancialsValidationError("Every allocation must use the payment currency", "currency_not_supported", {
        billId: allocation.billId,
        currencyCode: instruction.currencyCode
      });
    }
    const version = storedInteger(bill.version, "bill version");
    if (version !== allocation.expectedBillVersion) {
      throw new ErpFinancialsError(
        "optimistic_concurrency_conflict",
        `Vendor bill ${allocation.billId} expected version ${String(allocation.expectedBillVersion)}, found ${String(version)}`,
        {
          retryable: true,
          details: { actualVersion: version, billId: allocation.billId, expectedVersion: allocation.expectedBillVersion }
        }
      );
    }
    const status = storedString(bill.status, "bill status");
    const openMinor = parsePositiveOrZeroMoney(bill.open_amount, "bill open_amount");
    const allocationMinor = parsePositiveMoney(allocation.amount, "allocation amount");
    if (!["open", "partially_applied"].includes(status) || allocationMinor > openMinor) {
      throw new ErpFinancialsValidationError(
        `Vendor bill ${allocation.billId} is not eligible for the requested allocation`,
        "terminal_state_conflict",
        { billId: allocation.billId, status }
      );
    }
  }
}

function nestedServiceContext(context: ServiceContext, client: PostgresQueryClient): ServiceContext {
  return {
    ...context,
    database: { transaction: async <Result>(work: (nestedClient: PostgresQueryClient) => Promise<Result>) => work(client) }
  };
}

function billPaymentInstructionLock(context: ServiceContext, idempotencyKey: string): string {
  return `bill-payment-instruction:${context.tenantId}:${context.companyId}:${context.sourceId}:${idempotencyKey}`;
}

function billPaymentLifecycleLock(context: ServiceContext, billPaymentId: string): string {
  return `bill-payment-lifecycle:${context.tenantId}:${context.companyId}:${context.sourceId}:${billPaymentId}`;
}

function billPaymentAllocationIdempotencyKey(
  instruction: NormalizedBillPaymentInstruction,
  allocation: BillPaymentAllocationInput,
  index: number
): string {
  return `${instruction.idempotencyKey}:allocation:${String(index + 1)}:${allocation.billId}`;
}

// A source may participate in several books. Scheduling emits durable book
// provenance before there is a posted payment document; require it on every
// lifecycle path, including retries, instead of inferring ownership from caller scope.
async function assertBillPaymentInstructionBook(client: PostgresQueryClient, context: ServiceContext, row: Record<string, unknown>): Promise<void> {
  const evidence = await client.query(`select book_id from erp_financials.financial_outbox
    where tenant_id=$1 and company_id=$2 and source_id=$3 and aggregate_id=$4
      and event_type='bill_payment.scheduled' and idempotency_key=$5 for key share`,
  [context.tenantId, context.companyId, context.sourceId, storedString(row.bill_payment_id, "bill_payment_id"),
    `bill-payment:${storedString(row.idempotency_key, "idempotency_key")}:outbox:scheduled`]);
  if (evidence.rows.length !== 1 || storedOptionalString(evidence.rows[0]?.book_id) !== context.bookId) {
    throw new ErpFinancialsError("scope_mismatch", "Bill payment instruction book differs from the command scope");
  }
}

async function loadBillPaymentInstructionByIdempotencyKey(
  client: PostgresQueryClient,
  context: ServiceContext,
  idempotencyKey: string
): Promise<Record<string, unknown> | undefined> {
  const result = await client.query(
    `select *, "payment_date"::text as "payment_date" from "erp_financials"."bill_payment_disbursements"
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3 and "idempotency_key" = $4
for update`,
    [context.tenantId, context.companyId, context.sourceId, idempotencyKey]
  );
  const row = result.rows[0];
  if (row !== undefined) await assertBillPaymentInstructionBook(client, context, row);
  return row;
}

async function loadBillPaymentInstructionForUpdate(
  client: PostgresQueryClient,
  context: ServiceContext,
  billPaymentId: string
): Promise<Record<string, unknown>> {
  const result = await client.query(
    `select *, "payment_date"::text as "payment_date" from "erp_financials"."bill_payment_disbursements"
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3 and "bill_payment_id" = $4
for update`,
    [context.tenantId, context.companyId, context.sourceId, billPaymentId]
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new ErpFinancialsError("missing_document", `Bill payment ${billPaymentId} does not exist in the write source`);
  }
  await assertBillPaymentInstructionBook(client, context, row);
  return row;
}

function billPaymentInstructionFromRow(row: Record<string, unknown>): NormalizedBillPaymentInstruction {
  const allocationsJson = storedJson(row.allocations);
  if (!Array.isArray(allocationsJson)) throw new Error("Stored bill payment allocations must be an array");
  const allocations = allocationsJson.map((value, index): BillPaymentAllocationInput => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`Stored bill payment allocation ${String(index)} is invalid`);
    }
    const allocation = value as Readonly<Record<string, JsonValue>>;
    return {
      billId: storedString(allocation.billId, "allocation.billId"),
      amount: storedMoney(allocation.amount, "allocation.amount"),
      expectedBillVersion: storedInteger(allocation.expectedBillVersion, "allocation.expectedBillVersion")
    };
  });
  const paymentMethod = storedString(row.payment_method, "payment_method");
  assertBillPaymentMethod(paymentMethod);
  const documentNumber = storedOptionalString(row.document_number);
  const memo = storedOptionalString(row.memo);
  const reference = storedOptionalString(row.payment_reference);
  return {
    billPaymentId: storedString(row.bill_payment_id, "bill_payment_id"),
    idempotencyKey: storedString(row.idempotency_key, "idempotency_key"),
    date: storedDate(row.payment_date, "payment_date"),
    ...(documentNumber === undefined ? {} : { documentNumber }),
    ...(memo === undefined ? {} : { memo }),
    vendorId: storedString(row.vendor_id, "vendor_id"),
    currencyCode: storedString(row.currency_code, "currency_code"),
    amount: storedMoney(row.amount, "amount"),
    paymentMethod,
    ...(reference === undefined ? {} : { reference }),
    fundingAccountId: storedString(row.funding_account_id, "funding_account_id"),
    payableAccountId: storedString(row.payable_account_id, "payable_account_id"),
    allocations,
    payloadChecksum: storedString(row.payload_checksum, "payload_checksum")
  };
}

async function scheduledLifecycleEventId(
  client: PostgresQueryClient,
  context: ServiceContext,
  billPaymentId: string
): Promise<string> {
  const row = await loadBillPaymentInstructionForUpdate(client, context, billPaymentId);
  return storedString(row.scheduled_event_id, "scheduled_event_id");
}

/** A transport retry may carry fresh request metadata; immutable authorization and business payload must agree. */
async function billPaymentReplayOperation(
  client: PostgresQueryClient, context: ServiceContext, eventId: unknown,
  expectedKey: string, operation: FinancialOperationContext
): Promise<FinancialOperationContext> {
  const row = (await client.query(`select idempotency_key,actor_ref,approver_ref,request_id,correlation_id,reason_code,reason_detail,occurred_at
    from erp_financials.financial_lifecycle_events where tenant_id=$1 and company_id=$2 and source_id=$3 and event_id=$4`,
    [context.tenantId, context.companyId, context.sourceId, storedString(eventId, "lifecycle event id")])).rows[0];
  if (!row || row.idempotency_key !== expectedKey || row.actor_ref !== operation.actorRef
    || storedOptionalString(row.approver_ref) !== operation.approverRef || row.reason_code !== operation.reasonCode
    || storedOptionalString(row.reason_detail) !== operation.reasonDetail) {
    throw new ErpFinancialsIdempotencyConflictError(expectedKey);
  }
  const approverRef = storedOptionalString(row.approver_ref);
  const reasonDetail = storedOptionalString(row.reason_detail);
  return { actorRef: storedString(row.actor_ref, "actor_ref"), ...(approverRef === undefined ? {} : { approverRef }),
    requestId: storedString(row.request_id, "request_id"), correlationId: storedString(row.correlation_id, "correlation_id"),
    reasonCode: storedString(row.reason_code, "reason_code"), ...(reasonDetail === undefined ? {} : { reasonDetail }),
    occurredAt: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : storedString(row.occurred_at, "occurred_at") };
}

function optimisticBillPaymentConflict(
  billPaymentId: string,
  expectedVersion: number,
  actualVersion: number
): ErpFinancialsError {
  return new ErpFinancialsError(
    "optimistic_concurrency_conflict",
    `Bill payment expected version ${String(expectedVersion)}, found ${String(actualVersion)}`,
    { retryable: true, details: { actualVersion, billPaymentId, expectedVersion } }
  );
}

async function recordWriteOff(
  context: ServiceContext,
  input: RecordWriteOffInput,
  options: { readonly documentStartsOpen?: boolean } = {}
): Promise<SubledgerDocumentResult> {
  const amount = normalizedPositiveMoney(input.amount, "amount");
  const journalLines: readonly PostJournalEntryLineInput[] =
    input.balanceType === "receivable"
      ? [
          { ...input.writeOffAccount, debit: amount, partyId: input.partyId },
          { ...input.balanceAccount, credit: amount, partyId: input.partyId }
        ]
      : [
          { ...input.balanceAccount, debit: amount, partyId: input.partyId },
          { ...input.writeOffAccount, credit: amount, partyId: input.partyId }
        ];
  return createSubledgerDocument(context, {
    ...commonSubledgerDocument(context, input, "write_off", amount, options.documentStartsOpen ?? false, {
      writeOffProvenance: {
        balanceType: input.balanceType,
        balanceAccountId: resolveAccountId(context, input.balanceAccount),
        writeOffAccountId: resolveAccountId(context, input.writeOffAccount),
        ...(input.relatedInvoiceId === undefined ? {} : { relatedInvoiceId: nonEmpty(input.relatedInvoiceId, "relatedInvoiceId") }),
        ...(input.reason === undefined ? {} : { reason: nonEmpty(input.reason, "reason") })
      }
    }),
    partyId: input.partyId,
    journalLines
  });
}

async function settleInvoiceWriteOff(
  context: ServiceContext,
  input: SettleInvoiceWriteOffInput
): Promise<SettleInvoiceWriteOffResult> {
  assertFinancialOperationContext(input.operation);
  assertNonEmpty(input.idempotencyKey, "idempotencyKey");
  assertNonEmpty(input.customerId, "customerId");
  assertNonEmpty(input.invoiceId, "invoiceId");
  assertExpectedSubledgerVersion(input.expectedInvoiceVersion, "expectedInvoiceVersion");
  assertIsoDate(input.date, "date");
  const amount = normalizedPositiveMoney(input.amount, "amount");
  const currencyCode = input.currencyCode ?? context.currencyCode;
  assertCurrencyAllowed(context, currencyCode);

  return context.database.transaction(async (client) => {
    await acquireTransactionLock(
      client,
      `write-off-settlement:${context.tenantId}:${context.companyId}:${context.sourceId}:${input.idempotencyKey}`
    );
    await assertCompanySourceScope(client, context);
    const nestedContext: ServiceContext = {
      ...context,
      database: { transaction: async <Result>(work: (nestedClient: PostgresQueryClient) => Promise<Result>) => work(client) }
    };
    const writeOff = await recordWriteOff(nestedContext, {
      operation: input.operation,
      idempotencyKey: input.idempotencyKey,
      date: input.date,
      ...(input.documentNumber === undefined ? {} : { documentNumber: input.documentNumber }),
      ...(input.memo === undefined ? {} : { memo: input.memo }),
      currencyCode,
      partyId: input.customerId,
      amount,
      balanceType: "receivable",
      balanceAccount: input.balanceAccount,
      writeOffAccount: input.writeOffAccount,
      relatedInvoiceId: input.invoiceId,
      ...(input.reason === undefined ? {} : { reason: input.reason })
    }, { documentStartsOpen: true });
    const application = await applySubledgerPayment(nestedContext, {
      operation: input.operation,
      idempotencyKey: input.idempotencyKey,
      applicationType: "write_off_to_invoice",
      sourceDocumentId: writeOff.documentId,
      targetDocumentId: input.invoiceId,
      amount,
      applicationDate: input.date,
      expectedSourceVersion: 1,
      expectedTargetVersion: input.expectedInvoiceVersion
    });
    const [writeOffRow, invoiceRow] = await loadSubledgerDocumentsForUpdate(client, context, [
      writeOff.documentId,
      input.invoiceId
    ]);
    return invoiceWriteOffSettlementResult(
      writeOffRow,
      invoiceRow,
      application,
      application.status === "already_applied" ? "already_settled" : "settled"
    );
  });
}

async function recordDeposit(context: ServiceContext, input: RecordDepositInput): Promise<SubledgerDocumentResult> {
  const amount = normalizedPositiveMoney(input.amount, "amount");
  assertDistinctAccounts(context, input.bankAccount, input.clearingAccount, "Deposit bank and clearing accounts");
  return createSubledgerDocument(context, {
    ...commonSubledgerDocument(context, input, "deposit", amount, false),
    journalLines: [
      { ...input.bankAccount, debit: amount },
      { ...input.clearingAccount, credit: amount }
    ]
  });
}

async function recordTransfer(context: ServiceContext, input: RecordTransferInput): Promise<SubledgerDocumentResult> {
  const amount = normalizedPositiveMoney(input.amount, "amount");
  assertDistinctAccounts(context, input.fromAccount, input.toAccount, "Transfer source and destination accounts");
  return createSubledgerDocument(context, {
    ...commonSubledgerDocument(context, input, "transfer", amount, false),
    journalLines: [
      { ...input.toAccount, debit: amount },
      { ...input.fromAccount, credit: amount }
    ]
  });
}

async function reverseDeposit(context: ServiceContext, input: ReverseDepositInput): Promise<ReverseDepositResult> {
  const { originalDocumentId, ...result } = await reverseRecordedCashMovement(context, "deposit", {
    ...input, documentId: input.depositId
  });
  return { ...result, originalDepositId: originalDocumentId };
}

async function reverseTransfer(context: ServiceContext, input: ReverseTransferInput): Promise<ReverseTransferResult> {
  assertFinancialApproval(context, input.operation);
  // JavaScript callers can omit fields that TypeScript requires.
  const approval = input.approval as TransferReversalApproval | null | undefined;
  if (approval == null || typeof approval.approvalRef !== "string" ||
      approval.approvalRef.trim().length === 0 ||
      approval.operationChecksum !== createTransferReversalApprovalChecksum(context, input)) {
    throw new ErpFinancialsError("authorization_context_invalid", "Transfer reversal requires approval bound to this exact command and scope");
  }
  // Snapshot the approved command before any asynchronous work.
  const { originalDocumentId, ...result } = await reverseRecordedCashMovement(context, "transfer", {
    ...input, documentId: input.transferId, operation: copyFinancialOperation(input.operation), approval: { ...input.approval }
  });
  return { ...result, originalTransferId: originalDocumentId };
}

/** Narrow routing for native cash movements; generic journal commands remain restricted. */
async function reverseRecordedCashMovement(
  context: ServiceContext,
  documentType: "deposit" | "transfer",
  input: Omit<ReverseJournalEntryInput, "originalTransactionId"> & {
    readonly documentId: string;
    readonly approval?: TransferReversalApproval;
  }
): Promise<Omit<ReverseDepositResult, "originalDepositId"> & { readonly originalDocumentId: string }> {
  assertFinancialApproval(context, input.operation);
  assertNonEmpty(input.documentId, "documentId");
  assertNonEmpty(input.idempotencyKey, "idempotencyKey");
  assertIsoDate(input.date, "date");

  return context.database.transaction(async (client) => {
    await acquireTransactionLock(client, `${documentType}-reversal:${context.tenantId}:${context.sourceId}:${input.documentId}`);
    await assertCompanySourceScope(client, context);
    // Serialize with fiscal close/reopen and posting-lock changes through commit.
    await acquireTransactionLock(client, `fiscal-period:${context.tenantId}:${context.companyId}:${context.sourceId}`);
    if (documentType === "transfer") {
      const replay = await client.query(
        `select "aggregate_id", "payload" from "erp_financials"."financial_lifecycle_events"
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3 and "idempotency_key" = $4
for key share`,
        [context.tenantId, context.companyId, context.sourceId, `transfer-reversal:${input.idempotencyKey}`]
      );
      const existing = replay.rows[0];
      if (existing !== undefined) {
        const payload = storedJson(existing.payload) as { approval?: TransferReversalApproval };
        if (existing.aggregate_id !== input.documentId ||
            payload.approval?.approvalRef !== input.approval?.approvalRef ||
            payload.approval?.operationChecksum !== input.approval?.operationChecksum) {
          throw new ErpFinancialsError("idempotency_conflict", "Transfer reversal key is already bound to a different approved command");
        }
      }
    }
    const result = await client.query(
      `select "transaction_id", "idempotency_key", "lifecycle_event_id", "status"
from "erp_financials"."subledger_documents"
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3
  and "subledger_document_id" = $4 and "document_type" = $5
for key share`,
      [context.tenantId, context.companyId, context.sourceId, input.documentId, documentType]
    );
    const document = result.rows[0];
    if (document === undefined) {
      throw new ErpFinancialsValidationError(`Recorded ${documentType} does not exist in this scope`, "missing_document");
    }
    if (document.status !== "settled") {
      throw new ErpFinancialsError("terminal_state_conflict", `Only a settled recorded ${documentType} can be reversed`);
    }
    const transactionId = storedString(document.transaction_id, "transaction_id");
    const originalKey = storedString(document.idempotency_key, "idempotency_key");
    await acquireTransactionLock(client, `subledger-document:${context.tenantId}:${context.companyId}:${context.sourceId}:${originalKey}`);
    // Reuse the lifecycle implementation inside this one outer transaction. New
    // cash movement reversals always enforce fiscal periods, including legacy callers.
    const nestedContext: ServiceContext = {
      ...context,
      postingPolicy: "enforce_fiscal_periods",
      database: { transaction: async <Result>(work: (nestedClient: PostgresQueryClient) => Promise<Result>) => work(client) }
    };
    const reverseBasis = async (originalTransactionId: string, basis: "accrual" | "cash") => {
      await acquireTransactionLock(client, `journal-lifecycle:${context.tenantId}:${context.sourceId}:${originalTransactionId}`);
      // Native transactions have no book column. Their durable ledger.posted
      // outbox event records the original company/book attribution. Fail closed
      // if that evidence is absent; never infer a book from the caller.
      const provenance = await client.query(
        `select "book_id" from "erp_financials"."financial_outbox"
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3
  and "aggregate_id" = $4 and "event_type" = 'ledger.posted'
for key share`,
        [context.tenantId, context.companyId, context.sourceId, originalTransactionId]
      );
      if (provenance.rows.length !== 1 || storedOptionalString(provenance.rows[0]?.book_id) !== context.bookId) {
        throw new ErpFinancialsValidationError(`Recorded ${documentType} posting book provenance is missing or outside this scope`, "scope_mismatch");
      }
      const original = await loadPostedJournalForLifecycle(client, context, originalTransactionId, [`Subledger:${documentType}`]);
      if (original.accountingBasis !== basis || original.accountingPolicy !== "configured_basis_only") {
        throw new ErpFinancialsValidationError(`Recorded ${documentType} journal has an unsupported accounting context`);
      }
      return runJournalLifecycleWorkflow(nestedContext, "reversed", {
        originalTransactionId,
        idempotencyKey: `${documentType}-reversal:${input.idempotencyKey}:${basis}`,
        date: input.date,
        ...(input.memo === undefined ? {} : { memo: input.memo }),
        operation: input.operation
      }, {
        allowedSourceTypes: [`Subledger:${documentType}`],
        priorEventId: storedString(document.lifecycle_event_id, "lifecycle_event_id")
      });
    };
    const primary = await reverseBasis(transactionId, "accrual");
    // Locate first; reverseBasis acquires the lifecycle lock before row locks,
    // in the same order as other journal lifecycle commands.
    const cash = await client.query(
      `select "transaction_id" from "erp_financials"."transactions"
where "tenant_id" = $1 and "source_id" = $2
  and "source_transaction_type" = 'Subledger:${documentType}' and "source_transaction_id" = $3`,
      [context.tenantId, context.sourceId, `${originalKey}:accounting-basis:cash`]
    );
    const cashRow = cash.rows[0];
    const cashResult = cashRow === undefined ? undefined : await reverseBasis(storedString(cashRow.transaction_id, "transaction_id"), "cash");
    const workflows = cashResult === undefined ? [primary] : [primary, cashResult];
    const event = await appendFinancialLifecycleEvent(client, {
      tenantId: context.tenantId,
      companyId: context.companyId,
      sourceId: context.sourceId,
      aggregateType: "subledger_document",
      aggregateId: input.documentId,
      eventType: `subledger.${documentType}.reversed`,
      idempotencyKey: `${documentType}-reversal:${input.idempotencyKey}`,
      operation: input.operation,
      recordedAt: context.now(),
      priorEventId: storedString(document.lifecycle_event_id, "lifecycle_event_id"),
      payload: {
        [`${documentType}Id`]: input.documentId,
        originalTransactionId: transactionId,
        reversalTransactionIds: workflows.map((workflow) => workflow.reversal.transactionId),
        ...(input.approval === undefined ? {} : { approval: {
          approvalRef: input.approval.approvalRef, operationChecksum: input.approval.operationChecksum
        } })
      }
    });
    await appendServiceOutboxEvent(client, context, {
      aggregateType: "subledger_document",
      aggregateId: input.documentId,
      eventType: `subledger.${documentType}.reversed`,
      idempotencyKey: `${documentType}-reversal:${input.idempotencyKey}:outbox`,
      payload: { [`${documentType}Id`]: input.documentId, originalTransactionId: transactionId, lifecycleEventId: event.eventId }
    });
    return {
      status: primary.reversal.status === "already_posted" ? "already_reversed" : "reversed",
      originalDocumentId: input.documentId,
      originalTransactionId: transactionId,
      reversal: primary.reversal,
      ...(cashResult === undefined ? {} : { cashReversal: cashResult.reversal }),
      journalEntryLinkIds: workflows.flatMap((workflow) => workflow.journalEntryLinkIds),
      lifecycleEventIds: [...workflows.flatMap((workflow) => workflow.lifecycleEventIds), event.eventId]
    };
  });
}

function commonSubledgerDocument(
  context: ServiceContext,
  input: SubledgerDocumentInputCommon,
  documentType: SubledgerDocumentType,
  amount: DecimalString,
  documentStartsOpen: boolean,
  metadata: Readonly<Record<string, JsonValue>> = {}
): Omit<SubledgerDocumentWrite, "journalLines"> {
  assertFinancialOperationContext(input.operation);
  assertNonEmpty(input.idempotencyKey, "idempotencyKey");
  assertIsoDate(input.date, "date");
  const currencyCode = input.currencyCode ?? context.currencyCode;
  assertCurrencyAllowed(context, currencyCode);
  assertBoundedMetadata(metadata);
  return {
    documentType,
    idempotencyKey: input.idempotencyKey,
    date: input.date,
    ...(input.documentNumber === undefined ? {} : { documentNumber: input.documentNumber }),
    currencyCode,
    amount,
    documentStartsOpen,
    metadata,
    ...(input.memo === undefined ? {} : { memo: input.memo }),
    operation: input.operation
  };
}

function subledgerJournalInput(input: SubledgerDocumentWrite): InternalPostJournalEntryInput {
  return {
    operation: input.operation,
    idempotencyKey: input.idempotencyKey,
    date: input.recognitionDate ?? input.date,
    ...(input.documentNumber === undefined ? {} : { transactionNumber: input.documentNumber }),
    ...(input.memo === undefined ? {} : { memo: input.memo }),
    currencyCode: input.currencyCode,
    accountingBasis: "accrual",
    lines: input.journalLines,
    nativeTransactionType: subledgerTransactionType(input.documentType),
    lifecycleAggregateType: "subledger_document",
    lifecycleEventType: `subledger.${input.documentType}.posted`,
    ...(input.partyId === undefined ? {} : { nativePartyId: input.partyId })
  };
}

async function createSubledgerDocument(
  context: ServiceContext,
  input: SubledgerDocumentWrite
): Promise<SubledgerDocumentResult> {
  assertFinancialOperationContext(input.operation);
  assertIsoDate(input.date, "date");
  if (input.recognitionDate !== undefined) assertIsoDate(input.recognitionDate, "recognitionDate");
  if (input.dueDate !== undefined) {
    assertIsoDate(input.dueDate, "dueDate");
    // An invoice or supplier obligation can already be overdue when recognized or corrected.
    // Its contractual due date must not be extended to the posting date.
    if (input.documentType !== "vendor_bill" && input.documentType !== "invoice" && input.dueDate < input.date) {
      throw new ErpFinancialsValidationError("dueDate must be on or after date");
    }
  }
  const documentId = scopedRecordId(context, "subledger_document", `${input.documentType}:${input.idempotencyKey}`);
  const journalInput = subledgerJournalInput(input);
  const journal = normalizeJournalEntry(context, journalInput);
  const identities = journalIdentities(context, journal);

  return context.database.transaction(async (client) => {
    // Collection guards and application/correction commands take this lock
    // before document/fiscal locks. Include new receipts to prevent phantoms.
    if (input.documentType === "invoice" || input.documentType === "customer_payment") {
      await lockCustomerPaymentCorrectionSource(client, context.tenantId, context.sourceId);
    }
    await acquireTransactionLock(
      client,
      `subledger-document:${context.tenantId}:${context.companyId}:${context.sourceId}:${input.idempotencyKey}`
    );
    await assertCompanySourceScope(client, context);
    if (input.documentType === "customer_payment") {
      const retired = await client.query(`select event_id from erp_financials.financial_lifecycle_events
        where tenant_id=$1 and company_id=$2 and source_id=$3 and idempotency_key=$4
          and payload->>'retired'='true'`,
        [context.tenantId,context.companyId,context.sourceId,`customer-payment-collection:${input.idempotencyKey}:completed`]);
      if (retired.rows.length) throw new ErpFinancialsIdempotencyConflictError(input.idempotencyKey);
    }
    await assertSubledgerParty(client, context, input.partyId, input.documentType);
    for (const customerId of unique((input.documentLines ?? []).flatMap((line) =>
      line.customerId === undefined ? [] : [line.customerId]
    ))) {
      await assertActiveSubledgerParty(client, context, customerId, "customer", "Bill-line customerId");
    }
    await assertRelatedInvoiceReference(client, context, input.partyId, input.metadata);
    const posted = await executePostJournalEntryInTransaction(client, context, journalInput, journal, identities, input.accountRequirements,input.validateNewPosting);
    if (isDualBasisCashMovement(input.documentType)) {
      const cashInput: InternalPostJournalEntryInput = {
        ...journalInput,
        idempotencyKey: `${input.idempotencyKey}:accounting-basis:cash`,
        accountingBasis: "cash"
      };
      const cashJournal = normalizeJournalEntry(context, cashInput);
      await executePostJournalEntryInTransaction(
        client,
        context,
        cashInput,
        cashJournal,
        journalIdentities(context, cashJournal)
      );
    }
    const openAmount = input.documentStartsOpen ? input.amount : "0.00";
    const documentStatus = input.documentStartsOpen ? "open" : "settled";
    const insert = await client.query(
      `insert into "erp_financials"."subledger_documents" (
  "subledger_document_id", "tenant_id", "company_id", "source_id", "document_type", "transaction_id",
  "party_id", "document_number", "document_date", "due_date", "currency_code", "original_amount", "open_amount",
  "status", "version", "idempotency_key", "lifecycle_event_id", "metadata", "created_at", "updated_at"${input.recognitionDate === undefined ? "" : ', "recognition_date"'}
) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 1, $15, $16, $17, $18, $18${input.recognitionDate === undefined ? "" : ", $19"})
on conflict ("tenant_id", "company_id", "source_id", "idempotency_key") do nothing
returning *`,
      [
        documentId,
        context.tenantId,
        context.companyId,
        context.sourceId,
        input.documentType,
        posted.transactionId,
        input.partyId,
        input.documentNumber,
        input.date,
        input.dueDate,
        input.currencyCode,
        input.amount,
        openAmount,
        documentStatus,
        input.idempotencyKey,
        posted.lifecycleEventId,
        JSON.stringify(input.metadata),
        context.now(),
        ...(input.recognitionDate === undefined ? [] : [input.recognitionDate])
      ]
    );
    const inserted = insert.rows[0];
    if (inserted !== undefined) {
      if (input.documentLines !== undefined) {
        await writeSubledgerDocumentLines(client, context, documentId, input.documentLines);
      }
      await persistRefundCashBasisProjection(client, context, input, documentId, "reverse");
      await appendSubledgerDocumentOutboxEvent(client, context, input, documentId, posted.transactionId);
      return documentResult(inserted, posted);
    }
    const existing = await loadSubledgerDocumentByIdempotencyKey(client, context, input.idempotencyKey);
    // Exact issuance replay compares the original dated facts, even after an
    // explicit restatement. The response still describes the current document.
    const firstCorrection = input.documentType === "invoice" ? (await client.query(
      `select "payload"->>'previousDate' as "original_date", "payload"->>'previousDueDate' as "original_due_date"
from "erp_financials"."financial_lifecycle_events"
where "tenant_id"=$1 and "company_id"=$2 and "source_id"=$3 and "aggregate_id"=$4 and "event_type"='subledger.invoice.dates_corrected'
order by ("payload"->>'expectedVersion')::integer limit 1`,
      [context.tenantId, context.companyId, context.sourceId, documentId]
    )).rows[0] : undefined;
    if (
      storedString(existing.subledger_document_id, "subledger_document_id") !== documentId ||
      storedString(existing.document_type, "document_type") !== input.documentType ||
      storedString(existing.transaction_id, "transaction_id") !== posted.transactionId ||
      storedMoney(existing.original_amount, "original_amount") !== input.amount ||
      storedDate(firstCorrection?.original_date ?? existing.document_date, "document_date") !== input.date ||
      storedOptionalDate(firstCorrection ? firstCorrection.original_due_date : existing.due_date, "due_date") !== input.dueDate ||
      storedOptionalString(existing.document_number) !== input.documentNumber ||
      storedOptionalString(existing.party_id) !== input.partyId ||
      storedString(existing.currency_code, "currency_code") !== input.currencyCode ||
      stableJson(storedJson(existing.metadata)) !== stableJson(input.metadata)
    ) {
      throw new ErpFinancialsIdempotencyConflictError(input.idempotencyKey);
    }
    if (input.documentType === "vendor_bill") {
      await assertSameBillLineCustomers(client, context, documentId, input);
    }
    if (input.documentType === "invoice" || input.documentType === "credit_memo") await assertSameInvoiceComponents(client,context,documentId,input);
    // The original atomic write already persisted refund cash projections; replay adds no postings.
    await appendSubledgerDocumentOutboxEvent(client, context, input, documentId, posted.transactionId);
    return documentResult(existing, { ...posted, status: "already_posted" });
  });
}

async function persistRefundCashBasisProjection(
  client: PostgresQueryClient,
  context: ServiceContext,
  input: SubledgerDocumentWrite,
  documentId: string,
  action: "recognize" | "reverse"
): Promise<readonly string[]> {
  if (input.documentType !== "refund") return [];
  const provenance = input.metadata.refundProvenance;
  if (provenance === null || typeof provenance !== "object" || Array.isArray(provenance)) return [];
  const relatedInvoiceId = (provenance as Readonly<Record<string, JsonValue>>).relatedInvoiceId;
  if (typeof relatedInvoiceId !== "string") return [];
  return persistCashBasisApplicationProjection(client, context, {
    action,
    applicationId: `refund:${documentId}`,
    applicationType: "customer_refund_against_invoice",
    appliedAmount: input.amount,
    effectiveDate: input.date,
    targetTransactionId: await loadSubledgerDocumentTransactionId(client, context, relatedInvoiceId)
  });
}

async function assertRelatedInvoiceReference(
  client: PostgresQueryClient,
  context: ServiceContext,
  partyId: string | undefined,
  metadata: Readonly<Record<string, JsonValue>>
): Promise<void> {
  const containers = [metadata.refundProvenance, metadata.writeOffProvenance];
  const container = containers.find((value) => typeof value === "object" && value !== null && !Array.isArray(value));
  const relatedInvoiceId = container === undefined
    ? undefined
    : (container as Readonly<Record<string, JsonValue>>).relatedInvoiceId;
  if (relatedInvoiceId === undefined) return;
  if (typeof relatedInvoiceId !== "string" || partyId === undefined) {
    throw new ErpFinancialsValidationError("relatedInvoiceId requires a customer-scoped invoice reference");
  }
  const result = await client.query(
    `select "subledger_document_id" from "erp_financials"."subledger_documents"
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3
  and "subledger_document_id" = $4 and "document_type" = 'invoice' and "party_id" = $5
for key share`,
    [context.tenantId, context.companyId, context.sourceId, relatedInvoiceId, partyId]
  );
  if (result.rows[0] === undefined) {
    throw new ErpFinancialsValidationError(
      "relatedInvoiceId does not reference an invoice for the same customer in this company/source scope",
      "missing_document",
      { relatedInvoiceId }
    );
  }
}

async function appendSubledgerDocumentOutboxEvent(
  client: PostgresQueryClient,
  context: ServiceContext,
  input: SubledgerDocumentWrite,
  documentId: string,
  transactionId: string
): Promise<void> {
  await appendServiceOutboxEvent(client, context, {
    eventType: `subledger_document.${input.documentType}.posted`,
    aggregateType: "subledger_document",
    aggregateId: documentId,
    idempotencyKey: `subledger-document:${input.idempotencyKey}:outbox:posted`,
    payload: { documentId, documentType: input.documentType, transactionId }
  });
}

type NormalizedSubledgerAmountLine = ErpFinancialsAccountReference & NormalizedCommercialDocumentLine &
  Pick<VendorBillExpenseLine, "customerId"> & InvoicePostingComponents;

async function assertSameBillLineCustomers(
  client: PostgresQueryClient,
  context: ServiceContext,
  documentId: string,
  input: SubledgerDocumentWrite
): Promise<void> {
  // Compare assignments separately so legacy unassigned journal fingerprints remain valid.
  const stored = await client.query(
    `select "line_number", "customer_party_id" from "erp_financials"."subledger_document_lines"
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3 and "subledger_document_id" = $4
  and "customer_party_id" is not null
order by "line_number"
for key share`,
    [context.tenantId, context.companyId, context.sourceId, documentId]
  );
  const expected = (input.documentLines ?? []).flatMap((line, index) => line.customerId === undefined
    ? []
    : [{ lineNumber: index + 1, customerId: line.customerId }]);
  const actual = stored.rows.map((row) => ({
    lineNumber: storedInteger(row.line_number, "line_number"),
    customerId: storedString(row.customer_party_id, "customer_party_id")
  }));
  if (stableJson(actual) !== stableJson(expected)) {
    throw new ErpFinancialsIdempotencyConflictError(input.idempotencyKey);
  }
}

async function assertSameInvoiceComponents(client: PostgresQueryClient,context:ServiceContext,documentId:string,input:SubledgerDocumentWrite):Promise<void>{
  const stored=await client.query(`select line_number,tax_account_id,discount_account_id from erp_financials.subledger_document_lines
    where tenant_id=$1 and company_id=$2 and source_id=$3 and subledger_document_id=$4
    and (tax_account_id is not null or discount_account_id is not null) order by line_number for key share`,
    [context.tenantId,context.companyId,context.sourceId,documentId]);
  const actual=stored.rows.map(row=>({lineNumber:storedInteger(row.line_number,"line_number"),tax:row.tax_account_id??null,discount:row.discount_account_id??null}));
  const expected=(input.documentLines??[]).flatMap((line,index)=>line.taxAccount||line.discountAccount ? [{lineNumber:index+1,
    tax:line.taxAccount?resolveAccountId(context,line.taxAccount):null,discount:line.discountAccount?resolveAccountId(context,line.discountAccount):null}] : []);
  if(stableJson(actual)!==stableJson(expected))throw new ErpFinancialsIdempotencyConflictError(input.idempotencyKey);
}

async function writeSubledgerDocumentLines(
  client: PostgresQueryClient,
  context: ServiceContext,
  documentId: string,
  lines: readonly NormalizedSubledgerAmountLine[]
): Promise<void> {
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    await client.query(
      `insert into "erp_financials"."subledger_document_lines" (
  "subledger_document_line_id", "tenant_id", "company_id", "source_id", "subledger_document_id", "line_number",
  "account_id", "item_id", "description", "quantity", "unit_amount", "unit_cost", "discount_amount", "tax_code", "tax_amount",
  "service_period_start", "service_period_end", "dimension_refs", "line_amount", "customer_party_id", "tax_account_id", "discount_account_id"
) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)`,
      [
        scopedRecordId(context, "subledger_document_line", `${documentId}:${String(lineNumber)}`),
        context.tenantId,
        context.companyId,
        context.sourceId,
        documentId,
        lineNumber,
        resolveAccountId(context, line),
        line.itemId,
        line.description,
        line.quantity,
        line.unitAmount,
        line.unitCost,
        line.discountAmount,
        line.taxCode,
        line.taxAmount,
        line.servicePeriodStart,
        line.servicePeriodEnd,
        JSON.stringify(line.dimensionRefs),
        line.amount,
        line.customerId,
        line.taxAccount ? resolveAccountId(context,line.taxAccount) : undefined,
        line.discountAccount ? resolveAccountId(context,line.discountAccount) : undefined
      ]
    );
  }
}

function applySubledgerPayment(context: ServiceContext, input: ApplySubledgerPaymentInput): Promise<SubledgerApplicationResult>;
function applySubledgerPayment(context: ServiceContext, input: ApplySubledgerPaymentInput, retirement: FinancialOperationContext): Promise<RetireReceiptApplicationResult>;
async function applySubledgerPayment(
  context: ServiceContext,
  input: ApplySubledgerPaymentInput,
  retirementInput?: FinancialOperationContext
): Promise<SubledgerApplicationResult | RetireReceiptApplicationResult> {
  input = { ...structuredClone(input), operation: copyFinancialOperation(input.operation) };
  assertNonEmpty(input.idempotencyKey, "idempotencyKey");
  assertFinancialOperationContext(input.operation);
  assertExpectedSubledgerVersion(input.expectedSourceVersion, "expectedSourceVersion");
  assertExpectedSubledgerVersion(input.expectedTargetVersion, "expectedTargetVersion");
  assertSubledgerApplicationType(input.applicationType);
  const amount = normalizedPositiveMoney(input.amount, "amount");
  assertIsoDate(input.applicationDate, "applicationDate");
  assertSubledgerMatchInput(input.match);
  if (input.crossSource !== undefined) {
    assertFinancialApproval(context, input.operation);
    if (!input.operation.approverRef || input.operation.approverRef === input.operation.actorRef)
      throw new ErpFinancialsValidationError("Cross-source settlement requires independent approval");
    if (!["customer_payment_to_invoice", "bill_payment_to_bill"].includes(input.applicationType) || input.match || retirementInput
      || !context.bookId || input.crossSource.targetSourceId === context.sourceId)
      throw new ErpFinancialsValidationError("Cross-source settlement supports reviewed native payments and historical invoices or bills only");
    for (const key of ["targetSourceId", "nativePartyId", "historicalPartyId", "reviewRef"] as const) assertNonEmpty(input.crossSource[key], `crossSource.${key}`);
    if (!input.crossSource.accountMappings.length) throw new ErpFinancialsValidationError("Cross-source settlement requires complete account mappings");
  }
  const commandChecksum = subledgerApplicationCommandChecksum(context, input, amount);
  const applicationId = scopedRecordId(context, "subledger_application", input.idempotencyKey);
  const retirement = retirementInput === undefined ? undefined : copyFinancialOperation(retirementInput);
  if (retirement) {
    assertFinancialOperationContext(retirement);
    if (retirement.actorRef !== input.operation.actorRef) throw new ErpFinancialsError("authorization_context_invalid", "Only the original application actor may retire its unrecorded attempt");
    if (input.applicationType !== "customer_payment_to_invoice") throw new ErpFinancialsError("unsupported_operation", "Retirement supports native customer receipt allocations only");
  }
  const retirementChecksum = retirement === undefined ? undefined : createHash("sha256").update(stableJson({ actorRef: retirement.actorRef,
    approverRef: retirement.approverRef ?? null, reasonCode: retirement.reasonCode, reasonDetail: retirement.reasonDetail ?? null })).digest("hex");
  const eventKey = `subledger-application:${input.idempotencyKey}:applied`;
  return context.database.transaction(async (client) => {
    for (const sourceId of unique([context.sourceId, ...(input.crossSource ? [input.crossSource.targetSourceId] : [])]).sort())
      await lockCustomerPaymentCorrectionSource(client, context.tenantId, sourceId);
    await acquireTransactionLock(
      client,
      `subledger-application:${context.tenantId}:${context.companyId}:${context.sourceId}:${input.sourceDocumentId}:${input.targetDocumentId}`
    );
    await assertCompanySourceScope(client, context);
    const terminal = (await client.query(`select event_id,aggregate_id,event_type,payload from erp_financials.financial_lifecycle_events
      where tenant_id=$1 and company_id=$2 and source_id=$3 and idempotency_key=$4`,
      [context.tenantId, context.companyId, context.sourceId, eventKey])).rows[0];
    if (terminal?.event_type === "subledger_application.receipt_attempt_retired") {
      const payload = storedJson(terminal.payload) as { commandChecksum?: string; retirementChecksum?: string } | null;
      if (!retirement || terminal.aggregate_id !== applicationId || payload?.commandChecksum !== commandChecksum || payload.retirementChecksum !== retirementChecksum) throw new ErpFinancialsIdempotencyConflictError(input.idempotencyKey);
      return { status: "already_retired", sourceDocumentId: input.sourceDocumentId, targetDocumentId: input.targetDocumentId,
        idempotencyKey: input.idempotencyKey, lifecycleEventId: storedString(terminal.event_id, "event_id") };
    }
    const existing = await loadSubledgerApplicationByIdempotencyKey(client, context, input.idempotencyKey);
    if (existing !== undefined) {
      assertSameSubledgerApplication(existing, input, amount, applicationId);
      const existingStatus = storedString(existing.status, "status");
      if (retirement) {
        await assertSubledgerApplicationCommandReplay(client, context, existing, input, applicationId, commandChecksum);
        if (existingStatus !== "applied" && existingStatus !== "unapplied" && existingStatus !== "voided") throw new ErpFinancialsError("terminal_state_conflict", "Application has an unsupported recorded state");
        return { status: "already_recorded", application: applicationResult(existing, existingStatus === "applied" ? "already_applied" : existingStatus) };
      }
      if (existingStatus !== "applied") {
        throw new ErpFinancialsValidationError(
          `Subledger application ${applicationId} is ${existingStatus} and cannot be replayed as applied; use a new idempotency key`
        );
      }
      await assertSubledgerApplicationCommandReplay(client, context, existing, input, applicationId, commandChecksum);
      return applicationResult(existing, "already_applied");
    }
    if (retirement) {
      const [source, target] = await loadSubledgerDocumentsForUpdate(client, context, [input.sourceDocumentId, input.targetDocumentId]);
      if (source.document_type !== "customer_payment" || target.document_type !== "invoice" || source.party_id == null || source.party_id !== target.party_id
        || source.currency_code !== target.currency_code || source.currency_code !== context.currencyCode) throw new ErpFinancialsError("scope_mismatch", "Retirement requires a native receipt and invoice for the same customer and currency");
      for (const document of [source, target]) {
        const provenance = (await client.query(`select book_id from erp_financials.financial_outbox
          where tenant_id=$1 and company_id=$2 and source_id=$3 and aggregate_id=$4 and event_type='ledger.posted' for key share`,
          [context.tenantId, context.companyId, context.sourceId, document.transaction_id])).rows;
        if (provenance.length !== 1 || storedOptionalString(provenance[0]?.book_id) !== context.bookId) throw new ErpFinancialsError("scope_mismatch", "Receipt application retirement requires original posting evidence in this book");
      }
      if (retirementChecksum === undefined) throw Error("Missing application retirement checksum");
      const lifecycle = await appendFinancialLifecycleEvent(client, { ...context, operation: retirement, aggregateType: "subledger_application",
        aggregateId: applicationId, eventType: "subledger_application.receipt_attempt_retired", idempotencyKey: eventKey, recordedAt: context.now(),
        payload: { commandChecksum, retirementChecksum, sourceDocumentId: input.sourceDocumentId, targetDocumentId: input.targetDocumentId } });
      return { status: "retired", sourceDocumentId: input.sourceDocumentId, targetDocumentId: input.targetDocumentId, idempotencyKey: input.idempotencyKey, lifecycleEventId: lifecycle.eventId };
    }
    if (context.postingPolicy === "enforce_fiscal_periods") {
      await assertPostingDateAllowed(client, context, input.applicationDate);
    }
    const [source, target] = await loadSubledgerDocumentsForUpdate(client, context, [
      input.sourceDocumentId,
      input.targetDocumentId
    ], input.crossSource?.targetSourceId);
    const crossSourcePlan = input.crossSource === undefined ? undefined : await prepareCrossSourceSettlement(client, context, input, source, target, amount, applicationId);
    if (input.applicationType === "bill_payment_to_bill" && target.payment_hold === true) throw new ErpFinancialsError("terminal_state_conflict", "Vendor bill is on payment hold");
    assertSubledgerApplicationDocuments(input, source,
      crossSourcePlan ? { ...target, party_id: source.party_id } : target, amount);
    if (input.match !== undefined) {
      await assertAcceptedSubledgerMatch(client, context, { ...input, match: input.match }, source, target);
    }
    const lifecycle = await appendFinancialLifecycleEvent(client, {
      tenantId: context.tenantId,
      companyId: context.companyId,
      sourceId: context.sourceId,
      aggregateType: "subledger_application",
      aggregateId: applicationId,
      eventType: "subledger_application.applied",
      idempotencyKey: `subledger-application:${input.idempotencyKey}:applied`,
      operation: input.operation,
      recordedAt: context.now(),
      payload: {
        commandVersion: 1,
        commandChecksum,
        expectedSourceVersion: input.expectedSourceVersion,
        expectedTargetVersion: input.expectedTargetVersion,
        applicationDate: input.applicationDate,
        applicationType: input.applicationType,
        appliedAmount: amount,
        sourceDocumentId: input.sourceDocumentId,
        targetDocumentId: input.targetDocumentId,
        ...(input.crossSource === undefined ? {} : { crossSource: input.crossSource }),
        ...(input.match === undefined
          ? {}
          : {
              matchCandidateId: input.match.matchCandidateId,
              matchDecisionId: input.match.matchDecisionId,
              matchMethod: input.match.method,
              matchScore: input.match.score
            })
      }
    });
    const inserted = await client.query(
      `insert into "erp_financials"."subledger_applications" (
  "subledger_application_id", "tenant_id", "company_id", "source_id", "application_type", "source_document_id",
  "target_document_id", "applied_amount", "currency_code", "application_date", "status", "version",
  "idempotency_key", "applied_event_id", "ended_event_id", "match_candidate_id", "match_decision_id", "match_method",
  "match_score", "match_evidence", "created_at", "updated_at", "target_document_source_id"
) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'applied', 1, $11, $12, null, $13, $14, $15, $16, $17, $18, $18, $19)
returning *`,
      [
        applicationId,
        context.tenantId,
        context.companyId,
        context.sourceId,
        input.applicationType,
        input.sourceDocumentId,
        input.targetDocumentId,
        amount,
        storedString(source.currency_code, "currency_code"),
        input.applicationDate,
        input.idempotencyKey,
        lifecycle.eventId,
        input.match?.matchCandidateId,
        input.match?.matchDecisionId,
        input.match?.method,
        input.match?.score,
        input.match?.evidence === undefined ? undefined : JSON.stringify(input.match.evidence),
        context.now(),
        input.crossSource?.targetSourceId ?? null
      ]
    );
    const row = inserted.rows[0];
    if (row === undefined) {
      throw new Error("Subledger application insert did not return its row");
    }
    const cashBasisPostingIds = crossSourcePlan
      ? await persistCrossSourceSettlement(client, context, crossSourcePlan, applicationId, input.applicationDate, "recognize")
      : await persistCashBasisApplicationProjection(client, context, {
      action: "recognize",
      sourceDocument: source,
      applicationId,
      applicationType: input.applicationType,
      appliedAmount: amount,
      effectiveDate: input.applicationDate,
      targetTransactionId: storedString(target.transaction_id, "target.transaction_id")
    });
    await appendServiceOutboxEvent(client, context, {
      eventType: "subledger_application.applied",
      aggregateType: "subledger_application",
      aggregateId: applicationId,
      idempotencyKey: `subledger-application:${input.idempotencyKey}:outbox:applied`,
      payload: {
        amount,
        applicationId,
        applicationType: input.applicationType,
        sourceDocumentId: input.sourceDocumentId,
        targetDocumentId: input.targetDocumentId,
        cashBasisPostingIds
      }
    });
    return applicationResult(row, "applied");
  });
}

async function endSubledgerApplication(
  context: ServiceContext,
  input: EndSubledgerApplicationInput,
  status: "unapplied" | "voided"
): Promise<SubledgerApplicationResult> {
  assertFinancialApproval(context, input.operation);
  assertIsoDate(input.effectiveDate, "effectiveDate");
  assertExpectedSubledgerVersion(input.expectedVersion, "expectedVersion");
  return context.database.transaction(async (client) => {
    const coordinate = (await client.query(`select target_document_source_id from erp_financials.subledger_applications
      where tenant_id=$1 and company_id=$2 and source_id=$3 and subledger_application_id=$4`,
      [context.tenantId, context.companyId, context.sourceId, input.applicationId])).rows[0];
    const targetSource = storedOptionalString(coordinate?.target_document_source_id);
    for (const sourceId of unique([context.sourceId, ...(targetSource ? [targetSource] : [])]).sort())
      await lockCustomerPaymentCorrectionSource(client, context.tenantId, sourceId);
    await acquireTransactionLock(
      client,
      `subledger-application:${context.tenantId}:${context.companyId}:${context.sourceId}:${input.applicationId}`
    );
    const currentResult = await client.query(
      `select *, "application_date"::text as "application_date" from "erp_financials"."subledger_applications"
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3 and "subledger_application_id" = $4
for update`,
      [context.tenantId, context.companyId, context.sourceId, input.applicationId]
    );
    const current = currentResult.rows[0];
    if (current === undefined) {
      throw new ErpFinancialsValidationError(
        `Subledger application ${input.applicationId} does not exist in this scope`,
        "missing_document",
        { applicationId: input.applicationId }
      );
    }
    if (current.target_document_source_id != null && current.target_document_source_id !== context.sourceId) {
      if (!input.operation.approverRef || input.operation.approverRef === input.operation.actorRef)
        throw new ErpFinancialsValidationError("Cross-source settlement undo requires independent approval");
      if (current.target_document_source_id !== targetSource)
        throw new ErpFinancialsError("optimistic_concurrency_conflict", "Settlement source coordinates changed before locking", { retryable: true });
    }
    if (current.application_type === "customer_payment_to_refund") {
      throw new ErpFinancialsError("terminal_state_conflict", "Cash return settlements cannot be detached from their refund");
    }
    const cancellation = await client.query(
      `select invoice_void_id from erp_financials.invoice_voids
       where tenant_id=$1 and company_id=$2 and source_id=$3 and application_id=$4 limit 1`,
      [context.tenantId, context.companyId, context.sourceId, input.applicationId]
    );
    if (cancellation.rows.length) throw new ErpFinancialsError("terminal_state_conflict",
      "Invoice cancellation credit cannot be detached; record a separately reviewed replacement invoice instead");
    const currentStatus = storedString(current.status, "status");
    if (currentStatus === status) {
      // A retry may use a new transport request, but cannot silently change
      // the accounting date or the version on which the original end acted.
      const event = await client.query(
        `select "idempotency_key", "payload", "aggregate_id", "event_type"
from "erp_financials"."financial_lifecycle_events"
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3 and "event_id" = $4`,
        [context.tenantId, context.companyId, context.sourceId, current.ended_event_id]
      );
      const ended = event.rows[0];
      const payload = storedJson(ended?.payload);
      const evidence = payload !== null && typeof payload === "object" && !Array.isArray(payload)
        ? payload as Readonly<Record<string, JsonValue>> : undefined;
      if (ended === undefined || evidence === undefined
        || ended.aggregate_id !== input.applicationId || ended.event_type !== `subledger_application.${status}`
        || evidence.effectiveDate !== input.effectiveDate || evidence.priorVersion !== input.expectedVersion
        || evidence.status !== status || storedInteger(current.version, "version") !== input.expectedVersion + 1) {
        throw new ErpFinancialsIdempotencyConflictError(`subledger-application:${input.applicationId}:${status}`);
      }
      return applicationResult(current, status);
    }
    if (currentStatus !== "applied") {
      throw new ErpFinancialsValidationError(`Subledger application is already ${currentStatus}`);
    }
    const currentVersion = storedInteger(current.version, "version");
    if (currentVersion !== input.expectedVersion) {
      throw new ErpFinancialsError(
        "optimistic_concurrency_conflict",
        `Subledger application expected version ${String(input.expectedVersion)}, found ${String(currentVersion)}`,
        { retryable: true, details: { actualVersion: currentVersion, expectedVersion: input.expectedVersion } }
      );
    }
    if (context.postingPolicy === "enforce_fiscal_periods") {
      await assertPostingDateAllowed(client, context, input.effectiveDate);
    }
    const lifecycle = await appendFinancialLifecycleEvent(client, {
      tenantId: context.tenantId,
      companyId: context.companyId,
      sourceId: context.sourceId,
      aggregateType: "subledger_application",
      aggregateId: input.applicationId,
      eventType: `subledger_application.${status}`,
      idempotencyKey: `subledger-application:${input.applicationId}:${status}:v${String(currentVersion)}`,
      operation: input.operation,
      recordedAt: context.now(),
      priorEventId: storedString(current.applied_event_id, "applied_event_id"),
      payload: { effectiveDate: input.effectiveDate, priorVersion: currentVersion, status }
    });
    const updated = await client.query(
      `update "erp_financials"."subledger_applications"
set "status" = $5, "version" = "version" + 1, "ended_event_id" = $6, "updated_at" = $7
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3
  and "subledger_application_id" = $4 and "version" = $8 and "status" = 'applied'
returning *`,
      [
        context.tenantId,
        context.companyId,
        context.sourceId,
        input.applicationId,
        status,
        lifecycle.eventId,
        context.now(),
        currentVersion
      ]
    );
    const row = updated.rows[0];
    if (row === undefined) {
      throw new ErpFinancialsError("optimistic_concurrency_conflict", "Subledger application changed concurrently", {
        retryable: true,
        details: { applicationId: input.applicationId }
      });
    }
    const cashBasisPostingIds = current.target_document_source_id != null && current.target_document_source_id !== context.sourceId
      ? await reverseCrossSourceSettlement(client, context, current, input)
      : await persistCashBasisApplicationProjection(client, context, {
      action: "reverse",
      applicationId: input.applicationId,
      applicationType: storedString(current.application_type, "application_type") as SubledgerApplicationType,
      appliedAmount: storedMoney(current.applied_amount, "applied_amount"),
      effectiveDate: input.effectiveDate,
      targetTransactionId: await loadSubledgerDocumentTransactionId(
        client,
        context,
        storedString(current.target_document_id, "target_document_id")
      )
    });
    await appendServiceOutboxEvent(client, context, {
      eventType: `subledger_application.${status}`,
      aggregateType: "subledger_application",
      aggregateId: input.applicationId,
      idempotencyKey: `subledger-application:${input.applicationId}:outbox:${status}:v${String(currentVersion)}`,
      payload: { applicationId: input.applicationId, cashBasisPostingIds, effectiveDate: input.effectiveDate, priorVersion: currentVersion, status }
    });
    return applicationResult(row, status);
  });
}

type CashBasisApplicationProjectionInput = {
    readonly action: "recognize" | "reverse";
    readonly applicationId: string;
    readonly applicationType: SubledgerApplicationType | "customer_refund_against_invoice";
    readonly appliedAmount: DecimalString;
    readonly effectiveDate: IsoDate;
    readonly targetTransactionId: string;
    /** Read-only cash-return preflight models the pending full unapplication. */
    readonly previewReleasedApplicationId?: string;
    readonly sourceDocument?: Record<string, unknown>;
  };

async function prepareCashBasisApplicationProjection(
  client: PostgresQueryClient, context: ServiceContext, input: CashBasisApplicationProjectionInput
) {
  if (!["customer_payment_to_invoice", "bill_payment_to_bill", "customer_refund_against_invoice"].includes(input.applicationType)) return null;
  const result = await client.query(
    `select *, "posting_date"::text as "posting_date" from "erp_financials"."ledger_postings"
where "tenant_id" = $1 and "source_id" = $2 and "transaction_id" = $3 and "accounting_basis" = 'accrual'
order by "posting_id"
for key share`,
    [context.tenantId, context.sourceId, input.targetTransactionId]
  );
  const importBatchId = scopedRecordId(
    context,
    "import_batch",
    `cash-basis-application:${input.applicationId}:${input.action}`
  );
  let accrualPostings = (result.rows.length ? result.rows :
    await loadImportedDocumentAccrualPostings(client, context, input.targetTransactionId)).map(storedLedgerPosting);
  if (!result.rows.length && input.sourceDocument !== undefined && input.applicationType === 'customer_payment_to_invoice') {
    await assertImportedPaymentCashCredit(client, context, input.sourceDocument);
  }
  let controlAccountId: string | undefined;
  // A positive-only bill has one credit: its payable control. Avoid adding
  // metadata queries to the existing high-volume positive-bill path.
  if (input.applicationType === "bill_payment_to_bill"
    && accrualPostings.filter(posting => parsePositiveOrZeroMoney(posting.creditAmount, "credit") > 0n).length > 1) {
    const bill = (await client.query(`select subledger_document_id, metadata, original_amount::text
      from erp_financials.subledger_documents where tenant_id=$1 and company_id=$2 and source_id=$3
      and transaction_id=$4 and document_type='vendor_bill'`,
    [context.tenantId, context.companyId, context.sourceId, input.targetTransactionId])).rows[0];
    const metadata = storedJson(bill?.metadata) as { vendorBillCredit?: { amount?: unknown; payableAccountId?: unknown } } | undefined;
    const credit = metadata?.vendorBillCredit;
    if (credit !== undefined) {
      const payable = accrualPostings.filter(posting => posting.accountId === credit.payableAccountId);
      if (!bill || payable.length !== 1 || payable[0]?.debitAmount !== "0.00"
        || payable[0].creditAmount !== storedMoney(bill.original_amount, "original_amount")
        || credit.amount !== payable[0].creditAmount) {
        throw new ErpFinancialsValidationError("Credited bill cash projection requires its exact net payable account");
      }
      controlAccountId = payable[0].accountId;
      // Allocate the remaining journal, including prior reversals. Independent
      // percentage rounding on each installment can otherwise over-recognize
      // a small credit. End operations reverse the exact original allocation.
      const identities = accrualPostings.map(posting => posting.sourcePostingId);
      if (input.action === "recognize") {
        const recognized = (await client.query(`with origins as (select jsonb_array_elements_text($5::jsonb) id)
          select o.id,trunc(coalesce(sum(p.debit_amount-p.credit_amount),0)*100)::text as net_minor
          from origins o left join erp_financials.subledger_applications a
            on a.tenant_id=$1 and a.company_id=$2 and a.source_id=$3 and a.target_document_id=$4
            and a.application_type='bill_payment_to_bill'
            and ($7::text is null or a.subledger_application_id<>$7)
          left join erp_financials.ledger_postings p on p.tenant_id=$1 and p.source_id=$3 and p.accounting_basis='cash'
            and p.transaction_id=$6 and p.source_posting_id in ('cash-application:'||a.subledger_application_id||':recognize:'||o.id,'cash-application:'||a.subledger_application_id||':reverse:'||o.id)
          group by o.id`, [context.tenantId, context.companyId, context.sourceId, bill.subledger_document_id,
          JSON.stringify(identities), input.targetTransactionId, input.previewReleasedApplicationId ?? null])).rows;
        const used = new Map(recognized.map(row => [storedString(row.id, "id"), BigInt(storedString(row.net_minor, "net_minor"))]));
        accrualPostings = accrualPostings.map(posting => {
          const debit = parsePositiveOrZeroMoney(posting.debitAmount, "debit"), credit = parsePositiveOrZeroMoney(posting.creditAmount, "credit"), net = used.get(posting.sourcePostingId) ?? 0n;
          const remainingDebit = debit > 0n ? debit - net : 0n, remainingCredit = credit > 0n ? credit + net : 0n;
          if (remainingDebit < 0n || remainingCredit < 0n || remainingDebit > debit || remainingCredit > credit) throw new ErpFinancialsValidationError("Bill allocations exceed their original journal");
          return { ...posting, debitAmount: formatMoney(remainingDebit), creditAmount: formatMoney(remainingCredit), netAmount: formatMoney(remainingDebit - remainingCredit) };
        });
      } else {
        const prefix = `cash-application:${input.applicationId}:recognize:`;
        const allocated = (await client.query(`select source_posting_id,debit_amount::text,credit_amount::text from erp_financials.ledger_postings
          where tenant_id=$1 and source_id=$2 and transaction_id=$3 and accounting_basis='cash' and source_posting_id=any($4::text[])`,
        [context.tenantId, context.sourceId, input.targetTransactionId, identities.map(id => prefix + id)])).rows;
        const byOrigin = new Map(allocated.map(row => [storedString(row.source_posting_id, "source_posting_id").slice(prefix.length), row]));
        accrualPostings = accrualPostings.map(posting => {
          const prior = byOrigin.get(posting.sourcePostingId), debit = prior ? storedMoney(prior.debit_amount, "debit_amount") : "0.00", credit = prior ? storedMoney(prior.credit_amount, "credit_amount") : "0.00";
          return { ...posting, debitAmount: debit, creditAmount: credit, netAmount: formatMoney(parsePositiveOrZeroMoney(debit, "debit") - parsePositiveOrZeroMoney(credit, "credit")) };
        });
      }
    }
  }
  if(input.applicationType !== "bill_payment_to_bill") {
    const components=(await client.query(`select distinct d.subledger_document_id,d.original_amount::text,l.discount_account_id
      from erp_financials.subledger_documents d join erp_financials.subledger_document_lines l
      on l.tenant_id=d.tenant_id and l.company_id=d.company_id and l.source_id=d.source_id and l.subledger_document_id=d.subledger_document_id
      where d.tenant_id=$1 and d.company_id=$2 and d.source_id=$3 and d.transaction_id=$4 and d.document_type='invoice'
      and (l.discount_account_id is not null or l.tax_account_id is not null)`,[context.tenantId,context.companyId,context.sourceId,input.targetTransactionId])).rows;
    if(components.length){
      if(input.applicationType==="customer_refund_against_invoice")throw new ErpFinancialsError("unsupported_operation",
        "Component invoices require receipt returnCash for cash refunds and explicit credits for sale adjustments");
      const document=components[0];
      if(!document)throw new ErpFinancialsValidationError("Missing component document");
      const discountAccounts=new Set(components.filter(row=>row.discount_account_id!==null).map(row=>storedString(row.discount_account_id,"discount_account_id")));
      const controls=accrualPostings.filter(posting=>!discountAccounts.has(posting.accountId)&&parsePositiveOrZeroMoney(posting.debitAmount,"debit")>0n);
      if(controls.length!==1 || components.some(row=>row.subledger_document_id!==document.subledger_document_id)
        || controls[0]?.debitAmount!==storedMoney(document.original_amount,"original_amount"))throw new ErpFinancialsValidationError("Invoice component control posting is ambiguous");
      const control=controls[0];
      controlAccountId=control.accountId;
      const identities=accrualPostings.map(posting=>posting.sourcePostingId);
      if(input.action==="recognize"){
        // Subtract actual prior allocations and reversals, not independently
        // rounded application percentages. The last collection consumes the
        // exact remaining journal; unapply makes its exact components available.
        const recognized=(await client.query(`with origins as (select jsonb_array_elements_text($5::jsonb) id)
          select o.id,trunc(coalesce(sum(p.debit_amount-p.credit_amount),0)*100)::text as net_minor
          from origins o left join erp_financials.subledger_applications a
            on a.tenant_id=$1 and a.company_id=$2 and a.source_id=$3 and a.target_document_id=$4
            and a.application_type='customer_payment_to_invoice'
            and ($7::text is null or a.subledger_application_id<>$7)
          left join erp_financials.ledger_postings p on p.tenant_id=$1 and p.source_id=$3 and p.accounting_basis='cash'
            and p.transaction_id=$6 and p.source_posting_id in ('cash-application:'||a.subledger_application_id||':recognize:'||o.id,'cash-application:'||a.subledger_application_id||':reverse:'||o.id)
          group by o.id`,[context.tenantId,context.companyId,context.sourceId,document.subledger_document_id,JSON.stringify(identities),input.targetTransactionId,input.previewReleasedApplicationId??null])).rows;
        const used=new Map(recognized.map(row=>[storedString(row.id,"id"),BigInt(storedString(row.net_minor,"net_minor"))]));
        accrualPostings=accrualPostings.map(posting=>{
          const debit=parsePositiveOrZeroMoney(posting.debitAmount,"debit"),credit=parsePositiveOrZeroMoney(posting.creditAmount,"credit"),net=used.get(posting.sourcePostingId)??0n;
          const remainingDebit=debit>0n?debit-net:0n,remainingCredit=credit>0n?credit+net:0n;
          if(remainingDebit<0n||remainingCredit<0n)throw new ErpFinancialsValidationError("Invoice component allocations exceed their original journal");
          return {...posting,debitAmount:formatMoney(remainingDebit),creditAmount:formatMoney(remainingCredit),netAmount:formatMoney(remainingDebit-remainingCredit)};
        });
      }else{
        const prefix=`cash-application:${input.applicationId}:recognize:`;
        const allocated=(await client.query(`select source_posting_id,debit_amount::text,credit_amount::text from erp_financials.ledger_postings
          where tenant_id=$1 and source_id=$2 and transaction_id=$3 and accounting_basis='cash' and source_posting_id=any($4::text[])`,
          [context.tenantId,context.sourceId,input.targetTransactionId,identities.map(id=>prefix+id)])).rows;
        const byOrigin=new Map(allocated.map(row=>[storedString(row.source_posting_id,"source_posting_id").slice(prefix.length),row]));
        accrualPostings=accrualPostings.map(posting=>{
          const prior=byOrigin.get(posting.sourcePostingId),debit=prior?storedMoney(prior.debit_amount,"debit_amount"):"0.00",credit=prior?storedMoney(prior.credit_amount,"credit_amount"):"0.00";
          return {...posting,debitAmount:debit,creditAmount:credit,netAmount:formatMoney(parsePositiveOrZeroMoney(debit,"debit")-parsePositiveOrZeroMoney(credit,"credit"))};
        });
      }
    }
  }
  const postings = projectCashBasisApplication({
    applicationId: input.applicationId,
    applicationType: input.applicationType as CashBasisApplicationType,
    action: input.action,
    appliedAmount: input.appliedAmount,
    effectiveDate: input.effectiveDate,
    importBatchId,
    accrualPostings,
    ...(controlAccountId===undefined?{}:{controlAccountId})
  });
  const now = context.now();
  const storage = createPostgresStorageAdapter(client);
  const accountIds = unique(postings.map(posting => posting.accountId));
  await assertPostingAccountEligibility(client, context, accountIds);
  const accounts = await storage.loadAccounts({ tenantId: context.tenantId, sourceId: context.sourceId, accountIds });
  assertJournalAccounts(accounts, accountIds);
  return { postings, storage, importBatchId, now };
}

async function persistCashBasisApplicationProjection(
  client: PostgresQueryClient, context: ServiceContext, input: CashBasisApplicationProjectionInput
): Promise<readonly string[]> {
  const plan = await prepareCashBasisApplicationProjection(client, context, input);
  if (!plan) return [];
  const { postings, storage, importBatchId, now } = plan;
  await storage.upsertImportBatch({
    tenantId: context.tenantId,
    sourceId: context.sourceId,
    importBatchId,
    mode: "delta",
    status: "completed",
    startedAt: now,
    completedAt: now,
    sourceObjectCounts: { applications: 1, postings: postings.length }
  });
  // These are new native application facts on the document header. The source
  // posting identity and payload ref still identify the original basis journal;
  // no accrual posting or provider transaction is fabricated or moved.
  await storage.upsertLedgerPostings(postings.map(posting => ({ ...posting, transactionId: input.targetTransactionId })));
  const firstPosting = postings[0];
  if (firstPosting === undefined) throw new Error("Cash-basis projection returned no postings");
  await storage.markReportSnapshotsStaleForPostingChanges({
    tenantId: context.tenantId,
    companyId: context.companyId,
    sourceId: context.sourceId,
    affectedStart: input.effectiveDate,
    affectedEnd: input.effectiveDate,
    staleReason: `subledger_application_${input.action}`,
    accountingBasis: "cash",
    currencyCode: firstPosting.currencyCode
  });
  return postings.map((posting) => posting.postingId);
}

/** A provider cash journal must actually contain the unallocated A/R credit.
 * Otherwise projecting the invoice could recognize cash income a second time.
 */
async function assertImportedPaymentCashCredit(
  client: PostgresQueryClient, context: ServiceContext, payment: Record<string, unknown>
): Promise<void> {
  const metadata = payment.metadata as Record<string, unknown> | undefined;
  if (metadata?.provider !== 'quickbooks') return;
  if (metadata.sourceTransactionType !== 'Payment' || typeof metadata.sourceTransactionId !== 'string')
    throw new ErpFinancialsValidationError('Missing imported Payment identity');
  const transactions = (await client.query(`select * from erp_financials.transactions
    where tenant_id=$1 and source_id=$2 and
      ((source_transaction_type='Payment' and source_transaction_id=$3) or
       (source_payload_ref->>'sourceObjectType'='Payment' and source_payload_ref->>'sourceObjectId'=$3))
    order by transaction_id for share`, [context.tenantId,context.sourceId,metadata.sourceTransactionId])).rows;
  const postings = (await client.query(`select p.*,p.posting_date::text as posting_date,a.type as account_type from erp_financials.ledger_postings p
    join erp_financials.accounts a using(tenant_id,source_id,account_id)
    where p.tenant_id=$1 and p.source_id=$2 and p.transaction_id=any($3::text[]) order by posting_id for share of p,a`,
    [context.tenantId,context.sourceId,transactions.map(t=>t.transaction_id)])).rows;
  const original = parsePositiveMoney(payment.original_amount,'original_amount');
  if (!transactions.some(t=>t.transaction_id===payment.transaction_id) ||
      transactions.some(t=>t.status!=='posted' || t.currency_code!==payment.currency_code || (t.party_id!==null && t.party_id!==payment.party_id)) ||
      postings.some(p=>p.currency_code!==payment.currency_code || p.party_id!==payment.party_id || !['accrual','cash'].includes(String(p.accounting_basis))))
    throw new ErpFinancialsValidationError('Incomplete imported Payment accounting provenance');
  for (const basis of ['accrual','cash']) {
    const entries=postings.filter(p=>p.accounting_basis===basis);
    if(entries.reduce((sum,p)=>sum+parsePositiveOrZeroMoney(p.debit_amount,'debit_amount'),0n)!==original ||
       entries.reduce((sum,p)=>sum+parsePositiveOrZeroMoney(p.credit_amount,'credit_amount'),0n)!==original)
      throw new ErpFinancialsValidationError('Incomplete or duplicate imported Payment basis journal');
  }
  const arCredit=(basis:string)=>postings.filter(p=>p.accounting_basis===basis && p.account_type==='AccountsReceivable')
    .reduce((sum,p)=>sum+parsePositiveOrZeroMoney(p.credit_amount,'credit_amount')-parsePositiveOrZeroMoney(p.debit_amount,'debit_amount'),0n);
  const nativeApplied=(await client.query(`select a.applied_amount from erp_financials.subledger_applications a
    where a.tenant_id=$1 and a.source_id=$2 and a.source_document_id=$3 and a.status='applied'
      and exists(select 1 from erp_financials.ledger_postings p where p.tenant_id=a.tenant_id and p.source_id=a.source_id
        and starts_with(p.source_posting_id,'cash-application:'||a.subledger_application_id||':recognize:'))`,
    [context.tenantId,context.sourceId,payment.subledger_document_id])).rows
    .reduce((sum,a)=>sum+parsePositiveMoney(a.applied_amount,'applied_amount'),0n);
  if(arCredit('accrual')!==original || arCredit('cash')!==parsePositiveOrZeroMoney(payment.open_amount,'open_amount')+nativeApplied)
    throw new ErpFinancialsValidationError('Imported Payment lacks canonical unallocated cash-basis A/R credit; reconcile provider allocation evidence');
}

/** Resolve only exact imported object identities, never amount/date/number matches. */
async function loadImportedDocumentAccrualPostings(
  client: PostgresQueryClient, context: ServiceContext, headerTransactionId: string
): Promise<readonly Record<string, unknown>[]> {
  const header = (await client.query(`select t.*, d.original_amount, d.document_type, d.metadata
    from erp_financials.transactions t
    join erp_financials.subledger_documents d using(tenant_id,source_id,transaction_id)
    join erp_financials.accounting_sources s using(tenant_id,source_id)
    where t.tenant_id=$1 and t.source_id=$2 and t.transaction_id=$3 and d.company_id=$4
      and s.source_system='quickbooks'
    for share of t,d,s`, [context.tenantId, context.sourceId, headerTransactionId, context.companyId])).rows[0];
  const metadata = header?.metadata as Record<string, unknown> | undefined;
  if (!header || metadata?.provider !== 'quickbooks' ||
      !['Invoice','Bill'].includes(String(header.source_transaction_type)) ||
      metadata.sourceTransactionId !== header.source_transaction_id || metadata.sourceTransactionType !== header.source_transaction_type ||
      header.status !== 'posted' || header.currency_code !== context.currencyCode || !header.party_id) {
    throw new ErpFinancialsValidationError('Missing exact imported document accrual provenance');
  }
  const transactions = (await client.query(`select * from erp_financials.transactions
    where tenant_id=$1 and source_id=$2 and transaction_id<>$3
      and source_payload_ref->>'sourceObjectType'=$4 and source_payload_ref->>'sourceObjectId'=$5
    order by transaction_id for share`, [context.tenantId,context.sourceId,headerTransactionId,header.source_transaction_type,header.source_transaction_id])).rows;
  const rows = (await client.query(`select *, "posting_date"::text as "posting_date" from erp_financials.ledger_postings
    where tenant_id=$1 and source_id=$2 and transaction_id=any($3::text[]) and accounting_basis='accrual'
    order by posting_id for share`, [context.tenantId,context.sourceId,transactions.map(t=>t.transaction_id)])).rows;
  const ids = unique(rows.map(r=>String(r.transaction_id)));
  const transaction = transactions.find(t=>t.transaction_id===ids[0]);
  // One complete journal is supported. Duplicate/split/ambiguous basis journals
  // must be reconciled by the importer rather than summed or guessed here.
  if (ids.length !== 1 || !transaction || transaction.status !== 'posted' || transaction.currency_code !== header.currency_code ||
      (transaction.party_id !== null && transaction.party_id !== header.party_id) ||
      rows.some(r=>r.currency_code !== header.currency_code || r.party_id !== header.party_id) ||
      rows.reduce((sum,r)=>sum+parsePositiveOrZeroMoney(r.debit_amount,'debit_amount'),0n) !== parsePositiveMoney(header.original_amount,'original_amount') ||
      rows.reduce((sum,r)=>sum+parsePositiveOrZeroMoney(r.credit_amount,'credit_amount'),0n) !== parsePositiveMoney(header.original_amount,'original_amount')) {
    throw new ErpFinancialsValidationError('Incomplete or ambiguous imported document accrual provenance');
  }
  const reversed = await client.query(`select 1 from erp_financials.journal_entry_links
    where tenant_id=$1 and source_id=$2 and original_transaction_id=any($3::text[]) and link_type in ('reversal','void')`,
    [context.tenantId,context.sourceId,[headerTransactionId,...ids]]);
  if (reversed.rows.length) throw new ErpFinancialsValidationError('Imported document accrual journal has been reversed');
  return rows;
}

async function loadSubledgerDocumentTransactionId(
  client: PostgresQueryClient,
  context: ServiceContext,
  documentId: string
): Promise<string> {
  const result = await client.query(
    `select "transaction_id" from "erp_financials"."subledger_documents"
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3 and "subledger_document_id" = $4`,
    [context.tenantId, context.companyId, context.sourceId, documentId]
  );
  const row = result.rows[0];
  if (row === undefined) throw new ErpFinancialsValidationError(`Subledger document ${documentId} does not exist`);
  return storedString(row.transaction_id, "transaction_id");
}

function storedLedgerPosting(row: Record<string, unknown>): LedgerPosting {
  const transactionLineId = storedOptionalString(row.transaction_line_id);
  const partyId = storedOptionalString(row.party_id);
  const itemId = storedOptionalString(row.item_id);
  const checkpointId = storedOptionalString(row.checkpoint_id);
  return {
    tenantId: storedString(row.tenant_id, "tenant_id"),
    sourceId: storedString(row.source_id, "source_id"),
    postingId: storedString(row.posting_id, "posting_id"),
    sourcePostingId: storedString(row.source_posting_id, "source_posting_id"),
    transactionId: storedString(row.transaction_id, "transaction_id"),
    ...(transactionLineId === undefined ? {} : { transactionLineId }),
    accountId: storedString(row.account_id, "account_id"),
    ...(partyId === undefined ? {} : { partyId }),
    ...(itemId === undefined ? {} : { itemId }),
    postingDate: storedDate(row.posting_date, "posting_date"),
    accountingBasis: storedString(row.accounting_basis, "accounting_basis") as AccountingBasis,
    debitAmount: storedMoney(row.debit_amount, "debit_amount"),
    creditAmount: storedMoney(row.credit_amount, "credit_amount"),
    netAmount: storedMoney(row.net_amount, "net_amount"),
    currencyCode: storedString(row.currency_code, "currency_code"),
    dimensionHash: storedString(row.dimension_hash, "dimension_hash"),
    dimensionRefs: storedDimensionRefs(row.dimension_refs),
    importBatchId: storedString(row.import_batch_id, "import_batch_id"),
    ...(row.source_payload_ref == null ? {} : { sourcePayloadRef: storedJson(row.source_payload_ref) as SafeSourcePayloadRef }),
    ...(checkpointId === undefined ? {} : { checkpointId })
  };
}

async function assertSubledgerParty(
  client: PostgresQueryClient,
  context: ServiceContext,
  partyId: string | undefined,
  documentType: SubledgerDocumentType
): Promise<void> {
  if (partyId === undefined) {
    return;
  }
  const expectedPartyType = ["vendor_bill", "bill_payment"].includes(documentType) ? "vendor" : "customer";
  await assertActiveSubledgerParty(client, context, partyId, expectedPartyType, documentType);
}

async function assertActiveSubledgerParty(
  client: PostgresQueryClient,
  context: ServiceContext,
  partyId: string,
  expectedPartyType: "vendor" | "customer",
  label: string
): Promise<void> {
  const result = await client.query(
    `select "party_type", "active" from "erp_financials"."parties"
where "tenant_id" = $1 and "source_id" = $2 and "party_id" = $3
for share`,
    [context.tenantId, context.sourceId, partyId]
  );
  const party = result.rows[0];
  if (party === undefined || party.active !== true || party.party_type !== expectedPartyType) {
    throw new ErpFinancialsValidationError(
      `${label} requires an active ${expectedPartyType} in the current tenant/source scope`,
      "missing_party",
      { partyId }
    );
  }
}

async function loadSubledgerDocumentByIdempotencyKey(
  client: PostgresQueryClient,
  context: ServiceContext,
  idempotencyKey: string
): Promise<Record<string, unknown>> {
  const result = await client.query(
    `select *, document_date::text as document_date, due_date::text as due_date from "erp_financials"."subledger_documents"
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3 and "idempotency_key" = $4
for key share`,
    [context.tenantId, context.companyId, context.sourceId, idempotencyKey]
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`Subledger document idempotency row ${idempotencyKey} was not found`);
  }
  return row;
}

async function loadSubledgerApplicationByIdempotencyKey(
  client: PostgresQueryClient,
  context: ServiceContext,
  idempotencyKey: string
): Promise<Record<string, unknown> | undefined> {
  const result = await client.query(
    `select *, application_date::text as application_date from "erp_financials"."subledger_applications"
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3 and "idempotency_key" = $4
for key share`,
    [context.tenantId, context.companyId, context.sourceId, idempotencyKey]
  );
  return result.rows[0];
}

async function loadSubledgerDocumentsForUpdate(
  client: PostgresQueryClient,
  context: ServiceContext,
  ids: readonly [string, string],
  targetSourceId?: string
): Promise<readonly [Record<string, unknown>, Record<string, unknown>]> {
  if (ids[0] === ids[1]) {
    throw new ErpFinancialsValidationError("Subledger application source and target documents must differ");
  }
  const result = targetSourceId === undefined ? await client.query(
    `select *, "document_date"::text as "document_date", "due_date"::text as "due_date", (to_jsonb("subledger_documents")->>'recognition_date') as "recognition_date" from "erp_financials"."subledger_documents"
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3 and "subledger_document_id" = any($4::text[])
order by "subledger_document_id"
for update`,
    [context.tenantId, context.companyId, context.sourceId, [...ids].sort()]
  ) : await client.query(
    `select *, "document_date"::text as "document_date", "due_date"::text as "due_date", (to_jsonb("subledger_documents")->>'recognition_date') as "recognition_date" from "erp_financials"."subledger_documents"
where "tenant_id" = $1 and "company_id" = $2
  and (("source_id" = $3 and "subledger_document_id" = $4) or ("source_id" = $5 and "subledger_document_id" = $6))
order by "subledger_document_id"
for update`,
    [context.tenantId, context.companyId, context.sourceId, ids[0], targetSourceId, ids[1]]
  );
  const byId = new Map(result.rows.map((row) => [storedString(row.subledger_document_id, "subledger_document_id"), row]));
  const source = byId.get(ids[0]);
  const target = byId.get(ids[1]);
  if (source === undefined || target === undefined) {
    throw new ErpFinancialsValidationError(
      "Both subledger application documents must exist in the current scope",
      "missing_document"
    );
  }
  return [source, target];
}

function assertSubledgerApplicationDocuments(
  input: ApplySubledgerPaymentInput,
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  amount: DecimalString
): void {
  const expectedTypes: Record<SubledgerApplicationType, readonly [readonly SubledgerDocumentType[], SubledgerDocumentType]> = {
    customer_payment_to_invoice: [["customer_payment"], "invoice"],
    bill_payment_to_bill: [["bill_payment"], "vendor_bill"],
    credit_to_invoice: [["credit_memo", "deposit"], "invoice"],
    vendor_credit_to_bill: [["vendor_credit"], "vendor_bill"],
    write_off_to_invoice: [["write_off"], "invoice"],
    customer_payment_to_refund: [["customer_payment"], "refund"]
  };
  const types = expectedTypes[input.applicationType];
  if (!types[0].includes(source.document_type as SubledgerDocumentType) || target.document_type !== types[1]) {
    throw new ErpFinancialsValidationError("Application documents do not match applicationType");
  }
  if (source.party_id == null || source.party_id !== target.party_id) {
    throw new ErpFinancialsValidationError("Application documents must have the same non-null party");
  }
  if (source.currency_code !== target.currency_code) {
    throw new ErpFinancialsValidationError("Application documents must use the same currency");
  }
  if (storedInteger(source.version, "source.version") !== input.expectedSourceVersion) {
    throw new ErpFinancialsError("optimistic_concurrency_conflict", "Source document version changed concurrently", {
      retryable: true,
      details: { documentId: input.sourceDocumentId, expectedVersion: input.expectedSourceVersion }
    });
  }
  if (storedInteger(target.version, "target.version") !== input.expectedTargetVersion) {
    throw new ErpFinancialsError("optimistic_concurrency_conflict", "Target document version changed concurrently", {
      retryable: true,
      details: { documentId: input.targetDocumentId, expectedVersion: input.expectedTargetVersion }
    });
  }
  if (source.document_type === "customer_payment" && input.applicationDate < storedDate(source.document_date, "document_date")) {
    throw new ErpFinancialsValidationError("Application cannot precede cash receipt");
  }
  if (target.document_type === "invoice" && input.applicationDate < storedDate(target.recognition_date ?? target.document_date, "recognition_date")) {
    throw new ErpFinancialsValidationError("Invoice application cannot precede recognition; retain the receipt unapplied until recognition");
  }
  const amountMinor = parsePositiveMoney(amount, "amount");
  if (
    amountMinor > parsePositiveOrZeroMoney(source.open_amount, "source.open_amount") ||
    amountMinor > parsePositiveOrZeroMoney(target.open_amount, "target.open_amount")
  ) {
    throw new ErpFinancialsValidationError("Application amount exceeds an available document balance");
  }
}

function assertSubledgerMatchInput(match: ApplySubledgerPaymentInput["match"]): void {
  if (match === undefined) return;
  assertNonEmpty(match.matchCandidateId, "match.matchCandidateId");
  assertNonEmpty(match.matchDecisionId, "match.matchDecisionId");
  const method: unknown = match.method;
  if (method !== "automatic" && method !== "manual") {
    throw new ErpFinancialsValidationError("match.method must be automatic or manual");
  }
  if (!/^(?:0(?:\.\d{1,6})?|1(?:\.0{1,6})?)$/u.test(match.score)) {
    throw new ErpFinancialsValidationError("match.score must be between 0 and 1 with at most six fractional digits");
  }
  if (match.evidence !== undefined) {
    assertNoCredentialKeys(match.evidence);
    if (Buffer.byteLength(JSON.stringify(match.evidence), "utf8") > 4096) {
      throw new ErpFinancialsValidationError("match.evidence exceeds 4096 bytes");
    }
  }
}

function paymentProvenance(
  provenance: CustomerPaymentProvenance | undefined
): CustomerPaymentProvenance | undefined {
  if (provenance === undefined) return undefined;
  if (provenance.externalBankMatch !== undefined) {
    nonEmpty(provenance.externalBankMatch.externalMatchId, "provenance.externalBankMatch.externalMatchId");
    optionalNonEmpty(provenance.externalBankMatch.bankStatementLineId, "provenance.externalBankMatch.bankStatementLineId");
    optionalNonEmpty(provenance.externalBankMatch.providerReference, "provenance.externalBankMatch.providerReference");
    if (provenance.externalBankMatch.matchedAt !== undefined) {
      assertIsoDateTime(provenance.externalBankMatch.matchedAt, "provenance.externalBankMatch.matchedAt");
    }
  }
  if (provenance.deposit !== undefined) {
    nonEmpty(provenance.deposit.depositId, "provenance.deposit.depositId");
    optionalNonEmpty(provenance.deposit.externalDepositReference, "provenance.deposit.externalDepositReference");
    if (provenance.deposit.depositedAt !== undefined) {
      assertIsoDateTime(provenance.deposit.depositedAt, "provenance.deposit.depositedAt");
    }
  }
  assertBoundedMetadata({ customerPaymentProvenance: provenance });
  return provenance;
}

function optionalReferenceProvenance(
  values: Readonly<Record<string, string | undefined>>,
  field: string
): Readonly<Record<string, JsonValue>> | undefined {
  const entries = Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined);
  if (entries.length === 0) return undefined;
  const result = Object.fromEntries(entries.map(([key, value]) => [key, nonEmpty(value, `${field}.${key}`)]));
  assertBoundedMetadata(result);
  return result;
}

function assertBoundedMetadata(metadata: Readonly<Record<string, JsonValue>>): void {
  assertNoCredentialKeys(metadata);
  if (Buffer.byteLength(JSON.stringify(metadata), "utf8") > 4096) {
    throw new ErpFinancialsValidationError("subledger metadata exceeds 4096 bytes");
  }
}

function nonEmpty(value: string, field: string): string {
  assertNonEmpty(value, field);
  return value;
}

function optionalNonEmpty(value: string | undefined, field: string): void {
  if (value !== undefined) assertNonEmpty(value, field);
}

async function assertAcceptedSubledgerMatch(
  client: PostgresQueryClient,
  context: ServiceContext,
  input: ApplySubledgerPaymentInput & { readonly match: NonNullable<ApplySubledgerPaymentInput["match"]> },
  source: Readonly<Record<string, unknown>>,
  target: Readonly<Record<string, unknown>>
): Promise<void> {
  const result = await client.query(
    `select candidate."match_kind", candidate."origin_transaction_id", candidate."target_transaction_id", candidate."score" as "candidate_score",
  candidate."suggested_application_amount",
  candidate."currency_code", candidate."status" as "candidate_status", candidate."expires_at",
  decision."decision", decision."method", decision."evidence" as "decision_evidence"
from "erp_financials"."transaction_match_candidates" candidate
join "erp_financials"."transaction_match_decisions" decision
  on decision."tenant_id" = candidate."tenant_id" and decision."source_id" = candidate."source_id"
 and decision."match_candidate_id" = candidate."match_candidate_id"
where candidate."tenant_id" = $1 and candidate."source_id" = $2 and candidate."match_candidate_id" = $3
  and decision."match_decision_id" = $4
for key share of candidate, decision`,
    [context.tenantId, context.sourceId, input.match.matchCandidateId, input.match.matchDecisionId]
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new ErpFinancialsValidationError("Accepted match candidate and decision do not exist in this scope", "missing_document");
  }
  const expectedKind =
    input.applicationType === "customer_payment_to_invoice"
      ? "customer_payment_to_invoice"
      : input.applicationType === "bill_payment_to_bill"
        ? "vendor_payment_to_bill"
        : undefined;
  if (expectedKind === undefined) {
    throw new ErpFinancialsValidationError("Credit applications cannot reference a payment match candidate");
  }
  const candidateStatus = storedString(row.candidate_status, "candidate_status");
  if (
    storedString(row.match_kind, "match_kind") !== expectedKind ||
    storedString(row.origin_transaction_id, "origin_transaction_id") !== storedString(source.transaction_id, "source.transaction_id") ||
    storedString(row.target_transaction_id, "target_transaction_id") !== storedString(target.transaction_id, "target.transaction_id") ||
    storedString(row.currency_code, "currency_code") !== storedString(source.currency_code, "source.currency_code") ||
    normalizedPositiveMoney(
      storedDecimal(row.suggested_application_amount, "suggested_application_amount"),
      "suggested_application_amount"
    ) !== normalizedPositiveMoney(input.amount, "amount") ||
    storedString(row.decision, "decision") !== "accepted" ||
    storedString(row.method, "method") !== input.match.method ||
    !unitDecimalsEqual(storedDecimal(row.candidate_score, "candidate_score"), input.match.score) ||
    stableJson(storedJson(row.decision_evidence)) !== stableJson(input.match.evidence ?? null) ||
    ["rejected", "expired", "superseded"].includes(candidateStatus)
  ) {
    throw new ErpFinancialsValidationError("Match evidence is not valid for these application documents", "scope_mismatch");
  }
  const expiresAt = row.expires_at instanceof Date ? row.expires_at.toISOString() : storedOptionalString(row.expires_at);
  if (expiresAt !== undefined && expiresAt.slice(0, 10) < input.applicationDate) {
    throw new ErpFinancialsValidationError("Match candidate expired before the application date", "terminal_state_conflict");
  }
  await client.query(
    `update "erp_financials"."transaction_match_candidates"
set "status" = 'accepted'
where "tenant_id" = $1 and "source_id" = $2 and "match_candidate_id" = $3 and "status" in ('suggested', 'accepted')`,
    [context.tenantId, context.sourceId, input.match.matchCandidateId]
  );
}

function subledgerApplicationCommandChecksum(context: ServiceContext, input: ApplySubledgerPaymentInput, amount: string): string {
  return createHash("sha256").update(stableJson({
    commandVersion: 1, tenantId: context.tenantId, companyId: context.companyId, sourceId: context.sourceId,
    bookId: context.bookId ?? null, currencyCode: context.currencyCode, accountingBasis: context.accountingBasis,
    idempotencyKey: input.idempotencyKey, applicationType: input.applicationType,
    sourceDocumentId: input.sourceDocumentId, targetDocumentId: input.targetDocumentId,
    applicationDate: input.applicationDate, amount,
    expectedSourceVersion: input.expectedSourceVersion, expectedTargetVersion: input.expectedTargetVersion,
    match: input.match ?? null, actorRef: input.operation.actorRef, approverRef: input.operation.approverRef ?? null,
    reasonCode: input.operation.reasonCode, reasonDetail: input.operation.reasonDetail ?? null,
    ...(input.crossSource === undefined ? {} : { crossSource: input.crossSource })
  })).digest("hex");
}

async function assertSubledgerApplicationCommandReplay(client: PostgresQueryClient, context: ServiceContext,
  existing: Record<string, unknown>, input: ApplySubledgerPaymentInput, applicationId: string, checksum: string, retainedEvent?: Record<string, unknown>): Promise<void> {
  const event = retainedEvent ?? (await client.query(
    `select aggregate_type,aggregate_id,event_type,actor_ref,approver_ref,reason_code,reason_detail,payload
from erp_financials.financial_lifecycle_events
where tenant_id=$1 and company_id=$2 and source_id=$3 and event_id=$4 for key share`,
    [context.tenantId, context.companyId, context.sourceId, existing.applied_event_id]
  )).rows[0];
  const rawPayload = storedJson(event?.payload);
  const payload = rawPayload !== null && typeof rawPayload === "object" && !Array.isArray(rawPayload)
    ? rawPayload as Readonly<Record<string, JsonValue>> : undefined;
  if (!payload || payload.commandVersion !== 1 ||
    typeof payload.commandChecksum !== "string" || typeof payload.expectedSourceVersion !== "number" || typeof payload.expectedTargetVersion !== "number") {
    throw new ErpFinancialsError("unsupported_operation", "Historical application lacks immutable command evidence; reconcile its retained application and lifecycle records instead of resubmitting or choosing a new key");
  }
  if (!event || event.aggregate_type !== "subledger_application" || event.aggregate_id !== applicationId || event.event_type !== "subledger_application.applied" ||
    event.actor_ref !== input.operation.actorRef || (event.approver_ref ?? null) !== (input.operation.approverRef ?? null) ||
    event.reason_code !== input.operation.reasonCode || (event.reason_detail ?? null) !== (input.operation.reasonDetail ?? null) ||
    payload.commandChecksum !== checksum || payload.expectedSourceVersion !== input.expectedSourceVersion || payload.expectedTargetVersion !== input.expectedTargetVersion) {
    throw new ErpFinancialsIdempotencyConflictError(input.idempotencyKey);
  }
}

function assertSameSubledgerApplication(
  existing: Record<string, unknown>,
  input: ApplySubledgerPaymentInput,
  amount: DecimalString,
  applicationId: string
): void {
  if (
    existing.subledger_application_id !== applicationId ||
    existing.application_type !== input.applicationType ||
    existing.source_document_id !== input.sourceDocumentId ||
    existing.target_document_id !== input.targetDocumentId ||
    storedMoney(existing.applied_amount, "applied_amount") !== amount ||
    storedDate(existing.application_date, "application_date") !== input.applicationDate ||
    storedOptionalString(existing.match_candidate_id) !== input.match?.matchCandidateId ||
    storedOptionalString(existing.match_decision_id) !== input.match?.matchDecisionId ||
    storedOptionalString(existing.match_method) !== input.match?.method ||
    (existing.match_score === null || existing.match_score === undefined
      ? undefined
      : storedDecimal(existing.match_score, "match_score")) !== input.match?.score ||
    stableJson(existing.match_evidence ?? null) !== stableJson(input.match?.evidence ?? null)
  ) {
    throw new ErpFinancialsIdempotencyConflictError(input.idempotencyKey);
  }
}

function documentResult(row: Record<string, unknown>, journal: PostJournalEntryResult): SubledgerDocumentResult {
  const documentStatus = storedString(row.status, "status");
  if (!["open", "partially_applied", "settled", "voided"].includes(documentStatus)) {
    throw new Error(`New subledger document has unexpected status ${documentStatus}`);
  }
  return {
    status: journal.status,
    documentId: storedString(row.subledger_document_id, "subledger_document_id"),
    documentType: storedString(row.document_type, "document_type") as SubledgerDocumentType,
    originalAmount: storedMoney(row.original_amount, "original_amount"),
    openAmount: storedMoney(row.open_amount, "open_amount"),
    documentStatus: documentStatus as SubledgerDocumentResult["documentStatus"],
    version: storedInteger(row.version, "version"),
    journal
  };
}

function applicationResult(
  row: Record<string, unknown>,
  status: SubledgerApplicationResult["status"]
): SubledgerApplicationResult {
  const matchCandidateId = storedOptionalString(row.match_candidate_id);
  const matchDecisionId = storedOptionalString(row.match_decision_id);
  const matchMethod = storedOptionalString(row.match_method) as "automatic" | "manual" | undefined;
  const matchScore = row.match_score === null || row.match_score === undefined
    ? undefined
    : storedDecimal(row.match_score, "match_score");
  return {
    status,
    applicationId: storedString(row.subledger_application_id, "subledger_application_id"),
    version: storedInteger(row.version, "version"),
    sourceDocumentId: storedString(row.source_document_id, "source_document_id"),
    targetDocumentId: storedString(row.target_document_id, "target_document_id"),
    ...(row.target_document_source_id == null ? {} : { targetDocumentSourceId: storedString(row.target_document_source_id, "target_document_source_id") }),
    appliedAmount: storedMoney(row.applied_amount, "applied_amount"),
    currencyCode: storedString(row.currency_code, "currency_code"),
    ...(matchCandidateId === undefined ? {} : { matchCandidateId }),
    ...(matchDecisionId === undefined ? {} : { matchDecisionId }),
    ...(matchMethod === undefined ? {} : { matchMethod }),
    ...(matchScore === undefined ? {} : { matchScore }),
    lifecycleEventId: storedString(
      row.ended_event_id ?? row.applied_event_id,
      row.ended_event_id == null ? "applied_event_id" : "ended_event_id"
    )
  };
}

function invoiceWriteOffSettlementResult(
  writeOff: Record<string, unknown>,
  invoice: Record<string, unknown>,
  application: SubledgerApplicationResult,
  status: SettleInvoiceWriteOffResult["status"]
): SettleInvoiceWriteOffResult {
  if (writeOff.document_type !== "write_off" || invoice.document_type !== "invoice") {
    throw new Error("Invoice write-off settlement returned unexpected document types");
  }
  const invoiceStatus = storedString(invoice.status, "invoice.status");
  if (!["open", "partially_applied", "settled"].includes(invoiceStatus)) {
    throw new Error(`Invoice write-off settlement returned unexpected invoice status ${invoiceStatus}`);
  }
  return {
    status,
    writeOffDocumentId: storedString(writeOff.subledger_document_id, "writeOff.subledger_document_id"),
    writeOffTransactionId: storedString(writeOff.transaction_id, "writeOff.transaction_id"),
    writeOffVersion: storedInteger(writeOff.version, "writeOff.version"),
    application,
    invoiceId: storedString(invoice.subledger_document_id, "invoice.subledger_document_id"),
    invoiceOpenAmount: storedMoney(invoice.open_amount, "invoice.open_amount"),
    invoiceStatus: invoiceStatus as SettleInvoiceWriteOffResult["invoiceStatus"],
    invoiceVersion: storedInteger(invoice.version, "invoice.version")
  };
}

function storedDecimal(value: unknown, field: string): DecimalString {
  const decimal = typeof value === "number" ? String(value) : storedString(value, field);
  if (!/^-?\d+(?:\.\d+)?$/u.test(decimal)) throw new Error(`Stored field ${field} must be a decimal`);
  return decimal;
}

function storedJson(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  return (typeof value === "string" ? JSON.parse(value) : value) as JsonValue;
}

function unitDecimalsEqual(left: DecimalString, right: DecimalString): boolean {
  const scaled = (value: string): bigint => {
    const [whole = "0", fraction = ""] = value.split(".");
    return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0").slice(0, 6));
  };
  return scaled(left) === scaled(right);
}

function subledgerTransactionType(documentType: SubledgerDocumentType): string {
  return `Subledger:${documentType}`;
}

function sumSubledgerLines(lines: readonly SubledgerAmountLine[], field: string): DecimalString {
  if (lines.length === 0) {
    throw new ErpFinancialsValidationError(`${field} must contain at least one line`);
  }
  return formatMoney(
    lines.reduce((sum, line, index) => sum + parsePositiveMoney(line.amount, `${field}[${String(index)}].amount`), 0n)
  );
}

function normalizeInvoiceLines(lines: readonly SubledgerAmountLine[]): readonly NormalizedSubledgerAmountLine[] {
  if (!lines.length) throw new ErpFinancialsValidationError("revenueLines must contain at least one line");
  return lines.map((line,index)=>({ ...accountReferenceOnly(line),
    ...normalizeCommercialDocumentLine(line,`revenueLines[${String(index)}]`),...normalizeInvoiceComponents(line) }));
}

function normalizeSubledgerLines(
  lines: readonly SubledgerAmountLine[],
  field: string
): readonly (ErpFinancialsAccountReference & NormalizedCommercialDocumentLine)[] {
  if (lines.length === 0) {
    throw new ErpFinancialsValidationError(`${field} must contain at least one line`);
  }
  return lines.map((line, index) => {
    if (line.taxAccount !== undefined || line.discountAccount !== undefined) throw new ErpFinancialsValidationError("Invoice component accounts are unsupported for this document type");
    return {...accountReferenceOnly(line),...normalizeCommercialDocumentLine(line, `${field}[${String(index)}]`)};
  });
}

/** Vendor invoice credits retain their signed commercial line, not a second
 * liability or a collapsed net expense. Component tax/discount semantics for
 * negative lines are deliberately rejected until their own posting contract. */
function normalizeVendorBillLines(lines: readonly VendorBillExpenseLine[]) {
  if (!Array.isArray(lines) || !lines.length) throw new ErpFinancialsValidationError("expenseLines must contain at least one line");
  return lines.map((line: VendorBillExpenseLine, index: number) => {
    const field = `expenseLines[${String(index)}]`;
    if (line.taxAccount !== undefined || line.discountAccount !== undefined) throw new ErpFinancialsValidationError("Invoice component accounts are unsupported for this document type");
    if (typeof line.amount !== "string" || !line.amount.startsWith("-")) {
      const normalized = normalizeSubledgerLines([line], field)[0];
      if (!normalized) throw new ErpFinancialsValidationError("Missing vendor bill line");
      return normalized;
    }
    if ((line.taxAmount !== undefined && parsePositiveOrZeroMoney(line.taxAmount, `${field}.taxAmount`) !== 0n)
      || (line.discountAmount !== undefined && parsePositiveOrZeroMoney(line.discountAmount, `${field}.discountAmount`) !== 0n)) {
      throw new ErpFinancialsValidationError("Signed vendor bill lines require zero tax and discount components");
    }
    if (line.unitAmount !== undefined && (typeof line.unitAmount !== "string" || !line.unitAmount.startsWith("-"))) {
      throw new ErpFinancialsValidationError(`${field}.unitAmount must be negative for a bill credit`);
    }
    const normalized = normalizeCommercialDocumentLine({ ...line, amount: line.amount.slice(1),
      ...(line.unitAmount === undefined ? {} : { unitAmount: line.unitAmount.slice(1) }) }, field);
    return { ...accountReferenceOnly(line), ...normalized, amount: `-${normalized.amount}`, unitAmount: `-${normalized.unitAmount}` };
  });
}

function accountReferenceOnly(line: SubledgerAmountLine): ErpFinancialsAccountReference {
  return line.accountKey !== undefined ? { accountKey: line.accountKey } : { accountId: line.accountId };
}

function normalizedPositiveMoney(value: DecimalString, field: string): DecimalString {
  return formatMoney(parsePositiveMoney(value, field));
}

function assertDistinctAccounts(
  context: ServiceContext,
  left: ErpFinancialsAccountReference,
  right: ErpFinancialsAccountReference,
  label: string
): void {
  if (resolveAccountId(context, left) === resolveAccountId(context, right)) {
    throw new ErpFinancialsValidationError(`${label} must differ`);
  }
}

function assertSubledgerApplicationType(value: SubledgerApplicationType): void {
  if (![
    "customer_payment_to_invoice",
    "bill_payment_to_bill",
    "credit_to_invoice",
    "vendor_credit_to_bill",
    "write_off_to_invoice",
    "customer_payment_to_refund"
  ].includes(value)) {
    throw new ErpFinancialsValidationError(`Unsupported subledger application type ${value}`);
  }
}

function parsePositiveOrZeroMoney(value: unknown, field: string): bigint {
  const money = typeof value === "number" ? value.toFixed(2) : value;
  if (typeof money !== "string" || !/^\d+(?:\.\d{1,2})?$/u.test(money)) {
    throw new Error(`${field} must be nonnegative fixed-scale money`);
  }
  const [whole, fraction = ""] = money.split(".");
  return BigInt(whole ?? "0") * 100n + BigInt(fraction.padEnd(2, "0"));
}

function assertExpectedSubledgerVersion(version: number, field: string): void {
  if (!Number.isInteger(version) || version < 1) {
    throw new ErpFinancialsValidationError(`${field} must be a positive integer`);
  }
}

function storedInteger(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed)) {
    throw new Error(`Stored field ${field} must be an integer`);
  }
  return parsed;
}

type LoadedPostedJournal = {
  readonly transactionId: string;
  readonly memo?: string;
  readonly currencyCode: IsoCurrencyCode;
  readonly accountingBasis: AccountingBasis;
  readonly accountingPolicy: ManualJournalAccountingPolicy;
  readonly lines: readonly PostJournalEntryLineInput[];
  readonly postedLifecycleEventId?: string;
};

type LoadedPostedVendorBill = {
  readonly documentId: string;
  readonly transactionId: string;
  readonly vendorId: string;
  readonly currencyCode: IsoCurrencyCode;
  readonly originalAmount: DecimalString;
  readonly openAmount: DecimalString;
  readonly status: SubledgerDocumentResult["documentStatus"];
  readonly version: number;
  readonly journal: LoadedPostedJournal;
  readonly paymentHold: boolean;
  readonly paymentHoldReason: string | null;
};

async function correctPostedVendorBill(context: ServiceContext, input: CorrectPostedVendorBillInput): Promise<CorrectPostedVendorBillResult> {
  const command = { ...structuredClone(input), operation: copyFinancialOperation(input.operation) };
  assertFinancialApproval(context, command.operation);
  assertNonEmpty(command.vendorBillId, "vendorBillId");
  assertNonEmpty(command.idempotencyKey, "idempotencyKey");
  assertExpectedSubledgerVersion(command.expectedVersion, "expectedVersion");
  assertIsoDate(command.date, "date");
  const rawReleases: unknown = command.releases;
  if (!Array.isArray(rawReleases)) throw new ErpFinancialsValidationError("Correction requires an explicit application release plan");
  const releases = command.releases.map(release => {
    assertNonEmpty(release.applicationId, "applicationId");
    assertExpectedSubledgerVersion(release.expectedVersion, "application.expectedVersion");
    assertExpectedSubledgerVersion(release.expectedSourceVersion, "application.expectedSourceVersion");
    const reapplyAmount = formatMoney(parsePositiveOrZeroMoney(release.reapplyAmount, "reapplyAmount"));
    if (!command.replacement && reapplyAmount !== "0.00") throw new ErpFinancialsValidationError("A void cannot reapply funds without a replacement bill");
    return { ...release, reapplyAmount };
  }).sort((a, b) => a.applicationId.localeCompare(b.applicationId));
  if (new Set(releases.map(release => release.applicationId)).size !== releases.length) throw new ErpFinancialsValidationError("Application release IDs must be unique");
  if (command.replacement && command.replacement.date > command.date) throw new ErpFinancialsValidationError("Replacement date cannot follow the correction date");
  const { operation, ...business } = command;
  const checksum = createHash("sha256").update(stableJson({ ...business, releases,
    bookId: context.bookId ?? null, currencyCode: context.currencyCode, accountingBasis: context.accountingBasis, postingPolicy: context.postingPolicy,
    actorRef: operation.actorRef, approverRef: operation.approverRef,
    reasonCode: operation.reasonCode, reasonDetail: operation.reasonDetail })).digest("hex");
  const key = `vendor-bill-correction:${command.idempotencyKey}`;
  return context.database.transaction(client => withVendorBillCorrectionSavepoint(client, async () => {
    await lockCustomerPaymentCorrectionSource(client, context.tenantId, context.sourceId);
    await acquireTransactionLock(client, `${key}:${context.tenantId}:${context.companyId}:${context.sourceId}`);
    await assertCompanySourceScope(client, context);
    const original = await loadPostedVendorBillForLifecycle(client, context, command.vendorBillId);
    if (original.currencyCode !== context.currencyCode) throw new ErpFinancialsError("scope_mismatch", "Correction currency differs from the bill");
    const prior = (await client.query(
      `select event_id,aggregate_id,payload from erp_financials.financial_lifecycle_events
where tenant_id=$1 and company_id=$2 and source_id=$3 and idempotency_key=$4`,
      [context.tenantId, context.companyId, context.sourceId, `${key}:completed`])).rows[0];
    if (prior) {
      const payload = storedJson(prior.payload) as { commandChecksum?: string; result?: Omit<CorrectPostedVendorBillResult, "lifecycleEventId" | "status"> } | null;
      if (prior.aggregate_id !== original.documentId || payload?.commandChecksum !== checksum || !payload.result) throw new ErpFinancialsIdempotencyConflictError(command.idempotencyKey);
      return { ...payload.result, status: "already_corrected", lifecycleEventId: storedString(prior.event_id, "event_id") };
    }
    if (original.version !== command.expectedVersion) throw new ErpFinancialsError("optimistic_concurrency_conflict", "Bill changed before correction", { retryable: true });
    if (original.status === "voided") throw new ErpFinancialsError("terminal_state_conflict", "Bill is already voided");
    if (original.paymentHold && releases.some(release => release.reapplyAmount !== "0.00")) throw new ErpFinancialsError("terminal_state_conflict", "A held bill correction cannot authorize a new application; release the hold separately");
    // Query only active applications for this bill; never collect its full history.
    const active = (await client.query(
      `select *,application_date::text as application_date from erp_financials.subledger_applications
where tenant_id=$1 and company_id=$2 and source_id=$3 and target_document_id=$4 and status='applied'
order by subledger_application_id for update`, [context.tenantId, context.companyId, context.sourceId, original.documentId])).rows;
    const byId = new Map(active.map(row => [storedString(row.subledger_application_id, "application_id"), row]));
    if (active.length !== releases.length || releases.some(release => !byId.has(release.applicationId))) throw new ErpFinancialsError("optimistic_concurrency_conflict", "Reviewed release plan must contain every active bill application", { retryable: true });
    const nested = nestedServiceContext(context, client);
    for (const release of releases) {
      const row = byId.get(release.applicationId);
      if (!row) throw new ErpFinancialsValidationError("Missing reviewed application");
      if (row.application_type !== "bill_payment_to_bill" && row.application_type !== "vendor_credit_to_bill") throw new ErpFinancialsError("unsupported_operation", "Bill correction cannot release this application type");
      if (storedInteger(row.version, "application.version") !== release.expectedVersion) throw new ErpFinancialsError("optimistic_concurrency_conflict", "Application changed before correction", { retryable: true });
      if (storedDate(row.application_date, "application_date") > command.date) throw new ErpFinancialsValidationError("Correction cannot precede the released application date");
      const [source] = await loadSubledgerDocumentsForUpdate(client, context, [storedString(row.source_document_id, "source_document_id"), original.documentId]);
      if (storedInteger(source.version, "source.version") !== release.expectedSourceVersion) throw new ErpFinancialsError("optimistic_concurrency_conflict", "Payment or credit changed before correction", { retryable: true });
      if (source.party_id !== original.vendorId || source.currency_code !== original.currencyCode) throw new ErpFinancialsError("scope_mismatch", "Application source differs from the bill vendor or currency");
      const provenance = (await client.query(
        `select book_id from erp_financials.financial_outbox where tenant_id=$1 and company_id=$2 and source_id=$3
and aggregate_id=$4 and event_type='ledger.posted' and idempotency_key=$5 for key share`,
        [context.tenantId, context.companyId, context.sourceId, source.transaction_id,
          `ledger-posted:Subledger:${storedString(source.document_type, "document_type")}:${storedString(source.idempotency_key, "idempotency_key")}`])).rows;
      if (provenance.length !== 1 || storedOptionalString(provenance[0]?.book_id) !== context.bookId) throw new ErpFinancialsError("scope_mismatch", "Application source requires native posting evidence in the correction book");
    }
    if (command.replacement && (await client.query(
      `select 1 from erp_financials.subledger_documents where tenant_id=$1 and company_id=$2 and source_id=$3 and idempotency_key=$4`,
      [context.tenantId, context.companyId, context.sourceId, `${key}:replacement`])).rows.length) throw new ErpFinancialsIdempotencyConflictError(command.idempotencyKey);
    const releasedApplications: SubledgerApplicationResult[] = [];
    for (const release of releases) releasedApplications.push(await endSubledgerApplication(nested, {
      operation, applicationId: release.applicationId, expectedVersion: release.expectedVersion, effectiveDate: command.date
    }, "unapplied"));
    const correction = await runPostedVendorBillLifecycle(nested, command.replacement ? "replaced" : "voided", {
      operation, vendorBillId: command.vendorBillId, expectedVersion: command.expectedVersion + releases.length,
      idempotencyKey: `${key}:document`, date: command.date, ...(command.memo === undefined ? {} : { memo: command.memo }),
      ...(command.replacement ? { replacement: { ...command.replacement, idempotencyKey: `${key}:replacement` } } : {})
    });
    const applications: SubledgerApplicationResult[] = [];
    let replacementPosition: CorrectPostedVendorBillResult["replacementPosition"];
    if (correction.replacement) {
      const replacementId = correction.replacement.documentId;
      if (original.paymentHold) await setVendorBillPaymentHold(nested, { operation, vendorBillId: replacementId,
        expectedVersion: 1, idempotencyKey: `${key}:hold`, paymentHold: true, reason: original.paymentHoldReason ?? "Retained original bill hold" });
      for (const release of releases) {
        if (release.reapplyAmount === "0.00") continue;
        const row = byId.get(release.applicationId);
        if (!row) throw new ErpFinancialsValidationError("Missing released application");
        const sourceId = storedString(row.source_document_id, "source_document_id");
        const [source, target] = await loadSubledgerDocumentsForUpdate(client, context, [sourceId, replacementId]);
        applications.push(await applySubledgerPayment(nested, { operation, idempotencyKey: `${key}:apply:${release.applicationId}`,
          applicationType: row.application_type as "bill_payment_to_bill" | "vendor_credit_to_bill",
          sourceDocumentId: sourceId, targetDocumentId: replacementId, amount: release.reapplyAmount, applicationDate: command.date,
          expectedSourceVersion: storedInteger(source.version, "source.version"), expectedTargetVersion: storedInteger(target.version, "target.version") }));
      }
      const current = await loadSubledgerDocumentByIdempotencyKey(client, context, `${key}:replacement`);
      replacementPosition = { documentId: replacementId, version: storedInteger(current.version, "version"),
        openAmount: storedMoney(current.open_amount, "open_amount"), documentStatus: storedString(current.status, "status") as SubledgerDocumentResult["documentStatus"] };
    }
    const result = { correction, releasedApplications, applications, ...(replacementPosition ? { replacementPosition } : {}) };
    const completion = await appendFinancialLifecycleEvent(client, { tenantId: context.tenantId, companyId: context.companyId, sourceId: context.sourceId,
      aggregateType: "vendor_bill", aggregateId: original.documentId, eventType: "vendor_bill.corrected", idempotencyKey: `${key}:completed`,
      operation, recordedAt: context.now(), payload: JSON.parse(JSON.stringify({ commandChecksum: checksum, result })) as JsonValue });
    await appendServiceOutboxEvent(client, context, { eventType: "vendor_bill.corrected", aggregateType: "vendor_bill", aggregateId: original.documentId,
      idempotencyKey: `${key}:outbox`, payload: { lifecycleEventId: completion.eventId, replacementVendorBillId: correction.replacement?.documentId ?? null } });
    return { ...result, status: "corrected", lifecycleEventId: completion.eventId };
  }));
}

async function runPostedVendorBillLifecycle(
  context: ServiceContext,
  outcome: "voided" | "replaced",
  input: VoidPostedVendorBillInput | ReplacePostedVendorBillInput
): Promise<PostedVendorBillLifecycleResult> {
  input = { ...structuredClone(input), operation: copyFinancialOperation(input.operation) };
  assertFinancialApproval(context, input.operation);
  assertNonEmpty(input.vendorBillId, "vendorBillId");
  assertNonEmpty(input.idempotencyKey, "idempotencyKey");
  assertExpectedSubledgerVersion(input.expectedVersion, "expectedVersion");
  assertIsoDate(input.date, "date");
  if (outcome === "replaced" && !("replacement" in input)) {
    throw new ErpFinancialsValidationError("Replacing a posted vendor bill requires a replacement bill");
  }

  return context.database.transaction(client => withVendorBillCorrectionSavepoint(client, async () => {
    // Applications and database write guards take the source lock before rows.
    // Taking a bill row first can deadlock against an in-flight application.
    await lockCustomerPaymentCorrectionSource(client, context.tenantId, context.sourceId);
    await acquireTransactionLock(
      client,
      `posted-vendor-bill:${context.tenantId}:${context.companyId}:${context.sourceId}:${input.vendorBillId}`
    );
    await assertCompanySourceScope(client, context);
    const original = await loadPostedVendorBillForLifecycle(client, context, input.vendorBillId);
    const reversalInput: PostJournalEntryInput = {
      operation: input.operation,
      idempotencyKey: `${input.idempotencyKey}:reversal`,
      date: input.date,
      memo: input.memo ?? `${outcome} vendor bill ${original.documentId}`,
      currencyCode: original.currencyCode,
      accountingBasis: original.journal.accountingBasis,
      adjustment: true,
      lines: original.journal.lines
    };
    const reversalJournal = normalizeJournalEntry(context, reversalInput);
    const reversalIdentities = journalIdentities(context, reversalJournal);
    const reversalLinkType = outcome === "voided" ? "void" : "reversal";
    const replay = await assertJournalLifecycleSlotAvailable(client, context, {
      originalTransactionId: original.transactionId,
      expectedRelatedTransactionId: reversalIdentities.transactionId,
      expectedLinkType: reversalLinkType,
      competingLinkTypes: ["reversal", "void"]
    });
    assertPostedVendorBillLifecycleState(original, input.expectedVersion, replay);

    await acquireTransactionLock(
      client,
      `journal-entry:${context.tenantId}:${context.sourceId}:${reversalJournal.idempotencyKey}`
    );
    const reversal = await executePostJournalEntryInTransaction(
      client,
      context,
      reversalInput,
      reversalJournal,
      reversalIdentities
    );
    const reversalLink = await appendJournalEntryLink(client, context, {
      originalTransactionId: original.transactionId,
      relatedTransactionId: reversal.transactionId,
      linkType: reversalLinkType,
      eventType: outcome === "voided" ? "vendor_bill.voided" : "vendor_bill.reversed",
      idempotencyKey: `${input.idempotencyKey}:${reversalLinkType}`,
      operation: input.operation,
      allowTransportReplay: true,
      ...(original.journal.postedLifecycleEventId === undefined
        ? {}
        : { priorEventId: original.journal.postedLifecycleEventId })
    });
    const originalVersion = replay
      ? original.version
      : await markPostedVendorBillVoided(client, context, original, input.expectedVersion);

    let replacement: SubledgerDocumentResult | undefined;
    let replacementLink: { readonly linkId: string; readonly eventId: string } | undefined;
    if (outcome === "replaced") {
      const replacementInput = (input as ReplacePostedVendorBillInput).replacement;
      assertReplacementVendorBill(original, replacementInput);
      const nestedContext: ServiceContext = {
        ...context,
        database: { transaction: async <Result>(work: (nestedClient: PostgresQueryClient) => Promise<Result>) => work(client) }
      };
      replacement = await createVendorBill(nestedContext, {
        ...replacementInput,
        operation: input.operation
      });
      await assertJournalLifecycleSlotAvailable(client, context, {
        originalTransactionId: original.transactionId,
        expectedRelatedTransactionId: replacement.journal.transactionId,
        expectedLinkType: "replacement",
        competingLinkTypes: ["correction", "replacement"]
      });
      replacementLink = await appendJournalEntryLink(client, context, {
        originalTransactionId: original.transactionId,
        relatedTransactionId: replacement.journal.transactionId,
        linkType: "replacement",
        eventType: "vendor_bill.replaced",
        idempotencyKey: `${input.idempotencyKey}:replacement`,
        operation: input.operation,
        allowTransportReplay: true,
        priorEventId: reversalLink.eventId
      });
    }

    const lifecycle = await appendFinancialLifecycleEvent(client, {
      tenantId: context.tenantId,
      companyId: context.companyId,
      sourceId: context.sourceId,
      aggregateType: "vendor_bill",
      aggregateId: original.documentId,
      eventType: `vendor_bill.${outcome}`,
      idempotencyKey: `vendor-bill:${input.idempotencyKey}:${outcome}`,
      operation: input.operation,
      recordedAt: context.now(),
      allowTransportReplay: true,
      priorEventId: replacementLink?.eventId ?? reversalLink.eventId,
      payload: {
        originalVendorBillId: original.documentId,
        originalTransactionId: original.transactionId,
        replacementVendorBillId: replacement?.documentId ?? null,
        reversalTransactionId: reversal.transactionId
      }
    });
    await appendServiceOutboxEvent(client, context, {
      eventType: `vendor_bill.${outcome}`,
      aggregateType: "vendor_bill",
      aggregateId: original.documentId,
      idempotencyKey: `vendor-bill:${input.idempotencyKey}:outbox:${outcome}`,
      payload: {
        originalVendorBillId: original.documentId,
        replacementVendorBillId: replacement?.documentId ?? null,
        reversalTransactionId: reversal.transactionId
      }
    });

    return {
      status: replay
        ? outcome === "voided" ? "already_voided" : "already_replaced"
        : outcome,
      outcome,
      originalVendorBillId: original.documentId,
      originalTransactionId: original.transactionId,
      originalVersion,
      reversal,
      ...(replacement === undefined ? {} : { replacement }),
      journalEntryLinkIds: [reversalLink.linkId, ...(replacementLink === undefined ? [] : [replacementLink.linkId])],
      lifecycleEventIds: [
        reversal.lifecycleEventId,
        reversalLink.eventId,
        ...(replacement === undefined ? [] : [replacement.journal.lifecycleEventId]),
        ...(replacementLink === undefined ? [] : [replacementLink.eventId]),
        lifecycle.eventId
      ]
    };
  }));
}

/** A host may bind the SDK to its existing transaction and catch a command error.
 * Roll back the entire correction in that case, including its reversal, original
 * bill transition, replacement and audit/outbox, while preserving prior host work.
 * SAVEPOINT also fails closed if a host accidentally supplies an autocommit client.
 */
async function withVendorBillCorrectionSavepoint<Result>(
  client: PostgresQueryClient,
  work: () => Promise<Result>
): Promise<Result> {
  await client.query("savepoint erp_vendor_bill_correction");
  try {
    const result = await work();
    await client.query("release savepoint erp_vendor_bill_correction");
    return result;
  } catch (error) {
    await client.query("rollback to savepoint erp_vendor_bill_correction");
    await client.query("release savepoint erp_vendor_bill_correction");
    throw error;
  }
}

async function loadPostedVendorBillForLifecycle(
  client: PostgresQueryClient,
  context: ServiceContext,
  documentId: string
): Promise<LoadedPostedVendorBill> {
  const result = await client.query(
    `select *, "document_date"::text as "document_date", "due_date"::text as "due_date" from "erp_financials"."subledger_documents"
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3 and "subledger_document_id" = $4
for update`,
    [context.tenantId, context.companyId, context.sourceId, documentId]
  );
  const row = result.rows[0];
  if (row === undefined || row.document_type !== "vendor_bill") {
    throw new ErpFinancialsError(
      "missing_document",
      `Posted vendor bill ${documentId} does not exist in the write source`,
      { details: { vendorBillId: documentId } }
    );
  }
  const transactionId = storedString(row.transaction_id, "transaction_id");
  // Company/source membership does not establish the posting book. A source
  // can participate in several books; corrections must retain original scope,
  // including replay and legacy callers with no configured book.
  const provenance = await client.query(
    `select "book_id" from "erp_financials"."financial_outbox"
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3
  and "aggregate_id" = $4 and "event_type" = 'ledger.posted' and "idempotency_key" = $5
for key share`,
    [context.tenantId, context.companyId, context.sourceId, transactionId,
      `ledger-posted:${subledgerTransactionType("vendor_bill")}:${storedString(row.idempotency_key, "idempotency_key")}`]
  );
  if (provenance.rows.length !== 1 || storedOptionalString(provenance.rows[0]?.book_id) !== context.bookId) {
    throw new ErpFinancialsError("scope_mismatch", "Vendor bill posting book differs from the correction scope");
  }
  const status = storedString(row.status, "status");
  if (!["open", "partially_applied", "settled", "voided"].includes(status)) {
    throw new Error(`Posted vendor bill ${documentId} has invalid status ${status}`);
  }
  return {
    documentId,
    transactionId,
    vendorId: storedString(row.party_id, "party_id"),
    currencyCode: storedString(row.currency_code, "currency_code"),
    originalAmount: storedMoney(row.original_amount, "original_amount"),
    // PostgreSQL stores the void transition's numeric zero without a decimal scale.
    openAmount: formatMoney(parsePositiveOrZeroMoney(row.open_amount, "open_amount")),
    status: status as LoadedPostedVendorBill["status"],
    version: storedInteger(row.version, "version"),
    paymentHold: row.payment_hold === true,
    paymentHoldReason: storedOptionalString(row.payment_hold_reason) ?? null,
    journal: await loadPostedJournalForLifecycle(
      client,
      context,
      transactionId,
      [subledgerTransactionType("vendor_bill")],
      // Native bill liability is accrual. Cash-recognition postings added by
      // applications are reversed by unapply, never by correcting the bill.
      "accrual"
    )
  };
}

function assertPostedVendorBillLifecycleState(
  bill: LoadedPostedVendorBill,
  expectedVersion: number,
  replay: boolean
): void {
  if (replay) {
    if (bill.status !== "voided") {
      throw new ErpFinancialsError(
        "terminal_state_conflict",
        `Vendor bill ${bill.documentId} has lifecycle links but is not voided`
      );
    }
    // Voiding increments once and is terminal: no hold or application command
    // may advance the original bill afterward. The pre-transition version is
    // part of the original command, including retries of older stored events.
    if (bill.version - 1 !== expectedVersion) {
      throw new ErpFinancialsIdempotencyConflictError(`vendor-bill:${bill.documentId}:expected-version`);
    }
    return;
  }
  if (bill.version !== expectedVersion) {
    throw new ErpFinancialsError(
      "optimistic_concurrency_conflict",
      `Vendor bill expected version ${String(expectedVersion)}, found ${String(bill.version)}`,
      { retryable: true, details: { actualVersion: bill.version, expectedVersion, vendorBillId: bill.documentId } }
    );
  }
  if (bill.status !== "open" || bill.openAmount !== bill.originalAmount) {
    throw new ErpFinancialsError(
      "terminal_state_conflict",
      "An applied or partially applied vendor bill cannot be voided or replaced; unapply it first",
      { details: { status: bill.status, vendorBillId: bill.documentId } }
    );
  }
}

function assertReplacementVendorBill(
  bill: LoadedPostedVendorBill,
  replacement: ReplacePostedVendorBillInput["replacement"]
): void {
  if (replacement.vendorId !== bill.vendorId) {
    throw new ErpFinancialsError(
      "scope_mismatch",
      "A replacement vendor bill must keep the original vendor",
      { details: { actualVendorId: replacement.vendorId, expectedVendorId: bill.vendorId } }
    );
  }
  const currencyCode = replacement.currencyCode ?? bill.currencyCode;
  if (currencyCode !== bill.currencyCode) {
    throw new ErpFinancialsError(
      "currency_not_supported",
      "A replacement vendor bill must keep the original currency",
      { details: { actualCurrencyCode: currencyCode, expectedCurrencyCode: bill.currencyCode } }
    );
  }
}

async function markPostedVendorBillVoided(
  client: PostgresQueryClient,
  context: ServiceContext,
  bill: LoadedPostedVendorBill,
  expectedVersion: number
): Promise<number> {
  await client.query("select set_config('erp_financials.application_balance_update', 'on', true)");
  try {
    const result = await client.query(
      `update "erp_financials"."subledger_documents"
set "open_amount" = 0, "status" = 'voided', "version" = "version" + 1, "updated_at" = $5
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3
  and "subledger_document_id" = $4 and "version" = $6 and "document_type" = 'vendor_bill'
  and "status" = 'open' and "open_amount" = "original_amount"
returning "version"`,
      [context.tenantId, context.companyId, context.sourceId, bill.documentId, context.now(), expectedVersion]
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new ErpFinancialsError(
        "optimistic_concurrency_conflict",
        `Vendor bill ${bill.documentId} changed concurrently`,
        { retryable: true, details: { expectedVersion, vendorBillId: bill.documentId } }
      );
    }
    return storedInteger(row.version, "version");
  } finally {
    await client.query("select set_config('erp_financials.application_balance_update', 'off', true)");
  }
}

type LoadedPostedBillPayment = {
  readonly documentId: string;
  readonly transactionId: string;
  readonly currencyCode: IsoCurrencyCode;
  readonly originalAmount: DecimalString;
  readonly openAmount: DecimalString;
  readonly status: SubledgerDocumentResult["documentStatus"];
  readonly version: number;
  readonly journal: LoadedPostedJournal;
};

/** Completion evidence binds the outer reviewed command, including its original
 * version. Inner unapplication steps may advance the payment version, so that
 * version cannot be reconstructed from the terminal row on a later retry. */
async function withBillPaymentCompletion<Result extends PostedBillPaymentLifecycleResult>(
  client: PostgresQueryClient, context: ServiceContext, input: VoidPostedBillPaymentInput,
  action: "void" | "compensate", work: () => Promise<Result>
): Promise<Result> {
  const { operation, ...business } = input;
  const checksum = createHash("sha256").update(stableJson({ ...business, action,
    bookId: context.bookId ?? null, currencyCode: context.currencyCode, accountingBasis: context.accountingBasis,
    postingPolicy: context.postingPolicy, actorRef: operation.actorRef, approverRef: operation.approverRef,
    reasonCode: operation.reasonCode, reasonDetail: operation.reasonDetail })).digest("hex");
  const key = `bill-payment-completion:${action}:${input.idempotencyKey}`;
  const prior = (await client.query(`select event_id,aggregate_id,payload from erp_financials.financial_lifecycle_events
    where tenant_id=$1 and company_id=$2 and source_id=$3 and idempotency_key=$4`,
  [context.tenantId, context.companyId, context.sourceId, key])).rows[0];
  if (prior) {
    const payload = storedJson(prior.payload) as { commandChecksum?: string; result?: Result } | null;
    if (prior.aggregate_id !== input.billPaymentId || payload?.commandChecksum !== checksum || !payload.result) {
      throw new ErpFinancialsIdempotencyConflictError(input.idempotencyKey);
    }
    return { ...payload.result, status: "already_voided", reversal: { ...payload.result.reversal,
      status: "already_posted", snapshotsMarkedStale: 0,
      writeCounts: { importBatches: 0, transactions: 0, transactionLines: 0, postings: 0 } } };
  }
  const result = await work();
  // Do not manufacture a full command receipt for older terminal history whose
  // original outer version and authorization cannot be proven from that history.
  if (result.status === "voided") await appendFinancialLifecycleEvent(client, {
    tenantId: context.tenantId, companyId: context.companyId, sourceId: context.sourceId,
    aggregateType: "bill_payment", aggregateId: input.billPaymentId, eventType: `bill_payment.${action}_completed`,
    idempotencyKey: key, operation, recordedAt: context.now(),
    payload: JSON.parse(JSON.stringify({ commandChecksum: checksum, result })) as JsonValue
  });
  return result;
}

async function voidAndUnapplyBillPayment(
  context: ServiceContext,
  input: VoidAndUnapplyBillPaymentInput
): Promise<VoidAndUnapplyBillPaymentResult> {
  input = { ...structuredClone(input), operation: copyFinancialOperation(input.operation) };
  assertFinancialApproval(context, input.operation);
  assertNonEmpty(input.billPaymentId, "billPaymentId");
  assertNonEmpty(input.idempotencyKey, "idempotencyKey");
  assertExpectedSubledgerVersion(input.expectedVersion, "expectedVersion");
  assertIsoDate(input.date, "date");
  return context.database.transaction(client => withBillPaymentSavepoint(client, async () => {
    await lockCustomerPaymentCorrectionSource(client, context.tenantId, context.sourceId);
    await acquireTransactionLock(client, billPaymentLifecycleLock(context, input.billPaymentId));
    await assertCompanySourceScope(client, context);
    const disbursement = await loadOptionalBillPaymentInstructionForUpdate(client, context, input.billPaymentId);
    if (disbursement === undefined) await loadPostedBillPaymentForVoid(client, context, input.billPaymentId);
    return withBillPaymentCompletion(client, context, input, "compensate", async () => {
    if (input.expectedReviewToken !== undefined) {
      if (!/^[a-f0-9]{64}$/u.test(input.expectedReviewToken)) throw new ErpFinancialsValidationError("expectedReviewToken must be an SDK review token");
      if (!context.bookId) throw new ErpFinancialsError("scope_mismatch", "Reviewed compensation requires a reporting book");
      const review = await getBillPaymentCorrectionReview({database:{transaction:work=>work(client)},tenantId:context.tenantId,companyId:context.companyId,bookId:context.bookId},
        {sourceId:context.sourceId,paymentId:input.billPaymentId,limit:1});
      if (review.reviewToken !== input.expectedReviewToken) throw new ErpFinancialsError("optimistic_concurrency_conflict", "Payment correction review changed; review the current applications", {retryable:true});
    }
    if (disbursement !== undefined) {
      const status = storedString(disbursement.status, "bill payment status");
      const version = storedInteger(disbursement.version, "bill payment version");
      if (status === "scheduled") {
        throw new ErpFinancialsError(
          "terminal_state_conflict",
          "A scheduled bill payment must be cancelled rather than compensated"
        );
      }
      if (status === "voided") {
        if (version !== input.expectedVersion + 1) {
          throw optimisticBillPaymentConflict(input.billPaymentId, input.expectedVersion, version - 1);
        }
        await billPaymentReplayOperation(
          client,
          context,
          disbursement.voided_event_id,
          `bill-payment:${input.idempotencyKey}:compensated`,
          input.operation
        );
        const terminal = await loadPostedBillPaymentForVoid(client, context, input.billPaymentId);
        const replay = await runPostedBillPaymentVoid(nestedServiceContext(context, client), { ...input, expectedVersion: terminal.version - 1 }, true);
        const replayRows = await loadBillPaymentApplicationsForUpdate(client, context, input.billPaymentId);
        const endedApplications = replayRows.map((row) => {
          const applicationStatus = storedString(row.status, "application status");
          if (applicationStatus !== "unapplied" && applicationStatus !== "voided") {
            throw new ErpFinancialsError(
              "terminal_state_conflict",
              `Compensated bill payment has an application in status ${applicationStatus}`
            );
          }
          return applicationResult(row, applicationStatus);
        });
        return { ...replay, endedApplications, disbursementVersion: version };
      }
      if (version !== input.expectedVersion) {
        throw optimisticBillPaymentConflict(input.billPaymentId, input.expectedVersion, version);
      }
    } else {
      const payment = await loadPostedBillPaymentForVoid(client, context, input.billPaymentId);
      if (payment.status === "voided") {
        throw new ErpFinancialsError("terminal_state_conflict", "Legacy compensated payment lacks a provable outer command receipt; reconcile retained evidence before recovery");
      }
      if (payment.version !== input.expectedVersion) {
        throw optimisticBillPaymentConflict(input.billPaymentId, input.expectedVersion, payment.version);
      }
    }

    const applicationRows = await loadBillPaymentApplicationsForUpdate(client, context, input.billPaymentId);
    const nestedContext = nestedServiceContext(context, client);
    const endedApplications: SubledgerApplicationResult[] = [];
    for (const row of applicationRows) {
      const applicationStatus = storedString(row.status, "application status");
      if (applicationStatus === "applied") {
        endedApplications.push(await endSubledgerApplication(nestedContext, {
          operation: input.operation,
          applicationId: storedString(row.subledger_application_id, "subledger_application_id"),
          effectiveDate: input.date,
          expectedVersion: storedInteger(row.version, "application version")
        }, "voided"));
      } else if (applicationStatus === "unapplied" || applicationStatus === "voided") {
        endedApplications.push(applicationResult(row, applicationStatus));
      } else {
        throw new Error(`Stored bill payment application has invalid status ${applicationStatus}`);
      }
    }
    const openPayment = await loadPostedBillPaymentForVoid(client, context, input.billPaymentId);
    const voided = await runPostedBillPaymentVoid(nestedContext, {
      ...input,
      expectedVersion: openPayment.version
    }, true);
    if (disbursement === undefined) return { ...voided, endedApplications };

    const disbursementVersion = storedInteger(disbursement.version, "bill payment version");
    const lifecycle = await appendFinancialLifecycleEvent(client, {
      tenantId: context.tenantId,
      companyId: context.companyId,
      sourceId: context.sourceId,
      aggregateType: "bill_payment",
      aggregateId: input.billPaymentId,
      eventType: "bill_payment.compensated",
      idempotencyKey: `bill-payment:${input.idempotencyKey}:compensated`,
      operation: input.operation,
      recordedAt: context.now(),
      priorEventId: voided.lifecycleEventIds.at(-1) ?? storedString(disbursement.cleared_event_id, "cleared_event_id"),
      payload: {
        billPaymentId: input.billPaymentId,
        endedApplicationIds: endedApplications.map((application) => application.applicationId),
        reversalTransactionId: voided.reversal.transactionId
      }
    });
    const updated = await client.query(
      `update "erp_financials"."bill_payment_disbursements"
set "status" = 'voided', "version" = "version" + 1, "voided_event_id" = $5, "updated_at" = $6
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3 and "bill_payment_id" = $4
  and "status" = 'cleared' and "version" = $7
returning "version"`,
      [
        context.tenantId,
        context.companyId,
        context.sourceId,
        input.billPaymentId,
        lifecycle.eventId,
        context.now(),
        disbursementVersion
      ]
    );
    const row = updated.rows[0];
    if (row === undefined) {
      throw optimisticBillPaymentConflict(input.billPaymentId, disbursementVersion, disbursementVersion + 1);
    }
    await appendServiceOutboxEvent(client, context, {
      eventType: "bill_payment.compensated",
      aggregateType: "bill_payment",
      aggregateId: input.billPaymentId,
      idempotencyKey: `bill-payment:${input.idempotencyKey}:outbox:compensated`,
      payload: {
        billPaymentId: input.billPaymentId,
        endedApplicationIds: endedApplications.map((application) => application.applicationId),
        reversalTransactionId: voided.reversal.transactionId
      }
    });
    return {
      ...voided,
      endedApplications,
      disbursementVersion: storedInteger(row.version, "bill payment version")
    };
    });
  }));
}

async function loadOptionalBillPaymentInstructionForUpdate(
  client: PostgresQueryClient,
  context: ServiceContext,
  billPaymentId: string
): Promise<Record<string, unknown> | undefined> {
  const result = await client.query(
    `select *, "payment_date"::text as "payment_date" from "erp_financials"."bill_payment_disbursements"
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3 and "bill_payment_id" = $4
for update`,
    [context.tenantId, context.companyId, context.sourceId, billPaymentId]
  );
  const row = result.rows[0];
  if (row !== undefined) await assertBillPaymentInstructionBook(client, context, row);
  return row;
}

async function loadBillPaymentApplicationsForUpdate(
  client: PostgresQueryClient,
  context: ServiceContext,
  billPaymentId: string
): Promise<readonly Record<string, unknown>[]> {
  const result = await client.query(
    `select *, "application_date"::text as "application_date" from "erp_financials"."subledger_applications"
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3
  and "source_document_id" = $4 and "application_type" = 'bill_payment_to_bill'
order by "subledger_applications"."application_date", "subledger_application_id"
for update`,
    [context.tenantId, context.companyId, context.sourceId, billPaymentId]
  );
  return result.rows;
}

async function runPostedBillPaymentVoid(
  context: ServiceContext,
  input: VoidPostedBillPaymentInput,
  compensationOwnsInstruction = false
): Promise<PostedBillPaymentLifecycleResult> {
  input = { ...structuredClone(input), operation: copyFinancialOperation(input.operation) };
  assertFinancialApproval(context, input.operation);
  assertNonEmpty(input.billPaymentId, "billPaymentId");
  assertNonEmpty(input.idempotencyKey, "idempotencyKey");
  assertExpectedSubledgerVersion(input.expectedVersion, "expectedVersion");
  assertIsoDate(input.date, "date");

  return context.database.transaction(client => withBillPaymentSavepoint(client, async () => {
    await lockCustomerPaymentCorrectionSource(client, context.tenantId, context.sourceId);
    await acquireTransactionLock(
      client,
      `posted-bill-payment:${context.tenantId}:${context.companyId}:${context.sourceId}:${input.billPaymentId}`
    );
    await assertCompanySourceScope(client, context);
    const disbursement = compensationOwnsInstruction ? undefined : await loadOptionalBillPaymentInstructionForUpdate(client, context, input.billPaymentId);
    const original = await loadPostedBillPaymentForVoid(client, context, input.billPaymentId);
    return withBillPaymentCompletion(client, context, input, "void", async () => {
    const reversalInput: PostJournalEntryInput = {
      operation: input.operation,
      idempotencyKey: `${input.idempotencyKey}:reversal`,
      date: input.date,
      memo: input.memo ?? `voided bill payment ${original.documentId}`,
      currencyCode: original.currencyCode,
      accountingBasis: original.journal.accountingBasis,
      accountingPolicy: "mirror_cash_and_accrual",
      adjustment: true,
      lines: original.journal.lines
    };
    const reversalJournal = normalizeJournalEntry(context, reversalInput);
    const reversalIdentities = journalIdentities(context, reversalJournal);
    const replay = await assertJournalLifecycleSlotAvailable(client, context, {
      originalTransactionId: original.transactionId,
      expectedRelatedTransactionId: reversalIdentities.transactionId,
      expectedLinkType: "void",
      competingLinkTypes: ["reversal", "void"]
    });
    assertPostedBillPaymentVoidState(original, input.expectedVersion, replay);
    if (replay) return replayLegacyPostedBillPaymentVoid(client, context, input, original, reversalInput);

    await acquireTransactionLock(
      client,
      `journal-entry:${context.tenantId}:${context.sourceId}:${reversalJournal.idempotencyKey}`
    );
    const primaryReversal = await executePostJournalEntryInTransaction(
      client,
      context,
      reversalInput,
      reversalJournal,
      reversalIdentities
    );
    const mirroredReversal = await executeJournalBasisMirror(client, context, reversalInput, reversalJournal);
    const reversal = mirroredReversal === undefined ? primaryReversal : combineJournalResults(primaryReversal, mirroredReversal);
    const reversalLink = await appendJournalEntryLink(client, context, {
      originalTransactionId: original.transactionId,
      relatedTransactionId: reversal.transactionId,
      linkType: "void",
      eventType: "bill_payment.voided",
      idempotencyKey: `${input.idempotencyKey}:void`,
      operation: input.operation,
      ...(original.journal.postedLifecycleEventId === undefined
        ? {}
        : { priorEventId: original.journal.postedLifecycleEventId })
    });
    const originalVersion = await markPostedBillPaymentVoided(client, context, original, input.expectedVersion);
    const lifecycle = await appendFinancialLifecycleEvent(client, {
      tenantId: context.tenantId,
      companyId: context.companyId,
      sourceId: context.sourceId,
      aggregateType: "bill_payment",
      aggregateId: original.documentId,
      eventType: "bill_payment.voided",
      idempotencyKey: `bill-payment:${input.idempotencyKey}:voided`,
      operation: input.operation,
      recordedAt: context.now(),
      priorEventId: reversalLink.eventId,
      payload: {
        originalBillPaymentId: original.documentId,
        originalTransactionId: original.transactionId,
        reversalTransactionId: reversal.transactionId
      }
    });
    // Direct void is also valid after explicit unapplication. Keep its optional
    // instruction in the same terminal state, atomically with the document and
    // reversal. The composite compensation path owns its own instruction event.
    if (disbursement) {
      const version = storedInteger(disbursement.version, "bill payment version");
      if (disbursement.status !== "cleared" || disbursement.subledger_document_id !== original.documentId || !disbursement.cleared_event_id) {
        throw new ErpFinancialsError("terminal_state_conflict", "A posted payment requires its cleared instruction before direct void");
      }
      const updated = await client.query(`update "erp_financials"."bill_payment_disbursements"
        set status='voided',version=version+1,voided_event_id=$5,updated_at=$6
        where tenant_id=$1 and company_id=$2 and source_id=$3 and bill_payment_id=$4 and status='cleared' and version=$7 returning version`,
      [context.tenantId, context.companyId, context.sourceId, original.documentId, lifecycle.eventId, context.now(), version]);
      if (!updated.rows.length) throw optimisticBillPaymentConflict(original.documentId, version, version + 1);
    }
    await appendServiceOutboxEvent(client, context, {
      eventType: "bill_payment.voided",
      aggregateType: "bill_payment",
      aggregateId: original.documentId,
      idempotencyKey: `bill-payment:${input.idempotencyKey}:outbox:voided`,
      payload: {
        originalBillPaymentId: original.documentId,
        reversalTransactionId: reversal.transactionId
      }
    });

    return {
      status: "voided",
      originalBillPaymentId: original.documentId,
      originalTransactionId: original.transactionId,
      originalVersion,
      reversal,
      journalEntryLinkIds: [reversalLink.linkId],
      lifecycleEventIds: [
        reversal.lifecycleEventId,
        reversalLink.eventId,
        lifecycle.eventId
      ]
    };
    });
  }));
}

/** Pre-receipt raw voids retain enough immutable journal/link evidence for a
 * read-only replay. Never repair missing mirrors or audit facts during retry. */
async function replayLegacyPostedBillPaymentVoid(
  client: PostgresQueryClient, context: ServiceContext, input: VoidPostedBillPaymentInput,
  original: LoadedPostedBillPayment, reversalInput: PostJournalEntryInput
): Promise<PostedBillPaymentLifecycleResult> {
  const primary = normalizeJournalEntry(context, reversalInput);
  if (primary.accountingBasis === "modified_cash") throw new ErpFinancialsValidationError("Payment reversal requires cash and accrual evidence");
  const mirror = normalizeJournalEntry(context, { ...reversalInput,
    idempotencyKey: `${reversalInput.idempotencyKey}:accounting-basis:${oppositeAccountingMethod(primary.accountingBasis)}`,
    accountingBasis: oppositeAccountingMethod(primary.accountingBasis), accountingPolicy: "configured_basis_only" });
  const results: PostJournalEntryResult[] = [];
  for (const journal of [primary, mirror]) {
    const identities = journalIdentities(context, journal);
    const existing = await loadExistingJournal(client, context, journal.idempotencyKey, journal.sourceTransactionType);
    if (!existing || existing.status !== "posted" || existing.transactionId !== identities.transactionId
      || sourceRefChecksum(existing.sourcePayloadRef) !== journal.checksum) throw new ErpFinancialsIdempotencyConflictError(input.idempotencyKey);
    const eventKey = `${journal.lifecycleAggregateType}:${journal.sourceTransactionType}:${journal.idempotencyKey}:posted`;
    const event = (await client.query(`select event_id from erp_financials.financial_lifecycle_events
      where tenant_id=$1 and company_id=$2 and source_id=$3 and idempotency_key=$4 and aggregate_id=$5 and event_type=$6`,
    [context.tenantId, context.companyId, context.sourceId, eventKey, identities.transactionId, journal.lifecycleEventType])).rows[0];
    if (!event) throw new ErpFinancialsIdempotencyConflictError(input.idempotencyKey);
    await billPaymentReplayOperation(client, context, event.event_id, eventKey, input.operation);
    const provenance = (await client.query(`select book_id from erp_financials.financial_outbox
      where tenant_id=$1 and company_id=$2 and source_id=$3 and aggregate_id=$4 and event_type='ledger.posted' and idempotency_key=$5`,
    [context.tenantId, context.companyId, context.sourceId, identities.transactionId,
      `ledger-posted:${journal.sourceTransactionType}:${journal.idempotencyKey}`])).rows;
    if (provenance.length !== 1 || storedOptionalString(provenance[0]?.book_id) !== context.bookId) {
      throw new ErpFinancialsError("scope_mismatch", "Payment reversal requires retained posting book evidence");
    }
    results.push(alreadyPostedResult(identities, storedString(event.event_id, "event_id")));
  }
  const [first, second] = results;
  if (!first || !second) throw new ErpFinancialsIdempotencyConflictError(input.idempotencyKey);
  const reversal = combineJournalResults(first, second);
  const link = (await client.query(`select journal_entry_link_id,lifecycle_event_id from erp_financials.journal_entry_links
    where tenant_id=$1 and company_id=$2 and source_id=$3 and original_transaction_id=$4 and related_transaction_id=$5 and link_type='void'`,
  [context.tenantId, context.companyId, context.sourceId, original.transactionId, reversal.transactionId])).rows[0];
  const terminalKey = `bill-payment:${input.idempotencyKey}:voided`;
  const terminal = (await client.query(`select event_id,payload from erp_financials.financial_lifecycle_events
    where tenant_id=$1 and company_id=$2 and source_id=$3 and idempotency_key=$4 and aggregate_id=$5 and event_type='bill_payment.voided'`,
  [context.tenantId, context.companyId, context.sourceId, terminalKey, original.documentId])).rows[0];
  if (!link || !terminal || stableJson(billPaymentReceiptPayload(terminal.payload)) !== stableJson({
    originalBillPaymentId: original.documentId, originalTransactionId: original.transactionId, reversalTransactionId: reversal.transactionId
  })) throw new ErpFinancialsIdempotencyConflictError(input.idempotencyKey);
  await billPaymentReplayOperation(client, context, link.lifecycle_event_id, `journal-lifecycle:${input.idempotencyKey}:void`, input.operation);
  await billPaymentReplayOperation(client, context, terminal.event_id, terminalKey, input.operation);
  return { status: "already_voided", originalBillPaymentId: original.documentId, originalTransactionId: original.transactionId,
    originalVersion: original.version, reversal, journalEntryLinkIds: [storedString(link.journal_entry_link_id, "link_id")],
    lifecycleEventIds: [reversal.lifecycleEventId, storedString(link.lifecycle_event_id, "event_id"), storedString(terminal.event_id, "event_id")] };
}

async function loadPostedBillPaymentForVoid(
  client: PostgresQueryClient,
  context: ServiceContext,
  documentId: string
): Promise<LoadedPostedBillPayment> {
  const result = await client.query(
    `select *, "document_date"::text as "document_date", "due_date"::text as "due_date" from "erp_financials"."subledger_documents"
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3 and "subledger_document_id" = $4
for update`,
    [context.tenantId, context.companyId, context.sourceId, documentId]
  );
  const row = result.rows[0];
  if (row === undefined || row.document_type !== "bill_payment") {
    throw new ErpFinancialsError(
      "missing_document",
      `Posted bill payment ${documentId} does not exist in the write source`,
      { details: { billPaymentId: documentId } }
    );
  }
  const transactionId = storedString(row.transaction_id, "transaction_id");
  const evidence = await client.query(`select book_id from erp_financials.financial_outbox
    where tenant_id=$1 and company_id=$2 and source_id=$3 and aggregate_id=$4
      and event_type='ledger.posted' and idempotency_key=$5 for key share`,
  [context.tenantId, context.companyId, context.sourceId, transactionId,
    `ledger-posted:${subledgerTransactionType("bill_payment")}:${storedString(row.idempotency_key, "idempotency_key")}`]);
  if (evidence.rows.length !== 1 || storedOptionalString(evidence.rows[0]?.book_id) !== context.bookId) {
    throw new ErpFinancialsError("scope_mismatch", "Bill payment posting book differs from the command scope");
  }
  const status = storedString(row.status, "status");
  if (!["open", "partially_applied", "settled", "voided"].includes(status)) {
    throw new Error(`Posted bill payment ${documentId} has invalid status ${status}`);
  }
  return {
    documentId,
    transactionId,
    currencyCode: storedString(row.currency_code, "currency_code"),
    originalAmount: storedMoney(row.original_amount, "original_amount"),
    openAmount: storedMoney(row.open_amount, "open_amount"),
    status: status as LoadedPostedBillPayment["status"],
    version: storedInteger(row.version, "version"),
    journal: await loadPostedJournalForLifecycle(
      client,
      context,
      transactionId,
      [subledgerTransactionType("bill_payment")]
    )
  };
}

function assertPostedBillPaymentVoidState(
  payment: LoadedPostedBillPayment,
  expectedVersion: number,
  replay: boolean
): void {
  if (replay) {
    if (payment.status !== "voided") {
      throw new ErpFinancialsError(
        "terminal_state_conflict",
        `Bill payment ${payment.documentId} has lifecycle links but is not voided`
      );
    }
    if (payment.version !== expectedVersion + 1) throw optimisticBillPaymentConflict(payment.documentId, expectedVersion, payment.version - 1);
    return;
  }
  if (payment.version !== expectedVersion) {
    throw new ErpFinancialsError(
      "optimistic_concurrency_conflict",
      `Bill payment expected version ${String(expectedVersion)}, found ${String(payment.version)}`,
      {
        retryable: true,
        details: { actualVersion: payment.version, billPaymentId: payment.documentId, expectedVersion }
      }
    );
  }
  if (payment.status !== "open" || payment.openAmount !== payment.originalAmount) {
    throw new ErpFinancialsError(
      "terminal_state_conflict",
      "An applied or partially applied bill payment cannot be voided; unapply it first",
      { details: { billPaymentId: payment.documentId, status: payment.status } }
    );
  }
}

async function markPostedBillPaymentVoided(
  client: PostgresQueryClient,
  context: ServiceContext,
  payment: LoadedPostedBillPayment,
  expectedVersion: number
): Promise<number> {
  await client.query("select set_config('erp_financials.application_balance_update', 'on', true)");
  try {
    const result = await client.query(
      `update "erp_financials"."subledger_documents"
set "open_amount" = 0, "status" = 'voided', "version" = "version" + 1, "updated_at" = $5
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3
  and "subledger_document_id" = $4 and "version" = $6 and "document_type" = 'bill_payment'
  and "status" = 'open' and "open_amount" = "original_amount"
returning "version"`,
      [context.tenantId, context.companyId, context.sourceId, payment.documentId, context.now(), expectedVersion]
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new ErpFinancialsError(
        "optimistic_concurrency_conflict",
        `Bill payment ${payment.documentId} changed concurrently`,
        { retryable: true, details: { billPaymentId: payment.documentId, expectedVersion } }
      );
    }
    return storedInteger(row.version, "version");
  } finally {
    await client.query("select set_config('erp_financials.application_balance_update', 'off', true)");
  }
}

type LoadedIssuedAdjustment = {
  readonly documentId: string;
  readonly documentType: "credit_memo" | "refund" | "write_off";
  readonly transactionId: string;
  readonly partyId: string;
  readonly currencyCode: IsoCurrencyCode;
  readonly originalAmount: DecimalString;
  readonly openAmount: DecimalString;
  readonly status: SubledgerDocumentResult["documentStatus"];
  readonly version: number;
  readonly relatedInvoiceId?: string;
  readonly journal: LoadedPostedJournal;
};

async function runIssuedAdjustmentLifecycle(
  context: ServiceContext,
  outcome: "voided" | "replaced",
  input: VoidIssuedAdjustmentInput | ReplaceIssuedAdjustmentInput
): Promise<IssuedAdjustmentLifecycleResult> {
  assertFinancialApproval(context, input.operation);
  assertNonEmpty(input.adjustmentDocumentId, "adjustmentDocumentId");
  assertNonEmpty(input.idempotencyKey, "idempotencyKey");
  assertExpectedSubledgerVersion(input.expectedVersion, "expectedVersion");
  assertIsoDate(input.date, "date");
  if (outcome === "replaced" && !("replacement" in input)) {
    throw new ErpFinancialsValidationError("Replacing an issued adjustment requires a replacement document");
  }

  return context.database.transaction(async (client) => {
    await acquireTransactionLock(
      client,
      `issued-adjustment:${context.tenantId}:${context.companyId}:${context.sourceId}:${input.adjustmentDocumentId}`
    );
    await assertCompanySourceScope(client, context);
    const original = await loadIssuedAdjustmentForLifecycle(client, context, input.adjustmentDocumentId);
    assertIssuedAdjustmentType(original, input.adjustmentType);

    const reversalInput: PostJournalEntryInput = {
      operation: input.operation,
      idempotencyKey: `${input.idempotencyKey}:reversal`,
      date: input.date,
      memo: input.memo ?? `${outcome} ${original.documentId}`,
      currencyCode: original.currencyCode,
      accountingBasis: original.journal.accountingBasis,
      ...(original.documentType === "refund" ? { accountingPolicy: "mirror_cash_and_accrual" as const } : {}),
      adjustment: true,
      lines: original.journal.lines
    };
    const reversalJournal = normalizeJournalEntry(context, reversalInput);
    const reversalIdentities = journalIdentities(context, reversalJournal);
    const reversalLinkType = outcome === "voided" ? "void" : "reversal";
    const replay = await assertJournalLifecycleSlotAvailable(client, context, {
      originalTransactionId: original.transactionId,
      expectedRelatedTransactionId: reversalIdentities.transactionId,
      expectedLinkType: reversalLinkType,
      competingLinkTypes: ["reversal", "void"]
    });
    assertIssuedAdjustmentLifecycleState(original, input.expectedVersion, replay);

    await acquireTransactionLock(
      client,
      `journal-entry:${context.tenantId}:${context.sourceId}:${reversalJournal.idempotencyKey}`
    );
    const primaryReversal = await executePostJournalEntryInTransaction(
      client,
      context,
      reversalInput,
      reversalJournal,
      reversalIdentities
    );
    const mirroredReversal = await executeJournalBasisMirror(client, context, reversalInput, reversalJournal);
    const reversal = mirroredReversal === undefined ? primaryReversal : combineJournalResults(primaryReversal, mirroredReversal);
    if (original.documentType === "refund" && original.relatedInvoiceId !== undefined) {
      await persistCashBasisApplicationProjection(client, context, {
        action: "recognize",
        applicationId: `refund:${original.documentId}`,
        applicationType: "customer_refund_against_invoice",
        appliedAmount: original.originalAmount,
        effectiveDate: input.date,
        targetTransactionId: await loadSubledgerDocumentTransactionId(client, context, original.relatedInvoiceId)
      });
    }
    const reversalLink = await appendJournalEntryLink(client, context, {
      originalTransactionId: original.transactionId,
      relatedTransactionId: reversal.transactionId,
      linkType: reversalLinkType,
      eventType: outcome === "voided" ? "issued_adjustment.voided" : "issued_adjustment.reversed",
      idempotencyKey: `${input.idempotencyKey}:${reversalLinkType}`,
      operation: input.operation,
      ...(original.journal.postedLifecycleEventId === undefined
        ? {}
        : { priorEventId: original.journal.postedLifecycleEventId })
    });
    const originalVersion = replay
      ? original.version
      : await markIssuedAdjustmentVoided(client, context, original, input.expectedVersion);

    let replacement: SubledgerDocumentResult | undefined;
    let replacementLink: { readonly linkId: string; readonly eventId: string } | undefined;
    if (outcome === "replaced") {
      const replacementInput = (input as ReplaceIssuedAdjustmentInput).replacement;
      const replacementPartyId = input.adjustmentType === "write_off"
        ? (replacementInput as ReplaceIssuedWriteOffInput["replacement"]).partyId
        : (replacementInput as ReplaceIssuedCreditMemoInput["replacement"] | ReplaceIssuedRefundInput["replacement"]).customerId;
      assertReplacementAdjustmentParty(original, replacementPartyId);
      const nestedContext: ServiceContext = {
        ...context,
        database: { transaction: async <Result>(work: (nestedClient: PostgresQueryClient) => Promise<Result>) => work(client) }
      };
      replacement = input.adjustmentType === "credit"
        ? await issueCreditMemo(nestedContext, {
            ...(replacementInput as ReplaceIssuedCreditMemoInput["replacement"]),
            operation: input.operation
          })
        : input.adjustmentType === "refund" ? await issueRefund(nestedContext, {
            ...(replacementInput as ReplaceIssuedRefundInput["replacement"]),
            operation: input.operation
          }) : await recordWriteOff(nestedContext, {
            ...(replacementInput as ReplaceIssuedWriteOffInput["replacement"]),
            operation: input.operation
          });
      await assertJournalLifecycleSlotAvailable(client, context, {
        originalTransactionId: original.transactionId,
        expectedRelatedTransactionId: replacement.journal.transactionId,
        expectedLinkType: "replacement",
        competingLinkTypes: ["correction", "replacement"]
      });
      replacementLink = await appendJournalEntryLink(client, context, {
        originalTransactionId: original.transactionId,
        relatedTransactionId: replacement.journal.transactionId,
        linkType: "replacement",
        eventType: "issued_adjustment.replaced",
        idempotencyKey: `${input.idempotencyKey}:replacement`,
        operation: input.operation,
        priorEventId: reversalLink.eventId
      });
    }

    const lifecycle = await appendFinancialLifecycleEvent(client, {
      tenantId: context.tenantId,
      companyId: context.companyId,
      sourceId: context.sourceId,
      aggregateType: "issued_adjustment",
      aggregateId: original.documentId,
      eventType: `issued_adjustment.${outcome}`,
      idempotencyKey: `issued-adjustment:${input.idempotencyKey}:${outcome}`,
      operation: input.operation,
      recordedAt: context.now(),
      priorEventId: replacementLink?.eventId ?? reversalLink.eventId,
      payload: {
        adjustmentType: input.adjustmentType,
        originalDocumentId: original.documentId,
        originalTransactionId: original.transactionId,
        replacementDocumentId: replacement?.documentId ?? null,
        reversalTransactionId: reversal.transactionId
      }
    });
    await appendServiceOutboxEvent(client, context, {
      eventType: `issued_adjustment.${outcome}`,
      aggregateType: "issued_adjustment",
      aggregateId: original.documentId,
      idempotencyKey: `issued-adjustment:${input.idempotencyKey}:outbox:${outcome}`,
      payload: {
        adjustmentType: input.adjustmentType,
        originalDocumentId: original.documentId,
        replacementDocumentId: replacement?.documentId ?? null,
        reversalTransactionId: reversal.transactionId
      }
    });

    return {
      status: replay
        ? outcome === "voided" ? "already_voided" : "already_replaced"
        : outcome,
      outcome,
      adjustmentType: input.adjustmentType,
      originalAdjustmentDocumentId: original.documentId,
      originalTransactionId: original.transactionId,
      originalVersion,
      reversal,
      ...(replacement === undefined ? {} : { replacement }),
      journalEntryLinkIds: [reversalLink.linkId, ...(replacementLink === undefined ? [] : [replacementLink.linkId])],
      lifecycleEventIds: [
        reversal.lifecycleEventId,
        reversalLink.eventId,
        ...(replacement === undefined ? [] : [replacement.journal.lifecycleEventId]),
        ...(replacementLink === undefined ? [] : [replacementLink.eventId]),
        lifecycle.eventId
      ]
    };
  });
}

async function loadIssuedAdjustmentForLifecycle(
  client: PostgresQueryClient,
  context: ServiceContext,
  documentId: string
): Promise<LoadedIssuedAdjustment> {
  const result = await client.query(
    `select *, "document_date"::text as "document_date", "due_date"::text as "due_date" from "erp_financials"."subledger_documents"
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3 and "subledger_document_id" = $4
for update`,
    [context.tenantId, context.companyId, context.sourceId, documentId]
  );
  const row = result.rows[0];
  if (row === undefined || !["credit_memo", "refund", "write_off"].includes(String(row.document_type))) {
    throw new ErpFinancialsError(
      "missing_document",
      `Issued adjustment ${documentId} does not exist in the write source`,
      { details: { adjustmentDocumentId: documentId } }
    );
  }
  const documentType = row.document_type as LoadedIssuedAdjustment["documentType"];
  const transactionId = storedString(row.transaction_id, "transaction_id");
  const journal = await loadPostedJournalForLifecycle(
    client,
    context,
    transactionId,
    [subledgerTransactionType(documentType)]
  );
  const status = storedString(row.status, "status");
  if (!new Set(["open", "partially_applied", "settled", "voided"]).has(status)) {
    throw new Error(`Issued adjustment ${documentId} has invalid status ${status}`);
  }
  const metadata = storedJson(row.metadata);
  if (metadata !== null && typeof metadata === "object" && "customerPaymentReturn" in metadata) {
    throw new ErpFinancialsError("terminal_state_conflict", "A receipt cash return requires an explicit compensating cash fact; generic adjustment void/replace is not allowed");
  }
  const refundProvenance = metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Readonly<Record<string, JsonValue>>).refundProvenance
    : undefined;
  const relatedInvoiceId = refundProvenance !== null && typeof refundProvenance === "object" && !Array.isArray(refundProvenance)
    ? (refundProvenance as Readonly<Record<string, JsonValue>>).relatedInvoiceId
    : undefined;
  return {
    documentId,
    documentType,
    transactionId,
    partyId: storedString(row.party_id, "party_id"),
    currencyCode: storedString(row.currency_code, "currency_code"),
    originalAmount: storedMoney(row.original_amount, "original_amount"),
    openAmount: storedMoney(row.open_amount, "open_amount"),
    status: status as LoadedIssuedAdjustment["status"],
    version: storedInteger(row.version, "version"),
    ...(typeof relatedInvoiceId === "string" ? { relatedInvoiceId } : {}),
    journal
  };
}

function assertIssuedAdjustmentType(
  adjustment: LoadedIssuedAdjustment,
  expectedType: IssuedAdjustmentType
): void {
  const actualType: IssuedAdjustmentType = adjustment.documentType === "credit_memo"
    ? "credit"
    : adjustment.documentType === "refund" ? "refund" : "write_off";
  if (actualType !== expectedType) {
    throw new ErpFinancialsError(
      "invalid_input",
      `Issued adjustment ${adjustment.documentId} is a ${actualType}, not a ${expectedType}`,
      { details: { actualType, adjustmentDocumentId: adjustment.documentId, expectedType } }
    );
  }
}

function assertIssuedAdjustmentLifecycleState(
  adjustment: LoadedIssuedAdjustment,
  expectedVersion: number,
  replay: boolean
): void {
  if (replay) {
    if (adjustment.status !== "voided") {
      throw new ErpFinancialsError(
        "terminal_state_conflict",
        `Issued adjustment ${adjustment.documentId} has lifecycle links but is not voided`
      );
    }
    return;
  }
  if (adjustment.version !== expectedVersion) {
    throw new ErpFinancialsError(
      "optimistic_concurrency_conflict",
      `Issued adjustment expected version ${String(expectedVersion)}, found ${String(adjustment.version)}`,
      { retryable: true, details: { actualVersion: adjustment.version, expectedVersion } }
    );
  }
  const canEnd = adjustment.documentType === "credit_memo"
    ? adjustment.status === "open" && adjustment.openAmount === adjustment.originalAmount
    : adjustment.status === "settled" && adjustment.openAmount === "0.00";
  if (!canEnd) {
    throw new ErpFinancialsError(
      "terminal_state_conflict",
      adjustment.documentType === "credit_memo"
        ? "An applied or partially applied credit cannot be voided or replaced; unapply it first"
        : `Refund ${adjustment.documentId} is already in terminal status ${adjustment.status}`
    );
  }
}

function assertReplacementAdjustmentParty(adjustment: LoadedIssuedAdjustment, customerId: string): void {
  if (customerId !== adjustment.partyId) {
    throw new ErpFinancialsError(
      "scope_mismatch",
      "A replacement adjustment must keep the original customer",
      { details: { actualCustomerId: customerId, expectedCustomerId: adjustment.partyId } }
    );
  }
}

async function markIssuedAdjustmentVoided(
  client: PostgresQueryClient,
  context: ServiceContext,
  adjustment: LoadedIssuedAdjustment,
  expectedVersion: number
): Promise<number> {
  await client.query("select set_config('erp_financials.application_balance_update', 'on', true)");
  try {
    const result = await client.query(
      `update "erp_financials"."subledger_documents"
set "open_amount" = 0, "status" = 'voided', "version" = "version" + 1, "updated_at" = $5
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3
  and "subledger_document_id" = $4 and "version" = $6
  and (("document_type" = 'credit_memo' and "status" = 'open' and "open_amount" = "original_amount")
    or ("document_type" in ('refund', 'write_off') and "status" = 'settled' and "open_amount" = 0))
returning "version"`,
      [context.tenantId, context.companyId, context.sourceId, adjustment.documentId, context.now(), expectedVersion]
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new ErpFinancialsError(
        "optimistic_concurrency_conflict",
        `Issued adjustment ${adjustment.documentId} changed concurrently`,
        { retryable: true, details: { adjustmentDocumentId: adjustment.documentId, expectedVersion } }
      );
    }
    return storedInteger(row.version, "version");
  } finally {
    await client.query("select set_config('erp_financials.application_balance_update', 'off', true)");
  }
}

async function runJournalLifecycleWorkflow(
  context: ServiceContext,
  outcome: JournalEntryLifecycleResult["outcome"],
  input: ReverseJournalEntryInput | ReplaceJournalEntryInput,
  routing?: { readonly allowedSourceTypes: readonly string[]; readonly priorEventId: string }
): Promise<JournalEntryLifecycleResult> {
  assertFinancialApproval(context, input.operation);
  assertNonEmpty(input.originalTransactionId, "originalTransactionId");
  assertNonEmpty(input.idempotencyKey, "idempotencyKey");
  assertIsoDate(input.date, "date");
  if ((outcome === "corrected" || outcome === "replaced") && !("replacement" in input)) {
    throw new ErpFinancialsValidationError(`${outcome} journal workflow requires a replacement journal`);
  }

  return context.database.transaction(async (client) => {
    await lockCustomerPaymentCorrectionSource(client, context.tenantId, context.sourceId);
    await acquireTransactionLock(
      client,
      `journal-lifecycle:${context.tenantId}:${context.sourceId}:${input.originalTransactionId}`
    );
    await assertCompanySourceScope(client, context);
    const original = await loadPostedJournalForLifecycle(client, context, input.originalTransactionId, routing?.allowedSourceTypes);
    const reversalInput: PostJournalEntryInput = {
      operation: input.operation,
      idempotencyKey: `${input.idempotencyKey}:reversal`,
      date: input.date,
      memo: input.memo ?? `${outcome} ${original.transactionId}`,
      currencyCode: original.currencyCode,
      accountingBasis: original.accountingBasis,
      accountingPolicy: original.accountingPolicy,
      adjustment: true,
      lines: original.lines
    };
    const reversalJournal = normalizeJournalEntry(context, reversalInput);
    const reversalIdentities = journalIdentities(context, reversalJournal);
    const reversalLinkType = outcome === "voided" ? "void" : "reversal";
    await assertJournalLifecycleSlotAvailable(client, context, {
      originalTransactionId: original.transactionId,
      expectedRelatedTransactionId: reversalIdentities.transactionId,
      expectedLinkType: reversalLinkType,
      competingLinkTypes: ["reversal", "void"]
    });
    await acquireTransactionLock(
      client,
      `journal-entry:${context.tenantId}:${context.sourceId}:${reversalJournal.idempotencyKey}`
    );
    const primaryReversal = await executePostJournalEntryInTransaction(
      client,
      context,
      reversalInput,
      reversalJournal,
      reversalIdentities
    );
    const mirroredReversal = await executeJournalBasisMirror(client, context, reversalInput, reversalJournal);
    const reversal = mirroredReversal === undefined ? primaryReversal : combineJournalResults(primaryReversal, mirroredReversal);
    const priorEventId = routing?.priorEventId ?? original.postedLifecycleEventId;
    const reversalLink = await appendJournalEntryLink(client, context, {
      originalTransactionId: original.transactionId,
      relatedTransactionId: reversal.transactionId,
      linkType: reversalLinkType,
      eventType: outcome === "voided" ? "journal_entry.voided" : "journal_entry.reversed",
      idempotencyKey: `${input.idempotencyKey}:${reversalLinkType}`,
      operation: input.operation,
      ...(priorEventId === undefined ? {} : { priorEventId })
    });

    if (outcome !== "corrected" && outcome !== "replaced") {
      return {
        outcome,
        originalTransactionId: original.transactionId,
        reversal,
        journalEntryLinkIds: [reversalLink.linkId],
        lifecycleEventIds: [reversal.lifecycleEventId, reversalLink.eventId]
      };
    }

    const replacementDefinition = (input as ReplaceJournalEntryInput).replacement;
    const replacementInput: PostJournalEntryInput = {
      ...replacementDefinition,
      operation: input.operation,
      adjustment: true
    };
    const replacementJournal = normalizeJournalEntry(context, replacementInput);
    const replacementIdentities = journalIdentities(context, replacementJournal);
    const replacementLinkType = outcome === "corrected" ? "correction" : "replacement";
    await assertJournalLifecycleSlotAvailable(client, context, {
      originalTransactionId: original.transactionId,
      expectedRelatedTransactionId: replacementIdentities.transactionId,
      expectedLinkType: replacementLinkType,
      competingLinkTypes: ["correction", "replacement"]
    });
    await acquireTransactionLock(
      client,
      `journal-entry:${context.tenantId}:${context.sourceId}:${replacementJournal.idempotencyKey}`
    );
    const primaryReplacement = await executePostJournalEntryInTransaction(
      client,
      context,
      replacementInput,
      replacementJournal,
      replacementIdentities
    );
    const mirroredReplacement = await executeJournalBasisMirror(client, context, replacementInput, replacementJournal);
    const replacement = mirroredReplacement === undefined
      ? primaryReplacement
      : combineJournalResults(primaryReplacement, mirroredReplacement);
    const replacementLink = await appendJournalEntryLink(client, context, {
      originalTransactionId: original.transactionId,
      relatedTransactionId: replacement.transactionId,
      linkType: replacementLinkType,
      eventType: outcome === "corrected" ? "journal_entry.corrected" : "journal_entry.replaced",
      idempotencyKey: `${input.idempotencyKey}:${replacementLinkType}`,
      operation: input.operation,
      priorEventId: reversalLink.eventId
    });

    return {
      outcome,
      originalTransactionId: original.transactionId,
      reversal,
      replacement,
      journalEntryLinkIds: [reversalLink.linkId, replacementLink.linkId],
      lifecycleEventIds: [
        reversal.lifecycleEventId,
        reversalLink.eventId,
        replacement.lifecycleEventId,
        replacementLink.eventId
      ]
    };
  });
}

async function assertJournalLifecycleSlotAvailable(
  client: PostgresQueryClient,
  context: ServiceContext,
  input: {
    readonly originalTransactionId: string;
    readonly expectedRelatedTransactionId: string;
    readonly expectedLinkType: "reversal" | "void" | "correction" | "replacement";
    readonly competingLinkTypes: readonly ("reversal" | "void" | "correction" | "replacement")[];
  }
): Promise<boolean> {
  const result = await client.query(
    `select "related_transaction_id", "link_type"
from "erp_financials"."journal_entry_links"
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3 and "original_transaction_id" = $4
  and "link_type" = any($5::text[])
for key share`,
    [context.tenantId, context.companyId, context.sourceId, input.originalTransactionId, input.competingLinkTypes]
  );
  const existing = result.rows[0];
  if (existing === undefined) {
    return false;
  }
  const existingRelatedTransactionId = storedString(existing.related_transaction_id, "related_transaction_id");
  const existingLinkType = storedString(existing.link_type, "link_type");
  if (
    existingRelatedTransactionId !== input.expectedRelatedTransactionId ||
    existingLinkType !== input.expectedLinkType
  ) {
    throw new ErpFinancialsValidationError(
      `Journal entry ${input.originalTransactionId} already has a terminal ${existingLinkType} workflow`
    );
  }
  return true;
}

async function loadPostedJournalForLifecycle(
  client: PostgresQueryClient,
  context: ServiceContext,
  transactionId: string,
  allowedSourceTypes: readonly string[] = ["JournalEntry", "JournalEntryAdjustment"],
  accountingBasisFilter?: AccountingBasis
): Promise<LoadedPostedJournal> {
  const result = await client.query(
    `select transactions."transaction_id", transactions."source_transaction_type", transactions."status", transactions."memo", transactions."source_payload_ref",
  postings."posting_id", postings."account_id", postings."party_id", postings."item_id",
  postings."debit_amount", postings."credit_amount", postings."currency_code", postings."accounting_basis", postings."dimension_refs"
from "erp_financials"."transactions" transactions
join "erp_financials"."ledger_postings" postings
  on postings."tenant_id" = transactions."tenant_id"
 and postings."source_id" = transactions."source_id"
 and postings."transaction_id" = transactions."transaction_id"
where transactions."tenant_id" = $1 and transactions."source_id" = $2 and transactions."transaction_id" = $3
  and ($4::text is null or postings."accounting_basis" = $4)
order by postings."posting_id"
for update of transactions, postings`,
    [context.tenantId, context.sourceId, transactionId, accountingBasisFilter ?? null]
  );
  if (result.rows.length < 2) {
    throw new ErpFinancialsValidationError(`Posted journal ${transactionId} does not exist or has insufficient postings`);
  }
  const first = result.rows[0];
  if (first === undefined) {
    throw new Error("Posted journal query returned no first row");
  }
  const sourceType = storedString(first.source_transaction_type, "source_transaction_type");
  if (!allowedSourceTypes.includes(sourceType)) {
    throw new ErpFinancialsValidationError(`Transaction ${transactionId} is not an allowed lifecycle journal`);
  }
  if (storedString(first.status, "status") !== "posted") {
    throw new ErpFinancialsValidationError(`Journal entry ${transactionId} is not posted`);
  }
  const currencyCode = storedString(first.currency_code, "currency_code");
  const accountingBasis = storedString(first.accounting_basis, "accounting_basis") as AccountingBasis;
  assertAccountingBasis(accountingBasis);
  const lines = result.rows.map((row): PostJournalEntryLineInput => {
    if (
      storedString(row.currency_code, "currency_code") !== currencyCode ||
      storedString(row.accounting_basis, "accounting_basis") !== accountingBasis
    ) {
      throw new ErpFinancialsValidationError(`Journal entry ${transactionId} has mixed currency or accounting basis`);
    }
    const debit = storedMoney(row.debit_amount, "debit_amount");
    const credit = storedMoney(row.credit_amount, "credit_amount");
    const partyId = storedOptionalString(row.party_id);
    const itemId = storedOptionalString(row.item_id);
    const common = {
      accountId: storedString(row.account_id, "account_id"),
      lineId: storedString(row.posting_id, "posting_id"),
      ...(partyId === undefined ? {} : { partyId }),
      ...(itemId === undefined ? {} : { itemId }),
      dimensionRefs: storedDimensionRefs(row.dimension_refs)
    };
    if (debit !== "0.00" && credit === "0.00") {
      return { ...common, credit: debit };
    }
    if (credit !== "0.00" && debit === "0.00") {
      return { ...common, debit: credit };
    }
    throw new ErpFinancialsValidationError(`Journal entry ${transactionId} contains a non-single-sided posting`);
  });
  const postedLifecycleEventId = await loadPostedJournalLifecycleEventId(client, context, transactionId);
  const memo = storedOptionalString(first.memo);
  return {
    transactionId,
    ...(memo === undefined ? {} : { memo }),
    currencyCode,
    accountingBasis,
    accountingPolicy: storedJournalAccountingPolicy(first.source_payload_ref),
    lines,
    ...(postedLifecycleEventId === undefined ? {} : { postedLifecycleEventId })
  };
}

async function loadPostedJournalLifecycleEventId(
  client: PostgresQueryClient,
  context: ServiceContext,
  transactionId: string
): Promise<string | undefined> {
  const result = await client.query(
    `select "event_id"
from "erp_financials"."financial_lifecycle_events"
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3
  and "aggregate_type" = 'journal_entry' and "aggregate_id" = $4
  and "event_type" in ('journal_entry.posted', 'journal_entry.adjustment_posted')
order by "occurred_at", "event_id"
limit 1
for key share`,
    [context.tenantId, context.companyId, context.sourceId, transactionId]
  );
  return storedOptionalString(result.rows[0]?.event_id);
}

async function appendJournalEntryLink(
  client: PostgresQueryClient,
  context: ServiceContext,
  input: {
    readonly originalTransactionId: string;
    readonly relatedTransactionId: string;
    readonly linkType: "reversal" | "void" | "correction" | "replacement";
    readonly eventType: string;
    readonly idempotencyKey: string;
    readonly operation: FinancialOperationContext;
    readonly priorEventId?: string;
    readonly allowTransportReplay?: boolean;
  }
): Promise<{ readonly linkId: string; readonly eventId: string }> {
  const linkId = scopedRecordId(
    context,
    "journal_entry_link",
    `${input.originalTransactionId}:${input.relatedTransactionId}:${input.linkType}`
  );
  const lifecycle = await appendFinancialLifecycleEvent(client, {
    tenantId: context.tenantId,
    companyId: context.companyId,
    sourceId: context.sourceId,
    aggregateType: "journal_entry",
    aggregateId: input.originalTransactionId,
    eventType: input.eventType,
    idempotencyKey: `journal-lifecycle:${input.idempotencyKey}`,
    operation: input.operation,
    recordedAt: context.now(),
    ...(input.allowTransportReplay === true ? { allowTransportReplay: true } : {}),
    ...(input.priorEventId === undefined ? {} : { priorEventId: input.priorEventId }),
    payload: {
      linkType: input.linkType,
      originalTransactionId: input.originalTransactionId,
      relatedTransactionId: input.relatedTransactionId
    }
  });
  await client.query(
    `insert into "erp_financials"."journal_entry_links" (
  "journal_entry_link_id", "tenant_id", "company_id", "source_id", "original_transaction_id",
  "related_transaction_id", "link_type", "lifecycle_event_id", "created_at"
) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
on conflict ("tenant_id", "company_id", "source_id", "original_transaction_id", "related_transaction_id", "link_type") do nothing`,
    [
      linkId,
      context.tenantId,
      context.companyId,
      context.sourceId,
      input.originalTransactionId,
      input.relatedTransactionId,
      input.linkType,
      lifecycle.eventId,
      context.now()
    ]
  );
  return { linkId, eventId: lifecycle.eventId };
}

function storedString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Stored journal field ${field} must be a non-empty string`);
  }
  return value;
}

function storedOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function storedMoney(value: unknown, field: string): DecimalString {
  const money = typeof value === "number" ? value.toFixed(2) : storedString(value, field);
  if (!/^-?\d+(?:\.\d{1,2})?$/u.test(money)) {
    throw new Error(`Stored journal field ${field} must be fixed-scale money`);
  }
  const [whole, fraction = ""] = money.split(".");
  return `${whole ?? "0"}.${fraction.padEnd(2, "0")}`;
}

function storedDate(value: unknown, field: string): IsoDate {
  const date = value instanceof Date ? value.toISOString().slice(0, 10) : storedString(value, field);
  assertIsoDate(date, field);
  return date;
}

function storedOptionalDate(value: unknown, field: string): IsoDate | undefined {
  return value === undefined || value === null ? undefined : storedDate(value, field);
}

function storedDimensionRefs(value: unknown): readonly DimensionRef[] {
  const parsed = typeof value === "string" ? parseJson(value) : value;
  if (!Array.isArray(parsed)) {
    return [];
  }
  if (!parsed.every(isStoredDimensionRef)) {
    throw new Error("Stored journal field dimension_refs must contain valid dimension references");
  }
  return parsed;
}

function storedJournalAccountingPolicy(value: unknown): ManualJournalAccountingPolicy {
  if (value === undefined || value === null) return "configured_basis_only";
  const payload = typeof value === "string" ? parseJson(value) : value;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return "configured_basis_only";
  const preview = (payload as Record<string, unknown>).preview;
  if (preview === null || typeof preview !== "object" || Array.isArray(preview)) return "configured_basis_only";
  return (preview as Record<string, unknown>).accountingPolicy === "mirror_cash_and_accrual"
    ? "mirror_cash_and_accrual"
    : "configured_basis_only";
}

function isStoredDimensionRef(value: unknown): value is DimensionRef {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const ref = value as Record<string, unknown>;
  return (
    typeof ref.dimensionKind === "string" &&
    ref.dimensionKind.length > 0 &&
    (ref.dimensionId === undefined || typeof ref.dimensionId === "string") &&
    (ref.sourceDimensionId === undefined || typeof ref.sourceDimensionId === "string") &&
    (ref.name === undefined || typeof ref.name === "string")
  );
}

function serviceContext(input: CreateErpFinancialsInput): ServiceContext {
  const invoiceAccountPolicy = normalizeInvoiceAccountPolicy(input.invoiceAccountPolicy);
  assertNonEmpty(input.tenantId, "tenantId");
  assertNonEmpty(input.companyId, "companyId");
  assertNonEmpty(input.sourceId, "sourceId");
  assertNonEmpty(input.currencyCode, "currencyCode");
  if (!/^[A-Z]{3}$/u.test(input.currencyCode)) {
    throw new ErpFinancialsValidationError("currencyCode must be a three-letter uppercase ISO currency code");
  }
  const currencyPolicy: unknown = input.currencyPolicy;
  if (currencyPolicy !== undefined && currencyPolicy !== "single_currency") {
    throw new ErpFinancialsValidationError(
      `Unsupported currency policy ${typeof currencyPolicy === "string" ? currencyPolicy : "non-string value"}`,
      "unsupported_operation"
    );
  }
  const accountingBasis = input.accountingBasis ?? "accrual";
  assertAccountingBasis(accountingBasis);

  return {
    database: isTransactionRunner(input.database)
      ? input.database
      : createPostgresTransactionRunner(input.database),
    tenantId: input.tenantId,
    companyId: input.companyId,
    sourceId: input.sourceId,
    ...(input.bookId === undefined ? {} : { bookId: input.bookId }),
    currencyCode: input.currencyCode,
    currencyPolicy: input.currencyPolicy ?? "single_currency",
    ...(invoiceAccountPolicy === undefined ? {} : { invoiceAccountPolicy }),
    accountingBasis,
    now: input.now ?? (() => new Date().toISOString()),
    postingPolicy: input.postingPolicy ?? "enforce_fiscal_periods",
    ...(input.financialApprovalPolicy === undefined ? {} : { financialApprovalPolicy: input.financialApprovalPolicy }),
    ...(input.customerPaymentCorrectionGuard === undefined ? {} : { customerPaymentCorrectionGuard: input.customerPaymentCorrectionGuard })
  };
}

function isTransactionRunner(database: ErpFinancialsDatabase): database is ErpFinancialsTransactionRunner {
  return "transaction" in database && typeof database.transaction === "function";
}

function flattenAccountTree(context: ServiceContext, input: UpsertAccountTreeInput): readonly Account[] {
  const accounts: Account[] = [];
  const accountIds = new Set<string>();
  const sourceAccountIds = new Set<string>();
  const visitedNodes = new Set<object>();

  const visit = (definition: ErpFinancialsAccountTreeNode, parentAccountId?: AccountId): void => {
    if (visitedNodes.has(definition)) {
      throw new ErpFinancialsValidationError("Account tree contains the same node object more than once");
    }
    visitedNodes.add(definition);

    const accountId = resolveAccountId(context, definition);
    assertNonEmpty(definition.name, `Account ${accountId} name`);
    if (!ACCOUNT_CLASSIFICATIONS.has(definition.classification)) {
      throw new ErpFinancialsValidationError(
        `Account ${accountId} has unsupported classification ${definition.classification}`
      );
    }

    const sourceAccountId = definition.sourceAccountId ?? accountReferenceKey(definition);
    assertNonEmpty(sourceAccountId, `Account ${accountId} sourceAccountId`);
    if (accountIds.has(accountId)) {
      throw new ErpFinancialsValidationError(`Account tree contains duplicate accountId ${accountId}`);
    }
    if (sourceAccountIds.has(sourceAccountId)) {
      throw new ErpFinancialsValidationError(`Account tree contains duplicate sourceAccountId ${sourceAccountId}`);
    }
    accountIds.add(accountId);
    sourceAccountIds.add(sourceAccountId);

    accounts.push({
      tenantId: context.tenantId,
      sourceId: context.sourceId,
      accountId,
      sourceAccountId,
      ...(definition.accountNumber === undefined ? {} : { accountNumber: definition.accountNumber }),
      name: definition.name,
      type: definition.type ?? definition.classification,
      ...(definition.subtype === undefined ? {} : { subtype: definition.subtype }),
      classification: definition.classification,
      ...(parentAccountId === undefined ? {} : { parentAccountId }),
      currencyCode: definition.currencyCode ?? context.currencyCode,
      active: definition.active ?? true
    });

    for (const child of definition.children ?? []) {
      visit(child, accountId);
    }
  };

  visit({
    ...input.parent,
    ...(input.children === undefined ? {} : { children: input.children })
  });
  return accounts;
}

function assertAccountIdentitiesAreStable(existingAccounts: readonly Account[], accounts: readonly Account[]): void {
  const existingById = new Map(existingAccounts.map((account) => [account.accountId, account]));
  const existingBySourceId = new Map(existingAccounts.map((account) => [account.sourceAccountId, account]));

  for (const account of accounts) {
    const existingWithId = existingById.get(account.accountId);
    if (existingWithId !== undefined && existingWithId.sourceAccountId !== account.sourceAccountId) {
      throw new ErpFinancialsValidationError(
        `Account ${account.accountId} cannot change sourceAccountId from ${existingWithId.sourceAccountId} to ${account.sourceAccountId}`
      );
    }

    const existingWithSourceId = existingBySourceId.get(account.sourceAccountId);
    if (existingWithSourceId !== undefined && existingWithSourceId.accountId !== account.accountId) {
      throw new ErpFinancialsValidationError(
        `sourceAccountId ${account.sourceAccountId} is already assigned to account ${existingWithSourceId.accountId}`
      );
    }
  }
}

function normalizeJournalOrigin(origin: JournalEntryOrigin): JournalEntryOrigin {
  const candidate: unknown = origin;
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new ErpFinancialsValidationError("Journal origin must be an object");
  }
  assertNonEmpty(origin.module, "origin.module");
  if (origin.module.length > 80) throw new ErpFinancialsValidationError("Journal origin.module exceeds 80 characters");
  if (origin.reference !== undefined) {
    assertNonEmpty(origin.reference, "origin.reference");
    if (origin.reference.length > 256) throw new ErpFinancialsValidationError("Journal origin.reference exceeds 256 characters");
  }
  return { module: origin.module, ...(origin.reference === undefined ? {} : { reference: origin.reference }) };
}

function normalizeJournalEntry(context: ServiceContext, input: InternalPostJournalEntryInput): NormalizedJournalEntry {
  assertNonEmpty(input.idempotencyKey, "idempotencyKey");
  assertIsoDate(input.date, "date");
  if (input.accountingPolicy !== undefined && !["configured_basis_only", "mirror_cash_and_accrual"].includes(input.accountingPolicy)) {
    throw new ErpFinancialsValidationError("accountingPolicy must be configured_basis_only or mirror_cash_and_accrual");
  }
  if (input.lines.length < 2) {
    throw new ErpFinancialsValidationError("A journal entry requires at least two lines");
  }

  const origin = input.origin === undefined ? undefined : normalizeJournalOrigin(input.origin);
  const lineIds = new Set<string>();
  const lines = input.lines.map((line, index): NormalizedJournalLine => {
    const accountId = resolveAccountId(context, line);
    const lineId = line.lineId ?? String(index + 1);
    assertNonEmpty(lineId, `Journal line ${String(index + 1)} lineId`);
    if (lineIds.has(lineId)) {
      throw new ErpFinancialsValidationError(`Journal entry contains duplicate lineId ${lineId}`);
    }
    lineIds.add(lineId);

    const debit = (line as { readonly debit?: unknown }).debit;
    const credit = (line as { readonly credit?: unknown }).credit;
    if ((debit === undefined) === (credit === undefined)) {
      throw new ErpFinancialsValidationError(`Journal line ${lineId} must have exactly one of debit or credit`);
    }

    const debitMinor = debit === undefined ? 0n : parsePositiveMoney(debit, `Journal line ${lineId} debit`);
    const creditMinor = credit === undefined ? 0n : parsePositiveMoney(credit, `Journal line ${lineId} credit`);

    return {
      accountId,
      lineId,
      lineNumber: index + 1,
      debitMinor,
      creditMinor,
      debitAmount: formatMoney(debitMinor),
      creditAmount: formatMoney(creditMinor),
      ...(line.description === undefined ? {} : { description: line.description }),
      ...(line.partyId === undefined ? {} : { partyId: line.partyId }),
      ...(line.itemId === undefined ? {} : { itemId: line.itemId }),
      dimensionRefs: line.dimensionRefs ?? []
    };
  });

  const debitMinor = lines.reduce((sum, line) => sum + line.debitMinor, 0n);
  const creditMinor = lines.reduce((sum, line) => sum + line.creditMinor, 0n);
  if (debitMinor !== creditMinor) {
    throw new ErpFinancialsValidationError(
      `Journal entry is unbalanced: debits ${formatMoney(debitMinor)}, credits ${formatMoney(creditMinor)}`,
      "posting_unbalanced",
      { totalCredits: formatMoney(creditMinor), totalDebits: formatMoney(debitMinor) }
    );
  }

  const currencyCode = input.currencyCode ?? context.currencyCode;
  assertCurrencyAllowed(context, currencyCode);
  const accountingBasis = input.accountingBasis ?? context.accountingBasis;
  const sourceTransactionType =
    input.nativeTransactionType ?? (input.adjustment === true ? "JournalEntryAdjustment" : "JournalEntry");
  const lifecycleAggregateType = input.lifecycleAggregateType ?? "journal_entry";
  const lifecycleEventType =
    input.lifecycleEventType ??
    (input.adjustment === true ? "journal_entry.adjustment_posted" : "journal_entry.posted");
  assertNonEmpty(currencyCode, "currencyCode");
  assertAccountingBasis(accountingBasis);
  if (input.postedAt !== undefined) {
    assertIsoDateTime(input.postedAt, "postedAt");
  }

  const checksum = createHash("sha256")
    .update(
      stableJson({
        accountingBasis,
        ...(input.accountingPolicy === "mirror_cash_and_accrual"
          ? { accountingPolicy: input.accountingPolicy }
          : {}),
        adjustment: input.adjustment === true,
        currencyCode,
        date: input.date,
        idempotencyKey: input.idempotencyKey,
        lines: lines.map((line) => ({
          accountId: line.accountId,
          creditAmount: line.creditAmount,
          debitAmount: line.debitAmount,
          description: line.description ?? null,
          dimensionHash: createDimensionHash(line.dimensionRefs),
          itemId: line.itemId ?? null,
          lineId: line.lineId,
          partyId: line.partyId ?? null
        })),
        memo: input.memo ?? null,
        ...(origin === undefined ? {} : { origin }),
        postedAt: input.postedAt ?? null,
        transactionNumber: input.transactionNumber ?? null
        ,
        sourceTransactionType,
        partyId: input.nativePartyId ?? null
      })
    )
    .digest("hex");

  return {
    idempotencyKey: input.idempotencyKey,
    date: input.date,
    ...(input.transactionNumber === undefined ? {} : { transactionNumber: input.transactionNumber }),
    ...(input.memo === undefined ? {} : { memo: input.memo }),
    ...(origin === undefined ? {} : { origin }),
    ...(input.postedAt === undefined ? {} : { postedAt: input.postedAt }),
    currencyCode,
    accountingBasis,
    accountingPolicy: input.accountingPolicy ?? "configured_basis_only",
    lines,
    checksum,
    staleReason: input.staleReason ?? JOURNAL_ENTRY_POSTED_STALE_REASON,
    adjustment: input.adjustment === true,
    sourceTransactionType,
    lifecycleAggregateType,
    lifecycleEventType,
    ...(input.nativePartyId === undefined ? {} : { partyId: input.nativePartyId })
  };
}

function oppositeAccountingMethod(basis: "cash" | "accrual"): "cash" | "accrual" {
  return basis === "cash" ? "accrual" : "cash";
}

async function executeJournalBasisMirror(
  client: PostgresQueryClient,
  context: ServiceContext,
  input: PostJournalEntryInput,
  journal: NormalizedJournalEntry
): Promise<PostJournalEntryResult | undefined> {
  if (journal.accountingPolicy !== "mirror_cash_and_accrual") return undefined;
  if (journal.accountingBasis === "modified_cash") {
    throw new ErpFinancialsValidationError("Manual journal mirroring requires cash or accrual accountingBasis");
  }
  const mirrorInput: PostJournalEntryInput = {
    ...input,
    idempotencyKey: `${input.idempotencyKey}:accounting-basis:${oppositeAccountingMethod(journal.accountingBasis)}`,
    accountingBasis: oppositeAccountingMethod(journal.accountingBasis),
    accountingPolicy: "configured_basis_only"
  };
  const mirror = normalizeJournalEntry(context, mirrorInput);
  return executePostJournalEntryInTransaction(client, context, mirrorInput, mirror, journalIdentities(context, mirror));
}

function isDualBasisCashMovement(documentType: SubledgerDocumentType): boolean {
  return ["customer_payment", "bill_payment", "refund", "deposit", "transfer", "sales_receipt", "purchase"].includes(documentType);
}

function combineJournalResults(primary: PostJournalEntryResult, mirror: PostJournalEntryResult): PostJournalEntryResult {
  return {
    ...primary,
    status: primary.status === "already_posted" && mirror.status === "already_posted" ? "already_posted" : "posted",
    snapshotsMarkedStale: primary.snapshotsMarkedStale + mirror.snapshotsMarkedStale,
    writeCounts: {
      importBatches: primary.writeCounts.importBatches + mirror.writeCounts.importBatches,
      transactions: primary.writeCounts.transactions + mirror.writeCounts.transactions,
      transactionLines: primary.writeCounts.transactionLines + mirror.writeCounts.transactionLines,
      postings: primary.writeCounts.postings + mirror.writeCounts.postings
    }
  };
}

function journalIdentities(
  context: ServiceContext,
  journal: NormalizedJournalEntry
): Pick<PostJournalEntryResult, "transactionId" | "transactionLineIds" | "postingIds" | "importBatchId"> & {
  readonly sourcePostingIds: readonly string[];
} {
  const transactionId = scopedRecordId(
    context,
    "transaction",
    `${journal.sourceTransactionType}:${journal.idempotencyKey}`
  );
  const sourcePostingIds = journal.lines.map((line) =>
    scopedRecordId(
      context,
      "journal_line",
      `${journal.sourceTransactionType}:${journal.idempotencyKey}:${line.lineId}`
    )
  );

  return {
    transactionId,
    transactionLineIds: journal.lines.map((line) =>
      scopedRecordId(
        context,
        "transaction_line",
        `${journal.sourceTransactionType}:${journal.idempotencyKey}:${line.lineId}`
      )
    ),
    sourcePostingIds,
    postingIds: sourcePostingIds.map((sourcePostingId) => scopedRecordId(context, "posting", sourcePostingId)),
    importBatchId: scopedRecordId(context, "import_batch", `${journal.sourceTransactionType}:${journal.idempotencyKey}`)
  };
}

function journalFacts(
  context: ServiceContext,
  journal: NormalizedJournalEntry,
  identities: ReturnType<typeof journalIdentities>,
  postedAt: IsoDateTime
): {
  readonly importBatch: ImportBatch;
  readonly transaction: AccountingTransaction;
  readonly transactionLines: readonly TransactionLine[];
  readonly postings: readonly LedgerPosting[];
} {
  const transactionRef: SafeSourcePayloadRef = {
    sourceObjectType: journal.sourceTransactionType,
    sourceObjectId: journal.idempotencyKey,
    sourceUpdatedAt: postedAt,
    checksum: journal.checksum,
      preview: {
        accountingBasis: journal.accountingBasis,
        accountingPolicy: journal.accountingPolicy,
      currencyCode: journal.currencyCode,
      lineCount: journal.lines.length,
      transactionDate: journal.date,
      ...(journal.origin === undefined ? {} : { journalOrigin: { ...journal.origin } })
    }
  };
  assertNoCredentialKeys(transactionRef);

  const transaction: AccountingTransaction = {
    tenantId: context.tenantId,
    sourceId: context.sourceId,
    transactionId: identities.transactionId,
    sourceTransactionId: journal.idempotencyKey,
    sourceTransactionType: journal.sourceTransactionType,
    ...(journal.transactionNumber === undefined ? {} : { transactionNumber: journal.transactionNumber }),
    transactionDate: journal.date,
    postedAt,
    updatedAt: postedAt,
    ...(journal.partyId === undefined ? {} : { partyId: journal.partyId }),
    currencyCode: journal.currencyCode,
    status: "posted",
    ...(journal.memo === undefined ? {} : { memo: journal.memo }),
    sourcePayloadRef: transactionRef
  };

  const transactionLines = journal.lines.map((line, index): TransactionLine => ({
    tenantId: context.tenantId,
    sourceId: context.sourceId,
    transactionLineId: requiredIndex(identities.transactionLineIds, index, "transaction line id"),
    transactionId: identities.transactionId,
    lineNumber: line.lineNumber,
    accountId: line.accountId,
    ...(line.partyId === undefined ? {} : { partyId: line.partyId }),
    ...(line.itemId === undefined ? {} : { itemId: line.itemId }),
    amount: formatMoney(line.debitMinor - line.creditMinor),
    ...(line.description === undefined ? {} : { description: line.description }),
    dimensionRefs: line.dimensionRefs
  }));

  const postings = journal.lines.map((line, index): LedgerPosting => {
    const sourcePostingId = requiredIndex(identities.sourcePostingIds, index, "source posting id");
    return {
      tenantId: context.tenantId,
      sourceId: context.sourceId,
      postingId: requiredIndex(identities.postingIds, index, "posting id"),
      sourcePostingId,
      transactionId: identities.transactionId,
      transactionLineId: requiredIndex(identities.transactionLineIds, index, "transaction line id"),
      accountId: line.accountId,
      ...(line.partyId === undefined ? {} : { partyId: line.partyId }),
      ...(line.itemId === undefined ? {} : { itemId: line.itemId }),
      postingDate: journal.date,
      accountingBasis: journal.accountingBasis,
      debitAmount: line.debitAmount,
      creditAmount: line.creditAmount,
      netAmount: formatMoney(line.debitMinor - line.creditMinor),
      currencyCode: journal.currencyCode,
      dimensionHash: createDimensionHash(line.dimensionRefs),
      dimensionRefs: line.dimensionRefs,
      sourcePayloadRef: {
        sourceObjectType: `${journal.sourceTransactionType}Line`,
        sourceObjectId: sourcePostingId,
        sourceUpdatedAt: postedAt,
        checksum: journal.checksum,
        preview: {
          journalEntryId: journal.idempotencyKey,
          lineId: line.lineId,
          lineNumber: line.lineNumber
        }
      },
      importBatchId: identities.importBatchId
    };
  });

  return {
    importBatch: {
      tenantId: context.tenantId,
      sourceId: context.sourceId,
      importBatchId: identities.importBatchId,
      mode: "delta",
      status: "completed",
      startedAt: postedAt,
      completedAt: postedAt,
      sourceObjectCounts: {
        accounts: 0,
        postings: postings.length,
        transactions: 1
      }
    },
    transaction,
    transactionLines,
    postings
  };
}

async function acquireTransactionLock(client: PostgresQueryClient, lockKey: string): Promise<void> {
  await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [lockKey]);
}

async function appendServiceOutboxEvent(
  client: PostgresQueryClient,
  context: ServiceContext,
  input: {
    readonly eventType: string;
    readonly aggregateType: string;
    readonly aggregateId: string;
    readonly idempotencyKey: string;
    readonly payload: import("./canonical-model.js").JsonValue;
  }
): Promise<string> {
  return appendFinancialOutboxEvent(client, {
    tenantId: context.tenantId,
    companyId: context.companyId,
    ...(context.bookId === undefined ? {} : { bookId: context.bookId }),
    sourceId: context.sourceId,
    ...input,
    availableAt: context.now()
  });
}

async function assertCompanySourceScope(client: PostgresQueryClient, context: ServiceContext): Promise<void> {
  const result = await client.query<{ readonly company_source_id: string }>(
    `select "company_source_id"
from "erp_financials"."company_sources"
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3
for key share`,
    [context.tenantId, context.companyId, context.sourceId]
  );
  if (result.rows[0] === undefined) {
    throw new ErpFinancialsValidationError(
      `Company ${context.companyId} is not bound to source ${context.sourceId} for tenant ${context.tenantId}`,
      "scope_mismatch",
      { companyId: context.companyId, sourceId: context.sourceId }
    );
  }
}

async function loadExistingJournal(
  client: PostgresQueryClient,
  context: ServiceContext,
  idempotencyKey: string,
  sourceTransactionType: string
): Promise<{ readonly transactionId: string; readonly status: string; readonly sourcePayloadRef: unknown } | undefined> {
  const result = await client.query<ExistingJournalRow>(
    `select "transaction_id", "status", "source_payload_ref"
from "erp_financials"."transactions"
where "tenant_id" = $1
  and "source_id" = $2
  and "source_transaction_type" = $4
  and "source_transaction_id" = $3
for update`,
    [context.tenantId, context.sourceId, idempotencyKey, sourceTransactionType]
  );
  const row = result.rows[0];
  if (row === undefined) {
    return undefined;
  }

  if (typeof row.transaction_id !== "string" || typeof row.status !== "string") {
    throw new Error("Stored journal entry has invalid transaction identity or status");
  }

  return {
    transactionId: row.transaction_id,
    status: row.status,
    sourcePayloadRef: row.source_payload_ref
  };
}

function sourceRefChecksum(value: unknown): string | undefined {
  const parsed = typeof value === "string" ? parseJson(value) : value;
  if (typeof parsed !== "object" || parsed === null || !("checksum" in parsed)) {
    return undefined;
  }
  return typeof parsed.checksum === "string" ? parsed.checksum : undefined;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function alreadyPostedResult(
  identities: ReturnType<typeof journalIdentities>,
  lifecycleEventId: string
): PostJournalEntryResult {
  return {
    status: "already_posted",
    transactionId: identities.transactionId,
    transactionLineIds: identities.transactionLineIds,
    postingIds: identities.postingIds,
    importBatchId: identities.importBatchId,
    lifecycleEventId,
    snapshotsMarkedStale: 0,
    writeCounts: {
      importBatches: 0,
      transactions: 0,
      transactionLines: 0,
      postings: 0
    }
  };
}

async function appendJournalPostedLifecycleEvent(
  client: PostgresQueryClient,
  context: ServiceContext,
  operation: FinancialOperationContext,
  journal: NormalizedJournalEntry,
  identities: ReturnType<typeof journalIdentities>,
  accountRequirements: readonly { readonly accountId: string; readonly classifications: readonly AccountClassification[] }[] = []
) {
  const evidence = {
    ...await retainJournalAccountPolicy(client,{tenantId:context.tenantId,companyId:context.companyId,sourceId:context.sourceId,transactionId:identities.transactionId,operation,recordedAt:context.now(),requirements:accountRequirements}),
    accountingBasis: journal.accountingBasis,
    adjustment: journal.adjustment,
    currencyCode: journal.currencyCode,
    importBatchId: identities.importBatchId,
    transactionDate: journal.date,
    transactionId: identities.transactionId
  };
  const inline = { ...evidence, postingIds: identities.postingIds };
  // Use the smaller outbox budget, leaving room for JSONB formatting and any
  // approval audit. Canonical posting pages retain the complete set of IDs.
  const payload = Buffer.byteLength(JSON.stringify(inline), "utf8") <= FINANCIAL_OUTBOX_MAX_PAYLOAD_BYTES
    ? inline
    : { ...evidence, postingCount: identities.postingIds.length, postingIdsOmitted: true };
  return appendFinancialLifecycleEvent(client, {
    tenantId: context.tenantId,
    companyId: context.companyId,
    sourceId: context.sourceId,
    aggregateType: journal.lifecycleAggregateType,
    aggregateId: identities.transactionId,
    eventType: journal.lifecycleEventType,
    idempotencyKey: `${journal.lifecycleAggregateType}:${journal.sourceTransactionType}:${journal.idempotencyKey}:posted`,
    operation,
    recordedAt: context.now(),
    payload
  });
}

/** Hold lifecycle locks until commit so deactivation cannot race a new posting. */
async function assertPostingAccountEligibility(
  client: PostgresQueryClient,
  context: ServiceContext,
  accountIds: readonly AccountId[]
): Promise<void> {
  await acquireTransactionLock(client, `account-hierarchy:${context.tenantId}:${context.sourceId}`);
  if (context.bookId === undefined) return;
  await acquireTransactionLock(client, `reporting-book-accounts:${context.tenantId}:${context.companyId}:${context.bookId}`);
  const result = await client.query(
    `select mapping."account_id"
from "erp_financials"."reporting_book_account_mappings" mapping
join "erp_financials"."reporting_book_accounts" account
  on account."tenant_id" = mapping."tenant_id" and account."company_id" = mapping."company_id"
 and account."book_id" = mapping."book_id" and account."book_account_key" = mapping."book_account_key"
where mapping."tenant_id" = $1 and mapping."company_id" = $2 and mapping."book_id" = $3
  and mapping."source_id" = $4 and mapping."account_id" = any($5::text[])
  and (account."active" is not true or account."account_role" <> 'posting')`,
    [context.tenantId, context.companyId, context.bookId, context.sourceId, accountIds]
  );
  if (result.rows.length > 0) {
    throw new ErpFinancialsValidationError("Journal entry references inactive or non-posting reporting-book accounts");
  }
}

function assertJournalAccounts(accounts: readonly Account[], requestedAccountIds: readonly AccountId[]): void {
  const accountsById = new Map(accounts.map((account) => [account.accountId, account]));
  const missing = requestedAccountIds.filter((accountId) => !accountsById.has(accountId));
  if (missing.length > 0) {
    throw new ErpFinancialsValidationError(
      `Journal entry references missing accounts: ${missing.join(", ")}`,
      "missing_account",
      { accountIds: missing.join(",") }
    );
  }

  const inactive = requestedAccountIds.filter((accountId) => accountsById.get(accountId)?.active === false);
  if (inactive.length > 0) {
    throw new ErpFinancialsValidationError(`Journal entry references inactive accounts: ${inactive.join(", ")}`);
  }
}

function resolveAccountId(
  context: Pick<ServiceContext, "tenantId" | "sourceId">,
  reference: ErpFinancialsAccountReference
): AccountId {
  const accountKey = (reference as { readonly accountKey?: unknown }).accountKey;
  const accountId = (reference as { readonly accountId?: unknown }).accountId;

  if ((accountKey === undefined) === (accountId === undefined)) {
    throw new ErpFinancialsValidationError("Account reference must have exactly one of accountKey or accountId");
  }
  if (accountKey !== undefined) {
    if (typeof accountKey !== "string") {
      throw new ErpFinancialsValidationError("accountKey must be a string");
    }
    assertNonEmpty(accountKey, "accountKey");
    return scopedRecordId(context, "account", accountKey);
  }
  if (typeof accountId !== "string") {
    throw new ErpFinancialsValidationError("accountId must be a string");
  }
  assertNonEmpty(accountId, "accountId");
  return accountId;
}

function accountReferenceKey(reference: ErpFinancialsAccountReference): string {
  const accountKey = (reference as { readonly accountKey?: unknown }).accountKey;
  const accountId = (reference as { readonly accountId?: unknown }).accountId;

  if (typeof accountKey === "string") {
    return accountKey;
  }
  if (typeof accountId === "string") {
    return accountId;
  }
  throw new ErpFinancialsValidationError("Account reference must have exactly one of accountKey or accountId");
}

function parsePositiveMoney(value: unknown, field: string): bigint {
  if (typeof value !== "string") {
    throw new ErpFinancialsValidationError(`${field} must be a decimal string`);
  }
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (match === null || match[1] === undefined) {
    throw new ErpFinancialsValidationError(`${field} must be a nonnegative decimal with at most two fractional digits`);
  }
  const minor = BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
  if (minor === 0n) {
    throw new ErpFinancialsValidationError(`${field} must be greater than zero`);
  }
  return minor;
}

function formatMoney(value: bigint): DecimalString {
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  return `${sign}${(absolute / 100n).toString()}.${(absolute % 100n).toString().padStart(2, "0")}`;
}


function assertIsoDate(value: string, field: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) {
    throw new ErpFinancialsValidationError(`${field} must be an ISO date in YYYY-MM-DD format`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ErpFinancialsValidationError(`${field} must be a valid ISO date`);
  }
}

function assertAccountingBasis(value: string): void {
  if (!ACCOUNTING_BASES.has(value)) {
    throw new ErpFinancialsValidationError(`Unsupported accountingBasis ${value}`);
  }
}

function assertCurrencyAllowed(context: ServiceContext, currencyCode: string): void {
  assertNonEmpty(currencyCode, "currencyCode");
  if (currencyCode !== context.currencyCode) {
    throw new ErpFinancialsValidationError(
      `Currency ${currencyCode} is not supported by single-currency financial scope ${context.currencyCode}`,
      "currency_not_supported",
      { baseCurrencyCode: context.currencyCode, currencyCode }
    );
  }
}

function assertIsoDateTime(value: string, field: string): void {
  if (Number.isNaN(Date.parse(value))) {
    throw new ErpFinancialsValidationError(`${field} must be a valid ISO date-time`);
  }
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new ErpFinancialsValidationError(`${field} must not be empty`);
  }
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function requiredIndex<T>(values: readonly T[], index: number, label: string): T {
  const value = values[index];
  if (value === undefined) {
    throw new Error(`Missing ${label} at index ${String(index)}`);
  }
  return value;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry === undefined ? null : entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  }
  throw new ErpFinancialsValidationError("Journal entry contains a value that cannot be checksummed");
}

/** Cash recognition belongs to the active source, not the historical invoice's
 * expired reporting window. The original document and journal remain untouched. */
async function prepareCrossSourceSettlement(
  client: PostgresQueryClient, context: ServiceContext, input: ApplySubledgerPaymentInput,
  source: Record<string, unknown>, target: Record<string, unknown>, amount: string, applicationId: string
): Promise<readonly LedgerPosting[]> {
  const bridge = input.crossSource;
  const payable = input.applicationType === "bill_payment_to_bill";
  const sourceType = payable ? "bill_payment" : "customer_payment";
  const targetType = payable ? "vendor_bill" : "invoice";
  const controlSide = payable ? "creditAmount" : "debitAmount";
  const fundingSide = payable ? "debit_amount" : "credit_amount";
  if (!bridge) throw new ErpFinancialsValidationError("Missing settlement review");
  if (source.party_id !== bridge.nativePartyId || target.party_id !== bridge.historicalPartyId
    || source.currency_code !== context.currencyCode || target.currency_code !== context.currencyCode
    || source.document_type !== sourceType || target.document_type !== targetType
    || [source.status, target.status].some(status => status === "voided" || status === "replaced"))
    throw new ErpFinancialsValidationError("Settlement review does not match the document identities and currency");
  const bindings = (await client.query(`select b.*,s.source_system from erp_financials.reporting_book_sources b
    join erp_financials.accounting_sources s using(tenant_id,source_id)
    where b.tenant_id=$1 and b.company_id=$2 and b.book_id=$3 and b.source_id=any($4::text[])
    for share of b,s`, [context.tenantId, context.companyId, context.bookId, [context.sourceId, bridge.targetSourceId]])).rows;
  const native = bindings.find(row => row.source_id === context.sourceId), historical = bindings.find(row => row.source_id === bridge.targetSourceId);
  const within = (row: Record<string, unknown> | undefined, date: string) => row !== undefined
    && (row.effective_from == null || storedDate(row.effective_from, "effective_from") <= date)
    && (row.effective_through == null || storedDate(row.effective_through, "effective_through") >= date);
  if (native?.source_role !== "active" || native.source_system !== "native_erp" || historical?.source_role !== "historical"
    || historical.source_system !== "quickbooks" || !within(native, input.applicationDate)
    || !within(historical, storedDate(target.recognition_date ?? target.document_date, "recognition_date")))
    throw new ErpFinancialsValidationError("Settlement requires active native and historical QuickBooks sources in this book's date windows");
  const receipt = (await client.query(`select t.* from erp_financials.transactions t
    join erp_financials.financial_outbox o on o.tenant_id=t.tenant_id and o.source_id=t.source_id and o.aggregate_id=t.transaction_id
    where t.tenant_id=$1 and t.source_id=$2 and t.transaction_id=$3 and o.company_id=$4 and o.book_id=$5
      and o.event_type='ledger.posted' and t.source_transaction_type=$6 and t.status='posted'
    for share of t,o`, [context.tenantId, context.sourceId, source.transaction_id, context.companyId, context.bookId, `Subledger:${sourceType}`])).rows;
  if (receipt.length !== 1) throw new ErpFinancialsValidationError("Cross-source settlement requires an original native receipt in this book");
  const prior = (await client.query(`select a.*,e.payload from erp_financials.subledger_applications a
    join erp_financials.financial_lifecycle_events e on e.tenant_id=a.tenant_id and e.company_id=a.company_id
      and e.source_id=a.source_id and e.event_id=a.applied_event_id
    where a.tenant_id=$1 and a.company_id=$2 and coalesce(a.target_document_source_id,a.source_id)=$3
      and a.target_document_id=$4 order by a.subledger_application_id for share of a,e`,
    [context.tenantId, context.companyId, bridge.targetSourceId, input.targetDocumentId])).rows;
  if (prior.some(row => row.application_type !== input.applicationType || row.source_id !== context.sourceId
    || row.target_document_source_id !== bridge.targetSourceId))
    throw new ErpFinancialsValidationError("Historical invoice already has unsupported provider or other-source settlement");
  const applied = prior.filter(row => row.status === "applied").reduce((sum, row) => sum + parsePositiveMoney(row.applied_amount, "applied_amount"), 0n);
  if (parsePositiveOrZeroMoney(target.open_amount, "open_amount") + applied !== parsePositiveMoney(target.original_amount, "original_amount"))
    throw new ErpFinancialsValidationError("Historical provider balance lacks complete settlement evidence");
  const historicalContext = { ...context, sourceId: bridge.targetSourceId };
  const originals = (await loadImportedDocumentAccrualPostings(client, historicalContext, storedString(target.transaction_id, "transaction_id"))).map(storedLedgerPosting);
  if (originals.some(posting => posting.itemId !== undefined || posting.dimensionRefs.length > 0))
    throw new ErpFinancialsValidationError("Cross-source settlement requires explicit item and dimension mappings for dimensional invoices");
  const controls = originals.filter(posting => parsePositiveOrZeroMoney(posting[controlSide], "control") > 0n);
  if (controls.length !== 1 || controls[0]?.[controlSide] !== storedMoney(target.original_amount, "original_amount"))
    throw new ErpFinancialsValidationError("Cross-source settlement requires one unambiguous receivable/payable control");
  const mapping = new Map(bridge.accountMappings.map(row => [row.historicalAccountId, row.nativeAccountId]));
  const historicalIds = unique(originals.map(posting => posting.accountId));
  if (mapping.size !== bridge.accountMappings.length || mapping.size !== historicalIds.length || historicalIds.some(id => !mapping.has(id)))
    throw new ErpFinancialsValidationError("Settlement account mappings must cover exactly the original journal accounts");
  const accounts = (await client.query(`select * from erp_financials.accounts where tenant_id=$1
    and ((source_id=$2 and account_id=any($3::text[])) or (source_id=$4 and account_id=any($5::text[]))) for share`,
    [context.tenantId, bridge.targetSourceId, historicalIds, context.sourceId, [...mapping.values()]])).rows;
  for (const [oldId, newId] of mapping) {
    const oldAccount = accounts.find(row => row.source_id === bridge.targetSourceId && row.account_id === oldId);
    const newAccount = accounts.find(row => row.source_id === context.sourceId && row.account_id === newId);
    if (!oldAccount || !newAccount || newAccount.active !== true || oldAccount.classification !== newAccount.classification
      || (newAccount.currency_code != null && newAccount.currency_code !== context.currencyCode)
      || (oldId === controls[0].accountId ? newAccount.classification !== (payable ? "liability" : "asset") : !(payable ? ["expense", "cost_of_goods_sold", "other_expense"] : ["income", "other_income"]).includes(String(newAccount.classification))))
      throw new ErpFinancialsValidationError("Settlement account mapping changes classification or uses an unavailable account");
  }
  const cash = (await client.query(`select p.* from erp_financials.ledger_postings p
    join erp_financials.transactions t using(tenant_id,source_id,transaction_id)
    where p.tenant_id=$1 and p.source_id=$2 and t.source_transaction_id=$3
      and t.source_transaction_type=$4 and t.status='posted' and p.accounting_basis='cash'
    for share of p,t`, [context.tenantId, context.sourceId, `${String(receipt[0]?.source_transaction_id)}:accounting-basis:cash`, `Subledger:${sourceType}`])).rows;
  const credit = cash.filter(row => parsePositiveOrZeroMoney(row[fundingSide], fundingSide) > 0n);
  if (credit.length !== 1 || credit[0]?.account_id !== mapping.get(controls[0].accountId)
    || storedMoney(credit[0]?.[fundingSide], fundingSide) !== storedMoney(source.original_amount, "original_amount"))
    throw new ErpFinancialsValidationError("Mapped control does not match the original native payment cash posting");
  // Subtract exact earlier cash allocations. The final installment consumes all
  // remaining cents; independent percentage rounding cannot over-recognize income.
  const recognized = (await client.query(`select source_posting_id,debit_amount::text,credit_amount::text from erp_financials.ledger_postings
    where tenant_id=$1 and source_id=$2 and transaction_id=any($3::text[]) and accounting_basis='cash'`,
    [context.tenantId, context.sourceId, prior.flatMap(row => ["recognize", "reverse"].map(action =>
      scopedRecordId(context, "transaction", `cross-source-settlement:${String(row.subledger_application_id)}:${action}`)))])).rows;
  const remaining = originals.map(posting => {
    const previous = recognized.filter(row => prior.some(application => ["recognize", "reverse"].some(action =>
      row.source_posting_id === `cash-application:${String(application.subledger_application_id)}:${action}:${posting.sourcePostingId}`)));
    const used = previous.reduce((sum, row) => sum + parsePositiveOrZeroMoney(row.debit_amount, "debit") - parsePositiveOrZeroMoney(row.credit_amount, "credit"), 0n);
    const debit = parsePositiveOrZeroMoney(posting.debitAmount, "debit"), credit = parsePositiveOrZeroMoney(posting.creditAmount, "credit");
    const remainingDebit = debit > 0n ? debit - used : 0n, remainingCredit = credit > 0n ? credit + used : 0n;
    if (remainingDebit < 0n || remainingDebit > debit || remainingCredit < 0n || remainingCredit > credit)
      throw new ErpFinancialsValidationError("Historical invoice cash allocations exceed the original journal");
    return { ...posting, debitAmount: formatMoney(remainingDebit), creditAmount: formatMoney(remainingCredit), netAmount: formatMoney(remainingDebit - remainingCredit) };
  });
  const postings = projectCashBasisApplication({ applicationId, applicationType: payable ? "bill_payment_to_bill" : "customer_payment_to_invoice", action: "recognize",
    appliedAmount: amount, effectiveDate: input.applicationDate, importBatchId: scopedRecordId(context, "import_batch", `cross-source-settlement:${applicationId}:recognize`), accrualPostings: remaining });
  await assertPostingAccountEligibility(client, context, [...mapping.values()]);
  return postings.map(posting => {
    const accountId = mapping.get(posting.accountId);
    if (!accountId) throw new ErpFinancialsValidationError("Missing mapped account");
    // References to the original historical journal are retained in provenance,
    // never as foreign keys on the new native transaction.
    const { transactionLineId: _line, itemId: _item, checkpointId: _checkpoint, ...fact } = posting;
    void _line; void _item; void _checkpoint;
    return { ...fact, sourceId: context.sourceId, accountId, partyId: bridge.nativePartyId,
      sourcePayloadRef: { sourceObjectType: payable ? "CrossSourceVendorSettlement" : "CrossSourceCustomerSettlement", sourceObjectId: applicationId,
        preview: { targetSourceId: bridge.targetSourceId, targetDocumentId: input.targetDocumentId, reviewRef: bridge.reviewRef,
          historicalSourcePostingId: posting.sourcePostingId.slice(`cash-application:${applicationId}:recognize:`.length), historicalAccountId: posting.accountId } } };
  });
}

async function persistCrossSourceSettlement(client: PostgresQueryClient, context: ServiceContext,
  postings: readonly LedgerPosting[], applicationId: string, effectiveDate: string, action: "recognize" | "reverse"): Promise<readonly string[]> {
  const storage = createPostgresStorageAdapter(client), now = context.now();
  const identity = `cross-source-settlement:${applicationId}:${action}`;
  const transactionId = scopedRecordId(context, "transaction", identity), importBatchId = scopedRecordId(context, "import_batch", identity);
  if (!postings.length) throw new ErpFinancialsValidationError("Settlement requires a balanced cash journal");
  await storage.upsertImportBatch({ tenantId: context.tenantId, sourceId: context.sourceId, importBatchId,
    mode: "delta", status: "completed", startedAt: now, completedAt: now, sourceObjectCounts: { applications: 1, postings: postings.length } });
  await storage.upsertTransactions([{ tenantId: context.tenantId, sourceId: context.sourceId, transactionId,
    sourceTransactionId: identity, sourceTransactionType: postings[0]?.sourcePayloadRef?.sourceObjectType === "CrossSourceVendorSettlement" ? "Subledger:cross_source_vendor_settlement" : "Subledger:cross_source_customer_settlement", transactionDate: effectiveDate,
    postedAt: now, updatedAt: now, currencyCode: context.currencyCode, status: "posted",
    sourcePayloadRef: { sourceObjectType: postings[0]?.sourcePayloadRef?.sourceObjectType === "CrossSourceVendorSettlement" ? "CrossSourceVendorSettlement" : "CrossSourceCustomerSettlement", sourceObjectId: applicationId,
      preview: { action, bookId: context.bookId ?? null } } }]);
  await storage.upsertLedgerPostings(postings.map(posting => ({ ...posting, transactionId, importBatchId })));
  await storage.markReportSnapshotsStaleForPostingChanges({ tenantId: context.tenantId, companyId: context.companyId, sourceId: context.sourceId,
    affectedStart: effectiveDate, affectedEnd: effectiveDate, staleReason: `cross_source_settlement_${action}`, accountingBasis: "cash", currencyCode: context.currencyCode });
  return postings.map(posting => posting.postingId);
}

async function reverseCrossSourceSettlement(client: PostgresQueryClient, context: ServiceContext, application: Record<string, unknown>, input: EndSubledgerApplicationInput): Promise<readonly string[]> {
  if (input.effectiveDate < storedDate(application.application_date, "application_date"))
    throw new ErpFinancialsValidationError("Settlement reversal cannot precede its application");
  const transactionId = scopedRecordId(context, "transaction", `cross-source-settlement:${input.applicationId}:recognize`);
  const event = (await client.query(`select payload from erp_financials.financial_lifecycle_events
    where tenant_id=$1 and company_id=$2 and source_id=$3 and event_id=$4`,
    [context.tenantId, context.companyId, context.sourceId, application.applied_event_id])).rows[0];
  const book = (await client.query(`select source_payload_ref from erp_financials.transactions where tenant_id=$1 and source_id=$2 and transaction_id=$3`,
    [context.tenantId, context.sourceId, transactionId])).rows[0];
  if (!event || (storedJson(book?.source_payload_ref) as { preview?: { bookId?: unknown } } | null)?.preview?.bookId !== context.bookId)
    throw new ErpFinancialsValidationError("Settlement reversal requires the original posting book");
  const originals = (await client.query(`select *,posting_date::text from erp_financials.ledger_postings
    where tenant_id=$1 and source_id=$2 and transaction_id=$3 and accounting_basis='cash' order by posting_id for share`,
    [context.tenantId, context.sourceId, transactionId])).rows.map(storedLedgerPosting);
  const postings = originals.map(posting => ({ ...posting,
    postingId: scopedRecordId(context, "posting", `cross-source-reverse:${posting.postingId}`),
    sourcePostingId: posting.sourcePostingId.replace(`cash-application:${input.applicationId}:recognize:`, `cash-application:${input.applicationId}:reverse:`),
    postingDate: input.effectiveDate, debitAmount: posting.creditAmount, creditAmount: posting.debitAmount,
    netAmount: formatMoney(parsePositiveOrZeroMoney(posting.creditAmount, "credit") - parsePositiveOrZeroMoney(posting.debitAmount, "debit")) }));
  return persistCrossSourceSettlement(client, context, postings, input.applicationId, input.effectiveDate, "reverse");
}
