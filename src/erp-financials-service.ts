import { createHash } from "node:crypto";

import { assertValidAccountHierarchy } from "./account-hierarchy.js";
import { assertNoCredentialKeys, createDimensionHash } from "./canonical-model.js";
import { ACCOUNT_HIERARCHY_CHANGED_STALE_REASON } from "./rollup-jobs.js";
import { createPostgresStorageAdapter } from "./postgres-storage.js";
import { appendFinancialLifecycleEvent, assertFinancialOperationContext } from "./financial-lifecycle.js";
import { assertIndependentApproval } from "./financial-lifecycle.js";
import { assertPostingDateAllowed, createFiscalPeriodService } from "./fiscal-periods.js";
import { ErpFinancialsError } from "./sdk-errors.js";
import { appendFinancialOutboxEvent } from "./financial-outbox.js";
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
  release(): void;
};

export type ErpFinancialsPostgresPool = {
  connect(): Promise<ErpFinancialsPostgresTransactionClient>;
};

export type ErpFinancialsDatabase = ErpFinancialsTransactionRunner | ErpFinancialsPostgresPool;

export type CreateErpFinancialsInput = {
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

export type PostJournalEntryInput = {
  readonly operation: FinancialOperationContext;
  readonly idempotencyKey: string;
  readonly date: IsoDate;
  readonly transactionNumber?: string;
  readonly memo?: string;
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

export type SubledgerAmountLine = ErpFinancialsAccountReference & CommercialDocumentLineInput;

type SubledgerDocumentInputCommon = {
  readonly operation: FinancialOperationContext;
  readonly idempotencyKey: string;
  readonly date: IsoDate;
  readonly documentNumber?: string;
  readonly currencyCode?: IsoCurrencyCode;
  readonly memo?: string;
};

export type CreateInvoiceInput = SubledgerDocumentInputCommon & {
  readonly customerId: string;
  readonly dueDate: IsoDate;
  readonly receivableAccount: ErpFinancialsAccountReference;
  readonly revenueLines: readonly SubledgerAmountLine[];
};

export type RecordCustomerPaymentInput = SubledgerDocumentInputCommon & {
  readonly customerId: string;
  readonly amount: DecimalString;
  readonly cashAccount: ErpFinancialsAccountReference;
  readonly receivableAccount: ErpFinancialsAccountReference;
  /** Bounded external reconciliation references; never raw provider payloads or credentials. */
  readonly provenance?: CustomerPaymentProvenance;
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

export type CreateVendorBillInput = SubledgerDocumentInputCommon & {
  readonly vendorId: string;
  readonly dueDate: IsoDate;
  readonly payableAccount: ErpFinancialsAccountReference;
  readonly expenseLines: readonly VendorBillExpenseLine[];
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

export type ScheduleBillPaymentInput = RecordAndApplyBillPaymentInput;

export type ClearScheduledBillPaymentInput = {
  readonly operation: FinancialOperationContext;
  readonly billPaymentId: string;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
};

export type CancelScheduledBillPaymentInput = ClearScheduledBillPaymentInput;

export type VoidAndUnapplyBillPaymentInput = VoidPostedBillPaymentInput;

export type ScheduledBillPaymentResult = {
  readonly status: "scheduled" | "already_scheduled";
  readonly billPaymentId: string;
  readonly version: number;
  readonly lifecycleEventId: string;
};

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
  /** Present when the original deposit has a persisted cash-basis journal. */
  readonly cashReversal?: PostJournalEntryResult;
  readonly journalEntryLinkIds: readonly string[];
  readonly lifecycleEventIds: readonly string[];
};

export type RecordTransferInput = SubledgerDocumentInputCommon & {
  readonly amount: DecimalString;
  readonly fromAccount: ErpFinancialsAccountReference;
  readonly toAccount: ErpFinancialsAccountReference;
};

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
  | "write_off_to_invoice";

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
  readonly match?: {
    readonly matchCandidateId: string;
    readonly matchDecisionId: string;
    readonly method: "automatic" | "manual";
    readonly score: DecimalString;
    readonly evidence?: JsonValue;
  };
};

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
  readonly appliedAmount: DecimalString;
  readonly currencyCode: IsoCurrencyCode;
  readonly matchCandidateId?: string;
  readonly matchDecisionId?: string;
  readonly matchMethod?: "automatic" | "manual";
  readonly matchScore?: DecimalString;
  readonly lifecycleEventId: string;
};

export type ErpFinancials = {
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
  readonly invoices: { create(input: CreateInvoiceInput): Promise<SubledgerDocumentResult> };
  readonly customerPayments: { record(input: RecordCustomerPaymentInput): Promise<SubledgerDocumentResult> };
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
    create(input: CreateVendorBillInput): Promise<SubledgerDocumentResult>;
    voidIssued(input: VoidIssuedVendorBillInput): Promise<PostedVendorBillLifecycleResult>;
    replaceIssued(input: ReplaceIssuedVendorBillInput): Promise<PostedVendorBillLifecycleResult>;
    voidPosted(input: VoidPostedVendorBillInput): Promise<PostedVendorBillLifecycleResult>;
    replacePosted(input: ReplacePostedVendorBillInput): Promise<PostedVendorBillLifecycleResult>;
  };
  readonly billPayments: {
    record(input: RecordBillPaymentInput): Promise<SubledgerDocumentResult>;
    recordAndApply(input: RecordAndApplyBillPaymentInput): Promise<ClearedBillPaymentResult>;
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
  readonly transfers: { record(input: RecordTransferInput): Promise<SubledgerDocumentResult> };
  readonly paymentApplications: {
    apply(input: ApplySubledgerPaymentInput): Promise<SubledgerApplicationResult>;
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
    accounts: {
      upsertTree(treeInput) {
        return upsertAccountTree(context, treeInput);
      }
    },
    journalEntries: {
      post(journalInput) {
        return postJournalEntry(context, journalInput);
      },
      postAdjustment(journalInput) {
        return postJournalEntry(context, { ...journalInput, adjustment: true });
      },
      reverse(workflowInput) {
        return runJournalLifecycleWorkflow(context, "reversed", workflowInput);
      },
      void(workflowInput) {
        return runJournalLifecycleWorkflow(context, "voided", workflowInput);
      },
      correct(workflowInput) {
        return runJournalLifecycleWorkflow(context, "corrected", workflowInput);
      },
      replace(workflowInput) {
        return runJournalLifecycleWorkflow(context, "replaced", workflowInput);
      }
    },
    fiscalPeriods: createFiscalPeriodService(context),
    invoices: { create: (documentInput) => createInvoice(context, documentInput) },
    customerPayments: { record: (documentInput) => recordCustomerPayment(context, documentInput) },
    adjustments: {
      voidIssued: (adjustmentInput) => runIssuedAdjustmentLifecycle(context, "voided", adjustmentInput),
      replaceIssued: (adjustmentInput) => runIssuedAdjustmentLifecycle(context, "replaced", adjustmentInput)
    },
    credits: {
      issue: (documentInput) => issueCreditMemo(context, documentInput),
      voidIssued: (adjustmentInput) => runIssuedAdjustmentLifecycle(
        context,
        "voided",
        { ...adjustmentInput, adjustmentType: "credit" }
      ),
      replaceIssued: (adjustmentInput) => runIssuedAdjustmentLifecycle(
        context,
        "replaced",
        { ...adjustmentInput, adjustmentType: "credit" }
      )
    },
    refunds: {
      issue: (documentInput) => issueRefund(context, documentInput),
      voidIssued: (adjustmentInput) => runIssuedAdjustmentLifecycle(
        context,
        "voided",
        { ...adjustmentInput, adjustmentType: "refund" }
      ),
      replaceIssued: (adjustmentInput) => runIssuedAdjustmentLifecycle(
        context,
        "replaced",
        { ...adjustmentInput, adjustmentType: "refund" }
      )
    },
    vendorBills: {
      create: (documentInput) => createVendorBill(context, documentInput),
      voidIssued: (workflowInput) => runPostedVendorBillLifecycle(context, "voided", workflowInput),
      replaceIssued: (workflowInput) => runPostedVendorBillLifecycle(context, "replaced", workflowInput),
      voidPosted: (workflowInput) => runPostedVendorBillLifecycle(context, "voided", workflowInput),
      replacePosted: (workflowInput) => runPostedVendorBillLifecycle(context, "replaced", workflowInput)
    },
    billPayments: {
      record: (documentInput) => recordBillPayment(context, documentInput),
      recordAndApply: (documentInput) => recordAndApplyBillPayment(context, documentInput),
      schedule: (documentInput) => scheduleBillPayment(context, documentInput),
      clear: (workflowInput) => clearScheduledBillPayment(context, workflowInput),
      cancel: (workflowInput) => cancelScheduledBillPayment(context, workflowInput),
      voidAndUnapply: (workflowInput) => voidAndUnapplyBillPayment(context, workflowInput),
      void: (workflowInput) => runPostedBillPaymentVoid(context, workflowInput),
      voidIssued: (workflowInput) => runPostedBillPaymentVoid(context, workflowInput),
      voidPosted: (workflowInput) => runPostedBillPaymentVoid(context, workflowInput)
    },
    writeOffs: {
      record: (documentInput) => recordWriteOff(context, documentInput),
      settleInvoice: (settlementInput) => settleInvoiceWriteOff(context, settlementInput),
      voidIssued: (workflowInput) => runIssuedAdjustmentLifecycle(context, "voided", {
        ...workflowInput,
        adjustmentDocumentId: workflowInput.writeOffDocumentId,
        adjustmentType: "write_off"
      }),
      replaceIssued: (workflowInput) => runIssuedAdjustmentLifecycle(context, "replaced", {
        ...workflowInput,
        adjustmentDocumentId: workflowInput.writeOffDocumentId,
        adjustmentType: "write_off"
      })
    },
    deposits: {
      record: (documentInput) => recordDeposit(context, documentInput),
      reverse: (documentInput) => reverseDeposit(context, documentInput)
    },
    transfers: { record: (documentInput) => recordTransfer(context, documentInput) },
    paymentApplications: {
      apply: (applicationInput) => applySubledgerPayment(context, applicationInput),
      unapply: (applicationInput) => endSubledgerApplication(context, applicationInput, "unapplied"),
      void: (applicationInput) => endSubledgerApplication(context, applicationInput, "voided")
    }
  };
}

export function createPostgresTransactionRunner(
  pool: ErpFinancialsPostgresPool
): ErpFinancialsTransactionRunner {
  return {
    async transaction<Result>(operation: (client: PostgresQueryClient) => Promise<Result>): Promise<Result> {
      const client = await pool.connect();
      let transactionStarted = false;

      try {
        await client.query("begin");
        transactionStarted = true;
        const result = await operation(client);
        await client.query("commit");
        return result;
      } catch (error) {
        if (transactionStarted) {
          await client.query("rollback");
        }
        throw error;
      } finally {
        client.release();
      }
    }
  };
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
    assertIndependentApproval(input.operation);
  }
  const identities = journalIdentities(context, journal);

  return context.database.transaction(async (client) => {
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
  identities: ReturnType<typeof journalIdentities>
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
        const lifecycle = await appendJournalPostedLifecycleEvent(client, context, input.operation, journal, identities);
        return alreadyPostedResult(identities, lifecycle.eventId);
      }
      throw new ErpFinancialsIdempotencyConflictError(journal.idempotencyKey);
    }

    if (context.postingPolicy === "enforce_fiscal_periods") {
      await assertPostingDateAllowed(client, context, journal.date, {
        allowClosingAdjustment: journal.adjustment
      });
    }

    const storage = createPostgresStorageAdapter(client);
    const accountIds = unique(journal.lines.map((line) => line.accountId));
    await assertPostingAccountEligibility(client, context, accountIds);
    const accounts = await storage.loadAccounts({
      tenantId: context.tenantId,
      sourceId: context.sourceId,
      accountIds
    });
    assertJournalAccounts(accounts, accountIds);

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
    const lifecycle = await appendJournalPostedLifecycleEvent(client, context, input.operation, journal, identities);
    await appendServiceOutboxEvent(client, context, {
      eventType: "ledger.posted",
      aggregateType: journal.lifecycleAggregateType,
      aggregateId: identities.transactionId,
      idempotencyKey: `ledger-posted:${journal.sourceTransactionType}:${journal.idempotencyKey}`,
      payload: {
        accountingBasis: journal.accountingBasis,
        currencyCode: journal.currencyCode,
        postingDate: journal.date,
        postingIds: identities.postingIds,
        transactionId: identities.transactionId
      }
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
};

async function createInvoice(context: ServiceContext, input: CreateInvoiceInput): Promise<SubledgerDocumentResult> {
  const revenueLines = normalizeSubledgerLines(input.revenueLines, "revenueLines");
  const amount = sumSubledgerLines(revenueLines, "revenueLines");
  return createSubledgerDocument(context, {
    ...commonSubledgerDocument(context, input, "invoice", amount, true),
    dueDate: input.dueDate,
    partyId: input.customerId,
    journalLines: [
      { ...input.receivableAccount, debit: amount, partyId: input.customerId },
      ...revenueLines.map((line) => ({
        ...accountReferenceOnly(line),
        credit: line.amount,
        partyId: input.customerId,
        ...(line.itemId === undefined ? {} : { itemId: line.itemId }),
        ...(line.description === undefined ? {} : { description: line.description }),
        dimensionRefs: line.dimensionRefs
      }))
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
  return createSubledgerDocument(context, {
    ...commonSubledgerDocument(
      context,
      input,
      "customer_payment",
      amount,
      true,
      provenance === undefined ? {} : { customerPaymentProvenance: provenance }
    ),
    partyId: input.customerId,
    journalLines: [
      { ...input.cashAccount, debit: amount, partyId: input.customerId },
      { ...input.receivableAccount, credit: amount, partyId: input.customerId }
    ]
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
    : normalizeSubledgerLines(revenueLineInput, "revenueLines");
  const amount = revenueLines === undefined && legacyAmount !== undefined
    ? normalizedPositiveMoney(legacyAmount, "amount")
    : revenueLines === undefined
      ? (() => { throw new ErpFinancialsValidationError("Credit memo requires amount or revenueLines"); })()
      : sumSubledgerLines(revenueLines, "revenueLines");
  const revenueJournalLines: readonly PostJournalEntryLineInput[] = revenueLines === undefined
    ? legacyRevenueAccount === undefined
      ? (() => { throw new ErpFinancialsValidationError("Credit memo amount requires revenueAccount"); })()
      : [{ ...legacyRevenueAccount, debit: amount, partyId: input.customerId }]
    : revenueLines.map((line): PostJournalEntryLineInput => ({
        ...accountReferenceOnly(line),
        debit: line.amount,
        partyId: input.customerId,
        ...(line.itemId === undefined ? {} : { itemId: line.itemId }),
        ...(line.description === undefined ? {} : { description: line.description }),
        dimensionRefs: line.dimensionRefs
      }));
  return createSubledgerDocument(context, {
    ...commonSubledgerDocument(context, input, "credit_memo", amount, true),
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

async function createVendorBill(
  context: ServiceContext,
  input: CreateVendorBillInput
): Promise<SubledgerDocumentResult> {
  const expenseLines = normalizeSubledgerLines(input.expenseLines, "expenseLines");
  const amount = sumSubledgerLines(expenseLines, "expenseLines");
  return createSubledgerDocument(context, {
    ...commonSubledgerDocument(context, input, "vendor_bill", amount, true),
    dueDate: input.dueDate,
    partyId: input.vendorId,
    journalLines: [
      ...expenseLines.map((line) => ({
        ...accountReferenceOnly(line),
        debit: line.amount,
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
  const amount = normalizedPositiveMoney(input.amount, "amount");
  const fundingAccountId = resolveAccountId(context, input.cashAccount);
  const payableAccountId = resolveAccountId(context, input.payableAccount);
  if (input.paymentMethod !== undefined) assertBillPaymentMethod(input.paymentMethod);
  optionalNonEmpty(input.reference, "reference");
  return createSubledgerDocument(context, {
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
  });
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

async function scheduleBillPayment(
  context: ServiceContext,
  input: ScheduleBillPaymentInput
): Promise<ScheduledBillPaymentResult> {
  const instruction = normalizeBillPaymentInstruction(context, input);
  return context.database.transaction(async (client) => {
    await acquireTransactionLock(client, billPaymentInstructionLock(context, instruction.idempotencyKey));
    await assertCompanySourceScope(client, context);
    const row = await createOrLoadBillPaymentInstruction(client, context, instruction, input.operation);
    return {
      status: row.created ? "scheduled" : "already_scheduled",
      billPaymentId: instruction.billPaymentId,
      version: storedInteger(row.value.version, "bill payment version"),
      lifecycleEventId: storedString(row.value.scheduled_event_id, "scheduled_event_id")
    };
  });
}

async function recordAndApplyBillPayment(
  context: ServiceContext,
  input: RecordAndApplyBillPaymentInput
): Promise<ClearedBillPaymentResult> {
  const instruction = normalizeBillPaymentInstruction(context, input);
  return context.database.transaction(async (client) => {
    await acquireTransactionLock(client, billPaymentInstructionLock(context, instruction.idempotencyKey));
    await assertCompanySourceScope(client, context);
    const scheduled = await createOrLoadBillPaymentInstruction(client, context, instruction, input.operation);
    const currentStatus = storedString(scheduled.value.status, "bill payment status");
    if (currentStatus === "voided") {
      throw new ErpFinancialsError("terminal_state_conflict", `Bill payment ${instruction.billPaymentId} is voided`);
    }
    const nestedContext = nestedServiceContext(context, client);
    if (currentStatus === "cleared") {
      await assertLifecycleReplayKey(
        client,
        context,
        scheduled.value.cleared_event_id,
        `bill-payment:${input.idempotencyKey}:cleared`,
        input.operation
      );
      return materializeClearedBillPayment(
        nestedContext,
        instruction,
        input.operation,
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
  });
}

async function clearScheduledBillPayment(
  context: ServiceContext,
  input: ClearScheduledBillPaymentInput
): Promise<ClearedBillPaymentResult> {
  assertFinancialOperationContext(input.operation);
  assertNonEmpty(input.billPaymentId, "billPaymentId");
  assertNonEmpty(input.idempotencyKey, "idempotencyKey");
  assertExpectedSubledgerVersion(input.expectedVersion, "expectedVersion");
  return context.database.transaction(async (client) => {
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
      await assertLifecycleReplayKey(
        client,
        context,
        row.cleared_event_id,
        `bill-payment:${input.idempotencyKey}:cleared`,
        input.operation
      );
      return materializeClearedBillPayment(
        nestedContext,
        instruction,
        input.operation,
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
  });
}

async function cancelScheduledBillPayment(
  context: ServiceContext,
  input: CancelScheduledBillPaymentInput
): Promise<CancelledScheduledBillPaymentResult> {
  assertIndependentApproval(input.operation);
  assertNonEmpty(input.billPaymentId, "billPaymentId");
  assertNonEmpty(input.idempotencyKey, "idempotencyKey");
  assertExpectedSubledgerVersion(input.expectedVersion, "expectedVersion");
  return context.database.transaction(async (client) => {
    await acquireTransactionLock(client, billPaymentLifecycleLock(context, input.billPaymentId));
    await assertCompanySourceScope(client, context);
    const row = await loadBillPaymentInstructionForUpdate(client, context, input.billPaymentId);
    const status = storedString(row.status, "bill payment status");
    if (status === "voided") {
      const currentVersion = storedInteger(row.version, "bill payment version");
      if (currentVersion !== input.expectedVersion + 1) {
        throw optimisticBillPaymentConflict(input.billPaymentId, input.expectedVersion, currentVersion - 1);
      }
      await assertLifecycleReplayKey(
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
  });
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
  const payment = await recordBillPayment(context, {
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
  });
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
      `select * from "erp_financials"."subledger_documents"
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

async function createOrLoadBillPaymentInstruction(
  client: PostgresQueryClient,
  context: ServiceContext,
  instruction: NormalizedBillPaymentInstruction,
  operation: FinancialOperationContext
): Promise<{ readonly created: boolean; readonly value: Record<string, unknown> }> {
  const existing = await loadBillPaymentInstructionByIdempotencyKey(client, context, instruction.idempotencyKey);
  if (existing !== undefined) {
    if (
      storedString(existing.bill_payment_id, "bill_payment_id") !== instruction.billPaymentId ||
      storedString(existing.payload_checksum, "payload_checksum") !== instruction.payloadChecksum
    ) {
      throw new ErpFinancialsIdempotencyConflictError(instruction.idempotencyKey);
    }
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
    `select * from "erp_financials"."subledger_documents"
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3
  and "subledger_document_id" = any($4::text[])
order by "subledger_document_id"
for update`,
    [context.tenantId, context.companyId, context.sourceId, [...billIds].sort()]
  );
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

async function loadBillPaymentInstructionByIdempotencyKey(
  client: PostgresQueryClient,
  context: ServiceContext,
  idempotencyKey: string
): Promise<Record<string, unknown> | undefined> {
  const result = await client.query(
    `select * from "erp_financials"."bill_payment_disbursements"
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3 and "idempotency_key" = $4
for update`,
    [context.tenantId, context.companyId, context.sourceId, idempotencyKey]
  );
  return result.rows[0];
}

async function loadBillPaymentInstructionForUpdate(
  client: PostgresQueryClient,
  context: ServiceContext,
  billPaymentId: string
): Promise<Record<string, unknown>> {
  const result = await client.query(
    `select * from "erp_financials"."bill_payment_disbursements"
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3 and "bill_payment_id" = $4
for update`,
    [context.tenantId, context.companyId, context.sourceId, billPaymentId]
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new ErpFinancialsError("missing_document", `Bill payment ${billPaymentId} does not exist in the write source`);
  }
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

async function assertLifecycleReplayKey(
  client: PostgresQueryClient,
  context: ServiceContext,
  eventIdValue: unknown,
  expectedIdempotencyKey: string,
  operation: FinancialOperationContext
): Promise<void> {
  const eventId = storedString(eventIdValue, "lifecycle event id");
  const result = await client.query(
    `select "idempotency_key", "actor_ref", "approver_ref", "request_id", "correlation_id", "reason_code",
  "reason_detail", "occurred_at"
from "erp_financials"."financial_lifecycle_events"
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3 and "event_id" = $4`,
    [context.tenantId, context.companyId, context.sourceId, eventId]
  );
  const row = result.rows[0];
  const occurredAt = row?.occurred_at instanceof Date
    ? row.occurred_at.toISOString()
    : row === undefined ? undefined : storedString(row.occurred_at, "occurred_at");
  if (
    row === undefined ||
    storedString(row.idempotency_key, "idempotency_key") !== expectedIdempotencyKey ||
    storedString(row.actor_ref, "actor_ref") !== operation.actorRef ||
    storedOptionalString(row.approver_ref) !== operation.approverRef ||
    storedString(row.request_id, "request_id") !== operation.requestId ||
    storedString(row.correlation_id, "correlation_id") !== operation.correlationId ||
    storedString(row.reason_code, "reason_code") !== operation.reasonCode ||
    storedOptionalString(row.reason_detail) !== operation.reasonDetail ||
    occurredAt !== operation.occurredAt
  ) {
    throw new ErpFinancialsError("terminal_state_conflict", "Bill payment lifecycle already advanced under another command");
  }
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
  assertIndependentApproval(input.operation);
  assertNonEmpty(input.depositId, "depositId");
  assertNonEmpty(input.idempotencyKey, "idempotencyKey");
  assertIsoDate(input.date, "date");

  return context.database.transaction(async (client) => {
    await acquireTransactionLock(client, `deposit-reversal:${context.tenantId}:${context.sourceId}:${input.depositId}`);
    await assertCompanySourceScope(client, context);
    // Serialize with fiscal close/reopen and posting-lock changes through commit.
    await acquireTransactionLock(client, `fiscal-period:${context.tenantId}:${context.companyId}:${context.sourceId}`);
    const result = await client.query(
      `select "transaction_id", "idempotency_key", "lifecycle_event_id", "status"
from "erp_financials"."subledger_documents"
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3
  and "subledger_document_id" = $4 and "document_type" = 'deposit'
for key share`,
      [context.tenantId, context.companyId, context.sourceId, input.depositId]
    );
    const document = result.rows[0];
    if (document === undefined) {
      throw new ErpFinancialsValidationError("Deposit does not exist in this scope", "missing_document");
    }
    if (document.status !== "settled") {
      throw new ErpFinancialsError("terminal_state_conflict", "Only a settled recorded deposit can be reversed");
    }
    const transactionId = storedString(document.transaction_id, "transaction_id");
    const originalKey = storedString(document.idempotency_key, "idempotency_key");
    await acquireTransactionLock(client, `subledger-document:${context.tenantId}:${context.companyId}:${context.sourceId}:${originalKey}`);
    // Reuse the lifecycle implementation inside this one outer transaction. New
    // deposit reversals always enforce fiscal periods, including legacy callers.
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
        throw new ErpFinancialsValidationError("Deposit posting book provenance is missing or outside this scope", "scope_mismatch");
      }
      const original = await loadPostedJournalForLifecycle(client, context, originalTransactionId, ["Subledger:deposit"]);
      if (original.accountingBasis !== basis || original.accountingPolicy !== "configured_basis_only") {
        throw new ErpFinancialsValidationError("Deposit journal has an unsupported accounting context");
      }
      return runJournalLifecycleWorkflow(nestedContext, "reversed", {
        originalTransactionId,
        idempotencyKey: `deposit-reversal:${input.idempotencyKey}:${basis}`,
        date: input.date,
        ...(input.memo === undefined ? {} : { memo: input.memo }),
        operation: input.operation
      }, {
        allowedSourceTypes: ["Subledger:deposit"],
        priorEventId: storedString(document.lifecycle_event_id, "lifecycle_event_id")
      });
    };
    const primary = await reverseBasis(transactionId, "accrual");
    // Locate first; reverseBasis acquires the lifecycle lock before row locks,
    // in the same order as other journal lifecycle commands.
    const cash = await client.query(
      `select "transaction_id" from "erp_financials"."transactions"
where "tenant_id" = $1 and "source_id" = $2
  and "source_transaction_type" = 'Subledger:deposit' and "source_transaction_id" = $3`,
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
      aggregateId: input.depositId,
      eventType: "subledger.deposit.reversed",
      idempotencyKey: `deposit-reversal:${input.idempotencyKey}`,
      operation: input.operation,
      recordedAt: context.now(),
      priorEventId: storedString(document.lifecycle_event_id, "lifecycle_event_id"),
      payload: {
        depositId: input.depositId,
        originalTransactionId: transactionId,
        reversalTransactionIds: workflows.map((workflow) => workflow.reversal.transactionId)
      }
    });
    await appendServiceOutboxEvent(client, context, {
      aggregateType: "subledger_document",
      aggregateId: input.depositId,
      eventType: "subledger.deposit.reversed",
      idempotencyKey: `deposit-reversal:${input.idempotencyKey}:outbox`,
      payload: { depositId: input.depositId, originalTransactionId: transactionId, lifecycleEventId: event.eventId }
    });
    return {
      status: primary.reversal.status === "already_posted" ? "already_reversed" : "reversed",
      originalDepositId: input.depositId,
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

async function createSubledgerDocument(
  context: ServiceContext,
  input: SubledgerDocumentWrite
): Promise<SubledgerDocumentResult> {
  assertFinancialOperationContext(input.operation);
  assertIsoDate(input.date, "date");
  if (input.dueDate !== undefined) {
    assertIsoDate(input.dueDate, "dueDate");
    if (input.dueDate < input.date) {
      throw new ErpFinancialsValidationError("dueDate must be on or after date");
    }
  }
  const documentId = scopedRecordId(context, "subledger_document", `${input.documentType}:${input.idempotencyKey}`);
  const journalInput: InternalPostJournalEntryInput = {
    operation: input.operation,
    idempotencyKey: input.idempotencyKey,
    date: input.date,
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
  const journal = normalizeJournalEntry(context, journalInput);
  const identities = journalIdentities(context, journal);

  return context.database.transaction(async (client) => {
    await acquireTransactionLock(
      client,
      `subledger-document:${context.tenantId}:${context.companyId}:${context.sourceId}:${input.idempotencyKey}`
    );
    await assertCompanySourceScope(client, context);
    await assertSubledgerParty(client, context, input.partyId, input.documentType);
    for (const customerId of unique((input.documentLines ?? []).flatMap((line) =>
      line.customerId === undefined ? [] : [line.customerId]
    ))) {
      await assertActiveSubledgerParty(client, context, customerId, "customer", "Bill-line customerId");
    }
    await assertRelatedInvoiceReference(client, context, input.partyId, input.metadata);
    const posted = await executePostJournalEntryInTransaction(client, context, journalInput, journal, identities);
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
  "status", "version", "idempotency_key", "lifecycle_event_id", "metadata", "created_at", "updated_at"
) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 1, $15, $16, $17, $18, $18)
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
        context.now()
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
    if (
      storedString(existing.subledger_document_id, "subledger_document_id") !== documentId ||
      storedString(existing.document_type, "document_type") !== input.documentType ||
      storedString(existing.transaction_id, "transaction_id") !== posted.transactionId ||
      storedMoney(existing.original_amount, "original_amount") !== input.amount ||
      storedDate(existing.document_date, "document_date") !== input.date ||
      storedOptionalDate(existing.due_date, "due_date") !== input.dueDate ||
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
  Pick<VendorBillExpenseLine, "customerId">;

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
  "service_period_start", "service_period_end", "dimension_refs", "line_amount", "customer_party_id"
) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
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
        line.customerId
      ]
    );
  }
}

async function applySubledgerPayment(
  context: ServiceContext,
  input: ApplySubledgerPaymentInput
): Promise<SubledgerApplicationResult> {
  assertFinancialOperationContext(input.operation);
  assertExpectedSubledgerVersion(input.expectedSourceVersion, "expectedSourceVersion");
  assertExpectedSubledgerVersion(input.expectedTargetVersion, "expectedTargetVersion");
  assertSubledgerApplicationType(input.applicationType);
  const amount = normalizedPositiveMoney(input.amount, "amount");
  assertIsoDate(input.applicationDate, "applicationDate");
  assertSubledgerMatchInput(input.match);
  const applicationId = scopedRecordId(context, "subledger_application", input.idempotencyKey);
  return context.database.transaction(async (client) => {
    await acquireTransactionLock(
      client,
      `subledger-application:${context.tenantId}:${context.companyId}:${context.sourceId}:${input.sourceDocumentId}:${input.targetDocumentId}`
    );
    await assertCompanySourceScope(client, context);
    const existing = await loadSubledgerApplicationByIdempotencyKey(client, context, input.idempotencyKey);
    if (existing !== undefined) {
      assertSameSubledgerApplication(existing, input, amount, applicationId);
      const existingStatus = storedString(existing.status, "status");
      if (existingStatus !== "applied") {
        throw new ErpFinancialsValidationError(
          `Subledger application ${applicationId} is ${existingStatus} and cannot be replayed as applied; use a new idempotency key`
        );
      }
      return applicationResult(existing, "already_applied");
    }
    if (context.postingPolicy === "enforce_fiscal_periods") {
      await assertPostingDateAllowed(client, context, input.applicationDate);
    }
    const [source, target] = await loadSubledgerDocumentsForUpdate(client, context, [
      input.sourceDocumentId,
      input.targetDocumentId
    ]);
    assertSubledgerApplicationDocuments(input, source, target, amount);
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
        applicationDate: input.applicationDate,
        applicationType: input.applicationType,
        appliedAmount: amount,
        sourceDocumentId: input.sourceDocumentId,
        targetDocumentId: input.targetDocumentId,
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
  "match_score", "match_evidence", "created_at", "updated_at"
) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'applied', 1, $11, $12, null, $13, $14, $15, $16, $17, $18, $18)
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
        context.now()
      ]
    );
    const row = inserted.rows[0];
    if (row === undefined) {
      throw new Error("Subledger application insert did not return its row");
    }
    const cashBasisPostingIds = await persistCashBasisApplicationProjection(client, context, {
      action: "recognize",
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
  assertIndependentApproval(input.operation);
  assertIsoDate(input.effectiveDate, "effectiveDate");
  assertExpectedSubledgerVersion(input.expectedVersion, "expectedVersion");
  return context.database.transaction(async (client) => {
    await acquireTransactionLock(
      client,
      `subledger-application:${context.tenantId}:${context.companyId}:${context.sourceId}:${input.applicationId}`
    );
    const currentResult = await client.query(
      `select * from "erp_financials"."subledger_applications"
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
    const currentStatus = storedString(current.status, "status");
    if (currentStatus === status) {
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
    const cashBasisPostingIds = await persistCashBasisApplicationProjection(client, context, {
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

async function persistCashBasisApplicationProjection(
  client: PostgresQueryClient,
  context: ServiceContext,
  input: {
    readonly action: "recognize" | "reverse";
    readonly applicationId: string;
    readonly applicationType: SubledgerApplicationType | "customer_refund_against_invoice";
    readonly appliedAmount: DecimalString;
    readonly effectiveDate: IsoDate;
    readonly targetTransactionId: string;
  }
): Promise<readonly string[]> {
  if (!["customer_payment_to_invoice", "bill_payment_to_bill", "customer_refund_against_invoice"].includes(input.applicationType)) return [];
  const result = await client.query(
    `select * from "erp_financials"."ledger_postings"
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
  const accrualPostings = result.rows.map(storedLedgerPosting);
  const postings = projectCashBasisApplication({
    applicationId: input.applicationId,
    applicationType: input.applicationType as CashBasisApplicationType,
    action: input.action,
    appliedAmount: input.appliedAmount,
    effectiveDate: input.effectiveDate,
    importBatchId,
    accrualPostings
  });
  const now = context.now();
  const storage = createPostgresStorageAdapter(client);
  const accountIds = unique(postings.map(posting => posting.accountId));
  await assertPostingAccountEligibility(client, context, accountIds);
  const accounts = await storage.loadAccounts({ tenantId: context.tenantId, sourceId: context.sourceId, accountIds });
  assertJournalAccounts(accounts, accountIds);
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
  await storage.upsertLedgerPostings(postings);
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
for key share`,
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
    `select * from "erp_financials"."subledger_documents"
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
    `select * from "erp_financials"."subledger_applications"
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3 and "idempotency_key" = $4
for key share`,
    [context.tenantId, context.companyId, context.sourceId, idempotencyKey]
  );
  return result.rows[0];
}

async function loadSubledgerDocumentsForUpdate(
  client: PostgresQueryClient,
  context: ServiceContext,
  ids: readonly [string, string]
): Promise<readonly [Record<string, unknown>, Record<string, unknown>]> {
  if (ids[0] === ids[1]) {
    throw new ErpFinancialsValidationError("Subledger application source and target documents must differ");
  }
  const result = await client.query(
    `select * from "erp_financials"."subledger_documents"
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3 and "subledger_document_id" = any($4::text[])
order by "subledger_document_id"
for update`,
    [context.tenantId, context.companyId, context.sourceId, [...ids].sort()]
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
    write_off_to_invoice: [["write_off"], "invoice"]
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

function normalizeSubledgerLines(
  lines: readonly SubledgerAmountLine[],
  field: string
): readonly (ErpFinancialsAccountReference & NormalizedCommercialDocumentLine)[] {
  if (lines.length === 0) {
    throw new ErpFinancialsValidationError(`${field} must contain at least one line`);
  }
  return lines.map((line, index) => ({
    ...accountReferenceOnly(line),
    ...normalizeCommercialDocumentLine(line, `${field}[${String(index)}]`)
  }));
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
    "write_off_to_invoice"
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
};

async function runPostedVendorBillLifecycle(
  context: ServiceContext,
  outcome: "voided" | "replaced",
  input: VoidPostedVendorBillInput | ReplacePostedVendorBillInput
): Promise<PostedVendorBillLifecycleResult> {
  assertIndependentApproval(input.operation);
  assertNonEmpty(input.vendorBillId, "vendorBillId");
  assertNonEmpty(input.idempotencyKey, "idempotencyKey");
  assertExpectedSubledgerVersion(input.expectedVersion, "expectedVersion");
  assertIsoDate(input.date, "date");
  if (outcome === "replaced" && !("replacement" in input)) {
    throw new ErpFinancialsValidationError("Replacing a posted vendor bill requires a replacement bill");
  }

  return context.database.transaction(async (client) => {
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
  });
}

async function loadPostedVendorBillForLifecycle(
  client: PostgresQueryClient,
  context: ServiceContext,
  documentId: string
): Promise<LoadedPostedVendorBill> {
  const result = await client.query(
    `select * from "erp_financials"."subledger_documents"
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
    journal: await loadPostedJournalForLifecycle(
      client,
      context,
      transactionId,
      [subledgerTransactionType("vendor_bill")]
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

async function voidAndUnapplyBillPayment(
  context: ServiceContext,
  input: VoidAndUnapplyBillPaymentInput
): Promise<VoidAndUnapplyBillPaymentResult> {
  assertIndependentApproval(input.operation);
  assertNonEmpty(input.billPaymentId, "billPaymentId");
  assertNonEmpty(input.idempotencyKey, "idempotencyKey");
  assertExpectedSubledgerVersion(input.expectedVersion, "expectedVersion");
  assertIsoDate(input.date, "date");
  return context.database.transaction(async (client) => {
    await acquireTransactionLock(client, billPaymentLifecycleLock(context, input.billPaymentId));
    await assertCompanySourceScope(client, context);
    const disbursement = await loadOptionalBillPaymentInstructionForUpdate(client, context, input.billPaymentId);
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
        await assertLifecycleReplayKey(
          client,
          context,
          disbursement.voided_event_id,
          `bill-payment:${input.idempotencyKey}:compensated`,
          input.operation
        );
        const replay = await runPostedBillPaymentVoid(nestedServiceContext(context, client), input);
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
        const replay = await runPostedBillPaymentVoid(nestedServiceContext(context, client), input);
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
        return { ...replay, endedApplications };
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
    });
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
}

async function loadOptionalBillPaymentInstructionForUpdate(
  client: PostgresQueryClient,
  context: ServiceContext,
  billPaymentId: string
): Promise<Record<string, unknown> | undefined> {
  const result = await client.query(
    `select * from "erp_financials"."bill_payment_disbursements"
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3 and "bill_payment_id" = $4
for update`,
    [context.tenantId, context.companyId, context.sourceId, billPaymentId]
  );
  return result.rows[0];
}

async function loadBillPaymentApplicationsForUpdate(
  client: PostgresQueryClient,
  context: ServiceContext,
  billPaymentId: string
): Promise<readonly Record<string, unknown>[]> {
  const result = await client.query(
    `select * from "erp_financials"."subledger_applications"
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3
  and "source_document_id" = $4 and "application_type" = 'bill_payment_to_bill'
order by "application_date", "subledger_application_id"
for update`,
    [context.tenantId, context.companyId, context.sourceId, billPaymentId]
  );
  return result.rows;
}

async function runPostedBillPaymentVoid(
  context: ServiceContext,
  input: VoidPostedBillPaymentInput
): Promise<PostedBillPaymentLifecycleResult> {
  assertIndependentApproval(input.operation);
  assertNonEmpty(input.billPaymentId, "billPaymentId");
  assertNonEmpty(input.idempotencyKey, "idempotencyKey");
  assertExpectedSubledgerVersion(input.expectedVersion, "expectedVersion");
  assertIsoDate(input.date, "date");

  return context.database.transaction(async (client) => {
    await acquireTransactionLock(
      client,
      `posted-bill-payment:${context.tenantId}:${context.companyId}:${context.sourceId}:${input.billPaymentId}`
    );
    await assertCompanySourceScope(client, context);
    const original = await loadPostedBillPaymentForVoid(client, context, input.billPaymentId);
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
    const originalVersion = replay
      ? original.version
      : await markPostedBillPaymentVoided(client, context, original, input.expectedVersion);
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
      status: replay ? "already_voided" : "voided",
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
}

async function loadPostedBillPaymentForVoid(
  client: PostgresQueryClient,
  context: ServiceContext,
  documentId: string
): Promise<LoadedPostedBillPayment> {
  const result = await client.query(
    `select * from "erp_financials"."subledger_documents"
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
  assertIndependentApproval(input.operation);
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
    `select * from "erp_financials"."subledger_documents"
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
  assertIndependentApproval(input.operation);
  assertNonEmpty(input.originalTransactionId, "originalTransactionId");
  assertNonEmpty(input.idempotencyKey, "idempotencyKey");
  assertIsoDate(input.date, "date");
  if ((outcome === "corrected" || outcome === "replaced") && !("replacement" in input)) {
    throw new ErpFinancialsValidationError(`${outcome} journal workflow requires a replacement journal`);
  }

  return context.database.transaction(async (client) => {
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
  allowedSourceTypes: readonly string[] = ["JournalEntry", "JournalEntryAdjustment"]
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
order by postings."posting_id"
for update of transactions, postings`,
    [context.tenantId, context.sourceId, transactionId]
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
  if (!/^-?\d+\.\d{2}$/u.test(money)) {
    throw new Error(`Stored journal field ${field} must be fixed-scale money`);
  }
  return money;
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
    accountingBasis,
    now: input.now ?? (() => new Date().toISOString()),
    postingPolicy: input.postingPolicy ?? "enforce_fiscal_periods"
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

function normalizeJournalEntry(context: ServiceContext, input: InternalPostJournalEntryInput): NormalizedJournalEntry {
  assertNonEmpty(input.idempotencyKey, "idempotencyKey");
  assertIsoDate(input.date, "date");
  if (input.accountingPolicy !== undefined && !["configured_basis_only", "mirror_cash_and_accrual"].includes(input.accountingPolicy)) {
    throw new ErpFinancialsValidationError("accountingPolicy must be configured_basis_only or mirror_cash_and_accrual");
  }
  if (input.lines.length < 2) {
    throw new ErpFinancialsValidationError("A journal entry requires at least two lines");
  }

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
      transactionDate: journal.date
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
  identities: ReturnType<typeof journalIdentities>
) {
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
    payload: {
      accountingBasis: journal.accountingBasis,
      adjustment: journal.adjustment,
      currencyCode: journal.currencyCode,
      importBatchId: identities.importBatchId,
      postingIds: identities.postingIds,
      transactionDate: journal.date,
      transactionId: identities.transactionId
    }
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

function scopedRecordId(context: Pick<ServiceContext, "tenantId" | "sourceId">, kind: string, key: string): string {
  const digest = createHash("sha256")
    .update([context.tenantId, context.sourceId, kind, key].join("\u0000"))
    .digest("hex")
    .slice(0, 16);
  return `${kind}_${digest}`;
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
